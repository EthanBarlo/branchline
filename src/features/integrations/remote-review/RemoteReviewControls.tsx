import * as stylex from '@stylexjs/stylex';
import { Check, CirclePause, ExternalLink, GitMerge, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  FeedbackPreview,
  MergePreview,
  RemoteRepositoryLoad,
  RemoteReviewState,
} from '../../../../shared/integrations';
import { isMergeComplete, pullRequestKey } from '../../../../shared/integrations';
import type { Review } from '../../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { DialogFooter, DialogIntroduction } from '../../../ui/Dialog';
import { TextInput } from '../../../ui/Field';
import { Spinner } from '../../../ui/Spinner';
import { flushPendingComments } from '../../reviews/diff/commentAutosave';
import { IntegrationDialog, IntegrationLink, Problem, message } from '../IntegrationPrimitives';

import { BranchReviewRepositories } from './BranchReviewRepositories';
import { FeedbackPullRequests } from './FeedbackPullRequests';
import { MergeProgressView } from '../MergeProgressView';
const human = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');
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
  const [dialog, setDialog] = useState<'publish' | 'approve' | 'merge' | null>(null);
  const [feedback, setFeedback] = useState<FeedbackPreview | null>(null);
  const [merge, setMerge] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [jiraError, setJiraError] = useState('');
  const [unknownIds, setUnknownIds] = useState<Record<string, string>>({});
  const [checkedDelivery, setCheckedDelivery] = useState<Record<string, boolean>>({});
  const latest = useRef({ onRemote, onChanged });
  latest.current = { onRemote, onChanged };
  useEffect(() => {
    return window.reviewAPI.onRemoteReviewChanged((event) => {
      if (event.reviewId === review.id) {
        latest.current.onRemote(event.state);
      }
    });
  }, [review.id]);
  async function preview(action: 'publish' | 'approve' | 'merge') {
    setDialog(action);
    setLoading(true);
    setError('');
    setResult('');
    setJiraError('');
    setFeedback(null);
    setMerge(null);
    try {
      await flushPendingComments();
      if (action === 'merge' && isMergeComplete(remote)) {
        // Completion is already confirmed. Retrying local removal must also
        // work after the server saved it but its response was lost.
        setMerge({
          pullRequests: remote!.pullRequests,
          repositories: remote!.repositories,
          operation: remote!.operation,
          blockers: [],
          warnings: [],
          updateSubmodulePointers: false,
        });
        return;
      }
      if (action === 'publish') {
        if (!(await onChanged())) {
          setDialog(null);
          return;
        }
        setFeedback(await window.reviewAPI.previewFeedback(review.id));
      } else setMerge(await window.reviewAPI.previewMerge(review.id, action));
      const state = await window.reviewAPI.getRemoteReview(review.id);
      if (state) onRemote(state);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }
  async function run() {
    if (!dialog || busy) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      await flushPendingComments();
      if (dialog === 'merge' && isMergeComplete(remote)) {
        await onMergeComplete(remote!);
        setDialog(null);
        return;
      }
      const state =
        dialog === 'publish'
          ? await window.reviewAPI.publishFeedback(review.id)
          : await window.reviewAPI.runPullRequestAction(review.id, dialog);
      onRemote(state);
      if (dialog === 'merge' && isMergeComplete(state)) {
        await onMergeComplete(state);
        setDialog(null);
        return;
      }
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      if (dialog === 'publish') {
        const next = await window.reviewAPI.previewFeedback(review.id);
        setFeedback(next);
        setResult(
          next.items.length
            ? 'Completed items are saved. Review the remaining items below.'
            : 'Feedback published to Bitbucket.',
        );
      } else {
        setMerge(await window.reviewAPI.previewMerge(review.id, dialog));
      }
    } catch (reason) {
      setError(message(reason));
      const state = await window.reviewAPI.getRemoteReview(review.id).catch(() => null);
      if (state) onRemote(state);
    } finally {
      setBusy(false);
    }
  }
  async function conflict(commentId: string, choice: 'local' | 'remote') {
    setBusy(true);
    setError('');
    try {
      await flushPendingComments();
      await window.reviewAPI.resolveCommentConflict(review.id, commentId, choice);
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      setFeedback(await window.reviewAPI.previewFeedback(review.id));
      const state = await window.reviewAPI.getRemoteReview(review.id);
      if (state) onRemote(state);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function reconcileUnknown(commentId: string, remoteId: number | null) {
    setBusy(true);
    setError('');
    try {
      onRemote(await window.reviewAPI.resolveUnknownPublication(review.id, commentId, remoteId));
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      setFeedback(await window.reviewAPI.previewFeedback(review.id));
      setCheckedDelivery((previous) => ({ ...previous, [commentId]: false }));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function openTicket() {
    setJiraError('');
    try {
      await window.reviewAPI.openJiraTicket(review.id);
    } catch (reason) {
      setJiraError(message(reason));
    }
  }
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
    pendingRepositories.some((row) => {
      const pr = pendingPullRequests.find(
        (pr) => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId,
      );
      const item = pr && operation?.items.find((item) => item.prKey === pullRequestKey(pr));
      if (pr && item?.merge !== 'merged' && pr.state !== 'MERGED') return false;
      if (!pr && !['no-changes', 'missing-branch'].includes(row.status)) return false;
      return !['deleted', 'skipped'].includes(row.cleanup?.state || item?.cleanup || '');
    }) ||
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
      {dialog && (
        <IntegrationDialog
          title={
            dialog === 'publish'
              ? 'Publish feedback'
              : dialog === 'approve'
                ? 'Approve pull requests'
                : 'Approve and merge'
          }
          busy={busy || loading}
          onClose={() => setDialog(null)}
        >
          <div {...stylex.props(styles.body)}>
            <DialogIntroduction {...stylex.props(styles.introduction)}>
              {dialog === 'publish'
                ? 'Each comment goes to its file and exact lines in Bitbucket. Missing PRs are created when you publish; drafts remain saved locally.'
                : dialog === 'approve'
                  ? 'Approve changes across this branch with your connected Bitbucket account. Missing PRs are created for repositories with changes.'
                  : 'All required pull requests must merge successfully before any source branches are deleted. Repositories without changes wait for that cleanup stage. Progress is saved so you can resume.'}
            </DialogIntroduction>
            {loading && dialog === 'publish' && (
              <p className={`integration-loading ${stylex.props(styles.loading).className}`} role="status">
                <Spinner size={15} />
                Checking the branch across all repositories…
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
                    <article
                      className={`feedback-publication ${stylex.props(styles.feedbackPublication).className}`}
                      key={item.commentId}
                    >
                      <div {...stylex.props(styles.feedbackPublicationHeading)}>
                        <code {...stylex.props(styles.feedbackPublicationCode)}>
                          {item.repositoryPath} ·{' '}
                          {item.createsPullRequest ? 'Create PR on publish' : `#${item.prId}`}
                        </code>
                        <span
                          {...stylex.props(
                            styles.publicationStatus,
                            item.state === 'synced' && styles.publicationSynced,
                            ['unknown', 'failed', 'conflict'].includes(item.state) &&
                              styles.publicationWarning,
                          )}
                        >
                          {item.state === 'synced' ? 'Changes to publish' : human(item.state)}
                        </span>
                        <span {...stylex.props(styles.feedbackPublicationAction)}>{human(item.action)}</span>
                      </div>
                      <strong {...stylex.props(styles.feedbackPublicationName)}>
                        {item.path} ·{' '}
                        {item.lineStart
                          ? `L${item.lineStart}${item.lineEnd !== item.lineStart ? `–${item.lineEnd}` : ''}`
                          : 'File comment'}{' '}
                        · {item.side === 'deletions' ? 'Original' : 'New version'}
                      </strong>
                      <p {...stylex.props(styles.feedbackPublicationBody)}>{item.body}</p>
                      {item.error && <Problem>{item.error}</Problem>}
                      {item.state === 'unknown' && (
                        <div {...stylex.props(styles.unknownDelivery)}>
                          <p {...stylex.props(styles.note)}>
                            Delivery is uncertain. Check Bitbucket before deciding whether to retry.
                          </p>
                          {remote?.pullRequests
                            .filter(
                              (pr) =>
                                pr.repository.relativePath === item.repositoryPath && pr.id === item.prId,
                            )
                            .map((pr) => (
                              <IntegrationLink key={pullRequestKey(pr)} url={pr.url} variant="retry">
                                Check PR #{pr.id} in Bitbucket
                                <ExternalLink size={11} {...stylex.props(styles.linkIcon)} />
                              </IntegrationLink>
                            ))}
                          <div {...stylex.props(styles.unknownCommentLink)}>
                            <TextInput
                              {...stylex.props(styles.unknownCommentInput)}
                              type="text"
                              inputMode="numeric"
                              aria-label="Existing Bitbucket comment ID"
                              placeholder="Existing comment ID"
                              value={unknownIds[item.commentId] || ''}
                              disabled={busy}
                              onChange={(event) =>
                                setUnknownIds((previous) => ({
                                  ...previous,
                                  [item.commentId]: event.target.value,
                                }))
                              }
                            />
                            <Button
                              variant="secondary"
                              type="button"
                              {...stylex.props(styles.unknownCommentButton)}
                              disabled={
                                busy ||
                                !/^[1-9]\d*$/.test(unknownIds[item.commentId] || '') ||
                                !Number.isSafeInteger(Number(unknownIds[item.commentId]))
                              }
                              onClick={() =>
                                void reconcileUnknown(item.commentId, Number(unknownIds[item.commentId]))
                              }
                            >
                              Link existing comment
                            </Button>
                          </div>
                          <label {...stylex.props(styles.checkbox)}>
                            <input
                              {...stylex.props(styles.checkboxInput)}
                              type="checkbox"
                              checked={!!checkedDelivery[item.commentId]}
                              disabled={busy}
                              onChange={(event) =>
                                setCheckedDelivery((previous) => ({
                                  ...previous,
                                  [item.commentId]: event.target.checked,
                                }))
                              }
                            />
                            <span {...stylex.props(styles.checkboxContent)}>
                              I checked Bitbucket: this comment was not posted.
                            </span>
                          </label>
                          <button
                            type="button"
                            {...stylex.props(styles.link)}
                            disabled={busy || !checkedDelivery[item.commentId]}
                            onClick={() => void reconcileUnknown(item.commentId, null)}
                          >
                            Allow retry
                          </button>
                        </div>
                      )}
                      {item.state === 'conflict' && (
                        <div {...stylex.props(styles.publicationConflict)}>
                          <span {...stylex.props(styles.publicationConflictLabel)}>Bitbucket version</span>
                          <p {...stylex.props(styles.feedbackPublicationBody)}>
                            {item.remote?.deleted ? 'Deleted in Bitbucket' : item.remote?.body}
                          </p>
                          <div {...stylex.props(styles.inlineActions)}>
                            <button
                              {...stylex.props(styles.inlineActionButton)}
                              type="button"
                              disabled={busy}
                              onClick={() => void conflict(item.commentId, 'local')}
                            >
                              Keep local version
                            </button>
                            <button
                              {...stylex.props(styles.inlineActionButton)}
                              type="button"
                              disabled={busy}
                              onClick={() => void conflict(item.commentId, 'remote')}
                            >
                              Use Bitbucket version
                            </button>
                          </div>
                        </div>
                      )}
                      {!remote?.publications[item.commentId]?.remoteId &&
                        review.comments.some((comment) => comment.id === item.commentId) &&
                        item.state !== 'sending' &&
                        item.state !== 'unknown' && (
                          <button
                            type="button"
                            {...stylex.props(styles.link, styles.feedbackPublicationLink)}
                            disabled={busy}
                            onClick={() => {
                              setDialog(null);
                              onReanchor(item.commentId);
                            }}
                          >
                            Choose current lines…
                          </button>
                        )}
                    </article>
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
            <Button disabled={busy || loading} onClick={() => setDialog(null)}>
              {visibleOperation && resumeNeeded ? 'Return to review' : 'Close'}
            </Button>
            {dialog === 'publish' && (
              <Button disabled={busy || loading} onClick={() => void preview('publish')}>
                Refresh delivery status
              </Button>
            )}
            <Button
              variant="primary"
              disabled={
                busy ||
                loading ||
                !!completed ||
                (dialog === 'publish' ? !publishable : dialog === 'merge' ? !canMerge : !canApprove)
              }
              onClick={() => void run()}
            >
              {busy && <Spinner size={13} />}
              {busy
                ? 'Working…'
                : dialog === 'publish'
                  ? 'Publish to Bitbucket'
                  : completed
                    ? 'Complete'
                    : dialog === 'merge' && readyToFinish
                      ? 'Finish review'
                      : visibleOperation && resumeNeeded
                        ? 'Resume operation'
                        : dialog === 'approve'
                          ? 'Approve pull requests'
                          : 'Approve, merge and delete branches'}
            </Button>
          </DialogFooter>
        </IntegrationDialog>
      )}
    </>
  );
}

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
  feedbackPublication: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: '10px',
  },
  feedbackPublicationHeading: { display: 'flex', gap: '9px', alignItems: 'center' },
  feedbackPublicationCode: { fontSize: typeScale.caption, color: colors.textQuiet, flex: '1' },
  publicationStatus: { fontSize: typeScale.caption, color: colors.textQuiet, whiteSpace: 'nowrap' },
  publicationSynced: { color: colors.successText },
  publicationWarning: { color: colors.warningText },
  feedbackPublicationAction: { color: colors.textSubtle, fontSize: typeScale.caption },
  feedbackPublicationName: {
    display: 'block',
    color: colors.textEmphasis,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    lineHeight: 1.7,
    marginBlock: spacing.md,
    marginInline: '0',
    overflowWrap: 'anywhere',
  },
  feedbackPublicationBody: {
    fontSize: typeScale.body,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    marginBlock: spacing.md,
    marginInline: '0',
  },
  unknownDelivery: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.warningBorder,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    fontSize: typeScale.small,
  },
  linkIcon: { flexShrink: '0' },
  unknownCommentLink: { display: 'flex', gap: spacing.md, marginBlock: spacing.lg, marginInline: '0' },
  unknownCommentInput: { height: '29px', fontSize: typeScale.small, maxWidth: '165px' },
  unknownCommentButton: { minHeight: '29px', fontSize: typeScale.small },
  checkbox: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: '9px',
  },
  checkboxInput: { accentColor: colors.accent, marginTop: spacing.xxs, flexShrink: '0' },
  checkboxContent: { display: 'flex', flexDirection: 'column', gap: '5px' },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '0',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover': colors.textPrimary },
    textDecoration: { default: 'none', ':hover': 'underline' },
    opacity: { default: 1, ':disabled': 0.4 },
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
  },
  publicationConflict: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.warningBorder,
    marginTop: spacing.lg,
    paddingTop: '10px',
  },
  publicationConflictLabel: { fontSize: typeScale.caption, color: colors.textQuiet },
  inlineActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '9px' },
  inlineActionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.xs,
    paddingBlock: '3px',
    paddingInline: '0',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textSubtle, ':hover': colors.textPrimary },
    opacity: { default: 1, ':disabled': 0.4 },
    fontSize: typeScale.small,
  },
  feedbackPublicationLink: { fontSize: typeScale.small, marginTop: spacing.sm },
  pointerPreview: { display: 'block', marginTop: '13px' },
  modalChrome: { flexShrink: '0' },
  mergeJiraButton: { marginRight: 'auto' },
});
