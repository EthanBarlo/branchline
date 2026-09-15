import { createHash } from 'node:crypto';
import type { BranchReviewRepository, PullRequest, RemoteSnapshotResult } from '../shared/integrations';
import type { FileStatus, RepoStatus, ReviewFile } from '../shared/types';
import { BitbucketClient, validCommitHash } from './bitbucket-client';
import { validRelativePath } from './repository-mapping';
import { mapConcurrent } from './concurrency';

const TEXT_LIMIT = 1024 * 1024;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : 'The remote comparison could not be read.';
const statuses: Record<string, FileStatus> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', typechanged: 'T', 'type-changed': 'T' };

interface Side { content: string | null; mode: string; identity: string; binary: boolean; tooLarge: boolean; pointer?: string; unavailable?: string }
const absent: Side = { content: null, mode: '000000', identity: '', binary: false, tooLarge: false };

async function readSide(client: BitbucketClient, pr: Pick<PullRequest, 'repository'>, revision: string, path: string | undefined): Promise<Side> {
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

function validateMembership(input: PullRequest[], repositories?: BranchReviewRepository[]): void {
  if (!Array.isArray(input) || !input.length && !repositories?.length || input.length > 200) throw new Error('Choose one or more pull requests to review.');
  if (new Set(input.map(pr => pr.repository.relativePath)).size !== input.length) throw new Error('Only one pull request per repository can be included in a review.');
  if (repositories && (!repositories.length || repositories.length > 200 || new Set(repositories.map(row => row.repository.relativePath)).size !== repositories.length || input.some(pr => !repositories.some(row => row.repository.relativePath === pr.repository.relativePath && row.prId === pr.id)))) throw new Error('The branch review repository membership is incomplete or duplicated.');
}

/** One captured repository can become reviewable without waiting for the rest of its group. */
export async function buildRemoteRepositorySnapshot(client: BitbucketClient, reviewId: string, row: BranchReviewRepository, pr?: PullRequest): Promise<RemoteSnapshotResult> {
  const input = pr ? [pr] : [];
  validateMembership(input, [row]);
  return buildRemoteSnapshotPart(client, reviewId, input, [row]);
}

/** Builds complete immutable file pairs with at most four repository pipelines. */
export async function buildRemoteSnapshot(client: BitbucketClient, reviewId: string, input: PullRequest[], repositories?: BranchReviewRepository[]): Promise<RemoteSnapshotResult> {
  validateMembership(input, repositories);
  const parts = repositories
    ? await mapConcurrent(repositories, 4, row => buildRemoteRepositorySnapshot(client, reviewId, row, input.find(pr => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId)))
    : await mapConcurrent(input, 4, pr => buildRemoteSnapshotPart(client, reviewId, [pr]));
  const files = parts.flatMap(part => part.snapshot.files).sort((a, b) => a.id.localeCompare(b.id));
  const repos = parts.flatMap(part => part.snapshot.repos);
  const warnings = parts.flatMap(part => part.snapshot.warnings);
  return { pullRequests: parts.flatMap(part => part.pullRequests), ...(repositories ? { repositories: parts.flatMap(part => part.repositories ?? []) } : {}),
    snapshot: { reviewId, files, repos, warnings, refreshedAt: new Date().toISOString(), fingerprint: digest([files.map(file => [file.id, file.fingerprint, file.unavailable]), repos, warnings]) } };
}

async function buildRemoteSnapshotPart(client: BitbucketClient, reviewId: string, input: PullRequest[], repositories?: BranchReviewRepository[]): Promise<RemoteSnapshotResult> {
  const files: ReviewFile[] = [];
  const repos: RepoStatus[] = [];
  const warnings: string[] = [];
  const pullRequests: PullRequest[] = [];
  const comparisons: BranchReviewRepository[] = repositories ? structuredClone(repositories) : input.map(pr => ({ repository: pr.repository, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, sourceHash: pr.sourceHash, targetHash: pr.targetHash, prId: pr.id, status: 'pull-request' }));
  // Called for one repository; outer discovery or snapshot workers bound group concurrency.
  for (const row of comparisons) {
    const initial = input.find(pr => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId);
    const relativePath = row.repository.relativePath;
    const status: RepoStatus = { relativePath, currentBranch: null, workingTreeIncluded: false, pointers: [] };
    repos.push(status);
    let pr = initial;
    try {
      if (row.status === 'unavailable') throw new Error(row.error || 'This repository could not be compared. Refresh to retry.');
      if (row.status === 'missing-branch') {
        const [source, target] = await Promise.all([client.getBranch(row.repository, row.sourceBranch), client.getBranch(row.repository, row.targetBranch)]);
        if (source) throw new Error('The source branch appeared while loading. Refresh to review its changes.');
        if (!target || row.targetHash && target.hash !== row.targetHash) throw new Error('The target branch is unavailable or changed while loading. Refresh to retry.');
        warnings.push(`${relativePath}: Source branch ${row.sourceBranch} does not exist in this repository.`);
        continue;
      }
      if (initial) {
        // Discovery just captured this PR. Reuse those immutable identities and check live
        // revisions once after downloading instead of fetching the same detail twice.
        const latest = repositories ? initial : await client.getPullRequest(initial.repository, initial.id);
        if (repositories && latest.state !== 'MERGED' && (latest.sourceHash !== row.sourceHash || latest.targetHash !== row.targetHash || latest.sourceBranch !== row.sourceBranch || latest.targetBranch !== row.targetBranch)) throw new Error('The pull request changed while loading. Refresh to review its latest revision.');
        pr = repositories ? { ...latest, sourceBranch: row.sourceBranch, targetBranch: row.targetBranch, sourceHash: row.sourceHash!, targetHash: row.targetHash! } : latest;
        row.sourceHash = pr.sourceHash; row.targetHash = pr.targetHash;
      } else if (row.prId !== undefined) throw new Error('The captured pull request is missing from this review.');
      if (!validCommitHash(row.sourceHash) || !validCommitHash(row.targetHash)) throw new Error('The captured branch revisions are incomplete. Refresh to retry.');
      const sourceHash = row.sourceHash, targetHash = row.targetHash;
      const root = client.repositoryPath(row.repository);
      const mergeBase = repositories && validCommitHash(row.mergeBaseHash) ? row.mergeBaseHash : await client.mergeBase(row.repository, sourceHash, targetHash);
      row.mergeBaseHash = mergeBase;
      if (pr) pr = { ...pr, mergeBaseHash: mergeBase };
      status.baseCommit = mergeBase; status.headCommit = sourceHash;
      const stats = await client.pages(`${root}/diffstat/${sourceHash}..${mergeBase}?topic=false&renames=true&pagelen=100`);
      const seen = new Set<string>();
      const reviewed = await mapConcurrent(stats, 4, async (stat): Promise<ReviewFile | null> => {
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
          oldContent: null, newContent: null, binary: false, fingerprint: digest([relativePath, oldPath, newPath, mergeBase, sourceHash]),
          baseCommit: mergeBase, headCommit: sourceHash, source: 'committed', remotePath: path };
        try {
          // Sequential sides bound file transfer concurrency to four per repository.
          const before = await readSide(client, row, mergeBase, oldPath);
          const after = await readSide(client, row, sourceHash, newPath);
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
      if (pr) {
        const after = await client.getPullRequest(pr.repository, pr.id);
        if (!(repositories && pr.state === 'MERGED' && after.state === 'MERGED') && (after.sourceHash !== sourceHash || after.targetHash !== targetHash || after.sourceBranch !== pr.sourceBranch || after.targetBranch !== pr.targetBranch)) throw new Error('The pull request changed while loading. Refresh to review its latest revision.');
        pr = { ...pr, state: after.state, draft: after.draft, participants: after.participants, mergeCommit: after.mergeCommit };
      }
      // Even repositories without changes participate in the final revision check.
      // Historical merged PRs remain readable after their source branch is deleted.
      if (repositories && pr?.state !== 'MERGED') {
        const [source, target] = await Promise.all([client.getBranch(row.repository, row.sourceBranch), client.getBranch(row.repository, row.targetBranch)]);
        if (!source || !target || source.hash !== sourceHash || target.hash !== targetHash) throw new Error('The branch changed or disappeared while loading. Refresh to review its latest revision.');
      }
      const completeFiles = reviewed.filter((file): file is ReviewFile => file !== null);
      if (completeFiles.some(file => file.unavailable)) {
        status.error = 'Some remote file versions could not be loaded. Review is incomplete.';
        warnings.push(`${relativePath}: ${status.error}`);
      }
      files.push(...completeFiles);
      row.status = pr ? 'pull-request' : stats.length || mergeBase !== sourceHash ? 'changes' : 'no-changes';
      if (status.error) row.error = status.error; else delete row.error;
    } catch (error) { status.error = message(error); status.pointers = []; row.status = 'unavailable'; row.error = status.error; warnings.push(`${relativePath}: ${status.error}`); }
    if (pr) pullRequests.push(pr);
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  return { pullRequests, ...(repositories ? { repositories: comparisons } : {}), snapshot: { reviewId, files, repos, warnings, refreshedAt: new Date().toISOString(), fingerprint: digest([files.map(file => [file.id, file.fingerprint, file.unavailable]), repos, warnings]) } };
}
