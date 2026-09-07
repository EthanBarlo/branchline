import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFeedback, ReviewStore } from '../electron/store';
import type { NewComment, ReviewSnapshot, ReviewFile } from '../shared/types';
import { currentReviewId, reviewContextKey } from '../shared/types';

const config = { name: 'Checkout review', repoPath: '/example/mono', baseBranch: 'main', featureBranch: 'checkout', includeWorkingTree: true };
const sampleFile: ReviewFile = {
  id: 'packages/api/src/cart.ts', repoRelativePath: 'packages/api', path: 'src/cart.ts', status: 'M',
  additions: 1, deletions: 1, oldContent: 'old', newContent: 'new', binary: false,
  fingerprint: 'version-a', baseCommit: 'base', headCommit: 'head', source: 'working-tree',
};
function snapshot(reviewId: string, files = [sampleFile]): ReviewSnapshot {
  return { reviewId, files, repos: [], warnings: [], refreshedAt: new Date().toISOString(), fingerprint: 'snapshot' };
}

test('multiple reviews persist independently, including concurrent comments and approvals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    await store.load();
    const first = await store.createReview(config);
    const second = await store.createReview({ ...config, featureBranch: 'other' });
    await Promise.all([
      store.setApproval(first.id, sampleFile.id, sampleFile.fingerprint, true),
      store.addComment(first.id, { fileId: sampleFile.id, repoRelativePath: sampleFile.repoRelativePath, path: sampleFile.path,
        side: 'additions', lineStart: 2, lineEnd: 4, body: 'Handle an empty cart.', fingerprint: sampleFile.fingerprint, context: 'return cart.total;' }),
    ]);
    const reopened = new ReviewStore(join(dir, 'reviews.json'));
    await reopened.load();
    assert.equal(reopened.getReview(first.id).comments.length, 1);
    assert.equal(reopened.getReview(first.id).approvals[sampleFile.id], sampleFile.fingerprint);
    assert.deepEqual(reopened.getReview(second.id).approvals, {});
    await reopened.deleteReview(second.id);
    assert.equal(reopened.getState().reviews.filter(review => review.kind === 'saved').length, 1);
    assert.equal(reopened.getState().reviews.filter(review => review.kind === 'current').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approval survives unchanged snapshots but is permanently cleared when file changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const review = await store.createReview(config);
    await store.setApproval(review.id, sampleFile.id, 'version-a', true);
    assert.equal((await store.reconcileApprovals(review.id, snapshot(review.id))).approvals[sampleFile.id], 'version-a');
    assert.deepEqual((await store.reconcileApprovals(review.id, snapshot(review.id, [{ ...sampleFile, fingerprint: 'version-b' }]))).approvals, {});
    // Returning to the old contents must not silently reapprove the file.
    assert.deepEqual((await store.reconcileApprovals(review.id, snapshot(review.id))).approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refresh invalidates an approval already queued for the earlier version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const approval = store.setApproval(review.id, sampleFile.id, 'version-a', true);
    const refresh = store.reconcileApprovals(review.id, snapshot(review.id, [{ ...sampleFile, fingerprint: 'version-b' }]));
    await Promise.all([approval, refresh]);
    assert.deepEqual(store.getReview(review.id).approvals, {});
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getReview(review.id).approvals, {});
    assert.deepEqual((await store.reconcileApprovals(review.id, snapshot(review.id))).approvals, {}, 'reverting contents must not revive the queued approval');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unchanged refresh waits for queued mutations without rewriting the saved file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const approval = store.setApproval(review.id, sampleFile.id, 'version-a', true);
    const refresh = store.reconcileApprovals(review.id, snapshot(review.id));
    await approval;
    assert.equal((await refresh).approvals[sampleFile.id], 'version-a');
    const before = await stat(filePath);
    await store.reconcileApprovals(review.id, snapshot(review.id));
    const after = await stat(filePath);
    assert.equal(after.ino, before.ino, 'unchanged refresh should not replace the persisted file');
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed root read preserves root approvals while successful submodules still invalidate changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const review = await store.createReview(config);
    const rootFile = { ...sampleFile, id: 'root.ts', path: 'root.ts', repoRelativePath: '.' };
    await store.setApproval(review.id, rootFile.id, 'version-a', true);
    await store.setApproval(review.id, sampleFile.id, 'version-a', true);
    const failed = {
      ...snapshot(review.id, [{ ...sampleFile, fingerprint: 'version-b' }]),
      repos: [
        { relativePath: '.', currentBranch: 'checkout', workingTreeIncluded: true, error: 'The checkout changed during refresh.' },
        { relativePath: 'packages/api', currentBranch: 'checkout', workingTreeIncluded: true },
      ],
    };
    const pending = await store.reconcileApprovals(review.id, failed);
    assert.equal(pending.approvals[rootFile.id], 'version-a');
    assert.equal(pending.approvals[sampleFile.id], undefined);
    const success = {
      ...snapshot(review.id, [{ ...rootFile, fingerprint: 'version-b' }]),
      repos: [{ relativePath: '.', currentBranch: 'checkout', workingTreeIncluded: true }],
    };
    assert.deepEqual((await store.reconcileApprovals(review.id, success)).approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed submodule read preserves only its approvals until a successful version comparison', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const review = await store.createReview(config);
    const rootFile = { ...sampleFile, id: 'root.ts', path: 'root.ts', repoRelativePath: '.' };
    await store.setApproval(review.id, rootFile.id, 'version-a', true);
    await store.setApproval(review.id, sampleFile.id, 'version-a', true);
    const failed = {
      ...snapshot(review.id, [{ ...rootFile, fingerprint: 'version-b' }]),
      repos: [
        { relativePath: '.', currentBranch: 'checkout', workingTreeIncluded: true },
        { relativePath: 'packages/api', currentBranch: 'checkout', workingTreeIncluded: false, error: 'Repository temporarily unavailable.' },
      ],
    };
    const pending = await store.reconcileApprovals(review.id, failed);
    assert.equal(pending.approvals[rootFile.id], undefined);
    assert.equal(pending.approvals[sampleFile.id], 'version-a');
    const success = {
      ...snapshot(review.id),
      repos: failed.repos.map(({ error: _error, ...repository }) => repository),
    };
    assert.equal((await store.reconcileApprovals(review.id, success)).approvals[sampleFile.id], 'version-a', 'recovering with unchanged contents retains the approval');
    const changed = { ...success, files: [{ ...sampleFile, fingerprint: 'version-b' }] };
    assert.deepEqual((await store.reconcileApprovals(review.id, changed)).approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feedback contains only paths and bodies, groups interleaved files, and sorts line ranges stably', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const created = await store.createReview(config);
    assert.equal(formatFeedback(created), '');
    const comment = { fileId: sampleFile.id, repoRelativePath: sampleFile.repoRelativePath, path: 'src/old-cart.ts',
      side: 'deletions' as const, lineStart: 10, lineEnd: 12, body: 'Keep this validation.', fingerprint: 'older', context: '```\nvalidate(cart);' };
    await store.addComment(created.id, comment);
    await store.addComment(created.id, { ...comment, fileId: 'README.md', repoRelativePath: '.', path: 'README.md', lineStart: 7, lineEnd: 7, body: 'Check this example.' });
    await store.addComment(created.id, { ...comment, lineStart: 2, lineEnd: 4, body: 'Validate before updating.\nKeep the original behavior.' });
    await store.addComment(created.id, { ...comment, lineStart: 2, lineEnd: 2, body: 'Handle the missing cart.' });
    await store.addComment(created.id, { ...comment, lineStart: 2, lineEnd: 4, body: 'Keep the output stable.' });
    const withResolved = await store.addComment(created.id, { ...comment, body: 'Already fixed' });
    const review = await store.updateComment(created.id, withResolved.comments.at(-1)!.id, { resolved: true });
    assert.equal(formatFeedback(review), [
      'packages/api/src/old-cart.ts:2\nHandle the missing cart.',
      'packages/api/src/old-cart.ts:2-4\nValidate before updating.\nKeep the original behavior.',
      'packages/api/src/old-cart.ts:2-4\nKeep the output stable.',
      'packages/api/src/old-cart.ts:10-12\nKeep this validation.',
      'README.md:7\nCheck this example.',
    ].join('\n\n'));
    assert.equal(review.comments.length, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid storage is preserved rather than overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const file = join(dir, 'reviews.json');
    await writeFile(file, '{broken');
    await assert.rejects(() => new ReviewStore(file).load());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file-level comments can be saved and export without a fictitious line zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const created = await store.createReview(config);
    const review = await store.addComment(created.id, {
      fileId: sampleFile.id, repoRelativePath: '.', path: 'logo.png', side: 'additions',
      lineStart: 0, lineEnd: 0, body: 'Please keep the original logo.', fingerprint: 'image', context: '',
    });
    assert.equal(formatFeedback(review), 'logo.png\nPlease keep the original logo.');
    const resolved = await store.updateComment(review.id, review.comments[0].id, { resolved: true });
    assert.equal(formatFeedback(resolved), '');
    await assert.rejects(() => store.addComment(created.id, { ...review.comments[0], lineStart: 0, lineEnd: 5 }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preserves whitespace in filesystem paths and comment identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const repoPath = '/example/ repository ';
    const repoRelativePath = ' module ';
    const path = ' file.ts ';
    const fileId = `${repoRelativePath}/${path}`;
    const created = await store.createReview({ ...config, repoPath, name: ' Review name ' });
    assert.equal(created.repoPath, repoPath);
    assert.equal(created.name, 'Review name');
    await store.setApproval(created.id, fileId, 'version-a', true);
    await store.addComment(created.id, {
      fileId, repoRelativePath, path, side: 'additions', lineStart: 1, lineEnd: 1,
      body: ' Comment body ', fingerprint: 'version-a', context: 'code',
    });
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    const review = reopened.getReview(created.id);
    assert.equal(review.comments[0].fileId, fileId);
    assert.equal(review.comments[0].path, path);
    assert.equal(review.comments[0].repoRelativePath, repoRelativePath);
    assert.equal(review.comments[0].body, 'Comment body');
    assert.equal(review.approvals[fileId], 'version-a');
    assert.equal(formatFeedback(review), `${fileId}:1\nComment body`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('migrates legacy reviews into stable projects without changing feedback or approval data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const comment = {
      id: 'preserved-comment-id', fileId: ' file.ts ', repoRelativePath: '.', path: ' file.ts ',
      side: 'deletions', lineStart: 3, lineEnd: 5, body: 'Preserve this feedback.', fingerprint: 'reviewed-version',
      context: 'original code', createdAt: '2026-01-02T00:00:00.000Z', resolved: true,
    };
    const oldest = { ...config, id: 'old-review-id', baseBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', comments: [comment], approvals: { ' file.ts ': 'reviewed-version' } };
    const newest = { ...oldest, id: 'new-review-id', baseBranch: 'release', createdAt: '2026-05-01T00:00:00.000Z', comments: [], approvals: {} };
    const another = { ...oldest, id: 'other-review-id', repoPath: '/example/mono ', baseBranch: 'develop' };
    const legacy = { reviews: [oldest, another, newest] };
    await writeFile(filePath, JSON.stringify(legacy));
    const store = new ReviewStore(filePath);
    await store.load();
    const migrated = store.getState();
    assert.equal(migrated.projects.length, 2);
    const mono = migrated.projects.find(project => project.repoPath === config.repoPath)!;
    assert.equal(mono.name, 'mono');
    assert.equal(mono.defaultBaseBranch, 'release', 'latest creation timestamp determines remembered target');
    assert.equal(mono.createdAt, oldest.createdAt);
    assert.equal(migrated.reviews[0].projectId, mono.id);
    assert.equal(migrated.reviews[2].projectId, mono.id);
    assert.notEqual(migrated.reviews[1].projectId, mono.id, 'raw paths with different whitespace stay separate');
    assert.deepEqual(migrated.reviews.filter(review => review.kind === 'saved').map(({ projectId: _projectId, kind: _kind, ...review }) => review), legacy.reviews);
    for (const project of migrated.projects) {
      const current = migrated.reviews.find(review => review.id === currentReviewId(project.id))!;
      assert.equal(current.kind, 'current');
      assert.equal(current.baseBranch, '', 'remembered manual targets must not silently configure Current');
      assert.equal(current.featureBranch, '');
    }
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), migrated, 'migration is persisted before load resolves');
    const before = await stat(filePath);
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getState(), migrated, 'project IDs remain stable on reopening');
    assert.equal((await stat(filePath)).ino, before.ino, 'modern storage is not rewritten on every startup');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('projects deduplicate concurrent adds and remember independent targets across reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const [first, duplicate] = await Promise.all([
      store.createProject({ repoPath: '/offline/alpha', defaultBaseBranch: 'main' }),
      store.createProject({ repoPath: '/offline/alpha', name: 'Duplicate name', defaultBaseBranch: 'other' }),
    ]);
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.name, 'alpha');
    assert.equal(duplicate.defaultBaseBranch, 'main', 'reopening a known location retains its preferences');
    const second = await store.createProject({ repoPath: '/offline/beta', name: ' Beta project ', defaultBaseBranch: 'develop' });
    const review = await store.createReview({ projectId: first.id, featureBranch: 'feature/first' });
    assert.equal(review.name, 'feature/first');
    assert.equal(review.baseBranch, 'main');
    assert.equal(review.repoPath, first.repoPath);
    assert.equal(review.includeWorkingTree, true);
    await store.createReview({ projectId: first.id, featureBranch: 'feature/next', baseBranch: 'release', includeWorkingTree: false });
    assert.equal(store.getProject(first.id).defaultBaseBranch, 'release');
    assert.equal(store.getReview(review.id).baseBranch, 'main', 'existing comparisons retain their original target');
    assert.equal(store.getProject(second.id).defaultBaseBranch, 'develop');
    const otherReview = await store.createReview({ projectId: second.id, featureBranch: 'feature/other' });
    assert.equal(otherReview.baseBranch, 'develop');
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.equal(reopened.getProject(first.id).defaultBaseBranch, 'release');
    assert.equal(reopened.getProject(second.id).name, 'Beta project');
    await reopened.updateProject(first.id, { name: ' Renamed project ', defaultBaseBranch: 'stable' });
    assert.equal(reopened.getProject(first.id).name, 'Renamed project');
    assert.equal(reopened.getProject(first.id).defaultBaseBranch, 'stable');
    assert.equal(reopened.getProject(second.id).defaultBaseBranch, 'develop');
    await reopened.updateProject(first.id, { defaultBaseBranch: null });
    assert.equal(reopened.getProject(first.id).defaultBaseBranch, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy createReview calls reuse projects and validate project binding atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const first = await store.createReview(config);
    const second = await store.createReview({ ...config, baseBranch: 'release', featureBranch: 'another' });
    assert.equal(first.projectId, second.projectId);
    assert.equal(store.getState().projects.length, 1);
    assert.equal(store.getProject(first.projectId).defaultBaseBranch, 'release');
    const before = store.getState();
    await assert.rejects(() => store.createReview({ ...config, projectId: first.projectId, repoPath: '/wrong/repo' }), /does not match/);
    await assert.rejects(() => store.createReview({ projectId: 'missing', featureBranch: 'feature', baseBranch: 'main' }), /no longer exists/);
    await assert.rejects(() => store.createReview({ repoPath: '/offline/new-project', baseBranch: 'main' }), /Feature branch/);
    await assert.rejects(() => store.createReview({ projectId: first.projectId, featureBranch: 'feature', includeWorkingTree: 'yes' as unknown as boolean }), /enabled or disabled/);
    await assert.rejects(() => store.createProject({ repoPath: '' }), /Repository path/);
    await assert.rejects(() => store.updateProject(first.projectId, { name: ' ' }), /Project name/);
    await assert.rejects(() => store.updateProject(first.projectId, { defaultBaseBranch: '' }), /Target branch/);
    assert.deepEqual(store.getState(), before, 'invalid operations must not create orphan projects or modify defaults');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deleting the last review preserves its project; deleting a project cascades only its reviews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const first = await store.createReview(config);
    await store.deleteReview(first.id);
    assert.equal(store.getState().reviews.filter(review => review.kind === 'saved').length, 0);
    assert.equal(store.getReview(currentReviewId(first.projectId)).kind, 'current');
    assert.equal(store.getProject(first.projectId).repoPath, config.repoPath);
    const replacement = await store.createReview({ projectId: first.projectId, featureBranch: 'replacement' });
    await store.addComment(replacement.id, {
      fileId: 'src.ts', repoRelativePath: '.', path: 'src.ts', side: 'additions', lineStart: 1, lineEnd: 1,
      fingerprint: 'version', context: 'code', body: 'A saved note.',
    });
    const other = await store.createReview({ ...config, repoPath: '/offline/other-project' });
    await store.setApproval(other.id, 'other.ts', 'approved-version', true);
    const otherBefore = store.getReview(other.id);
    const result = await store.deleteProject(first.projectId);
    assert.deepEqual(result.reviews.filter(review => review.kind === 'saved'), [otherBefore]);
    assert.equal(result.reviews.filter(review => review.kind === 'current').length, 1);
    assert.equal(result.reviews.find(review => review.kind === 'current')?.id, currentReviewId(other.projectId));
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].id, other.projectId);
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getState(), result);
    assert.throws(() => reopened.getProject(first.projectId), /no longer exists/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('malformed projects and dangling review relationships cannot overwrite saved data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const source = new ReviewStore(join(dir, 'source.json'));
    const review = await source.createReview(config);
    const valid = source.getState();
    const project = valid.projects[0];
    const invalidStates = [
      { ...valid, projects: null },
      { ...valid, projects: [{ ...project, defaultBaseBranch: 42 }] },
      { ...valid, projects: [project, { ...project, id: 'duplicate-path' }] },
      { ...valid, reviews: [{ ...review, projectId: 'missing-project' }] },
      { ...valid, reviews: [{ ...review, repoPath: '/different/path' }] },
      { reviews: valid.reviews },
    ];
    for (const [index, invalid] of invalidStates.entries()) {
      const filePath = join(dir, `invalid-${index}.json`);
      const original = JSON.stringify(invalid, null, 2);
      await writeFile(filePath, original);
      const store = new ReviewStore(filePath);
      await assert.rejects(() => store.load(), /invalid format/);
      await assert.rejects(() => store.createProject({ repoPath: '/another/project' }), /could not be loaded/);
      assert.equal(await readFile(filePath, 'utf8'), original);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('every project owns one permanent initially unconfigured Current review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const project = await store.createProject({ repoPath: '/offline/current-project', defaultBaseBranch: 'remembered-main' });
    const current = store.getReview(currentReviewId(project.id));
    assert.equal(current.kind, 'current');
    assert.equal(current.name, 'Current');
    assert.equal(current.includeWorkingTree, true);
    assert.equal(current.featureBranch, '');
    assert.equal(current.baseBranch, '');
    await store.createProject({ repoPath: project.repoPath });
    const saved = await store.createReview({ projectId: project.id, featureBranch: 'manual-feature' });
    assert.equal(saved.kind, 'saved');
    assert.equal(saved.baseBranch, 'remembered-main');
    assert.equal(store.getState().reviews.filter(review => review.kind === 'current').length, 1);
    await assert.rejects(() => store.deleteReview(current.id), /Current is permanent/);
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getReview(current.id), current);
    await reopened.deleteProject(project.id);
    assert.deepEqual(reopened.getState(), { projects: [], reviews: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('migrates project-era saved reviews and empty projects without reusing remembered Current targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const source = new ReviewStore(join(dir, 'source.json'));
    const saved = await source.createReview(config);
    const empty = await source.createProject({ repoPath: '/offline/empty', defaultBaseBranch: 'develop' });
    const sourceState = source.getState();
    const legacy = {
      projects: sourceState.projects,
      reviews: sourceState.reviews.filter(review => review.kind === 'saved').map(({ kind: _kind, ...review }) => review),
    };
    await writeFile(filePath, JSON.stringify(legacy));
    const store = new ReviewStore(filePath);
    await store.load();
    assert.equal(store.getState().reviews.length, 3);
    assert.deepEqual(store.getReview(saved.id), saved);
    assert.equal(store.getReview(currentReviewId(saved.projectId)).baseBranch, '');
    assert.equal(store.getReview(currentReviewId(empty.id)).baseBranch, '');
    assert.equal(store.getProject(empty.id).defaultBaseBranch, 'develop');
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getState(), store.getState());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const currentComment = {
  fileId: sampleFile.id, repoRelativePath: sampleFile.repoRelativePath, path: sampleFile.path,
  side: 'additions' as const, lineStart: 1, lineEnd: 1, body: 'Feedback for this branch.',
  fingerprint: sampleFile.fingerprint, context: 'selected code',
};

test('Current swaps branch/target feedback independently and restores exact data across reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const project = await store.createProject({ repoPath: '/offline/context-project' });
    let current = await store.switchCurrentContext(project.id, 'feature-a', 'main');
    const keyA = reviewContextKey(current);
    const id = current.id;
    await store.addComment(id, currentComment, keyA);
    const feedbackA = await store.setApproval(id, sampleFile.id, sampleFile.fingerprint, true, keyA);
    current = await store.switchCurrentContext(project.id, 'feature-b');
    assert.equal(current.baseBranch, 'main', 'omitting target retains the current target');
    assert.deepEqual(current.comments, []);
    assert.deepEqual(current.approvals, {});
    const keyB = reviewContextKey(current);
    const feedbackB = await store.addComment(id, { ...currentComment, body: 'Different branch feedback.' }, keyB);
    current = await store.switchCurrentContext(project.id, 'feature-b', 'release');
    assert.deepEqual(current.comments, []);
    const keyRelease = reviewContextKey(current);
    const feedbackRelease = await store.addComment(id, { ...currentComment, body: 'Different target feedback.' }, keyRelease);
    current = await store.switchCurrentContext(project.id, 'feature-a', 'main');
    assert.deepEqual(current.comments, feedbackA.comments);
    assert.deepEqual(current.approvals, feedbackA.approvals);
    assert.equal(Object.hasOwn(current.currentContexts!, keyA), false, 'active context must be removed from the inactive map');
    assert.deepEqual(current.currentContexts?.[keyB].comments, feedbackB.comments);
    assert.deepEqual(current.currentContexts?.[keyRelease].comments, feedbackRelease.comments);
    const before = await stat(filePath);
    assert.deepEqual(await store.switchCurrentContext(project.id, 'feature-a'), current);
    assert.equal((await stat(filePath)).ino, before.ino, 'unchanged checkout does not rewrite storage');
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getReview(id), current);
    current = await reopened.switchCurrentContext(project.id, 'feature-b', 'release');
    assert.deepEqual(current.comments, feedbackRelease.comments);
    assert.equal(Object.hasOwn(current.currentContexts!, keyRelease), false);
    current = await reopened.switchCurrentContext(project.id, 'feature-b', null);
    assert.equal(current.baseBranch, '');
    assert.deepEqual(current.comments, []);
    assert.equal(reopened.getProject(project.id).defaultBaseBranch, 'release', 'clearing Current does not erase manual review defaults');
    current = await reopened.switchCurrentContext(project.id, null);
    assert.equal(current.featureBranch, '');
    assert.equal(current.baseBranch, '');
    current = await reopened.switchCurrentContext(project.id, 'feature-a', 'main');
    assert.deepEqual(current.comments, feedbackA.comments);
    assert.deepEqual(current.approvals, feedbackA.approvals);
    current = await reopened.switchCurrentContext(project.id, 'feature-a', '');
    assert.equal(current.baseBranch, '', 'explicit empty target also unsets the target');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('queued Current mutations validate their captured context after earlier switches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const project = await store.createProject({ repoPath: '/offline/race-project' });
    const initial = await store.switchCurrentContext(project.id, 'feature-a', 'main');
    const key = reviewContextKey(initial);
    const id = initial.id;
    const withComment = await store.addComment(id, currentComment, key);
    const commentId = withComment.comments[0].id;
    const original = await store.setApproval(id, sampleFile.id, sampleFile.fingerprint, true, key);
    const switching = store.switchCurrentContext(project.id, 'feature-b');
    const staleMutations = [
      store.setApproval(id, 'wrong-file', 'wrong-version', true, key),
      store.addComment(id, { ...currentComment, body: 'Wrong-context note.' }, key),
      store.updateComment(id, commentId, { body: 'Wrong-context edit.' }, key),
      store.deleteComment(id, commentId, key),
      store.reconcileApprovals(id, snapshot(id, []), key),
    ];
    const results = await Promise.allSettled(staleMutations);
    await switching;
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), /context changed/);
    }
    assert.deepEqual(store.getReview(id).comments, []);
    assert.deepEqual(store.getReview(id).approvals, {});
    let restored = await store.switchCurrentContext(project.id, 'feature-a');
    assert.deepEqual(restored.comments, original.comments);
    assert.deepEqual(restored.approvals, original.approvals);
    // A mutation submitted before the switch belongs to its original context.
    await Promise.all([
      store.addComment(id, { ...currentComment, body: 'Saved before switch.' }, key),
      store.switchCurrentContext(project.id, 'feature-b'),
    ]);
    assert.deepEqual(store.getReview(id).comments, []);
    restored = await store.switchCurrentContext(project.id, 'feature-a');
    assert.equal(restored.comments.length, 2);
    assert.equal(restored.comments[1].body, 'Saved before switch.');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid Current identities and inactive feedback schemas preserve the original saved file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const source = new ReviewStore(join(dir, 'source.json'));
    const project = await source.createProject({ repoPath: '/offline/validation-project' });
    await source.createReview({ projectId: project.id, featureBranch: 'saved-feature', baseBranch: 'main' });
    const valid = source.getState();
    const current = source.getReview(currentReviewId(project.id));
    const saved = valid.reviews.find(review => review.kind === 'saved')!;
    const changedCurrent = (changes: Record<string, unknown>) => ({ ...valid, reviews: [saved, { ...current, ...changes }] });
    const invalidStates = [
      changedCurrent({ id: 'wrong-current-id' }),
      changedCurrent({ name: 'Different name' }),
      changedCurrent({ includeWorkingTree: false }),
      changedCurrent({ currentContexts: { invalid: { comments: [], approvals: {} } } }),
      changedCurrent({ currentContexts: { [reviewContextKey(current)]: { comments: [], approvals: {} } } }),
      changedCurrent({ currentContexts: { '["feature","main"]': { comments: [{ body: 'Incomplete comment' }], approvals: {} } } }),
      changedCurrent({ currentContexts: { '["feature","main"]': { comments: [], approvals: [] } } }),
      { ...valid, reviews: [saved] },
      { ...valid, reviews: [saved, current, current] },
      { ...valid, reviews: [{ ...saved, kind: undefined }, current] },
      { ...valid, reviews: [{ ...saved, currentContexts: {} }, current] },
    ];
    for (const [index, invalid] of invalidStates.entries()) {
      const filePath = join(dir, `invalid-current-${index}.json`);
      const contents = JSON.stringify(invalid);
      await writeFile(filePath, contents);
      const store = new ReviewStore(filePath);
      await assert.rejects(() => store.load(), /invalid format/);
      assert.equal(await readFile(filePath, 'utf8'), contents);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('client comment UUID retries are idempotent and preserve newer saved edits after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const input = { ...currentComment, id: '147f6095-a9df-4f65-8133-c2f22206c4e5' };
    const results = await Promise.all([store.addComment(review.id, input), store.addComment(review.id, input)]);
    for (const result of results) {
      assert.equal(result.comments.length, 1);
      assert.equal(result.comments[0].id, input.id);
    }
    const originalCreatedAt = results[0].comments[0].createdAt;
    const updated = await store.updateComment(review.id, input.id, { body: 'The latest autosaved text.', resolved: true });
    const before = await stat(filePath);
    const retried = await store.addComment(review.id, { ...input, id: input.id.toUpperCase() });
    assert.deepEqual(retried, updated);
    assert.equal(retried.comments[0].createdAt, originalCreatedAt);
    assert.equal((await stat(filePath)).ino, before.ino, 'idempotent retries do not rewrite storage');
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    const afterRestart = await reopened.addComment(review.id, input);
    assert.equal(afterRestart.comments.length, 1);
    assert.equal(afterRestart.comments[0].body, 'The latest autosaved text.');
    assert.equal(afterRestart.comments[0].resolved, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a supplied comment UUID rejects a different code anchor and invalid IDs without changing saved feedback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const review = await store.createReview(config);
    const input = { ...currentComment, id: '147f6095-a9df-4f65-8133-c2f22206c4e5', lineStart: 2, lineEnd: 4 };
    const original = await store.addComment(review.id, input);
    const changedAnchors: Partial<NewComment>[] = [
      { fileId: 'other-file.ts' }, { repoRelativePath: 'another/module' }, { path: 'renamed-file.ts' },
      { fingerprint: 'another-version' }, { side: 'deletions' }, { lineStart: 3 }, { lineEnd: 5 }, { context: 'different selected code' },
    ];
    for (const changes of changedAnchors) await assert.rejects(() => store.addComment(review.id, { ...input, ...changes }), /different code/);
    for (const id of ['', 'not-a-uuid', '147f6095-a9df-4f65-0133-c2f22206c4e5', '147f6095-a9df-4f65-8133-c2f22206c4e5\0']) {
      await assert.rejects(() => store.addComment(review.id, { ...input, id }), /valid UUID/);
    }
    assert.deepEqual(store.getReview(review.id), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('idempotent retries retain Current context guards and comment IDs are scoped to their context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const project = await store.createProject({ repoPath: '/offline/idempotent-contexts' });
    const first = await store.switchCurrentContext(project.id, 'feature-a', 'main');
    const keyA = reviewContextKey(first);
    const input = { ...currentComment, id: '147f6095-a9df-4f65-8133-c2f22206c4e5' };
    await store.addComment(first.id, input, keyA);
    const second = await store.switchCurrentContext(project.id, 'feature-b');
    await assert.rejects(() => store.addComment(first.id, input, keyA), /context changed/);
    const added = await store.addComment(second.id, { ...input, body: 'Feedback for the other context.' }, reviewContextKey(second));
    assert.equal(added.comments[0].id, input.id);
    assert.equal(added.comments[0].body, 'Feedback for the other context.');
    const restored = await store.switchCurrentContext(project.id, 'feature-a');
    assert.equal(restored.comments.length, 1);
    assert.equal(restored.comments[0].body, input.body);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('batch approval validates the complete selection before one durable state change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const files = [{ fileId: 'src/first.ts', fingerprint: 'first-version' }, { fileId: 'packages/api/second.ts', fingerprint: 'second-version' }];
    const before = await readFile(filePath, 'utf8');
    await assert.rejects(() => store.setApprovals(review.id, [files[0], { fileId: files[1].fileId, fingerprint: '' }], true), /File version/);
    await assert.rejects(() => store.setApprovals(review.id, [files[0], { ...files[0], fingerprint: 'conflicting-version' }], true), /conflicting versions/);
    await assert.rejects(() => store.setApprovals(review.id, files, 'true' as unknown as boolean), /whether/);
    await assert.rejects(() => store.setApprovals(review.id, [], true), /at least one/);
    assert.deepEqual(store.getReview(review.id).approvals, {});
    assert.equal(await readFile(filePath, 'utf8'), before, 'invalid batches must not write a partially approved selection');
    const approved = await store.setApprovals(review.id, [...files, files[0]], true);
    assert.deepEqual(approved.approvals, Object.fromEntries(files.map(file => [file.fileId, file.fingerprint])));
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getReview(review.id).approvals, approved.approvals);
    const unchanged = await stat(filePath);
    await reopened.setApprovals(review.id, files, true);
    assert.equal((await stat(filePath)).ino, unchanged.ino, 'an already approved batch does not rewrite storage');
    const unapproved = await reopened.setApprovals(review.id, [...files, { fileId: 'no-longer-in-diff.ts', fingerprint: 'previous-version' }], false);
    assert.deepEqual(unapproved.approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a queued batch cannot apply any approval after its Current context switches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const project = await store.createProject({ repoPath: '/offline/batch-context' });
    const current = await store.switchCurrentContext(project.id, 'feature-a', 'main');
    const switching = store.switchCurrentContext(project.id, 'feature-b');
    const approving = store.setApprovals(current.id, [
      { fileId: 'first.ts', fingerprint: 'first-version' }, { fileId: 'second.ts', fingerprint: 'second-version' },
    ], true, reviewContextKey(current));
    await assert.rejects(approving, /context changed/);
    await switching;
    assert.deepEqual(store.getReview(current.id).approvals, {});
    assert.deepEqual((await store.switchCurrentContext(project.id, 'feature-a')).approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed batch disk write leaves every selected approval unchanged in memory and on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const before = await readFile(filePath, 'utf8');
    // A directory at the temporary-write path makes persistence fail safely.
    await mkdir(`${filePath}.tmp`);
    await assert.rejects(() => store.setApprovals(review.id, [
      { fileId: 'first.ts', fingerprint: 'first-version' }, { fileId: 'second.ts', fingerprint: 'second-version' },
    ], true));
    assert.deepEqual(store.getReview(review.id).approvals, {});
    assert.equal(await readFile(filePath, 'utf8'), before);
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    assert.deepEqual(reopened.getReview(review.id).approvals, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('surrounding comment context persists unchanged and remains part of its retry anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-store-'));
  try {
    const filePath = join(dir, 'reviews.json');
    const store = new ReviewStore(filePath);
    const review = await store.createReview(config);
    const input = { ...currentComment, id: '147f6095-a9df-4f65-8133-c2f22206c4e5', contextBefore: 'before one\nbefore two\nbefore three', contextAfter: 'after one\nafter two' };
    const created = await store.addComment(review.id, input);
    await store.updateComment(review.id, input.id, { body: 'Updated body.' });
    const reopened = new ReviewStore(filePath);
    await reopened.load();
    const retried = await reopened.addComment(review.id, input);
    assert.equal(retried.comments[0].contextBefore, input.contextBefore);
    assert.equal(retried.comments[0].contextAfter, input.contextAfter);
    assert.equal(retried.comments[0].context, created.comments[0].context);
    assert.equal(retried.comments[0].body, 'Updated body.');
    await assert.rejects(() => reopened.addComment(review.id, { ...input, contextBefore: 'Different surroundings' }), /different code/);
    await assert.rejects(() => reopened.addComment(review.id, { ...currentComment, contextAfter: 123 as unknown as string }), /must be text/);
    assert.equal(formatFeedback(retried), `${sampleFile.repoRelativePath}/${sampleFile.path}:1\nUpdated body.`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
