import * as stylex from '@stylexjs/stylex';
import { Files, GitBranch } from 'lucide-react';
import { colors, typeScale } from '../../theme/tokens.stylex';

export function ProjectAreaNavigation({
  area,
  onGit,
  onReviews,
}: {
  area: 'git' | 'reviews';
  onGit: () => void;
  onReviews: () => void;
}) {
  return (
    <nav aria-label="Project areas" {...stylex.props(styles.bar)}>
      <button
        {...stylex.props(styles.tab, area === 'reviews' && styles.active)}
        aria-current={area === 'reviews' ? 'page' : undefined}
        onClick={onReviews}
      >
        <Files size={14} /> Reviews
      </button>
      <button
        {...stylex.props(styles.tab, area === 'git' && styles.active)}
        aria-label="Project Git workflow"
        aria-current={area === 'git' ? 'page' : undefined}
        onClick={onGit}
      >
        <GitBranch size={14} /> Git
      </button>
    </nav>
  );
}
const styles = stylex.create({
  bar: {
    display: 'flex',
    flexShrink: 0,
    height: 38,
    gap: 20,
    paddingInline: 18,
    backgroundColor: colors.panel,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    paddingInline: 3,
    borderWidth: 0,
    borderBottomWidth: 2,
    borderBottomStyle: 'solid',
    borderBottomColor: 'transparent',
    backgroundColor: 'transparent',
    color: { default: colors.textMuted, ':hover': colors.textPrimary },
    fontSize: typeScale.compact,
  },
  active: { borderBottomColor: colors.accent, color: colors.textPrimary, fontWeight: 600 },
});
