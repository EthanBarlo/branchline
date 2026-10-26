import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { BranchReviewService } from '../electron/integrations/bitbucket/branch-review-service';
import { MergeService } from '../electron/integrations/bitbucket/merge-service';
import type { BitbucketClient } from '../electron/integrations/bitbucket/bitbucket-client';
import type { ConnectionManager } from '../electron/integrations/connection-manager';
import type { PointerRemoteInput, PointerService } from '../electron/git/pointer-service';
import { IntegrationStore } from '../electron/integrations/integration-store';
import type { ReviewStore } from '../electron/reviews/review-store';
import type { BranchReviewRepository, PullRequest, RepositoryMapping } from '../shared/integrations';
import { pullRequestKey } from '../shared/integrations';
import type { ReviewSnapshot } from '../shared/types';

const fixtures: string[] = [];
after(async () => { await Promise.all(fixtures.map(dir => rm(dir, { recursive: true, force: true }))); });
const hash = (id: number): string => id.toString(16).padStart(40, '0');
const sourceBranch = 'feature/APP-1';
const targetBranch = 'main';
const writes = new Set(['createPullRequest', 'approve', 'merge', 'deleteBranch']);
/** Reads that must separate each write from the previous write to the same repository. */
const preconditions: Record<string, string[]> = {
  createPullRequest: ['findPullRequests', 'getRepository', 'getBranch', 'mergeBase'],
  approve: ['getPullRequest', 'getRepository', 'getBranch'],
  merge: ['getPullRequest', 'getMergeConflicts', 'getBranch'],
  deleteBranch: ['getRepository', 'getBranch', 'findPullRequests', 'mergeBase'],
};

interface Call { stage: string; method: string; repository: string; start: number; end: number }
interface Stage { outer: string; inner?: string }

/** Virtual time advances only when every runnable task is blocked on a simulated round trip. */
class VirtualClock {
  now = 0;
  private busy = 0;
  private scheduled = false;
  private sleepers: Array<{ at: number; wake: () => void }> = [];
  sleep(roundTrips: number): Promise<void> {
    return new Promise(wake => { this.sleepers.push({ at: this.now + roundTrips, wake }); this.schedule(); });
  }
  async track<T>(work: Promise<T>): Promise<T> {
    this.busy++;
    try { return await work; } finally { this.busy--; this.schedule(); }
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.busy || !this.sleepers.length) return;
      this.now = Math.min(...this.sleepers.map(sleeper => sleeper.at));
      const due = this.sleepers.filter(sleeper => sleeper.at <= this.now);
      this.sleepers = this.sleepers.filter(sleeper => sleeper.at > this.now);
      for (const sleeper of due) sleeper.wake();
      this.schedule();
    });
  }
}

/** One linked PR, three branches that need PRs, one missing branch; pointer maintenance off. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchline-read-budget-'));
  fixtures.push(root);
  const repository = (relativePath: string): RepositoryMapping => ({ relativePath, workspace: 'example', repoSlug: relativePath === '.' ? 'root' : relativePath });
  const row = (relativePath: string, status: BranchReviewRepository['status'], seed: number, prId?: number): BranchReviewRepository => ({
    repository: repository(relativePath), sourceBranch, targetBranch, targetHash: hash(seed + 100),
    ...(status === 'missing-branch' ? {} : { sourceHash: hash(seed), mergeBaseHash: hash(seed + 100) }),
    status, ...(prId ? { prId } : {}),
  });
  const rows = [row('.', 'pull-request', 1, 370), row('a', 'changes', 2), row('b', 'changes', 3), row('c', 'changes', 4), row('d', 'missing-branch', 5)];
  const linked: PullRequest = {
    id: 370, repository: rows[0].repository, title: 'APP-1 changes', url: 'https://bitbucket.org/example/root/pull-requests/370',
    sourceBranch, targetBranch, sourceHash: rows[0].sourceHash!, targetHash: rows[0].targetHash!,
    author: { id: 'author', name: 'Author' }, reviewers: [], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'],
  };
  const state = new IntegrationStore(path.join(root, 'integrations.json'));
  await state.setProject('project', { repositories: rows.map(value => value.repository), bitbucketConnectionId: 'connection', updateSubmodulePointers: false });
  await state.setReview('review', { connectionId: 'connection', pullRequests: [linked], publications: {}, repositories: rows });
  const refs = new Map<string, string>();
  const bases = new Map<string, string>();
  for (const value of rows) {
    if (value.sourceHash) refs.set(`${value.repository.relativePath}:${sourceBranch}`, value.sourceHash);
    refs.set(`${value.repository.relativePath}:${targetBranch}`, value.targetHash!);
    bases.set(value.repository.relativePath, value.targetHash!);
  }
  const merged = new Map<string, Set<string>>();
  const live = new Map<string, PullRequest>([[pullRequestKey(linked), structuredClone(linked)]]);
  const current = (mapping: RepositoryMapping, id: number): PullRequest => {
    const value = live.get(`${mapping.relativePath}#${id}`);
    if (!value) throw new Error(`PR #${id} does not exist in ${mapping.relativePath}.`);
    return value;
  };
  let nextId = linked.id;

  const clock = new VirtualClock();
  const stages = new AsyncLocalStorage<Stage>();
  const log: Call[] = [];
  const stage = (repository: string): string => {
    const label = stages.getStore() ?? { outer: 'unlabeled' };
    if (label.inner) return `${label.outer}:${label.inner}`;
    const review = state.review('review');
    const saved = review?.repositories?.find(value => value.repository.relativePath === repository);
    const item = review?.operation?.items.find(value => value.prKey === `${repository}#${saved?.prId}`);
    if (item?.phase) return `${label.outer}:${item.phase}`;
    if (review?.operation?.items.every(value => value.merge === 'merged')) return `${label.outer}:cleanup`;
    return label.outer;
  };
  const timed = <A extends unknown[], R>(method: string, impl: (...args: A) => Promise<R>, roundTrips = 1) =>
    async (...args: A): Promise<R> => {
      const first = args[0] as { relativePath?: string; repository?: RepositoryMapping };
      const repository = first.repository?.relativePath ?? first.relativePath!;
      const call: Call = { stage: stage(repository), method, repository, start: clock.now, end: NaN };
      log.push(call);
      await clock.sleep(roundTrips);
      call.end = clock.now;
      return impl(...args);
    };
  const client = {
    getRepository: timed('getRepository', async (_mapping: RepositoryMapping) => ({ defaultBranch: targetBranch })),
    getBranch: timed('getBranch', async (mapping: RepositoryMapping, name: string) => {
      const value = refs.get(`${mapping.relativePath}:${name}`);
      return value ? { name, hash: value } : null;
    }),
    mergeBase: timed('mergeBase', async (mapping: RepositoryMapping, source: string, target: string) =>
      source === target || merged.get(mapping.relativePath)?.has(source) ? source : bases.get(mapping.relativePath)!),
    getMergeConflicts: timed('getMergeConflicts', async (_mapping: RepositoryMapping, _source: string, _target: string) => []),
    findPullRequests: timed('findPullRequests', async (mapping: RepositoryMapping, branch: string, states: string[] = ['OPEN']) =>
      [...live.values()]
        .filter(value => value.repository.relativePath === mapping.relativePath && value.sourceBranch === branch && states.includes(value.state))
        .map(value => structuredClone(value))),
    getPullRequest: timed('getPullRequest', async (mapping: RepositoryMapping, id: number) => structuredClone(current(mapping, id))),
    createPullRequest: timed('createPullRequest', async (mapping: RepositoryMapping, input: { sourceBranch: string; targetBranch: string; title: string }) => {
      const created: PullRequest = {
        id: ++nextId, repository: mapping, title: input.title, url: `https://bitbucket.org/example/${mapping.repoSlug}/pull-requests/${nextId}`,
        sourceBranch: input.sourceBranch, targetBranch: input.targetBranch,
        sourceHash: refs.get(`${mapping.relativePath}:${input.sourceBranch}`)!, targetHash: refs.get(`${mapping.relativePath}:${input.targetBranch}`)!,
        author: { id: 'me', name: 'Me' }, reviewers: [], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'],
      };
      live.set(pullRequestKey(created), created);
      return structuredClone(created);
    }),
    approve: timed('approve', async (value: PullRequest) => { current(value.repository, value.id).participants = [{ id: 'me', approved: true }]; }),
    merge: timed('merge', async (value: PullRequest) => {
      const latest = current(value.repository, value.id);
      Object.assign(latest, { state: 'MERGED', mergeCommit: hash(value.id + 1000) });
      refs.set(`${value.repository.relativePath}:${latest.targetBranch}`, latest.mergeCommit!);
      merged.set(value.repository.relativePath, new Set([...(merged.get(value.repository.relativePath) ?? []), latest.sourceHash]));
      return { pr: structuredClone(latest) };
    }),
    branchExists: timed('branchExists', async (value: PullRequest) => refs.has(`${value.repository.relativePath}:${value.sourceBranch}`)),
  } as unknown as BitbucketClient;
  const pointers = {
    preflight: async () => ({ name: 'Reviewer', email: 'reviewer@example.com' }),
    // ls-remote, push --force-with-lease, ls-remote: the push resolves only once the ref is gone.
    deleteBranch: timed('deleteBranch', async (input: PointerRemoteInput) => { refs.delete(`${input.repository.relativePath}:${input.sourceBranch}`); }, 3),
  } as unknown as PointerService;
  const reviews = {
    getProject: () => ({ id: 'project', repoPath: root }),
    getReview: () => ({ id: 'review', projectId: 'project', comments: [] }),
  } as unknown as ReviewStore;
  const connections = { credentials: () => ({ email: 'me@example.com', token: 'fake-token', info: { accountId: 'me' } }) } as unknown as ConnectionManager;
  const snapshot: ReviewSnapshot = {
    reviewId: 'review', files: [], warnings: [], fingerprint: 'fixture', refreshedAt: new Date().toISOString(),
    repos: rows.map(value => ({ relativePath: value.repository.relativePath, currentBranch: null, workingTreeIncluded: false })),
  };
  const updateReview = state.updateReview.bind(state);
  state.updateReview = (id, update) => clock.track(updateReview(id, update));
  const branches = new BranchReviewService(reviews, state, () => client, () => snapshot);
  const nested = <T>(inner: string, work: () => Promise<T>) => stages.run({ ...stages.getStore()!, inner }, work);
  const service = new MergeService(reviews, state, connections, () => client, () => snapshot, pointers, {}, {
    preflight: (id, options) => branches.preflight(id, options),
    ensurePullRequests: (id, paths, options) => nested('ensure', () => branches.ensurePullRequests(id, paths, options)),
  });
  const preview = service.preview.bind(service);
  service.preview = (id, action, checkBranches) => nested(checkBranches === false ? 'recheck' : 'preview', () => preview(id, action, checkBranches));
  const elapsed: Record<string, number> = {};
  return {
    service, state, live, log, elapsed,
    async stage<T>(outer: string, work: () => Promise<T>): Promise<T> {
      const started = clock.now;
      try { return await stages.run({ outer }, work); } finally { elapsed[outer] = clock.now - started; }
    },
    summary() {
      const methods: Record<string, number> = {};
      const byStage: Record<string, Record<string, number>> = {};
      const spans: Record<string, { from: number; to: number }> = {};
      for (const call of log) {
        methods[call.method] = (methods[call.method] ?? 0) + 1;
        (byStage[call.stage] ??= {})[call.method] = (byStage[call.stage][call.method] ?? 0) + 1;
        const span = (spans[call.stage] ??= { from: call.start, to: call.end });
        span.from = Math.min(span.from, call.start);
        span.to = Math.max(span.to, call.end);
      }
      return { methods, byStage, spans, elapsed };
    },
  };
}

test('approve and merge over five repositories spends a bounded number of Bitbucket round trips', async () => {
  const f = await fixture();
  const dialog = await f.stage('dialog', () => f.service.preview('review', 'merge'));
  assert.deepEqual(dialog.blockers, []);
  assert.ok(f.log.every(call => !writes.has(call.method)), 'opening the dialog never writes');
  const result = await f.stage('run', () => f.service.run('review', 'merge'));
  assert.equal(result.operation?.state, 'complete', result.operation?.error);
  assert.deepEqual([...f.live.values()].map(value => `${value.repository.relativePath}#${value.id}:${value.state}`).sort(), ['.#370:MERGED', 'a#371:MERGED', 'b#372:MERGED', 'c#373:MERGED']);
  assert.deepEqual(result.repositories!.map(value => `${value.repository.relativePath}:${value.cleanup?.state}`), ['.:deleted', 'a:deleted', 'b:deleted', 'c:deleted', 'd:skipped']);

  for (const repository of ['.', 'a', 'b', 'c', 'd']) {
    const sequence = f.log.filter(call => call.repository === repository && call.stage.startsWith('run'));
    let since = 0;
    sequence.forEach((call, index) => {
      if (!writes.has(call.method)) return;
      const window = sequence.slice(since, index).map(value => value.method);
      for (const read of preconditions[call.method])
        assert.ok(window.includes(read), `${repository}: ${call.method} must follow ${read} after the previous write, saw ${window.join(', ')}`);
      since = index + 1;
    });
  }

  const summary = f.summary();
  if (process.env.MERGE_READ_BUDGET) console.log(JSON.stringify(summary, null, 2));
  assert.deepEqual(summary.methods, {
    getRepository: 27, getPullRequest: 24, findPullRequests: 39, getBranch: 54, mergeBase: 23, getMergeConflicts: 16,
    createPullRequest: 3, approve: 4, merge: 4, deleteBranch: 4,
  });
  assert.deepEqual(summary.elapsed, { dialog: 6, run: 28 }, 'serial round trips the user waits on, with one per client call and three per git deletion');
});
