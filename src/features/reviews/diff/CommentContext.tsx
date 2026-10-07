import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { colors, fonts, radii, typeScale } from '../../../theme/tokens.stylex';
export function CommentContext({ reference, children }: { reference?: string; children?: ReactNode }) {
  return (
    <div className={`review-comment-context ${stylex.props(styles.commentContext).className}`}>
      {reference && (
        <div
          className={`review-comment-original-reference ${stylex.props(styles.originalReference).className}`}
        >
          {reference}
        </div>
      )}
      {children !== undefined && <pre {...stylex.props(styles.commentContextCode)}>{children}</pre>}
    </div>
  );
}
const styles = stylex.create({
  commentContext: {
    display: 'grid',
    gap: 4,
    marginTop: 4,
    marginRight: 0,
    marginBottom: 6,
    marginLeft: 0,
    minWidth: 0,
    color: colors.textMuted,
    fontSize: typeScale.caption,
  },
  originalReference: {
    color: colors.textMuted,
    overflowWrap: 'anywhere',
  },
  commentContextCode: {
    maxHeight: 180,
    overflow: 'auto',
    margin: 0,
    paddingBlock: 6,
    paddingInline: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.panel,
    color: colors.textEmphasis,
    fontFamily: fonts.code,
    fontSize: typeScale.compact,
    lineHeight: 1.6,
  },
});
