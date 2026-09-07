import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewService } from '../electron/review-service';
import { ReviewStore } from '../electron/store';
import { currentReviewId, reviewContextKey } from '../shared/types';
import type { NewComment, ReviewConfig, ReviewFile, ReviewSnapshot } from '../shared/types';

const file: ReviewFile = {
  id: 'src/file.ts', repoRelativePath: '.', path: 'src/file.ts', status: 'M',
  additions: 1, deletions: 1, oldContent: 'before\n', newContent: 'after\n', binary: false,
  fingerprint: 'version-one', baseCommit: 'base', headCommit: 'head', source: 'working-tree',
};
const comment: NewComment = {
  fileId: file.id, repoRelativePath: '.', path: file.path, side: 'additions',
  lineStart: 1, lineEnd: 1, body: 'Check the result.', fingerprint: file.fingerprint, context: 'after',
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-current-service-'));
  const store = new ReviewStore(join(dir, 'reviews.json'));
  const project = await store.createProject({ name: 'Monorepo', repoPath: '/repository' });
  const live = { branch: 'feature/one' as string | null, fingerprint: file.fingerprint, extraFiles: [] as ReviewFile[], builds: [] as ReviewConfig[], onBuild: undefined as (() => Promise<void>) | undefined };
  const inspect = async () => ({ rootPath: '/repository', name: 'Monorepo', currentBranch: live.branch, branches: ['main', 'release', 'feature/one', 'feature/two'] });
  const build = async (config: ReviewConfig): Promise<ReviewSnapshot> => {
    live.builds.push(config);
    await live.onBuild?.();
    return { reviewId: config.id, files: [{ ...file, fingerprint: live.fingerprint }, ...live.extraFiles], repos: [], warnings: [], refreshedAt: new Date().toISOString(), fingerprint: live.fingerprint };
  };
  return { store, project, live, service: new ReviewService(store, inspect, build), id: currentReviewId(project.id), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('Current resolves the checkout but does not compare anything until a target is selected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const empty = await f.service.refreshReview(f.id);
  assert.equal(empty.review.featureBranch, 'feature/one');
  assert.equal(empty.review.baseBranch, '');
  assert.equal(empty.requiresTarget, true);
  assert.equal(empty.inspection?.currentBranch, 'feature/one');
  assert.deepEqual(empty.snapshot.files, []);
  assert.equal(f.live.builds.length, 0);
  await assert.rejects(() => f.service.setCurrentTarget(f.project.id, 'missing'), /not available/);
  assert.equal(f.store.getReview(f.id).baseBranch, '');
  const selected = await f.service.setCurrentTarget(f.project.id, 'main');
  assert.equal(selected.requiresTarget, false);
  assert.equal(selected.review.includeWorkingTree, true);
  assert.equal(f.store.getProject(f.project.id).defaultBaseBranch, 'main');
  assert.equal(f.store.getState().reviews.length, 1);
});

test('one Current review restores branch-and-target feedback and revalidates returning approvals', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const a = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  await f.service.addComment(f.id, comment, reviewContextKey(a));
  await f.service.setApproval(f.id, file.id, file.fingerprint, true, reviewContextKey(a));
  f.live.branch = 'feature/two';
  const b = (await f.service.refreshReview(f.id)).review;
  assert.equal(b.baseBranch, 'main');
  assert.deepEqual(b.comments, []);
  assert.deepEqual(b.approvals, {});
  await f.service.addComment(f.id, { ...comment, body: 'Feedback for two.' }, reviewContextKey(b));
  f.live.branch = 'feature/one';
  const restored = (await f.service.refreshReview(f.id)).review;
  assert.deepEqual(restored.comments.map(item => item.body), [comment.body]);
  assert.equal(restored.approvals[file.id], file.fingerprint);
  const release = (await f.service.setCurrentTarget(f.project.id, 'release')).review;
  assert.deepEqual(release.comments, []);
  assert.deepEqual(release.approvals, {});
  f.live.fingerprint = 'version-two';
  const changed = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  assert.deepEqual(changed.comments.map(item => item.body), [comment.body]);
  assert.deepEqual(changed.approvals, {});
  assert.equal(await f.service.copyFeedback(f.id, reviewContextKey(changed)), 'src/file.ts:1\nCheck the result.');
  assert.equal(f.store.getState().reviews.length, 1);
});

test('feedback actions detect a checkout switch before the renderer polls and reject the previous context', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const a = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  const annotated = await f.service.addComment(f.id, comment, reviewContextKey(a));
  f.live.branch = 'feature/two';
  const key = reviewContextKey(a);
  const actions = [
    () => f.service.addComment(f.id, comment, key),
    () => f.service.setApproval(f.id, file.id, file.fingerprint, true, key),
    () => f.service.updateComment(f.id, annotated.comments[0].id, { resolved: true }, key),
    () => f.service.deleteComment(f.id, annotated.comments[0].id, key),
    () => f.service.copyFeedback(f.id, key),
    () => f.service.addComment(f.id, comment),
  ];
  for (const action of actions) await assert.rejects(action, /branch or target changed/);
  assert.deepEqual(f.store.getReview(f.id).comments, []);
  f.live.branch = 'feature/one';
  const returned = (await f.service.refreshReview(f.id)).review;
  assert.equal(returned.comments.length, 1);
  assert.equal(returned.comments[0].resolved, false);
});

test('Current discards a diff built while switching branches and rejects approval of a changed file', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let builds = 0;
  f.live.onBuild = async () => { if (builds++ === 0) f.live.branch = 'feature/two'; };
  const result = await f.service.setCurrentTarget(f.project.id, 'main');
  assert.equal(result.review.featureBranch, 'feature/two');
  assert.deepEqual(f.live.builds.map(config => config.featureBranch), ['feature/one', 'feature/two']);
  f.live.fingerprint = 'newer-contents';
  await assert.rejects(() => f.service.setApproval(f.id, file.id, file.fingerprint, true, reviewContextKey(result.review)), /file changed/);
  assert.deepEqual(f.store.getReview(f.id).approvals, {});
});

test('detached HEAD suspends Current and a saved review remains on its explicit branch', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  await f.service.addComment(f.id, comment, reviewContextKey(current));
  const saved = await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/two', baseBranch: 'release', includeWorkingTree: false });
  f.live.branch = null;
  const detached = await f.service.refreshReview(f.id);
  assert.equal(detached.review.featureBranch, '');
  assert.equal(detached.review.baseBranch, 'main');
  assert.deepEqual(detached.snapshot.files, []);
  assert.match(detached.snapshot.warnings.join(' '), /HEAD is detached/);
  const pinned = await f.service.refreshReview(saved.id);
  assert.equal(pinned.review.featureBranch, 'feature/two');
  assert.equal(pinned.review.baseBranch, 'release');
  f.live.branch = 'feature/one';
  assert.equal((await f.service.refreshReview(f.id)).review.comments.length, 1);
});

test('a target change queued during a refresh rejects a later feedback action from the old view', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  let started!: () => void;
  const building = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  f.live.onBuild = async () => { f.live.onBuild = undefined; started(); await barrier; };
  const refreshing = f.service.refreshReview(f.id);
  await building;
  const switching = f.service.setCurrentTarget(f.project.id, 'release');
  const commenting = f.service.addComment(f.id, comment, reviewContextKey(current));
  const rejected = assert.rejects(() => commenting, /branch or target changed/);
  finish();
  await Promise.all([refreshing, switching, rejected]);
  assert.equal(f.store.getReview(f.id).baseBranch, 'release');
  assert.deepEqual(f.store.getReview(f.id).comments, []);
});

test('a batch refreshes once and validates every selected file before approving any', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const second = { ...file, id: 'packages/api/other.ts', path: 'other.ts', repoRelativePath: 'packages/api', fingerprint: 'second-version' };
  f.live.extraFiles = [second];
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  const key = reviewContextKey(current);
  const selection = [{ fileId: file.id, fingerprint: file.fingerprint }, { fileId: second.id, fingerprint: second.fingerprint }];
  f.live.builds.length = 0;
  await assert.rejects(() => f.service.setApprovals(f.id, [selection[0], { ...selection[1], fingerprint: 'stale-version' }], true, key), /file changed/);
  assert.deepEqual(f.store.getReview(f.id).approvals, {}, 'a stale second file must not leave the first file approved');
  assert.equal(f.live.builds.length, 1);
  f.live.builds.length = 0;
  const approved = await f.service.setApprovals(f.id, selection, true, key);
  assert.deepEqual(approved.approvals, { [file.id]: file.fingerprint, [second.id]: second.fingerprint });
  assert.equal(f.live.builds.length, 1, 'the batch uses one shared comparison instead of refreshing per selected file');
});

test('saved-review batches use a fresh snapshot and unapproval permits files absent from the diff', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const saved = await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/two', baseBranch: 'main' });
  await f.service.refreshReview(saved.id);
  f.live.fingerprint = 'new-file-version';
  await assert.rejects(() => f.service.setApprovals(saved.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true), /file changed/);
  assert.deepEqual(f.store.getReview(saved.id).approvals, {});
  await f.store.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: 'previous-version' }], true);
  const result = await f.service.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: 'previous-version' }], false);
  assert.deepEqual(result.approvals, {});
  await assert.rejects(() => f.service.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: '' }], false), /File version/);
});

test('a checkout switch during batch refresh rejects the entire captured Current selection', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  f.live.extraFiles = [{ ...file, id: 'second.ts', path: 'second.ts' }];
  let switched = false;
  f.live.onBuild = async () => { if (!switched) { switched = true; f.live.branch = 'feature/two'; } };
  await assert.rejects(() => f.service.setApprovals(f.id, [
    { fileId: file.id, fingerprint: file.fingerprint }, { fileId: 'second.ts', fingerprint: file.fingerprint },
  ], true, reviewContextKey(current)), /branch or target changed/);
  assert.deepEqual(f.store.getReview(f.id).approvals, {});
  assert.deepEqual(f.store.getReview(f.id).currentContexts?.[reviewContextKey(current)].approvals, {});
});
