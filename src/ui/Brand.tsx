import * as stylex from '@stylexjs/stylex';
import { GitCompareArrows } from 'lucide-react';
import { colors, spacing } from '../theme/tokens.stylex';

const styles = stylex.create({
  brand: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.md,
    color: colors.textDefault,
    fontSize: '21px',
    fontWeight: 600,
    letterSpacing: '-.8px',
    lineHeight: 1,
  },
  'brand-symbol': {
    display: 'grid',
    placeItems: 'center',
    width: '28px',
    height: '28px',
    borderTopLeftRadius: '7px',
    borderTopRightRadius: '7px',
    borderBottomRightRadius: '7px',
    borderBottomLeftRadius: '2px',
    backgroundColor: colors.textSecondary,
    color: colors.interactive,
  },
  'brand-dot': {
    color: colors.textSecondary,
  },
});

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'brand-small' : ''} ${stylex.props(styles.brand).className}`}>
      <span className={`brand-symbol ${stylex.props(styles['brand-symbol']).className}`}>
        <GitCompareArrows size={small ? 19 : 22} strokeWidth={2.2} />
      </span>
      <span>
        branchline<span className={`brand-dot ${stylex.props(styles['brand-dot']).className}`}>.</span>
      </span>
    </div>
  );
}
