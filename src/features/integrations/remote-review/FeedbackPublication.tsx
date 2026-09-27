import * as stylex from '@stylexjs/stylex';
import type { FeedbackItem, RemoteReviewState } from '../../../../shared/integrations';
import type { Review } from '../../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Problem } from '../IntegrationError';
import { UnknownPublication } from './UnknownPublication';
import type { RemoteReviewActions } from './useRemoteReviewActions';

const styles = stylex.create({
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
  feedbackPublicationLink: { fontSize: typeScale.small, marginTop: spacing.sm },
});

const human = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');
type PublicationActions = Pick<
  RemoteReviewActions,
  | 'busy'
  | 'unknownIds'
  | 'checkedDelivery'
  | 'updateUnknownId'
  | 'checkDelivery'
  | 'reconcileUnknown'
  | 'conflict'
  | 'close'
>;
interface FeedbackPublicationProps {
  item: FeedbackItem;
  review: Review;
  remote: RemoteReviewState | null;
  actions: PublicationActions;
  onReanchor: (commentId: string) => void;
}
export function FeedbackPublication({ item, review, remote, actions, onReanchor }: FeedbackPublicationProps) {
  const {
    busy,
    unknownIds,
    checkedDelivery,
    updateUnknownId,
    checkDelivery,
    reconcileUnknown,
    conflict,
    close,
  } = actions;
  return (
    <article className={`feedback-publication ${stylex.props(styles.feedbackPublication).className}`}>
      <div {...stylex.props(styles.feedbackPublicationHeading)}>
        <code {...stylex.props(styles.feedbackPublicationCode)}>
          {item.repositoryPath} · {item.createsPullRequest ? 'Create PR on publish' : `#${item.prId}`}
        </code>
        <span
          {...stylex.props(
            styles.publicationStatus,
            item.state === 'synced' && styles.publicationSynced,
            ['unknown', 'failed', 'conflict'].includes(item.state) && styles.publicationWarning,
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
        <UnknownPublication
          item={item}
          pullRequests={remote?.pullRequests || []}
          busy={busy}
          unknownId={unknownIds[item.commentId] || ''}
          checkedDelivery={!!checkedDelivery[item.commentId]}
          onUnknownIdChange={(value) => updateUnknownId(item.commentId, value)}
          onCheckedDeliveryChange={(checked) => checkDelivery(item.commentId, checked)}
          onReconcile={(remoteId) => void reconcileUnknown(item.commentId, remoteId)}
        />
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
              close();
              onReanchor(item.commentId);
            }}
          >
            Choose current lines…
          </button>
        )}
    </article>
  );
}
