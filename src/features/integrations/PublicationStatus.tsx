import * as stylex from '@stylexjs/stylex';
import type { CommentPublication } from '../../../shared/integrations';
import type { ReviewComment } from '../../../shared/types';
import { colors, typeScale } from '../../tokens.stylex';

export function PublicationStatus({
  publication,
  comment,
}: {
  publication?: CommentPublication;
  comment?: Pick<ReviewComment, 'body' | 'resolved'>;
}) {
  const dirty =
    publication?.acknowledged &&
    comment &&
    (publication.acknowledged.body !== comment.body ||
      publication.acknowledged.resolved !== comment.resolved);
  const state = !publication
    ? 'draft'
    : dirty && publication.state === 'synced'
      ? 'draft'
      : publication.state;
  const label =
    state === 'synced'
      ? 'Published'
      : state === 'unknown'
        ? 'Delivery unknown'
        : state === 'conflict'
          ? 'Conflict'
          : state === 'sending'
            ? 'Publishing…'
            : state === 'failed'
              ? 'Publish failed'
              : dirty
                ? 'Changes to publish'
                : 'Local draft';
  return (
    <span
      {...stylex.props(
        styles.publicationStatus,
        state === 'synced' && styles.publicationSynced,
        ['unknown', 'failed', 'conflict'].includes(state) && styles.publicationWarning,
      )}
      title={publication?.error}
      role="status"
    >
      {label}
    </span>
  );
}

const styles = stylex.create({
  publicationStatus: { fontSize: typeScale.caption, color: colors.textQuiet, whiteSpace: 'nowrap' },
  publicationSynced: { color: colors.successText },
  publicationWarning: { color: colors.warningText },
});
