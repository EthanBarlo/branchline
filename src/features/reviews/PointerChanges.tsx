import * as stylex from '@stylexjs/stylex';
import { ArrowRight, ChevronDown, GitFork } from 'lucide-react';
import type { ReviewSnapshot } from '../../../shared/types';
import { colors, spacing, typeScale } from '../../theme/tokens.stylex';

type PointerChange = NonNullable<ReviewSnapshot['repos'][number]['pointers']>[number] & {
  repositoryPath: string;
};

export function PointerChanges({ pointers, fileCount }: { pointers: PointerChange[]; fileCount: number }) {
  if (!pointers.length) return null;
  return (
    <details
      className={`pointer-changes ${stylex.props(styles['pointer-changes']).className}`}
      open={fileCount ? undefined : true}
    >
      <summary {...stylex.props(styles.pointerSummary)}>
        <GitFork size={13} />
        <span {...stylex.props(styles.pointerSummaryText)}>
          {pointers.length} submodule pointer {pointers.length === 1 ? 'change' : 'changes'}
        </span>
        <ChevronDown size={12} />
      </summary>
      <div {...stylex.props(styles.pointerContent)}>
        {pointers.map((pointer) => (
          <div
            className={`pointer-change-row ${stylex.props(styles['pointer-change-row']).className}`}
            key={`${pointer.repositoryPath}:${pointer.path}`}
          >
            <span {...stylex.props(styles.pointerRowText)}>
              {pointer.repositoryPath === '.' ? '' : `${pointer.repositoryPath}/`}
              {pointer.path}
            </span>
            <code {...stylex.props(styles.pointerRowCode)} title={pointer.oldHash || 'Not present'}>
              {pointer.oldHash?.slice(0, 12) || 'not present'}
            </code>
            <ArrowRight size={11} />
            <code {...stylex.props(styles.pointerRowCode)} title={pointer.newHash || 'Removed'}>
              {pointer.newHash?.slice(0, 12) || 'removed'}
            </code>
          </div>
        ))}
      </div>
    </details>
  );
}

const styles = stylex.create({
  'pointer-changes': {
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  pointerSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    cursor: 'pointer',
    paddingBlock: '9px',
    paddingInline: '13px',
    color: colors.textTertiary,
    fontSize: typeScale.small,
    listStyle: 'none',
  },
  pointerSummaryText: { flex: '1' },
  pointerContent: {
    paddingTop: 0,
    paddingRight: 14,
    paddingBottom: 10,
    paddingLeft: 34,
    maxHeight: 170,
    overflow: 'auto',
  },
  'pointer-change-row': {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingBlock: spacing.sm,
    paddingInline: 0,
    fontSize: typeScale.small,
    color: colors.textQuiet,
  },
  pointerRowText: { flex: '1', color: colors.textEmphasis, overflowWrap: 'anywhere' },
  pointerRowCode: { fontSize: typeScale.small, userSelect: 'text' },
});
