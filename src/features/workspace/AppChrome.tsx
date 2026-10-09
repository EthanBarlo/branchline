import * as stylex from '@stylexjs/stylex';
import { FolderGit2, Plus, Settings2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Project } from '../../../shared/types';
import type { UpdateState } from '../../../shared/updates';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { IconButton } from '../../ui/Button';
import { UpdateButton } from '../settings/UpdateControls';
import { ProjectTabMenu, type ProjectTabMenuAction, type ProjectTabMenuContext } from './ProjectTabMenu';

/** Pixels the pointer must travel before a press on a tab becomes a drag. */
const DRAG_THRESHOLD = 5;

const styles = stylex.create({
  chrome: {
    height: 40,
    minHeight: 40,
    display: 'flex',
    alignItems: 'stretch',
    paddingTop: 0,
    paddingRight: 10,
    paddingBottom: 0,
    paddingLeft: 84,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.panel,
    position: 'relative',
    userSelect: 'none',
  },
  tabs: {
    display: 'flex',
    alignItems: 'stretch',
    flex: '1',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    '::-webkit-scrollbar': { height: 2 },
  },
  tab: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    minWidth: { default: 126, '@media (max-width: 1050px)': 110 },
    maxWidth: { default: 228, '@media (max-width: 1050px)': 195 },
    flexShrink: 0,
    paddingBlock: 0,
    paddingInline: { default: 16, '@media (max-width: 1050px)': 12 },
    borderWidth: 0,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    backgroundColor: { default: 'transparent', ':hover': colors.raised },
    color: { default: colors.textMuted, ':hover': colors.textDefault },
    fontSize: typeScale.compact,
    outlineOffset: { default: null, ':focus-visible': -4 },
  },
  activeTab: {
    backgroundColor: colors.raised,
    color: colors.textPrimary,
    '::after': {
      content: "''",
      position: 'absolute',
      height: 2,
      left: 14,
      right: 14,
      bottom: 0,
      backgroundColor: colors.textEmphasis,
    },
  },
  draggingTab: {
    zIndex: 1,
    backgroundColor: colors.raised,
    color: colors.textPrimary,
    boxShadow: `0 4px 14px ${colors.shadow}`,
    cursor: 'grabbing',
  },
  shiftingTab: {
    transitionProperty: 'transform',
    transitionDuration: { default: '160ms', '@media (prefers-reduced-motion: reduce)': '0s' },
    transitionTimingFunction: 'cubic-bezier(.2, .8, .2, 1)',
  },
  renameInput: {
    flex: '1',
    minWidth: 0,
    height: 24,
    paddingBlock: 0,
    paddingInline: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSelected,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    font: 'inherit',
    outline: 'none',
  },
  tabIcon: { flexShrink: 0, color: colors.textQuiet },
  selectedTabIcon: { color: colors.textSecondary },
  tabName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  addTab: {
    display: 'inline-flex',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 26,
    marginBlock: 0,
    marginInline: spacing.md,
    padding: 0,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.interactive },
    color: { default: colors.textMuted, ':hover': colors.textDefault },
    borderRadius: radii.md,
    flexShrink: 0,
  },
  settingsLabel: {
    display: 'flex',
    alignItems: 'center',
    flex: '1',
    gap: spacing.md,
    paddingLeft: 13,
    color: colors.textTertiary,
    fontSize: typeScale.compact,
  },
  appName: {
    display: { default: 'inline-flex', '@media (max-width: 1050px)': 'none' },
    alignItems: 'center',
    gap: 5,
    paddingLeft: 9,
    paddingRight: 3,
    fontSize: typeScale.compact,
    fontWeight: 550,
    letterSpacing: '-.3px',
    color: colors.textFaint,
  },
  appNameDot: { color: colors.textMuted },
  settingsButton: { alignSelf: 'center', width: 28, height: 28, marginLeft: 10, flexShrink: 0 },
});

interface AppChromeProps {
  projects: Project[];
  selectedProjectId: string | null;
  showSettings: boolean;
  initializing: boolean;
  updateState: UpdateState | null;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onRenameProject: (id: string, name: string) => void;
  onReorderProjects: (ids: string[]) => void;
  onRemoveProject: (project: Project) => void;
  onShowUpdates: () => void;
  onOpenSettings: () => void;
}

interface TabDrag {
  id: string;
  pointerId: number;
  startX: number;
  active: boolean;
  /** Tab boxes measured when the drag starts, in the original order. */
  slots: { id: string; left: number; width: number }[];
}

interface TabDragPreview {
  id: string;
  /** Horizontal offset of each tab from its resting slot while dragging. */
  shifts: Record<string, number>;
}

function focusTab(id: string) {
  document.getElementById(`project-tab-${id}`)?.focus();
}

export function AppChrome({
  projects,
  selectedProjectId,
  showSettings,
  initializing,
  updateState,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onReorderProjects,
  onRemoveProject,
  onShowUpdates,
  onOpenSettings,
}: AppChromeProps) {
  const actionsDisabled = initializing || !window.reviewAPI;
  const [menu, setMenu] = useState<ProjectTabMenuContext | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<TabDragPreview | null>(null);
  const drag = useRef<TabDrag | null>(null);
  const suppressClick = useRef(false);
  const tabElements = useRef(new Map<string, HTMLElement>());
  const tabPositions = useRef(new Map<string, number>());
  const renderedOrder = useRef('');
  /** Offsets tabs should glide back from after a drag ends, keyed by project id. */
  const settle = useRef(new Map<string, number>());
  const focusAfterRename = useRef<string | null>(null);

  // Tabs keep their DOM order while dragging (moving the captured element
  // would drop pointer capture), so shifts are transforms until the drop.
  // After any other reorder, slide tabs into their new slots (FLIP).
  useLayoutEffect(() => {
    const order = projects.map((project) => project.id).join('\n');
    const reordered = order !== renderedOrder.current;
    renderedOrder.current = order;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (focusAfterRename.current) {
      focusTab(focusAfterRename.current);
      focusAfterRename.current = null;
    }
    const settling = settle.current;
    settle.current = new Map();
    for (const [id, element] of tabElements.current) {
      const left = element.offsetLeft;
      const previous = tabPositions.current.get(id);
      tabPositions.current.set(id, left);
      const from = settling.size
        ? (settling.get(id) ?? 0)
        : reordered && previous !== undefined
          ? previous - left
          : 0;
      if (reduceMotion || !from) continue;
      element.animate([{ transform: `translateX(${from}px)` }, { transform: 'none' }], {
        duration: 160,
        easing: 'cubic-bezier(.2, .8, .2, 1)',
      });
    }
  });

  function endDrag(settleFrom: Map<string, number>) {
    drag.current = null;
    settle.current = settleFrom;
    setPreview(null);
  }

  useEffect(() => {
    if (!preview) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      suppressClick.current = true;
      endDrag(new Map(Object.entries(preview.shifts)));
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [preview]);

  function dragTo(state: TabDrag, clientX: number) {
    const { slots } = state;
    const self = slots.find((slot) => slot.id === state.id)!;
    const first = slots[0].left;
    const last = slots[slots.length - 1].left + slots[slots.length - 1].width;
    const dx = Math.max(first - self.left, Math.min(clientX - state.startX, last - self.width - self.left));
    const center = self.left + dx + self.width / 2;
    const others = slots.filter((slot) => slot.id !== state.id);
    const index = others.filter((slot) => slot.left + slot.width / 2 < center).length;
    const ordered = [...others];
    ordered.splice(index, 0, self);
    const shifts: Record<string, number> = {};
    let left = first;
    let landing = 0;
    for (const slot of ordered) {
      if (slot === self) landing = self.left + dx - left;
      shifts[slot.id] = slot === self ? dx : left - slot.left;
      left += slot.width;
    }
    return { order: ordered.map((slot) => slot.id), shifts, landing };
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    suppressClick.current = false;
    if (event.button !== 0 || actionsDisabled || projects.length < 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, pointerId: event.pointerId, startX: event.clientX, active: false, slots: [] };
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.active) {
      if (Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD) return;
      state.active = true;
      // Layout offsets ignore any reorder animation still in flight.
      state.slots = projects.map((project) => {
        const element = tabElements.current.get(project.id)!;
        return { id: project.id, left: element.offsetLeft, width: element.offsetWidth };
      });
    }
    const { shifts } = dragTo(state, event.clientX);
    setPreview({ id: state.id, shifts });
  }

  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.active) {
      drag.current = null;
      return;
    }
    suppressClick.current = true;
    const { order, landing } = dragTo(state, event.clientX);
    const changed = order.some((id, index) => projects[index]?.id !== id);
    // Displaced tabs already sit in their new slots; only the dragged tab glides home.
    endDrag(new Map([[state.id, changed ? landing : (preview?.shifts[state.id] ?? 0)]]));
    if (changed) onReorderProjects(order);
  }

  function pointerCancel(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    endDrag(new Map(Object.entries(preview?.shifts ?? {})));
  }

  function openMenu(id: string, x: number, y: number) {
    if (drag.current?.active) return;
    setMenu({ projectId: id, x, y });
  }

  function menuAction(project: Project, action: ProjectTabMenuAction) {
    const index = projects.findIndex((item) => item.id === project.id);
    if (action === 'rename') setRenamingId(project.id);
    else if (action === 'remove') onRemoveProject(project);
    else {
      const target = action === 'move-left' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= projects.length) return;
      const order = projects.map((item) => item.id);
      [order[index], order[target]] = [order[target], order[index]];
      onReorderProjects(order);
    }
  }

  const menuProject = menu && projects.find((project) => project.id === menu.projectId);

  return (
    <div className={`project-tab-strip window-chrome ${stylex.props(styles.chrome).className}`}>
      {showSettings ? (
        <div className={`settings-chrome-label ${stylex.props(styles.settingsLabel).className}`}>
          <Settings2 size={13} />
          Settings
        </div>
      ) : (
        <div
          className={`project-tabs ${stylex.props(styles.tabs).className}`}
          role="tablist"
          aria-label="Projects"
        >
          {projects.map((project, index) => {
            const selected = selectedProjectId === project.id;
            const dragging = preview?.id === project.id;
            const register = (element: HTMLElement | null) => {
              if (element) tabElements.current.set(project.id, element);
              else tabElements.current.delete(project.id);
            };
            if (renamingId === project.id)
              return (
                <div
                  key={project.id}
                  ref={register}
                  className={`project-tab ${selected ? 'active' : ''} ${stylex.props(styles.tab, selected && styles.activeTab).className}`}
                >
                  <FolderGit2
                    size={13}
                    className={stylex.props(styles.tabIcon, selected && styles.selectedTabIcon).className}
                  />
                  <TabRenameInput
                    name={project.name}
                    onDone={(name, restoreFocus) => {
                      setRenamingId(null);
                      if (name && name !== project.name) onRenameProject(project.id, name);
                      if (restoreFocus) focusAfterRename.current = project.id;
                    }}
                  />
                </div>
              );
            return (
              <button
                key={project.id}
                ref={register}
                id={`project-tab-${project.id}`}
                className={`project-tab ${selected ? 'active' : ''} ${stylex.props(styles.tab, selected && styles.activeTab, preview && (dragging ? styles.draggingTab : styles.shiftingTab)).className}`}
                style={
                  preview ? { transform: `translateX(${preview.shifts[project.id] ?? 0}px)` } : undefined
                }
                role="tab"
                aria-label={project.name}
                aria-selected={selected}
                aria-controls="project-workspace"
                aria-haspopup="menu"
                aria-expanded={menu?.projectId === project.id ? true : undefined}
                tabIndex={selected ? 0 : -1}
                title={project.repoPath}
                onPointerDown={(event) => pointerDown(event, project.id)}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerCancel}
                onLostPointerCapture={pointerCancel}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(project.id, event.clientX, event.clientY);
                }}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelectProject(project.id);
                }}
                onDoubleClick={() => !actionsDisabled && setRenamingId(project.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu(project.id, rect.left + 12, rect.bottom);
                    return;
                  }
                  if (event.key === 'F2' && !actionsDisabled) {
                    event.preventDefault();
                    setRenamingId(project.id);
                    return;
                  }
                  const next =
                    event.key === 'ArrowRight'
                      ? (index + 1) % projects.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + projects.length) % projects.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? projects.length - 1
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  onSelectProject(projects[next].id);
                  focusTab(projects[next].id);
                }}
              >
                <FolderGit2
                  size={13}
                  className={stylex.props(styles.tabIcon, selected && styles.selectedTabIcon).className}
                />
                <span {...stylex.props(styles.tabName)}>{project.name}</span>
              </button>
            );
          })}
          <button
            className={`add-project-tab ${stylex.props(styles.addTab).className}`}
            aria-label="Add project"
            title="Add project"
            onClick={onAddProject}
          >
            <Plus size={15} />
          </button>
        </div>
      )}
      {menu && menuProject && (
        <ProjectTabMenu
          context={menu}
          project={menuProject}
          index={projects.indexOf(menuProject)}
          count={projects.length}
          disabled={actionsDisabled}
          onClose={(restoreFocus) => {
            setMenu(null);
            if (restoreFocus) focusTab(menuProject.id);
          }}
          onAction={(action) => menuAction(menuProject, action)}
        />
      )}
      <UpdateButton state={updateState} onClick={onShowUpdates} />
      <span className={`chrome-app-name ${stylex.props(styles.appName).className}`}>
        branchline<span {...stylex.props(styles.appNameDot)}>.</span>
      </span>
      <IconButton
        className={`app-settings-button ${stylex.props(styles.settingsButton).className}`}
        aria-label="App settings"
        title="Settings"
        aria-pressed={showSettings}
        disabled={showSettings || initializing || !window.reviewAPI}
        onClick={onOpenSettings}
      >
        <Settings2 size={15} />
      </IconButton>
    </div>
  );
}

function TabRenameInput({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null, restoreFocus: boolean) => void;
}) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (next: string | null, restoreFocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(next?.trim() || null, restoreFocus);
  };
  return (
    <input
      {...stylex.props(styles.renameInput)}
      aria-label="Project name"
      value={value}
      maxLength={200}
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value, false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null, true);
        }
      }}
    />
  );
}
