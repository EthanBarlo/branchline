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
    const snapshot = { reviewId: config.id, files: [{ ...file, fingerprint: live.fingerprint }, ...live.extraFiles], repos: [], warnings: [], refreshedAt: new Date().toISOString(), fingerprint: live.fingerprint };
    await live.onBuild?.();
    return snapshot;
  };
  return { store, project, live, service: new ReviewService(store, inspect, build), id: currentReviewId(project.id), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function blockNextSnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  let started!: () => void;
  let finish!: () => void;
  const building = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  f.live.onBuild = async () => { f.live.onBuild = undefined; started(); await barrier; };
  return { building, finish };
}

async function beforeSnapshotFinishes<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Feedback waited for the blocked snapshot.')), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
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

test('Current discards a diff built while switching branches and refresh invalidates marks of older contents', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let builds = 0;
  f.live.onBuild = async () => { if (builds++ === 0) f.live.branch = 'feature/two'; };
  const result = await f.service.setCurrentTarget(f.project.id, 'main');
  assert.equal(result.review.featureBranch, 'feature/two');
  assert.deepEqual(f.live.builds.map(config => config.featureBranch), ['feature/one', 'feature/two']);
  f.live.fingerprint = 'newer-contents';
  const approved = await f.service.setApproval(f.id, file.id, file.fingerprint, true, reviewContextKey(result.review));
  assert.equal(approved.approvals[file.id], file.fingerprint, 'mark the exact contents the user saw without scanning again');
  assert.equal(f.live.builds.length, 2);
  assert.deepEqual((await f.service.refreshReview(f.id)).review.approvals, {});
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
  const blocked = blockNextSnapshot(f);
  const refreshing = f.service.refreshReview(f.id);
  await blocked.building;
  try {
    f.live.fingerprint = 'release-version';
    const switching = f.service.setCurrentTarget(f.project.id, 'release');
    const commenting = f.service.addComment(f.id, comment, reviewContextKey(current));
    const rejected = assert.rejects(() => commenting, /branch or target changed/);
    const [release] = await beforeSnapshotFinishes(Promise.all([switching, rejected]));
    assert.equal(release.review.baseBranch, 'release');
    assert.equal(release.snapshot.fingerprint, 'release-version');
    await f.service.setApproval(f.id, file.id, 'release-version', true, reviewContextKey(release.review));
  } finally { blocked.finish(); await refreshing; }
  assert.equal(f.store.getReview(f.id).baseBranch, 'release');
  assert.deepEqual(f.store.getReview(f.id).comments, []);
  assert.equal(f.store.getReview(f.id).approvals[file.id], 'release-version', 'the obsolete main scan must not invalidate marks from the release comparison');
});

test('a batch uses the loaded snapshot and validates every selected file before approving any', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const second = { ...file, id: 'packages/api/other.ts', path: 'other.ts', repoRelativePath: 'packages/api', fingerprint: 'second-version' };
  f.live.extraFiles = [second];
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  const key = reviewContextKey(current);
  const selection = [{ fileId: file.id, fingerprint: file.fingerprint }, { fileId: second.id, fingerprint: second.fingerprint }];
  f.live.builds.length = 0;
  await assert.rejects(() => f.service.setApprovals(f.id, [selection[0], { ...selection[1], fingerprint: 'stale-version' }], true, key), /file changed/);
  assert.deepEqual(f.store.getReview(f.id).approvals, {}, 'a stale second file must not leave the first file approved');
  assert.equal(f.live.builds.length, 0);
  f.live.builds.length = 0;
  const approved = await f.service.setApprovals(f.id, selection, true, key);
  assert.deepEqual(approved.approvals, { [file.id]: file.fingerprint, [second.id]: second.fingerprint });
  assert.equal(f.live.builds.length, 0, 'marking files never starts a new comparison');
});

test('saved-review batches use cached contents until refresh and unapproval permits files absent from the diff', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const saved = await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/two', baseBranch: 'main' });
  await f.service.refreshReview(saved.id);
  f.live.fingerprint = 'new-file-version';
  assert.equal((await f.service.setApproval(saved.id, file.id, file.fingerprint, true)).approvals[file.id], file.fingerprint);
  assert.equal(f.live.builds.length, 1);
  await f.service.refreshReview(saved.id);
  await assert.rejects(() => f.service.setApprovals(saved.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true), /file changed/);
  assert.deepEqual(f.store.getReview(saved.id).approvals, {});
  await f.store.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: 'previous-version' }], true);
  const result = await f.service.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: 'previous-version' }], false);
  assert.deepEqual(result.approvals, {});
  await assert.rejects(() => f.service.setApprovals(saved.id, [{ fileId: 'removed.ts', fingerprint: '' }], false), /File version/);
});

test('a checkout switch before the next refresh rejects the entire captured Current selection', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.live.extraFiles = [{ ...file, id: 'second.ts', path: 'second.ts' }];
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  f.live.branch = 'feature/two';
  f.live.builds.length = 0;
  await assert.rejects(() => f.service.setApprovals(f.id, [
    { fileId: file.id, fingerprint: file.fingerprint }, { fileId: 'second.ts', fingerprint: file.fingerprint },
  ], true, reviewContextKey(current)), /branch or target changed/);
  assert.deepEqual(f.store.getReview(f.id).approvals, {});
  assert.deepEqual(f.store.getReview(f.id).currentContexts?.[reviewContextKey(current)].approvals, {});
  assert.equal(f.live.builds.length, 0, 'the checkout check does not build a comparison');
});

for (const kind of ['current', 'saved'] as const) {
  test(`${kind} marks and comment changes save while a background snapshot is blocked`, async t => {
    const f = await fixture(); t.after(f.cleanup);
    const unchanged = { ...file, id: 'unchanged.ts', path: 'unchanged.ts', fingerprint: 'unchanged-version' };
    f.live.extraFiles = [unchanged];
    const review = kind === 'current'
      ? (await f.service.setCurrentTarget(f.project.id, 'main')).review
      : await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/one', baseBranch: 'main' });
    if (kind === 'saved') await f.service.refreshReview(review.id);
    const key = reviewContextKey(review);
    const before = await f.service.addComment(review.id, { ...comment, body: 'Remove this note.' }, key);
    const deletedId = before.comments[0].id;
    f.live.builds.length = 0;
    f.live.fingerprint = 'new-background-version';
    const blocked = blockNextSnapshot(f);
    const refreshing = f.service.refreshReview(review.id);
    await blocked.building;
    try {
      await beforeSnapshotFinishes((async () => {
        const marked = await f.service.setApproval(review.id, file.id, file.fingerprint, true, key);
        assert.equal(marked.approvals[file.id], file.fingerprint);
        await f.service.setApproval(review.id, unchanged.id, unchanged.fingerprint, true, key);
        const added = await f.service.addComment(review.id, comment, key);
        const addedId = added.comments.find(item => item.id !== deletedId)!.id;
        await f.service.updateComment(review.id, addedId, { body: 'Updated while the agent edits.' }, key);
        await f.service.updateComment(review.id, addedId, { resolved: true }, key);
        await f.service.updateComment(review.id, addedId, { resolved: false }, key);
        await f.service.deleteComment(review.id, deletedId, key);
        const stored = f.store.getReview(review.id);
        assert.deepEqual(stored.comments.map(item => [item.id, item.body, item.resolved]), [[addedId, 'Updated while the agent edits.', false]]);
        assert.equal(f.live.builds.length, 1, 'feedback must not request another snapshot');
      })());
    } finally { blocked.finish(); await refreshing; }
    const refreshed = f.store.getReview(review.id);
    assert.deepEqual(refreshed.approvals, { [unchanged.id]: unchanged.fingerprint }, 'the finished scan invalidates only the older reviewed version');
    assert.deepEqual(refreshed.comments.map(item => [item.body, item.resolved]), [['Updated while the agent edits.', false]], 'publishing a background scan preserves current feedback edits and deletions');
    assert.equal(f.live.builds.length, 1);
  });
}

test('local markers require a loaded snapshot and never start a scan themselves', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const current = await f.store.switchCurrentContext(f.project.id, 'feature/one', 'main');
  const saved = await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/one', baseBranch: 'main' });
  for (const review of [current, saved]) {
    await assert.rejects(() => f.service.setApproval(review.id, file.id, file.fingerprint, true, reviewContextKey(review)), /Open or refresh.*before marking files reviewed/);
    assert.deepEqual(f.store.getReview(review.id).approvals, {});
  }
  assert.equal(f.live.builds.length, 0);
  await f.service.refreshReview(f.id);
  assert.equal((await f.service.setApproval(f.id, file.id, file.fingerprint, true, reviewContextKey(current))).approvals[file.id], file.fingerprint);
});

test('a checkout switch during a blocked scan cannot publish the previous branch or its snapshot', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const current = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  await f.service.addComment(f.id, comment, reviewContextKey(current));
  const blocked = blockNextSnapshot(f);
  const refreshing = f.service.refreshReview(f.id);
  await blocked.building;
  try {
    f.live.branch = 'feature/two';
    f.live.fingerprint = 'branch-two-version';
    await beforeSnapshotFinishes(assert.rejects(() => f.service.setApproval(f.id, file.id, file.fingerprint, true, reviewContextKey(current)), /branch or target changed/));
  } finally { blocked.finish(); }
  const refreshed = await refreshing;
  assert.equal(refreshed.review.featureBranch, 'feature/two');
  assert.equal(refreshed.snapshot.fingerprint, 'branch-two-version');
  assert.deepEqual(refreshed.review.comments, []);
  assert.deepEqual(refreshed.review.approvals, {});
  f.live.branch = 'feature/one';
  assert.deepEqual((await f.service.refreshReview(f.id)).review.comments.map(item => item.body), [comment.body]);
});

test('switching targets away and back does not let an earlier scan replace the newer version of that context', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.service.setCurrentTarget(f.project.id, 'main');
  const blocked = blockNextSnapshot(f);
  const refreshing = f.service.refreshReview(f.id);
  await blocked.building;
  try {
    await beforeSnapshotFinishes((async () => {
      await f.service.setCurrentTarget(f.project.id, 'release');
      f.live.fingerprint = 'updated-main-version';
      const returned = await f.service.setCurrentTarget(f.project.id, 'main');
      await f.service.setApproval(f.id, file.id, 'updated-main-version', true, reviewContextKey(returned.review));
      await f.service.addComment(f.id, { ...comment, body: 'Feedback on the updated comparison.', fingerprint: 'updated-main-version' }, reviewContextKey(returned.review));
    })());
  } finally { blocked.finish(); }
  const refreshed = await refreshing;
  assert.equal(refreshed.review.baseBranch, 'main');
  assert.equal(refreshed.snapshot.fingerprint, 'updated-main-version');
  assert.deepEqual(refreshed.review.approvals, { [file.id]: 'updated-main-version' });
  assert.deepEqual(refreshed.review.comments.map(item => item.body), ['Feedback on the updated comparison.']);
});

test('a new refresh and an obsolete scan retry cannot publish conflicting versions of the same context', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const initial = (await f.service.setCurrentTarget(f.project.id, 'main')).review;
  const first = blockNextSnapshot(f);
  const firstRefresh = f.service.refreshReview(f.id);
  await first.building;
  const second = blockNextSnapshot(f);
  const secondRefresh = f.service.setCurrentTarget(f.project.id, 'release');
  await second.building;
  let retry: ReturnType<typeof blockNextSnapshot> | undefined;
  let latestRefresh: Promise<Awaited<ReturnType<ReviewService['refreshReview']>>> | undefined;
  try {
    f.live.branch = 'feature/two';
    await beforeSnapshotFinishes(assert.rejects(() => f.service.addComment(f.id, comment, reviewContextKey(initial)), /branch or target changed/));
    f.live.fingerprint = 'retry-version';
    retry = blockNextSnapshot(f);
    first.finish();
    await retry.building;
    f.live.fingerprint = 'later-version';
    latestRefresh = f.service.refreshReview(f.id);
    // This queued mutation lets the new refresh prepare if it starts another
    // scan, while leaving the retry's snapshot promise blocked.
    await beforeSnapshotFinishes(f.service.copyFeedback(f.id, reviewContextKey(f.store.getReview(f.id))));
  } finally {
    first.finish(); second.finish(); retry?.finish();
  }
  const [earlier, target, latest] = await Promise.all([firstRefresh, secondRefresh, latestRefresh!]);
  assert.equal(earlier.snapshot.fingerprint, latest.snapshot.fingerprint);
  assert.equal(target.snapshot.fingerprint, latest.snapshot.fingerprint);
  assert.equal(latest.review.featureBranch, 'feature/two');
  const approved = await f.service.setApproval(f.id, file.id, latest.snapshot.files[0].fingerprint, true, reviewContextKey(latest.review));
  assert.equal(approved.approvals[file.id], latest.snapshot.files[0].fingerprint, 'the cache must retain the latest completed comparison');
});

for (const removal of ['review', 'project'] as const) {
  test(`deleting a ${removal} during a snapshot never restores the removed review or its cache`, async t => {
    const f = await fixture(); t.after(f.cleanup);
    const saved = await f.store.createReview({ projectId: f.project.id, featureBranch: 'feature/one', baseBranch: 'main' });
    await f.service.refreshReview(saved.id);
    const blocked = blockNextSnapshot(f);
    const refreshing = f.service.refreshReview(saved.id);
    const rejected = assert.rejects(() => refreshing, /being removed|no longer exists/);
    await blocked.building;
    const deleting = removal === 'review' ? f.service.deleteReview(saved.id) : f.service.deleteProject(f.project.id);
    blocked.finish();
    await Promise.all([deleting, rejected]);
    assert.equal(f.store.getState().reviews.some(review => review.id === saved.id), false);
    if (removal === 'project') assert.equal(f.store.getState().projects.some(project => project.id === f.project.id), false);
    await assert.rejects(() => f.service.setApproval(saved.id, file.id, file.fingerprint, true), /no longer exists/);
    await assert.rejects(() => f.service.refreshReview(saved.id), /no longer exists/);
  });
}
