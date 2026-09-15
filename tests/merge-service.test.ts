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
import type { PointerPrepareInput, PointerRemoteInput, PointerService } from '../electron/pointer-service';
import type { ReviewStore } from '../electron/store';
import type { BranchReviewRepository, MergeProgress, PullRequest, RemoteReviewChanged, RepositoryMapping } from '../shared/integrations';
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

async function fixture(prs = [pr(1), pr(2, 'packages/child', '.', 'packages/child')], updatePointers = false, repositories?: BranchReviewRepository[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchline-merge-'));
  fixtures.push(root);
  const statePath = path.join(root, 'integrations.json');
  let state = new IntegrationStore(statePath);
  await state.setProject('project', { repositories: repositories?.map(row => row.repository) ?? prs.map(p => p.repository), bitbucketConnectionId: 'connection', updateSubmodulePointers: updatePointers });
  await state.setReview('review', { connectionId: 'connection', pullRequests: prs, publications: {}, ...(repositories ? { repositories } : {}) });
  const live = new Map(prs.map(p => [pullRequestKey(p), structuredClone(p)]));
  const calls: string[] = [];
  const reads = new Map<string, number>();
  const pointerEntries = new Map(prs.map(parent => [parent.repository.relativePath, prs.filter(child => child.repository.parentRelativePath === parent.repository.relativePath).map(child => ({ path: child.repository.submodulePath!, hash: hash(child.id + 500) }))]));
  const prepared: PointerPrepareInput[] = [];
  const pushes: Array<PointerPrepareInput & { commit: string }> = [];
  const deletions: PointerRemoteInput[] = [];
  const remoteBranches = new Map<string, string>();
  for (const row of repositories ?? []) {
    if (row.sourceHash) remoteBranches.set(`${row.repository.relativePath}:${row.sourceBranch}`, row.sourceHash);
    if (row.targetHash) remoteBranches.set(`${row.repository.relativePath}:${row.targetBranch}`, row.targetHash);
  }
  const hooks: {
    get?: (value: PullRequest, count: number) => void | Promise<void>;
    approve?: (value: PullRequest) => Promise<void>;
    merge?: (value: PullRequest) => Promise<{ pr?: PullRequest; taskId?: string }>;
    status?: (value: PullRequest, taskId: string) => Promise<{ state: 'pending' | 'success' | 'failed'; error?: string }>;
    write?: (mapping: RepositoryMapping) => Promise<void>;
    identity?: () => Promise<{ name: string; email: string }>;
    push?: (input: PointerPrepareInput & { commit: string }, apply: () => void) => Promise<void>;
    retained?: (value: PullRequest) => boolean | Promise<boolean>;
    branchPreflight?: (options?: { repositoryPaths?: string[] }) => Promise<string[]>;
    ensurePrs?: (paths: string[]) => Promise<void>;
    getBranch?: (mapping: RepositoryMapping, name: string) => Promise<void>;
    repository?: (mapping: RepositoryMapping) => Promise<{ defaultBranch: string }>;
    openPrs?: (mapping: RepositoryMapping) => Promise<PullRequest[]>;
    mergeBase?: (mapping: RepositoryMapping, source: string, target: string) => Promise<string>;
    deleteBranch?: (input: PointerRemoteInput) => Promise<void>;
  } = {};
  const current = (value: Pick<PullRequest, 'repository' | 'id'>): PullRequest => live.get(pullRequestKey(value))!;
  const markMerged = (value: PullRequest): PullRequest => {
    const latest = current(value);
    Object.assign(latest, { state: 'MERGED', mergeCommit: hash(value.id + 1000) });
    if (repositories) {
      remoteBranches.set(`${value.repository.relativePath}:${value.targetBranch}`, latest.mergeCommit!);
      if (!hooks.retained) remoteBranches.delete(`${value.repository.relativePath}:${value.sourceBranch}`);
    }
    return structuredClone(latest);
  };
  const client = {
    async getPullRequest(mapping: RepositoryMapping, id: number) {
      const value = current({ repository: mapping, id });
      const key = pullRequestKey(value);
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      await hooks.get?.(value, count);
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
    async getRepository(mapping: RepositoryMapping) { return hooks.repository ? hooks.repository(mapping) : { defaultBranch: 'main' }; },
    async getBranch(mapping: RepositoryMapping, name: string) {
      await hooks.getBranch?.(mapping, name);
      const value = remoteBranches.get(`${mapping.relativePath}:${name}`);
      return value ? { name, hash: value } : null;
    },
    async findPullRequests(mapping: RepositoryMapping) { return hooks.openPrs ? hooks.openPrs(mapping) : []; },
    async mergeBase(mapping: RepositoryMapping, source: string, target: string) { return hooks.mergeBase ? hooks.mergeBase(mapping, source, target) : source; },
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
    async deleteBranch(input: PointerRemoteInput) {
      deletions.push(structuredClone(input));
      calls.push(`delete:${input.repository.relativePath}`);
      if (hooks.deleteBranch) return hooks.deleteBranch(input);
      remoteBranches.delete(`${input.repository.relativePath}:${input.sourceBranch}`);
    },
  } as unknown as PointerService;
  const reviews = {
    getProject: () => ({ id: 'project', repoPath: '/unchanged/local/checkout' }),
    getReview: () => ({ id: 'review', projectId: 'project', comments: [] }),
  } as unknown as ReviewStore;
  const connections = { credentials: () => ({ email: 'account@example.com', token: 'fake-token', info: { accountId: 'me' } }) } as unknown as ConnectionManager;
  let snapshot: ReviewSnapshot | undefined = { reviewId: 'review', files: [], repos: [], fingerprint: 'snapshot', refreshedAt: new Date().toISOString(), warnings: [] };
  const polling: MergePollingOptions = { maxAttempts: 2, intervalMs: 0, wait: async () => undefined };
  const build = () => new MergeService(reviews, state, connections, () => client, () => snapshot, pointers, polling, repositories ? {
    preflight: async (_id, options) => hooks.branchPreflight ? hooks.branchPreflight(options) : [],
    ensurePullRequests: async (_id, paths) => { await hooks.ensurePrs?.(paths); },
  } : undefined);
  let service = build();
  return {
    prs, live, hooks, calls, reads, prepared, pushes, deletions, remoteBranches, pointerEntries, current, markMerged, statePath, polling,
    get service() { return service; }, get state() { return state; },
    item(id: number): MergeProgress { return state.review('review')!.operation!.items.find(item => item.prKey === pullRequestKey(prs.find(value => value.id === id)!))!; },
    setSnapshot(value: ReviewSnapshot | undefined) { snapshot = value; },
    async refresh() { await state.updateReview('review', value => { value.pullRequests = value.pullRequests.map(p => structuredClone(current(p))); }); },
    async reload() { state = new IntegrationStore(statePath); await state.load(); service = build(); },
  };
}

test('approves and standard-merges independent repositories and records cleanup including retained branches', async () => {
  const f = await fixture([pr(1), pr(2, 'packages/child', '.', 'packages/child'), pr(3, 'packages/child/nested', 'packages/child', 'nested')]);
  f.hooks.retained = value => value.id === 2;
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual([...f.calls].sort(), ['approve:1', 'approve:2', 'approve:3', 'merge:1', 'merge:2', 'merge:3']);
  for (const value of f.prs) assert.ok(f.calls.indexOf(`approve:${value.id}`) < f.calls.indexOf(`merge:${value.id}`));
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
  assert.deepEqual([...f.calls].sort(), ['approve:1', 'approve:2', 'merge:1', 'merge:1', 'merge:2']);
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
  const f = await fixture(undefined, true);
  f.pointerEntries.set('.', [{ path: 'packages/child', hash: hash(1002) }]);
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
  const f = await fixture(undefined, true);
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
    const f = await fixture(undefined, true);
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
  const f = await fixture(undefined, true);
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

function branchRow(value: PullRequest, status: BranchReviewRepository['status'] = 'pull-request'): BranchReviewRepository {
  return { repository: value.repository, sourceBranch: value.sourceBranch, targetBranch: value.targetBranch,
    sourceHash: value.sourceHash, targetHash: value.targetHash, mergeBaseHash: value.targetHash, status,
    ...(status === 'pull-request' ? { prId: value.id } : {}) };
}

async function addCreatedPr(f: Awaited<ReturnType<typeof fixture>>, value: PullRequest): Promise<void> {
  f.prs.push(value);
  f.live.set(pullRequestKey(value), structuredClone(value));
  await f.state.updateReview('review', review => {
    review.pullRequests.push(value);
    const row = review.repositories!.find(row => row.repository.relativePath === value.repository.relativePath)!;
    row.status = 'pull-request'; row.prId = value.id;
  });
}

test('creates PRs for every reviewed changed branch, merges repositories, and then deletes empty branches', async () => {
  const parent = pr(1);
  const child = pr(2, 'packages/child', '.', 'packages/child');
  const empty = pr(3, 'packages/empty', '.', 'packages/empty');
  const f = await fixture([parent], false, [branchRow(parent), branchRow(child, 'changes'), branchRow(empty, 'no-changes')]);
  f.hooks.ensurePrs = async paths => {
    assert.deepEqual(paths, ['packages/child']);
    f.calls.push('create:2');
    await addCreatedPr(f, child);
  };
  const preview = await f.service.preview('review');
  assert.equal(preview.repositories?.length, 3);
  assert.equal(preview.blockers.length, 0);
  assert.match(preview.warnings.join('\n'), /pull request will be created/);
  f.hooks.deleteBranch = async input => {
    const saved = f.state.review('review')!;
    assert.equal(saved.repositories!.find(row => row.repository.relativePath === input.repository.relativePath)!.cleanup?.state, 'sending');
    assert.ok(saved.operation!.items.every(item => item.merge === 'merged'), 'cleanup follows all merges');
    f.remoteBranches.delete(`${input.repository.relativePath}:${input.sourceBranch}`);
  };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.calls[0], 'create:2');
  assert.equal(f.calls.at(-1), 'delete:packages/empty');
  assert.deepEqual([...f.calls.slice(1, -1)].sort(), ['approve:1', 'approve:2', 'merge:1', 'merge:2']);
  assert.ok(result.repositories!.every(row => row.cleanup?.state === 'deleted'));
  assert.equal(result.pullRequests.length, 2, 'empty branches never need a PR');
  assert.equal(f.deletions[0].expectedHead, empty.sourceHash);
});

test('approve creates missing changed-branch PRs without merging or deleting branches', async () => {
  const parent = pr(1);
  const child = pr(2, 'child', '.', 'child');
  const f = await fixture([parent], false, [branchRow(parent), branchRow(child, 'changes')]);
  f.hooks.ensurePrs = async () => { await addCreatedPr(f, child); };
  const result = await f.service.run('review', 'approve');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:2', 'approve:1']);
  assert.equal(f.deletions.length, 0);
  assert.ok(result.repositories!.every(row => !row.cleanup));
});

test('branch-wide blockers prevent PR creation, approval and merge, including formerly empty repositories', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'empty'), 'no-changes')]);
  f.hooks.branchPreflight = async () => ['empty: the source branch changed. Refresh and review the new changes.'];
  await assert.rejects(f.service.run('review', 'merge'), /empty: the source branch changed/);
  assert.deepEqual(f.calls, []);
});

test('a new push in another repository after approval pauses the final group check before cleanup', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'empty'), 'no-changes')]);
  let pushed = false;
  f.hooks.approve = async () => { pushed = true; };
  f.hooks.branchPreflight = async options => pushed && !options?.repositoryPaths ? ['empty: new branch work needs review.'] : [];
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.match(result.operation!.error!, /new branch work/);
  assert.deepEqual(f.calls, ['approve:1', 'merge:1']);
  assert.equal(f.item(1).merge, 'merged');
  assert.equal(f.deletions.length, 0);
});

test('newly created PRs must permit standard merging before any group approvals are sent', async () => {
  const parent = pr(1);
  const child = pr(2, 'child');
  const f = await fixture([parent], false, [branchRow(parent), branchRow(child, 'changes')]);
  f.hooks.ensurePrs = async () => { await addCreatedPr(f, { ...child, mergeStrategies: ['squash'] }); };
  await assert.rejects(f.service.run('review', 'merge'), /does not permit standard merge commits/);
  assert.equal(f.state.review('review')!.pullRequests.length, 2, 'created PR identity survives the blocker');
  assert.deepEqual(f.calls, []);
});

test('cleanup retains unmerged, changed, default and open-PR branches and skips missing branches', async () => {
  const parent = pr(1);
  const rows = ['unmerged', 'changed', 'default', 'open', 'missing'].map((name, index) => branchRow(pr(index + 2, name), 'no-changes'));
  const missing = rows.find(row => row.repository.relativePath === 'missing')!;
  missing.status = 'missing-branch'; delete missing.sourceHash; delete missing.mergeBaseHash;
  const f = await fixture([parent], false, [branchRow(parent), ...rows]);
  f.remoteBranches.set(`changed:${parent.sourceBranch}`, hash(999));
  f.hooks.repository = async mapping => ({ defaultBranch: mapping.relativePath === 'default' ? parent.sourceBranch : 'main' });
  f.hooks.mergeBase = async (mapping, source) => mapping.relativePath === 'unmerged' ? hash(998) : source;
  f.hooks.openPrs = async mapping => mapping.relativePath === 'open' ? [{ ...pr(20, 'open'), targetBranch: 'other-target' }] : [];
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.deletions.length, 0);
  for (const row of result.repositories!.filter(row => row.repository.relativePath !== '.')) {
    assert.equal(row.cleanup?.state, row.repository.relativePath === 'missing' ? 'skipped' : 'retained');
    if (row.cleanup?.state === 'retained') assert.ok(row.cleanup.error);
  }
});

test('cleanup retries a known protected-branch refusal after restart without repeating completed merges or deletions', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'a'), 'no-changes'), branchRow(pr(3, 'b'), 'no-changes')]);
  f.hooks.deleteBranch = async input => {
    if (input.repository.relativePath === 'b') throw new Error('remote rejected: branch deletion not permitted');
    f.remoteBranches.delete(`${input.repository.relativePath}:${input.sourceBranch}`);
  };
  let result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'a')!.cleanup?.state, 'deleted');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'b')!.cleanup?.state, 'retained');
  await f.reload();
  delete f.hooks.deleteBranch;
  result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:1', 'merge:1', 'delete:a', 'delete:b', 'delete:b']);
});

test('an uncertain deletion reconciles after restart and does not resend when the branch is still present', async () => {
  const parent = pr(1);
  const empty = pr(2, 'empty');
  const f = await fixture([parent], false, [branchRow(parent), branchRow(empty, 'no-changes')]);
  f.hooks.deleteBranch = async () => { throw new Error('connection reset after sending deletion'); };
  let result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'empty')!.cleanup?.state, 'unknown');
  await f.reload();
  result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(f.deletions.length, 1);
  assert.match(result.operation!.error!, /has not sent another deletion/);
  f.remoteBranches.delete(`empty:${empty.sourceBranch}`);
  result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.deletions.length, 1);
});

test('cleanup reconciles a lost success response and retains a source that races deletion', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'lost'), 'no-changes'), branchRow(pr(3, 'race'), 'no-changes')]);
  f.hooks.deleteBranch = async input => {
    const key = `${input.repository.relativePath}:${input.sourceBranch}`;
    if (input.repository.relativePath === 'lost') f.remoteBranches.delete(key);
    else f.remoteBranches.set(key, hash(998));
    throw new Error('connection reset');
  };
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'lost')!.cleanup?.state, 'deleted');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'race')!.cleanup?.state, 'retained');
  assert.equal(f.remoteBranches.get(`race:${parent.sourceBranch}`), hash(998));
});

test('cleanup deletes a retained merged PR source using its reviewed revision and keeps completed receipts', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent)]);
  f.hooks.retained = () => true;
  let result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.equal(f.item(1).cleanup, 'deleted');
  assert.deepEqual(f.calls, ['approve:1', 'merge:1', 'delete:.']);
  f.remoteBranches.set(`.:${parent.sourceBranch}`, parent.sourceHash);
  result = await f.service.run('review', 'merge');
  assert.equal(result.repositories![0].cleanup?.state, 'deleted');
  assert.equal(f.deletions.length, 1, 'a deliberately recreated branch is not covered by an old successful cleanup');
});

test('pointer preview permits a reviewed parent branch that will receive a PR, then pauses after the pointer push', async () => {
  const parent = pr(1);
  const child = pr(2, 'child', '.', 'child');
  const f = await fixture([child], true, [branchRow(parent, 'changes'), branchRow(child)]);
  f.pointerEntries.set('.', [{ path: 'child', hash: hash(700) }]);
  f.hooks.ensurePrs = async paths => { assert.deepEqual(paths, ['.']); await addCreatedPr(f, parent); };
  assert.equal((await f.service.preview('review')).blockers.length, 0);
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.match(result.operation!.error!, /pointer changes are ready for review/);
  assert.deepEqual(f.calls, ['approve:2', 'merge:2']);
  assert.equal(f.pushes[0].updates.child, hash(1002));
  assert.equal(f.deletions.length, 0);
});

test('an observed concurrent source merged by Bitbucket is recorded but stops remaining repositories until reviewed', async () => {
  const f = await fixture(undefined, true);
  f.pointerEntries.set('.', [{ path: 'packages/child', hash: hash(1002) }]);
  f.hooks.merge = async value => {
    if (value.id === 2) f.current(value).sourceHash = hash(9002);
    return { pr: f.markMerged(value) };
  };
  let result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(f.item(2).merge, 'merged');
  assert.equal(f.item(2).mergeCommit, hash(1002));
  assert.match(result.operation!.error!, /different source revision/);
  assert.deepEqual(f.calls, ['approve:2', 'merge:2']);
  await f.reload();
  assert.match((await f.service.run('review', 'merge')).operation!.error!, /different source revision/);
  assert.deepEqual(f.calls, ['approve:2', 'merge:2']);
  await f.refresh();
  result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'complete');
  assert.deepEqual(f.calls, ['approve:2', 'merge:2', 'approve:1', 'merge:1']);
});

test('cleanup cannot mistake revoked repository access for an absent branch', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'empty'), 'no-changes')]);
  f.hooks.repository = async mapping => {
    if (mapping.relativePath === 'empty') throw providerError(404, 'Repository no longer accessible');
    return { defaultBranch: 'main' };
  };
  f.remoteBranches.delete(`empty:${parent.sourceBranch}`);
  const result = await f.service.run('review', 'merge');
  assert.equal(result.operation?.state, 'paused');
  assert.equal(result.repositories!.find(row => row.repository.relativePath === 'empty')!.cleanup?.state, 'pending');
  assert.match(result.operation!.error!, /Repository no longer accessible/);
  assert.equal(f.deletions.length, 0);
});

test('a second restart during uncertain cleanup reconciliation cannot make deletion retryable', async () => {
  const parent = pr(1);
  const f = await fixture([parent], false, [branchRow(parent), branchRow(pr(2, 'empty'), 'no-changes')]);
  f.hooks.deleteBranch = async () => { throw new Error('connection reset'); };
  await f.service.run('review', 'merge');
  await f.reload();
  f.hooks.repository = async mapping => {
    if (mapping.relativePath === 'empty') {
      const disk = JSON.parse(readFileSync(f.statePath, 'utf8')).reviews.review;
      assert.equal(disk.repositories.find((row: BranchReviewRepository) => row.repository.relativePath === 'empty').cleanup.state, 'unknown');
      throw new Error('read interrupted');
    }
    return { defaultBranch: 'main' };
  };
  await f.service.run('review', 'merge');
  await f.reload();
  assert.equal(f.state.review('review')!.repositories!.find(row => row.repository.relativePath === 'empty')!.cleanup?.state, 'unknown');
  delete f.hooks.repository;
  await f.service.run('review', 'merge');
  assert.equal(f.deletions.length, 1);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('merge policy preflight checks four repositories at once with durable per-repository progress', async () => {
  const prs = Array.from({ length: 6 }, (_, index) => pr(index + 1, `repo-${index + 1}`));
  const f = await fixture(prs, false, prs.map(value => branchRow(value)));
  const gates = new Map(prs.map(value => [value.id, deferred()]));
  let active = 0; let peak = 0; let hold = true;
  f.hooks.get = async value => {
    active++; peak = Math.max(peak, active);
    try { if (hold) await gates.get(value.id)!.promise; } finally { active--; }
  };
  const preview = f.service.preview('review');
  try {
    await until(() => active === 4, 'four concurrent PR policy checks');
    const rows = f.state.review('review')!.repositories!;
    assert.equal(rows.filter(row => row.check?.state === 'checking').length, 4);
    assert.equal(rows.filter(row => row.check?.state === 'queued').length, 2);
    gates.get(1)!.resolve();
    await until(() => f.reads.has(pullRequestKey(prs[4])), 'the next queued policy check');
    assert.equal(active, 4);
  } finally { hold = false; for (const gate of gates.values()) gate.resolve(); }
  assert.equal((await preview).blockers.length, 0);
  assert.equal(peak, 4);
  assert.ok(f.state.review('review')!.repositories!.every(row => row.check?.state === 'ready'));
});

test('independent merges overlap with at most four active requests and include parents when pointers are off', async () => {
  const prs = [pr(1), ...Array.from({ length: 6 }, (_, index) => pr(index + 2, `child-${index + 2}`, '.', `child-${index + 2}`))];
  const f = await fixture(prs);
  const gates = new Map(prs.map(value => [value.id, deferred()]));
  let active = 0; let peak = 0; let hold = true;
  f.hooks.merge = async value => {
    active++; peak = Math.max(peak, active);
    try { if (hold) await gates.get(value.id)!.promise; return { pr: f.markMerged(value) }; }
    finally { active--; }
  };
  const merging = f.service.run('review', 'merge');
  try {
    await until(() => active === 4, 'four concurrent merge requests');
    assert.equal(f.state.review('review')!.operation!.items.filter(item => item.phase === 'merging').length, 4);
    assert.equal(f.calls.filter(call => call.startsWith('merge:')).length, 4);
    gates.get(2)!.resolve();
    await until(() => f.calls.filter(call => call.startsWith('merge:')).length === 5, 'the next merge after one finishes');
    assert.equal(active, 4);
  } finally { hold = false; for (const gate of gates.values()) gate.resolve(); }
  const result = await merging;
  assert.equal(result.operation!.state, 'complete');
  assert.equal(peak, 4);
  assert.ok(result.operation!.items.every(item => item.merge === 'merged'));
  assert.ok(f.calls.includes('merge:1'));
});

test('a failed parallel merge stops queued writes and drains already-sent merges before pausing', async () => {
  const prs = Array.from({ length: 6 }, (_, index) => pr(index + 1, `repo-${index + 1}`));
  const f = await fixture(prs);
  const gates = new Map(prs.map(value => [value.id, deferred<{ pr: PullRequest }>()]));
  f.hooks.merge = value => gates.get(value.id)!.promise;
  let settled = false;
  const merging = f.service.run('review', 'merge').finally(() => { settled = true; });
  try {
    await until(() => f.calls.filter(call => call.startsWith('merge:')).length === 4, 'four sent merges');
    gates.get(1)!.reject(providerError(409, 'Merge checks failed'));
    await until(() => f.item(1).merge === 'failed', 'durable failed merge');
    assert.equal(settled, false, 'the operation must still await the other sent requests');
    assert.equal(f.state.review('review')!.operation!.state, 'running');
    for (const value of prs.slice(1, 4)) assert.equal(f.item(value.id).phase, 'merging', 'other live row spinners remain visible');
    assert.ok(!f.calls.includes('approve:5') && !f.calls.includes('approve:6'));
  } finally { for (const value of prs) gates.get(value.id)!.resolve({ pr: value.id > 1 && value.id <= 4 ? f.markMerged(value) : structuredClone(f.current(value)) }); }
  const result = await merging;
  assert.equal(result.operation!.state, 'paused');
  assert.match(result.operation!.error!, /Merge checks failed/);
  assert.equal(f.calls.filter(call => call.startsWith('merge:')).length, 4);
  for (const value of prs.slice(1, 4)) assert.equal(f.item(value.id).merge, 'merged');
  for (const value of prs.slice(4)) assert.equal(f.item(value.id).merge, 'pending');
});

test('pointer dependencies allow sibling merges concurrently and wait for every child before a parent pointer commit', async () => {
  const prs = [pr(1), pr(2, 'a', '.', 'a'), pr(3, 'b', '.', 'b')];
  const f = await fixture(prs, true);
  const gates = new Map([[2, deferred()], [3, deferred()]]);
  f.hooks.merge = async value => { await gates.get(value.id)?.promise; return { pr: f.markMerged(value) }; };
  const merging = f.service.run('review', 'merge');
  try {
    await until(() => f.calls.includes('merge:2') && f.calls.includes('merge:3'), 'both sibling merges');
    assert.equal(f.prepared.length, 0);
    assert.ok(!f.calls.includes('approve:1'));
    gates.get(2)!.resolve();
    await until(() => f.item(2).merge === 'merged', 'the first sibling merge');
    assert.equal(f.prepared.length, 0, 'the parent still waits for its other child');
  } finally { for (const gate of gates.values()) gate.resolve(); }
  const result = await merging;
  assert.equal(result.operation!.state, 'paused');
  assert.equal(f.prepared.length, 1);
  assert.deepEqual(f.prepared[0].updates, { a: hash(1002), b: hash(1003) });
  assert.equal(f.item(1).pointerState, 'review');
  assert.ok(!f.calls.includes('approve:1'));
});

test('a failed parallel branch deletion drains in-flight deletions and leaves queued branches untouched', async () => {
  const parent = pr(1);
  const rows = Array.from({ length: 6 }, (_, index) => branchRow(pr(index + 2, `empty-${index + 2}`), 'no-changes'));
  const f = await fixture([parent], false, [branchRow(parent), ...rows]);
  const gates = new Map(rows.map(row => [row.repository.relativePath, deferred()]));
  let active = 0; let peak = 0; let settled = false;
  f.hooks.deleteBranch = async input => {
    active++; peak = Math.max(peak, active);
    try { await gates.get(input.repository.relativePath)!.promise; f.remoteBranches.delete(`${input.repository.relativePath}:${input.sourceBranch}`); }
    finally { active--; }
  };
  const merging = f.service.run('review', 'merge').finally(() => { settled = true; });
  try {
    await until(() => f.deletions.length === 4, 'four concurrent branch deletions');
    assert.ok(f.state.review('review')!.operation!.items.every(item => item.merge === 'merged'));
    gates.get('empty-2')!.reject(new Error('remote rejected: branch deletion not permitted'));
    await until(() => f.state.review('review')!.repositories!.find(row => row.repository.relativePath === 'empty-2')!.cleanup?.state === 'retained', 'the protected branch result');
    assert.equal(settled, false);
    assert.equal(f.deletions.length, 4);
    for (const row of rows.slice(1, 4)) assert.equal(f.state.review('review')!.repositories!.find(value => value.repository.relativePath === row.repository.relativePath)!.cleanup?.state, 'sending');
  } finally { for (const gate of gates.values()) gate.resolve(); }
  const result = await merging;
  assert.equal(result.operation!.state, 'paused');
  assert.equal(peak, 4);
  assert.equal(f.deletions.length, 4);
  for (const row of rows.slice(1, 4)) assert.equal(result.repositories!.find(value => value.repository.relativePath === row.repository.relativePath)!.cleanup?.state, 'deleted');
  for (const row of rows.slice(4)) assert.equal(result.repositories!.find(value => value.repository.relativePath === row.repository.relativePath)!.cleanup, undefined);
});

test('merge preflight performs two whole-group checks and only scoped checks around each PR action', async () => {
  const prs = Array.from({ length: 7 }, (_, index) => pr(index + 1, `repo-${index + 1}`));
  const f = await fixture(prs, false, prs.map(value => branchRow(value)));
  const checked: Array<string[] | undefined> = [];
  f.hooks.branchPreflight = async options => { checked.push(options?.repositoryPaths); return []; };
  assert.equal((await f.service.run('review', 'merge')).operation!.state, 'complete');
  assert.equal(checked.filter(paths => !paths).length, 2, 'group discovery is not repeated per repository');
  assert.equal(checked.filter(paths => paths?.length === 1).length, prs.length * 2);
  for (const value of prs) assert.equal(checked.filter(paths => paths?.[0] === value.repository.relativePath).length, 2);
});

test('a parent can finish merging while its child is still in flight when pointer updates are off', async () => {
  const f = await fixture();
  const child = deferred();
  f.hooks.merge = async value => { if (value.id === 2) await child.promise; return { pr: f.markMerged(value) }; };
  const merging = f.service.run('review', 'merge');
  try {
    await until(() => f.state.review('review')?.operation?.items.find(item => item.prKey === pullRequestKey(f.prs[0]))?.merge === 'merged', 'the independent parent merge');
    assert.equal(f.item(2).merge, 'sending');
    assert.equal(f.item(2).phase, 'merging');
    assert.equal(f.state.review('review')!.operation!.state, 'running');
  } finally { child.resolve(); }
  assert.equal((await merging).operation!.state, 'complete');
});
