import * as stylex from '@stylexjs/stylex';
import { Check, CirclePause, GitMerge, Send } from 'lucide-react';
import type { RemoteRepositoryLoad, RemoteReviewState } from '../../../../shared/integrations';
import type { Review } from '../../../../shared/types';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/Spinner';
import { BranchReviewRepositories } from './BranchReviewRepositories';
import { RemoteReviewDialog } from './RemoteReviewDialog';
import { useRemoteReviewActions } from './useRemoteReviewActions';

const styles = stylex.create({
  remoteControls: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: { default: 6, '@media (max-width: 1150px)': 4 },
    flexShrink: '0',
  },
  remoteActions: {
    display: 'flex',
    alignItems: 'center',
    gap: { default: 6, '@media (max-width: 1150px)': 4 },
    flexShrink: '0',
  },
  remoteActionButton: {
    minHeight: '27px',
    height: '27px',
    fontSize: typeScale.small,
    paddingBlock: '0',
    paddingInline: '9px',
    gap: spacing.sm,
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: { default: 'none', ':focus-visible': 'solid' },
    outlineColor: colors.focus,
    outlineOffset: { default: 0, ':focus-visible': 3 },
  },
  remoteCompactButton: {
    width: { default: 'auto', '@media (max-width: 1350px)': 27 },
    padding: { default: '0 9px', '@media (max-width: 1350px)': 0 },
    justifyContent: 'center',
  },
  remoteProgressButton: { color: colors.warningText },
  remoteCompactLabel: { display: { default: 'inline', '@media (max-width: 1350px)': 'none' } },
});

export function RemoteReviewControls({
  review,
  remote,
  onRemote,
  onChanged,
  onReanchor,
  onMergeComplete,
  jiraLink,
  loadingRepositories,
  reviewLoading = false,
}: {
  review: Review;
  remote: RemoteReviewState | null;
  onRemote: (state: RemoteReviewState) => void;
  onChanged: () => Promise<boolean>;
  onReanchor: (commentId: string) => void;
  onMergeComplete: (state: RemoteReviewState) => Promise<void>;
  jiraLink: { key: string; url: string } | null;
  loadingRepositories?: RemoteRepositoryLoad[];
  reviewLoading?: boolean;
}) {
  const actions = useRemoteReviewActions({
    reviewId: review.id,
    remote,
    onRemote,
    onChanged,
    onMergeComplete,
  });
  const {
    preview,
    view: { operation, resumeNeeded, readyToFinish },
  } = actions;
  return (
    <>
      <div
        className={`remote-review-controls ${stylex.props(styles.remoteControls).className}`}
        aria-label="Bitbucket review controls"
      >
        {remote && <BranchReviewRepositories remote={remote} loadingRepositories={loadingRepositories} />}
        <div className={`remote-review-actions ${stylex.props(styles.remoteActions).className}`}>
          {operation && (operation.state !== 'complete' || resumeNeeded || readyToFinish) && (
            <Button
              variant="secondary"
              type="button"
              {...stylex.props(
                styles.remoteActionButton,
                styles.remoteCompactButton,
                styles.remoteProgressButton,
              )}
              aria-label={
                readyToFinish ? 'Finish review' : resumeNeeded ? 'Resume operation' : 'View progress'
              }
              title={
                readyToFinish
                  ? 'Remove the completed review from Branchline'
                  : resumeNeeded
                    ? 'Merge or branch cleanup needs attention. Resume operation.'
                    : 'View operation progress'
              }
              disabled={reviewLoading}
              onClick={() => void preview(operation.action)}
            >
              {readyToFinish ? (
                <Check size={13} />
              ) : resumeNeeded ? (
                <CirclePause size={13} />
              ) : (
                <Spinner size={13} />
              )}
              <span {...stylex.props(styles.remoteCompactLabel)}>
                {readyToFinish ? 'Finish review' : resumeNeeded ? 'Resume operation' : 'View progress'}
              </span>
            </Button>
          )}
          <Button
            variant="secondary"
            {...stylex.props(styles.remoteActionButton, styles.remoteCompactButton)}
            type="button"
            aria-label="Publish feedback"
            disabled={reviewLoading}
            title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Publish feedback'}
            onClick={() => void preview('publish')}
          >
            <Send size={12} />
            <span {...stylex.props(styles.remoteCompactLabel)}>Publish feedback</span>
          </Button>
          <Button
            variant="secondary"
            {...stylex.props(styles.remoteActionButton, styles.remoteCompactButton)}
            type="button"
            aria-label="Approve"
            disabled={reviewLoading}
            title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Approve'}
            onClick={() => void preview('approve')}
          >
            <Check size={13} />
            <span {...stylex.props(styles.remoteCompactLabel)}>Approve</span>
          </Button>
          <Button
            variant="primary"
            {...stylex.props(styles.remoteActionButton)}
            type="button"
            aria-label="Approve and merge"
            disabled={reviewLoading}
            title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Approve and merge'}
            onClick={() => void preview('merge')}
          >
            <GitMerge size={13} />
            <span>Approve and merge</span>
          </Button>
        </div>
      </div>
      <RemoteReviewDialog
        review={review}
        remote={remote}
        jiraLink={jiraLink}
        actions={actions}
        onReanchor={onReanchor}
      />
    </>
  );
}
