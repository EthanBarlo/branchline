import * as stylex from '@stylexjs/stylex';
import { TriangleAlert, X } from 'lucide-react';
import { colors, radii, spacing, typeScale } from '../../tokens.stylex';
import { IconButton } from '../../ui/Button';

export function ErrorBanner({
  message,
  retry,
  onDismiss,
}: {
  message: string;
  retry?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`error-banner ${stylex.props(styles['error-banner']).className}`} role="alert">
      <TriangleAlert size={16} {...stylex.props(styles.errorBannerIcon)} />
      <span {...stylex.props(styles.errorBannerText)}>{message}</span>
      {retry && (
        <button {...stylex.props(styles.errorBannerRetry)} onClick={retry}>
          Retry
        </button>
      )}
      <IconButton aria-label="Dismiss error" onClick={onDismiss}>
        <X size={15} />
      </IconButton>
    </div>
  );
}

const styles = stylex.create({
  'error-banner': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingBlock: spacing.md,
    paddingInline: '13px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.dangerButton,
    backgroundColor: colors.dangerSurface,
    color: colors.dangerText,
    fontSize: typeScale.compact,
  },
  errorBannerIcon: { flexShrink: 0 },
  errorBannerText: { flex: '1', overflowWrap: 'anywhere' },
  errorBannerRetry: {
    paddingBlock: '3px',
    paddingInline: '9px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    borderRadius: radii.sm,
    backgroundColor: 'transparent',
    color: colors.dangerText,
    fontSize: typeScale.small,
  },
});
