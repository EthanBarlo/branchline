import * as stylex from '@stylexjs/stylex';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { colors, fonts, radii, typeScale } from '../../../theme/tokens.stylex';

/**
 * Spread on the card whose hover or focus reveals its `CommentActions`; the
 * card must also apply `stylex.defaultMarker()`.
 */
export const commentCardProps = { 'data-comment-card': '' } as const;

/** Icon actions that stay out of the way until their card is hovered or focused. */
export function CommentActions({ visible = false, children }: { visible?: boolean; children: ReactNode }) {
  return (
    <div
      className={`compact-comment-actions ${stylex.props(styles.actions, visible && styles.visible).className}`}
    >
      {children}
    </div>
  );
}

export function CommentActionButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} {...stylex.props(styles.actionButton)} />;
}

export function EarlierVersionBadge({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`review-comment-earlier ${stylex.props(styles.earlierBadge).className}`}
      aria-expanded={expanded}
      title="Left on an earlier version of this file. Show the code it referred to."
      onClick={onToggle}
    >
      Earlier version
    </button>
  );
}

const styles = stylex.create({
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    marginLeft: 'auto',
    flexShrink: 0,
    opacity: {
      default: 0,
      [stylex.when.ancestor(':is([data-comment-card]:hover)')]: 1,
      [stylex.when.ancestor(':is([data-comment-card]:focus-within)')]: 1,
      '@media (hover: none)': 1,
    },
    transition: 'opacity 120ms',
  },
  visible: { opacity: 1 },
  actionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
    color: { default: colors.textSubtle, ':hover:not(:disabled)': colors.textDefault },
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.4 },
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': 1 },
  },
  earlierBadge: {
    flexShrink: 0,
    paddingBlock: 1,
    paddingInline: 5,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: radii.sm,
    backgroundColor: { default: colors.warningSurface, ':hover': colors.warningRaised },
    color: colors.warningText,
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    lineHeight: '13px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: 1,
  },
});
