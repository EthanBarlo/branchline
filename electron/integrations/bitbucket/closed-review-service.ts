import type { ClosedReviewCheck, PullRequest } from '../../../shared/integrations';
import { isMergeComplete } from '../../../shared/integrations';
import type { ReviewStore } from '../../reviews/review-store';
import type { IntegrationStore } from '../integration-store';
import type { BitbucketClient } from './bitbucket-client';
import { mapConcurrent } from '../concurrency';

/** Verifies remote closure; the integration coordinator owns locks and durable removal. */
export class ClosedReviewService {
  constructor(
    private readonly reviews: ReviewStore,
    private readonly state: IntegrationStore,
    private readonly client: (connectionId: string) => BitbucketClient,
    private readonly removedName: (reviewId: string) => string | undefined,
  ) {}

  summary(id: string): ClosedReviewCheck {
    const review = this.reviews.getState().reviews.find((review) => review.id === id),
      binding = this.state.review(id);
    const commentIds = new Set([
      ...(review?.comments.map((comment) => comment.id) ?? []),
      ...Object.keys(binding?.publications ?? {}),
    ]);
    const unpublishedComments = [...commentIds].filter((commentId) => {
      const comment = review?.comments.find((comment) => comment.id === commentId),
        publication = binding?.publications[commentId];
      if (!publication) return !!comment;
      if (publication.state !== 'synced')
        return (
          !!comment ||
          !!publication.remoteId ||
          ['sending', 'unknown', 'conflict'].includes(publication.state)
        );
      const acknowledged = publication.acknowledged;
      return comment
        ? !acknowledged ||
            acknowledged.deleted ||
            comment.body !== acknowledged.body ||
            comment.resolved !== acknowledged.resolved
        : !!publication.remoteId && !acknowledged?.deleted;
    }).length;
    return {
      reviewId: id,
      name: review?.name ?? this.removedName(id) ?? 'Review unavailable',
      status: 'unavailable',
      unpublishedComments,
      pullRequests:
        binding?.pullRequests.map((pr) => ({
          repositoryPath: pr.repository.relativePath,
          repoSlug: pr.repository.repoSlug,
          id: pr.id,
          url: pr.url,
          state: 'UNCHECKED',
        })) ?? [],
    };
  }
  async inspect(id: string, automatic = false): Promise<ClosedReviewCheck> {
    const result = this.summary(id),
      review = this.reviews.getState().reviews.find((review) => review.id === id),
      binding = this.state.review(id);
    const blocked = (reason: string): ClosedReviewCheck => ({ ...result, status: 'blocked', reason });
    if (!review) return { ...result, reason: 'This review is no longer saved in Branchline.' };
    if (!review.remote || review.kind === 'current')
      return blocked('Only saved Bitbucket reviews can be removed by this check.');
    if (!binding?.pullRequests.length)
      return blocked(
        'This review has missing Bitbucket metadata. Open it to recover its repository links before removing it.',
      );
    const operation = binding.operation;
    const unfinishedOperation =
      operation &&
      (operation.state !== 'complete' || (operation.action === 'merge' && !isMergeComplete(binding)));
    if (
      operation?.state === 'running' ||
      operation?.items.some((item) => item.pointerState && item.pointerState !== 'ready')
    ) {
      return blocked(
        'This review has an unfinished approval, merge or branch cleanup. Open the review and resume or reconcile that operation first.',
      );
    }
    let client: BitbucketClient;
    try {
      client = this.client(binding.connectionId);
    } catch (error) {
      return {
        ...result,
        reason: `Reconnect this review’s original Bitbucket account and check again. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const failures: string[] = [];
    const freshPRs = new Map<string, PullRequest>();
    await mapConcurrent(binding.pullRequests, 4, async (saved, index) => {
      const item = result.pullRequests[index];
      try {
        const fresh = await client.getPullRequest(saved.repository, saved.id);
        if (
          fresh.id !== saved.id ||
          fresh.repository.relativePath !== saved.repository.relativePath ||
          fresh.repository.workspace.toLowerCase() !== saved.repository.workspace.toLowerCase() ||
          fresh.repository.repoSlug.toLowerCase() !== saved.repository.repoSlug.toLowerCase() ||
          (saved.repository.uuid && fresh.repository.uuid && saved.repository.uuid !== fresh.repository.uuid)
        )
          throw new Error('Bitbucket returned a different repository or PR identity.');
        if (
          fresh.sourceBranch !== saved.sourceBranch ||
          fresh.targetBranch !== saved.targetBranch ||
          fresh.unsupportedReason
        )
          throw new Error('The pull request branch comparison changed. Reopen and review its current scope.');
        item.state = fresh.state;
        freshPRs.set(saved.repository.relativePath, fresh);
        if (!['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(fresh.state))
          failures.push(
            `${item.repoSlug} #${item.id}: Bitbucket returned an unrecognized PR state (${fresh.state || 'empty'}).`,
          );
      } catch (error) {
        item.state = 'UNAVAILABLE';
        failures.push(
          `${item.repoSlug} #${item.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    if (failures.length)
      return {
        ...result,
        reason: `${failures.join(' ')} This review was kept; check the account’s access and try again.`,
      };
    if (result.pullRequests.some((pr) => pr.state === 'OPEN'))
      return { ...result, status: 'open', reason: 'At least one PR in this review is still open.' };
    const unfinished: string[] = [];
    const rows = [...(binding.repositories ?? [])];
    if (binding.repositories || automatic)
      for (const pr of binding.pullRequests) {
        if (!rows.some((row) => row.repository.relativePath === pr.repository.relativePath))
          rows.push({
            repository: pr.repository,
            sourceBranch: pr.sourceBranch,
            targetBranch: pr.targetBranch,
            sourceHash: pr.sourceHash,
            targetHash: pr.targetHash,
            mergeBaseHash: pr.mergeBaseHash,
            status: 'pull-request',
            prId: pr.id,
          });
      }
    const absentSources = new Set<string>();
    await mapConcurrent(rows, 4, async (row) => {
      const path = row.repository.relativePath,
        label = path === '.' ? row.repository.repoSlug : path;
      try {
        await client.getRepository(row.repository);
        const linked = freshPRs.get(path);
        if (row.prId && (!linked || linked.id !== row.prId))
          throw new Error('The saved PR link is incomplete. Refresh this review to recover it.');
        if (
          linked &&
          (linked.repository.workspace.toLowerCase() !== row.repository.workspace.toLowerCase() ||
            linked.repository.repoSlug.toLowerCase() !== row.repository.repoSlug.toLowerCase() ||
            linked.sourceBranch !== row.sourceBranch ||
            linked.targetBranch !== row.targetBranch)
        )
          throw new Error(
            'The saved repository comparison no longer matches its PR. Reopen the review to recover its scope.',
          );
        const candidates = await client.findPullRequests(row.repository, row.sourceBranch);
        const current = await mapConcurrent(candidates, 4, async (candidate) => {
          const pr = await client.getPullRequest(row.repository, candidate.id);
          if (
            pr.id !== candidate.id ||
            pr.repository.relativePath !== path ||
            pr.repository.workspace.toLowerCase() !== row.repository.workspace.toLowerCase() ||
            pr.repository.repoSlug.toLowerCase() !== row.repository.repoSlug.toLowerCase() ||
            (row.repository.uuid && pr.repository.uuid && row.repository.uuid !== pr.repository.uuid) ||
            pr.sourceBranch !== row.sourceBranch ||
            pr.unsupportedReason ||
            !['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(pr.state)
          )
            throw new Error(
              'The branch PR lookup returned an unverified identity or state. Refresh to retry.',
            );
          return pr;
        });
        if (current.some((pr) => pr.state === 'OPEN')) {
          unfinished.push(
            `${label}: a PR for this branch is still open. Refresh or open that PR before removing this group.`,
          );
          return;
        }
        const source = await client.getBranch(row.repository, row.sourceBranch);
        if (!source) absentSources.add(path);
        if (source && row.sourceHash && source.hash !== row.sourceHash) {
          unfinished.push(
            `${label}: the source branch contains a different revision. Refresh and review the new work.`,
          );
          return;
        }
        if (linked) {
          if (row.creation) {
            unfinished.push(`${label}: PR creation needs attention. Refresh to reconcile it.`);
            return;
          }
          if (source && row.cleanup && !['deleted', 'skipped'].includes(row.cleanup.state))
            unfinished.push(`${label}: branch cleanup is unfinished. Resume the operation first.`);
          return;
        }
        const capturedHead = row.sourceHash ?? row.creation?.sourceHash;
        const hadChanges =
          row.status === 'changes' ||
          !!row.creation ||
          (!!capturedHead && capturedHead !== row.mergeBaseHash);
        if (hadChanges && capturedHead) {
          const closed = (
            await client.findPullRequests(row.repository, row.sourceBranch, [
              'MERGED',
              'DECLINED',
              'SUPERSEDED',
            ])
          ).filter(
            (pr) =>
              pr.sourceBranch === row.sourceBranch &&
              pr.targetBranch === row.targetBranch &&
              pr.sourceHash === capturedHead &&
              !pr.unsupportedReason,
          );
          if (closed.length === 1) {
            const confirmed = await client.getPullRequest(row.repository, closed[0].id);
            if (
              confirmed.id !== closed[0].id ||
              confirmed.repository.relativePath !== path ||
              confirmed.repository.workspace.toLowerCase() !== row.repository.workspace.toLowerCase() ||
              confirmed.repository.repoSlug.toLowerCase() !== row.repository.repoSlug.toLowerCase() ||
              (row.repository.uuid &&
                confirmed.repository.uuid &&
                row.repository.uuid !== confirmed.repository.uuid) ||
              confirmed.sourceHash !== capturedHead ||
              confirmed.sourceBranch !== row.sourceBranch ||
              confirmed.targetBranch !== row.targetBranch ||
              confirmed.unsupportedReason ||
              !['MERGED', 'DECLINED', 'SUPERSEDED'].includes(confirmed.state)
            )
              throw new Error('The matching closed PR changed while checking it. Refresh to retry.');
            result.pullRequests.push({
              repositoryPath: path,
              repoSlug: row.repository.repoSlug,
              id: confirmed.id,
              url: confirmed.url,
              state: confirmed.state,
            });
            if (source && row.cleanup && !['deleted', 'skipped'].includes(row.cleanup.state))
              unfinished.push(`${label}: branch cleanup is unfinished. Resume the operation first.`);
            return;
          }
          if (closed.length > 1) {
            unfinished.push(
              `${label}: multiple closed PRs match this work. Open the review to reconcile its PR links.`,
            );
            return;
          }
        }
        if (row.creation) {
          unfinished.push(
            `${label}: PR creation is still unconfirmed. Reconcile it before removing the review.`,
          );
          return;
        }
        // Missing refs can retire a captured empty comparison, but never prove
        // that previously unique commits were merged.
        if (!source && !hadChanges) return;
        const target = await client.getBranch(row.repository, row.targetBranch);
        const head = source?.hash ?? capturedHead;
        if (target && head && (await client.mergeBase(row.repository, head, target.hash)) === head) {
          if (source && row.cleanup && !['deleted', 'skipped'].includes(row.cleanup.state))
            unfinished.push(`${label}: branch cleanup is unfinished. Resume the operation first.`);
          return;
        }
        unfinished.push(
          `${label}: ${!source ? 'the source branch is missing, but its captured changes have not been confirmed merged' : !target ? `target branch “${row.targetBranch}” is missing, so its changes cannot be verified` : 'the branch still contains changes without a closed PR'}. This review was kept.`,
        );
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (failures.length)
      return { ...result, reason: `${failures.join(' ')} This review was kept; refresh to retry.` };
    if (
      unfinishedOperation &&
      (!rows.length ||
        absentSources.size !== rows.length ||
        operation.items.some(
          (item) =>
            !result.pullRequests.some(
              (pr) => `${pr.repositoryPath}#${pr.id}` === item.prKey && pr.state === 'MERGED',
            ),
        ))
    ) {
      return blocked(
        'This review has an unfinished approval, merge or branch cleanup. Open the review and resume or reconcile that operation first.',
      );
    }
    if (unfinished.length) return blocked(unfinished.join(' '));
    if (automatic && result.unpublishedComments)
      return blocked(
        'This review is closed in Bitbucket, but unpublished feedback is still saved in Branchline. Remove or publish that feedback, or use Clean up closed Bitbucket reviews to remove it explicitly.',
      );
    return { ...result, status: 'closed' };
  }
}
