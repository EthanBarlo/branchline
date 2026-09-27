import type {
  BranchReviewRepository,
  FeedbackPreview,
  MergeOperation,
  MergePreview,
  PullRequest,
  RemoteReviewState,
} from '../../../../shared/integrations';
import { isMergeComplete, pullRequestKey } from '../../../../shared/integrations';

export type RemoteReviewAction = 'publish' | 'approve' | 'merge';
interface RemoteReviewStateInput {
  remote: RemoteReviewState | null;
  feedback: FeedbackPreview | null;
  merge: MergePreview | null;
  dialog: RemoteReviewAction | null;
  busy: boolean;
  loading: boolean;
}

function repositoryNeedsCleanup(
  row: BranchReviewRepository,
  pullRequests: PullRequest[],
  operation?: MergeOperation,
): boolean {
  const pr = pullRequests.find(
    (candidate) =>
      candidate.repository.relativePath === row.repository.relativePath && candidate.id === row.prId,
  );
  const item = pr && operation?.items.find((candidate) => candidate.prKey === pullRequestKey(pr));
  if (pr && item?.merge !== 'merged' && pr.state !== 'MERGED') return false;
  if (!pr && !['no-changes', 'missing-branch'].includes(row.status)) return false;
  return !['deleted', 'skipped'].includes(row.cleanup?.state || item?.cleanup || '');
}

export function remoteReviewState({
  remote,
  feedback,
  merge,
  dialog,
  busy,
  loading,
}: RemoteReviewStateInput) {
  const operation = remote?.operation || merge?.operation;
  const visibleOperation = operation?.action === dialog ? operation : undefined;
  const publishable =
    !!feedback &&
    !feedback.blockers.length &&
    feedback.items.some((item) => item.state !== 'unknown' && item.state !== 'conflict');
  // A task can finish in Bitbucket while Branchline is paused. Resuming still
  // needs to reconcile its cleanup and close the review when every PR is merged.
  const pendingRepositories = merge?.repositories || remote?.repositories || [];
  const needsPullRequest = pendingRepositories.some((row) => row.status === 'changes' && !row.prId);
  const pendingPullRequests = merge?.pullRequests || remote?.pullRequests || [];
  const needsCleanup =
    pendingRepositories.some((row) => repositoryNeedsCleanup(row, pendingPullRequests, operation)) ||
    (operation?.action === 'merge' &&
      operation.items.some((item) => item.merge === 'merged' && item.cleanup !== 'deleted'));
  const readyToFinish = isMergeComplete(remote);
  const resumeNeeded =
    operation?.state === 'paused' ||
    (operation?.action === 'merge' && operation.state === 'complete' && !readyToFinish);
  const canMerge =
    !!merge &&
    !merge.blockers.length &&
    (readyToFinish ||
      needsPullRequest ||
      needsCleanup ||
      merge.pullRequests.some((pr) => pr.state === 'OPEN') ||
      (visibleOperation?.action === 'merge' && resumeNeeded));
  const canApprove =
    !!merge &&
    !merge.blockers.length &&
    (needsPullRequest || merge.pullRequests.some((pr) => pr.state === 'OPEN' && !pr.draft));
  const completed =
    dialog === 'approve' &&
    operation?.state === 'complete' &&
    operation.action === dialog &&
    !needsPullRequest;
  const progressPullRequests = busy
    ? remote?.pullRequests || merge?.pullRequests || []
    : merge?.pullRequests || remote?.pullRequests || [];
  const repositoryProgress =
    busy || loading
      ? remote?.repositories || merge?.repositories
      : merge?.repositories || remote?.repositories;

  return {
    operation,
    visibleOperation,
    publishable,
    readyToFinish,
    resumeNeeded,
    canMerge,
    canApprove,
    completed,
    progressPullRequests,
    repositoryProgress,
  };
}
export type RemoteReviewView = ReturnType<typeof remoteReviewState>;
