import { createHash } from 'node:crypto';
import type { PullRequest, RemoteSnapshotResult } from '../shared/integrations';
import type { FileStatus, RepoStatus, ReviewFile } from '../shared/types';
import { BitbucketClient, validCommitHash } from './bitbucket-client';
import { validRelativePath } from './repository-mapping';

const TEXT_LIMIT = 1024 * 1024;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : 'The remote comparison could not be read.';
const statuses: Record<string, FileStatus> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', typechanged: 'T', 'type-changed': 'T' };

async function mapLimit<T, R>(values: T[], limit: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await action(values[index]); }
  }));
  const failure = workers.find(worker => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return result;
}
interface Side { content: string | null; mode: string; identity: string; binary: boolean; tooLarge: boolean; pointer?: string; unavailable?: string }
const absent: Side = { content: null, mode: '000000', identity: '', binary: false, tooLarge: false };

async function readSide(client: BitbucketClient, pr: PullRequest, revision: string, path: string | undefined): Promise<Side> {
  if (path === undefined) return { ...absent };
  if (!validRelativePath(path, false)) throw new Error('Bitbucket returned an unsafe file path.');
  const url = `${client.repositoryPath(pr.repository)}/src/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const meta = await client.fileMetadata(`${url}?format=meta`);
  if (!meta || meta.type !== 'commit_file' || meta.path !== path || !Array.isArray(meta.attributes)) throw new Error(`Bitbucket returned incomplete metadata for ${path}.`);
  const attributes = meta.attributes as string[];
  const pointer = attributes.includes('subrepository');
  const mode = pointer ? '160000' : attributes.includes('link') ? '120000' : attributes.includes('executable') ? '100755' : '100644';
  const raw = await client.raw(url, TEXT_LIMIT);
  const side: Side = {
    content: null, mode, identity: raw.etag ?? (raw.bytes ? createHash('sha256').update(raw.bytes).digest('hex') : `${revision}:${path}`),
    binary: attributes.includes('binary'), tooLarge: raw.tooLarge || typeof meta.size === 'number' && meta.size > TEXT_LIMIT,
  };
  if (raw.redirected) { side.unavailable = 'This file uses external or LFS storage and cannot be previewed here.'; return side; }
  if (pointer) {
    const hash = raw.bytes?.toString('utf8').trim();
    if (!validCommitHash(hash)) throw new Error(`The submodule pointer at ${path} could not be read.`);
    side.pointer = hash; side.identity = hash; return side;
  }
  if (!raw.bytes || side.tooLarge) return side;
  if (Number.isSafeInteger(meta.size) && meta.size >= 0 && raw.bytes.length !== meta.size) throw new Error(`The file content for ${path} is incomplete.`);
  if (raw.bytes.subarray(0, 8000).includes(0)) side.binary = true;
  if (!side.binary) {
    try { side.content = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes); } catch { side.binary = true; }
  }
  return side;
}

/** Builds complete file pairs at immutable server revisions; local Git refs are never used. */
export async function buildRemoteSnapshot(client: BitbucketClient, reviewId: string, input: PullRequest[]): Promise<RemoteSnapshotResult> {
  if (!Array.isArray(input) || !input.length || input.length > 200) throw new Error('Choose one or more pull requests to review.');
  if (new Set(input.map(pr => pr.repository.relativePath)).size !== input.length) throw new Error('Only one pull request per repository can be included in a review.');
  const files: ReviewFile[] = [];
  const repos: RepoStatus[] = [];
  const warnings: string[] = [];
  const pullRequests: PullRequest[] = [];
  // One repository at a time keeps total network concurrency bounded across the group.
  for (const initial of input) {
    const relativePath = initial.repository.relativePath;
    const status: RepoStatus = { relativePath, currentBranch: null, workingTreeIncluded: false, pointers: [] };
    repos.push(status);
    let pr = initial;
    try {
      pr = await client.getPullRequest(initial.repository, initial.id);
      const root = client.repositoryPath(pr.repository);
      const base = await client.json(`${root}/merge-base/${pr.sourceHash}..${pr.targetHash}`);
      if (!validCommitHash(base?.hash)) throw new Error('Bitbucket did not return a valid common ancestor.');
      const mergeBase: string = base.hash;
      pr = { ...pr, mergeBaseHash: mergeBase };
      status.baseCommit = mergeBase; status.headCommit = pr.sourceHash;
      const stats = await client.pages(`${root}/diffstat/${pr.sourceHash}..${mergeBase}?topic=false&renames=true&pagelen=100`);
      const seen = new Set<string>();
      const reviewed = await mapLimit(stats, 4, async (stat): Promise<ReviewFile | null> => {
        const state = statuses[stat?.status];
        const oldPath = stat?.old?.path as string | undefined;
        const newPath = stat?.new?.path as string | undefined;
        const path = newPath ?? oldPath;
        if (!state || !validRelativePath(path, false) || oldPath !== undefined && !validRelativePath(oldPath, false) || newPath !== undefined && !validRelativePath(newPath, false)) throw new Error('Bitbucket returned an unsupported or incomplete file change.');
        if (state === 'A' ? oldPath !== undefined || newPath === undefined : state === 'D' ? oldPath === undefined || newPath !== undefined : oldPath === undefined || newPath === undefined) throw new Error('Bitbucket omitted a required file version from this change. Review is incomplete.');
        if (seen.has(path)) throw new Error('Bitbucket returned a duplicate file change.');
        seen.add(path);
        const id = relativePath === '.' ? path : `${relativePath}/${path}`;
        const initialFile: ReviewFile = { id, repoRelativePath: relativePath, path, ...(oldPath && oldPath !== path ? { oldPath } : {}), status: state,
          additions: Number.isSafeInteger(stat.lines_added) && stat.lines_added >= 0 ? stat.lines_added : 0,
          deletions: Number.isSafeInteger(stat.lines_removed) && stat.lines_removed >= 0 ? stat.lines_removed : 0,
          oldContent: null, newContent: null, binary: false, fingerprint: digest([relativePath, oldPath, newPath, mergeBase, pr.sourceHash]),
          baseCommit: mergeBase, headCommit: pr.sourceHash, source: 'committed', remotePath: path };
        try {
          // Sequential sides bound file transfer concurrency to four, including metadata requests.
          const before = await readSide(client, pr, mergeBase, oldPath);
          const after = await readSide(client, pr, pr.sourceHash, newPath);
          if (before.pointer || after.pointer) {
            status.pointers!.push({ path, oldHash: before.pointer ?? null, newHash: after.pointer ?? null });
            if ((before.mode === '160000' || before.mode === '000000') && (after.mode === '160000' || after.mode === '000000')) return null;
            throw new Error('This path changes between a submodule and a regular file. Review that structural change in Bitbucket.');
          }
          const unavailable = before.unavailable ?? after.unavailable;
          return { ...initialFile, oldContent: before.content, newContent: after.content, oldMode: before.mode, newMode: after.mode,
            binary: before.binary || after.binary, tooLarge: before.tooLarge || after.tooLarge,
            fingerprint: digest([relativePath, oldPath ?? path, path, before.mode, before.identity, after.mode, after.identity]), ...(unavailable ? { unavailable } : {}) };
        } catch (error) { return { ...initialFile, unavailable: message(error) }; }
      });
      const after = await client.getPullRequest(pr.repository, pr.id);
      if (after.sourceHash !== pr.sourceHash || after.targetHash !== pr.targetHash || after.sourceBranch !== pr.sourceBranch || after.targetBranch !== pr.targetBranch) throw new Error('The pull request changed while loading. Refresh to review its latest revision.');
      const completeFiles = reviewed.filter((file): file is ReviewFile => file !== null);
      if (completeFiles.some(file => file.unavailable)) {
        status.error = 'Some remote file versions could not be loaded. Review is incomplete.';
        warnings.push(`${relativePath}: ${status.error}`);
      }
      files.push(...completeFiles);
      pr = { ...pr, state: after.state, draft: after.draft, participants: after.participants, mergeCommit: after.mergeCommit };
    } catch (error) { status.error = message(error); status.pointers = []; warnings.push(`${relativePath}: ${status.error}`); }
    pullRequests.push(pr);
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  return { pullRequests, snapshot: { reviewId, files, repos, warnings, refreshedAt: new Date().toISOString(), fingerprint: digest([files.map(file => [file.id, file.fingerprint, file.unavailable]), repos, warnings]) } };
}
