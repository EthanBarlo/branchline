import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';

export type ProjectTabMenuAction = 'rename' | 'move-left' | 'move-right' | 'remove';
export interface ProjectTabMenuContext {
  projectId: string;
  x: number;
  y: number;
}

export function ProjectTabMenu({
  context,
  project,
  index,
  count,
  disabled,
  onClose,
  onAction,
}: {
  context: ProjectTabMenuContext;
  project: Project;
  index: number;
  count: number;
  disabled: boolean;
  onClose: (restoreFocus?: boolean) => void;
  onAction: (action: ProjectTabMenuAction) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: context.x, top: context.y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(context.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(context.y, window.innerHeight - rect.height - 8)),
    });
    (element.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? element).focus();
  }, [context]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close.current(false);
    };
    const dismiss = () => close.current(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);
  function perform(action: ProjectTabMenuAction) {
    // Rename moves focus into the tab's own input, so only other actions restore it.
    onClose(action !== 'rename');
    onAction(action);
  }
  return createPortal(
    <div
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label={`Project actions for ${project.name}`}
      {...stylex.props(styles.menu)}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
          return;
        }
        const items = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
        );
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : event.key === 'ArrowUp'
              ? (current - 1 + items.length) % items.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          items[next]?.focus();
        }
      }}
    >
      <div {...stylex.props(styles.label)} title={project.repoPath}>
        {project.name}
      </div>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={disabled}
        onClick={() => perform('rename')}
      >
        <Pencil size={14} /> Rename
      </button>
      <div role="separator" {...stylex.props(styles.separator)} />
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={disabled || index === 0}
        onClick={() => perform('move-left')}
      >
        <ArrowLeft size={14} /> Move left
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={disabled || index === count - 1}
        onClick={() => perform('move-right')}
      >
        <ArrowRight size={14} /> Move right
      </button>
      <div role="separator" {...stylex.props(styles.separator)} />
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item, styles.danger)}
        disabled={disabled}
        onClick={() => perform('remove')}
      >
        <Trash2 size={14} /> Remove project…
      </button>
    </div>,
    document.body,
  );
}

const styles = stylex.create({
  menu: {
    position: 'fixed',
    zIndex: 210,
    width: 220,
    maxWidth: 'calc(100vw - 16px)',
    padding: 5,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    color: colors.textDefault,
    boxShadow: `0 8px 28px ${colors.shadow}, 0 1px 0 ${colors.insetHighlight} inset`,
    fontFamily: fonts.body,
    fontSize: typeScale.compact,
  },
  label: {
    paddingInline: 9,
    paddingTop: 6,
    paddingBottom: 7,
    fontSize: typeScale.small,
    color: colors.textQuiet,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
    minHeight: 32,
    paddingInline: 9,
    paddingBlock: spacing.sm,
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
    font: 'inherit',
    textAlign: 'left',
    outline: { default: 'none', ':focus-visible': 'none' },
    opacity: { default: 1, ':disabled': 0.35 },
  },
  danger: {
    color: {
      default: colors.dangerText,
      ':hover:not(:disabled)': colors.dangerStrong,
      ':focus-visible': colors.dangerStrong,
    },
  },
  separator: { height: 1, marginBlock: 5, marginInline: 8, backgroundColor: colors.borderSubtle },
});
