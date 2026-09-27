import { type ContextMenuOpenContext } from '@pierre/trees';
import * as stylex from '@stylexjs/stylex';
import { Check, RotateCcw } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewFile } from '../../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';

export function TreeReviewMenu({
  context,
  files,
  includesDirectory,
  approvals,
  busy,
  onReview,
}: {
  context: ContextMenuOpenContext;
  files: ReviewFile[];
  includesDirectory: boolean;
  approvals: Record<string, string>;
  busy: boolean;
  onReview: (files: ReviewFile[], approved: boolean) => Promise<void>;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: context.anchorRect.left, top: context.anchorRect.top });
  const allReviewed = files.length > 0 && files.every((file) => approvals[file.id] === file.fingerprint);
  const noneReviewed = files.every((file) => approvals[file.id] !== file.fingerprint);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(context.anchorRect.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(context.anchorRect.top, window.innerHeight - rect.height - 8)),
    });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [context]);
  const perform = (approved: boolean) => {
    context.close({ restoreFocus: false });
    void onReview(files, approved);
  };
  return createPortal(
    <div
      ref={menu}
      className={`tree-review-menu ${stylex.props(styles.menu).className}`}
      data-file-tree-context-menu-root="true"
      role="menu"
      aria-label="File review actions"
      style={{ ...position, WebkitAppRegion: 'no-drag' } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          context.close();
          return;
        }
        const options = [
          ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
        ];
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % options.length
            : event.key === 'ArrowUp'
              ? (current - 1 + options.length) % options.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : null;
        if (next !== null && options.length) {
          event.preventDefault();
          event.stopPropagation();
          options[next]?.focus();
        }
      }}
    >
      <div className={`tree-review-menu-label ${stylex.props(styles.menuLabel).className}`}>
        {files.length === 1 && !includesDirectory
          ? files[0].path.split('/').at(-1)
          : `${files.length} file${files.length === 1 ? '' : 's'} selected`}
      </div>
      <button
        {...stylex.props(styles.menuButton)}
        type="button"
        role="menuitem"
        disabled={busy || !files.length || allReviewed}
        onClick={() => perform(true)}
      >
        <Check size={14} className={stylex.props(styles.menuIcon).className} />
        Mark reviewed
      </button>
      <button
        {...stylex.props(styles.menuButton)}
        type="button"
        role="menuitem"
        disabled={busy || !files.length || noneReviewed}
        onClick={() => perform(false)}
      >
        <RotateCcw size={14} className={stylex.props(styles.menuIcon).className} />
        Mark unreviewed
      </button>
    </div>,
    document.body,
  );
}
const styles = stylex.create({
  menu: {
    position: 'fixed',
    zIndex: 210,
    width: 208,
    padding: 5,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    color: colors.textDefault,
    boxShadow: `0 8px 28px ${colors.shadow}, 0 1px 0 ${colors.insetHighlight} inset`,
    fontFamily: fonts.body,
    fontSize: typeScale.compact,
  },
  menuLabel: {
    paddingTop: '6px',
    paddingRight: '8px',
    paddingBottom: '7px',
    paddingLeft: '8px',
    color: colors.textQuiet,
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  menuButton: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
    minHeight: 31,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.hover,
      ':focus-visible': colors.hover,
    },
    color: {
      default: 'inherit',
      ':hover:not(:disabled)': colors.textStrong,
      ':focus-visible': colors.textStrong,
    },
    textAlign: 'left',
    font: 'inherit',
    outline: { default: 'none', ':focus-visible': 'none' },
    opacity: { default: 1, ':disabled': 0.35 },
    cursor: { default: 'auto', ':disabled': 'default' },
  },
  menuIcon: {
    color: colors.textSubtle,
    flexShrink: 0,
  },
});
