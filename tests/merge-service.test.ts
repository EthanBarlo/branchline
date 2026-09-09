import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MergeService, type MergePollingOptions } from '../electron/merge-service';
import { IntegrationStore } from '../electron/integration-store';
import type { BitbucketClient } from '../electron/bitbucket-client';
import type { ConnectionManager } from '../electron/connection-manager';
import type { PointerPrepareInput, PointerService } from '../electron/pointer-service';
import type { ReviewStore } from '../electron/store';
import type { MergeProgress, PullRequest, RemoteReviewChanged, RepositoryMapping } from '../shared/integrations';
import { pullRequestKey } from '../shared/integrations';
import type { ReviewSnapshot } from '../shared/types';

const fixtures: string[] = [];
after(async () => { await Promise.all(fixtures.map(dir => rm(dir, { recursive: true, force: true }))); });
const hash = (id: number): string => id.toString(16).padStart(40, '0');
const providerError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

function pr(id: number, relativePath = '.', parentRelativePath?: string, submodulePath?: string): PullRequest {
  return {
    id, repository: { workspace: 'example', repoSlug: `repo-${id}`, relativePath, parentRelativePath, submodulePath },
    title: `Change ${id}`, url: `https://bitbucket.org/example/repo-${id}/pull-requests/${id}`,
    sourceBranch: 'feature/TEST-12', targetBranch: 'main', sourceHash: hash(id), targetHash: hash(id + 100),
    author: { id: 'author', name: 'Author' }, reviewers: [], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'],
  };
}

async function fixture(prs = [pr(1), pr(2, 'packages/child', '.', 'packages/child')], updatePointers = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchline-merge-'));
  fixtures.push(root);
  const statePath = path.join(root, 'integrations.json');
  let state = new IntegrationStore(statePath);
  await state.setProject('project', { repositories: prs.map(p => p.repository), bitbucketConnectionId: 'connection', updateSubmodulePointers: updatePointers });
  await state.setReview('review', { connectionId: 'connection', pullRequests: prs, publications: {} });
  const live = new Map(prs.map(p => [pullRequestKey(p), structuredClone(p)]));
  const calls: string[] = [];
  const reads = new Map<string, number>();
  const pointerEntries = new Map(prs.map(parent => [parent.repository.relativePath, prs.filter(child => child.repository.parentRelativePath === parent.repository.relativePath).map(child => ({ path: child.repository.submodulePath!, hash: hash(child.id + 500) }))]));
  const prepared: PointerPrepareInput[] = [];
  const pushes: Array<PointerPrepareInput & { commit: string }> = [];
  const hooks: {
    get?: (value: PullRequest, count: number) => void;
    approve?: (value: PullRequest) => Promise<void>;
    merge?: (value: PullRequest) => Promise<{ pr?: PullRequest; taskId?: string }>;
    status?: (value: PullRequest, taskId: string) => Promise<{ state: 'pending' | 'success' | 'failed'; error?: string }>;
    write?: (mapping: RepositoryMapping) => Promise<void>;
    identity?: () => Promise<{ name: string; email: string }>;
    push?: (input: PointerPrepareInput & { commit: string }, apply: () => void) => Promise<void>;
    retained?: (value: PullRequest) => boolean | Promise<boolean>;
  } = {};
  const current = (value: Pick<PullRequest, 'repository' | 'id'>): PullRequest => live.get(pullRequestKey(value))!;
  const markMerged = (value: PullRequest): PullRequest => {
    const latest = current(value);
    Object.assign(latest, { state: 'MERGED', mergeCommit: hash(value.id + 1000) });
    return structuredClone(latest);
  };
  const client = {
    async getPullRequest(mapping: RepositoryMapping, id: number) {
      const value = current({ repository: mapping, id });
      const key = pullRequestKey(value);
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      hooks.get?.(value, count);
      return structuredClone(value);
    },
    async approve(value: PullRequest) {
      calls.push(`approve:${value.id}`);
      await hooks.approve?.(value);
      current(value).participants = [{ id: 'me', approved: true }];
    },
    async merge(value: PullRequest) {
      calls.push(`merge:${value.id}`);
      return hooks.merge ? hooks.merge(value) : { pr: markMerged(value) };
    },
    async mergeStatus(value: PullRequest, taskId: string) {
      calls.push(`status:${value.id}:${taskId}`);
      return hooks.status ? hooks.status(value, taskId) : { state: 'pending' as const };
    },
    async branchExists(value: PullRequest) { return hooks.retained?.(value) ?? false; },
    async checkWriteAccess(mapping: RepositoryMapping) { await hooks.write?.(mapping); },
    async pointerEntries(value: PullRequest) { return structuredClone(pointerEntries.get(value.repository.relativePath) ?? []); },
  } as unknown as BitbucketClient;
  const pointers = {
    async preflight() { return hooks.identity ? hooks.identity() : { name: 'Reviewer', email: 'reviewer@example.com' }; },
    async prepare(input: PointerPrepareInput) {
      prepared.push(structuredClone(input));
      const parent = prs.find(value => value.repository.relativePath === input.repository.relativePath)!;
      return { commit: hash(parent.id + 2000), base: input.expectedHead };
    },
    async push(input: PointerPrepareInput & { commit: string }) {
      pushes.push(structuredClone(input));
      const apply = () => {
        const parent = [...live.values()].find(value => value.repository.relativePath === input.repository.relativePath)!;
        parent.sourceHash = input.commit;
        parent.participants = [];
        const entries = pointerEntries.get(input.repository.relativePath)!;
        for (const [file, result] of Object.entries(input.updates)) entries.find(entry => entry.path === file)!.hash = result;
      };
      if (hooks.push) await hooks.push(input, apply); else apply();
    },
  } as unknown as PointerService;
  const reviews = {
    getProject: () => ({ id: 'project', repoPath: '/unchanged/local/checkout' }),
    getReview: () => ({ id: 'review', projectId: 'project', comments: [] }),
  } as unknown as ReviewStore;
  const connections = { credentials: () => ({ email: 'account@example.com', token: 'fake-token', info: { accountId: 'me' } }) } as unknown as ConnectionManager;
  let snapshot: ReviewSnapshot | undefined = { reviewId: 'review', files: [], repos: [], fingerprint: 'snapshot', refreshedAt: new Date().toISOString(), warnings: [] };
  const polling: MergePollingOptions = { maxAttempts: 2, intervalMs: 0, wait: async () => undefined };
  const build = () => new MergeService(reviews, state, connections, () => client, () => snapshot, pointers, polling);
  let service = build();
  return {
    prs, live, hooks, calls, reads, prepared, pushes, pointerEntries, current, markMerged, statePath, polling,
    get service() { return service; }, get state() { return state; },
    item(id: number): MergeProgress { return state.review('review')!.operation!.items.find(item => item.prKey === pullRequestKey(prs.find(value => value.id === id)!))!; },
    setSnapshot(value: ReviewSnapshot | undefined) { snapshot = value; },
    async refresh() { await state.updateReview('review', value => { value.pullRequests = value.pullRequests.map(p => structuredClone(current(p))); }); },
    async reload() { state = new IntegrationStore(statePath); await state.load(); service = build(); },
  };
}

test('approves and standard-merges deepest children first and records cleanup including retained branches', async () => {
  const f = await fixture([pr(1), pr(2, 'packages/child', '.', 'packages/child'), pr(3, 'packages/child/nested', 'packages/child', 'nested')]);
  f.hooks.retained = value => value.id === 2;
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:3', 'merge:3', 'approve:2', 'merge:2', 'approve:1', 'merge:1']);
  assert.equal(f.item(3).cleanup, 'deleted');
  assert.equal(f.item(2).cleanup, 'retained');
  assert.equal(f.item(1).mergeCommit, hash(1001));
  assert.equal(f.prepared.length, 0, 'pointer maintenance defaults off');
});

test('approve alone does not merge, and does not repeat existing account approvals', async () => {
  const f = await fixture();
  f.current(f.prs[0]).participants = [{ id: 'me', approved: true }];
  const result = await f.service.run('review', 'approve');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:2']);
  assert.equal(f.item(1).merge, 'pending');
  assert.equal(f.item(2).approval, 'approved');
});

test('committed live progress shows approval, merging and confirmed merge before branch cleanup', async () => {
  const f = await fixture([pr(1)]);
  const events: Array<{ event: RemoteReviewChanged; disk: unknown }> = [];
  f.state.onReviewChanged(event => {
    events.push({ event, disk: JSON.parse(readFileSync(f.statePath, 'utf8')).reviews.review });
  });
  f.hooks.approve = async () => { assert.equal(f.item(1).phase, 'approving'); };
  f.hooks.merge = async value => {
    assert.equal(f.item(1).phase, 'merging');
    assert.equal(f.item(1).merge, 'sending');
    return { pr: f.markMerged(value) };
  };
  f.hooks.retained = async () => {
    assert.equal(f.item(1).merge, 'merged', 'merge success must be durable while branch lookup is in flight');
    assert.equal(f.item(1).phase, 'cleanup');
    assert.equal(f.item(1).cleanup, undefined);
    return false;
  };
  const result = await f.service.run('review', 'merge');
  assert.deepEqual(events.filter(({ event }) => event.state.operation?.items[0].phase)
    .map(({ event }) => event.state.operation!.items[0].phase), ['checking', 'approving', 'checking', 'merging', 'cleanup']);
  for (const { event, disk } of events) {
    assert.equal(event.reviewId, 'review');
    assert.deepEqual(JSON.parse(JSON.stringify(event.state)), disk, 'listeners only receive the successfully renamed snapshot');
  }
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.item(1).phase, undefined);
  assert.equal(f.item(1).cleanup, 'deleted');
  assert.notEqual(f.item(1).skipped, true);
});

test('review subscriptions isolate listener failures and mutations, unsubscribe, and omit failed writes', async () => {
  const f = await fixture([pr(1)]);
  f.state.onReviewChanged(event => { event.state.pullRequests = []; throw new Error('Renderer disappeared'); });
  const seen: RemoteReviewChanged[] = [];
  const stop = f.state.onReviewChanged(event => { seen.push(event); });
  await f.state.updateReview('review', value => { value.ticketKey = 'APP-12'; });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state.pullRequests.length, 1);
  assert.equal(f.state.review('review')?.pullRequests.length, 1);
  stop();
  await f.state.updateReview('review', value => { value.ticketKey = 'APP-13'; });
  assert.equal(seen.length, 1);
  f.state.onReviewChanged(event => { seen.push(event); });
  await mkdir(`${f.statePath}.tmp`);
  await assert.rejects(f.state.updateReview('review', value => { value.ticketKey = 'APP-14'; }));
  assert.equal(seen.length, 1);
  assert.equal(f.state.review('review')?.ticketKey, 'APP-13');
});

test('already merged repositories are skipped with deleted, retained or unknown source branch results', async () => {
  const f = await fixture([pr(1), pr(2, 'child', '.', 'child'), pr(3, 'other', '.', 'other')]);
  for (const value of f.prs) f.markMerged(value);
  f.hooks.retained = async value => { if (value.id === 3) throw new Error('Cleanup lookup unavailable'); return value.id === 2; };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, [], 'completed PRs must never be approved or merged again');
  assert.equal(f.item(1).cleanup, 'deleted');
  assert.equal(f.item(2).cleanup, 'retained');
  assert.equal(f.item(3).cleanup, 'unknown');
  assert.ok(result.operation!.items.every(item => item.skipped && item.merge === 'merged' && !item.phase));
});

test('restart preserves a confirmed merge, clears transient phases and resumes missing cleanup safely', async () => {
  const f = await fixture([pr(1)]);
  f.markMerged(f.prs[0]);
  await f.state.updateReview('review', value => {
    value.operation = { action: 'merge', state: 'running', updatedAt: new Date().toISOString(), items: [{
      prKey: pullRequestKey(f.prs[0]), approval: 'approved', merge: 'merged', phase: 'cleanup',
      sourceHash: f.prs[0].sourceHash, targetHash: f.prs[0].targetHash, mergeCommit: hash(1001),
    }] };
  });
  await f.reload();
  assert.equal(f.state.review('review')?.operation?.state, 'paused');
  assert.equal(f.item(1).merge, 'merged');
  assert.equal(f.item(1).phase, undefined);
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.item(1).cleanup, 'deleted');
  assert.notEqual(f.item(1).skipped, true);
  assert.deepEqual(f.calls, []);
});

test('a failed cleanup acknowledgement never downgrades an already persisted successful merge', async () => {
  const f = await fixture([pr(1)]);
  const updateReview = f.state.updateReview.bind(f.state);
  let failed = false;
  f.state.updateReview = (id, update) => {
    const candidate = f.state.review(id)!;
    update(candidate);
    if (!failed && candidate.operation?.items[0].cleanup === 'deleted') {
      failed = true;
      return Promise.reject(new Error('Cleanup status could not be saved'));
    }
    return updateReview(id, update);
  };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.equal(f.item(1).merge, 'merged');
  assert.equal(f.item(1).mergeCommit, hash(1001));
  assert.equal(f.item(1).cleanup, undefined);
  await f.reload();
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.item(1).cleanup, 'deleted');
  assert.deepEqual(f.calls, ['approve:1', 'merge:1']);
});

test('legacy operations accept absent visual fields while invalid phases and skip metadata are rejected', async () => {
  const f = await fixture([pr(1)]);
  await f.state.updateReview('review', value => {
    value.operation = { action: 'merge', state: 'paused', updatedAt: new Date().toISOString(), items: [{
      prKey: pullRequestKey(f.prs[0]), approval: 'pending', merge: 'pending',
      sourceHash: f.prs[0].sourceHash, targetHash: f.prs[0].targetHash,
    }] };
  });
  await f.reload();
  assert.equal(f.item(1).phase, undefined);
  assert.equal(f.item(1).skipped, undefined);
  for (const bad of [{ phase: 'done' }, { skipped: 'yes' }, { skipped: true }]) {
    await assert.rejects(f.state.updateReview('review', value => Object.assign(value.operation!.items[0], bad)), /invalid/);
  }
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
});

test('pointer maintenance blocks manual child mappings without a known parent before merging', async () => {
  const f = await fixture([pr(1), pr(2, 'packages/child')], true);
  await assert.rejects(f.service.run('review', 'merge'), /parent repository and submodule path/);
  assert.deepEqual(f.calls, []);
});

test('pointer maintenance cannot silently change a saved review hierarchy through project settings', async () => {
  const f = await fixture(undefined, true);
  await f.state.setProject('project', { repositories: [f.prs[0].repository, { ...f.prs[1].repository, parentRelativePath: 'packages', submodulePath: 'child' }], bitbucketConnectionId: 'connection', updateSubmodulePointers: true });
  await assert.rejects(f.service.run('review', 'merge'), /parent mapping.*changed/);
  assert.deepEqual(f.calls, []);
});

test('blocks prohibited merge strategies, drafts and unavailable snapshots before mutations', async () => {
  const f = await fixture();
  f.current(f.prs[0]).mergeStrategies = ['squash'];
  await assert.rejects(f.service.run('review', 'merge'), /does not permit standard merge commits/);
  assert.deepEqual(f.calls, []);
  f.current(f.prs[0]).mergeStrategies = ['merge_commit'];
  f.current(f.prs[0]).draft = true;
  await assert.rejects(f.service.run('review', 'merge'), /draft/);
  f.current(f.prs[0]).draft = false;
  f.setSnapshot(undefined);
  await assert.rejects(f.service.run('review', 'merge'), /Open and refresh/);
  assert.deepEqual(f.calls, []);
});

test('surfaces permission failures and stops before merging that PR or any parent', async () => {
  const f = await fixture();
  f.hooks.approve = async () => { throw providerError(403, 'Missing pull request write permission'); };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.match(result.operation?.error ?? '', /permission/);
  assert.deepEqual(f.calls, ['approve:2']);
  assert.equal(f.item(2).approval, 'failed');
  assert.equal(f.item(2).phase, undefined);
});

test('detects revisions changed before approval or between approval and merge', async () => {
  const f = await fixture([pr(1)]);
  f.hooks.get = (value, count) => { if (count === 2) value.sourceHash = hash(9000); };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.deepEqual(f.calls, []);
  await f.refresh();
  f.hooks.get = undefined;
  f.hooks.approve = async value => { f.current(value).targetHash = hash(9001); };
  const result = await f.service.run('review', 'merge');
  assert.match(result.operation?.error ?? '', /changed after approval/);
  assert.deepEqual(f.calls, ['approve:1']);
  assert.equal(f.item(1).sourceHash, hash(9000), 'the saved attempt records the explicitly refreshed revision');
});

test('resumes known partial failures without reapproving or remerging completed children', async () => {
  const f = await fixture();
  let failParent = true;
  f.hooks.merge = async value => {
    if (value.id === 1 && failParent) throw providerError(409, 'Merge conflict');
    return { pr: f.markMerged(value) };
  };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.equal(f.item(2).merge, 'merged');
  assert.equal(f.item(1).merge, 'failed');
  failParent = false;
  await f.reload();
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:2', 'merge:2', 'approve:1', 'merge:1', 'merge:1']);
  assert.notEqual(f.item(2).skipped, true, 'a merge completed by this operation is not relabeled as externally skipped');
});

test('unknown merge delivery never blindly retries, even after a refreshed source revision', async () => {
  const f = await fixture([pr(1)]);
  f.hooks.merge = async () => { throw new Error('Connection timed out after sending'); };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.equal(f.item(1).merge, 'unknown');
  const previous = f.item(1).sourceHash;
  f.current(f.prs[0]).sourceHash = hash(8000);
  await f.refresh();
  await f.reload();
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.equal(f.item(1).sourceHash, previous, 'uncertain old requests retain their original expected revision');
  assert.equal(f.calls.filter(call => call.startsWith('merge:')).length, 1);
  f.markMerged(f.prs[0]);
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.calls.filter(call => call.startsWith('merge:')).length, 1);
});

test('an interrupted sending state is uncertain in memory and after storage reload', async () => {
  for (const reload of [false, true]) {
    const f = await fixture([pr(1)]);
    await f.state.updateReview('review', value => { value.operation = { action: 'merge', state: 'running', updatedAt: new Date().toISOString(), items: [{ prKey: pullRequestKey(f.prs[0]), approval: 'approved', merge: 'sending', sourceHash: f.prs[0].sourceHash, targetHash: f.prs[0].targetHash }] }; });
    if (reload) await f.reload();
    assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
    assert.equal(f.item(1).merge, 'unknown');
    assert.deepEqual(f.calls, []);
  }
});

test('reconciles asynchronous merges through authoritative PR state before merging parents', async () => {
  const f = await fixture();
  f.hooks.merge = async value => value.id === 2 ? { taskId: 'task-2' } : { pr: f.markMerged(value) };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
  assert.equal(f.item(2).merge, 'merging');
  await f.service.run('review', 'merge');
  assert.equal(f.calls.filter(call => call === 'merge:2').length, 1);
  assert.ok(f.calls.includes('status:2:task-2'));
  f.markMerged(f.prs[1]);
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.item(2).mergeCommit, hash(1002));
  assert.equal(f.calls.filter(call => call === 'merge:2').length, 1);
});

test('an accepted asynchronous merge stays live and finishes children and parents in one action', async () => {
  const f = await fixture();
  let observations = 0;
  f.hooks.merge = async value => value.id === 2 ? { taskId: 'async-child' } : { pr: f.markMerged(value) };
  f.hooks.status = async value => {
    assert.equal(f.state.review('review')?.operation?.state, 'running');
    assert.equal(f.item(2).phase, 'merging');
    assert.equal(f.item(2).merge, 'merging');
    if (++observations === 1) return { state: 'pending' };
    f.markMerged(value);
    return { state: 'success' };
  };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.item(2).mergeCommit, hash(1002));
  assert.equal(f.item(2).cleanup, 'deleted');
  assert.deepEqual(f.calls, ['approve:2', 'merge:2', 'status:2:async-child', 'status:2:async-child', 'approve:1', 'merge:1']);
});

test('successful task status without an authoritative merged PR never advances a parent', async () => {
  const f = await fixture();
  f.hooks.merge = async () => ({ taskId: 'task-success' });
  f.hooks.status = async () => ({ state: 'success' });
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(f.item(2).merge, 'merging');
  assert.equal(f.item(2).mergeCommit, undefined);
  assert.equal(f.item(2).phase, undefined);
  assert.deepEqual(f.calls.filter(call => !call.startsWith('status:')), ['approve:2', 'merge:2']);
});

test('polling pauses on task failures and unreadable status without repeating an accepted merge', async () => {
  for (const failure of ['task', 'permission', 'network']) {
    const f = await fixture();
    f.hooks.merge = async () => ({ taskId: `task-${failure}` });
    f.hooks.status = async () => {
      if (failure === 'task') return { state: 'failed', error: 'Merge check failed' };
      if (failure === 'permission') throw providerError(403, 'Status permission expired');
      throw new Error('Status connection lost');
    };
    const result = await f.service.run('review', 'merge');
    assert.equal(result.operation?.state, 'paused');
    assert.equal(f.item(2).merge, failure === 'task' ? 'failed' : 'unknown');
    assert.equal(f.item(2).phase, undefined);
    if (failure !== 'task') await f.service.run('review', 'merge');
    assert.deepEqual(f.calls.filter(call => !call.startsWith('status:')), ['approve:2', 'merge:2']);
  }
});

test('a push observed while polling pauses before any parent actions', async () => {
  const f = await fixture();
  f.hooks.merge = async () => ({ taskId: 'task-push' });
  f.hooks.status = async value => { f.current(value).sourceHash = hash(9000); return { state: 'pending' }; };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.match(result.operation?.error ?? '', /changed while Bitbucket was merging/);
  assert.equal(f.item(2).merge, 'merging');
  assert.equal(f.item(2).sourceHash, f.prs[1].sourceHash);
  assert.equal(f.calls.filter(call => call.startsWith('status:')).length, 1);
  assert.deepEqual(f.calls.filter(call => !call.startsWith('status:')), ['approve:2', 'merge:2']);
});

test('polling respects a bounded deadline and safely resumes an accepted task after restart', async () => {
  const f = await fixture();
  let now = 0;
  Object.assign(f.polling, { now: () => now, timeoutMs: 10, intervalMs: 10, maxAttempts: 100, wait: async (ms: number) => { now += ms; } });
  f.hooks.merge = async value => value.id === 2 ? { taskId: 'task-restart' } : { pr: f.markMerged(value) };
  const first = await f.service.run('review', 'merge');
  assert.equal(first.operation?.state, 'paused');
  assert.equal(f.item(2).merge, 'merging');
  assert.equal(f.calls.filter(call => call.startsWith('status:')).length, 1, 'the observation deadline bounds repeated reads');
  await f.reload();
  f.hooks.status = async value => { f.markMerged(value); return { state: 'success' }; };
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.item(2).mergeCommit, hash(1002));
  assert.equal(f.calls.filter(call => call === 'merge:2').length, 1);
  assert.ok(f.calls.includes('merge:1'));
});

test('clears a failed asynchronous task before a retry so later uncertain delivery is not retried against that old task', async () => {
  const f = await fixture([pr(1)]);
  let attempt = 0;
  f.hooks.merge = async () => { if (++attempt === 1) return { taskId: 'old-failed-task' }; throw new Error('New request delivery lost'); };
  await f.service.run('review', 'merge');
  f.hooks.status = async () => ({ state: 'failed', error: 'First task failed' });
  await f.service.run('review', 'merge');
  assert.equal(attempt, 1, 'an observed task failure pauses before a separate explicit retry');
  assert.equal(f.item(1).merge, 'failed');
  await f.service.run('review', 'merge');
  assert.equal(attempt, 2);
  assert.equal(f.item(1).merge, 'unknown');
  assert.equal(f.item(1).taskId, undefined);
  await f.service.run('review', 'merge');
  assert.equal(attempt, 2);
});

test('pointer preflight requires existing parent PRs, existing gitlinks, valid identity and parent write access', async () => {
  const missing = await fixture([pr(2, 'packages/child', '.', 'packages/child')], true);
  await assert.rejects(missing.service.run('review', 'merge'), /existing parent PR/);
  assert.deepEqual(missing.calls, []);
  const noPointer = await fixture(undefined, true);
  noPointer.pointerEntries.set('.', []);
  await assert.rejects(noPointer.service.run('review', 'merge'), /existing submodule pointer/);
  assert.deepEqual(noPointer.calls, []);
  const noIdentity = await fixture(undefined, true);
  noIdentity.hooks.identity = async () => { throw new Error('Configure a Git identity'); };
  await assert.rejects(noIdentity.service.run('review', 'merge'), /Git identity/);
  const noWrite = await fixture(undefined, true);
  noWrite.hooks.write = async () => { throw providerError(403, 'Parent repository requires write access'); };
  await assert.rejects(noWrite.service.run('review', 'merge'), /write access/);
  assert.deepEqual(noWrite.calls, []);
});

test('uses actual child merge commits, pauses for parent pointer review, and then resumes the refreshed parent', async () => {
  const f = await fixture(undefined, true);
  const first = await f.service.run('review', 'merge');
  assert.equal(first.operation?.state, 'paused');
  assert.equal(f.item(1).pointerState, 'review');
  assert.deepEqual(f.prepared[0].updates, { 'packages/child': hash(1002) });
  assert.equal(f.prepared[0].expectedHead, f.prs[0].sourceHash);
  assert.deepEqual(f.calls, ['approve:2', 'merge:2']);
  await assert.rejects(f.service.run('review', 'merge'), /Refresh and review/);
  await f.refresh();
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.item(1).pointerState, 'ready');
  assert.equal(f.item(1).sourceHash, hash(2001));
  assert.equal(f.prepared.length, 1);
  assert.equal(f.pushes.length, 1);
  assert.deepEqual(f.calls, ['approve:2', 'merge:2', 'approve:1', 'merge:1']);
});

test('nested pointer merges resume after an intermediate parent is merged while its ancestor is still open', async () => {
  const f = await fixture([pr(1), pr(2, 'packages/child', '.', 'packages/child'), pr(3, 'packages/child/nested', 'packages/child', 'nested')], true);
  await f.service.run('review', 'merge');
  assert.equal(f.item(2).pointerState, 'review');
  assert.deepEqual(f.prepared[0].updates, { nested: hash(1003) });
  await f.refresh();
  await f.service.run('review', 'merge');
  assert.equal(f.item(2).merge, 'merged');
  assert.equal(f.item(1).pointerState, 'review');
  assert.deepEqual(f.prepared[1].updates, { 'packages/child': hash(1002) });
  await f.refresh();
  await f.reload();
  assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
  assert.equal(f.prepared.length, 2);
  assert.deepEqual(f.calls.filter(call => call.startsWith('merge:')), ['merge:3', 'merge:2', 'merge:1']);
});

test('reconciles an interrupted pointer push without preparing a duplicate commit', async () => {
  for (const delivered of [false, true]) {
    const f = await fixture(undefined, true);
    let interrupted = true;
    f.hooks.push = async (_input, apply) => {
      if (interrupted) {
        interrupted = false;
        if (delivered) apply();
        throw new Error('Pointer push interrupted');
      }
      apply();
    };
    await f.service.run('review', 'merge');
    assert.equal(f.item(1).pointerState, 'pushing');
    await f.reload();
    if (delivered) {
      await assert.rejects(f.service.run('review', 'merge'), /Refresh and review/);
    } else {
      assert.equal((await f.service.run('review', 'merge')).operation?.state, 'paused');
      assert.equal(f.item(1).pointerState, 'review');
    }
    await f.refresh();
    assert.equal((await f.service.run('review', 'merge')).operation?.state, 'complete');
    assert.equal(f.prepared.length, 1);
    assert.equal(f.pushes.length, delivered ? 1 : 2);
  }
});
