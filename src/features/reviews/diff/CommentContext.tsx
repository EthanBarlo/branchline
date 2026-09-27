import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { colors, fonts, radii, typeScale } from '../../../theme/tokens.stylex';
export function CommentContext({
  label,
  reference,
  children,
}: {
  label: string;
  reference?: string;
  children?: ReactNode;
}) {
  return (
    <details className={`review-comment-context ${stylex.props(styles.commentContext).className}`}>
      <summary {...stylex.props(styles.commentContextSummary)}>{label}</summary>
      {reference && (
        <div
          className={`review-comment-original-reference ${stylex.props(styles.originalReference).className}`}
        >
          {reference}
        </div>
      )}
      {children !== undefined && <pre {...stylex.props(styles.commentContextCode)}>{children}</pre>}
    </details>
  );
}
const styles = stylex.create({
  commentContext: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '4px',
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.caption,
  },
  commentContextSummary: { cursor: 'pointer' },
  originalReference: {
    marginTop: 6,
    color: colors.textMuted,
    overflowWrap: 'anywhere',
  },
  commentContextCode: {
    maxHeight: 180,
    overflow: 'auto',
    marginTop: '6px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    padding: 7,
    borderRadius: radii.sm,
    backgroundColor: colors.panel,
    color: colors.textEmphasis,
    fontFamily: fonts.code,
    fontSize: typeScale.compact,
    lineHeight: 1.6,
  },
});
