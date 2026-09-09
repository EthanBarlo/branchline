import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryMapping } from '../shared/integrations';
const exec = promisify(execFile);

export function validRelativePath(value: unknown, allowRoot = true): value is string {
  return typeof value === 'string' && value.length <= 4096 && (allowRoot && value === '.' || !!value && !/[\\\u0000-\u001f\u007f]/.test(value) && !path.posix.isAbsolute(value) && !/^[a-z]:/i.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'));
}
export function validateRepositoryMappings(input: unknown): RepositoryMapping[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error('Choose at most 200 repository mappings.');
  const paths = new Set<string>();
  const repositories = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== 'object' || !validRelativePath(value.relativePath) || typeof value.workspace !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value.workspace) || typeof value.repoSlug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(value.repoSlug)) throw new Error('Each repository needs a safe relative path, workspace, and repository slug.');
    const identity = `${value.workspace}/${value.repoSlug}`.toLowerCase();
    if (paths.has(value.relativePath) || repositories.has(identity)) throw new Error('Each repository and local repository path can only be mapped once.');
    paths.add(value.relativePath); repositories.add(identity);
    const result: RepositoryMapping = { relativePath: value.relativePath, workspace: value.workspace, repoSlug: value.repoSlug };
    if (value.uuid !== undefined) { if (typeof value.uuid !== 'string' || !/^\{?[a-f0-9-]{36}\}?$/i.test(value.uuid)) throw new Error('The repository UUID is invalid.'); result.uuid = value.uuid; }
    if (value.parentRelativePath !== undefined || value.submodulePath !== undefined) {
      if (!validRelativePath(value.parentRelativePath) || !validRelativePath(value.submodulePath, false) || (value.parentRelativePath === '.' ? value.submodulePath : `${value.parentRelativePath}/${value.submodulePath}`) !== value.relativePath) throw new Error('The submodule parent mapping does not match its relative path.');
      result.parentRelativePath = value.parentRelativePath; result.submodulePath = value.submodulePath;
    }
    return result;
  });
}

export function parseBitbucketRemote(remote: string): { workspace: string; repoSlug: string } | null {
  if (typeof remote !== 'string' || /[\u0000-\u0020\u007f]/.test(remote)) return null;
  let pathname: string;
  const scp = /^(?:[^/@:]+@)?bitbucket\.org:([^?#]+)$/i.exec(remote);
  if (scp) pathname = scp[1];
  else {
    let url: URL; try { url = new URL(remote); } catch { return null; }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname !== 'bitbucket.org' || url.search || url.hash || (url.port && !(url.protocol === 'ssh:' && url.port === '22'))) return null;
    pathname = url.pathname.replace(/^\//, '');
  }
  const match = /^([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?\/?$/i.exec(pathname);
  return match ? { workspace: match[1], repoSlug: match[2] } : null;
}

/** Reads configured remotes and initialized gitlinks; never fetches or changes Git state. */
export async function discoverRepositories(repoPath: string): Promise<RepositoryMapping[]> {
  if (typeof repoPath !== 'string' || !repoPath || repoPath.includes('\0')) throw new Error('Choose a valid repository path.');
  const git = async (cwd: string, args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout.trimEnd();
  const root = await realpath(await git(repoPath, ['rev-parse', '--show-toplevel']));
  const visited = new Set<string>();
  const results: RepositoryMapping[] = [];
  async function visit(location: string, relativePath: string, depth: number, parentRelativePath?: string, submodulePath?: string): Promise<void> {
    if (depth > 24) throw new Error('The repository has too many nested submodules.');
    let physical: string;
    try { physical = await realpath(location); } catch { return; }
    const relative = path.relative(root, physical);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('A submodule resolves outside this project.');
    if (visited.has(physical)) return;
    visited.add(physical);
    try { if (await realpath(await git(physical, ['rev-parse', '--show-toplevel'])) !== physical) return; } catch { return; }
    const configured = await git(physical, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '');
    const remotes = configured.split('\n').flatMap(line => { const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line); const remote = match && parseBitbucketRemote(match[2]); return remote ? [{ name: match![1], ...remote }] : []; });
    const selected = remotes.find(remote => remote.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : undefined);
    if (selected) results.push({ relativePath, workspace: selected.workspace, repoSlug: selected.repoSlug, ...(parentRelativePath !== undefined ? { parentRelativePath, submodulePath } : {}) });
    const index = await git(physical, ['ls-files', '--stage', '-z']);
    for (const entry of index.split('\0')) {
      const match = /^160000 [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
      if (!match || !validRelativePath(match[1], false)) continue;
      const child = match[1];
      await visit(path.join(physical, child), relativePath === '.' ? child : `${relativePath}/${child}`, depth + 1, relativePath, child);
    }
  }
  await visit(root, '.', 0);
  return validateRepositoryMappings(results);
}
