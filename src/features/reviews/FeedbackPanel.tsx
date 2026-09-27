import * as stylex from '@stylexjs/stylex';
import { ArrowDownLeft, Check, FileCode2, MessageSquare, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { RemoteReviewState } from '../../../shared/integrations';
import type { Review, ReviewFile } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { IconButton } from '../../ui/Button';
import { errorMessage } from '../../lib/errorMessage';
import { Spinner } from '../../ui/Spinner';
import { PublicationStatus } from '../integrations/PublicationStatus';
import { flushPendingComments } from './diff/commentAutosave';
import { fileLocation } from './fileLocation';

const panelIn = stylex.keyframes({
  from: { opacity: 0, transform: 'translateX(12px)' },
  to: { opacity: 1, transform: 'translateX(0)' },
});

const styles = stylex.create({
  'feedback-panel': {
    width: { default: '306px', '@media (max-width: 1250px)': '320px' },
    minWidth: '306px',
    backgroundColor: colors.panel,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    minHeight: '0',
    animationDuration: '150ms',
    animationTimingFunction: 'ease-out',
    animationName: panelIn,
    position: { default: null, '@media (max-width: 1250px)': 'absolute' },
    top: { default: null, '@media (max-width: 1250px)': '0' },
    right: { default: null, '@media (max-width: 1250px)': '0' },
    bottom: { default: null, '@media (max-width: 1250px)': '0' },
    zIndex: { default: null, '@media (max-width: 1250px)': 10 },
    boxShadow: { default: null, '@media (max-width: 1250px)': `-12px 0 30px ${colors.shadowSoft}` },
  },
  'feedback-panel-heading': {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: '38px',
    paddingTop: '5px',
    paddingRight: '13px',
    paddingBottom: '0',
    paddingLeft: '13px',
  },
  'feedback-description': {
    color: colors.textMuted,
    fontSize: typeScale.small,
    marginTop: '1px',
    marginRight: '13px',
    marginBottom: '11px',
    marginLeft: '13px',
  },
  'resolved-filter': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontSize: typeScale.small,
    color: colors.textSubtle,
    paddingTop: '0',
    paddingRight: spacing.xl,
    paddingBottom: '13px',
    paddingLeft: spacing.xl,
  },
  'feedback-comments': {
    flex: '1',
    minHeight: '0',
    overflow: 'auto',
    paddingTop: '0',
    paddingRight: spacing.lg,
    paddingBottom: spacing.lg,
    paddingLeft: spacing.lg,
  },
  'feedback-card': {
    backgroundColor: colors.raised,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    paddingTop: '11px',
    paddingRight: '11px',
    paddingBottom: '0',
    paddingLeft: '11px',
    marginBottom: '10px',
  },
  'feedback-card.resolved': {
    opacity: '.6',
  },
  'feedback-location': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    color: colors.textDefault,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderStyle: 'none',
    padding: '0',
    width: '100%',
    textAlign: 'left',
  },
  'feedback-card-path': {
    display: 'block',
    fontFamily: fonts.code,
    fontSize: typeScale.micro,
    color: colors.textMuted,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    marginBlock: '7px',
    marginInline: '0',
  },
  'feedback-card-meta': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: typeScale.micro,
    color: colors.textQuiet,
    gap: '10px',
    marginBlock: '9px',
    marginInline: '0',
  },
  'feedback-card-actions': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBlock: '9px',
    paddingInline: '0',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderStrong,
  },
  'feedback-empty': {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    paddingTop: '70px',
    paddingRight: '14px',
    paddingBottom: '0',
    paddingLeft: '14px',
    color: colors.textSubtle,
  },
  'feedback-panel-footer': {
    paddingBlock: '13px',
    paddingInline: '15px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderStrong,
  },
  'saved-context': {
    fontSize: typeScale.caption,
    color: colors.textSubtle,
    marginBottom: spacing.lg,
  },
  'comment-publication-row': {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    marginTop: 3,
    marginRight: 0,
    marginBottom: 5,
    marginLeft: 0,
  },
  feedbackHeadingTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    margin: 0,
    fontSize: typeScale.body,
    fontWeight: 550,
  },
  headingCount: {
    minWidth: 16,
    paddingBlock: '1px',
    paddingInline: '3px',
    borderRadius: radii.sm,
    backgroundColor: colors.interactive,
    color: colors.textSubtle,
    textAlign: 'center',
    fontSize: typeScale.caption,
    fontWeight: 400,
  },
  feedbackFilterInput: { accentColor: colors.accent, width: 12, height: 12, margin: 0 },
  feedbackLocationIcon: { flexShrink: 0 },
  feedbackLocationName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: typeScale.small,
  },
  feedbackLocationCode: {
    fontSize: typeScale.micro,
    color: colors.textEmphasis,
    whiteSpace: 'nowrap',
    marginLeft: 'auto',
  },
  staleLabel: { color: colors.warningStrong },
  feedbackBody: {
    fontSize: typeScale.compact,
    lineHeight: 1.75,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    marginTop: '11px',
    marginRight: '0',
    marginBottom: '13px',
    marginLeft: '0',
    color: colors.textDefault,
  },
  publicationButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: 0,
    color: colors.textTertiary,
    fontSize: typeScale.caption,
  },
  savedContextSummary: { cursor: 'pointer' },
  savedContextCode: {
    whiteSpace: 'pre-wrap',
    fontSize: typeScale.caption,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
    padding: spacing.md,
    backgroundColor: colors.panel,
    borderRadius: radii.md,
    maxHeight: 170,
    overflowY: 'auto',
  },
  feedbackActionButton: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.xs,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textMuted, ':hover': colors.textDefault },
    fontSize: typeScale.caption,
  },
  resolvedFeedbackAction: { color: colors.textDefault },
  feedbackEmptyTitle: {
    fontSize: typeScale.base,
    fontWeight: 500,
    color: colors.textSecondary,
    marginTop: '15px',
    marginRight: '0',
    marginBottom: spacing.md,
    marginLeft: '0',
  },
  feedbackEmptyDescription: {
    fontSize: typeScale.small,
    color: colors.textMuted,
    lineHeight: 1.8,
    margin: 0,
  },
  feedbackFootnote: {
    fontSize: typeScale.micro,
    display: 'block',
    textAlign: 'center',
    color: colors.textMuted,
    marginTop: 9,
  },
});

export function FeedbackPanel({
  review,
  files,
  onClose,
  onSelect,
  onUpdate,
  onDelete,
  onError,
  copyButton,
  remote,
  onReanchor,
}: {
  review: Review;
  files: ReviewFile[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, changes: { resolved?: boolean; body?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onError: (error: string) => void;
  copyButton: React.ReactNode;
  remote: RemoteReviewState | null;
  onReanchor: (id: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const comments = review.comments.filter((comment) => showResolved || !comment.resolved);
  const resolvedCount = review.comments.filter((comment) => comment.resolved).length;
  async function action(id: string, operation: () => Promise<void>) {
    setBusy(id);
    try {
      await flushPendingComments();
      await operation();
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }
  return (
    <aside
      className={`feedback-panel ${stylex.props(styles['feedback-panel']).className}`}
      aria-label="Review feedback"
    >
      <div className={`feedback-panel-heading ${stylex.props(styles['feedback-panel-heading']).className}`}>
        <h2 {...stylex.props(styles.feedbackHeadingTitle)}>
          Feedback{' '}
          <span {...stylex.props(styles.headingCount)}>
            {review.comments.filter((comment) => !comment.resolved).length}
          </span>
        </h2>
        <IconButton aria-label="Close feedback" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <p className={`feedback-description ${stylex.props(styles['feedback-description']).className}`}>
        Your notes, ready for the next iteration.
      </p>
      {resolvedCount > 0 && (
        <label className={`resolved-filter ${stylex.props(styles['resolved-filter']).className}`}>
          <input
            type="checkbox"
            {...stylex.props(styles.feedbackFilterInput)}
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />
          Show {resolvedCount} resolved
        </label>
      )}
      <div className={`feedback-comments ${stylex.props(styles['feedback-comments']).className}`}>
        {comments.length ? (
          comments.map((comment) => {
            const file = files.find((item) => item.id === comment.fileId);
            const stale = !file || file.fingerprint !== comment.fingerprint;
            return (
              <article
                key={comment.id}
                className={`feedback-card ${comment.resolved ? 'resolved' : ''} ${stylex.props(styles['feedback-card'], comment.resolved && styles['feedback-card.resolved']).className}`}
              >
                <button
                  className={`feedback-location ${stylex.props(styles['feedback-location']).className}`}
                  onClick={() => onSelect(comment.fileId)}
                  disabled={!file}
                  title={fileLocation(comment)}
                >
                  <FileCode2 size={13} className={stylex.props(styles.feedbackLocationIcon).className} />
                  <span {...stylex.props(styles.feedbackLocationName)}>{comment.path.split('/').pop()}</span>
                  <code {...stylex.props(styles.feedbackLocationCode)}>
                    {comment.lineStart === 0
                      ? 'File'
                      : `L${comment.lineStart}${comment.lineEnd !== comment.lineStart ? `–${comment.lineEnd}` : ''}`}
                  </code>
                  <ArrowDownLeft size={12} className={stylex.props(styles.feedbackLocationIcon).className} />
                </button>
                <span
                  className={`feedback-card-path ${stylex.props(styles['feedback-card-path']).className}`}
                  title={fileLocation(comment)}
                >
                  {fileLocation(comment)}
                </span>
                <div className={`feedback-card-meta ${stylex.props(styles['feedback-card-meta']).className}`}>
                  <span>{comment.side === 'deletions' ? 'Original version' : 'Feature version'}</span>
                  {stale && (
                    <span className={`stale-label ${stylex.props(styles.staleLabel).className}`}>
                      Earlier revision
                    </span>
                  )}
                </div>
                <p {...stylex.props(styles.feedbackBody)}>{comment.body}</p>
                {review.remote && (
                  <div
                    className={`comment-publication-row ${stylex.props(styles['comment-publication-row']).className}`}
                  >
                    <PublicationStatus publication={remote?.publications[comment.id]} comment={comment} />
                    {!remote?.publications[comment.id]?.remoteId && (
                      <button
                        type="button"
                        {...stylex.props(styles.publicationButton)}
                        onClick={() => onReanchor(comment.id)}
                      >
                        Choose current lines…
                      </button>
                    )}
                  </div>
                )}
                {stale && comment.context && (
                  <details className={`saved-context ${stylex.props(styles['saved-context']).className}`}>
                    <summary {...stylex.props(styles.savedContextSummary)}>Saved line context</summary>
                    <pre {...stylex.props(styles.savedContextCode)}>{comment.context}</pre>
                  </details>
                )}
                <div
                  className={`feedback-card-actions ${stylex.props(styles['feedback-card-actions']).className}`}
                >
                  <button
                    className={`${comment.resolved ? 'comment-resolved' : ''} ${stylex.props(styles.feedbackActionButton, comment.resolved && styles.resolvedFeedbackAction).className}`}
                    disabled={busy === comment.id}
                    onClick={() =>
                      void action(comment.id, () => onUpdate(comment.id, { resolved: !comment.resolved }))
                    }
                  >
                    {busy === comment.id ? <Spinner size={13} /> : <Check size={13} />}
                    {comment.resolved ? 'Reopen' : 'Resolve'}
                  </button>
                  <button
                    {...stylex.props(styles.feedbackActionButton)}
                    disabled={busy === comment.id}
                    onClick={() => void action(comment.id, () => onDelete(comment.id))}
                    aria-label={`Delete comment on ${comment.path} line ${comment.lineStart}`}
                    title="Delete comment"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <div className={`feedback-empty ${stylex.props(styles['feedback-empty']).className}`}>
            <MessageSquare size={26} />
            <h3 {...stylex.props(styles.feedbackEmptyTitle)}>
              {review.comments.length ? 'All notes resolved.' : 'Room for your thoughts.'}
            </h3>
            <p {...stylex.props(styles.feedbackEmptyDescription)}>
              Click a line number in the diff to leave a comment. Your feedback will appear here.
            </p>
          </div>
        )}
      </div>
      <div className={`feedback-panel-footer ${stylex.props(styles['feedback-panel-footer']).className}`}>
        {copyButton}
        <span {...stylex.props(styles.feedbackFootnote)}>Unresolved comments · paths · line references</span>
      </div>
    </aside>
  );
}
