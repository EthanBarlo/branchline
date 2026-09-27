import * as stylex from '@stylexjs/stylex';
import { GitPullRequest, HelpCircle, Layers3, MoreHorizontal, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { colors, radii, typeScale } from '../../theme/tokens.stylex';
import { IconButton } from '../../ui/Button';

const styles = stylex.create({
  'workspace-menu': {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  'workspace-menu-popover': {
    position: 'absolute',
    top: 'calc(100% + 7px)',
    right: '0',
    zIndex: 30,
    minWidth: '205px',
    padding: '5px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: radii.lg,
    backgroundColor: colors.raised,
    boxShadow: `0 9px 30px ${colors.shadowMedium}, 0 1px 0 ${colors.translucentSelected} inset`,
  },
  workspaceMenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    padding: 9,
    borderWidth: 0,
    borderRadius: radii.md,
    backgroundColor: { default: 'transparent', ':hover': colors.hover, ':focus-visible': colors.hover },
    color: {
      default: colors.textSecondary,
      ':hover': colors.textPrimary,
      ':focus-visible': colors.textPrimary,
    },
    textAlign: 'left',
    fontSize: typeScale.compact,
    whiteSpace: 'nowrap',
    opacity: { default: 1, ':disabled': 0.4 },
  },
  workspaceMenuItemIcon: { flexShrink: 0, color: colors.textMuted },
  workspaceMenuDanger: { color: colors.diffRemoved },
});

export function WorkspaceMenu({
  onSettings,
  onRepositories,
  onIntegrations,
  onHelp,
  onDelete,
  onCleanupClosed,
}: {
  onSettings: () => void;
  onRepositories: () => void;
  onIntegrations: () => void;
  onHelp: () => void;
  onDelete?: () => void;
  onCleanupClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  function choose(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }
  return (
    <div className={`workspace-menu ${stylex.props(styles['workspace-menu']).className}`} ref={container}>
      <IconButton
        ref={trigger}
        aria-label="Workspace menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Workspace menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={17} />
      </IconButton>
      {open && (
        <div
          className={`workspace-menu-popover ${stylex.props(styles['workspace-menu-popover']).className}`}
          ref={menu}
          role="menu"
          aria-label="Workspace"
          onKeyDown={(event) => {
            const items = Array.from(
              menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [],
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
                      : null;
            if (next !== null) {
              event.preventDefault();
              items[next]?.focus();
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <button
            role="menuitem"
            {...stylex.props(styles.workspaceMenuItem)}
            onClick={() => choose(onSettings)}
          >
            <Settings2 size={14} className={stylex.props(styles.workspaceMenuItemIcon).className} />
            Project settings
          </button>
          <button
            role="menuitem"
            {...stylex.props(styles.workspaceMenuItem)}
            onClick={() => choose(onIntegrations)}
          >
            <GitPullRequest size={14} className={stylex.props(styles.workspaceMenuItemIcon).className} />
            Project integrations
          </button>
          {onCleanupClosed && (
            <button
              role="menuitem"
              {...stylex.props(styles.workspaceMenuItem)}
              onClick={() => choose(onCleanupClosed)}
            >
              <Trash2 size={14} className={stylex.props(styles.workspaceMenuItemIcon).className} />
              Clean up closed Bitbucket reviews
            </button>
          )}
          <button
            role="menuitem"
            {...stylex.props(styles.workspaceMenuItem)}
            onClick={() => choose(onRepositories)}
          >
            <Layers3 size={14} className={stylex.props(styles.workspaceMenuItemIcon).className} />
            Repositories
          </button>
          <button role="menuitem" {...stylex.props(styles.workspaceMenuItem)} onClick={() => choose(onHelp)}>
            <HelpCircle size={14} className={stylex.props(styles.workspaceMenuItemIcon).className} />
            How Branchline works
          </button>
          {onDelete && (
            <button
              role="menuitem"
              className={`menu-danger ${stylex.props(styles.workspaceMenuItem, styles.workspaceMenuDanger).className}`}
              onClick={() => choose(onDelete)}
            >
              <Trash2
                size={14}
                className={stylex.props(styles.workspaceMenuItemIcon, styles.workspaceMenuDanger).className}
              />
              Delete this review
            </button>
          )}
        </div>
      )}
    </div>
  );
}
