import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepoInspection, RepoStatus, ReviewConfig, ReviewFile, ReviewSnapshot } from '../shared/types';

const TEXT_LIMIT = 1024 * 1024;
const CACHE_LIMIT = 24 * TEXT_LIMIT;
const blobCache = new Map<string, Buffer>();
let cacheSize = 0;

// Git is only ever used for reads. In particular, do not refresh the index or
// invoke a repository's configured external diff, textconv, or fsmonitor.
function git(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], {
      cwd, encoding: 'buffer', maxBuffer: 40 * TEXT_LIMIT, timeout: 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString().trim() || error.message));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).toString('utf8').trimEnd();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }));
  return results;
}

interface Entry { mode: string; oid: string }
interface Change { path: string; oldPath?: string; old: Entry; new: Entry; status: ReviewFile['status'] }
interface Metadata { root: string; currentBranch: string | null; checkoutCommit: string; refs: Map<string, string>; format: 'sha1' | 'sha256' }

async function metadata(repo: string): Promise<Metadata> {
  const [root, branch, checkoutCommit, refList, format] = await Promise.all([
    gitText(repo, ['rev-parse', '--show-toplevel']),
    gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    gitText(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    gitText(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes']),
    gitText(repo, ['rev-parse', '--show-object-format']),
  ]);
  const refs = new Map(refList.split('\n').filter(Boolean).map(line => {
    const [name, oid] = line.split('\0');
    return [name, oid] as const;
  }));
  return { root: await realpath(root), currentBranch: branch || null, checkoutCommit, refs, format: format === 'sha256' ? 'sha256' : 'sha1' };
}

export async function inspectRepo(repoPath: string): Promise<RepoInspection> {
  const info = await metadata(path.resolve(repoPath));
  const branches = [...info.refs.keys()].filter(name => !name.endsWith('/HEAD')).map(name => name.replace(/^refs\/(heads|remotes)\//, ''));
  return { rootPath: info.root, name: path.basename(info.root), branches: [...new Set(branches)].sort(), currentBranch: info.currentBranch };
}

function resolveBranch(info: Metadata, name: string): { ref: string; oid: string } {
  if (!name.trim()) throw new Error('Choose both a target branch and a feature branch.');
  const candidates = name.startsWith('refs/heads/') || name.startsWith('refs/remotes/')
    ? [name]
    : [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/origin/${name}`];
  for (const ref of candidates) {
    const oid = info.refs.get(ref);
    if (oid) return { ref, oid };
  }
  const matching = [...info.refs].filter(([ref]) => ref.startsWith('refs/remotes/') && ref.slice('refs/remotes/'.length).split('/').slice(1).join('/') === name);
  if (matching.length === 1) return { ref: matching[0][0], oid: matching[0][1] };
  if (matching.length > 1) throw new Error(`Branch “${name}” is ambiguous across remotes. Select a remote-qualified branch.`);
  throw new Error(`Branch “${name}” was not found locally or in remote-tracking refs. Fetch it outside Branchline, then refresh.`);
}

function parseTree(output: Buffer): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const item of output.toString('utf8').split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    const [mode, , oid] = item.slice(0, tab).split(' ');
    entries.set(item.slice(tab + 1), { mode, oid });
  }
  return entries;
}

function parseRaw(output: Buffer): Change[] {
  const chunks = output.toString('utf8').split('\0');
  const changes: Change[] = [];
  for (let index = 0; index < chunks.length && chunks[index];) {
    const [oldMode, newMode, oldOid, newOid, kind] = chunks[index++].slice(1).split(' ');
    const firstPath = chunks[index++];
    const renamed = kind.startsWith('R') || kind.startsWith('C');
    const newPath = renamed ? chunks[index++] : firstPath;
    if (oldMode === '160000' || newMode === '160000') continue;
    changes.push({ path: newPath, oldPath: renamed ? firstPath : undefined, old: { mode: oldMode, oid: /^0+$/.test(oldOid) ? '' : oldOid }, new: { mode: newMode, oid: /^0+$/.test(newOid) ? '' : newOid }, status: renamed ? 'R' : kind[0] as Change['status'] });
  }
  return changes;
}

function parseStats(output: Buffer): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>();
  const chunks = output.toString('utf8').split('\0');
  for (let index = 0; index < chunks.length && chunks[index];) {
    const item = chunks[index++];
    const firstTab = item.indexOf('\t');
    const secondTab = item.indexOf('\t', firstTab + 1);
    let file = item.slice(secondTab + 1);
    if (!file) { index++; file = chunks[index++]; }
    result.set(file, { additions: Number(item.slice(0, firstTab)) || 0, deletions: Number(item.slice(firstTab + 1, secondTab)) || 0 });
  }
  return result;
}

function cacheBlob(oid: string, data: Buffer): void {
  if (blobCache.has(oid)) return;
  while (cacheSize + data.length > CACHE_LIMIT && blobCache.size) {
    const oldest = blobCache.keys().next().value!;
    cacheSize -= blobCache.get(oldest)!.length;
    blobCache.delete(oldest);
  }
  blobCache.set(oid, data);
  cacheSize += data.length;
}

// Batch object reads avoid launching Git once for every changed line/file.
async function readBlobs(repo: string, oids: string[]): Promise<Map<string, Buffer | null>> {
  const unique = [...new Set(oids.filter(oid => oid && !/^0+$/.test(oid)))];
  const result = new Map<string, Buffer | null>();
  const missing = unique.filter(oid => {
    const cached = blobCache.get(oid);
    if (cached) { result.set(oid, cached); return false; }
    return true;
  });
  if (!missing.length) return result;
  const checks = (await git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], missing.join('\n') + '\n')).toString().trim().split('\n');
  let group: string[] = [];
  let groupSize = 0;
  const groups: string[][] = [];
  for (const line of checks) {
    const [oid, type, sizeString] = line.split(' ');
    const size = Number(sizeString);
    if (type !== 'blob') throw new Error(`Git object ${oid} is unavailable or is not a file.`);
    if (size > TEXT_LIMIT) { result.set(oid, null); continue; }
    if (groupSize + size > 8 * TEXT_LIMIT && group.length) { groups.push(group); group = []; groupSize = 0; }
    group.push(oid); groupSize += size;
  }
  if (group.length) groups.push(group);
  for (const ids of groups) {
    const data = await git(repo, ['cat-file', '--batch'], ids.join('\n') + '\n');
    let offset = 0;
    for (const expected of ids) {
      const newline = data.indexOf(10, offset);
      const [oid, type, sizeString] = data.subarray(offset, newline).toString().split(' ');
      const size = Number(sizeString);
      if (oid !== expected || type !== 'blob' || !Number.isFinite(size)) throw new Error('Unexpected Git object response.');
      const content = Buffer.from(data.subarray(newline + 1, newline + 1 + size));
      result.set(oid, content); cacheBlob(oid, content);
      offset = newline + size + 2;
    }
  }
  return result;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface WorkingFile { entry: Entry; content: Buffer | null }
async function readWorkingFile(repo: string, file: string, format: Metadata['format'], modeHint: string): Promise<WorkingFile | null> {
  const absolute = path.resolve(repo, file);
  if (!inside(repo, absolute)) throw new Error(`File path escapes repository: ${file}`);
  try {
    const parent = await realpath(path.dirname(absolute));
    if (!inside(repo, parent)) throw new Error(`File parent resolves outside repository: ${file}`);
    const safePath = path.join(parent, path.basename(absolute));
    const stat = await lstat(safePath);
    if (stat.isDirectory()) return null;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported file type: ${file}`);
    const mode = stat.isSymbolicLink() ? '120000' : modeHint === '100755' || (stat.mode & 0o111) ? '100755' : '100644';
    if (stat.isSymbolicLink()) {
      const content = await readlink(safePath, { encoding: 'buffer' });
      return { entry: { mode, oid: createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex') }, content };
    }
    const handle = await open(safePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const hash = createHash(format).update(`blob ${opened.size}\0`);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = createReadStream(safePath, { fd: handle.fd, autoClose: false });
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        hash.update(buffer); bytes += buffer.length;
        if (opened.size <= TEXT_LIMIT && bytes <= TEXT_LIMIT) chunks.push(buffer);
      }
      const after = await handle.stat();
      if (bytes !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`File changed while reading: ${file}. Refresh to retry.`);
      return { entry: { mode, oid: hash.digest('hex') }, content: bytes <= TEXT_LIMIT ? Buffer.concat(chunks) : null };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function asText(content: Buffer | null | undefined): string | null {
  if (!content || content.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return null; }
}

const absent: Entry = { mode: '000000', oid: '' };
const lineCount = (text: string | null): number => !text ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

export async function buildSnapshot(config: ReviewConfig): Promise<ReviewSnapshot> {
  const rootInfo = await metadata(path.resolve(config.repoPath));
  const files: ReviewFile[] = [];
  const repos: RepoStatus[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();

  async function visit(repo: string, relativePath: string, depth: number, initial?: Metadata): Promise<void> {
    const label = relativePath === '.' ? 'Root repository' : relativePath;
    const status: RepoStatus = { relativePath, currentBranch: null, workingTreeIncluded: false };
    repos.push(status);
    let info: Metadata;
    try {
      const physical = await realpath(repo);
      if (!inside(rootInfo.root, physical)) throw new Error('Submodule resolves outside the selected repository.');
      if (visited.has(physical) || depth > 24) throw new Error('Repeated or excessively nested submodule path.');
      visited.add(physical);
      info = initial ?? await metadata(physical);
      if (info.root !== physical) throw new Error('Submodule is not initialized. Initialize it outside Branchline, then refresh.');
      status.currentBranch = info.currentBranch;
    } catch (error) {
      status.error = `Repository unavailable or uninitialized: ${(error as Error).message}`;
      warnings.push(`${label}: ${status.error}`);
      return;
    }

    let headTree = new Map<string, Entry>();
    const modulePaths = new Set<string>();
    try {
      const feature = resolveBranch(info, config.featureBranch);
      headTree = parseTree(await git(repo, ['ls-tree', '-rz', '--full-tree', feature.oid]));
      for (const [file, entry] of headTree) if (entry.mode === '160000') modulePaths.add(file);
      const base = resolveBranch(info, config.baseBranch);
      const mergeBases = (await gitText(repo, ['merge-base', '--all', base.oid, feature.oid]).catch(() => { throw new Error(`“${config.baseBranch}” and “${config.featureBranch}” have no common ancestor.`); })).split('\n');
      if (mergeBases.length !== 1) throw new Error('Multiple merge bases were found (criss-cross history). Resolve the branch history outside Branchline before reviewing this repository.');
      const mergeBase = mergeBases[0];
      status.baseCommit = mergeBase;
      status.headCommit = feature.oid;
      const checkedOutFeature = feature.ref.startsWith('refs/heads/')
        ? feature.ref.slice('refs/heads/'.length)
        : feature.ref.slice('refs/remotes/'.length).split('/').slice(1).join('/');
      const includeWorking = config.includeWorkingTree && info.currentBranch === checkedOutFeature && info.checkoutCommit === feature.oid;
      status.workingTreeIncluded = includeWorking;
      if (config.includeWorkingTree && !includeWorking) warnings.push(`${label}: working changes excluded because “${config.featureBranch}” is not the checked-out feature revision (current: ${info.currentBranch ?? 'detached HEAD'}).`);
      const diffArgs = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-abbrev', '-M', '-z', mergeBase, ...(includeWorking ? [] : [feature.oid]), '--'];
      const [raw, statsOutput, untrackedOutput, baseTreeOutput, indexOutput] = await Promise.all([
        git(repo, ['diff', '--raw', ...diffArgs]),
        git(repo, ['diff', '--numstat', ...diffArgs]),
        includeWorking ? git(repo, ['ls-files', '--others', '--exclude-standard', '-z']) : Buffer.alloc(0),
        git(repo, ['ls-tree', '-rz', '--full-tree', mergeBase]),
        includeWorking ? git(repo, ['ls-files', '--stage', '-z']) : Buffer.alloc(0),
      ]);
      if (indexOutput.toString().split('\0').some(item => item && item.slice(0, item.indexOf('\t')).split(' ')[2] !== '0')) {
        throw new Error('The working tree has unresolved merge conflicts. Resolve them outside Branchline, or turn off working changes to review committed changes.');
      }
      for (const item of indexOutput.toString().split('\0')) {
        if (item.startsWith('160000 ')) modulePaths.add(item.slice(item.indexOf('\t') + 1));
      }
      const baseTree = parseTree(baseTreeOutput);
      for (const [file, entry] of baseTree) if (entry.mode === '160000' && !modulePaths.has(file)) warnings.push(`${label}: submodule “${file}” was removed from the feature branch; its gitlink is not a line-reviewable file.`);
      const changes = new Map(parseRaw(raw).map(change => [change.path, change]));
      const untracked = new Set(untrackedOutput.toString('utf8').split('\0').filter(Boolean));
      for (const file of untracked) {
        const before = baseTree.get(file) ?? absent;
        if (before.mode === '160000' || [...modulePaths].some(module => file === module || file.startsWith(`${module}/`))) continue;
        const prior = changes.get(file);
        changes.set(file, { path: file, old: before, new: { mode: '100644', oid: '' }, status: before.mode === '000000' ? 'A' : 'M', ...(prior?.oldPath ? { oldPath: prior.oldPath } : {}) });
      }
      const stats = parseStats(statsOutput);
      const allChanges = [...changes.values()];
      const blobs = await readBlobs(repo, allChanges.flatMap(change => [change.old.oid, ...(includeWorking ? [] : [change.new.oid])]));
      const reviewed = await mapLimit(allChanges, 6, async change => {
        const oldContent = change.old.mode === '000000' ? undefined : blobs.get(change.old.oid);
        let newEntry = change.new;
        let newContent: Buffer | null | undefined;
        if (includeWorking && (change.new.mode !== '000000' || untracked.has(change.path))) {
          const current = await readWorkingFile(repo, change.path, info.format, change.new.mode);
          newEntry = current?.entry ?? absent;
          newContent = current?.content;
        } else newContent = change.new.mode === '000000' ? undefined : blobs.get(change.new.oid);
        if (change.old.mode === '000000' && newEntry.mode === '000000') return null;
        if (!change.oldPath && change.old.oid === newEntry.oid && change.old.mode === newEntry.mode) return null;
        const oldText = asText(oldContent);
        const newText = asText(newContent);
        const tooLarge = oldContent === null || newContent === null;
        const binary = !tooLarge && ((oldContent !== undefined && oldText === null) || (newContent !== undefined && newText === null));
        const rootPath = relativePath === '.' ? change.path : `${relativePath}/${change.path}`;
        const headEntry = headTree.get(change.path);
        const source = includeWorking && (newEntry.oid !== (headEntry?.oid ?? '') || newEntry.mode !== (headEntry?.mode ?? '000000')) ? 'working-tree' : 'committed';
        const counts = stats.get(change.path) ?? { additions: lineCount(newText), deletions: lineCount(oldText) };
        return {
          id: rootPath, repoRelativePath: relativePath, path: change.path, oldPath: change.oldPath,
          status: newEntry.mode === '000000' ? 'D' : change.old.mode === '000000' ? 'A' : change.status === 'D' ? 'M' : change.status,
          ...counts, oldContent: binary ? null : oldText, newContent: binary ? null : newText,
          binary, tooLarge, oldMode: change.old.mode, newMode: newEntry.mode,
          fingerprint: digest(JSON.stringify([relativePath, change.oldPath ?? change.path, change.path, change.old.mode, change.old.oid, newEntry.mode, newEntry.oid])),
          baseCommit: mergeBase, headCommit: feature.oid, source,
        } satisfies ReviewFile;
      });
      if (includeWorking) {
        const [branchAfter, commitAfter] = await Promise.all([
          gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
          gitText(repo, ['rev-parse', '--verify', 'HEAD']),
        ]);
        if (branchAfter !== info.currentBranch || commitAfter !== info.checkoutCommit) {
          throw new Error('The checkout changed during refresh. Refresh to retry against a consistent feature branch.');
        }
      }
      files.push(...reviewed.filter((file): file is NonNullable<typeof file> => file !== null));
    } catch (error) {
      status.error = (error as Error).message;
      warnings.push(`${label}: ${status.error}`);
      // Discover children even if this repository is missing the selected ref.
      // HEAD is used only for discovery, never as a substitute comparison ref.
      if (!modulePaths.size && info.checkoutCommit) {
        try {
          for (const [file, entry] of parseTree(await git(repo, ['ls-tree', '-rz', '--full-tree', info.checkoutCommit]))) if (entry.mode === '160000') modulePaths.add(file);
        } catch { /* The repository-level error remains visible. */ }
      }
    }
    for (const module of [...modulePaths].sort()) {
      const location = path.resolve(repo, module);
      const childRelative = relativePath === '.' ? module : `${relativePath}/${module}`;
      if (!inside(repo, location)) { warnings.push(`${label}: unsafe submodule path “${module}” skipped.`); continue; }
      await visit(location, childRelative, depth + 1);
    }
  }

  await visit(rootInfo.root, '.', 0, rootInfo);
  files.sort((a, b) => a.id.localeCompare(b.id));
  return {
    reviewId: config.id, files, repos, warnings, refreshedAt: new Date().toISOString(),
    fingerprint: digest(JSON.stringify([files.map(file => [file.id, file.fingerprint]), repos, warnings])),
  };
}
