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
import {
  CommentActionButton,
  CommentActions,
  commentCardProps,
  EarlierVersionBadge,
} from './comments/CommentChrome';
import { ResolvedComment } from './comments/ResolvedComment';
import { CommentContext } from './diff/CommentContext';
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
    borderLeftWidth: '2px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderLeftColor: colors.textFaint,
    borderRadius: radii.lg,
    paddingTop: '8px',
    paddingRight: '8px',
    paddingBottom: '9px',
    paddingLeft: '11px',
    marginBottom: '10px',
  },
  staleCard: { borderLeftColor: colors.warningBorder },
  feedbackCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 22,
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
    flex: '1',
    minWidth: 0,
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
    marginTop: '3px',
    marginInline: '0',
  },
  'feedback-card-meta': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    fontSize: typeScale.caption,
    lineHeight: '16px',
    color: colors.textQuiet,
  },
  metaItem: { display: 'inline-flex', alignItems: 'center' },
  metaSeparator: { paddingInline: 6, color: colors.textFaint },
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
    marginTop: '4px',
    marginRight: '0',
    marginBottom: '6px',
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
            const lines =
              comment.lineStart === 0
                ? 'File'
                : `L${comment.lineStart}${comment.lineEnd !== comment.lineStart ? `–${comment.lineEnd}` : ''}`;
            const publication = review.remote && (
              <PublicationStatus publication={remote?.publications[comment.id]} comment={comment} />
            );
            const savedContext = stale && comment.context && (
              <CommentContext reference={fileLocation(comment)}>{comment.context}</CommentContext>
            );
            const toggleResolved = () =>
              void action(comment.id, () => onUpdate(comment.id, { resolved: !comment.resolved }));
            const remove = () => void action(comment.id, () => onDelete(comment.id));
            if (comment.resolved)
              return (
                <ResolvedComment
                  key={comment.id}
                  className="feedback-card resolved"
                  variant="block"
                  location={`${comment.path.split('/').pop()} · ${lines}`}
                  body={comment.body}
                  context={savedContext || undefined}
                  status={publication || undefined}
                  busy={busy === comment.id}
                  onReopen={toggleResolved}
                  onDelete={remove}
                />
              );
            return (
              <FeedbackCard
                key={comment.id}
                stale={stale}
                savedContext={savedContext || undefined}
                header={
                  <button
                    className={`feedback-location ${stylex.props(styles['feedback-location']).className}`}
                    onClick={() => onSelect(comment.fileId)}
                    disabled={!file}
                    title={fileLocation(comment)}
                  >
                    <FileCode2 size={13} className={stylex.props(styles.feedbackLocationIcon).className} />
                    <span {...stylex.props(styles.feedbackLocationName)}>
                      {comment.path.split('/').pop()}
                    </span>
                    <code {...stylex.props(styles.feedbackLocationCode)}>{lines}</code>
                    <ArrowDownLeft
                      size={12}
                      className={stylex.props(styles.feedbackLocationIcon).className}
                    />
                  </button>
                }
                actions={
                  <CommentActions visible={busy === comment.id}>
                    <CommentActionButton
                      disabled={busy === comment.id}
                      onClick={toggleResolved}
                      aria-label={`Resolve comment on ${comment.path} line ${comment.lineStart}`}
                      title="Resolve"
                    >
                      {busy === comment.id ? <Spinner size={13} /> : <Check size={13} />}
                    </CommentActionButton>
                    <CommentActionButton
                      disabled={busy === comment.id}
                      onClick={remove}
                      aria-label={`Delete comment on ${comment.path} line ${comment.lineStart}`}
                      title="Delete comment"
                    >
                      <Trash2 size={12} />
                    </CommentActionButton>
                  </CommentActions>
                }
                path={fileLocation(comment)}
                body={comment.body}
                meta={[
                  <span key="side">
                    {comment.side === 'deletions' ? 'Original version' : 'Feature version'}
                  </span>,
                  publication && <span key="publication">{publication}</span>,
                  review.remote && !remote?.publications[comment.id]?.remoteId && (
                    <button
                      key="reanchor"
                      type="button"
                      {...stylex.props(styles.publicationButton)}
                      onClick={() => onReanchor(comment.id)}
                    >
                      Choose current lines…
                    </button>
                  ),
                ]}
              />
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

function FeedbackCard({
  stale,
  savedContext,
  header,
  actions,
  path,
  body,
  meta,
}: {
  stale: boolean;
  savedContext?: React.ReactNode;
  header: React.ReactNode;
  actions: React.ReactNode;
  path: string;
  body: string;
  meta: React.ReactNode[];
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  const items = meta.filter(Boolean);
  return (
    <article
      {...commentCardProps}
      className={`feedback-card ${stylex.props(stylex.defaultMarker(), styles['feedback-card'], stale && styles.staleCard).className}`}
    >
      <div {...stylex.props(styles.feedbackCardHeader)}>
        {header}
        {actions}
      </div>
      <span
        className={`feedback-card-path ${stylex.props(styles['feedback-card-path']).className}`}
        title={path}
      >
        {path}
      </span>
      <p {...stylex.props(styles.feedbackBody)}>{body}</p>
      {showEarlier && savedContext}
      <div className={`feedback-card-meta ${stylex.props(styles['feedback-card-meta']).className}`}>
        {stale &&
          (savedContext ? (
            <EarlierVersionBadge expanded={showEarlier} onToggle={() => setShowEarlier((value) => !value)} />
          ) : (
            <span className={`stale-label ${stylex.props(styles.staleLabel).className}`}>
              Earlier version
            </span>
          ))}
        {items.map((item, index) => (
          <span key={index} {...stylex.props(styles.metaItem)}>
            {(index > 0 || stale) && (
              <span aria-hidden {...stylex.props(styles.metaSeparator)}>
                ·
              </span>
            )}
            {item}
          </span>
        ))}
      </div>
    </article>
  );
}
