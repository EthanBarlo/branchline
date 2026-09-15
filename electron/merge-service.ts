import type { BranchReviewRepository, MergeOperation, MergePreview, MergeProgress, PullRequest, RemoteReviewState, RepositoryMapping } from '../shared/integrations';
import { pullRequestKey } from '../shared/integrations';
import type { ReviewSnapshot } from '../shared/types';
import type { BitbucketClient } from './bitbucket-client';
import type { ConnectionManager } from './connection-manager';
import { IntegrationStore } from './integration-store';
import type { PointerService } from './pointer-service';
import { ReviewStore } from './store';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const depth = (pr: Pick<PullRequest, 'repository'>) => pr.repository.relativePath === '.' ? 0 : pr.repository.relativePath.split('/').length;
const sameRevision = (a: Pick<PullRequest, 'sourceHash' | 'targetHash'>, b: PullRequest) => a.sourceHash === b.sourceHash && a.targetHash === b.targetHash;
const unknownFailure = (error: unknown) => { const status = (error as { status?: number })?.status; return !status || status >= 500 || status === 408; };
export interface MergePollingOptions { maxAttempts?: number; intervalMs?: number; timeoutMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number; }
export interface BranchMergePreparation {
  preflight(id: string, options?: { repositoryPaths?: string[] }): Promise<string[]>;
  ensurePullRequests(id: string, repositoryPaths: string[]): Promise<void>;
}
class MergePollDeadline extends Error {}

/** Stop scheduling on the first failure, but always drain already-started work. */
async function concurrent<T>(values: T[], task: (value: T, stopped: () => boolean, stop: (reason: string) => void) => Promise<string | null>, ready: (value: T) => boolean = () => true): Promise<string | null> {
  const pending = [...values];
  const active = new Set<Promise<void>>();
  let reason: string | null = null;
  const stop = (error: string) => { reason ??= error || 'The repository operation failed.'; };
  while (pending.length || active.size) {
    while (!reason && active.size < 4) {
      const index = pending.findIndex(ready);
      if (index < 0) break;
      const [value] = pending.splice(index, 1);
      const promise = task(value, () => reason !== null, stop).then(error => { if (error) stop(error); }, error => stop(message(error)));
      const tracked = promise.finally(() => { active.delete(tracked); });
      active.add(tracked);
    }
    if (!active.size) {
      if (!reason && pending.length) stop('The repository dependency hierarchy cannot advance. Check its parent mappings before resuming.');
      break;
    }
    await Promise.race(active);
  }
  return reason;
}

export class MergeService {
  constructor(private readonly reviews: ReviewStore, private readonly state: IntegrationStore,
    private readonly connections: ConnectionManager, private readonly client: (id: string) => BitbucketClient,
    private readonly snapshots: (id: string) => ReviewSnapshot | undefined, private readonly pointers: PointerService,
    private readonly polling: MergePollingOptions = {}, private readonly branches?: BranchMergePreparation) {}
  private binding(id: string): RemoteReviewState { const binding = this.state.review(id); if (!binding) throw new Error('Open a Bitbucket PR review first.'); return binding; }
  private async progress(id: string, key: string, update: Partial<MergeProgress>) {
    await this.state.updateReview(id, r => { const item = r.operation?.items.find(i => i.prKey === key); if (!item) throw new Error('The merge operation is unavailable.'); Object.assign(item, update); r.operation!.updatedAt = new Date().toISOString(); });
  }
  private async pause(id: string, reason: string) {
    return this.state.updateReview(id, r => { if (r.operation) { r.operation.state = 'paused'; r.operation.error = reason; r.operation.updatedAt = new Date().toISOString(); for (const item of r.operation.items) delete item.phase; } });
  }
  private async confirmMerged(id: string, key: string, pr: PullRequest, client: BitbucketClient, skipped?: boolean, stop?: (reason: string) => void): Promise<void> {
    const previous = this.binding(id).operation?.items.find(item => item.prKey === key);
    // Publish the confirmed merge before checking cleanup: source branch lookup
    // can take time or fail without changing the successful merge result.
    await this.progress(id, key, { merge: 'merged', mergeCommit: pr.mergeCommit ?? previous?.mergeCommit,
      phase: 'cleanup', skipped: skipped ?? previous?.skipped, error: undefined });
    const reviewed = this.binding(id).pullRequests.find(value => pullRequestKey(value) === key);
    if (pr.sourceHash !== (reviewed?.sourceHash ?? previous?.sourceHash)) {
      const reason = `${pr.repository.relativePath}: Bitbucket confirmed a merge with a different source revision. The merge result was saved; refresh and review the changed source before continuing with other repositories.`;
      stop?.(reason);
      await this.progress(id, key, { phase: undefined, error: reason });
      throw new Error(reason);
    }
    if (this.binding(id).repositories?.find(row => row.repository.relativePath === pr.repository.relativePath)?.cleanup?.state === 'deleted') {
      await this.progress(id, key, { cleanup: 'deleted', phase: undefined });
      return;
    }
    const exists = await client.branchExists(pr).catch(() => undefined);
    await this.progress(id, key, { cleanup: exists === undefined ? 'unknown' : exists ? 'retained' : 'deleted', phase: undefined });
  }
  private children<T extends Pick<PullRequest, 'repository'>>(parent: T, prs: T[]): T[] { return prs.filter(pr => pr.repository.parentRelativePath === parent.repository.relativePath); }

  private async pollMerge(id: string, key: string, pr: PullRequest, client: BitbucketClient, stop?: (reason: string) => void): Promise<string | null> {
    const item = this.binding(id).operation!.items.find(value => value.prKey === key)!;
    if (!item.taskId) return 'Merge delivery is uncertain. Resume after Bitbucket has confirmed its result.';
    const now = this.polling.now ?? Date.now;
    const deadline = now() + (this.polling.timeoutMs ?? 30_000);
    const attempts = this.polling.maxAttempts ?? 16;
    const interval = this.polling.intervalMs ?? 2_000;
    const wait = this.polling.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const pending = `${pr.repository.relativePath}: Bitbucket is still merging this PR. Resume to check its result.`;
    const read = async <T>(request: () => Promise<T>): Promise<T> => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new MergePollDeadline(pending);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // These are read-only requests. A slow provider response must not keep
        // the operation running beyond the observation deadline.
        return await Promise.race([request(), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new MergePollDeadline(pending)), remaining); })]);
      } finally { if (timeout) clearTimeout(timeout); }
    };
    await this.state.updateReview(id, review => {
      review.operation!.updatedAt = new Date().toISOString();
      const progress = review.operation!.items.find(value => value.prKey === key)!;
      progress.merge = 'merging'; progress.phase = 'merging'; progress.error = undefined;
    });
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        let latest = await read(() => client.getPullRequest(pr.repository, pr.id));
        if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client, undefined, stop); return null; }
        if (latest.state !== 'OPEN' || !sameRevision(item, latest)) {
          const reason = `${pr.repository.relativePath}: the PR changed while Bitbucket was merging it. Refresh and review its status before resuming.`;
          stop?.(reason);
          await this.progress(id, key, { phase: undefined, error: reason });
          return reason;
        }
        const task = await read(() => client.mergeStatus(latest, item.taskId!));
        if (task.state === 'failed') {
          const reason = task.error ?? 'Bitbucket could not complete the merge.';
          stop?.(reason);
          await this.progress(id, key, { merge: 'failed', phase: undefined, error: reason });
          return reason;
        }
        if (task.state === 'success') {
          // A completed task alone is not authoritative enough to merge a
          // parent or use a child result as a submodule pointer.
          latest = await read(() => client.getPullRequest(pr.repository, pr.id));
          if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client, undefined, stop); return null; }
          if (latest.state !== 'OPEN' || !sameRevision(item, latest)) {
            const reason = `${pr.repository.relativePath}: the PR changed while Bitbucket was merging it. Refresh and review its status before resuming.`;
            stop?.(reason);
            await this.progress(id, key, { phase: undefined, error: reason });
            return reason;
          }
        }
        if (attempt + 1 < attempts) await wait(Math.max(0, Math.min(interval, deadline - now())));
      }
      stop?.(pending);
      await this.progress(id, key, { phase: undefined, error: pending });
      return pending;
    } catch (error) {
      const confirmed = this.binding(id).operation!.items.find(value => value.prKey === key)!.merge === 'merged';
      const reason = message(error);
      stop?.(reason);
      await this.progress(id, key, { ...(confirmed ? {} : { merge: error instanceof MergePollDeadline ? 'merging' as const : 'unknown' as const }), phase: undefined, error: reason });
      return reason;
    }
  }

  private async pointerPreflight(id: string, prs: PullRequest[], client: BitbucketClient, pending: BranchReviewRepository[] = []): Promise<string[]> {
    const errors: string[] = [];
    const project = this.reviews.getProject(this.reviews.getReview(id).projectId);
    const settings = this.state.project(project.id);
    try { await this.pointers.preflight(project.repoPath); } catch (error) { errors.push(message(error)); }
    const mapped = new Map(settings.repositories.map(r => [r.relativePath, r]));
    const candidates: Array<Pick<PullRequest, 'repository' | 'sourceHash' | 'state'> & { id?: number }> = [
      ...prs, ...pending.filter(row => row.sourceHash).map(row => ({ repository: row.repository, sourceHash: row.sourceHash!, state: 'OPEN' })),
    ];
    for (const child of candidates) {
      if (child.repository.relativePath !== '.' && (!child.repository.parentRelativePath || !child.repository.submodulePath)) {
        errors.push(`Pointer updates need the parent repository and submodule path for ${child.repository.relativePath}. Complete its mapping, then remove and reopen this PR review.`);
        continue;
      }
      const configured = mapped.get(child.repository.relativePath);
      if (configured && (configured.parentRelativePath !== child.repository.parentRelativePath || configured.submodulePath !== child.repository.submodulePath)) {
        errors.push(`The parent mapping for ${child.repository.relativePath} changed. Restore it or remove and reopen this PR review before updating pointers.`);
        continue;
      }
      let repo: RepositoryMapping | undefined = mapped.get(child.repository.relativePath) ?? child.repository;
      const visited = new Set<string>();
      while (repo?.parentRelativePath !== undefined) {
        if (visited.has(repo.relativePath)) { errors.push('The submodule parent mapping contains a cycle.'); break; }
        visited.add(repo.relativePath);
        const parent = candidates.find(pr => pr.repository.relativePath === repo!.parentRelativePath);
        if (!parent) { errors.push(`Pointer updates require an existing parent PR or reviewed branch changes for ${repo.parentRelativePath}. Add a parent PR or turn pointer updates off.`); break; }
        repo = mapped.get(parent.repository.relativePath) ?? parent.repository;
      }
    }
    const preparationFailure = await concurrent(candidates, async parent => {
      const children = this.children(parent, candidates);
      if (!children.length) return null;
      // A completed parent already contributed its merge result to the next
      // ancestor. Requiring it to reopen would strand a resumed nested merge.
      if (parent.state === 'MERGED' && children.every(child => child.state === 'MERGED')) return null;
      if (parent.state !== 'OPEN') { errors.push(`Parent PR ${parent.repository.relativePath} #${parent.id} must remain open until its child pointers are updated.`); return null; }
      try {
        await client.checkWriteAccess(parent.repository);
        const entries = await client.pointerEntries(parent);
        for (const child of children) {
          const path = child.repository.submodulePath;
          if (!path || !entries.some(entry => entry.path === path)) errors.push(`The parent PR does not contain an existing submodule pointer for ${child.repository.relativePath}.`);
        }
      } catch (error) { errors.push(`${parent.repository.relativePath}: ${message(error)}`); }
      return null;
    });
    if (preparationFailure) errors.push(preparationFailure);
    return [...new Set(errors)];
  }

  async preview(id: string, action: 'approve' | 'merge' = 'merge', checkBranches = true): Promise<MergePreview> {
    const binding = this.binding(id);
    const project = this.state.project(this.reviews.getReview(id).projectId);
    const client = this.client(binding.connectionId);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const snapshot = this.snapshots(id);
    if (!snapshot) blockers.push('Open and refresh this PR review before taking an action.');
    if (snapshot?.loading) blockers.push('Wait for all repositories to finish loading before approving or merging.');
    if (snapshot?.repos.some(repo => repo.error) || snapshot?.files.some(file => file.unavailable)) blockers.push('Some PR contents could not be loaded. Refresh the complete review before approving or merging.');
    if (this.branches && checkBranches) blockers.push(...await this.branches.preflight(id));
    const missingPrs = binding.repositories?.filter(row => row.status === 'changes' && !row.prId) ?? [];
    if (missingPrs.length && !this.branches) blockers.push('Automatic pull request creation is unavailable. Reopen this branch review before continuing.');
    for (const row of missingPrs) warnings.push(`${row.repository.relativePath}: a pull request will be created for the reviewed branch changes before ${action === 'merge' ? 'merging' : 'approval'}.`);
    if (missingPrs.length) warnings.push('You will own automatically created pull requests. Your approval does not count toward Bitbucket\'s required approval count; another reviewer may still be needed.');
    const currentByKey = new Map<string, PullRequest>();
    await this.state.updateReview(id, review => {
      for (const row of review.repositories ?? []) {
        if (row.prId && row.check?.state !== 'failed') row.check = { state: 'queued' };
      }
    });
    const checks = await concurrent(binding.pullRequests, async reviewed => {
      let failed: string | undefined;
      const updateCheck = (state: 'checking' | 'ready' | 'failed') => this.state.updateReview(id, review => {
        const row = review.repositories?.find(row => row.repository.relativePath === reviewed.repository.relativePath);
        if (row && row.check?.state !== 'failed') row.check = { state, ...(failed ? { error: failed } : {}) };
      });
      const policyBlockers = new Set<string>();
      const addBlocker = (reason: string) => { policyBlockers.add(reason); blockers.push(reason); };
      try {
        await updateCheck('checking');
        const pr = await client.getPullRequest(reviewed.repository, reviewed.id); currentByKey.set(pullRequestKey(pr), pr);
        const progress = binding.operation?.items.find(i => i.prKey === pullRequestKey(pr));
        if (progress?.merge === 'merged' && pr.state === 'MERGED') return null;
        if (pr.state === 'MERGED') { warnings.push(`${pr.repository.relativePath} #${pr.id} is already merged.`); return null; }
        if (pr.state !== 'OPEN') addBlocker(`${pr.repository.relativePath} #${pr.id} is ${pr.state.toLowerCase()}.`);
        if (pr.author.id === this.connections.credentials(binding.connectionId).info.accountId) warnings.push(`${pr.repository.relativePath} #${pr.id}: your own approval does not count toward Bitbucket's required approval count.`);
        if (pr.draft) addBlocker(`${pr.repository.relativePath} #${pr.id} is a draft.`);
        // A just-pushed pointer commit must be viewed before it can be approved.
        if (!sameRevision(reviewed, pr)) addBlocker(`${pr.repository.relativePath} #${pr.id} changed. Refresh and review the latest changes first.`);
        if (action === 'merge' && !pr.mergeStrategies.includes('merge_commit')) addBlocker(`${pr.repository.relativePath} does not permit standard merge commits.`);
        if (pr.checks?.some(check => check.state !== 'SUCCESSFUL')) warnings.push(`${pr.repository.relativePath} has pending or unsuccessful build checks. Bitbucket will enforce its configured merge rules.`);
        if (pr.taskCount) warnings.push(`${pr.repository.relativePath} has ${pr.taskCount} PR task(s). Bitbucket will enforce required task resolution.`);
      } catch (error) { addBlocker(`${reviewed.repository.relativePath}: ${message(error)}`); }
      finally { failed = [...policyBlockers].join('\n') || undefined; await updateCheck(failed ? 'failed' : 'ready'); }
      return null;
    });
    if (checks) blockers.push(checks);
    const current = binding.pullRequests.flatMap(pr => { const latest = currentByKey.get(pullRequestKey(pr)); return latest ? [latest] : []; });
    if (action === 'merge' && project.updateSubmodulePointers && current.length === binding.pullRequests.length) {
      // Completed ancestor chains need no further preparation on a resumed run.
      const unfinished = current.filter(pr => binding.operation?.items.find(i => i.prKey === pullRequestKey(pr))?.merge !== 'merged');
      if (unfinished.length || missingPrs.length) blockers.push(...await this.pointerPreflight(id, current, client, missingPrs));
      warnings.push('Parent pointer commits pause this operation for review and checks before each parent merge.');
    }
    if (this.reviews.getReview(id).comments.some(c => !c.resolved)) warnings.push('Unresolved local feedback remains in this review. Publish feedback separately before merging if it should appear in Bitbucket.');
    return { pullRequests: current, repositories: this.binding(id).repositories, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], updateSubmodulePointers: project.updateSubmodulePointers, operation: binding.operation };
  }

  private async reconcileOperation(id: string, client: BitbucketClient): Promise<string | null> {
    const binding = this.binding(id);
    if (!binding.operation) return null;
    return concurrent(binding.operation.items, async item => {
      const pr = binding.pullRequests.find(p => pullRequestKey(p) === item.prKey);
      if (!pr) throw new Error('A PR disappeared from the operation.');
      if (item.taskId && (item.merge === 'merging' || item.merge === 'unknown')) {
        const pending = await this.pollMerge(id, item.prKey, pr, client);
        if (pending) return pending;
        return null;
      }
      const latest = await client.getPullRequest(pr.repository, pr.id);
      if (latest.state === 'MERGED') {
        await this.confirmMerged(id, item.prKey, latest, client, item.skipped ?? (item.merge === 'pending' || item.merge === 'failed'));
      } else if (item.merge === 'sending') {
        // A store failure or interrupted process can leave the request in flight.
        // OPEN is not proof that the provider never received the merge request.
        await this.progress(id, item.prKey, { merge: 'unknown', error: 'Merge delivery is uncertain. Wait for Bitbucket to confirm its result before resuming.' });
      }
      if (item.pointerState === 'pushing' && item.pointerCommit) {
        if (latest.sourceHash === item.pointerCommit) await this.progress(id, item.prKey, { pointerState: 'review' });
        else if (latest.sourceHash === item.pointerBase) await this.progress(id, item.prKey, { pointerState: 'prepared' });
        else throw new Error(`${pr.repository.relativePath}: the parent branch changed during a pointer push. Refresh before resuming.`);
      }
      return null;
    });
  }

  private async cleanupProgress(id: string, repositoryPath: string, cleanup: NonNullable<BranchReviewRepository['cleanup']>): Promise<void> {
    await this.state.updateReview(id, review => {
      const row = review.repositories?.find(value => value.repository.relativePath === repositoryPath);
      if (!row) throw new Error('The repository disappeared from branch cleanup.');
      row.cleanup = cleanup;
      const item = review.operation?.items.find(value => value.prKey === `${repositoryPath}#${row.prId}`);
      if (item && ['deleted', 'retained', 'unknown'].includes(cleanup.state)) item.cleanup = cleanup.state as MergeProgress['cleanup'];
      if (review.operation) review.operation.updatedAt = new Date().toISOString();
    });
  }

  /** All writes use a source-hash lease; only commits already in the target can be deleted. */
  private async cleanupBranches(id: string, client: BitbucketClient): Promise<string | null> {
    const binding = this.binding(id);
    const rows = [...(binding.repositories ?? [])].sort((a, b) => depth(b) - depth(a)
      || a.repository.relativePath.localeCompare(b.repository.relativePath));
    return concurrent(rows, async (row, stopped, stop) => {
      const repositoryPath = row.repository.relativePath;
      // A previously deleted branch may have since been deliberately recreated.
      // A successful receipt never authorizes deleting that replacement branch.
      if (row.cleanup?.state === 'deleted' || row.cleanup?.state === 'skipped') return null;
      const item = binding.operation?.items.find(value => value.prKey === `${repositoryPath}#${row.prId}`);
      const uncertain = row.cleanup?.state === 'sending' || row.cleanup?.state === 'unknown';
      const expectedHead = (uncertain ? row.cleanup?.expectedHead : undefined) ?? item?.pointerCommit ?? row.sourceHash;
      const save = (state: NonNullable<BranchReviewRepository['cleanup']>['state'], error?: string) => this.cleanupProgress(id, repositoryPath, { state, expectedHead, ...(error ? { error } : {}) });
      try {
        if (row.prId && item?.merge !== 'merged') return `${repositoryPath}: its PR has not finished merging. Branch cleanup is paused.`;
        // Reconciliation is read-only. Preserve uncertainty on disk while it is
        // in flight, so a second crash cannot turn it into a new deletion attempt.
        await save(uncertain ? 'unknown' : 'checking');
        // A private repository can return 404 when access is revoked. Verify the
        // repository first so that response cannot masquerade as a deleted branch.
        const repository = await client.getRepository(row.repository);
        const source = await client.getBranch(row.repository, row.sourceBranch);
        if (!source) { await save(row.sourceHash ? 'deleted' : 'skipped'); return null; }
        if (!expectedHead || source.hash !== expectedHead) {
          await save('retained', 'The source branch contains changes that were not part of this review.'); return null;
        }
        if (uncertain) {
          const reason = `${repositoryPath}: branch deletion is unconfirmed and the branch still exists. Check Bitbucket before retrying; Branchline has not sent another deletion.`;
          stop(reason); await save('unknown', reason); return reason;
        }
        if (row.sourceBranch === row.targetBranch || !repository.defaultBranch || row.sourceBranch === repository.defaultBranch) {
          await save('retained', 'The source is the target or default branch, or the default branch could not be verified.'); return null;
        }
        const open = await client.findPullRequests(row.repository, row.sourceBranch, ['OPEN']);
        if (open.length) { await save('retained', 'The source branch still has an open pull request.'); return null; }
        const target = await client.getBranch(row.repository, row.targetBranch);
        if (!target) { await save('retained', `The target branch ${row.targetBranch} is missing.`); return null; }
        if (await client.mergeBase(row.repository, source.hash, target.hash) !== source.hash) {
          await save('retained', 'The source branch has commits that are not merged into its target.'); return null;
        }
        if (stopped()) { await save('pending'); return null; }
        const credentials = this.connections.credentials(binding.connectionId);
        await save('sending');
        if (stopped()) { await save('pending'); return null; }
        try {
          await this.pointers.deleteBranch({ repository: row.repository, sourceBranch: row.sourceBranch, expectedHead,
            credentials: { email: credentials.email, token: credentials.token } });
        } catch (error) {
          // A failed Git request may have reached the server. Reconcile before
          // deciding whether a retry would be safe, without issuing another write.
          let latest: Awaited<ReturnType<BitbucketClient['getBranch']>>;
          try { latest = await client.getBranch(row.repository, row.sourceBranch); }
          catch {
            const reason = `${repositoryPath}: branch deletion could not be confirmed. ${message(error)}`;
            stop(reason); await save('unknown', reason); return reason;
          }
          if (!latest) { await save('deleted'); return null; }
          if (latest.hash !== expectedHead) { await save('retained', 'The source branch changed during cleanup and was retained.'); return null; }
          // Explicit refusals can be retried after permissions/protection are
          // corrected; an indeterminate transport response remains uncertain.
          const rejected = /remote rejected|stale info|source branch changed|permission denied|not permitted|not allowed|authentication failed|could not read username|access denied|403|401/i.test(message(error));
          const reason = `${repositoryPath}: ${message(error)}`;
          stop(reason); await save(rejected ? 'retained' : 'unknown', reason); return reason;
        }
        const latest = await client.getBranch(row.repository, row.sourceBranch);
        if (latest) { await save('retained', 'The branch exists again after deletion. Check Bitbucket before continuing.'); return null; }
        await save('deleted');
      } catch (error) {
        const current = this.binding(id).repositories?.find(value => value.repository.relativePath === repositoryPath)?.cleanup;
        const reason = `${repositoryPath}: ${message(error)}`;
        stop(reason);
        await save(uncertain || current?.state === 'sending' ? 'unknown' : 'pending', reason);
        return reason;
      }
      return null;
    });
  }

  private async performRun(id: string, action: 'approve' | 'merge'): Promise<RemoteReviewState> {
    if (action !== 'approve' && action !== 'merge') throw new Error('Choose approve or merge.');
    let binding = this.binding(id);
    const client = this.client(binding.connectionId);
    if (binding.operation) await this.state.updateReview(id, review => { review.operation!.state = 'running'; review.operation!.error = undefined; });
    const reconciliationPause = await this.reconcileOperation(id, client);
    if (reconciliationPause) return this.pause(id, reconciliationPause);
    const preview = await this.preview(id, action);
    if (preview.blockers.length) throw new Error(preview.blockers.join('\n'));
    if (this.branches) {
      const missing = this.binding(id).repositories?.filter(row => row.status === 'changes' && !row.prId).map(row => row.repository.relativePath) ?? [];
      if (missing.length) {
        await this.branches.ensurePullRequests(id, missing);
        if (this.binding(id).repositories?.some(row => row.status === 'changes' && !row.prId)) throw new Error('Some reviewed repositories still need a pull request. Resume creation before approving or merging.');
        // Newly created PRs have their own merge policies and required checks.
        // Creation cannot stand in for checking those before the first approval.
        const createdPreview = await this.preview(id, action, false);
        if (createdPreview.blockers.length) throw new Error(createdPreview.blockers.join('\n'));
      }
    }
    binding = this.binding(id);
    const existing = binding.operation;
    const operation: MergeOperation = {
      action, state: 'running', updatedAt: new Date().toISOString(),
      items: binding.pullRequests.map(pr => {
        const previous = existing?.items.find(item => item.prKey === pullRequestKey(pr));
        // A refreshed review starts a new attempt only after a known failure or
        // before any merge was sent. Uncertain delivery must retain its old
        // expected revisions and cannot be turned into a fresh merge attempt.
        if (previous && (previous.sourceHash !== pr.sourceHash || previous.targetHash !== pr.targetHash)
          && ['pending', 'failed'].includes(previous.merge) && !previous.pointerCommit) {
          return { prKey: pullRequestKey(pr), approval: 'pending', merge: 'pending', sourceHash: pr.sourceHash, targetHash: pr.targetHash } as MergeProgress;
        }
        return previous ?? {
          prKey: pullRequestKey(pr), approval: 'pending', merge: 'pending', sourceHash: pr.sourceHash, targetHash: pr.targetHash,
        };
      }),
    };
    await this.state.updateReview(id, r => { r.operation = operation; });
    const ordered = [...binding.pullRequests].sort((a, b) => depth(b) - depth(a) || a.repository.relativePath.localeCompare(b.repository.relativePath));
    const settings = this.state.project(this.reviews.getReview(id).projectId);
    const mergePause = await concurrent(ordered, async (reviewed, stopped, stop) => {
      const key = pullRequestKey(reviewed);
      const stopWith = (reason: string) => { stop(reason); return reason; };
      let item = this.binding(id).operation!.items.find(item => item.prKey === key)!;
      if (item.merge === 'merged') return null;
      if (item.merge === 'sending' || item.merge === 'unknown' || item.merge === 'merging') return stopWith(`${reviewed.repository.relativePath}: merge delivery is still uncertain or pending. Resume after Bitbucket has confirmed its result.`);
      try {
        if (this.branches) {
          const blockers = await this.branches.preflight(id, { repositoryPaths: [reviewed.repository.relativePath] });
          if (blockers.length) throw new Error(blockers.join('\n'));
        }
        if (stopped()) return null;
        await this.progress(id, key, { phase: 'checking', error: undefined });
        let latest = await client.getPullRequest(reviewed.repository, reviewed.id);
        if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client, true); return null; }
        if (!sameRevision(reviewed, latest)) throw new Error(`${reviewed.repository.relativePath}: the PR changed. Refresh and review it before resuming.`);
        if (latest.state !== 'OPEN' || latest.draft) throw new Error(`${reviewed.repository.relativePath}: the PR is not ready for approval.`);
        if (action === 'merge' && !latest.mergeStrategies.includes('merge_commit')) throw new Error('Standard merge commits are no longer permitted.');
        if (action === 'merge' && settings.updateSubmodulePointers) {
          const children = this.children(reviewed, ordered);
          const updates: Record<string, string> = {};
          for (const child of children) {
            const childProgress = this.binding(id).operation!.items.find(p => p.prKey === pullRequestKey(child));
            if (childProgress?.merge !== 'merged' || !childProgress.mergeCommit) throw new Error('Wait for all child merges to complete before updating parent pointers.');
            updates[child.repository.submodulePath!] = childProgress.mergeCommit;
          }
          if (Object.keys(updates).length) {
            await this.progress(id, key, { phase: 'updating-pointers' });
            const entries = await client.pointerEntries(latest);
            const changed = Object.fromEntries(Object.entries(updates).filter(([path, hash]) => entries.find(entry => entry.path === path)?.hash !== hash));
            if (Object.keys(changed).length) {
              const project = this.reviews.getProject(this.reviews.getReview(id).projectId);
              const identity = await this.pointers.preflight(project.repoPath);
              const credentials = this.connections.credentials(binding.connectionId);
              const expectedHead = item.pointerBase ?? latest.sourceHash;
              const input = { repository: latest.repository, sourceBranch: latest.sourceBranch, expectedHead, updates: changed,
                identity, credentials: { email: credentials.email, token: credentials.token }, operationId: `${id}:${key}:${expectedHead}` };
              if (!item.pointerCommit) {
                const prepared = await this.pointers.prepare(input);
                await this.progress(id, key, { pointerCommit: prepared.commit, pointerBase: prepared.base, pointerChildren: changed, pointerState: 'prepared' });
                item = this.binding(id).operation!.items.find(p => p.prKey === key)!;
              }
              if (stopped()) return null;
              await this.progress(id, key, { pointerState: 'pushing' });
              if (stopped()) { await this.progress(id, key, { pointerState: 'prepared' }); return null; }
              await this.pointers.push({ ...input, updates: item.pointerChildren ?? changed, commit: item.pointerCommit! });
              const reason = `${reviewed.repository.relativePath}: pointer changes are ready for review. Refresh the PR, review the new pointers, wait for its checks, then resume.`;
              stop(reason);
              await this.progress(id, key, { pointerState: 'review', approval: 'pending' });
              return reason;
            }
            if (item.pointerCommit && latest.sourceHash !== item.pointerCommit) throw new Error('The pointer commit changed. Review the parent branch before resuming.');
            if (item.pointerState === 'review') await this.progress(id, key, { pointerState: 'ready', sourceHash: latest.sourceHash, targetHash: latest.targetHash });
          }
        }
        // Approvals are always queried again; Bitbucket may reset them after pushes.
        const account = this.connections.credentials(binding.connectionId).info.accountId;
        if (stopped()) return null;
        await this.progress(id, key, { phase: 'approving' });
        if (stopped()) return null;
        if (!latest.participants.some(p => p.id === account && p.approved)) {
          await client.approve(latest);
          await this.progress(id, key, { approval: 'approved', phase: undefined, error: undefined });
        } else await this.progress(id, key, { approval: 'approved', phase: undefined, error: undefined });
        if (action === 'approve' || stopped()) return null;
        if (this.branches) {
          const blockers = await this.branches.preflight(id, { repositoryPaths: [reviewed.repository.relativePath] });
          if (blockers.length) throw new Error(blockers.join('\n'));
        }
        await this.progress(id, key, { phase: 'checking' });
        latest = await client.getPullRequest(reviewed.repository, reviewed.id);
        if (!sameRevision(reviewed, latest)) throw new Error('The PR changed after approval. Refresh before merging.');
        if (latest.state !== 'OPEN' || latest.draft || !latest.mergeStrategies.includes('merge_commit')) throw new Error('The PR is no longer ready for a standard merge. Refresh its status before resuming.');
        if (stopped()) return null;
        await this.progress(id, key, { merge: 'sending', phase: 'merging', skipped: undefined, sourceHash: latest.sourceHash, targetHash: latest.targetHash, taskId: undefined, error: undefined });
        if (stopped()) { await this.progress(id, key, { merge: 'pending', phase: undefined }); return null; }
        try {
          const result = await client.merge(latest);
          if (result.taskId) {
            await this.progress(id, key, { merge: 'merging', taskId: result.taskId });
            const pending = await this.pollMerge(id, key, latest, client, stop);
            if (pending) return stopWith(pending);
            return null;
          }
          const merged = result.pr?.state === 'MERGED' ? result.pr : await client.getPullRequest(latest.repository, latest.id);
          if (merged.state !== 'MERGED') {
            stop('Bitbucket has not confirmed the merge. Resume to reconcile its status.');
            await this.progress(id, key, { merge: 'unknown' });
            return stopWith('Bitbucket has not confirmed the merge. Resume to reconcile its status.');
          }
          await this.confirmMerged(id, key, merged, client, undefined, stop);
        } catch (error) {
          stop(message(error));
          const confirmed = this.binding(id).operation?.items.find(item => item.prKey === key)?.merge === 'merged';
          await this.progress(id, key, { ...(confirmed ? {} : { merge: unknownFailure(error) ? 'unknown' as const : 'failed' as const }), phase: undefined, error: message(error) });
          return stopWith(message(error));
        }
      } catch (error) {
        stop(message(error));
        const current = this.binding(id).operation!.items.find(i => i.prKey === key)!;
        await this.progress(id, key, { ...(current.approval !== 'approved' ? { approval: 'failed' as const } : {}), error: message(error) });
        return stopWith(message(error));
      }
      return null;
    }, reviewed => action !== 'merge' || !settings.updateSubmodulePointers
      || this.children(reviewed, ordered).every(child => this.binding(id).operation!.items.find(item => item.prKey === pullRequestKey(child))?.merge === 'merged'));
    if (mergePause) return this.pause(id, mergePause);
    if (action === 'merge') {
      if (this.branches) {
        const blockers = await this.branches.preflight(id);
        if (blockers.length) return this.pause(id, blockers.join('\n'));
      }
      const cleanupPause = await this.cleanupBranches(id, client);
      if (cleanupPause) return this.pause(id, cleanupPause);
    }
    return this.state.updateReview(id, r => { r.operation!.state = 'complete'; r.operation!.error = undefined; r.operation!.updatedAt = new Date().toISOString(); for (const item of r.operation!.items) delete item.phase; });
  }

  async run(id: string, action: 'approve' | 'merge'): Promise<RemoteReviewState> {
    try { return await this.performRun(id, action); }
    catch (error) {
      if (this.binding(id).operation?.state === 'running') await this.pause(id, message(error));
      throw error;
    }
  }
}
