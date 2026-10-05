import * as stylex from '@stylexjs/stylex';
import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitCompareArrows,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitSidebarBranch } from './branchTree';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';

export type GitBranchMenuAction =
  'review' | 'checkout' | 'fetch' | 'pull' | 'push' | 'create' | 'rename' | 'delete' | 'favourite';
export interface GitBranchMenuContext {
  name: string;
  key: string;
  remote?: string;
  x: number;
  y: number;
  anchor: HTMLButtonElement;
}

export function GitBranchMenu({
  context,
  branch,
  repositoryCount,
  busy,
  favourite,
  onClose,
  onAction,
}: {
  context: GitBranchMenuContext;
  branch: GitSidebarBranch;
  favourite: boolean;
  repositoryCount: number;
  busy: boolean;
  onClose: (restoreFocus?: boolean) => void;
  onAction: (name: string, action: GitBranchMenuAction) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ left: context.x, top: context.y });
  const root = branch.repositories.find((repo) => repo.path === '.');
  const checkedOut =
    branch.repositories.length === repositoryCount && branch.repositories.every((repo) => repo.current);
  const reason = busy
    ? 'Wait for the current Git operation to finish.'
    : !checkedOut
      ? 'Check out this branch in every repository first.'
      : undefined;

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
  function perform(action: GitBranchMenuAction) {
    onClose(true);
    onAction(branch.key, action);
  }
  return createPortal(
    <div
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label={`Branch actions for ${branch.remote ? `${branch.remote}/` : ''}${branch.name}`}
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
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : event.key === 'ArrowUp'
              ? (index - 1 + items.length) % items.length
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
      <div {...stylex.props(styles.label)} title={branch.name}>
        {branch.remote ? `${branch.remote}/` : ''}
        {branch.name}
      </div>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy}
        onClick={() => perform('create')}
      >
        <Plus size={14} />
        <span {...stylex.props(styles.actionLabel)} title={`New branch from '${branch.name}'…`}>
          New branch from '{branch.name}'…
        </span>
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy || !root}
        title={!root ? 'Branch review requires this branch in the root repository.' : undefined}
        onClick={() => perform('review')}
      >
        <GitCompareArrows size={14} /> Review branch…
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy}
        onClick={() => perform('checkout')}
      >
        <GitBranch size={14} /> Check out…
      </button>
      <div role="separator" {...stylex.props(styles.separator)} />
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy}
        onClick={() => perform('fetch')}
      >
        <RefreshCw size={14} /> Fetch project
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy || !checkedOut}
        title={reason || 'Preview a fast-forward pull across every repository.'}
        onClick={() => perform('pull')}
      >
        <ArrowDown size={14} /> Pull project…
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy || !checkedOut}
        title={reason || 'Preview a push across every repository.'}
        onClick={() => perform('push')}
      >
        <ArrowUp size={14} /> Push project…
      </button>
      <div role="separator" {...stylex.props(styles.separator)} />
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        disabled={busy || branch.repositories.some((repo) => !repo.local)}
        title={
          branch.repositories.some((repo) => !repo.local)
            ? 'Rename requires local branches. Check out the branch first.'
            : undefined
        }
        onClick={() => perform('rename')}
      >
        <Pencil size={14} /> Rename…
      </button>
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item, styles.danger)}
        disabled={busy || (!branch.remote && branch.repositories.some((repo) => repo.current))}
        title={
          !branch.remote && branch.repositories.some((repo) => repo.current)
            ? 'Check out another branch before deleting this local branch.'
            : undefined
        }
        onClick={() => perform('delete')}
      >
        <Trash2 size={14} /> Delete branch…
      </button>
      <div role="separator" {...stylex.props(styles.separator)} />
      <button
        role="menuitem"
        type="button"
        {...stylex.props(styles.item)}
        onClick={() => perform('favourite')}
      >
        <Star size={14} fill={favourite ? 'currentColor' : 'none'} />
        {favourite ? 'Remove from favourites' : 'Add to favourites'}
      </button>
      {!checkedOut && (
        <p {...stylex.props(styles.hint)}>
          Pull and push require this branch checked out across the project.
        </p>
      )}
    </div>,
    document.body,
  );
}
const styles = stylex.create({
  menu: {
    position: 'fixed',
    zIndex: 210,
    width: 270,
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: 'calc(100dvh - 16px)',
    overflowY: 'auto',
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
  actionLabel: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
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
  hint: {
    color: colors.textQuiet,
    fontSize: typeScale.micro,
    lineHeight: 1.6,
    paddingInline: 9,
    marginBlock: 8,
  },
});
