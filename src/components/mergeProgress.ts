import type { BranchReviewRepository, MergeOperation, MergeProgress, PullRequest } from '../../shared/integrations';

type ProgressIcon = 'spinner' | 'check' | 'skip' | 'warning' | 'pause' | 'circle' | 'pr';
type ProgressTone = 'active' | 'complete' | 'warning' | 'waiting';
interface ProgressStatus { label: string; tone: ProgressTone; icon: ProgressIcon; }
export interface RepositoryMergeProgress {
  status: ProgressStatus;
  finished: boolean;
  detail?: string;
  error?: string;
  cleanup?: NonNullable<BranchReviewRepository['cleanup']>['state'];
}

const active = (label: string): ProgressStatus => ({ label, tone: 'active', icon: 'spinner' });
const warning = (label: string, icon: ProgressIcon = 'warning'): ProgressStatus => ({ label, tone: 'warning', icon });
const complete = (label: string): ProgressStatus => ({ label, tone: 'complete', icon: 'check' });
const waiting = (label: string, icon: ProgressIcon = 'circle'): ProgressStatus => ({ label, tone: 'waiting', icon });

/** Provider subchecks stay within this repository's workflow stage. */
export function repositoryMergeProgress({ row, pr, item, operation, action, checking = false, running = false }: {
  row: BranchReviewRepository; pr?: PullRequest; item?: MergeProgress; operation?: MergeOperation;
  action: 'approve' | 'merge'; checking?: boolean; running?: boolean;
}): RepositoryMergeProgress {
  const isRunning = operation ? operation.state === 'running' : running;
  const merged = item?.merge === 'merged' || pr?.state === 'MERGED';
  const cleanup = action === 'merge' ? row.cleanup?.state ?? item?.cleanup : undefined;
  const cleanupFinished = cleanup === 'deleted' || cleanup === 'skipped';
  const noChanges = !pr && (row.status === 'no-changes' || row.status === 'missing-branch');
  const skipped = noChanges ? row.status === 'no-changes' ? 'Skipped · no changes' : 'Skipped · branch missing'
    : merged && (item?.skipped || !item) ? 'Skipped · already merged' : undefined;
  const error = row.check?.error || item?.error || row.creation?.error || row.cleanup?.error || row.error;
  const result = (status: ProgressStatus, finished = false, detail?: string): RepositoryMergeProgress => ({ status, finished, detail, cleanup, error });

  // Failure receipts must remain visible while other workers are still running.
  if (row.creation?.state === 'unknown') return result(warning('PR creation unconfirmed', 'pause'));
  if (row.creation?.state === 'failed') return result(warning('PR creation failed'));
  const retryingKnownFailure = isRunning && !!item?.phase && !item.error;
  const approvalFailed = item?.approval === 'failed' && !(action === 'merge' && item.merge === 'merged');
  if ((item?.merge === 'failed' || approvalFailed) && !retryingKnownFailure) return result(warning('Failed'));
  if (item?.pointerState === 'review') return result(warning('Needs review', 'pause'));
  if (item?.merge === 'unknown') return result(warning('Awaiting confirmation', 'pause'));
  if (cleanup === 'retained' || cleanup === 'unknown') return result(warning(merged ? 'Merged · cleanup paused' : 'Cleanup paused', 'pause'));
  if (row.check?.state === 'failed') return result(warning('Check failed'));
  if (row.status === 'unavailable') return result(warning('Unavailable'));
  if (error) return result(warning('Paused', 'pause'));

  // Successful cleanup is durable even when another repository starts checking.
  if (action === 'merge' && (merged || noChanges) && cleanupFinished) return result(complete('Done'), true, skipped);
  if (action === 'approve' && item?.approval === 'approved' && !item.phase) return result(complete('Approved'), true);
  if (action === 'approve' && noChanges && operation?.state === 'complete') return result({ label: skipped!, tone: 'complete', icon: 'skip' }, true);

  if (item?.merge === 'sending' || item?.merge === 'merging') return result(isRunning ? active('Merging…') : warning('Awaiting confirmation', 'pause'));
  if (row.creation?.state === 'sending') return result(isRunning ? active('Creating PR…') : warning('PR creation unconfirmed', 'pause'));
  if (isRunning) {
    if (action === 'merge' && (cleanup === 'checking' || cleanup === 'sending' || item?.phase === 'cleanup')) return result(active('Deleting branch…'));
    if (action === 'merge' && merged) return result(waiting('Merged · waiting for other merges', 'check'));
    if (item?.phase === 'updating-pointers') return result(active('Updating pointers…'));
    if (item?.phase === 'approving') return result(active('Approving…'));
    if (item?.phase === 'merging') return result(active('Merging…'));
    if (action === 'merge' && noChanges) return result(waiting('Waiting for merges', 'skip'));
    return result(active('Checking…'));
  }
  if (operation?.state === 'paused') return result(warning(merged ? 'Merged · cleanup paused' : 'Paused', 'pause'));
  if (checking) return result(active('Checking…'));
  if (merged) return result(waiting(skipped || 'Merged', skipped ? 'skip' : 'check'));
  if (noChanges) return result(waiting(skipped!, 'skip'));
  if (!pr && row.status === 'changes') return result(waiting(action === 'merge' ? 'Create PR, then merge' : 'Create PR, then approve', 'pr'));
  return result(waiting('Ready'));
}
