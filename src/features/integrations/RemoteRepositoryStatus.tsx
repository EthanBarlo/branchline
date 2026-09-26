import * as stylex from '@stylexjs/stylex';
import {
  Check,
  CirclePause,
  GitPullRequest,
  LoaderCircle,
  SkipForward,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { BranchReviewRepository, PullRequest, RemoteRepositoryLoad } from '../../../shared/integrations';
import { colors, spacing, typeScale } from '../../tokens.stylex';

export function repositoryRows(
  pullRequests: PullRequest[],
  repositories?: BranchReviewRepository[],
): BranchReviewRepository[] {
  const rows = [...(repositories || [])];
  for (const pr of pullRequests) {
    const index = rows.findIndex((row) => row.repository.relativePath === pr.repository.relativePath);
    if (index < 0)
      rows.push({
        repository: pr.repository,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        status: 'pull-request',
        prId: pr.id,
      });
    else rows[index] = { ...rows[index], prId: pr.id };
  }
  return rows.sort((a, b) => {
    const depth = (row: BranchReviewRepository) =>
      row.repository.relativePath === '.' ? 0 : row.repository.relativePath.split('/').length;
    return depth(b) - depth(a) || a.repository.relativePath.localeCompare(b.repository.relativePath);
  });
}

export function branchStatus(row: BranchReviewRepository, pr?: PullRequest) {
  if (pr?.state === 'MERGED') return { label: 'Merged', tone: 'complete', icon: Check };
  if (pr?.state === 'DECLINED') return { label: 'Declined', tone: 'waiting', icon: SkipForward };
  if (pr?.state === 'SUPERSEDED') return { label: 'Closed', tone: 'waiting', icon: SkipForward };
  if (row.creation?.state === 'sending') return { label: 'Creating PR…', tone: 'active', icon: LoaderCircle };
  if (row.creation?.state === 'unknown')
    return { label: 'PR creation unconfirmed', tone: 'warning', icon: CirclePause };
  if (row.creation?.state === 'failed')
    return { label: 'PR creation failed', tone: 'warning', icon: TriangleAlert };
  if (row.status === 'unavailable') return { label: 'Unavailable', tone: 'warning', icon: TriangleAlert };
  if (row.status === 'missing-branch') return { label: 'Branch missing', tone: 'waiting', icon: SkipForward };
  if (row.status === 'no-changes')
    return {
      label: 'No changes',
      tone: row.cleanup?.state === 'deleted' ? 'complete' : 'waiting',
      icon: SkipForward,
    };
  if (row.status === 'changes')
    return { label: 'Changes without a PR', tone: 'waiting', icon: GitPullRequest };
  return { label: 'PR exists', tone: 'complete', icon: GitPullRequest };
}

export function CleanupStatus({
  state,
}: {
  state?: NonNullable<BranchReviewRepository['cleanup']>['state'];
}) {
  if (!state || ['pending', 'checking', 'sending'].includes(state)) return null;
  return (
    <span
      {...stylex.props(styles.mergeCleanup, state === 'deleted' && styles.mergeCleanupDeleted)}
      title={
        state === 'deleted'
          ? 'Remote source branch deleted'
          : state === 'retained'
            ? 'Remote source branch still exists'
            : state === 'skipped'
              ? 'No source branch to delete'
              : 'Remote source branch deletion could not be confirmed'
      }
    >
      {state === 'deleted' ? (
        <Trash2 size={11} aria-hidden="true" {...stylex.props(styles.mergeCleanupIcon)} />
      ) : state === 'skipped' ? (
        <SkipForward size={11} aria-hidden="true" {...stylex.props(styles.mergeCleanupIcon)} />
      ) : (
        <TriangleAlert size={11} aria-hidden="true" {...stylex.props(styles.mergeCleanupIcon)} />
      )}
      {state === 'deleted'
        ? 'Deleted'
        : state === 'retained'
          ? 'Retained'
          : state === 'skipped'
            ? 'Cleanup skipped'
            : 'Deletion unconfirmed'}
    </span>
  );
}

export function loadStatus(load: RemoteRepositoryLoad) {
  return load.phase === 'ready'
    ? { label: 'Ready to review', tone: 'complete', icon: Check }
    : load.phase === 'failed'
      ? { label: 'Could not load', tone: 'warning', icon: TriangleAlert }
      : {
          label:
            load.phase === 'queued'
              ? 'Queued…'
              : load.phase === 'files'
                ? 'Loading files…'
                : 'Checking branch…',
          tone: 'active',
          icon: LoaderCircle,
        };
}

const styles = stylex.create({
  mergeCleanup: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    color: colors.warningText,
    fontSize: typeScale.caption,
    lineHeight: 1.4,
  },
  mergeCleanupDeleted: { color: colors.successText },
  mergeCleanupIcon: { flexShrink: '0' },
});
