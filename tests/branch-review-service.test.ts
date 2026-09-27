import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { IntegrationService, type IntegrationDependencies } from '../electron/integrations/integration-service';
import { IntegrationStore } from '../electron/integrations/integration-store';
import { ReviewStore } from '../electron/reviews/review-store';
import { ReviewService } from '../electron/reviews/review-service';
import { BranchReviewService } from '../electron/integrations/bitbucket/branch-review-service';
import { ProviderError, type ConnectionManager } from '../electron/integrations/connection-manager';
import type { BitbucketClient } from '../electron/integrations/bitbucket/bitbucket-client';
import type { PointerService } from '../electron/git/pointer-service';
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
    getMergeConflicts: async () => [],
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
      refs.set(`${value.repository.relativePath}:target`, hash('9'));
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
  const dependencies: IntegrationDependencies = {
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
  };
  service = new IntegrationService(reviews, reviewService, state, connections, pointers, dependencies);
  await service.configureProjectIntegration(project.id, { bitbucketConnectionId: 'bb', repositories: [root, child, empty, absent], updateSubmodulePointers: false });
  const review = await service.openPullRequestReview(project.id, [{ repositoryPath: '.', prId: 7 }]);
  await service.refreshReview(review.id);
  const add = async (repositoryPath = 'child', side: 'additions' | 'deletions' = 'additions') => {
    const row = state.review(review.id)!.repositories!.find(row => row.repository.relativePath === repositoryPath)!;
    const result = await service.addComment(review.id, { fileId: `${repositoryPath}/new.ts`, repoRelativePath: repositoryPath, path: 'new.ts', side, lineStart: 1, lineEnd: 2,
      body: `Check ${repositoryPath} ${side}`, context: '', fingerprint: `${repositoryPath}:${row.sourceHash}` }); return result.comments.at(-1)!;
  };
  const restart = async () => {
    const restoredReviews = new ReviewStore(join(directory, 'reviews.json')); await restoredReviews.load();
    const restoredState = new IntegrationStore(file); await restoredState.load();
    let restoredService: IntegrationService;
    const restoredReviewService = new ReviewService(restoredReviews, async () => { calls.git++; throw new Error('Local Git must not run.'); }, config => restoredService.buildSnapshot(config as Review));
    restoredService = new IntegrationService(restoredReviews, restoredReviewService, restoredState, connections, pointers, dependencies);
    return { service: restoredService, state: restoredState, reviews: restoredReviews };
  };
  return { directory, file, state, reviews, review, project, service, refs, prs, comments, calls, hooks, add, client, restart };
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

test('refreshing or reopening an open PR replaces its captured target and merge base with remote revisions', async t => {
  for (const reopen of [false, true]) {
    const f = await fixture(t);
    const captured = f.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === '.')!;
    assert.equal(captured.targetHash, hash('b'));
    assert.equal(captured.mergeBaseHash, hash('c'));
    f.refs.set('.:target', hash('e'));
    f.prs.get('.#7')!.targetHash = hash('e');
    const comparisons: { source: string; target: string }[] = [];
    const mergeBase = f.client.mergeBase.bind(f.client);
    f.client.mergeBase = async (repository, source, target) => {
      if (repository.relativePath !== '.') return mergeBase(repository, source, target);
      comparisons.push({ source, target });
      return hash('f');
    };
    const active = reopen ? await f.restart() : f;
    if (reopen) {
      const review = await active.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }]);
      assert.equal(review.id, f.review.id);
    }
    const refreshed = await active.service.refreshReview(f.review.id);
    const row = active.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === '.')!;
    assert.equal(row.status, 'pull-request');
    assert.equal(row.targetHash, hash('e'));
    assert.equal(row.mergeBaseHash, hash('f'));
    assert.deepEqual(comparisons, [{ source: hash('a'), target: hash('e') }]);
    assert.equal(refreshed.snapshot.files.find(file => file.repoRelativePath === '.')?.baseCommit, hash('f'));
    assert.equal(f.calls.git, 0, 'The target revision is read from Bitbucket without inspecting local refs.');
  }
});

test('disagreement between an open PR and its remote target leaves the comparison unavailable and blocks merging', async t => {
  const f = await fixture(t);
  f.refs.set('.:target', hash('e'));
  const refreshed = await f.service.refreshReview(f.review.id);
  const row = f.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === '.')!;
  assert.equal(row.status, 'unavailable');
  assert.match(row.error ?? '', /branch changed.*consistent revision/i);
  assert.equal(refreshed.snapshot.files.some(file => file.repoRelativePath === '.'), false);
  assert.match(refreshed.snapshot.repos.find(repo => repo.relativePath === '.')?.error ?? '', /consistent revision/);
  assert.ok((await f.service.previewMerge(f.review.id)).blockers.some(message => /consistent revision/.test(message)));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /consistent revision/);
  assert.deepEqual(f.calls.merges, []);
  assert.deepEqual(f.calls.deletions, []);
  assert.equal(f.calls.git, 0);
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
  assert.deepEqual(new Set(f.calls.deletions), new Set(['child', '.', 'empty']));
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
  assert.deepEqual(new Set(f.calls.deletions), new Set(['child', '.', 'empty', 'zempty']));
  assert.equal(f.calls.deletions.length, 4);
  assert.deepEqual(f.calls.merges, ['child', '.']);
  f.refs.set('empty:source', hash('e'));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /recreated/);
  assert.equal(f.refs.get('empty:source'), hash('e'));
});

test('a saved partial merge reopens after restart with deleted child branches and resumes only unfinished work', async t => {
  const f = await fixture(t);
  f.prs.set('child#8', pr(child, 8, hash('d')));
  await f.service.refreshReview(f.review.id);
  const feedback = await f.add('.');
  const childPr = f.prs.get('child#8')!;
  childPr.state = 'MERGED'; childPr.mergeCommit = hash('9');
  f.refs.set('child:target', hash('9'));
  f.refs.delete('child:source'); f.refs.delete('empty:source');
  await f.state.updateReview(f.review.id, binding => {
    binding.repositories!.find(row => row.repository.relativePath === 'child')!.cleanup = { state: 'deleted', expectedHead: hash('d') };
    binding.repositories!.find(row => row.repository.relativePath === 'empty')!.cleanup = { state: 'deleted', expectedHead: hash('b') };
    binding.operation = { action: 'merge', state: 'paused', updatedAt: new Date().toISOString(), error: 'Root merge permission denied', items: binding.pullRequests.map(pr => ({
      prKey: pullRequestKey(pr), sourceHash: pr.sourceHash, targetHash: pr.targetHash, approval: 'approved',
      ...(pr.repository.relativePath === 'child' ? { merge: 'merged' as const, cleanup: 'deleted' as const, mergeCommit: hash('9') } : { merge: 'failed' as const, error: 'Merge permission denied' }),
    })) };
  });
  const restored = await f.restart();
  const reopened = await restored.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }]);
  assert.equal(reopened.id, f.review.id);
  const refreshed = await restored.service.refreshReview(reopened.id);
  const childRow = restored.state.review(reopened.id)!.repositories!.find(row => row.repository.relativePath === 'child')!;
  assert.equal(childRow.status, 'pull-request');
  assert.equal(childRow.error, undefined);
  assert.equal(childRow.cleanup?.state, 'deleted');
  assert.equal(childRow.sourceHash, hash('d'));
  assert.equal(childRow.targetHash, hash('b'), 'the reviewed comparison survives the changed target');
  assert.equal(childRow.mergeBaseHash, hash('c'));
  assert.ok(refreshed.snapshot.files.some(file => file.repoRelativePath === 'child' && file.headCommit === hash('d')));
  assert.deepEqual((await restored.service.previewMerge(reopened.id)).blockers, []);
  const complete = await restored.service.runPullRequestAction(reopened.id, 'merge');
  assert.equal(complete.operation?.state, 'complete', complete.operation?.error);
  assert.deepEqual(f.calls.merges, ['.']);
  assert.deepEqual(f.calls.deletions, ['.'], 'confirmed child and empty branch deletion receipts are not repeated');
  assert.equal(complete.operation!.items.find(item => item.prKey === 'child#8')!.mergeCommit, hash('9'));
  assert.equal(restored.reviews.getReview(reopened.id).comments[0].id, feedback.id);
  assert.equal(f.calls.git, 0);
});

test('a missing source branch on an open PR stays visible and blocks the group instead of skipping its changes', async t => {
  const f = await fixture(t);
  f.prs.set('child#8', pr(child, 8, hash('d')));
  await f.service.refreshReview(f.review.id);
  f.refs.delete('child:source');
  const refreshed = await f.service.refreshReview(f.review.id);
  const row = f.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === 'child')!;
  assert.equal(row.status, 'unavailable');
  assert.equal(row.prId, 8);
  assert.equal(row.sourceHash, hash('d'));
  assert.match(row.error ?? '', /Source branch.*missing.*still open.*will not skip unmerged changes/);
  assert.ok(refreshed.snapshot.repos.some(repo => repo.relativePath === 'child' && repo.error));
  const preview = await f.service.previewMerge(f.review.id);
  assert.ok(preview.blockers.some(message => /Source branch.*missing/.test(message)));
  await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'), /Source branch.*missing/);
  assert.deepEqual(f.calls.merges, []);
  assert.deepEqual(f.calls.deletions, []);
  assert.equal(f.calls.git, 0);
});

test('a concurrent external merge and deletion between PR and branch reads recovers the captured child comparison', async t => {
  for (const alreadyLinked of [true, false]) {
    const f = await fixture(t);
    f.prs.set('child#8', pr(child, 8, hash('d')));
    if (alreadyLinked) await f.service.refreshReview(f.review.id);
    const getBranch = f.client.getBranch.bind(f.client);
    let raced = false;
    f.client.getBranch = async (repository, name) => {
      if (!raced && repository.relativePath === 'child' && name === sourceBranch) {
        raced = true;
        const current = f.prs.get('child#8')!; current.state = 'MERGED'; current.mergeCommit = hash('9');
        f.refs.set('child:target', hash('9')); f.refs.delete('child:source');
      }
      return getBranch(repository, name);
    };
    const refreshed = await f.service.refreshReview(f.review.id);
    assert.equal(raced, true);
    const binding = f.state.review(f.review.id)!;
    const row = binding.repositories!.find(row => row.repository.relativePath === 'child')!;
    assert.equal(row.status, 'pull-request'); assert.equal(row.error, undefined);
    assert.equal(row.sourceHash, hash('d')); assert.equal(row.targetHash, hash('b')); assert.equal(row.mergeBaseHash, hash('c'));
    assert.equal(binding.pullRequests.find(pr => pr.repository.relativePath === 'child')?.state, 'MERGED');
    assert.ok(refreshed.snapshot.files.some(file => file.repoRelativePath === 'child' && file.headCommit === hash('d')));
    assert.deepEqual((await f.service.previewMerge(f.review.id)).blockers, []);
    const complete = await f.service.runPullRequestAction(f.review.id, 'merge');
    assert.equal(complete.operation?.state, 'complete', complete.operation?.error);
    assert.deepEqual(f.calls.merges, ['.']);
    assert.ok(!f.calls.deletions.includes('child'));
    assert.equal(complete.repositories!.find(row => row.repository.relativePath === 'child')!.cleanup?.state, 'deleted');
    assert.equal(f.calls.git, 0);
  }
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

test('an exact closed PR resolves uncertain creation after its source branch disappears', async t => {
  const f = await fixture(t); await f.add();
  f.hooks.afterCreate = () => { throw new Error('Connection timed out after acceptance'); };
  await assert.rejects(f.service.publishFeedback(f.review.id), /timed out/);
  const childPr = f.prs.get('child#21')!; childPr.state = 'MERGED'; childPr.mergeCommit = hash('9');
  f.refs.delete('child:source'); f.refs.set('child:target', hash('9'));
  await f.service.refreshReview(f.review.id);
  const preview = await f.service.previewMerge(f.review.id);
  assert.deepEqual(preview.blockers, []);
  const row = f.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === 'child')!;
  assert.equal(row.prId, 21);
  assert.equal(row.creation, undefined);
  assert.deepEqual(f.calls.merges, []);
});

test('missing source branches with unique captured work or uncertain creation stay blocked without an exact closed PR', async t => {
  for (const uncertain of [false, true]) {
    const f = await fixture(t);
    if (uncertain) {
      await f.add(); f.hooks.createError = new Error('Connection timed out');
      await assert.rejects(f.service.publishFeedback(f.review.id), /timed out/);
    }
    f.refs.delete('child:source'); f.refs.delete('child:target');
    await f.service.refreshReview(f.review.id);
    const row = f.state.review(f.review.id)!.repositories!.find(row => row.repository.relativePath === 'child')!;
    assert.equal(row.status, 'unavailable');
    assert.equal(row.sourceHash, hash('d'), 'missing refs cannot erase the captured work');
    assert.match(row.error!, uncertain ? /creation is still unconfirmed/ : /changes without a matching closed PR/);
    assert.ok((await f.service.previewMerge(f.review.id)).blockers.length);
    assert.deepEqual(f.calls.merges, []); assert.deepEqual(f.calls.deletions, []);
  }
});

test('closed linked and newly discovered PRs reconcile after both branches are deleted', async t => {
  for (const state of ['MERGED', 'DECLINED', 'SUPERSEDED']) {
    const f = await fixture(t);
    f.prs.get('.#7')!.state = state;
    f.prs.set('child#21', { ...pr(child, 21, hash('d')), state });
    for (const path of ['.', 'child', 'empty', 'absent']) {
      f.refs.delete(`${path}:source`); f.refs.delete(`${path}:target`);
    }
    const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => undefined);
    const result = await service.discover(f.review.id);
    assert.deepEqual(result.repositories.map(row => row.status), ['pull-request', 'pull-request', 'missing-branch', 'missing-branch']);
    assert.deepEqual(result.pullRequests.map(value => [value.id, value.state]), [[7, state], [21, state]]);
    assert.equal(result.repositories[1].sourceHash, hash('d'));
    assert.equal(result.repositories[1].targetHash, hash('b'));
    assert.ok(result.repositories.every(row => !row.error));
    assert.deepEqual(f.calls.merges, []); assert.deepEqual(f.calls.deletions, []); assert.equal(f.calls.git, 0);
  }
});

test('old closed PRs never hide reused branches or attach to repositories with no captured source', async t => {
  for (const sourceExists of [false, true]) {
    const f = await fixture(t);
    f.prs.set('child#21', { ...pr(child, 21, hash('e')), state: 'MERGED' });
    f.prs.set('absent#22', { ...pr(absent, 22, hash('e')), state: 'MERGED' });
    if (!sourceExists) f.refs.delete('child:source');
    const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => undefined);
    const result = await service.discover(f.review.id);
    assert.equal(result.repositories[1].status, sourceExists ? 'changes' : 'unavailable');
    assert.equal(result.repositories[1].prId, undefined);
    assert.equal(result.repositories[3].status, 'missing-branch');
    assert.equal(result.repositories[3].prId, undefined);
    assert.deepEqual(result.pullRequests.map(value => value.id), [7]);
  }
});

test('declined and superseded PRs remain unmergeable even when their captured historical diff is readable', async t => {
  for (const state of ['DECLINED', 'SUPERSEDED']) {
    const f = await fixture(t);
    f.prs.get('.#7')!.state = state;
    await f.service.refreshReview(f.review.id);
    assert.equal(f.state.review(f.review.id)!.repositories![0].status, 'pull-request');
    const preview = await f.service.previewMerge(f.review.id);
    assert.ok(preview.blockers.some(value => value.includes(state.toLowerCase())));
    await assert.rejects(f.service.runPullRequestAction(f.review.id, 'merge'));
    assert.deepEqual(f.calls.merges, []); assert.deepEqual(f.calls.deletions, []);
  }
});

test('divergent or duplicate closed PRs cannot establish the result of captured branch changes', async t => {
  for (const kind of ['target', 'duplicate']) {
    const f = await fixture(t);
    f.prs.set('child#21', { ...pr(child, 21, hash('d')), state: 'MERGED', ...(kind === 'target' ? { targetBranch: 'release' } : {}) });
    if (kind === 'duplicate') f.prs.set('child#22', { ...pr(child, 22, hash('d')), state: 'DECLINED' });
    f.refs.delete('child:source'); f.refs.delete('child:target');
    const service = new BranchReviewService(f.reviews, f.state, () => f.client, () => undefined);
    const result = await service.discover(f.review.id);
    assert.equal(result.repositories[1].status, 'unavailable');
    assert.match(result.repositories[1].error!, kind === 'target' ? /without a matching closed PR/ : /Multiple closed PRs/);
    assert.deepEqual(result.pullRequests.map(value => value.id), [7]);
  }
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
