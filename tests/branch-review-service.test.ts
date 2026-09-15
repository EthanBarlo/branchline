import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { IntegrationService } from '../electron/integration-service';
import { IntegrationStore } from '../electron/integration-store';
import { ReviewStore } from '../electron/store';
import { ReviewService } from '../electron/review-service';
import { BranchReviewService } from '../electron/branch-review-service';
import { ProviderError, type ConnectionManager } from '../electron/connection-manager';
import type { BitbucketClient } from '../electron/bitbucket-client';
import type { PointerService } from '../electron/pointer-service';
import { branchReviewKey, pullRequestKey, type BranchReviewRepository, type InlinePayload, type PullRequest, type RemoteComment, type RepositoryMapping } from '../shared/integrations';
import type { Review, ReviewFile, ReviewSnapshot } from '../shared/types';

const hash = (value: string) => value.repeat(40);
const sourceBranch = 'feature/APP-123', targetBranch = 'main';
const root: RepositoryMapping = { relativePath: '.', workspace: 'team', repoSlug: 'root' };
const child: RepositoryMapping = { relativePath: 'child', workspace: 'team', repoSlug: 'child', parentRelativePath: '.', submodulePath: 'child' };
const empty: RepositoryMapping = { relativePath: 'empty', workspace: 'team', repoSlug: 'empty', parentRelativePath: '.', submodulePath: 'empty' };
const absent: RepositoryMapping = { relativePath: 'absent', workspace: 'team', repoSlug: 'absent', parentRelativePath: '.', submodulePath: 'absent' };
const pr = (repository = root, id = 7, sourceHash = hash('a')): PullRequest => ({ id, repository, title: 'APP-123 changes', url: `https://bitbucket.org/team/${repository.repoSlug}/pull-requests/${id}`,
  sourceBranch, targetBranch, sourceHash, targetHash: hash('b'), mergeBaseHash: hash('c'), author: { id: 'author', name: 'Author' }, reviewers: [], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'] });

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'branchline-whole-branch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'integrations.json');
  const reviews = new ReviewStore(join(directory, 'reviews.json')); await reviews.load();
  const project = await reviews.createProject({ repoPath: directory, name: 'Branch review' });
  const state = new IntegrationStore(file); await state.load();
  const refs = new Map<string, string>([['.:source', hash('a')], ['child:source', hash('d')], ['empty:source', hash('b')], ...[root, child, empty, absent].map(repo => [`${repo.relativePath}:target`, hash('b')] as [string, string])]);
  const prs = new Map<string, PullRequest>([[pullRequestKey(pr()), pr()]]);
  const comments = new Map<string, RemoteComment[]>();
  const calls = { creates: [] as string[], publishes: [] as { pr: PullRequest; payload: InlinePayload }[], merges: [] as string[], deletions: [] as string[], git: 0 };
  const hooks: { repositoryError?: string; afterCreate?: () => void; beforeCreate?: () => void; createError?: Error; beforeSnapshot?: () => void; deletionError?: string; afterMerge?: (path: string) => void } = {};
  const account = { id: 'bb', kind: 'bitbucket' as const, label: 'Reviewer', email: 'reviewer@example.invalid', displayName: 'Reviewer', accountId: 'reviewer', connected: true, storage: 'session' as const };
  const connections = { list: () => [account], credentials: () => ({ info: account, email: account.email, token: 'test-only' }) } as unknown as ConnectionManager;
  const client = {
    getRepository: async (repo: RepositoryMapping) => { if (hooks.repositoryError === repo.relativePath) throw new ProviderError('Repository access denied', 403); return { defaultBranch: 'main' }; },
    getBranch: async (repo: RepositoryMapping, name: string) => { const value = refs.get(`${repo.relativePath}:${name === sourceBranch ? 'source' : 'target'}`); return value ? { name, hash: value } : null; },
    mergeBase: async (repo: RepositoryMapping, source: string, target: string) => source === target || target === hash('9') && [...prs.values()].some(pr => pr.repository.relativePath === repo.relativePath && pr.state === 'MERGED' && pr.sourceHash === source) ? source : hash('c'),
    getPullRequest: async (repo: RepositoryMapping, id: number) => { const value = prs.get(`${repo.relativePath}#${id}`); if (!value) throw new Error('PR not found'); return structuredClone(value); },
    findPullRequests: async (repo: RepositoryMapping, source: string, states = ['OPEN']) => [...prs.values()].filter(value => value.repository.relativePath === repo.relativePath && value.sourceBranch === source && states.includes(value.state)).map(value => structuredClone(value)),
    createPullRequest: async (repo: RepositoryMapping) => {
      hooks.beforeCreate?.(); if (hooks.createError) throw hooks.createError;
      calls.creates.push(repo.relativePath);
      const created = { ...pr(repo, 20 + calls.creates.length, refs.get(`${repo.relativePath}:source`)!), targetHash: refs.get(`${repo.relativePath}:target`)!, author: { id: account.accountId, name: account.displayName } };
      prs.set(pullRequestKey(created), created); hooks.afterCreate?.(); return structuredClone(created);
    },
    listComments: async (value: PullRequest) => structuredClone(comments.get(pullRequestKey(value)) ?? []),
    createComment: async (value: PullRequest, payload: InlinePayload) => {
      calls.publishes.push({ pr: structuredClone(value), payload: structuredClone(payload) });
      const entry: RemoteComment = { id: calls.publishes.length, authorId: 'reviewer', body: payload.content.raw, resolved: false, deleted: false,
        path: payload.inline.path, from: payload.inline.from, to: payload.inline.to, startFrom: payload.inline.start_from, startTo: payload.inline.start_to };
      const saved = comments.get(pullRequestKey(value)) ?? []; saved.push(entry); comments.set(pullRequestKey(value), saved); return entry;
    },
    approve: async (value: PullRequest) => { prs.get(pullRequestKey(value))!.participants = [{ id: account.accountId, approved: true }]; },
    merge: async (value: PullRequest) => {
      calls.merges.push(value.repository.relativePath);
      const latest = prs.get(pullRequestKey(value))!; latest.state = 'MERGED'; latest.mergeCommit = hash('9');
      refs.set(`${value.repository.relativePath}:target`, hash('9')); refs.delete(`${value.repository.relativePath}:source`);
      hooks.afterMerge?.(value.repository.relativePath);
      return { pr: structuredClone(latest) };
    },
    branchExists: async (value: PullRequest) => refs.has(`${value.repository.relativePath}:source`),
  } as unknown as BitbucketClient;
  const pointers = { deleteBranch: async (input: { repository: RepositoryMapping; expectedHead: string }) => {
    if (hooks.deletionError === input.repository.relativePath) throw new Error('Permission denied deleting branch');
    assert.equal(refs.get(`${input.repository.relativePath}:source`), input.expectedHead); calls.deletions.push(input.repository.relativePath); refs.delete(`${input.repository.relativePath}:source`);
  } } as unknown as PointerService;
  let service: IntegrationService;
  const reviewService = new ReviewService(reviews, async () => { calls.git++; throw new Error('Local Git must not run.'); }, config => service.buildSnapshot(config as Review));
  service = new IntegrationService(reviews, reviewService, state, connections, pointers, {
    client: () => client,
    snapshot: async (_client, id, pullRequests, repositories) => {
      hooks.beforeSnapshot?.();
      const files: ReviewFile[] = (repositories ?? []).filter(row => row.status === 'changes' || row.status === 'pull-request').map(row => ({
        id: `${row.repository.relativePath}/new.ts`, repoRelativePath: row.repository.relativePath, path: 'new.ts', oldPath: 'old.ts', remotePath: 'new.ts',
        status: 'R', additions: 2, deletions: 2, oldContent: 'old\nlines\n', newContent: 'new\nlines\n', binary: false, source: 'committed',
        fingerprint: `${row.repository.relativePath}:${row.sourceHash}`, baseCommit: row.mergeBaseHash!, headCommit: row.sourceHash!,
      }));
      const snapshot: ReviewSnapshot = { reviewId: id, files, repos: repositories!.map(row => ({ relativePath: row.repository.relativePath, currentBranch: null, workingTreeIncluded: false, ...(row.error ? { error: row.error } : {}) })), warnings: [], fingerprint: JSON.stringify(files.map(file => file.fingerprint)), refreshedAt: new Date().toISOString() };
      return { snapshot, pullRequests, repositories };
    },
  });
  await service.configureProjectIntegration(project.id, { bitbucketConnectionId: 'bb', repositories: [root, child, empty, absent], updateSubmodulePointers: false });
  const review = await service.openPullRequestReview(project.id, [{ repositoryPath: '.', prId: 7 }]);
  await service.refreshReview(review.id);
  const add = async (repositoryPath = 'child', side: 'additions' | 'deletions' = 'additions') => {
    const row = state.review(review.id)!.repositories!.find(row => row.repository.relativePath === repositoryPath)!;
    const result = await service.addComment(review.id, { fileId: `${repositoryPath}/new.ts`, repoRelativePath: repositoryPath, path: 'new.ts', side, lineStart: 1, lineEnd: 2,
      body: `Check ${repositoryPath} ${side}`, context: '', fingerprint: `${repositoryPath}:${row.sourceHash}` }); return result.comments.at(-1)!;
  };
  return { directory, file, state, reviews, review, project, service, refs, prs, comments, calls, hooks, add, client };
}

test('one starter PR includes every repository; drafts create no PR and publication reuses one exact inline destination', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.state.review(f.review.id)!.repositories!.map(row => row.status), ['pull-request', 'changes', 'no-changes', 'missing-branch']);
  const first = await f.add(); await f.add('child', 'deletions');
  assert.equal(f.state.review(f.review.id)!.publications[first.id].anchor.prKey, branchReviewKey('child'));
  assert.deepEqual(f.calls.creates, []);
  const preview = await f.service.previewFeedback(f.review.id);
  assert.ok(preview.items.every(item => item.createsPullRequest && item.prId === 0));
  await Promise.all([f.service.publishFeedback(f.review.id), f.service.publishFeedback(f.review.id)]);
  assert.deepEqual(f.calls.creates, ['child']);
  assert.deepEqual(f.calls.publishes.map(item => item.payload.inline), [{ path: 'new.ts', to: 2, start_to: 1 }, { path: 'new.ts', from: 2, start_from: 1 }]);
  assert.ok(f.calls.publishes.every(item => item.pr.repository.relativePath === 'child' && item.pr.id === 21));
  assert.equal(f.state.review(f.review.id)!.publications[first.id].anchor.prKey, 'child#21');
  assert.equal(f.calls.git, 0);
  const reopened = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: 'child', prId: 21 }]);
  assert.equal(reopened.id, f.review.id);
});

test('approve and merge creates unrequested child PRs, merges children first and deletes empty remote branches', async t => {
  const f = await fixture(t);
  const preview = await f.service.previewMerge(f.review.id);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.repositories?.length, 4);
  const result = await f.service.runPullRequestAction(f.review.id, 'merge');
  assert.equal(result.operation?.state, 'complete', result.operation?.error);
  assert.deepEqual(f.calls.creates, ['child']);
  assert.deepEqual(f.calls.merges, ['child', '.']);
  assert.deepEqual(f.calls.deletions, ['empty']);
  assert.equal(result.repositories?.find(row => row.repository.relativePath === 'empty')?.cleanup?.state, 'deleted');
  assert.equal(f.calls.git, 0);
});

test('nested no-PR repositories are all created and merged deepest first', async t => {
  const f = await fixture(t);
  const nested: RepositoryMapping = { relativePath: 'child/nested', workspace: 'team', repoSlug: 'nested', parentRelativePath: 'child', submodulePath: 'nested' };
  const settings = f.service.getIntegrations().projects[f.project.id];
  f.refs.set('child/nested:source', hash('f')); f.refs.set('child/nested:target', hash('b'));
  await f.service.configureProjectIntegration(f.project.id, { ...settings, repositories: [...settings.repositories, nested] });
  assert.ok((await f.service.previewMerge(f.review.id)).blockers.some(message => /mappings changed/.test(message)));
  await f.service.refreshReview(f.review.id);
  const result = await f.service.runPullRequestAction(f.review.id, 'merge');
  assert.equal(result.operation?.state, 'complete', result.operation?.error);
  assert.deepEqual(f.calls.creates, ['child', 'child/nested']);
  assert.deepEqual(f.calls.merges, ['child/nested', 'child', '.']);
});

test('partial cleanup resumes without repeating merged PRs or already deleted empty branches', async t => {
  const f = await fixture(t);
  const last: RepositoryMapping = { relativePath: 'zempty', workspace: 'team', repoSlug: 'zempty', parentRelativePath: '.', submodulePath: 'zempty' };
  const settings = f.service.getIntegrations().projects[f.project.id];
  f.refs.set('zempty:source', hash('b')); f.refs.set('zempty:target', hash('b'));
  await f.service.configureProjectIntegration(f.project.id, { ...settings, repositories: [...settings.repositories, last] });
  await f.service.refreshReview(f.review.id);
  f.hooks.deletionError = 'zempty';
  const paused = await f.service.runPullRequestAction(f.review.id, 'merge');
  assert.equal(paused.operation?.state, 'paused');
  assert.equal(paused.repositories!.find(row => row.repository.relativePath === 'empty')!.cleanup?.state, 'deleted');
  f.hooks.deletionError = undefined;
  const complete = await f.service.runPullRequestAction(f.review.id, 'merge');
  assert.equal(complete.operation?.state, 'complete', complete.operation?.error);
  assert.deepEqual(f.calls.deletions, ['empty', 'zempty']);
  assert.deepEqual(f.calls.merges, ['child', '.']);
  f.refs.set('empty:source', hash('e'));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /recreated/);
  assert.equal(f.refs.get('empty:source'), hash('e'));
});

test('new source commits after a parallel merge pause completion and preserve already completed merges', async t => {
  const f = await fixture(t);
  f.hooks.afterMerge = path => { if (path === 'child') f.refs.set('child:source', hash('e')); };
  const paused = await f.service.runPullRequestAction(f.review.id, 'merge');
  assert.equal(paused.operation?.state, 'paused');
  assert.match(paused.operation?.error ?? '', /source branch changed after/);
  assert.deepEqual(new Set(f.calls.merges), new Set(['child', '.']), 'already started independent merges finish and remain recorded');
  assert.equal(f.refs.get('child:source'), hash('e'));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /source branch changed after/);
  assert.equal(f.calls.merges.length, 2, 'resuming does not repeat a completed merge');
  f.prs.set('child#99', { ...pr(child, 99, hash('e')), targetHash: hash('9') });
  const fresh = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: 'child', prId: 99 }]);
  assert.notEqual(fresh.id, f.review.id);
  const snapshot = await f.service.refreshReview(fresh.id);
  assert.ok(snapshot.snapshot.files.some(file => file.repoRelativePath === 'child' && file.headCommit === hash('e')));
  assert.equal(f.state.review(fresh.id)!.repositories![1].status, 'pull-request');
  assert.equal(f.state.review(f.review.id)!.operation?.items.find(item => item.prKey === 'child#21')?.merge, 'merged');
});

test('new work in previously empty or absent repositories blocks all publication until reviewed', async t => {
  for (const path of ['empty', 'absent']) {
    const f = await fixture(t); await f.add();
    f.refs.set(`${path}:source`, hash('e'));
    await assert.rejects(f.service.publishFeedback(f.review.id), /branch changed/);
    assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.publishes, []);
    const refreshed = await f.service.refreshReview(f.review.id);
    assert.ok(refreshed.snapshot.files.some(file => file.repoRelativePath === path));
    assert.equal(f.reviews.getReview(f.review.id).comments.length, 1);
  }
});

test('a no-PR draft retains its original revisions after refresh and needs explicit re-anchoring', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.refs.set('child:source', hash('e'));
  await f.service.refreshReview(f.review.id);
  await assert.rejects(f.service.publishFeedback(f.review.id), /Move this draft/);
  assert.deepEqual(f.calls.creates, []);
  await f.service.reanchorComment(f.review.id, comment.id, { fileId: 'child/new.ts', fingerprint: `child:${hash('e')}`, side: 'additions', lineStart: 2, lineEnd: 2 });
  await f.service.publishFeedback(f.review.id);
  assert.deepEqual(f.calls.publishes[0].payload.inline, { path: 'new.ts', to: 2 });
});

test('accepted PR creation followed by timeout or restart reconciles without creating a duplicate', async t => {
  const f = await fixture(t); await f.add();
  f.hooks.afterCreate = () => { throw new Error('Connection timed out after acceptance'); };
  await assert.rejects(f.service.publishFeedback(f.review.id), /timed out/);
  assert.equal(f.state.review(f.review.id)!.repositories![1].creation?.state, 'unknown');
  const restored = new IntegrationStore(f.file); await restored.load();
  assert.equal(restored.review(f.review.id)!.repositories![1].creation?.state, 'unknown');
  f.hooks.afterCreate = undefined;
  await f.service.refreshReview(f.review.id); await f.service.publishFeedback(f.review.id);
  assert.deepEqual(f.calls.creates, ['child']); assert.equal(f.calls.publishes.length, 1);
});

test('unknown creation with no visible result never blindly posts again', async t => {
  const f = await fixture(t); await f.add();
  f.hooks.createError = new Error('Connection timed out');
  await assert.rejects(f.service.publishFeedback(f.review.id), /timed out/);
  f.hooks.createError = undefined;
  await f.service.refreshReview(f.review.id);
  await assert.rejects(f.service.publishFeedback(f.review.id), /unconfirmed/);
  assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.publishes, []);
});

test('uncertain PR creation remains a merge blocker after its source branch disappears', async t => {
  const f = await fixture(t); await f.add();
  f.hooks.afterCreate = () => { throw new Error('Connection timed out after acceptance'); };
  await assert.rejects(f.service.publishFeedback(f.review.id), /timed out/);
  const childPr = f.prs.get('child#21')!; childPr.state = 'MERGED'; childPr.mergeCommit = hash('9');
  f.refs.delete('child:source'); f.refs.set('child:target', hash('9'));
  await f.service.refreshReview(f.review.id);
  const preview = await f.service.previewMerge(f.review.id);
  assert.ok(preview.blockers.some(message => /creation is still unconfirmed/.test(message)));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /creation is still unconfirmed/);
  assert.deepEqual(f.calls.merges, []);
});

test('known creation rejection can retry, while concurrent source pushes preserve drafts and stop publication', async t => {
  const f = await fixture(t); await f.add();
  f.hooks.createError = new ProviderError('Missing write scope', 403);
  await assert.rejects(f.service.publishFeedback(f.review.id), /write scope/);
  assert.equal(f.state.review(f.review.id)!.repositories![1].creation?.state, 'failed');
  f.hooks.createError = undefined;
  f.hooks.beforeCreate = () => { f.refs.set('child:source', hash('e')); };
  await assert.rejects(f.service.publishFeedback(f.review.id), /branch changed/);
  assert.equal(f.calls.creates.length, 1); assert.equal(f.calls.publishes.length, 0);
  assert.equal(f.reviews.getReview(f.review.id).comments.length, 1);
});

test('missing targets, inaccessible repositories and conflicting PR targets remain visible and block merge', async t => {
  for (const kind of ['target', 'permission', 'conflict']) {
    const f = await fixture(t);
    if (kind === 'target') f.refs.delete('child:target');
    if (kind === 'permission') f.hooks.repositoryError = 'child';
    if (kind === 'conflict') f.prs.set('child#99', { ...pr(child, 99, hash('d')), targetBranch: 'release' });
    await f.service.refreshReview(f.review.id);
    assert.equal(f.state.review(f.review.id)!.repositories![1].status, 'unavailable');
    assert.ok((await f.service.previewMerge(f.review.id)).blockers.length);
    await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'));
    assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.merges, []);
  }
});

test('repository additions and remapping cannot silently change a saved review scope', async t => {
  const f = await fixture(t);
  const settings = f.service.getIntegrations().projects[f.project.id];
  await f.service.configureProjectIntegration(f.project.id, { ...settings, repositories: [root, { ...child, repoSlug: 'replacement' }, empty, absent] });
  await f.service.refreshReview(f.review.id);
  const row = f.state.review(f.review.id)!.repositories![1];
  assert.equal(row.repository.repoSlug, 'child'); assert.equal(row.status, 'unavailable');
  assert.ok((await f.service.previewMerge(f.review.id)).blockers.some(value => /mapping/.test(value)));
  const fresh = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }]);
  assert.notEqual(fresh.id, f.review.id, 'Opening the corrected mapping starts a fresh review and preserves old feedback.');
});

test('branch metadata survives restart; interrupted writes become unknown and invalid anchors are rejected', async t => {
  const f = await fixture(t); const comment = await f.add();
  await f.state.updateReview(f.review.id, binding => {
    binding.repositories![1].creation = { state: 'sending', sourceHash: hash('d'), targetHash: hash('b'), startedAt: new Date().toISOString(), marker: 'a'.repeat(24) };
    binding.repositories![2].cleanup = { state: 'sending', expectedHead: hash('b') };
  });
  const restored = new IntegrationStore(f.file); await restored.load();
  assert.equal(restored.review(f.review.id)!.repositories![1].creation?.state, 'unknown');
  assert.equal(restored.review(f.review.id)!.repositories![2].cleanup?.state, 'unknown');
  assert.equal(restored.review(f.review.id)!.publications[comment.id].anchor.prKey, branchReviewKey('child'));
  const raw = JSON.parse(await readFile(f.file, 'utf8'));
  raw.reviews[f.review.id].publications[comment.id].remoteId = 200;
  await writeFile(f.file, JSON.stringify(raw));
  await assert.rejects(new IntegrationStore(f.file).load(), /invalid/);
});

test('discovery streams independent repositories while a slow pipeline waits, with bounded workers and stable membership', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const extras = Array.from({ length: 3 }, (_, index): RepositoryMapping => ({ relativePath: `extra${index}`, workspace: 'team', repoSlug: `extra${index}` }));
  const mappings = [root, child, empty, absent, ...extras];
  await f.state.setProject(f.project.id, { ...f.state.project(f.project.id), repositories: mappings });
  for (const repository of extras) f.refs.set(`${repository.relativePath}:target`, hash('b'));
  const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => undefined);
  const rootStarted = deferred(), rootRelease = deferred(), fourPipelines = deferred(), pipelineRelease = deferred();
  const getRepository = f.client.getRepository.bind(f.client);
  f.client.getRepository = async repository => {
    if (repository.relativePath === '.') { rootStarted.resolve(); await rootRelease.promise; }
    return getRepository(repository);
  };
  const checked: string[] = [], ready: string[] = [];
  let started = false;
  const task = service.discover(f.review.id, {
    onStart: async repositories => { assert.deepEqual(repositories, mappings); started = true; },
    onChecking: async repository => { assert.ok(started); checked.push(repository.relativePath); },
    onRepository: async row => {
      ready.push(row.repository.relativePath);
      if (ready.length === 4) fourPipelines.resolve();
      await pipelineRelease.promise;
    },
  });
  try {
    await rootStarted.promise;
    // A repository held at discovery must not hold up content callbacks for its siblings.
    while (ready.length < 3) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(new Set(ready), new Set(['child', 'empty', 'absent']));
    assert.equal(checked.length, 4, 'completed callbacks remain part of the bounded pipeline');
    rootRelease.resolve(); await fourPipelines.promise;
    assert.equal(checked.length, 4, 'a fifth repository waits for a content pipeline to finish');
  } finally { rootRelease.resolve(); pipelineRelease.resolve(); }
  const result = await task;
  assert.deepEqual(result.repositories.map(row => row.repository.relativePath), mappings.map(row => row.relativePath));
  assert.equal(ready.length, 7); assert.equal(result.pullRequests.length, 1);
});

test('parallel preflight publishes per-repository progress, reports failures and only rechecks a selected subset', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const snapshot: ReviewSnapshot = { reviewId: f.review.id, files: [], repos: [root, child, empty, absent].map(repository => ({ relativePath: repository.relativePath, currentBranch: null, workingTreeIncluded: false })), warnings: [], refreshedAt: new Date().toISOString(), fingerprint: 'captured' };
  const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => snapshot);
  const fourStarted = deferred(), release = deferred();
  const reads: string[] = [];
  const getRepository = f.client.getRepository.bind(f.client);
  f.client.getRepository = async repository => { reads.push(repository.relativePath); if (reads.length === 4) fourStarted.resolve(); await release.promise; return getRepository(repository); };
  f.hooks.repositoryError = 'child';
  const task = service.preflight(f.review.id);
  try {
    await fourStarted.promise;
    assert.deepEqual(f.state.review(f.review.id)!.repositories!.map(row => row.check?.state), ['checking', 'checking', 'checking', 'checking']);
  } finally { release.resolve(); }
  const blockers = await task;
  assert.equal(blockers.length, 1); assert.match(blockers[0], /child: Repository access denied/);
  assert.deepEqual(f.state.review(f.review.id)!.repositories!.map(row => row.check?.state), ['ready', 'failed', 'ready', 'ready']);
  reads.length = 0;
  assert.deepEqual(await service.preflight(f.review.id, { repositoryPaths: ['empty'] }), []);
  assert.deepEqual(reads, ['empty']);
  snapshot.loading = true;
  assert.match((await service.preflight(f.review.id, { repositoryPaths: ['empty'] }))[0], /finish loading/);
  assert.deepEqual(reads, ['empty'], 'partial review actions fail without additional network requests');
});

test('concurrent PR creation stops scheduling after failure and drains durable successes before returning', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const extras = Array.from({ length: 5 }, (_, index): RepositoryMapping => ({ relativePath: `extra${index}`, workspace: 'team', repoSlug: `extra${index}` }));
  for (const repository of extras) { f.refs.set(`${repository.relativePath}:source`, hash('d')); f.refs.set(`${repository.relativePath}:target`, hash('b')); }
  await f.state.setProject(f.project.id, { ...f.state.project(f.project.id), repositories: [root, child, empty, absent, ...extras] });
  await f.service.refreshReview(f.review.id);
  const snapshot: ReviewSnapshot = { reviewId: f.review.id, files: [], repos: f.state.review(f.review.id)!.repositories!.map(row => ({ relativePath: row.repository.relativePath, currentBranch: null, workingTreeIncluded: false })), warnings: [], refreshedAt: new Date().toISOString(), fingerprint: 'captured' };
  const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => snapshot);
  const allStarted = deferred(), releaseFailure = deferred(), failed = deferred(), releaseSuccess = deferred();
  const started: string[] = [];
  const create = f.client.createPullRequest.bind(f.client);
  f.client.createPullRequest = async (repository, input) => {
    started.push(repository.relativePath); if (started.length === 4) allStarted.resolve();
    if (repository.relativePath === 'child') { await releaseFailure.promise; throw new Error('Creation delivery uncertain'); }
    await releaseSuccess.promise;
    return create(repository, input);
  };
  const unsubscribe = f.state.onReviewChanged(event => { if (event.state.repositories!.find(row => row.repository.relativePath === 'child')!.creation?.state === 'unknown') failed.resolve(); });
  let settled = false;
  const task = service.ensurePullRequests(f.review.id, ['child', ...extras.map(row => row.relativePath)]).then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
  try {
    await allStarted.promise; releaseFailure.resolve(); await failed.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the operation waits for accepted sibling writes to finish');
    assert.equal(started.length, 4, 'repositories beyond the worker limit were not posted after failure');
  } finally { releaseFailure.resolve(); releaseSuccess.resolve(); unsubscribe(); }
  assert.match((await task as Error).message, /Creation delivery uncertain/);
  assert.equal(started.length, 4);
  assert.equal(f.state.review(f.review.id)!.repositories!.filter(row => row.prId && row.repository.relativePath !== '.').length, 3);
  const restored = new IntegrationStore(f.file); await restored.load();
  assert.equal(restored.review(f.review.id)!.repositories!.filter(row => row.prId && row.repository.relativePath !== '.').length, 3, 'successful creations survive restart');
});
