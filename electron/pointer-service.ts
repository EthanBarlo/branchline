import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryMapping } from '../shared/integrations';

export interface PointerIdentity { name: string; email: string; }
export interface PointerRemoteInput {
  repository: RepositoryMapping;
  sourceBranch: string;
  expectedHead: string;
  credentials: { email: string; token: string };
  signal?: AbortSignal;
}
export interface PointerPrepareInput extends PointerRemoteInput {
  updates: Record<string, string>;
  identity: PointerIdentity;
  operationId: string;
}
export interface PointerServiceOptions {
  /** An explicit test seam; production never permits a local or arbitrary remote. */
  testTransport?: { remoteFor(repository: RepositoryMapping): string; beforePush?(): Promise<void> };
  commandTimeoutMs?: number;
}

const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
const objectId = /^[a-f0-9]{40}$/;
const locks = new Map<string, Promise<unknown>>();
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

// No secret is interpolated into this argument or persisted to a config file.
// Git invokes the helper only for this HTTPS host; redirects are disabled too.
const credentialHelper = '!f() { if test "$1" = get; then protocol=; host=; while IFS="=" read -r key value; do test -n "$key" || break; case "$key" in protocol) protocol="$value" ;; host) host="$value" ;; esac; done; if test "$protocol" = https && test "$host" = bitbucket.org; then printf "username=x-bitbucket-api-token-auth\\npassword=%s\\n" "$BRANCHLINE_GIT_API_TOKEN"; fi; fi; }; f';

function environment(allowIdentityConfig = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile,
    ...(allowIdentityConfig ? {} : { GIT_CONFIG_GLOBAL: nullFile }),
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat',
  };
}

function assertHash(value: string): void {
  if (!objectId.test(value) || /^0+$/.test(value)) throw new Error('This operation requires a complete, nonzero Git commit hash.');
}

function validateIdentity(identity: PointerIdentity): void {
  if (!identity.name?.trim() || !identity.email?.trim() || !identity.email.includes('@')
    || [identity.name, identity.email].some(value => value.length > 320 || /[\r\n\0<>]/.test(value))) {
    throw new Error('Configure a valid Git user.name and user.email before updating submodule pointers.');
  }
}

function updateEntries(input: PointerPrepareInput): [string, string][] {
  validateIdentity(input.identity);
  if (!input.operationId || input.operationId.length > 512) throw new Error('A saved operation ID is required for submodule updates.');
  const entries = Object.entries(input.updates).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!entries.length) throw new Error('Choose at least one submodule pointer to update.');
  for (const [file, hash] of entries) {
    if (!file || file.includes('\0') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Submodule paths must be canonical repository-relative paths.');
    }
    assertHash(hash);
  }
  return entries;
}

/** All writes, refs and temporary indexes belong to Branchline's bare workspace. */
export class PointerService {
  private readonly workspaceRoot: string;
  private readonly options: PointerServiceOptions;

  constructor(workspaceRoot: string, options: PointerServiceOptions = {}) {
    if (options.testTransport && process.env.NODE_ENV !== 'test') throw new Error('A pointer transport override is only available in tests.');
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.options = options;
  }

  private command(cwd: string, args: string[], options: {
    input?: string; env?: NodeJS.ProcessEnv; credentials?: PointerRemoteInput['credentials'];
    signal?: AbortSignal; allowIdentityConfig?: boolean;
  } = {}): Promise<string> {
    if (options.signal?.aborted) return Promise.reject(new Error('Remote Git operation was cancelled.'));
    const env = { ...environment(options.allowIdentityConfig), ...options.env };
    const config = [
      '-c', `core.hooksPath=${nullFile}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false',
      '-c', `core.attributesFile=${nullFile}`, '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false', '-c', 'safe.bareRepository=all',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
      '-c', 'credential.helper=', '-c', 'credential.interactive=false', '-c', 'credential.useHttpPath=true',
    ];
    if (this.options.testTransport) config.push('-c', 'protocol.file.allow=always');
    if (options.credentials) {
      if (!options.credentials.token || /[\0\r\n]/.test(options.credentials.token)) return Promise.reject(new Error('A valid Bitbucket API token is required.'));
      config.push('-c', `credential.helper=${credentialHelper}`);
      env.BRANCHLINE_GIT_API_TOKEN = options.credentials.token;
    }
    return new Promise((resolve, reject) => {
      const child = execFile('git', [...config, ...args], {
        cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        timeout: this.options.commandTimeoutMs ?? 120_000, signal: options.signal,
      }, (error, stdout, stderr) => {
        delete env.BRANCHLINE_GIT_API_TOKEN;
        if (!error) { resolve(stdout.trimEnd()); return; }
        let message = options.signal?.aborted ? 'Remote Git operation was cancelled.'
          : error.killed ? 'Git timed out. Check the remote operation result before retrying.'
            : stderr.trim() || error.message;
        if (options.credentials?.token) {
          message = message.split(options.credentials.token).join('[redacted]');
          message = message.split(Buffer.from(`x-bitbucket-api-token-auth:${options.credentials.token}`).toString('base64')).join('[redacted]');
        }
        reject(new Error(message));
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    });
  }

  async preflight(repoPath: string): Promise<PointerIdentity> {
    // Config reads do not execute hooks/helpers and never refresh the checkout index.
    const cwd = path.resolve(repoPath);
    await this.command(cwd, ['--version']);
    const readIdentity = (key: string): Promise<string> => this.command(cwd, ['config', '--includes', '--get', key], { allowIdentityConfig: true }).catch(() => '');
    const [name, email] = await Promise.all([readIdentity('user.name'), readIdentity('user.email')]);
    const identity = { name, email };
    validateIdentity(identity);
    return identity;
  }

  private remote(repository: RepositoryMapping): string {
    for (const value of [repository.workspace, repository.repoSlug]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.includes('..')) throw new Error('Choose a valid Bitbucket workspace and repository slug.');
    }
    const override = this.options.testTransport?.remoteFor(repository);
    if (override !== undefined) {
      if (!path.isAbsolute(override) || override.includes('\0')) throw new Error('Test remotes must be absolute local paths.');
      return override;
    }
    return `https://bitbucket.org/${repository.workspace}/${repository.repoSlug}.git`;
  }

  private directory(repository: RepositoryMapping): string {
    return path.join(this.workspaceRoot, digest(`${repository.workspace}/${repository.repoSlug}`));
  }

  private async serialized<T>(directory: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(directory) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(directory, next);
    try { return await next; } finally { if (locks.get(directory) === next) locks.delete(directory); }
  }

  private async initialize(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await stat(path.join(directory, 'HEAD')); }
    catch { await this.command(directory, ['init', '--bare', '--template=', '.']); }
    if (await this.command(directory, ['rev-parse', '--is-bare-repository']) !== 'true') throw new Error('The pointer workspace must be an app-owned bare repository.');
  }

  private async validateRemoteInput(directory: string, input: PointerRemoteInput): Promise<string> {
    assertHash(input.expectedHead);
    const remote = this.remote(input.repository);
    if (!input.sourceBranch || input.sourceBranch.startsWith('-')) throw new Error('A valid source branch is required.');
    await this.command(directory, ['check-ref-format', `refs/heads/${input.sourceBranch}`], { signal: input.signal });
    return remote;
  }

  private preparedRef(input: PointerPrepareInput): string {
    return `refs/branchline/prepared/${digest(JSON.stringify({
      operationId: input.operationId, sourceBranch: input.sourceBranch, base: input.expectedHead,
      identity: input.identity, updates: updateEntries(input),
    }))}`;
  }

  private async verifyTree(directory: string, input: PointerPrepareInput, treeish: string): Promise<void> {
    const expected = new Map(updateEntries(input));
    const raw = await this.command(directory, ['diff-tree', '--no-commit-id', '--raw', '--no-abbrev', '--no-renames', '-z', '-r', input.expectedHead, treeish], { signal: input.signal });
    const chunks = raw.split('\0');
    for (let index = 0; chunks[index]; index += 2) {
      const [oldMode, newMode, , newHash, status] = chunks[index].slice(1).split(' ');
      const file = chunks[index + 1];
      if (oldMode !== '160000' || newMode !== '160000' || status !== 'M' || expected.get(file) !== newHash) {
        throw new Error('The generated commit contains a change other than the selected existing submodule pointers.');
      }
    }
    // Also verify unchanged requested pointers; an empty diff is valid only when already up to date.
    for (const [file, hash] of expected) {
      const entry = await this.command(directory, ['ls-tree', '-z', treeish, '--', `:(literal)${file}`], { signal: input.signal });
      if (entry !== `160000 commit ${hash}\t${file}\0`) throw new Error(`The generated submodule pointer does not match the requested commit: ${file}`);
    }
  }

  async prepare(input: PointerPrepareInput): Promise<{ commit: string; base: string }> {
    const entries = updateEntries(input);
    const directory = this.directory(input.repository);
    return this.serialized(directory, async () => {
      await this.initialize(directory);
      const remote = await this.validateRemoteInput(directory, input);
      const ref = this.preparedRef(input);
      const cached = await this.command(directory, ['rev-parse', '--verify', ref], { signal: input.signal }).catch(() => '');
      if (cached) {
        await this.verifyPrepared(directory, input, cached);
        return { commit: cached, base: input.expectedHead };
      }
      const fetchedRef = `refs/branchline/source/${digest(input.sourceBranch)}`;
      await this.command(directory, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', remote, `+refs/heads/${input.sourceBranch}:${fetchedRef}`], input);
      const actual = await this.command(directory, ['rev-parse', '--verify', `${fetchedRef}^{commit}`], { signal: input.signal });
      if (actual !== input.expectedHead) throw new Error('The parent source branch changed. Refresh and review it before updating submodule pointers.');
      const temporary = await mkdtemp(path.join(directory, 'pointer-index-'));
      const env = { GIT_INDEX_FILE: path.join(temporary, 'index') };
      try {
        await this.command(directory, ['read-tree', input.expectedHead], { env, signal: input.signal });
        for (const [file] of entries) {
          const entry = await this.command(directory, ['ls-tree', '-z', input.expectedHead, '--', `:(literal)${file}`], { signal: input.signal });
          const tab = entry.indexOf('\t');
          if (!entry.startsWith('160000 commit ') || entry.slice(tab + 1) !== `${file}\0`) throw new Error(`The selected path is not an existing submodule: ${file}`);
        }
        await this.command(directory, ['update-index', '-z', '--index-info'], { env, signal: input.signal, input: entries.map(([file, hash]) => `160000 ${hash}\t${file}\0`).join('') });
        const tree = await this.command(directory, ['write-tree'], { env, signal: input.signal });
        await this.verifyTree(directory, input, tree);
        const originalTree = await this.command(directory, ['rev-parse', `${input.expectedHead}^{tree}`], { signal: input.signal });
        let commit = input.expectedHead;
        if (tree !== originalTree) {
          // Stable dates allow recovery even if the process stops before recording the prepared ref.
          const timestamp = Number(await this.command(directory, ['show', '-s', '--format=%ct', input.expectedHead], { signal: input.signal })) + 1;
          if (!Number.isSafeInteger(timestamp)) throw new Error('The parent commit has an invalid timestamp.');
          commit = await this.command(directory, ['commit-tree', tree, '-p', input.expectedHead], {
            signal: input.signal, input: 'Update submodule pointers\n',
            env: { GIT_AUTHOR_NAME: input.identity.name, GIT_AUTHOR_EMAIL: input.identity.email,
              GIT_COMMITTER_NAME: input.identity.name, GIT_COMMITTER_EMAIL: input.identity.email,
              GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000` },
          });
        }
        await this.command(directory, ['update-ref', ref, commit], { signal: input.signal });
        return { commit, base: input.expectedHead };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  private async verifyPrepared(directory: string, input: PointerPrepareInput, commit: string): Promise<void> {
    assertHash(commit);
    if (commit !== input.expectedHead) {
      const parents = await this.command(directory, ['show', '-s', '--format=%P', commit], { signal: input.signal });
      if (parents !== input.expectedHead) throw new Error('The prepared pointer commit must be a direct descendant of the reviewed source commit.');
    }
    await this.verifyTree(directory, input, commit);
  }

  private async remoteHead(directory: string, input: PointerRemoteInput, remote: string): Promise<string | undefined> {
    const result = await this.command(directory, ['ls-remote', '--heads', '--', remote, `refs/heads/${input.sourceBranch}`], input);
    return result.split('\n').map(line => line.split('\t')).find(([, ref]) => ref === `refs/heads/${input.sourceBranch}`)?.[0];
  }

  async verifyRemote(input: PointerRemoteInput): Promise<boolean> {
    const directory = this.directory(input.repository);
    return this.serialized(directory, async () => {
      await this.initialize(directory);
      const remote = await this.validateRemoteInput(directory, input);
      return await this.remoteHead(directory, input, remote) === input.expectedHead;
    });
  }

  /** Delete only the reviewed remote ref; no fetch, checkout or local index is needed. */
  async deleteBranch(input: PointerRemoteInput): Promise<void> {
    const directory = this.directory(input.repository);
    await this.serialized(directory, async () => {
      await this.initialize(directory);
      const remote = await this.validateRemoteInput(directory, input);
      const actual = await this.remoteHead(directory, input, remote);
      if (actual === undefined) return; // Reconcile a deletion whose response was lost.
      if (actual !== input.expectedHead) throw new Error('The source branch changed. It was retained instead of deleted.');
      await this.options.testTransport?.beforePush?.();
      // Unlike an unconditional provider DELETE, an explicit old-OID lease also
      // rejects a concurrent push or rollback after the final remote read.
      await this.command(directory, ['push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/${input.sourceBranch}:${input.expectedHead}`, '--', remote, `:refs/heads/${input.sourceBranch}`], input);
      if (await this.remoteHead(directory, input, remote) !== undefined) throw new Error('The deletion completed but the source branch exists again. It was retained; check Bitbucket before continuing.');
    });
  }

  async push(input: PointerPrepareInput & { commit: string }): Promise<void> {
    const directory = this.directory(input.repository);
    await this.serialized(directory, async () => {
      await this.initialize(directory);
      const remote = await this.validateRemoteInput(directory, input);
      const prepared = await this.command(directory, ['rev-parse', '--verify', this.preparedRef(input)], { signal: input.signal }).catch(() => '');
      if (prepared !== input.commit) throw new Error('Prepare and save this pointer update before pushing it.');
      await this.verifyPrepared(directory, input, input.commit);
      const actual = await this.remoteHead(directory, input, remote);
      if (actual === input.commit) return; // Reconcile a completed push after a lost response.
      if (actual !== input.expectedHead) throw new Error('The parent source branch changed. The prepared pointer update was not pushed.');
      await this.options.testTransport?.beforePush?.();
      // An explicit old-OID lease catches advances AND rollbacks after the read above.
      // The only allowed new commit is the verified direct child of that exact old OID.
      await this.command(directory, ['push', '--porcelain', '--no-verify', `--force-with-lease=refs/heads/${input.sourceBranch}:${input.expectedHead}`, '--', remote, `${input.commit}:refs/heads/${input.sourceBranch}`], input);
      if (await this.remoteHead(directory, input, remote) !== input.commit) throw new Error('The push completed but the remote source changed again. Refresh the PR before continuing.');
    });
  }
}
