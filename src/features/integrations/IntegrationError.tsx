import * as stylex from '@stylexjs/stylex';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';

export function IntegrationError({
  children,
  noBottomMargin = false,
}: {
  children: ReactNode;
  noBottomMargin?: boolean;
}) {
  return (
    <div {...stylex.props(styles.error, noBottomMargin && styles.errorNoBottomMargin)} role="alert">
      <TriangleAlert size={14} {...stylex.props(styles.errorIcon)} />
      <span>{children}</span>
    </div>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return <IntegrationError>{children}</IntegrationError>;
}

const styles = stylex.create({
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingBlock: '10px',
    paddingInline: '11px',
    marginBlock: spacing.lg,
    marginInline: '0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
    color: colors.warningText,
    borderRadius: radii.md,
    fontSize: typeScale.compact,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  errorNoBottomMargin: { marginBottom: 0 },
  errorIcon: { flexShrink: '0', marginTop: spacing.xxs },
});
