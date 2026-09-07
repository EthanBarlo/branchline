import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { FileTree as FileTreeModel, prepareFileTreeInput, themeToTreeStyles, type ContextMenuOpenContext } from '@pierre/trees';
import { Check, CheckCheck, LoaderCircle, RotateCcw, Search, X } from 'lucide-react';
import type { ReviewComment, ReviewFile } from '../../shared/types';
import { reviewFilePath } from './reviewFileOrder';
import './review-components.css';
import './review-tree-actions.css';

interface ReviewTreeProps {
  files: ReviewFile[];
  selectedFileId: string | null;
  approvals: Record<string, string>;
  reviewedVersions: Record<string, string>;
  comments: ReviewComment[];
  onSelect: (id: string) => void;
  onReviewFiles: (files: ReviewFile[], approved: boolean) => Promise<void>;
  reviewBusy: boolean;
  onOrderChange: (fileIds: string[]) => void;
  filter: 'all' | 'unreviewed' | 'commented';
  query: string;
}

const treeTheme = themeToTreeStyles({
  type: 'dark', bg: '#1e1e1e', fg: '#d0d0d0',
  colors: {
    'sideBar.background': '#1e1e1e',
    'sideBar.foreground': '#d0d0d0',
    'list.hoverBackground': '#2a2a2a',
    'list.activeSelectionBackground': '#373737',
    'list.activeSelectionForeground': '#eeeeee',
    'list.inactiveSelectionBackground': '#303030',
    'list.inactiveSelectionForeground': '#eeeeee',
    'focusBorder': '#a8a8a8',
    'gitDecoration.addedResourceForeground': '#99d79b',
    'gitDecoration.modifiedResourceForeground': '#d5ba7f',
    'gitDecoration.deletedResourceForeground': '#df9991',
    'gitDecoration.renamedResourceForeground': '#91bed2',
  },
});

const gitStatuses = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified' } as const;

function directoryPaths(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(`${parts.slice(0, depth).join('/')}/`);
  }
  return [...directories];
}

function samePaths(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

export function ReviewTree(props: ReviewTreeProps) {
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [operationBusy, setOperationBusy] = useState(false);
  const [error, setError] = useState('');
  const modelRef = useRef<FileTreeModel | null>(null);
  const selecting = useRef(false);
  const mounted = useRef(true);
  const selectionRequest = useRef(0);
  const selectionAnchor = useRef<string | null>(null);
  const lastOrder = useRef<string[] | null>(null);
  const expansion = useRef(new Map<string, boolean>());
  const previousDirectories = useRef<string[]>([]);
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of props.comments) if (!comment.resolved) counts.set(comment.fileId, (counts.get(comment.fileId) ?? 0) + 1);
    return counts;
  }, [props.comments]);
  const query = props.query.trim().toLowerCase();
  const visibleFiles = useMemo(() => props.files.filter(file => {
    if (props.filter === 'unreviewed' && props.approvals[file.id] === file.fingerprint) return false;
    if (props.filter === 'commented' && !commentCounts.has(file.id)) return false;
    return !query || reviewFilePath(file).toLowerCase().includes(query);
  }), [props.files, props.filter, props.approvals, commentCounts, query]);
  const byPath = useMemo(() => new Map(visibleFiles.map(file => [reviewFilePath(file), file])), [visibleFiles]);
  const pathsKey = JSON.stringify([...byPath.keys()]);
  const paths = useMemo(() => [...byPath.keys()], [pathsKey]);
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths]);
  const directories = useMemo(() => directoryPaths(paths), [paths]);
  const selectedFile = visibleFiles.find(file => file.id === props.selectedFileId);
  const activePath = selectedFile ? reviewFilePath(selectedFile) : null;
  const latest = useRef({ props, byPath, commentCounts });
  latest.current = { props, byPath, commentCounts };

  function syncProjection() {
    const tree = modelRef.current;
    if (!tree || !mounted.current) return;
    tree.getFileTreeContainer()?.shadowRoot?.querySelector('[role="tree"]')?.setAttribute('aria-multiselectable', 'true');
    const rows = tree.getVisibleRows(0, tree.getVisibleCount() - 1);
    const ids = rows.flatMap(row => {
      const file = row.kind === 'file' ? latest.current.byPath.get(row.path) : undefined;
      return file ? [file.id] : [];
    });
    if (lastOrder.current === null || !samePaths(ids, lastOrder.current)) {
      lastOrder.current = ids;
      latest.current.props.onOrderChange(ids);
    }
    const selected = tree.getSelectedPaths();
    setSelection(previous => samePaths(previous, selected) ? previous : [...selected]);
  }

  function selectOnly(path: string) {
    const tree = modelRef.current;
    if (!tree) return;
    selectionAnchor.current = path;
    selecting.current = true;
    try {
      for (const selected of tree.getSelectedPaths()) if (selected !== path) tree.getItem(selected)?.deselect();
      tree.getItem(path)?.select();
    } finally { selecting.current = false; }
    syncProjection();
  }

  const { model } = useFileTree({
    preparedInput,
    initialExpansion: 'closed',
    initialExpandedPaths: directories,
    initialSelectedPaths: activePath ? [activePath] : [],
    flattenEmptyDirectories: true,
    icons: { set: 'standard', colored: false },
    density: 'default',
    composition: { contextMenu: {
      enabled: true,
      triggerMode: 'right-click',
      onOpen: (item) => {
        const tree = modelRef.current;
        if (!tree || tree.getSelectedPaths().includes(item.path)) return;
        selectOnly(item.path);
        const file = latest.current.byPath.get(item.path);
        if (file && file.id !== latest.current.props.selectedFileId) latest.current.props.onSelect(file.id);
      },
    } },
    onSelectionChange: () => {
      if (selecting.current) return;
      const request = ++selectionRequest.current;
      // Pierre updates focus after selection. Read the endpoint after the
      // pointer/keyboard handler completes, including upward Shift ranges.
      queueMicrotask(() => {
        if (!mounted.current || request !== selectionRequest.current) return;
        const tree = modelRef.current;
        if (!tree) return;
        const selected = tree.getSelectedPaths();
        const focused = tree.getFocusedPath();
        const path = focused && selected.includes(focused) && latest.current.byPath.has(focused)
          ? focused : [...selected].reverse().find(item => latest.current.byPath.has(item));
        const file = path ? latest.current.byPath.get(path) : undefined;
        if (file && file.id !== latest.current.props.selectedFileId) latest.current.props.onSelect(file.id);
      });
    },
    renderRowDecoration: ({ item }) => {
      const file = latest.current.byPath.get(item.path);
      if (!file) return null;
      const reviewed = latest.current.props.approvals[file.id] === file.fingerprint;
      const changed = !reviewed && Boolean(latest.current.props.reviewedVersions[file.id]);
      const count = latest.current.commentCounts.get(file.id) ?? 0;
      const state = reviewed ? 'Reviewed' : changed ? 'Changed' : 'Unreviewed';
      return {
        text: `${state}${count ? ` · ${count}` : ''}`,
        parts: [
          { text: `${reviewed ? '✓ ' : changed ? '↻ ' : ''}${state}`, color: reviewed ? '#d0d0d0' : changed ? '#efc17b' : '#969696' },
          ...(count ? [{ text: ` · ${count}`, color: '#b7b7b7' }] : []),
        ],
        title: [changed ? 'Needs re-review' : state, count ? `${count} open comment${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '),
      };
    },
  });
  modelRef.current = model;

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = model.subscribe(syncProjection);
    syncProjection();
    return () => { mounted.current = false; selectionRequest.current++; unsubscribe(); };
  }, [model]);

  useEffect(() => {
    for (const path of previousDirectories.current) {
      const item = model.getItem(path);
      if (item && 'isExpanded' in item) expansion.current.set(path, item.isExpanded());
    }
    const initialExpandedPaths = directories.filter(path => expansion.current.get(path) !== false);
    selecting.current = true;
    try { model.resetPaths({ preparedInput, initialExpandedPaths }); }
    finally { selecting.current = false; }
    previousDirectories.current = directories;
    syncProjection();
  }, [model, preparedInput, directories]);

  useEffect(() => {
    model.setGitStatus(visibleFiles.map(file => ({ path: reviewFilePath(file), status: gitStatuses[file.status] })));
    const host = model.getFileTreeContainer();
    if (host) model.render({ fileTreeContainer: host });
    syncProjection();
  }, [model, visibleFiles, props.approvals, props.reviewedVersions, commentCounts]);

  useEffect(() => {
    if (!activePath) return;
    if (selectionAnchor.current === null) selectionAnchor.current = activePath;
    // An App update that echoes a Shift-click endpoint must retain the range.
    // External selection (next file, feedback link) selects and reveals one file.
    if (!model.getSelectedPaths().includes(activePath)) selectOnly(activePath);
    const parts = activePath.split('/');
    selecting.current = true;
    try {
      for (let depth = 1; depth < parts.length; depth++) {
        const directory = model.getItem(`${parts.slice(0, depth).join('/')}/`);
        if (directory && 'expand' in directory) directory.expand();
      }
      model.scrollToPath(activePath, { offset: 'nearest', focus: false });
    } finally { selecting.current = false; }
    syncProjection();
  }, [model, activePath]);

  const selectedFiles = selection.flatMap(path => {
    const file = byPath.get(path);
    return file ? [file] : [];
  });
  const busy = operationBusy || props.reviewBusy;
  const allReviewed = selectedFiles.length > 0 && selectedFiles.every(file => props.approvals[file.id] === file.fingerprint);
  const noneReviewed = selectedFiles.every(file => props.approvals[file.id] !== file.fingerprint);

  async function reviewFiles(files: ReviewFile[], approved: boolean) {
    if (busy || files.length === 0) return;
    setOperationBusy(true);
    setError('');
    try { await latest.current.props.onReviewFiles(files, approved); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setOperationBusy(false); }
  }

  return <div className="review-file-tree review-file-tree-with-actions" onClickCapture={event => {
    if (event.button !== 0) return;
    const row = event.nativeEvent.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.itemPath !== undefined);
    const path = row?.dataset.itemPath;
    if (!path) return;
    if (!event.shiftKey) { selectionAnchor.current = path; return; }
    // Public item.select() does not reset Pierre's private range anchor.
    // Keep Shift-click anchored to the active file after App-driven navigation.
    const rows = model.getVisibleRows(0, model.getVisibleCount() - 1);
    const end = rows.findIndex(item => item.path === path);
    if (end < 0) return;
    const foundStart = rows.findIndex(item => item.path === selectionAnchor.current);
    const start = foundStart < 0 ? end : foundStart;
    if (foundStart < 0) selectionAnchor.current = path;
    const range = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
    const next = new Set(event.metaKey || event.ctrlKey ? model.getSelectedPaths() : []);
    for (const item of range) next.add(item.path);
    event.preventDefault(); event.stopPropagation();
    selecting.current = true;
    try {
      for (const selected of model.getSelectedPaths()) if (!next.has(selected)) model.getItem(selected)?.deselect();
      for (const selected of next) model.getItem(selected)?.select();
      model.focusPath(path);
    } finally { selecting.current = false; }
    syncProjection();
    const endpointOrder = end >= start ? [...range].reverse() : range;
    const endpoint = endpointOrder.find(item => byPath.has(item.path));
    const file = endpoint ? byPath.get(endpoint.path) : undefined;
    if (file && file.id !== props.selectedFileId) props.onSelect(file.id);
  }}>
    {selectedFiles.length > 1 && <div className="tree-selection-actions" role="group" aria-label="Selected file actions">
      <span aria-live="polite">{selectedFiles.length} selected</span>
      <button type="button" aria-label="Mark selected files reviewed" title="Mark selected files reviewed" disabled={busy || allReviewed} onClick={() => void reviewFiles(selectedFiles, true)}>{busy ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}<span>Mark reviewed</span></button>
      <button type="button" aria-label="Mark selected files unreviewed" title="Mark selected files unreviewed" disabled={busy || noneReviewed} onClick={() => void reviewFiles(selectedFiles, false)}><RotateCcw size={12} /></button>
    </div>}
    {error && <div className="tree-action-error" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss file review error" onClick={() => setError('')}><X size={12} /></button></div>}
    {visibleFiles.length === 0 ? <div className="review-tree-empty">
      {props.filter === 'unreviewed' && !query ? <CheckCheck size={24} /> : <Search size={24} />}
      <strong>{props.filter === 'unreviewed' && !query ? 'All caught up' : 'No matching files'}</strong>
      <p>{props.filter === 'unreviewed' && !query ? 'Every changed file has been reviewed.' : props.filter === 'commented' && !query ? 'Files with open comments will appear here.' : 'Try a different search or filter.'}</p>
    </div> : <FileTree model={model} className="review-tree-host" style={treeTheme} aria-label="Changed files" renderContextMenu={(item, context) => {
      const paths = model.getSelectedPaths();
      const targetPaths = paths.includes(item.path) ? paths : [item.path];
      const targets = targetPaths.flatMap(path => {
        const file = byPath.get(path);
        return file ? [file] : [];
      });
      return <TreeReviewMenu context={context} files={targets} approvals={props.approvals} busy={busy} onReview={reviewFiles} />;
    }} />}
  </div>;
}

function TreeReviewMenu({ context, files, approvals, busy, onReview }: {
  context: ContextMenuOpenContext;
  files: ReviewFile[];
  approvals: Record<string, string>;
  busy: boolean;
  onReview: (files: ReviewFile[], approved: boolean) => Promise<void>;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: context.anchorRect.left, top: context.anchorRect.top });
  const allReviewed = files.length > 0 && files.every(file => approvals[file.id] === file.fingerprint);
  const noneReviewed = files.every(file => approvals[file.id] !== file.fingerprint);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(context.anchorRect.left, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(context.anchorRect.top, window.innerHeight - rect.height - 8)) });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [context]);
  const perform = (approved: boolean) => {
    context.close({ restoreFocus: false });
    void onReview(files, approved);
  };
  return createPortal(<div ref={menu} className="tree-review-menu" data-file-tree-context-menu-root="true" role="menu" aria-label="File review actions" style={position} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); context.close(); return; }
    const options = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % options.length : event.key === 'ArrowUp' ? (current - 1 + options.length) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null;
    if (next !== null && options.length) { event.preventDefault(); event.stopPropagation(); options[next]?.focus(); }
  }}>
    <div className="tree-review-menu-label">{files.length === 1 ? files[0].path.split('/').at(-1) : `${files.length} files selected`}</div>
    <button type="button" role="menuitem" disabled={busy || !files.length || allReviewed} onClick={() => perform(true)}><Check size={14} />Mark reviewed</button>
    <button type="button" role="menuitem" disabled={busy || !files.length || noneReviewed} onClick={() => perform(false)}><RotateCcw size={14} />Mark unreviewed</button>
  </div>, document.body);
}
