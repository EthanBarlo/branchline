import type { MergeOperation, MergePreview, MergeProgress, PullRequest, RemoteReviewState, RepositoryMapping } from '../shared/integrations';
import { pullRequestKey } from '../shared/integrations';
import type { ReviewSnapshot } from '../shared/types';
import type { BitbucketClient } from './bitbucket-client';
import type { ConnectionManager } from './connection-manager';
import { IntegrationStore } from './integration-store';
import type { PointerService } from './pointer-service';
import { ReviewStore } from './store';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const depth = (pr: PullRequest) => pr.repository.relativePath === '.' ? 0 : pr.repository.relativePath.split('/').length;
const sameRevision = (a: Pick<PullRequest, 'sourceHash' | 'targetHash'>, b: PullRequest) => a.sourceHash === b.sourceHash && a.targetHash === b.targetHash;
const unknownFailure = (error: unknown) => { const status = (error as { status?: number })?.status; return !status || status >= 500 || status === 408; };
export interface MergePollingOptions { maxAttempts?: number; intervalMs?: number; timeoutMs?: number; wait?: (ms: number) => Promise<void>; now?: () => number; }
class MergePollDeadline extends Error {}

export class MergeService {
  constructor(private readonly reviews: ReviewStore, private readonly state: IntegrationStore,
    private readonly connections: ConnectionManager, private readonly client: (id: string) => BitbucketClient,
    private readonly snapshots: (id: string) => ReviewSnapshot | undefined, private readonly pointers: PointerService,
    private readonly polling: MergePollingOptions = {}) {}
  private binding(id: string): RemoteReviewState { const binding = this.state.review(id); if (!binding) throw new Error('Open a Bitbucket PR review first.'); return binding; }
  private async progress(id: string, key: string, update: Partial<MergeProgress>) {
    await this.state.updateReview(id, r => { const item = r.operation?.items.find(i => i.prKey === key); if (!item) throw new Error('The merge operation is unavailable.'); Object.assign(item, update); r.operation!.updatedAt = new Date().toISOString(); });
  }
  private async pause(id: string, reason: string) {
    return this.state.updateReview(id, r => { if (r.operation) { r.operation.state = 'paused'; r.operation.error = reason; r.operation.updatedAt = new Date().toISOString(); for (const item of r.operation.items) delete item.phase; } });
  }
  private async confirmMerged(id: string, key: string, pr: PullRequest, client: BitbucketClient, skipped?: boolean): Promise<void> {
    const previous = this.binding(id).operation?.items.find(item => item.prKey === key);
    // Publish the confirmed merge before checking cleanup: source branch lookup
    // can take time or fail without changing the successful merge result.
    await this.progress(id, key, { merge: 'merged', mergeCommit: pr.mergeCommit ?? previous?.mergeCommit,
      phase: 'cleanup', skipped: skipped ?? previous?.skipped, error: undefined });
    const exists = await client.branchExists(pr).catch(() => undefined);
    await this.progress(id, key, { cleanup: exists === undefined ? 'unknown' : exists ? 'retained' : 'deleted', phase: undefined });
  }
  private children(parent: PullRequest, prs: PullRequest[]): PullRequest[] { return prs.filter(pr => pr.repository.parentRelativePath === parent.repository.relativePath); }

  private async pollMerge(id: string, key: string, pr: PullRequest, client: BitbucketClient): Promise<string | null> {
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
      review.operation!.state = 'running'; review.operation!.error = undefined;
      review.operation!.updatedAt = new Date().toISOString();
      const progress = review.operation!.items.find(value => value.prKey === key)!;
      progress.merge = 'merging'; progress.phase = 'merging'; progress.error = undefined;
    });
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        let latest = await read(() => client.getPullRequest(pr.repository, pr.id));
        if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client); return null; }
        if (latest.state !== 'OPEN' || !sameRevision(item, latest)) {
          const reason = `${pr.repository.relativePath}: the PR changed while Bitbucket was merging it. Refresh and review its status before resuming.`;
          await this.progress(id, key, { phase: undefined, error: reason });
          return reason;
        }
        const task = await read(() => client.mergeStatus(latest, item.taskId!));
        if (task.state === 'failed') {
          const reason = task.error ?? 'Bitbucket could not complete the merge.';
          await this.progress(id, key, { merge: 'failed', phase: undefined, error: reason });
          return reason;
        }
        if (task.state === 'success') {
          // A completed task alone is not authoritative enough to merge a
          // parent or use a child result as a submodule pointer.
          latest = await read(() => client.getPullRequest(pr.repository, pr.id));
          if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client); return null; }
          if (latest.state !== 'OPEN' || !sameRevision(item, latest)) {
            const reason = `${pr.repository.relativePath}: the PR changed while Bitbucket was merging it. Refresh and review its status before resuming.`;
            await this.progress(id, key, { phase: undefined, error: reason });
            return reason;
          }
        }
        if (attempt + 1 < attempts) await wait(Math.max(0, Math.min(interval, deadline - now())));
      }
      await this.progress(id, key, { phase: undefined, error: pending });
      return pending;
    } catch (error) {
      const confirmed = this.binding(id).operation!.items.find(value => value.prKey === key)!.merge === 'merged';
      const reason = message(error);
      await this.progress(id, key, { ...(confirmed ? {} : { merge: error instanceof MergePollDeadline ? 'merging' as const : 'unknown' as const }), phase: undefined, error: reason });
      return reason;
    }
  }

  private async pointerPreflight(id: string, prs: PullRequest[], client: BitbucketClient): Promise<string[]> {
    const errors: string[] = [];
    const project = this.reviews.getProject(this.reviews.getReview(id).projectId);
    const settings = this.state.project(project.id);
    try { await this.pointers.preflight(project.repoPath); } catch (error) { errors.push(message(error)); }
    const mapped = new Map(settings.repositories.map(r => [r.relativePath, r]));
    for (const child of prs) {
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
        const parent = prs.find(pr => pr.repository.relativePath === repo!.parentRelativePath);
        if (!parent) { errors.push(`Pointer updates require an existing parent PR for ${repo.parentRelativePath}. Add that PR to this review or turn pointer updates off.`); break; }
        repo = mapped.get(parent.repository.relativePath) ?? parent.repository;
      }
    }
    for (const parent of prs) {
      const children = this.children(parent, prs);
      if (!children.length) continue;
      // A completed parent already contributed its merge result to the next
      // ancestor. Requiring it to reopen would strand a resumed nested merge.
      if (parent.state === 'MERGED' && children.every(child => child.state === 'MERGED')) continue;
      if (parent.state !== 'OPEN') { errors.push(`Parent PR ${parent.repository.relativePath} #${parent.id} must remain open until its child pointers are updated.`); continue; }
      try {
        await client.checkWriteAccess(parent.repository);
        const entries = await client.pointerEntries(parent);
        for (const child of children) {
          const path = child.repository.submodulePath;
          if (!path || !entries.some(entry => entry.path === path)) errors.push(`The parent PR does not contain an existing submodule pointer for ${child.repository.relativePath}.`);
        }
      } catch (error) { errors.push(`${parent.repository.relativePath}: ${message(error)}`); }
    }
    return [...new Set(errors)];
  }

  async preview(id: string, action: 'approve' | 'merge' = 'merge'): Promise<MergePreview> {
    const binding = this.binding(id);
    const project = this.state.project(this.reviews.getReview(id).projectId);
    const client = this.client(binding.connectionId);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const snapshot = this.snapshots(id);
    if (!snapshot) blockers.push('Open and refresh this PR review before taking an action.');
    if (snapshot?.repos.some(repo => repo.error) || snapshot?.files.some(file => file.unavailable)) blockers.push('Some PR contents could not be loaded. Refresh the complete review before approving or merging.');
    const current: PullRequest[] = [];
    for (const reviewed of binding.pullRequests) {
      try {
        const pr = await client.getPullRequest(reviewed.repository, reviewed.id); current.push(pr);
        const progress = binding.operation?.items.find(i => i.prKey === pullRequestKey(pr));
        if (progress?.merge === 'merged' && pr.state === 'MERGED') continue;
        if (pr.state === 'MERGED') { warnings.push(`${pr.repository.relativePath} #${pr.id} is already merged.`); continue; }
        if (pr.state !== 'OPEN') blockers.push(`${pr.repository.relativePath} #${pr.id} is ${pr.state.toLowerCase()}.`);
        if (pr.draft) blockers.push(`${pr.repository.relativePath} #${pr.id} is a draft.`);
        // A just-pushed pointer commit must be viewed before it can be approved.
        if (!sameRevision(reviewed, pr)) blockers.push(`${pr.repository.relativePath} #${pr.id} changed. Refresh and review the latest changes first.`);
        if (action === 'merge' && !pr.mergeStrategies.includes('merge_commit')) blockers.push(`${pr.repository.relativePath} does not permit standard merge commits.`);
        if (pr.checks?.some(check => check.state !== 'SUCCESSFUL')) warnings.push(`${pr.repository.relativePath} has pending or unsuccessful build checks. Bitbucket will enforce its configured merge rules.`);
        if (pr.taskCount) warnings.push(`${pr.repository.relativePath} has ${pr.taskCount} PR task(s). Bitbucket will enforce required task resolution.`);
      } catch (error) { blockers.push(`${reviewed.repository.relativePath}: ${message(error)}`); }
    }
    if (action === 'merge' && project.updateSubmodulePointers && current.length === binding.pullRequests.length) {
      // Completed ancestor chains need no further preparation on a resumed run.
      const unfinished = current.filter(pr => binding.operation?.items.find(i => i.prKey === pullRequestKey(pr))?.merge !== 'merged');
      if (unfinished.length) blockers.push(...await this.pointerPreflight(id, current, client));
      warnings.push('Parent pointer commits pause this operation for review and checks before each parent merge.');
    }
    if (this.reviews.getReview(id).comments.some(c => !c.resolved)) warnings.push('Unresolved local feedback remains in this review. Publish feedback separately before merging if it should appear in Bitbucket.');
    return { pullRequests: current, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], updateSubmodulePointers: project.updateSubmodulePointers, operation: binding.operation };
  }

  private async reconcileOperation(id: string, client: BitbucketClient): Promise<string | null> {
    const binding = this.binding(id);
    if (!binding.operation) return null;
    for (const item of binding.operation.items) {
      const pr = binding.pullRequests.find(p => pullRequestKey(p) === item.prKey);
      if (!pr) throw new Error('A PR disappeared from the operation.');
      if (item.taskId && (item.merge === 'merging' || item.merge === 'unknown')) {
        const pending = await this.pollMerge(id, item.prKey, pr, client);
        if (pending) return pending;
        continue;
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
    }
    return null;
  }

  async run(id: string, action: 'approve' | 'merge'): Promise<RemoteReviewState> {
    if (action !== 'approve' && action !== 'merge') throw new Error('Choose approve or merge.');
    let binding = this.binding(id);
    const client = this.client(binding.connectionId);
    const reconciliationPause = await this.reconcileOperation(id, client);
    if (reconciliationPause) return this.pause(id, reconciliationPause);
    const preview = await this.preview(id, action);
    if (preview.blockers.length) throw new Error(preview.blockers.join('\n'));
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
    for (const reviewed of ordered) {
      const key = pullRequestKey(reviewed);
      let item = this.binding(id).operation!.items.find(item => item.prKey === key)!;
      if (item.merge === 'merged') continue;
      if (item.merge === 'sending' || item.merge === 'unknown' || item.merge === 'merging') return this.pause(id, `${reviewed.repository.relativePath}: merge delivery is still uncertain or pending. Resume after Bitbucket has confirmed its result.`);
      try {
        await this.progress(id, key, { phase: 'checking', error: undefined });
        let latest = await client.getPullRequest(reviewed.repository, reviewed.id);
        if (latest.state === 'MERGED') { await this.confirmMerged(id, key, latest, client, true); continue; }
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
              await this.progress(id, key, { pointerState: 'pushing' });
              await this.pointers.push({ ...input, updates: item.pointerChildren ?? changed, commit: item.pointerCommit! });
              await this.progress(id, key, { pointerState: 'review', approval: 'pending' });
              return this.pause(id, `${reviewed.repository.relativePath}: pointer changes are ready for review. Refresh the PR, review the new pointers, wait for its checks, then resume.`);
            }
            if (item.pointerCommit && latest.sourceHash !== item.pointerCommit) throw new Error('The pointer commit changed. Review the parent branch before resuming.');
            if (item.pointerState === 'review') await this.progress(id, key, { pointerState: 'ready', sourceHash: latest.sourceHash, targetHash: latest.targetHash });
          }
        }
        // Approvals are always queried again; Bitbucket may reset them after pushes.
        const account = this.connections.credentials(binding.connectionId).info.accountId;
        await this.progress(id, key, { phase: 'approving' });
        if (!latest.participants.some(p => p.id === account && p.approved)) {
          await client.approve(latest);
          await this.progress(id, key, { approval: 'approved', phase: undefined, error: undefined });
        } else await this.progress(id, key, { approval: 'approved', phase: undefined, error: undefined });
        if (action === 'approve') continue;
        await this.progress(id, key, { phase: 'checking' });
        latest = await client.getPullRequest(reviewed.repository, reviewed.id);
        if (!sameRevision(reviewed, latest)) throw new Error('The PR changed after approval. Refresh before merging.');
        if (latest.state !== 'OPEN' || latest.draft || !latest.mergeStrategies.includes('merge_commit')) throw new Error('The PR is no longer ready for a standard merge. Refresh its status before resuming.');
        await this.progress(id, key, { merge: 'sending', phase: 'merging', skipped: undefined, sourceHash: latest.sourceHash, targetHash: latest.targetHash, taskId: undefined, error: undefined });
        try {
          const result = await client.merge(latest);
          if (result.taskId) {
            await this.progress(id, key, { merge: 'merging', taskId: result.taskId });
            const pending = await this.pollMerge(id, key, latest, client);
            if (pending) return this.pause(id, pending);
            continue;
          }
          const merged = result.pr?.state === 'MERGED' ? result.pr : await client.getPullRequest(latest.repository, latest.id);
          if (merged.state !== 'MERGED') {
            await this.progress(id, key, { merge: 'unknown' });
            return this.pause(id, 'Bitbucket has not confirmed the merge. Resume to reconcile its status.');
          }
          await this.confirmMerged(id, key, merged, client);
        } catch (error) {
          const confirmed = this.binding(id).operation?.items.find(item => item.prKey === key)?.merge === 'merged';
          await this.progress(id, key, { ...(confirmed ? {} : { merge: unknownFailure(error) ? 'unknown' as const : 'failed' as const }), phase: undefined, error: message(error) });
          return this.pause(id, message(error));
        }
      } catch (error) {
        const current = this.binding(id).operation!.items.find(i => i.prKey === key)!;
        await this.progress(id, key, { ...(current.approval !== 'approved' ? { approval: 'failed' as const } : {}), error: message(error) });
        return this.pause(id, message(error));
      }
    }
    return this.state.updateReview(id, r => { r.operation!.state = 'complete'; r.operation!.error = undefined; r.operation!.updatedAt = new Date().toISOString(); for (const item of r.operation!.items) delete item.phase; });
  }
}
