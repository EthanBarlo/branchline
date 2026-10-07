import * as stylex from '@stylexjs/stylex';
import { Check, MessageSquareCheck, RotateCcw, Trash2 } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Popover } from '../../../ui/Popover';
import { Spinner } from '../../../ui/Spinner';

/**
 * A resolved comment collapsed to a marker. `inline` floats an icon over the
 * end of the commented diff line so the annotation row takes no height;
 * `block` is a one-line chip for lists. Either opens the full comment in a
 * popover.
 */
export function ResolvedComment({
  variant,
  location,
  body,
  context,
  status,
  busy = false,
  onReopen,
  onDelete,
  className = '',
  ...props
}: {
  variant: 'inline' | 'block';
  /** Short location, e.g. "Line 12". */
  location: string;
  body: string;
  /** Saved code or an earlier version, shown below the body. */
  context?: ReactNode;
  /** Publication state or other quiet metadata. */
  status?: ReactNode;
  busy?: boolean;
  onReopen: () => void;
  onDelete: () => void;
} & HTMLAttributes<HTMLElement>) {
  const excerpt = body.trim().split('\n')[0];
  return (
    <article
      {...props}
      className={`${className} ${stylex.props(variant === 'inline' ? styles.inline : styles.block).className}`}
    >
      <Popover
        label={`Resolved comment, ${location}`}
        trigger={({ ref, ...trigger }) => (
          <button
            {...trigger}
            ref={ref}
            type="button"
            aria-label="Show resolved comment"
            {...stylex.props(variant === 'inline' ? styles.marker : styles.chip)}
          >
            <MessageSquareCheck size={variant === 'inline' ? 11 : 12} {...stylex.props(styles.icon)} />
            {variant === 'block' && (
              <>
                <span {...stylex.props(styles.chipLocation)}>{location}</span>
                <span {...stylex.props(styles.chipExcerpt)}>{excerpt}</span>
              </>
            )}
          </button>
        )}
      >
        <div {...stylex.props(styles.header)}>
          <span {...stylex.props(styles.resolvedBadge)}>
            <Check size={10} strokeWidth={2.5} />
            Resolved
          </span>
          <span {...stylex.props(styles.location)}>{location}</span>
        </div>
        <p {...stylex.props(styles.body)}>{body}</p>
        {context && <div {...stylex.props(styles.context)}>{context}</div>}
        <div {...stylex.props(styles.footer)}>
          <span {...stylex.props(styles.status)}>{status}</span>
          <button
            type="button"
            aria-label="Delete comment"
            disabled={busy}
            onClick={onDelete}
            {...stylex.props(styles.action)}
          >
            <Trash2 size={12} />
            Delete
          </button>
          <button
            type="button"
            aria-label="Reopen comment"
            disabled={busy}
            onClick={onReopen}
            {...stylex.props(styles.action, styles.primaryAction)}
          >
            {busy ? <Spinner size={12} /> : <RotateCcw size={12} />}
            Reopen
          </button>
        </div>
      </Popover>
    </article>
  );
}

const DIFF_LINE_HEIGHT = 23;
const MARKER_SIZE = 18;

const styles = stylex.create({
  inline: {
    // A 1px float keeps the annotation row almost flat while the marker sits
    // over the commented line. Chromium ignores zero-height floats when
    // placing later ones, so 1px lets several markers on a line sit side by side.
    float: 'right',
    position: 'relative',
    width: MARKER_SIZE,
    height: 1,
    marginLeft: 4,
  },
  block: {
    display: 'flex',
    minWidth: 0,
    marginBlock: 4,
  },
  marker: {
    position: 'absolute',
    top: -(DIFF_LINE_HEIGHT + MARKER_SIZE) / 2,
    right: 10,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    padding: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':hover': colors.borderSelected },
    borderRadius: radii.md,
    backgroundColor: { default: colors.surface, ':hover': colors.raised },
    boxShadow: `0 1px 2px ${colors.shadowSoft}`,
    color: {
      default: colors.textFaint,
      ':hover': colors.textDefault,
      '[aria-expanded="true"]': colors.textDefault,
    },
    cursor: 'pointer',
    transition: 'color 120ms, background-color 120ms, border-color 120ms',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: 1,
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    maxWidth: 860,
    height: 24,
    paddingBlock: 0,
    paddingInline: spacing.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: { default: colors.interactive, ':hover': colors.hover },
    borderRadius: 5,
    backgroundColor: { default: 'transparent', ':hover': colors.surface },
    color: { default: colors.textFaint, ':hover': colors.textMuted },
    fontFamily: fonts.body,
    fontSize: typeScale.small,
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'color 120ms, background-color 120ms, border-color 120ms',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: 1,
  },
  icon: { flexShrink: 0 },
  chipLocation: { flexShrink: 0, color: colors.textMuted, whiteSpace: 'nowrap' },
  chipExcerpt: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: 9,
    paddingInline: 11,
  },
  resolvedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    paddingBlock: 1,
    paddingInline: 5,
    borderRadius: radii.sm,
    backgroundColor: colors.successSurface,
    color: colors.successText,
    fontSize: typeScale.caption,
    fontWeight: 550,
  },
  location: { color: colors.textMuted, fontSize: typeScale.caption },
  body: {
    maxHeight: 240,
    overflowY: 'auto',
    marginTop: 7,
    marginBottom: 0,
    marginInline: 0,
    paddingInline: 11,
    color: colors.textDefault,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  context: { paddingTop: 2, paddingInline: 11 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 9,
    paddingBlock: 5,
    paddingInline: 7,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.interactive,
  },
  status: { marginRight: 'auto', paddingLeft: 4, fontSize: typeScale.caption, color: colors.textQuiet },
  action: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.xs,
    paddingBlock: 3,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.raised },
    color: { default: colors.textSubtle, ':hover:not(:disabled)': colors.textDefault },
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    lineHeight: '14px',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.4 },
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: 1,
  },
  primaryAction: {
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.interactive },
    color: colors.textDefault,
  },
});
