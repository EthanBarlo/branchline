import * as stylex from '@stylexjs/stylex';
import {
  ArrowDown,
  ArrowUp,
  Tag,
  Star,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  Search,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { colors, fonts, typeScale } from '../../theme/tokens.stylex';
import { GitBranchMenu, type GitBranchMenuAction, type GitBranchMenuContext } from './GitBranchMenu';
import { aggregateCount, branchTree, type BranchFolder, type GitSidebarBranch } from './branchTree';

export function BranchCounts({
  repositories,
}: {
  repositories: { incoming: number | null; outgoing: number | null; diverged: boolean }[];
}) {
  return (
    <span
      {...stylex.props(styles.counts)}
      title="Commit counts summed across repositories. — or ? means a destination is unavailable."
    >
      <span
        aria-label={`Incoming ${aggregateCount(repositories.map((repo) => repo.incoming))}`}
        {...stylex.props(styles.count, repositories.some((repo) => repo.incoming) && styles.incoming)}
      >
        <ArrowDown size={12} />
        {aggregateCount(repositories.map((repo) => repo.incoming))}
      </span>
      <span
        aria-label={`Outgoing ${aggregateCount(repositories.map((repo) => repo.outgoing))}`}
        {...stylex.props(styles.count, repositories.some((repo) => repo.outgoing) && styles.outgoing)}
      >
        <ArrowUp size={12} />
        {aggregateCount(repositories.map((repo) => repo.outgoing))}
      </span>
    </span>
  );
}

export function GitBranchSidebar({
  projectId,
  branches,
  repositoryCount,
  projectName,
  selected,
  loading,
  onSelect,
  busy,
  onAction,
  favourites,
  onToggleFavourite,
  cached,
  refreshing,
}: {
  projectId: string;
  branches: GitSidebarBranch[];
  repositoryCount: number;
  projectName: string;
  selected?: string;
  loading: boolean;
  onSelect: (name: string) => void;
  busy: boolean;
  cached: boolean;
  refreshing: boolean;
  favourites: ReadonlySet<string>;
  onToggleFavourite: (key: string) => void;
  onAction: (name: string, action: GitBranchMenuAction) => void;
}) {
  const [context, setContext] = useState<GitBranchMenuContext>();
  const contextBranch = branches.find((branch) => branch.key === context?.key);
  function closeMenu(restoreFocus = true) {
    if (restoreFocus && context?.anchor.isConnected) context.anchor.focus();
    setContext(undefined);
  }
  function openMenu(name: string, anchor: HTMLButtonElement, x: number, y: number) {
    if (selected !== name) onSelect(name);
    anchor.focus();
    const branch = branches.find((item) => item.key === name)!;
    setContext({ key: name, name: branch.name, remote: branch.remote, anchor, x, y });
  }
  const [query, setQuery] = useState('');
  const folderStorage = `branchline.git.folders.${projectId}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(folderStorage) ?? '[]');
      return new Set<string>(Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set<string>();
    }
  });
  const favouriteFocus = useRef<string | undefined>(undefined);
  function toggleFavourite(key: string) {
    favouriteFocus.current = key;
    onToggleFavourite(key);
  }
  useLayoutEffect(() => {
    if (!favouriteFocus.current) return;
    Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('[data-branch-key]') ?? [])
      .find((item) => item.dataset.branchKey === favouriteFocus.current)
      ?.focus();
    favouriteFocus.current = undefined;
  }, [favourites]);
  const clamp = (value: number) => Math.max(260, Math.min(520, window.innerWidth - 520, value));
  const [width, setWidth] = useState(() =>
    clamp(Number(localStorage.getItem('branchline.git.sidebarWidth')) || 320),
  );
  const origin = useRef<{ x: number; width: number; pointerId: number } | null>(null);
  useEffect(() => {
    const resize = () => setWidth((previous) => clamp(previous));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function saveWidth(value = width) {
    origin.current = null;
    localStorage.setItem('branchline.git.sidebarWidth', String(value));
  }
  const tree = useRef<HTMLUListElement>(null);
  const local = branchTree(
    branches.filter((branch) => !branch.remote),
    query,
    'Local',
    favourites,
  );
  const remotes = [...new Set(branches.flatMap((branch) => (branch.remote ? [branch.remote] : [])))]
    .sort()
    .map((remote) => ({
      ...branchTree(
        branches.filter((branch) => branch.remote === remote),
        query,
        `Remote/${remote}`,
        favourites,
      ),
      name: remote,
    }));
  const remote: BranchFolder = { path: 'Remote', name: 'Remote', folders: remotes, branches: [], pinned: [] };
  const matches = (folder: BranchFolder): boolean =>
    !!(folder.pinned.length || folder.branches.length || folder.folders.some(matches));
  const sections: BranchFolder[] = [{ ...local, name: 'Local' }, remote].filter(
    (folder) => !query || matches(folder),
  );
  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem(folderStorage, JSON.stringify([...next]));
      return next;
    });
  }
  function renderBranch(branch: GitSidebarBranch, folder: BranchFolder, depth: number, pinned = false) {
    const partial = branch.repositories.length < repositoryCount;
    const present = branch.repositories
      .map((repo) => (repo.path === '.' ? projectName : repo.path))
      .join(', ');
    const current = branch.repositories.filter((repo) => repo.current).length;
    const favourite = favourites.has(branch.key);
    const label = branch.remote ? `${branch.remote}/${branch.name}` : branch.name;
    const checkoutLabel =
      current === repositoryCount
        ? 'Checked out in all repositories'
        : `Checked out in ${current} of ${repositoryCount} repositories`;
    return (
      <li key={`branch:${branch.key}`} role="none" {...stylex.props(styles.branchRow)}>
        <button
          role="treeitem"
          aria-level={depth}
          aria-selected={selected === branch.key}
          aria-label={label}
          data-parent={folder.path}
          data-branch-key={branch.key}
          tabIndex={-1}
          title={`${label}${partial ? ` [${present}]` : ' · All repositories'}${current ? ` · ${checkoutLabel}` : ''}${favourite ? ' · Favourite' : ''}${branch.repositories.some((repo) => repo.diverged) ? ' · Diverged' : ''}`}
          {...stylex.props(styles.row, selected === branch.key && styles.selected)}
          style={{ paddingLeft: 12 + (depth - 1) * 16 }}
          aria-haspopup="menu"
          aria-expanded={context?.key === branch.key ? true : undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu(branch.key, event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(branch.key, event.currentTarget, rect.left + 20, rect.bottom);
            }
          }}
          onClick={() => onSelect(branch.key)}
        >
          {favourite ? (
            <Star
              size={13}
              fill="currentColor"
              aria-label="Favourite"
              {...stylex.props(styles.favouriteIcon, styles.invisible)}
            />
          ) : current ? (
            <Tag size={13} aria-label={checkoutLabel} {...stylex.props(styles.current)} />
          ) : (
            <GitBranch size={13} {...stylex.props(styles.branchIcon)} />
          )}
          <span {...stylex.props(styles.branchText)}>
            <span {...stylex.props(styles.label, !!current && styles.currentText)}>
              {pinned ? branch.name : branch.name.split('/').at(-1)}
            </span>
            {partial && <span {...stylex.props(styles.coverage)}>[{present}]</span>}
          </span>
          {!!current && favourite && (
            <Tag size={12} aria-label={checkoutLabel} {...stylex.props(styles.current)} />
          )}
          <BranchCounts repositories={branch.repositories} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`${favourite ? 'Unfavourite' : 'Favourite'} ${label}`}
          aria-pressed={favourite}
          title={favourite ? 'Remove from favourites' : 'Add to favourites'}
          {...stylex.props(
            styles.favouriteControl,
            favourite && styles.favourited,
            selected === branch.key && styles.favouriteSelected,
          )}
          style={{ left: 9 + (depth - 1) * 16 }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const anchor =
              event.currentTarget.parentElement!.querySelector<HTMLButtonElement>('[role="treeitem"]')!;
            openMenu(branch.key, anchor, event.clientX, event.clientY);
          }}
          onClick={() => toggleFavourite(branch.key)}
        >
          <Star size={12} fill={favourite ? 'currentColor' : 'none'} />
        </button>
      </li>
    );
  }
  function render(folder: BranchFolder, depth: number) {
    return (
      <>
        {folder.pinned.map((branch) => renderBranch(branch, folder, depth, true))}
        {folder.folders
          .filter((child) => !query || matches(child))
          .map((child) => {
            const expanded = !!query || !collapsed.has(child.path);
            return (
              <li key={`folder:${child.path}`} role="none">
                <button
                  role="treeitem"
                  aria-label={
                    child.path === 'Local' || child.path === 'Remote'
                      ? child.name
                      : child.path.replace(/^(Local|Remote)\//, '')
                  }
                  aria-level={depth}
                  aria-expanded={expanded}
                  aria-owns={`branch-folder-${encodeURIComponent(child.path)}`}
                  data-parent={folder.path}
                  data-folder={child.path}
                  tabIndex={-1}
                  {...stylex.props(
                    styles.row,
                    styles.folder,
                    (child.path === 'Local' || child.path === 'Remote') && styles.section,
                  )}
                  style={{ paddingLeft: 12 + (depth - 1) * 16 }}
                  onClick={() => toggle(child.path)}
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {child.path !== 'Local' && child.path !== 'Remote' && <Folder size={13} />}
                  <span {...stylex.props(styles.label)}>{child.name}</span>
                </button>
                {expanded && (
                  <ul
                    id={`branch-folder-${encodeURIComponent(child.path)}`}
                    role="group"
                    aria-label={child.name}
                    {...stylex.props(styles.list)}
                  >
                    {render(child, depth + 1)}
                  </ul>
                )}
              </li>
            );
          })}
        {folder.branches.map((branch) => renderBranch(branch, folder, depth))}
      </>
    );
  }
  return (
    <>
      <aside aria-label="Git branches" {...stylex.props(styles.sidebar)} style={{ width }}>
        <div {...stylex.props(styles.heading)}>
          <span>Branches</span>
          <span {...stylex.props(styles.quiet)}>{branches.length}</span>
        </div>
        <label {...stylex.props(styles.search)}>
          <Search size={13} />
          <input
            aria-label="Find a branch"
            placeholder="Find a branch…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            {...stylex.props(styles.input)}
          />
        </label>
        <div {...stylex.props(styles.scope)}>
          Across {repositoryCount} {repositoryCount === 1 ? 'repository' : 'repositories'}
          {(cached || refreshing) && (
            <span role="status" {...stylex.props(styles.refreshStatus)}>
              {cached
                ? refreshing
                  ? 'Cached · refreshing…'
                  : 'Cached · refresh failed'
                : 'Updating branches…'}
            </span>
          )}
        </div>
        <ul
          ref={tree}
          role="tree"
          aria-label="Project branches"
          {...stylex.props(styles.list, styles.tree)}
          tabIndex={branches.length ? 0 : -1}
          onFocus={(event) => {
            if (event.target === tree.current)
              tree.current
                .querySelector<HTMLButtonElement>('[aria-selected="true"], [role="treeitem"]')
                ?.focus();
          }}
          onKeyDown={(event) => {
            const items = Array.from(
              tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [],
            );
            const item = document.activeElement as HTMLButtonElement;
            const index = items.indexOf(item);
            let next: HTMLButtonElement | undefined;
            if (event.key === 'ArrowDown') next = items[Math.min(index + 1, items.length - 1)];
            else if (event.key === 'ArrowUp') next = items[Math.max(index - 1, 0)];
            else if (event.key === 'Home') next = items[0];
            else if (event.key === 'End') next = items.at(-1);
            else if (event.key === 'ArrowRight') {
              if (item.dataset.folder && item.getAttribute('aria-expanded') === 'false')
                toggle(item.dataset.folder!);
              else if (item.dataset.folder) next = items[index + 1];
            } else if (event.key === 'ArrowLeft') {
              if (item.dataset.folder && item.getAttribute('aria-expanded') === 'true' && !query)
                toggle(item.dataset.folder!);
              else next = items.find((candidate) => candidate.dataset.folder === item.dataset.parent);
            } else return;
            event.preventDefault();
            next?.focus();
          }}
        >
          {render({ path: '', name: '', folders: sections, branches: [], pinned: [] }, 1)}
        </ul>
        {!branches.length && (
          <p {...stylex.props(styles.empty)}>{loading ? 'Reading branches…' : 'No branches available.'}</p>
        )}
        {branches.length > 0 && !sections.some(matches) && (
          <p {...stylex.props(styles.empty)}>No matching branches.</p>
        )}
      </aside>
      {context && contextBranch && (
        <GitBranchMenu
          context={context}
          branch={contextBranch}
          repositoryCount={repositoryCount}
          busy={busy}
          favourite={favourites.has(contextBranch.key)}
          onClose={closeMenu}
          onAction={(key, action) => {
            if (action === 'favourite') toggleFavourite(key);
            else onAction(key, action);
          }}
        />
      )}
      <div
        role="separator"
        aria-label="Resize branch sidebar"
        aria-orientation="vertical"
        aria-valuemin={260}
        aria-valuemax={Math.max(260, Math.min(520, window.innerWidth - 520))}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        {...stylex.props(styles.resizer)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          origin.current = { x: event.clientX, width, pointerId: event.pointerId };
        }}
        onPointerMove={(event) => {
          if (origin.current?.pointerId === event.pointerId)
            setWidth(clamp(origin.current.width + event.clientX - origin.current.x));
        }}
        onPointerUp={() => saveWidth()}
        onPointerCancel={() => saveWidth()}
        onLostPointerCapture={() => {
          if (origin.current) saveWidth();
        }}
        onDoubleClick={() => {
          const value = clamp(320);
          setWidth(value);
          saveWidth(value);
        }}
        onKeyDown={(event) => {
          const value =
            event.key === 'ArrowLeft'
              ? width - 10
              : event.key === 'ArrowRight'
                ? width + 10
                : event.key === 'Home'
                  ? 260
                  : event.key === 'End'
                    ? 520
                    : undefined;
          if (value === undefined) return;
          event.preventDefault();
          const adjusted = clamp(value);
          setWidth(adjusted);
          saveWidth(adjusted);
        }}
      />
    </>
  );
}
const styles = stylex.create({
  branchRow: { position: 'relative', display: 'flex', alignItems: 'stretch' },
  invisible: { opacity: 0 },
  favouriteSelected: { backgroundColor: colors.interactive },
  favouriteIcon: { color: colors.warningStrong, flexShrink: 0 },
  currentText: { fontWeight: 600, color: colors.textPrimary },
  favouriteControl: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 20,
    padding: 0,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    backgroundColor: colors.panel,
    color: colors.textQuiet,
    opacity: { default: 0, ':hover': 1, ':focus-visible': 1 },
  },
  favourited: { color: colors.warningStrong, opacity: 1 },
  section: { color: colors.textDefault, fontWeight: 600, marginTop: 8 },
  refreshStatus: { display: 'block', marginTop: 5, color: colors.warningStrong },
  resizer: {
    width: 5,
    flexShrink: 0,
    cursor: 'col-resize',
    backgroundColor: {
      default: 'transparent',
      ':hover': colors.interactive,
      ':focus-visible': colors.interactive,
    },
    touchAction: 'none',
    marginLeft: -3,
    zIndex: 1,
  },
  sidebar: {
    minWidth: 260,
    flexShrink: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.panel,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
  },
  heading: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 12,
    fontSize: typeScale.compact,
    fontWeight: 600,
    color: colors.textDefault,
  },
  quiet: { fontWeight: 400, color: colors.textQuiet, fontFamily: fonts.code, fontSize: typeScale.small },
  search: {
    display: 'flex',
    gap: 7,
    alignItems: 'center',
    paddingInline: 9,
    marginInline: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: 5,
    color: colors.textMuted,
    backgroundColor: colors.canvas,
  },
  input: {
    width: '100%',
    minWidth: 0,
    height: 30,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontSize: typeScale.small,
    color: colors.textDefault,
    outline: 'none',
  },
  scope: { paddingInline: 16, paddingBlock: 12, fontSize: typeScale.micro, color: colors.textQuiet },
  list: { padding: 0, margin: 0, listStyle: 'none' },
  tree: { overflowY: 'auto', flex: '1', paddingBottom: 12, minHeight: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    width: '100%',
    minHeight: 28,
    paddingRight: 12,
    paddingBlock: 4,
    borderWidth: 0,
    textAlign: 'left',
    backgroundColor: {
      default: 'transparent',
      ':hover': colors.translucentSelected,
      ':focus-visible': colors.translucentSelected,
    },
    color: colors.textSecondary,
    outlineOffset: -2,
    fontSize: typeScale.small,
  },
  folder: { color: colors.textMuted, minHeight: 26 },
  selected: {
    backgroundColor: { default: colors.interactive, ':hover': colors.interactive },
    color: colors.textPrimary,
  },
  label: { overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
  branchText: { display: 'flex', flexDirection: 'column', flex: '1', minWidth: 0, gap: 2 },
  branchIcon: { flexShrink: 0, color: colors.textQuiet },
  coverage: {
    color: colors.textQuiet,
    fontSize: typeScale.micro,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  counts: { display: 'inline-flex', gap: 9, alignItems: 'center', flexShrink: 0 },
  count: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    color: colors.textQuiet,
    fontSize: typeScale.micro,
    fontFamily: fonts.code,
    whiteSpace: 'nowrap',
  },
  incoming: { color: colors.warningStrong },
  outgoing: { color: colors.successText },
  current: { color: colors.warningStrong, flexShrink: 0 },
  empty: { fontSize: typeScale.small, color: colors.textMuted, paddingInline: 16 },
});
