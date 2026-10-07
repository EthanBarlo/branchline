import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitWorkflowCache } from './workflow-cache';
import { GitOperationQueue } from './operation-queue';
import { historyFormat, parseHistory } from './history';
import { projectGraphHistory } from './project-history';
import { mapConcurrent } from '../integrations/concurrency';
import type { Project } from '../../shared/types';
import type {
  GitActionInput,
  GitActionPreview,
  GitActionRow,
  GitBranchChoice,
  GitRemoteBranchStatus,
  GitProjectBranch,
  GitDestination,
  GitOperation,
  GitRepositoryStatus,
  GitWorkflowChange,
  GitWorkflowProgress,
  GitWorkflowSnapshot,
  GitCommit,
  GitHistory,
  GitHistoryInput,
  GitProjectHistory,
} from '../../shared/git-workflow';

interface Repository extends GitRepositoryStatus {
  directory: string;
  refs: Map<string, string>;
  modules: string[];
  signature: string;
  inProgress: boolean;
}
type BranchDestinations = Pick<
  GitRepositoryStatus,
  'incoming' | 'outgoing' | 'diverged' | 'upstream' | 'pushTarget'
> & { error?: string };
interface BranchReadContext {
  settings: Map<string, string>;
  tracking: Map<string, string>;
  urls: Map<string, Promise<string>>;
}
interface RepositoryTreeRead {
  head: Promise<string>;
  index: Promise<string>;
  modules: Promise<string[]>;
}
interface Prepared {
  preview: GitActionPreview;
  input: GitActionInput;
  repositories: Repository[];
  created: number;
}
interface Journal {
  operations: Record<string, GitOperation>;
  fetched: Record<string, { at?: string; error?: string }>;
  directories: Record<string, Record<string, string>>;
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
    '$1[redacted]@',
  );
const within = (root: string, directory: string): boolean => {
  const relative = path.relative(root, directory);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};
const remoteCacheRef = (url: string, branch: string): string =>
  `refs/branchline/workflow/${createHash('sha256').update(`${url}\0${branch}`).digest('hex')}`;

/** Owns local Git writes. Reads coexist; writes drain readers and protect overlapping projects. */
export class GitWorkflowService {
  private queue = new GitOperationQueue();
  private historyCache = new Map<
    string,
    { signature: string; commits: GitCommit[]; hasMore: boolean; loading: Promise<void> }
  >();
  private branchCache = new Map<
    string,
    {
      signature: string;
      states: Map<string, BranchDestinations>;
      remoteStates: Map<string, GitRemoteBranchStatus>;
    }
  >();
  private cache: GitWorkflowCache;
  private version = 0;
  private published = new Map<string, GitWorkflowSnapshot>();
  private generations = new Map<string, number>();
  private saving: Promise<void> = Promise.resolve();
  private plans = new Map<string, Prepared>();
  private listeners = new Set<(change: GitWorkflowChange) => void>();
  private journal: Journal = { operations: {}, fetched: {}, directories: {} };

  constructor(
    private journalPath: string,
    private project: (id: string) => Project,
    private invalidateReviews: () => void = () => {},
  ) {
    this.cache = new GitWorkflowCache(path.join(path.dirname(journalPath), 'git-status-cache.json'));
  }

  async load(): Promise<void> {
    try {
      this.journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
      this.journal.directories ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const operation of Object.values(this.journal.operations)) {
      if (operation.state !== 'running') continue;
      operation.state = 'interrupted';
      for (const row of operation.rows) {
        if (row.state === 'running') {
          row.state = 'unknown';
          row.message = 'The operation was interrupted. Check its result before trying again.';
        }
      }
    }
    await this.save();
    await this.cache.load();
  }

  private save(): Promise<void> {
    const saved = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.journalPath), { recursive: true });
        const temporary = `${this.journalPath}.tmp`;
        await writeFile(temporary, JSON.stringify(this.journal), { mode: 0o600 });
        await rename(temporary, this.journalPath);
      });
    this.saving = saved;
    return saved;
  }

  subscribe(listener: (change: GitWorkflowChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(projectId: string, busy: boolean, activity: GitWorkflowChange['activity'] = 'mutation'): void {
    const change = { projectId, busy, activity, operation: this.journal.operations[projectId] };
    for (const listener of this.listeners) listener(structuredClone(change));
  }

  private emitProgress(projectId: string, progress: GitWorkflowProgress): void {
    const change: GitWorkflowChange = { projectId, busy: true, activity: 'preview', progress };
    for (const listener of this.listeners) listener(structuredClone(change));
  }

  private async scope(repo: string): Promise<string[]> {
    const root = await realpath(repo);
    // Linked worktrees share refs even when their checkout paths are unrelated.
    const common = await this.command(root, ['rev-parse', '--git-common-dir']);
    return [root, await realpath(path.resolve(root, common))];
  }

  /** A lightweight checkout guard can run while a long comparison is reading Git. */
  read<T>(action: () => Promise<T>, repo?: string): Promise<T> {
    return this.queue.run(false, repo ? this.scope(repo) : undefined, action);
  }

  private exclusive<T>(
    projectId: string,
    action: () => Promise<T>,
    activity: GitWorkflowChange['activity'] = 'mutation',
  ): Promise<T> {
    return this.queue.run(true, this.scope(this.project(projectId).repoPath), async () => {
      this.invalidateReviews();
      this.emit(projectId, true, activity);
      try {
        return await action();
      } finally {
        this.invalidateReviews();
        this.emit(projectId, false, activity);
      }
    });
  }

  private async command(directory: string, args: string[]): Promise<string> {
    const network = args.some((arg) => ['fetch', 'push', 'ls-remote'].includes(arg));
    const configuredSSH = network ? await this.config(directory, 'core.sshCommand') : '';
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
      // Writes need Git's normal index/ref locks. Never inherit a caller's alternate index.
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OPTIONAL_LOCKS']) delete env[key];
      env.GIT_ASKPASS = '/usr/bin/false';
      env.SSH_ASKPASS = '/usr/bin/false';
      env.SSH_ASKPASS_REQUIRE = 'never';
      if (network && !configuredSSH && !env.GIT_SSH_COMMAND && !env.GIT_SSH)
        env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
      execFile(
        'git',
        [
          ...(args.includes('status') ? ['--no-optional-locks'] : []),
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.quotePath=false',
          '-c',
          'submodule.recurse=false',
          '-c',
          'credential.interactive=false',
          ...args,
        ],
        { cwd: directory, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(message(stderr.trim() || error.message)));
          else resolve(stdout.trimEnd());
        },
      );
    });
  }

  private async config(directory: string, key: string): Promise<string> {
    return this.command(directory, ['config', '--get', key]).catch(() => '');
  }

  private async validBranch(directory: string, name: string): Promise<void> {
    if (typeof name !== 'string' || !name || name === 'HEAD' || name.startsWith('-') || name.includes('\0'))
      throw new Error('Choose a valid branch.');
    await this.command(directory, ['check-ref-format', `refs/heads/${name}`]);
  }

  private async modules(directory: string, revision: string): Promise<string[]> {
    const tree = await this.command(directory, ['ls-tree', '-rz', revision]);
    return tree
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1))
      .sort();
  }

  private async ancestor(directory: string, older: string, newer: string): Promise<boolean> {
    return this.command(directory, ['merge-base', '--is-ancestor', older, newer]).then(
      () => true,
      () => false,
    );
  }

  private async counts(directory: string, head: string, other: string): Promise<[number, number]> {
    const [ahead, behind] = (
      await this.command(directory, ['rev-list', '--left-right', '--count', `${head}...${other}`])
    )
      .split(/\s+/)
      .map(Number);
    return [ahead, behind];
  }

  private async inspect(
    directory: string,
    relativePath: string,
    tree?: RepositoryTreeRead,
  ): Promise<Repository> {
    const [branch, head, refText, remoteText, porcelain] = await Promise.all([
      this.command(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      tree?.head ?? this.command(directory, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
      this.command(directory, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        'refs/heads',
        'refs/remotes',
        'refs/branchline/workflow',
      ]),
      this.command(directory, ['remote']),
      this.command(directory, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]),
    ]);
    const refs = new Map(
      refText
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\0') as [string, string]),
    );
    const [modules, index, gitDirectory] = await Promise.all([
      tree?.modules ?? (head ? this.modules(directory, head) : []),
      tree?.index ?? this.command(directory, ['ls-files', '--stage', '-z']),
      this.command(directory, ['rev-parse', '--absolute-git-dir']),
    ]);
    const indexModules = index
      .split('\0')
      .filter((line) => line.startsWith('160000 '))
      .map((line) => line.slice(line.indexOf('\t') + 1));
    const pointerChanges: string[] = [];
    let changes = 0;
    const entries = porcelain.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const filename = entry.slice(3);
      if (entry.slice(0, 2) === ' M' && indexModules.includes(filename)) pointerChanges.push(filename);
      else changes++;
      if (/[RC]/.test(entry.slice(0, 2))) i++;
    }
    const remotes = remoteText.split('\n').filter(Boolean);
    const fetched = this.journal.fetched[directory];
    const result: Repository = {
      directory,
      path: relativePath,
      branch: branch || null,
      head,
      refs,
      modules,
      remotes,
      incoming: null,
      outgoing: null,
      diverged: false,
      changes,
      pointerChanges,
      signature: createHash('sha256').update(porcelain).digest('hex'),
      inProgress: false,
      lastFetched: fetched?.at,
      fetchError: fetched?.error,
    };
    await Promise.all(
      [
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'rebase-merge',
        'rebase-apply',
        'sequencer',
        'BISECT_START',
      ].map(async (marker) => {
        if (
          await stat(path.join(gitDirectory, marker)).then(
            () => true,
            () => false,
          )
        )
          result.inProgress = true;
      }),
    );
    if (!head) result.error = 'This repository has no commits yet. Create the initial commit manually.';
    if (result.inProgress)
      result.error = 'Finish the current merge, rebase, cherry-pick, or bisect manually.';
    if (!branch || !head) return result;
    Object.assign(result, await this.branchDestinations(directory, refs, branch, head));
    return result;
  }

  private async branchDestinations(
    directory: string,
    refs: Map<string, string>,
    branch: string,
    head: string,
    context?: BranchReadContext,
  ): Promise<BranchDestinations> {
    const result: BranchDestinations = {
      incoming: null,
      outgoing: null,
      diverged: false,
    };
    const config = (key: string) =>
      context
        ? Promise.resolve(context.settings.get(key.replace(/\.[^.]+$/, (part) => part.toLowerCase())) ?? '')
        : this.config(directory, key);
    const url = (remote: string, push = false) => {
      const key = `${remote}:${push}`;
      let request = context?.urls.get(key);
      if (!request) {
        request = this.command(directory, ['remote', 'get-url', ...(push ? ['--push'] : []), remote]).catch(
          () => '',
        );
        context?.urls.set(key, request);
      }
      return request;
    };
    let upstreamCounts: [number, number] | undefined;
    const [upstreamRemote, upstreamRef, pushRemote, defaultPushRemote] = await Promise.all([
      config(`branch.${branch}.remote`),
      config(`branch.${branch}.merge`),
      config(`branch.${branch}.pushRemote`),
      config('remote.pushDefault'),
    ]);
    if (upstreamRemote && upstreamRef.startsWith('refs/heads/')) {
      const upstreamName = upstreamRef.slice('refs/heads/'.length);
      const trackingRef = context
        ? (context.tracking.get(branch) ?? '')
        : await this.command(directory, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]).catch(
            () => '',
          );
      const commit = refs.get(trackingRef) ?? null;
      result.upstream = { remote: upstreamRemote, branch: upstreamName, commit };
      if (upstreamRemote !== '.') result.upstream.url = message(await url(upstreamRemote));
      if (commit) {
        upstreamCounts = await this.counts(directory, head, commit);
        const [ahead, behind] = upstreamCounts;
        result.incoming = behind;
        result.diverged = ahead > 0 && behind > 0;
      }
    }
    const destinationRemote = pushRemote || defaultPushRemote || upstreamRemote;
    if (destinationRemote && destinationRemote !== '.') {
      const destinationBranch =
        destinationRemote === upstreamRemote && result.upstream ? result.upstream.branch : branch;
      result.pushTarget = {
        remote: destinationRemote,
        branch: destinationBranch,
        commit: refs.get(`refs/remotes/${destinationRemote}/${destinationBranch}`) ?? null,
      };
      const fetchUrl = await url(destinationRemote);
      const pushUrl = await url(destinationRemote, true);
      if (pushUrl !== fetchUrl)
        result.pushTarget.commit = refs.get(remoteCacheRef(pushUrl, destinationBranch)) ?? null;
      result.pushTarget.url = message(pushUrl);
      if (result.pushTarget.commit)
        result.outgoing = (
          upstreamCounts && result.pushTarget.commit === result.upstream?.commit
            ? upstreamCounts
            : await this.counts(directory, head, result.pushTarget.commit)
        )[0];
    }
    return result;
  }

  private async discover(
    projectId: string,
    onRepository?: (repository: Repository) => Promise<void>,
    onPending?: (relativePath: string) => void,
  ): Promise<Repository[]> {
    const root = await realpath(this.project(projectId).repoPath);
    const visited = new Set<string>();
    const repositories = new Map<string, Repository>();
    const visit = async (directory: string, relativePath: string, depth: number): Promise<void> => {
      onPending?.(relativePath);
      try {
        const physical = await realpath(directory);
        if (!within(root, physical) || depth > 24 || visited.has(physical))
          throw new Error('Unsafe or repeated submodule path.');
        visited.add(physical);
        const top = await realpath(await this.command(physical, ['rev-parse', '--show-toplevel']));
        if (top !== physical) throw new Error('Submodule is not initialized. Initialize it manually.');
        // Discovery and status inspect the same HEAD/index. Share those reads while
        // still allowing children to load before a slow parent status check finishes.
        const head = this.command(physical, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
        const tree: RepositoryTreeRead = {
          head,
          index: this.command(physical, ['ls-files', '--stage', '-z']),
          modules: head.then((revision) => (revision ? this.modules(physical, revision) : [])),
        };
        const inspection = this.inspect(physical, relativePath, tree).then(async (repository) => {
          repositories.set(relativePath, repository);
          await onRepository?.(repository);
        });
        const children = (async () => {
          const [index, modules] = await Promise.all([tree.index, tree.modules.catch(() => [] as string[])]);
          const indexed = index
            .split('\0')
            .filter((line) => line.startsWith('160000 '))
            .map((line) => line.slice(line.indexOf('\t') + 1));
          await Promise.all(
            [...new Set([...modules, ...indexed])]
              .sort()
              .map((module) =>
                visit(
                  path.resolve(physical, module),
                  relativePath === '.' ? module : `${relativePath}/${module}`,
                  depth + 1,
                ),
              ),
          );
        })();
        // Settle all children even on failure, so a read cannot escape the mutation barrier.
        const results = await Promise.allSettled([inspection, children]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      } catch (error) {
        const repository: Repository = {
          directory,
          path: relativePath,
          branch: null,
          head: '',
          remotes: [],
          refs: new Map(),
          modules: [],
          signature: '',
          inProgress: false,
          incoming: null,
          outgoing: null,
          diverged: false,
          changes: 0,
          pointerChanges: [],
          error: message(error),
        };
        repositories.set(relativePath, repository);
        await onRepository?.(repository);
      }
    };
    await visit(root, '.', 0);
    return [...repositories.values()].sort((a, b) =>
      a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path),
    );
  }

  private uncertainOperation(repositories: Repository[]): GitOperation | undefined {
    return Object.entries(this.journal.operations).find(([id, operation]) =>
      operation.rows.some(
        (row) =>
          row.state === 'unknown' &&
          repositories.some(
            (repository) => repository.directory === this.journal.directories[id]?.[row.path],
          ),
      ),
    )?.[1];
  }

  private async repositoryBranches(repository: Repository): Promise<GitProjectBranch[]> {
    const branches = new Map<string, GitProjectBranch>();
    const members = new Map<string, { local: boolean; remotes: string[] }>();
    for (const ref of repository.refs.keys()) {
      let name: string;
      let remote: string | undefined;
      if (ref.startsWith('refs/heads/')) name = ref.slice(11);
      else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        const [source, ...parts] = ref.slice(13).split('/');
        remote = source;
        name = parts.join('/');
      } else continue;
      const member = members.get(name) ?? { local: false, remotes: [] };
      if (remote) member.remotes.push(remote);
      else member.local = true;
      members.set(name, member);
    }
    // Cache counts by refs and effective configuration, including external Git edits.
    // Read branch metadata in bulk so large monorepos do not spawn processes per config key.
    const [settingsText, trackingText] = members.size
      ? await Promise.all([
          this.command(repository.directory, ['config', '--null', '--list']),
          this.command(repository.directory, [
            'for-each-ref',
            '--format=%(refname:strip=2)%00%(upstream)',
            'refs/heads',
          ]),
        ])
      : ['', ''];
    const signature = createHash('sha256')
      .update(JSON.stringify([...repository.refs]) + settingsText + trackingText)
      .digest('hex');
    let cached = this.branchCache.get(repository.directory);
    if (cached?.signature !== signature) {
      cached = { signature, states: new Map(), remoteStates: new Map() };
      if (this.branchCache.size > 128) this.branchCache.clear();
      this.branchCache.set(repository.directory, cached);
    }
    const context: BranchReadContext = {
      settings: new Map(
        settingsText
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const split = entry.indexOf('\n');
            return split < 0 ? [entry, ''] : [entry.slice(0, split), entry.slice(split + 1)];
          }),
      ),
      tracking: new Map(
        trackingText
          .split('\n')
          .filter(Boolean)
          .map((entry) => entry.split('\0') as [string, string]),
      ),
      urls: new Map(),
    };
    const entries = [...members];
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const [name, member] = entries[cursor++];
        const branch = branches.get(name) ?? { name, repositories: [] };
        const current = repository.branch === name;
        let state: BranchDestinations = current
          ? repository
          : { incoming: null, outgoing: null, diverged: false };
        if (!current && member.local) {
          state =
            cached.states.get(name) ??
            (await this.branchDestinations(
              repository.directory,
              repository.refs,
              name,
              repository.refs.get(`refs/heads/${name}`)!,
              context,
            ).catch((error) => ({ incoming: null, outgoing: null, diverged: false, error: message(error) })));
          cached.states.set(name, state);
        }
        const remoteStatus: Record<string, GitRemoteBranchStatus> = {};
        for (const remote of member.remotes) {
          const key = `${remote}/${name}`;
          let remoteState = cached.remoteStates.get(key);
          if (!remoteState) {
            const head = repository.refs.get(`refs/remotes/${key}`)!;
            const local = repository.refs.get(`refs/heads/${name}`);
            const counts = local
              ? await this.counts(repository.directory, local, head).catch(() => null)
              : null;
            remoteState = {
              head,
              incoming: counts?.[1] ?? null,
              outgoing: counts?.[0] ?? null,
              diverged: !!counts && counts[0] > 0 && counts[1] > 0,
            };
            cached.remoteStates.set(key, remoteState);
          }
          remoteStatus[remote] = remoteState;
        }
        branch.repositories.push({
          path: repository.path,
          ...member,
          remoteStatus,
          current,
          incoming: state.incoming,
          outgoing: state.outgoing,
          diverged: state.diverged,
          upstream: 'upstream' in state ? state.upstream : undefined,
          pushTarget: 'pushTarget' in state ? state.pushTarget : undefined,
          error: 'error' in state ? state.error : undefined,
        });
        branches.set(name, branch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, worker));
    return [...branches.values()];
  }

  private async snapshot(projectId: string, repositories: Repository[]): Promise<GitWorkflowSnapshot> {
    const branches = new Map<string, GitProjectBranch>();
    const chunks = await Promise.all(repositories.map((repository) => this.repositoryBranches(repository)));
    for (const chunk of chunks)
      for (const branch of chunk) {
        const combined = branches.get(branch.name) ?? { name: branch.name, repositories: [] };
        combined.repositories.push(...branch.repositories);
        branches.set(branch.name, combined);
      }
    return {
      projectId,
      version: ++this.version,
      repositories: repositories.map(
        ({
          directory: _directory,
          refs: _refs,
          modules: _modules,
          signature: _signature,
          inProgress: _inProgress,
          ...repository
        }) => repository,
      ),
      branches: [...branches.values()].sort((a, b) => a.name.localeCompare(b.name)),
      operation: structuredClone(this.uncertainOperation(repositories) ?? this.journal.operations[projectId]),
    };
  }

  getCachedStatus(projectId: string): GitWorkflowSnapshot | undefined {
    const snapshot = this.cache.get(this.project(projectId));
    if (snapshot)
      snapshot.operation = structuredClone(
        this.journal.operations[projectId] ??
          Object.values(this.journal.operations).find((operation) => operation.id === snapshot.operation?.id),
      );
    return snapshot;
  }

  private async scan(projectId: string, fetch: boolean): Promise<GitWorkflowSnapshot> {
    const project = this.project(projectId);
    const generation = (this.generations.get(projectId) ?? 0) + 1;
    this.generations.set(projectId, generation);
    const cached = this.getCachedStatus(projectId);
    // Only first load and network fetch need progressive results. Routine local
    // checks publish one coherent snapshot, keeping coverage and selection stable.
    const progressive = fetch || !this.published.has(projectId);
    const chunks = new Map<string, GitWorkflowSnapshot>();
    for (const repository of cached?.repositories ?? [])
      chunks.set(repository.path, {
        projectId,
        repositories: [repository],
        branches: cached!.branches.flatMap((branch) => {
          const member = branch.repositories.find((item) => item.path === repository.path);
          return member ? [{ name: branch.name, repositories: [member] }] : [];
        }),
      });
    const pending = new Set(['.', ...chunks.keys()]);
    const compose = (loading: boolean): GitWorkflowSnapshot => {
      const values = [...chunks.values()].sort((a, b) =>
        a.repositories[0].path === '.'
          ? -1
          : b.repositories[0].path === '.'
            ? 1
            : a.repositories[0].path.localeCompare(b.repositories[0].path),
      );
      const branches = new Map<string, GitProjectBranch>();
      for (const chunk of values)
        for (const branch of chunk.branches) {
          const item = branches.get(branch.name) ?? { name: branch.name, repositories: [] };
          item.repositories.push(...branch.repositories);
          branches.set(item.name, item);
        }
      return {
        projectId,
        version: ++this.version,
        cached: loading && !!cached,
        loading,
        pendingRepositories: [...pending],
        repositories: values.flatMap((chunk) => chunk.repositories),
        branches: [...branches.values()].sort((a, b) => a.name.localeCompare(b.name)),
        operation: structuredClone(this.journal.operations[projectId] ?? cached?.operation),
      };
    };
    const publish = async () => {
      if (this.generations.get(projectId) !== generation) return;
      const snapshot = compose(true);
      this.published.set(projectId, snapshot);
      for (const listener of this.listeners) listener({ projectId, busy: fetch, snapshot });
      // Intermediate display caches must not hold up Git/network work. The final
      // snapshot is persisted before scan completion below.
      void this.cache.put(project, snapshot).catch(() => {});
    };
    const repositories = await this.discover(
      projectId,
      progressive
        ? async (repository) => {
            chunks.set(repository.path, await this.snapshot(projectId, [repository]));
            if (!fetch) pending.delete(repository.path);
            await publish();
            if (fetch && !repository.error) {
              await this.fetchRepositories([repository]);
              const updated = await this.inspect(repository.directory, repository.path);
              chunks.set(repository.path, await this.snapshot(projectId, [updated]));
            }
            pending.delete(repository.path);
            if (fetch) await publish();
          }
        : undefined,
      (relativePath) => pending.add(relativePath),
    );
    await this.reconcile(projectId, repositories);
    // Fresh topology replaces the cache only when discovery has finished.
    const result = await this.snapshot(projectId, fetch ? await this.discover(projectId) : repositories);
    if (this.generations.get(projectId) !== generation)
      return structuredClone(this.published.get(projectId) ?? result);
    Object.assign(result, {
      version: ++this.version,
      cached: false,
      loading: false,
      pendingRepositories: [],
    });
    const previous = this.published.get(projectId);
    if (
      previous &&
      !previous.loading &&
      JSON.stringify([previous.repositories, previous.branches, previous.operation]) ===
        JSON.stringify([result.repositories, result.branches, result.operation])
    )
      return structuredClone(previous);
    if (this.generations.get(projectId) === generation) {
      this.published.set(projectId, result);
      await this.cache.put(project, result).catch(() => {});
      for (const listener of this.listeners)
        listener({ projectId, busy: fetch, snapshot: structuredClone(result) });
    }
    return result;
  }

  getStatus(projectId: string): Promise<GitWorkflowSnapshot> {
    return this.read(() => this.scan(projectId, false), this.project(projectId).repoPath);
  }

  private historyLimit(limit = 250): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER)
      throw new Error('Choose a positive, safe history limit.');
    return limit;
  }

  private async historyRepository(projectId: string, repository: Repository): Promise<string> {
    const directory = await realpath(repository.directory);
    const root = await realpath(this.project(projectId).repoPath);
    if (!within(root, directory)) throw new Error('Unsafe submodule path.');
    const top = await realpath(await this.command(directory, ['rev-parse', '--show-toplevel']));
    if (top !== directory) throw new Error('Submodule is not initialized. Initialize it manually.');
    return directory;
  }

  private async repositoryHistory(directory: string, input: GitHistoryInput): Promise<GitHistory> {
    const limit = this.historyLimit(input.limit);
    const [refOutput, head] = await Promise.all([
      this.command(directory, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)',
        'refs/heads/',
        'refs/remotes/',
        'refs/tags/',
      ]),
      this.command(directory, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    ]);
    const refs = (
      await Promise.all(
        refOutput.split('\n').map(async (line) => {
          const fields = line.split('\0');
          if (fields[4] !== 'tag') return line;
          const commit = await this.command(directory, [
            'rev-parse',
            '--verify',
            `${fields[1]}^{commit}`,
          ]).catch(() => '');
          if (!commit) return line;
          fields[2] = commit;
          fields[4] = 'commit';
          return fields.join('\0');
        }),
      )
    ).join('\n');
    let revisions = [
      ...new Set([
        ...refs.split('\n').flatMap((line) => {
          const [, hash, peeled, type, peeledType] = line.split('\0');
          return type === 'commit' ? [hash] : peeledType === 'commit' ? [peeled] : [];
        }),
        ...(head ? [head] : []),
      ]),
    ];
    if (input.branch) {
      await this.validBranch(directory, input.branch.name);
      const ref = input.branch.remote
        ? `refs/remotes/${input.branch.remote}/${input.branch.name}`
        : `refs/heads/${input.branch.name}`;
      const revision = await this.command(directory, ['rev-parse', '--verify', `${ref}^{commit}`]).catch(
        () => '',
      );
      if (!revision) throw new Error('This branch is unavailable in the selected repository.');
      revisions = [revision];
    }
    if (!refs && !head) return { repositoryPath: input.repositoryPath, commits: [], hasMore: false };
    const signature = JSON.stringify([refs, head, revisions]);
    let cached = this.historyCache.get(directory);
    if (!cached || cached.signature !== signature) {
      // Keep reuse bounded to the currently inspected repositories.
      if (this.historyCache.size >= 32) this.historyCache.clear();
      cached = { signature, commits: [], hasMore: true, loading: Promise.resolve() };
      this.historyCache.set(directory, cached);
    }
    const history = cached;
    const request = history.loading.then(async () => {
      while (history.hasMore && history.commits.length < limit + 1) {
        const count = Math.min(250, limit + 1 - history.commits.length);
        const log = await this.command(directory, [
          'log',
          '-z',
          '--topo-order',
          '--no-show-signature',
          '--no-color',
          `--skip=${history.commits.length}`,
          `--max-count=${count}`,
          `--format=${historyFormat}`,
          ...revisions,
          '--',
        ]);
        const page = parseHistory(log, refs, head);
        history.commits.push(...page);
        history.hasMore = page.length === count;
      }
    });
    // Serialize overlapping reads of the same cached traversal, including after failures.
    history.loading = request.catch(() => {});
    await request;
    return {
      repositoryPath: input.repositoryPath,
      commits: history.commits.slice(0, limit),
      hasMore: history.hasMore || history.commits.length > limit,
    };
  }

  async getHistory(projectId: string, input: GitHistoryInput): Promise<GitHistory> {
    this.historyLimit(input.limit);
    return this.read(async () => {
      const repository = (await this.discover(projectId)).find((repo) => repo.path === input.repositoryPath);
      if (!repository) throw new Error('Repository is not part of this project.');
      return this.repositoryHistory(await this.historyRepository(projectId, repository), input);
    }, this.project(projectId).repoPath);
  }

  async getProjectHistory(
    projectId: string,
    input: Omit<GitHistoryInput, 'repositoryPath'>,
  ): Promise<GitProjectHistory> {
    const limit = this.historyLimit(input.limit);
    return this.read(async () => {
      const repositories = await this.discover(projectId);
      const results = await mapConcurrent(repositories, 4, async (repository) => {
        try {
          const directory = await this.historyRepository(projectId, repository);
          return {
            path: repository.path,
            history: await this.repositoryHistory(directory, {
              ...input,
              repositoryPath: repository.path,
            }),
          };
        } catch (error) {
          return { path: repository.path, error: message(error) };
        }
      });
      const histories = results.flatMap((result) => (result.history ? [result.history] : []));
      const events = projectGraphHistory(histories);
      return {
        events: events.slice(0, limit),
        repositories: results.map((result) => ({
          path: result.path,
          ...(result.error ? { error: result.error } : {}),
        })),
        hasMore: histories.some((history) => history.hasMore) || events.length > limit,
      };
    }, this.project(projectId).repoPath);
  }

  private async fetchRepositories(
    repositories: Repository[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    let done = 0;
    onProgress?.(done, repositories.length);
    await mapConcurrent(repositories, 4, async (repository) => {
      if (repository.error || !repository.remotes.length) {
        onProgress?.(++done, repositories.length);
        return;
      }
      const previous = this.journal.fetched[repository.directory];
      try {
        for (const remote of repository.remotes) {
          if (remote.startsWith('-')) throw new Error('Invalid remote name. Configure it manually.');
          await this.command(repository.directory, [
            '-c',
            'fetch.pruneTags=false',
            '-c',
            `remote.${remote}.pruneTags=false`,
            'fetch',
            '--prune',
            '--no-tags',
            '--no-recurse-submodules',
            '--no-write-fetch-head',
            remote,
            `+refs/heads/*:refs/remotes/${remote}/*`,
          ]);
        }
        const updated = await this.inspect(repository.directory, repository.path);
        if (updated.pushTarget)
          await this.remoteCommit(updated, updated.pushTarget.remote, updated.pushTarget.branch);
        this.journal.fetched[repository.directory] = { at: new Date().toISOString() };
      } catch (error) {
        this.journal.fetched[repository.directory] = { at: previous?.at, error: message(error) };
      }
      onProgress?.(++done, repositories.length);
    });
    await this.save();
  }

  fetch(projectId: string): Promise<GitWorkflowSnapshot> {
    return this.exclusive(projectId, () => this.scan(projectId, true), 'fetch');
  }

  private async remoteCommit(repository: Repository, remote: string, branch: string): Promise<string | null> {
    await this.validBranch(repository.directory, branch);
    if (!repository.remotes.includes(remote) || remote.startsWith('-'))
      throw new Error('Choose an available remote.');
    const urls = (
      await this.command(repository.directory, ['remote', 'get-url', '--push', '--all', remote])
    ).split('\n');
    if (urls.length !== 1 || urls[0].startsWith('-'))
      throw new Error('Multiple or invalid push destinations must be managed manually.');
    const url = urls[0];
    const ref = `refs/heads/${branch}`;
    const output = await this.command(repository.directory, ['ls-remote', '--heads', url, ref]);
    const commit =
      output
        .split('\n')
        .find((line) => line.split('\t')[1] === ref)
        ?.split('\t')[0] ?? null;
    if (commit) {
      const cacheRef = remoteCacheRef(url, branch);
      await this.command(repository.directory, [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        url,
        `+${ref}:${cacheRef}`,
      ]);
      // Refetch may race the remote read. Capture only a revision we actually fetched.
      return this.command(repository.directory, ['rev-parse', cacheRef]);
    }
    return null;
  }

  private async remoteDeletionTarget(
    repository: Repository,
    remote: string,
    branch: string,
  ): Promise<GitDestination> {
    await this.validBranch(repository.directory, branch);
    if (!repository.remotes.includes(remote) || remote.startsWith('-'))
      throw new Error('Choose an available remote.');
    if ((await this.config(repository.directory, `remote.${remote}.mirror`)) === 'true')
      throw new Error('Mirror remotes must be managed manually.');
    const urls = (
      await this.command(repository.directory, ['remote', 'get-url', '--push', '--all', remote])
    ).split('\n');
    if (urls.length !== 1 || urls[0].startsWith('-'))
      throw new Error('Multiple or invalid push destinations must be managed manually.');
    const ref = `refs/heads/${branch}`;
    const output = await this.command(repository.directory, ['ls-remote', '--heads', urls[0], ref]);
    const commit =
      output
        .split('\n')
        .find((line) => line.split('\t')[1] === ref)
        ?.split('\t')[0] ?? null;
    // Deletion needs the server tip for a lease, not its objects or ancestry.
    return { remote, branch, commit, url: message(urls[0]) };
  }

  private async localRemoteDeletion(
    repository: Repository,
    input: GitActionInput,
  ): Promise<GitDestination | undefined> {
    if (!repository.remotes.length) return undefined;
    const name = input.branch!.name;
    const configured = await this.config(repository.directory, `branch.${name}.remote`);
    const known = repository.remotes.filter((remote) =>
      repository.refs.has(`refs/remotes/${remote}/${name}`),
    );
    const remote =
      input.deleteRemotes?.[repository.path] ||
      (configured && configured !== '.' ? configured : '') ||
      (known.length === 1 ? known[0] : repository.remotes.length === 1 ? repository.remotes[0] : '');
    if (!remote) throw new Error('Choose a remote for this repository to also delete its remote branch.');
    const merge =
      remote === configured ? await this.config(repository.directory, `branch.${name}.merge`) : '';
    if (merge && !merge.startsWith('refs/heads/'))
      throw new Error('The tracking target is not a remote branch. Choose a remote manually.');
    return this.remoteDeletionTarget(repository, remote, merge ? merge.slice(11) : name);
  }

  private async checkoutTarget(
    repository: Repository,
    branch: GitBranchChoice,
    preferLocal = true,
  ): Promise<GitDestination> {
    await this.validBranch(repository.directory, branch.name);
    const local = repository.refs.get(`refs/heads/${branch.name}`);
    if (local && preferLocal) return { remote: '', branch: branch.name, commit: local };
    const matches = [...repository.refs].filter(
      ([ref]) =>
        ref.startsWith('refs/remotes/') &&
        ref.endsWith(`/${branch.name}`) &&
        ref.slice(13).split('/').slice(1).join('/') === branch.name &&
        (!branch.remote || ref.startsWith(`refs/remotes/${branch.remote}/`)),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'Branch is ambiguous across remotes. Select a remote-qualified branch.'
          : 'Branch is missing. Fetch or create it manually.',
      );
    const [ref, commit] = matches[0];
    const remote = ref.slice(13).split('/')[0];
    return {
      remote,
      branch: branch.name,
      commit,
      url: message(await this.command(repository.directory, ['remote', 'get-url', remote])),
    };
  }

  private async availableWorktree(repository: Repository, branch: string): Promise<void> {
    const [worktrees, gitDirectory] = await Promise.all([
      this.command(repository.directory, ['worktree', 'list', '--porcelain']),
      this.command(repository.directory, ['rev-parse', '--absolute-git-dir']),
    ]);
    for (const worktree of worktrees.split('\n\n')) {
      if (worktree.split('\n').includes(`branch refs/heads/${branch}`)) {
        const directory = worktree.split('\n')[0].slice('worktree '.length);
        const actual = await realpath(directory);
        // Git lists a submodule's primary worktree by its Git directory, not core.worktree.
        if (actual !== repository.directory && actual !== (await realpath(gitDirectory)))
          throw new Error('This branch is checked out in another worktree.');
      }
    }
  }

  private async branchConfigSignature(directory: string, name: string): Promise<string> {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = `branch.${name}.`;
    const output = await this.command(directory, [
      'config',
      '--null',
      '--get-regexp',
      `^branch\\.${escaped}\\.`,
    ]).catch(() => '');
    const values = output
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(prefix.length))
      .sort();
    return values.length ? createHash('sha256').update(JSON.stringify(values)).digest('hex') : '';
  }

  private async newBranchAvailable(repository: Repository, name: string): Promise<void> {
    await this.validBranch(repository.directory, name);
    const full = `refs/heads/${name}`;
    for (const ref of repository.refs.keys()) {
      if (!ref.startsWith('refs/heads/')) continue;
      if (ref === full) throw new Error('A local branch with this name already exists.');
      if (ref.startsWith(`${full}/`) || full.startsWith(`${ref}/`))
        throw new Error('The new name conflicts with an existing branch folder.');
    }
    if (await this.branchConfigSignature(repository.directory, name))
      throw new Error('The new name already has branch configuration. Resolve it manually first.');
    await this.availableWorktree(repository, name);
  }

  private async rows(
    repositories: Repository[],
    input: GitActionInput,
    fresh: boolean,
    checkChildren = true,
  ): Promise<GitActionRow[]> {
    const commonBranch = repositories[0]?.branch;
    const rows = await mapConcurrent(repositories, 4, async (repository): Promise<GitActionRow> => {
      const row: GitActionRow = {
        path: repository.path,
        branch: repository.branch,
        head: repository.head,
        noop: false,
        blockers: [],
        warnings: repository.pointerChanges.map(
          (file) => `Pointer difference: ${file}. Pointer commits remain manual.`,
        ),
      };
      try {
        if (repository.error) throw new Error(repository.error);
        if (repository.inProgress)
          throw new Error('Finish the current merge, rebase, cherry-pick, or bisect manually.');
        if ((input.action === 'checkout' || input.action === 'pull') && repository.changes)
          throw new Error('Commit or stash local file and index changes manually first.');
        if (
          (input.action === 'pull' || input.action === 'push') &&
          (!commonBranch || repository.branch !== commonBranch)
        )
          throw new Error('Check out the same branch in every repository first.');
        if (input.action === 'checkout') {
          if (!input.branch) throw new Error('Choose a branch.');
          row.destination = await this.checkoutTarget(repository, input.branch);
          row.createTracking = !!row.destination.remote;
          row.noop = repository.branch === row.destination.branch;
          await this.availableWorktree(repository, row.destination.branch);
        } else if (input.action === 'create' || input.action === 'rename') {
          if (!input.branch || !input.newBranch) throw new Error('Choose a source branch and a new name.');
          await this.newBranchAvailable(repository, input.newBranch);
          row.source = await this.checkoutTarget(
            repository,
            input.branch,
            input.action !== 'create' || input.branch.kind !== 'remote',
          );
          if (input.action === 'rename' && input.branch.kind === 'remote')
            throw new Error('Rename requires a local branch.');
          if (input.action === 'rename') {
            if (row.source.remote)
              throw new Error(
                'Rename requires a local branch. Check it out first to create a tracking branch.',
              );
            await this.availableWorktree(repository, row.source.branch);
            row.sourceConfigSignature = await this.branchConfigSignature(
              repository.directory,
              row.source.branch,
            );
            row.warnings.push('Remote branch names stay unchanged. Existing upstream tracking is retained.');
            row.warnings.push('Saved reviews keep their recorded branch names.');
          }
          row.destination = { remote: '', branch: input.newBranch, commit: row.source.commit };
        } else if (input.action === 'delete') {
          if (!input.branch) throw new Error('Choose a branch.');
          await this.validBranch(repository.directory, input.branch.name);
          const remote = input.branch.kind === 'remote' ? input.branch.remote : '';
          if (input.branch.kind === 'remote' && !remote) throw new Error('Choose a remote-qualified branch.');
          if (input.branch.kind !== 'remote' && input.branch.remote)
            throw new Error('Choose either a local branch or a remote-qualified branch.');
          row.source = { remote: remote || '', branch: input.branch.name, commit: null };
          if (remote) {
            if (!repository.remotes.includes(remote)) {
              row.noop = true;
              return row;
            }
            row.source = await this.remoteDeletionTarget(repository, remote, input.branch.name);
          } else {
            row.source.commit = repository.refs.get(`refs/heads/${input.branch.name}`) ?? null;
            if (row.source.commit) {
              if (repository.branch === input.branch.name)
                throw new Error('Check out another branch before deleting this local branch.');
              await this.availableWorktree(repository, input.branch.name);
              row.sourceConfigSignature = await this.branchConfigSignature(
                repository.directory,
                input.branch.name,
              );
              const upstream = await this.command(repository.directory, [
                'for-each-ref',
                '--format=%(upstream)',
                `refs/heads/${input.branch.name}`,
              ]);
              const base = repository.refs.get(upstream) ?? repository.head;
              row.unmergedCommits = Number(
                await this.command(repository.directory, [
                  'rev-list',
                  '--count',
                  `${base}..${row.source.commit}`,
                ]),
              );
              if (row.unmergedCommits && !input.force)
                row.blockers.push(
                  `${row.unmergedCommits} unmerged commits. Select "Delete even if unmerged" to delete this branch.`,
                );
              if (row.unmergedCommits)
                row.warnings.push(
                  `${row.unmergedCommits} unmerged commits will lose this local branch reference.`,
                );
            }
            if (input.deleteRemote) {
              row.remoteDeletion = await this.localRemoteDeletion(repository, input);
              if (!row.remoteDeletion)
                row.warnings.push('No remote configured; only the local branch will be deleted.');
            }
          }
          const target = row.source.remote ? row.source : row.remoteDeletion;
          if (target) {
            const fetchUrl = message(
              await this.command(repository.directory, ['remote', 'get-url', target.remote]),
            );
            if (fetchUrl !== target.url)
              row.warnings.push(
                'This remote fetches from a different URL. Its tracking branches stay unchanged.',
              );
          }
          row.noop = !row.source.commit && !row.remoteDeletion?.commit;
        } else if (input.action === 'pull') {
          if (repository.fetchError) throw new Error(`Fetch failed: ${repository.fetchError}`);
          if (!repository.upstream || repository.upstream.remote === '.')
            throw new Error('Configure a remote tracking branch manually before pulling.');
          row.destination = repository.upstream;
          if (!row.destination.commit) throw new Error('The tracking branch is missing on the remote.');
          const [ahead, behind] = await this.counts(
            repository.directory,
            repository.head,
            row.destination.commit,
          );
          if (ahead && behind)
            throw new Error('Branches have diverged. Merge or rebase manually, then refresh.');
          row.noop = behind === 0;
          if (
            !row.noop &&
            !(await this.ancestor(repository.directory, repository.head, row.destination.commit))
          )
            throw new Error('Only fast-forward pulls are allowed. Handle the history manually.');
        } else {
          const target = repository.pushTarget;
          const remote = target?.remote || input.publishRemotes?.[repository.path];
          if (!remote) throw new Error('Choose a remote to publish this branch.');
          const branch = target?.branch || repository.branch!;
          if ((await this.config(repository.directory, `remote.${remote}.mirror`)) === 'true')
            throw new Error('Mirror remotes must be managed manually.');
          if (await this.config(repository.directory, `remote.${remote}.push`))
            throw new Error('Custom push refspecs must be managed manually.');
          const commit = fresh
            ? await this.remoteCommit(repository, remote, branch)
            : (target?.commit ?? null);
          row.destination = {
            remote,
            branch,
            commit,
            url: message(await this.command(repository.directory, ['remote', 'get-url', '--push', remote])),
          };
          row.createTracking = !repository.upstream;
          row.noop = commit === repository.head;
          if (commit && !(await this.ancestor(repository.directory, commit, repository.head))) {
            [row.outgoing, row.incoming] = await this.counts(repository.directory, repository.head, commit);
            throw new Error(
              row.outgoing
                ? `Branches have diverged (${row.outgoing} local, ${row.incoming} remote). Merge or rebase manually first.`
                : `${row.incoming} incoming ${row.incoming === 1 ? 'commit' : 'commits'}. Pull first.`,
            );
          }
        }
        if (
          (input.action === 'checkout' || input.action === 'pull') &&
          row.destination?.commit &&
          JSON.stringify(await this.modules(repository.directory, row.destination.commit)) !==
            JSON.stringify(repository.modules)
        )
          throw new Error('Submodule paths change in this operation. Handle it manually.');
      } catch (error) {
        row.blockers.push(message(error));
      }
      return row;
    });
    // Before a parent push, each gitlink must already be published or included in a child push.
    if (input.action === 'push' && checkChildren) {
      for (let i = 0; i < repositories.length; i++) {
        const repository = repositories[i];
        if (rows[i].blockers.length || rows[i].noop) continue;
        const tree = await this.command(repository.directory, ['ls-tree', '-rz', repository.head]);
        for (const entry of tree.split('\0').filter((line) => line.startsWith('160000 '))) {
          const file = entry.slice(entry.indexOf('\t') + 1);
          const oid = entry.split(' ')[2].split('\t')[0];
          const childPath = repository.path === '.' ? file : `${repository.path}/${file}`;
          const child = repositories.find((item) => item.path === childPath);
          if (!child || child.error) {
            rows[i].blockers.push(`Submodule ${file} is unavailable.`);
            continue;
          }
          const childRow = rows.find((item) => item.path === childPath)!;
          const published = await this.command(child.directory, [
            'for-each-ref',
            `--contains=${oid}`,
            '--format=%(refname)',
            'refs/remotes',
          ]).catch(() => '');
          const planned =
            !childRow.blockers.length && (await this.ancestor(child.directory, oid, child.head));
          if (!published && !planned)
            rows[i].blockers.push(`Publish the referenced commit in ${file} manually first.`);
        }
      }
    }
    return rows;
  }

  preview(projectId: string, input: GitActionInput): Promise<GitActionPreview> {
    if (!input || !['checkout', 'pull', 'push', 'create', 'rename', 'delete'].includes(input.action))
      return Promise.reject(new Error('Choose a supported Git action.'));
    if (
      (input.force !== undefined && typeof input.force !== 'boolean') ||
      (input.deleteRemote !== undefined && typeof input.deleteRemote !== 'boolean')
    )
      return Promise.reject(new Error('Choose a valid deletion option.'));
    return this.exclusive(
      projectId,
      async () => {
        this.project(projectId);
        if (input.action === 'pull' || input.action === 'push')
          await this.fetchRepositories(await this.discover(projectId), (done, total) =>
            this.emitProgress(projectId, { stage: 'fetching', done, total }),
          );
        const repositories = await this.discover(projectId);
        await this.reconcile(projectId, repositories);
        this.emitProgress(projectId, { stage: 'checking', done: 0, total: repositories.length });
        const rows = await this.rows(repositories, input, true);
        if (this.uncertainOperation(repositories))
          rows[0].blockers.push(
            'Check the previous uncertain result, then acknowledge it before starting another action.',
          );
        const preview: GitActionPreview = {
          id: randomUUID(),
          projectId,
          action: input.action,
          rows,
          ready: rows.every((row) => !row.blockers.length),
        };
        if (input.action === 'delete' && input.branch?.kind !== 'remote') {
          const candidates = await mapConcurrent(repositories, 4, async (repository) => {
            if (repository.error) return [repository.path, []] as const;
            const targets = await Promise.all(
              repository.remotes.map(async (remote) => {
                try {
                  return await this.localRemoteDeletion(repository, {
                    ...input,
                    deleteRemotes: { [repository.path]: remote },
                  });
                } catch {
                  // Optional remote discovery must not prevent a local-only deletion.
                  return undefined;
                }
              }),
            );
            return [
              repository.path,
              targets.filter((target): target is GitDestination => Boolean(target?.commit)),
            ] as const;
          });
          preview.remoteDeletionCandidates = Object.fromEntries(candidates);
        }
        for (const [id, prepared] of this.plans)
          if (Date.now() - prepared.created > 300_000) this.plans.delete(id);
        this.plans.set(preview.id, {
          preview,
          input: structuredClone(input),
          repositories,
          created: Date.now(),
        });
        return preview;
      },
      'preview',
    );
  }

  private sameRepository(before: Repository, after: Repository, action: GitActionInput['action']): boolean {
    return (
      before.directory === after.directory &&
      before.branch === after.branch &&
      before.head === after.head &&
      !after.error &&
      !after.inProgress &&
      (['push', 'create', 'rename', 'delete'].includes(action) || before.signature === after.signature)
    );
  }

  needsJiraClose(projectId: string, previewId: string): boolean {
    const prepared = this.plans.get(previewId);
    return (
      prepared?.preview.projectId === projectId &&
      (prepared.input.action === 'checkout' || prepared.input.action === 'rename')
    );
  }

  run(projectId: string, previewId: string): Promise<GitOperation> {
    return this.exclusive(projectId, async () => {
      const prepared = this.plans.get(previewId);
      this.plans.delete(previewId);
      if (
        !prepared ||
        prepared.preview.projectId !== projectId ||
        Date.now() - prepared.created > 300_000 ||
        !prepared.preview.ready
      )
        throw new Error('Prepare a fresh, unblocked action preview first.');
      const current = await this.discover(projectId);
      if (this.uncertainOperation(current))
        throw new Error(
          'Check and acknowledge the previous uncertain result before starting another action.',
        );
      const checkedRows = await this.rows(current, prepared.input, true);
      if (
        current.length !== prepared.repositories.length ||
        current.some(
          (repository, i) =>
            repository.path !== prepared.repositories[i].path ||
            !this.sameRepository(prepared.repositories[i], repository, prepared.input.action),
        ) ||
        JSON.stringify(checkedRows) !== JSON.stringify(prepared.preview.rows)
      )
        throw new Error('The project changed since the preview. Prepare a new preview.');
      const operation: GitOperation = {
        id: randomUUID(),
        projectId,
        action: prepared.input.action,
        state: 'running',
        startedAt: new Date().toISOString(),
        rows: prepared.preview.rows.map((row) => ({ ...row, state: 'pending' })),
      };
      this.journal.operations[projectId] = operation;
      this.journal.directories[projectId] = Object.fromEntries(
        current.map((repository) => [repository.path, repository.directory]),
      );
      await this.save();
      this.emit(projectId, true);
      const order = current.map((repository, index) => ({ repository, index }));
      const deletedRemotes = new Set<string>();
      const executeRow = async ({ repository, index }: (typeof order)[number]) => {
        if (operation.state !== 'running') return;
        const row = operation.rows[index];
        let attempted = false;
        try {
          if ((await realpath(this.project(projectId).repoPath)) !== current[0].directory)
            throw new Error('The project location changed. Prepare a new preview.');
          if (
            (await realpath(repository.directory)) !== repository.directory ||
            (await realpath(await this.command(repository.directory, ['rev-parse', '--show-toplevel']))) !==
              repository.directory
          )
            throw new Error('The repository location changed. Handle it manually.');
          const latest = await this.inspect(repository.directory, repository.path);
          // Parent operations can change unstaged gitlink differences; file/index edits still block.
          if (
            latest.branch !== repository.branch ||
            latest.head !== repository.head ||
            latest.error ||
            latest.inProgress ||
            ((operation.action === 'checkout' || operation.action === 'pull') && latest.changes)
          )
            throw new Error('The checkout changed during the operation. Prepare a new preview.');
          const [rechecked] = await this.rows([latest], prepared.input, true, false);
          // Different repositories may share one server branch. Once its deletion
          // has been confirmed, subsequent rows only need to prune their own refs.
          const remoteTarget = row.source?.remote ? row.source : row.remoteDeletion;
          const remoteKey = remoteTarget ? JSON.stringify([remoteTarget.url, remoteTarget.branch]) : '';
          const sharedDeletion = operation.action === 'delete' && deletedRemotes.has(remoteKey);
          const recheckedRemote = rechecked.source?.remote ? rechecked.source : rechecked.remoteDeletion;
          if (sharedDeletion && recheckedRemote?.commit === null)
            recheckedRemote.commit = remoteTarget!.commit;
          if (
            rechecked.blockers.length ||
            JSON.stringify(rechecked.destination) !== JSON.stringify(row.destination) ||
            rechecked.createTracking !== row.createTracking ||
            JSON.stringify(rechecked.source) !== JSON.stringify(row.source) ||
            rechecked.sourceConfigSignature !== row.sourceConfigSignature ||
            rechecked.unmergedCommits !== row.unmergedCommits ||
            JSON.stringify(rechecked.remoteDeletion) !== JSON.stringify(row.remoteDeletion)
          )
            throw new Error(
              rechecked.blockers.join(' ') || 'The branch destination changed. Prepare a new preview.',
            );
          row.state = 'running';
          await this.save();
          this.emit(projectId, true);
          if (!row.noop) {
            attempted = true;
            const destination = row.destination!;
            if (operation.action === 'checkout') {
              await this.command(
                repository.directory,
                row.createTracking
                  ? [
                      'switch',
                      '--no-recurse-submodules',
                      '--track',
                      '-c',
                      destination.branch,
                      `${destination.remote}/${destination.branch}`,
                    ]
                  : ['switch', '--no-recurse-submodules', '--no-guess', '--', destination.branch],
              );
            } else if (operation.action === 'create') {
              await this.command(repository.directory, [
                'branch',
                '--no-track',
                '--',
                destination.branch,
                destination.commit!,
              ]);
            } else if (operation.action === 'rename') {
              await this.command(repository.directory, [
                'branch',
                '-m',
                '--',
                row.source!.branch,
                destination.branch,
              ]);
            } else if (operation.action === 'delete') {
              const source = row.source!;
              if (remoteTarget?.commit) {
                await this.deleteRemoteBranch(repository, remoteTarget, sharedDeletion);
                deletedRemotes.add(remoteKey);
              }
              if (!source.remote && source.commit) {
                await this.command(repository.directory, [
                  'branch',
                  prepared.input.force ? '-D' : '-d',
                  '--',
                  source.branch,
                ]);
                const after = await this.inspect(repository.directory, repository.path);
                if (
                  after.refs.has(`refs/heads/${source.branch}`) ||
                  (await this.branchConfigSignature(repository.directory, source.branch)) ||
                  after.branch !== row.branch ||
                  after.head !== row.head
                )
                  throw new Error('The branch changed during deletion. Inspect the result manually.');
              }
              // Keep the upstream ref available for Git's normal merged check
              // until the local branch deletion finishes.
              if (remoteTarget) await this.pruneDeletedRemote(repository, remoteTarget);
            } else if (operation.action === 'pull') {
              await this.command(repository.directory, [
                '-c',
                'merge.autoStash=false',
                'merge',
                '--ff-only',
                '--no-autostash',
                '--no-edit',
                destination.commit!,
              ]);
            } else {
              const liveRemote = await this.remoteCommit(repository, destination.remote, destination.branch);
              if (liveRemote !== destination.commit)
                throw new Error('The remote changed during the operation. Prepare a new preview.');
              await this.command(repository.directory, [
                'push',
                '--porcelain',
                '--no-follow-tags',
                '--recurse-submodules=check',
                destination.remote,
                `${row.head}:refs/heads/${destination.branch}`,
              ]);
              await this.remoteCommit(repository, destination.remote, destination.branch);
              if (row.createTracking) await this.setTracking(repository, row);
            }
          } else if (operation.action === 'push' && row.createTracking) {
            await this.setTracking(repository, row);
          }
          if (
            (operation.action === 'create' || operation.action === 'rename') &&
            !(await this.branchEditConfirmed(
              await this.inspect(repository.directory, repository.path),
              row,
              operation.action,
            ))
          )
            throw new Error('The branch changed during the operation. Inspect the result manually.');
          row.state = 'done';
          row.message =
            operation.action === 'delete'
              ? row.noop
                ? 'Branch not present; skipped.'
                : row.remoteDeletion
                  ? 'Local and remote branches deleted.'
                  : 'Branch deleted.'
              : row.noop
                ? 'Already up to date.'
                : 'Completed.';
          await this.save();
          this.emit(projectId, true);
        } catch (error) {
          row.state = attempted ? 'unknown' : 'failed';
          row.message = message(error);
          operation.state = 'failed';
          await this.save();
          this.emit(projectId, true);
        }
      };
      if (operation.action === 'push') {
        // Finish descendants before publishing a parent gitlink. Independent
        // siblings share the network, with at most four active pushes.
        const depth = (repository: Repository) =>
          repository.path === '.' ? 0 : repository.path.split('/').length;
        const levels = [...new Set(order.map(({ repository }) => depth(repository)))].sort((a, b) => b - a);
        for (const level of levels) {
          await mapConcurrent(
            order.filter(({ repository }) => depth(repository) === level),
            4,
            executeRow,
          );
          if (operation.state !== 'running') break;
        }
      } else {
        for (const item of order) {
          await executeRow(item);
          if (operation.state !== 'running') break;
        }
      }
      // Drain all started writes before discovery/recovery observes their results.
      if (operation.state === 'failed') await this.reconcile(projectId, await this.discover(projectId));
      if (operation.state === 'running') operation.state = 'completed';
      await this.save();
      return structuredClone(operation);
    });
  }

  private async setTracking(repository: Repository, row: GitActionRow): Promise<void> {
    if (await this.config(repository.directory, `branch.${row.branch}.remote`))
      throw new Error('Push finished, but tracking settings changed. Configure tracking manually.');
    await this.command(repository.directory, [
      'config',
      `branch.${row.branch}.remote`,
      row.destination!.remote,
    ]);
    await this.command(repository.directory, [
      'config',
      `branch.${row.branch}.merge`,
      `refs/heads/${row.destination!.branch}`,
    ]);
  }

  private async deleteRemoteBranch(
    repository: Repository,
    target: GitDestination,
    alreadyDeleted: boolean,
  ): Promise<void> {
    if (!alreadyDeleted) {
      const url = await this.command(repository.directory, ['remote', 'get-url', '--push', target.remote]);
      if (message(url) !== target.url)
        throw new Error('The remote destination changed. Prepare a new preview.');
      await this.command(repository.directory, [
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--recurse-submodules=no',
        `--force-with-lease=refs/heads/${target.branch}:${target.commit}`,
        url,
        `:refs/heads/${target.branch}`,
      ]);
    }
    const after = await this.remoteDeletionTarget(repository, target.remote, target.branch);
    if (after.url !== target.url || after.commit !== null)
      throw new Error('The remote branch is still present. Inspect the result manually.');
  }

  private async pruneDeletedRemote(repository: Repository, source: GitDestination): Promise<void> {
    // The server deletion is confirmed. Compare-and-delete only this clone's
    // tracking ref, preserving a concurrent fetch that changed it meanwhile.
    const fetchUrl = message(await this.command(repository.directory, ['remote', 'get-url', source.remote]));
    if (fetchUrl !== source.url) return;
    const ref = `refs/remotes/${source.remote}/${source.branch}`;
    const commit = await this.command(repository.directory, ['rev-parse', '--verify', ref]).catch(() => null);
    if (commit) await this.command(repository.directory, ['update-ref', '-d', ref, commit]);
  }

  private async branchEditConfirmed(
    repository: Repository,
    row: GitActionRow,
    action: 'create' | 'rename',
  ): Promise<boolean> {
    const destination = row.destination!;
    if (repository.refs.get(`refs/heads/${destination.branch}`) !== destination.commit) return false;
    if (action === 'create') return true;
    return (
      !repository.refs.has(`refs/heads/${row.source!.branch}`) &&
      (await this.branchConfigSignature(repository.directory, destination.branch)) ===
        row.sourceConfigSignature &&
      repository.branch === (row.branch === row.source!.branch ? destination.branch : row.branch) &&
      repository.head === row.head
    );
  }

  private async reconcile(projectId: string, repositories: Repository[]): Promise<void> {
    const operation = this.journal.operations[projectId];
    if (!operation || !operation.rows.some((row) => row.state === 'unknown')) return;
    for (const row of operation.rows) {
      if (row.state !== 'unknown') continue;
      const repository = repositories.find((item) => item.path === row.path && !item.error);
      if (!repository || this.journal.directories[projectId]?.[row.path] !== repository.directory) continue;
      try {
        if (operation.action === 'delete') {
          const source = row.source!;
          const target = source.remote ? source : row.remoteDeletion;
          let remoteDone = !target;
          let remoteUnchanged = !target;
          if (target) {
            const actual = await this.remoteDeletionTarget(repository, target.remote, target.branch);
            if (actual.url !== target.url) continue;
            remoteDone = actual.commit === null;
            remoteUnchanged = actual.commit === target.commit;
            if (remoteDone) await this.pruneDeletedRemote(repository, target);
          }
          let localDone = !!source.remote;
          let localUnchanged = !!source.remote;
          if (!source.remote) {
            if (repository.branch !== row.branch || repository.head !== row.head) continue;
            const commit = repository.refs.get(`refs/heads/${source.branch}`) ?? null;
            const config = await this.branchConfigSignature(repository.directory, source.branch);
            localDone = commit === null && (!source.commit || config === '');
            localUnchanged = commit === source.commit && config === (row.sourceConfigSignature ?? '');
          }
          if (localDone && remoteDone) {
            row.state = 'done';
            row.message = 'Git confirms the branch was deleted.';
          } else if (localUnchanged && (remoteUnchanged || remoteDone)) {
            row.state = 'failed';
            row.message =
              target?.commit && remoteDone && !source.remote
                ? 'Remote branch deleted; local branch remains. Prepare a new preview to retry.'
                : 'Git confirms the branch was not deleted.';
          } else if (localDone && remoteUnchanged) {
            row.state = 'failed';
            row.message = 'Local branch deleted; remote branch remains. Prepare a new preview to retry.';
          }
          continue;
        }
        const destination = row.destination!;
        const remoteHead =
          operation.action === 'push'
            ? await this.remoteCommit(repository, destination.remote, destination.branch)
            : undefined;
        const refOnly = operation.action === 'create' || operation.action === 'rename';
        const destinationHead = repository.refs.get(`refs/heads/${destination.branch}`);
        const sourceHead = row.source && repository.refs.get(`refs/heads/${row.source.branch}`);
        const done = refOnly
          ? await this.branchEditConfirmed(repository, row, operation.action as 'create' | 'rename')
          : operation.action === 'push'
            ? remoteHead === row.head
            : repository.branch === (operation.action === 'checkout' ? destination.branch : row.branch) &&
              repository.head === destination.commit;
        if (done) {
          row.state = 'done';
          row.message = refOnly
            ? 'Git confirms the branch change completed.'
            : 'Git confirms the requested revision is present. Check tracking settings if publication was interrupted.';
        } else if (
          refOnly
            ? !destinationHead && (operation.action === 'create' || sourceHead === row.source?.commit)
            : operation.action === 'push'
              ? remoteHead === destination.commit
              : repository.head === row.head && repository.branch === row.branch
        ) {
          row.state = 'failed';
          row.message = 'Git confirms the destination was not updated.';
        }
      } catch {
        /* Keep uncertainty visible when the destination cannot be verified. */
      }
    }
    await this.save();
  }

  acknowledge(projectId: string): Promise<GitWorkflowSnapshot> {
    return this.read(async () => {
      this.project(projectId);
      const repositories = await this.discover(projectId);
      for (const [id, operation] of Object.entries(this.journal.operations)) {
        for (const row of operation.rows)
          if (
            row.state === 'unknown' &&
            repositories.some(
              (repository) => repository.directory === this.journal.directories[id]?.[row.path],
            )
          ) {
            row.state = 'failed';
            row.message = 'Result checked manually. A fresh preview is required before retrying.';
          }
      }
      await this.save();
      return this.snapshot(projectId, repositories);
    });
  }
}
