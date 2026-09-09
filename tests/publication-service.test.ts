import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlinePayload, PullRequest, RemoteComment } from '../shared/integrations';
import type { ReviewFile, ReviewSnapshot } from '../shared/types';
import type { BitbucketClient } from '../electron/bitbucket-client';
import { PublicationService, inlinePayload } from '../electron/publication-service';
import { ReviewStore } from '../electron/store';
import { IntegrationStore } from '../electron/integration-store';

const hash = (value: string) => value.repeat(40);
const basePR: PullRequest = { id: 7, repository: { relativePath: '.', workspace: 'team', repoSlug: 'app' }, title: 'Feature', url: 'https://bitbucket.org/team/app/pull-requests/7', sourceBranch: 'APP-123-feature', targetBranch: 'main', sourceHash: hash('a'), targetHash: hash('b'), author: { id: 'author', name: 'Author' }, reviewers: [], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'] };
const baseFile: ReviewFile = { id: 'new.ts', repoRelativePath: '.', path: 'new.ts', oldPath: 'old.ts', remotePath: 'new.ts', status: 'R', additions: 2, deletions: 1, oldContent: 'old\nline\n', newContent: 'new\nline\nlast\n', binary: false, fingerprint: 'version1', baseCommit: hash('c'), headCommit: hash('a'), source: 'committed' };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'branchline-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reviews = new ReviewStore(join(directory, 'reviews.json')); await reviews.load();
  const project = await reviews.createProject({ name: 'Project', repoPath: '/fixture' });
  const review = await reviews.createReview({ projectId: project.id, featureBranch: basePR.sourceBranch, baseBranch: 'main' }, true);
  const state = new IntegrationStore(join(directory, 'integrations.json')); await state.load();
  await state.setReview(review.id, { connectionId: 'bb', pullRequests: [structuredClone(basePR)], publications: {} });
  const live = { pr: structuredClone(basePR), file: structuredClone(baseFile), comments: [] as RemoteComment[], sent: [] as InlinePayload[], changes: [] as string[], nextId: 1,
    fail: undefined as undefined | ((kind: string) => void), account: 'reviewer' };
  const client = {
    async getPullRequest() { return structuredClone(live.pr); },
    async listComments() { return structuredClone(live.comments); },
    async createComment(_pr: PullRequest, payload: InlinePayload) {
      live.sent.push(structuredClone(payload)); live.fail?.('beforeCreate');
      const comment: RemoteComment = { id: live.nextId++, authorId: live.account, body: payload.content.raw, resolved: false, deleted: false,
        path: payload.inline.path, from: payload.inline.from, to: payload.inline.to, startFrom: payload.inline.start_from, startTo: payload.inline.start_to, createdAt: new Date().toISOString() };
      live.comments.push(comment); live.fail?.('afterCreate'); return structuredClone(comment);
    },
    async updateComment(_pr: PullRequest, id: number, body: string) { live.changes.push('update'); live.fail?.('update'); const c = live.comments.find(c => c.id === id)!; c.body = body; return structuredClone(c); },
    async resolveComment(_pr: PullRequest, id: number, resolved: boolean) { live.changes.push(resolved ? 'resolve' : 'reopen'); live.comments.find(c => c.id === id)!.resolved = resolved; },
    async deleteComment(_pr: PullRequest, id: number) { live.changes.push('delete'); live.comments.find(c => c.id === id)!.deleted = true; },
  } as unknown as BitbucketClient;
  const snapshot = (): ReviewSnapshot => ({ reviewId: review.id, files: [live.file], repos: [{ relativePath: '.', currentBranch: null, workingTreeIncluded: false }], warnings: [], fingerprint: 'snapshot', refreshedAt: new Date().toISOString() });
  const make = (storage = state) => new PublicationService(reviews, storage, () => client, snapshot, () => live.account);
  const service = make();
  const add = async (changes: Partial<{ body: string; side: 'additions' | 'deletions'; lineStart: number; lineEnd: number; fingerprint: string }> = {}) => {
    const result = await reviews.addComment(review.id, { fileId: live.file.id, repoRelativePath: '.', path: live.file.path, side: 'additions', lineStart: 1, lineEnd: 2, fingerprint: live.file.fingerprint, context: 'new\nline', body: 'Please check this', ...changes });
    await service.capture(review.id); return result.comments.at(-1)!;
  };
  return { directory, reviews, state, review, live, service, add, make };
}

test('publishes exact new/old ranges and file anchors, including canonical rename path', async t => {
  const f = await fixture(t);
  await f.add();
  await f.add({ side: 'deletions', lineStart: 1, lineEnd: 1, body: 'Old-side note' });
  await f.add({ lineStart: 0, lineEnd: 0, body: 'File note' });
  await f.service.publish(f.review.id);
  assert.deepEqual(f.live.sent.map(p => p.inline), [{ path: 'new.ts', to: 2, start_to: 1 }, { path: 'new.ts', from: 1 }, { path: 'new.ts' }]);
  assert.ok(Object.values(f.state.review(f.review.id)!.publications).every(p => p.state === 'synced'));
  await f.service.publish(f.review.id);
  assert.equal(f.live.sent.length, 3, 'repeated publish must not repost acknowledged comments');
});

test('inline payload never mixes old and new sides', () => {
  assert.deepEqual(inlinePayload({ prKey: '.#7', sourceHash: 'a', targetHash: 'b', path: 'deleted.ts', side: 'deletions', lineStart: 2, lineEnd: 4, fingerprint: 'v' }, 'note').inline, { path: 'deleted.ts', from: 4, start_from: 2 });
});

test('stale drafts require an explicit fresh selection; display context cannot relocate outgoing lines', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.live.pr.sourceHash = hash('d'); f.live.file.fingerprint = 'version2';
  await f.state.updateReview(f.review.id, r => { r.pullRequests[0] = structuredClone(f.live.pr); });
  await assert.rejects(f.service.publish(f.review.id), /changed/);
  assert.equal(f.live.sent.length, 0);
  await f.service.reanchor(f.review.id, comment.id, { fileId: f.live.file.id, fingerprint: 'version2', side: 'additions', lineStart: 3, lineEnd: 3 });
  await f.service.publish(f.review.id);
  assert.deepEqual(f.live.sent[0].inline, { path: 'new.ts', to: 3 });
  await assert.rejects(f.service.reanchor(f.review.id, comment.id, { fileId: 'new.ts', fingerprint: 'version2', side: 'additions', lineStart: 1, lineEnd: 1 }), /original anchor/);
});

test('a push between preview and sending keeps drafts and sends no stale comment', async t => {
  const f = await fixture(t); await f.add(); f.live.pr.sourceHash = hash('d');
  const result = await f.service.publish(f.review.id);
  assert.equal(f.live.sent.length, 0);
  assert.match(Object.values(result.publications)[0].error!, /changed/);
});

test('edits, resolutions and deletion update the same owned comment', async t => {
  const f = await fixture(t); const comment = await f.add(); await f.service.publish(f.review.id);
  await f.reviews.updateComment(f.review.id, comment.id, { body: 'Edited note', resolved: true });
  const pending = await f.service.preview(f.review.id);
  assert.equal(pending.items[0].state, 'draft', 'A pending published edit remains actionable in the preview.');
  assert.equal(pending.items[0].action, 'update');
  await f.service.publish(f.review.id);
  assert.deepEqual(f.live.changes, ['update', 'resolve']);
  await f.reviews.updateComment(f.review.id, comment.id, { resolved: false }); await f.service.publish(f.review.id);
  await f.reviews.deleteComment(f.review.id, comment.id); await f.service.publish(f.review.id);
  assert.deepEqual(f.live.changes, ['update', 'resolve', 'reopen', 'delete']);
  assert.equal(f.live.sent.length, 1);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].acknowledged?.deleted, true);
});

test('accepted POST followed by timeout reconciles once without reposting', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.live.fail = kind => { if (kind === 'afterCreate') throw new Error('connection interrupted'); };
  await f.service.publish(f.review.id);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].state, 'unknown');
  f.live.fail = undefined;
  const restarted = new IntegrationStore(join(f.directory, 'integrations.json')); await restarted.load();
  await f.make(restarted).publish(f.review.id);
  assert.equal(f.live.sent.length, 1);
  assert.equal(restarted.review(f.review.id)!.publications[comment.id].state, 'synced');
});

test('ambiguous delivery cannot blindly retry even if no matching remote comment is found', async t => {
  const f = await fixture(t); await f.add();
  f.live.fail = kind => { if (kind === 'beforeCreate') throw new Error('timeout'); };
  await f.service.publish(f.review.id); f.live.fail = undefined;
  await assert.rejects(f.service.publish(f.review.id), /timeout|unknown/);
  assert.equal(f.live.sent.length, 1);
});

test('known permission rejection can retry after its cause is corrected', async t => {
  const f = await fixture(t); await f.add();
  f.live.fail = kind => { if (kind === 'beforeCreate') throw Object.assign(new Error('permission denied'), { status: 403 }); };
  await f.service.publish(f.review.id); f.live.fail = undefined;
  const rejected = await f.service.preview(f.review.id);
  assert.equal(rejected.items[0].error, 'permission denied');
  assert.deepEqual(rejected.blockers, [], 'Known failures remain visible without preventing an explicit retry.');
  await f.service.publish(f.review.id);
  assert.equal(f.live.comments.length, 1);
  assert.equal(f.live.sent.length, 2);
});

test('remote edits are adopted only without pending local changes; conflicts preserve both', async t => {
  const f = await fixture(t); const comment = await f.add(); await f.service.publish(f.review.id);
  f.live.comments[0].body = 'Changed in Bitbucket'; await f.service.reconcile(f.review.id);
  assert.equal(f.reviews.getReview(f.review.id).comments[0].body, 'Changed in Bitbucket');
  await f.reviews.updateComment(f.review.id, comment.id, { body: 'Local edit' }); f.live.comments[0].body = 'Remote edit';
  const preview = await f.service.preview(f.review.id);
  assert.equal(preview.items[0].state, 'conflict');
  await assert.rejects(f.service.publish(f.review.id), /changed in Bitbucket/);
  await f.service.resolveConflict(f.review.id, comment.id, 'local'); await f.service.publish(f.review.id);
  assert.equal(f.live.comments[0].body, 'Local edit');
});

test('accepting a remote edit after a queued local deletion restores the local linked comment', async t => {
  const f = await fixture(t); const comment = await f.add(); await f.service.publish(f.review.id);
  await f.reviews.deleteComment(f.review.id, comment.id); f.live.comments[0].body = 'Remote edit';
  await f.service.preview(f.review.id); await f.service.resolveConflict(f.review.id, comment.id, 'remote');
  assert.equal(f.reviews.getReview(f.review.id).comments[0].body, 'Remote edit');
  assert.equal((await f.service.preview(f.review.id)).items.length, 0);
});

test('foreign-account comment mutation is blocked and resolved unpublished notes stay local', async t => {
  const f = await fixture(t); const a = await f.add(); await f.service.publish(f.review.id);
  f.live.account = 'different-user'; await f.reviews.updateComment(f.review.id, a.id, { body: 'Edited' });
  await assert.rejects(f.service.publish(f.review.id), /another Bitbucket account/);
  assert.deepEqual(f.live.changes, []);
  f.live.account = 'reviewer'; const b = await f.add({ body: 'Local resolved note' }); await f.reviews.updateComment(f.review.id, b.id, { resolved: true });
  assert.equal((await f.service.preview(f.review.id)).items.some(i => i.commentId === b.id), false);
});

test('integration restart turns persisted sending operations into delivery unknown', async t => {
  const f = await fixture(t); const comment = await f.add();
  await f.state.updateReview(f.review.id, r => { r.publications[comment.id].state = 'sending'; });
  const fresh = new IntegrationStore(join(f.directory, 'integrations.json')); await fresh.load();
  assert.equal(fresh.review(f.review.id)!.publications[comment.id].state, 'unknown');
});

test('explicit not-delivered reconciliation enables retry only when no matching comment exists', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.live.fail = kind => { if (kind === 'beforeCreate') throw new Error('timeout'); };
  await f.service.publish(f.review.id); f.live.fail = undefined;
  await f.service.resolveUnknown(f.review.id, comment.id, null);
  await f.service.publish(f.review.id);
  assert.equal(f.live.comments.length, 1);
  assert.equal(f.live.sent.length, 2);
});

test('duplicate-looking uncertain deliveries require selecting a verified owned remote ID', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.live.fail = kind => {
    if (kind === 'afterCreate') {
      f.live.comments.push({ ...f.live.comments[0], id: f.live.nextId++ });
      throw new Error('timeout');
    }
  };
  await f.service.publish(f.review.id); f.live.fail = undefined;
  await assert.rejects(f.service.resolveUnknown(f.review.id, comment.id, null), /Matching comments exist/);
  await assert.rejects(f.service.resolveUnknown(f.review.id, comment.id, 999), /does not match/);
  await f.service.resolveUnknown(f.review.id, comment.id, 2);
  await f.service.publish(f.review.id);
  assert.equal(f.live.sent.length, 1);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].remoteId, 2);
});

test('new drafts entered after partial publication preserve acknowledged results', async t => {
  const f = await fixture(t); await f.add({ body: 'First' }); await f.add({ body: 'Second' });
  f.live.fail = kind => { if (kind === 'beforeCreate' && f.live.sent.length === 2) throw Object.assign(new Error('rate limited'), { status: 429 }); };
  await f.service.publish(f.review.id); f.live.fail = undefined;
  await f.add({ body: 'Third' }); await f.service.publish(f.review.id);
  assert.deepEqual(f.live.comments.map(c => c.body), ['First', 'Second', 'Third']);
  assert.equal(f.live.sent.filter(c => c.content.raw === 'First').length, 1);
});

test('sending state in a still-running process is reconciled before another POST', async t => {
  const f = await fixture(t); const comment = await f.add();
  const anchor = f.state.review(f.review.id)!.publications[comment.id].anchor;
  const payload = inlinePayload(anchor, comment.body);
  f.live.comments.push({ id: 100, authorId: 'reviewer', body: comment.body, resolved: false, deleted: false, path: payload.inline.path, to: payload.inline.to, startTo: payload.inline.start_to, createdAt: new Date().toISOString() });
  await f.state.updateReview(f.review.id, r => Object.assign(r.publications[comment.id], { state: 'sending', action: 'create', intended: { body: comment.body, resolved: false, deleted: false }, startedAt: new Date().toISOString(), baselineIds: [] }));
  await f.service.publish(f.review.id);
  assert.equal(f.live.sent.length, 0);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].remoteId, 100);
});

test('a push after successful delivery clears the failed marker when remote intent is confirmed', async t => {
  const f = await fixture(t); const comment = await f.add();
  f.live.fail = kind => { if (kind === 'afterCreate') f.live.pr.sourceHash = hash('d'); };
  await f.service.publish(f.review.id);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].state, 'failed');
  f.live.fail = undefined;
  await f.state.updateReview(f.review.id, r => { r.pullRequests[0] = structuredClone(f.live.pr); });
  assert.equal((await f.service.preview(f.review.id)).items.length, 0);
  assert.equal(f.state.review(f.review.id)!.publications[comment.id].state, 'synced');
  await f.service.publish(f.review.id);
  assert.equal(f.live.sent.length, 1);
});
