import * as stylex from '@stylexjs/stylex';
import { ExternalLink } from 'lucide-react';
import type { RemoteReviewState } from '../../../../shared/integrations';
import type { Review } from '../../../../shared/types';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { DialogFooter, DialogIntroduction } from '../../../ui/Dialog';
import { Spinner } from '../../../ui/Spinner';
import { IntegrationDialog } from '../IntegrationDialog';
import { Problem } from '../IntegrationError';
import { MergeProgressView } from '../MergeProgressView';
import { FeedbackPublication } from './FeedbackPublication';
import { FeedbackPullRequests } from './FeedbackPullRequests';
import type { RemoteReviewActions } from './useRemoteReviewActions';
import type { RemoteReviewAction, RemoteReviewView } from './remoteReviewState';

const styles = stylex.create({
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: '0',
    overflow: 'auto',
  },
  introduction: { maxWidth: '570px', marginBottom: '20px' },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    color: colors.textSubtle,
    fontSize: typeScale.compact,
  },
  note: {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: '10px',
    marginInline: '0',
  },
  pointerPreview: { display: 'block', marginTop: '13px' },
  modalChrome: { flexShrink: '0' },
  mergeJiraButton: { marginRight: 'auto' },
  requestChanges: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '9px',
    marginRight: 'auto',
    maxWidth: '340px',
    fontSize: typeScale.small,
    color: colors.textPrimary,
  },
  requestChangesInput: { accentColor: colors.accent, marginTop: spacing.xxs, flexShrink: '0' },
  requestChangesContent: { display: 'flex', flexDirection: 'column', gap: spacing.xxs },
  requestChangesHint: { color: colors.textQuiet, fontSize: typeScale.caption },
  linkIcon: { flexShrink: '0' },
});

const dialogContent = {
  publish: {
    title: 'Publish feedback',
    introduction:
      'Each comment goes to its file and exact lines in Bitbucket. Missing PRs are created when you publish; drafts remain saved locally.',
  },
  approve: {
    title: 'Approve pull requests',
    introduction:
      'Approve changes across this branch with your connected Bitbucket account. Missing PRs are created for repositories with changes.',
  },
  merge: {
    title: 'Approve and merge',
    introduction:
      'All required pull requests must merge successfully before any source branches are deleted. Repositories without changes wait for that cleanup stage. Progress is saved so you can resume.',
  },
} satisfies Record<RemoteReviewAction, { title: string; introduction: string }>;

function submitLabel(
  action: RemoteReviewAction,
  busy: boolean,
  view: RemoteReviewView,
  requestChanges: boolean,
): string {
  if (busy) return 'Working…';
  if (action === 'publish') return requestChanges ? 'Publish and request changes' : 'Publish to Bitbucket';
  if (view.completed) return 'Complete';
  if (action === 'merge' && view.readyToFinish) return 'Finish review';
  if (view.visibleOperation && view.resumeNeeded) return 'Resume operation';
  return action === 'approve' ? 'Approve pull requests' : 'Approve, merge and delete branches';
}

interface RemoteReviewDialogProps {
  review: Review;
  remote: RemoteReviewState | null;
  jiraLink: { key: string; url: string } | null;
  actions: RemoteReviewActions;
  onReanchor: (commentId: string) => void;
}
export function RemoteReviewDialog({
  review,
  remote,
  jiraLink,
  actions,
  onReanchor,
}: RemoteReviewDialogProps) {
  const {
    dialog,
    feedback,
    merge,
    busy,
    loading,
    error,
    result,
    jiraError,
    requestChanges,
    setRequestChanges,
    preview,
    run,
    openTicket,
    close,
    view,
  } = actions;
  const {
    visibleOperation,
    publishable,
    readyToFinish,
    resumeNeeded,
    canMerge,
    canApprove,
    completed,
    progressPullRequests,
    repositoryProgress,
  } = view;
  if (!dialog) return null;
  const content = dialogContent[dialog];
  const canSubmit = { publish: publishable, merge: canMerge, approve: canApprove }[dialog];
  return (
    <IntegrationDialog title={content.title} busy={busy || loading} onClose={close}>
      <div {...stylex.props(styles.body)}>
        <DialogIntroduction {...stylex.props(styles.introduction)}>{content.introduction}</DialogIntroduction>
        {loading && dialog === 'publish' && (
          <p className={`integration-loading ${stylex.props(styles.loading).className}`} role="status">
            <Spinner size={15} />
            Checking Bitbucket for changes…
          </p>
        )}
        {error && <Problem>{error}</Problem>}
        {result && (
          <p {...stylex.props(styles.note)} role="status">
            {result}
          </p>
        )}
        {dialog === 'publish' && <FeedbackPullRequests pullRequests={remote?.pullRequests || []} />}
        {dialog === 'publish' && feedback && (
          <>
            <div className="feedback-publication-list">
              {feedback.items.map((item) => (
                <FeedbackPublication
                  key={item.commentId}
                  item={item}
                  review={review}
                  remote={remote}
                  actions={actions}
                  onReanchor={onReanchor}
                />
              ))}
            </div>
            {!feedback.items.length && <p {...stylex.props(styles.note)}>No feedback to publish.</p>}
            {feedback.blockers.map((blocker, index) => (
              <Problem key={index}>{blocker}</Problem>
            ))}
          </>
        )}
        {dialog !== 'publish' && (
          <>
            <MergeProgressView
              pullRequests={progressPullRequests}
              repositories={repositoryProgress}
              operation={visibleOperation}
              action={dialog}
              checking={loading}
              running={busy}
            />
            {merge && (
              <>
                {dialog === 'merge' && !readyToFinish && (
                  <p {...stylex.props(styles.note, styles.pointerPreview)}>
                    Submodule pointers:{' '}
                    {merge.updateSubmodulePointers
                      ? 'update after children merge; review before parent merge'
                      : 'leave unchanged'}
                  </p>
                )}
                {merge.warnings.map((warning, index) => (
                  <p {...stylex.props(styles.note)} key={index}>
                    {warning}
                  </p>
                ))}
                {merge.blockers.map((blocker, index) => (
                  <Problem key={index}>{blocker}</Problem>
                ))}
              </>
            )}
            {jiraError && <Problem>{jiraError}</Problem>}
          </>
        )}
      </div>
      <DialogFooter {...stylex.props(styles.modalChrome)}>
        {dialog === 'publish' && (
          <label {...stylex.props(styles.requestChanges)}>
            <input
              {...stylex.props(styles.requestChangesInput)}
              type="checkbox"
              checked={requestChanges}
              disabled={busy}
              onChange={(event) => setRequestChanges(event.target.checked)}
            />
            <span {...stylex.props(styles.requestChangesContent)}>
              Request changes on the pull request
              <span {...stylex.props(styles.requestChangesHint)}>
                Applies to PRs that receive new or edited feedback and replaces your approval.
              </span>
            </span>
          </label>
        )}
        {dialog !== 'publish' && jiraLink && (
          <Button
            variant="secondary"
            {...stylex.props(styles.mergeJiraButton)}
            title={`Open ${jiraLink.key} to update its status in Jira`}
            onClick={() => void openTicket()}
          >
            <ExternalLink size={12} {...stylex.props(styles.linkIcon)} />
            Open in Jira
          </Button>
        )}
        <Button disabled={busy || loading} onClick={close}>
          {visibleOperation && resumeNeeded ? 'Return to review' : 'Close'}
        </Button>
        {dialog === 'publish' && (
          <Button disabled={busy || loading} onClick={() => void preview('publish')}>
            Refresh delivery status
          </Button>
        )}
        <Button
          variant="primary"
          disabled={busy || loading || !!completed || !canSubmit}
          onClick={() => void run()}
        >
          {busy && <Spinner size={13} />}
          {submitLabel(dialog, busy, view, requestChanges)}
        </Button>
      </DialogFooter>
    </IntegrationDialog>
  );
}
