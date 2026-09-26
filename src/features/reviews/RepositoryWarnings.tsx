import * as stylex from '@stylexjs/stylex';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { colors, spacing, typeScale } from '../../tokens.stylex';

export function RepositoryWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className={`warning-banner ${stylex.props(styles['warning-banner']).className}`}>
      <summary {...stylex.props(styles.warningSummary)}>
        <TriangleAlert size={14} />
        <span>
          {warnings.length} {warnings.length === 1 ? 'repository notice' : 'repository notices'}
        </span>
        <span className={`warning-detail-label ${stylex.props(styles['warning-detail-label']).className}`}>
          View details
        </span>
        <ChevronDown size={12} />
      </summary>
      <ul {...stylex.props(styles.warningList)}>
        {warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </details>
  );
}

const styles = stylex.create({
  'warning-banner': {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.warningRaised,
    backgroundColor: colors.warningSurface,
    color: colors.warningStrong,
    fontSize: typeScale.small,
  },
  warningSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    paddingBlock: '7px',
    paddingInline: '14px',
    cursor: 'pointer',
    listStyle: 'none',
  },
  'warning-detail-label': {
    marginLeft: 'auto',
    color: colors.warningText,
    fontSize: typeScale.caption,
  },
  warningList: {
    marginBlock: '3px',
    marginInline: '0',
    paddingTop: '0',
    paddingRight: '20px',
    paddingBottom: spacing.md,
    paddingLeft: '36px',
    lineHeight: 1.8,
  },
});
