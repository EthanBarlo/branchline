import * as stylex from '@stylexjs/stylex';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { IconButton } from '../../ui/Button';

export function ClosedReviewNotice({
  message,
  warning,
  onDismiss,
}: {
  message: string;
  warning?: boolean;
  onDismiss: () => void;
}) {
  return (
    <div
      className={`closed-review-notice ${warning ? 'closed-review-warning' : ''} ${stylex.props(styles['closed-review-notice'], warning && styles['closed-review-warning']).className}`}
      role="status"
    >
      {warning ? (
        <TriangleAlert size={14} {...stylex.props(styles.closedReviewIcon)} />
      ) : (
        <CircleCheck size={14} {...stylex.props(styles.closedReviewIcon)} />
      )}
      <span {...stylex.props(styles.closedReviewText)}>{message}</span>
      <IconButton aria-label="Dismiss completed review notice" onClick={onDismiss}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

const styles = stylex.create({
  'closed-review-notice': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingBlock: '7px',
    paddingInline: '13px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.successRaised,
    backgroundColor: colors.successSurface,
    color: colors.successText,
    fontSize: typeScale.compact,
  },
  'closed-review-warning': {
    borderColor: colors.warningRaised,
    backgroundColor: colors.warningSurface,
    color: colors.warningStrong,
  },
  closedReviewIcon: { flexShrink: 0 },
  closedReviewText: { flex: '1', overflowWrap: 'anywhere' },
});
