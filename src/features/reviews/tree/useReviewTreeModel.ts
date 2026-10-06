import { FileTree as FileTreeModel, prepareFileTreeInput } from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewFile } from '../../../../shared/types';
import { reviewFilePath } from './reviewFileOrder';
import { selectedReviewFiles } from './reviewTreeSelection';

import type { MouseEventHandler } from 'react';
import { rowDecorationColors } from './reviewTreeTheme';
import type { ReviewTreeProps } from './reviewTreeTypes';
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

export function useReviewTreeModel(props: ReviewTreeProps) {
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
    for (const comment of props.comments)
      if (!comment.resolved) counts.set(comment.fileId, (counts.get(comment.fileId) ?? 0) + 1);
    return counts;
  }, [props.comments]);
  const query = props.query.trim().toLowerCase();
  const visibleFiles = useMemo(
    () =>
      props.files.filter((file) => {
        if (
          props.filter === 'unreviewed' &&
          (props.historicalFiles?.[file.id] || props.approvals[file.id] === file.fingerprint)
        )
          return false;
        if (props.filter === 'commented' && !commentCounts.has(file.id)) return false;
        return !query || reviewFilePath(file).toLowerCase().includes(query);
      }),
    [props.files, props.filter, props.approvals, props.historicalFiles, commentCounts, query],
  );
  const byPath = useMemo(
    () => new Map(visibleFiles.map((file) => [reviewFilePath(file), file])),
    [visibleFiles],
  );
  const pathsKey = JSON.stringify([...byPath.keys()]);
  const paths = useMemo(() => [...byPath.keys()], [pathsKey]);
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths]);
  const directories = useMemo(() => directoryPaths(paths), [paths]);
  const selectedFile = visibleFiles.find((file) => file.id === (props.visibleFileId ?? props.selectedFileId));
  const activePath = selectedFile ? reviewFilePath(selectedFile) : null;
  const latest = useRef({ props, byPath, commentCounts });
  latest.current = { props, byPath, commentCounts };

  function navigateToFile(file: ReviewFile | undefined) {
    const { props } = latest.current;
    if (
      file &&
      (file.id !== props.selectedFileId || (props.visibleFileId && file.id !== props.visibleFileId))
    )
      props.onSelect(file.id);
  }

  function syncProjection() {
    const tree = modelRef.current;
    if (!tree || !mounted.current) return;
    tree
      .getFileTreeContainer()
      ?.shadowRoot?.querySelector('[role="tree"]')
      ?.setAttribute('aria-multiselectable', 'true');
    const rows = tree.getVisibleRows(0, tree.getVisibleCount() - 1);
    const ids = rows.flatMap((row) => {
      const file = row.kind === 'file' ? latest.current.byPath.get(row.path) : undefined;
      return file ? [file.id] : [];
    });
    if (lastOrder.current === null || !samePaths(ids, lastOrder.current)) {
      lastOrder.current = ids;
      latest.current.props.onOrderChange(ids);
    }
    const selected = tree.getSelectedPaths();
    setSelection((previous) => (samePaths(previous, selected) ? previous : [...selected]));
  }

  function selectOnly(path: string) {
    const tree = modelRef.current;
    if (!tree) return;
    selectionAnchor.current = path;
    selecting.current = true;
    try {
      for (const selected of tree.getSelectedPaths())
        if (selected !== path) tree.getItem(selected)?.deselect();
      tree.getItem(path)?.select();
    } finally {
      selecting.current = false;
    }
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
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'right-click',
        onOpen: (item) => {
          const tree = modelRef.current;
          if (!tree || tree.getSelectedPaths().includes(item.path)) return;
          selectOnly(item.path);
          const file = latest.current.byPath.get(item.path);
          navigateToFile(file);
        },
      },
    },
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
        const path =
          focused && selected.includes(focused) && latest.current.byPath.has(focused)
            ? focused
            : [...selected].reverse().find((item) => latest.current.byPath.has(item));
        const file = path ? latest.current.byPath.get(path) : undefined;
        navigateToFile(file);
      });
    },
    renderRowDecoration: ({ item }) => {
      const file = latest.current.byPath.get(item.path);
      if (!file) return null;
      const reviewed = latest.current.props.approvals[file.id] === file.fingerprint;
      const changed = !reviewed && Boolean(latest.current.props.reviewedVersions[file.id]);
      const count = latest.current.commentCounts.get(file.id) ?? 0;
      const historical = latest.current.props.historicalFiles?.[file.id];
      const state = historical || (reviewed ? 'Reviewed' : changed ? 'Changed' : 'Unreviewed');
      const decoration = rowDecorationColors;
      return {
        text: `${state}${count ? ` · ${count}` : ''}`,
        parts: [
          {
            text: `${historical ? '' : reviewed ? '✓ ' : changed ? '↻ ' : ''}${state}`,
            color: historical
              ? decoration.historical
              : reviewed
                ? decoration.reviewed
                : changed
                  ? decoration.changed
                  : decoration.pending,
          },
          ...(count ? [{ text: ` · ${count}`, color: decoration.count }] : []),
        ],
        title: [
          historical || (changed ? 'Needs re-review' : state),
          count ? `${count} open comment${count === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    },
  });
  modelRef.current = model;

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = model.subscribe(syncProjection);
    syncProjection();
    return () => {
      mounted.current = false;
      selectionRequest.current++;
      unsubscribe();
    };
  }, [model]);

  useEffect(() => {
    for (const path of previousDirectories.current) {
      const item = model.getItem(path);
      if (item && 'isExpanded' in item) expansion.current.set(path, item.isExpanded());
    }
    const initialExpandedPaths = directories.filter((path) => expansion.current.get(path) !== false);
    selecting.current = true;
    try {
      model.resetPaths({ preparedInput, initialExpandedPaths });
    } finally {
      selecting.current = false;
    }
    previousDirectories.current = directories;
    syncProjection();
  }, [model, preparedInput, directories]);

  useEffect(() => {
    model.setGitStatus(
      visibleFiles.map((file) => ({ path: reviewFilePath(file), status: gitStatuses[file.status] })),
    );
    const host = model.getFileTreeContainer();
    if (host) model.render({ fileTreeContainer: host });
    syncProjection();
  }, [
    model,
    visibleFiles,
    props.approvals,
    props.reviewedVersions,
    props.historicalFiles,
    props.theme,
    commentCounts,
  ]);

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
    } finally {
      selecting.current = false;
    }
    syncProjection();
  }, [model, activePath]);

  const selectedFiles = selectedReviewFiles(selection, byPath).filter(
    (file) => !props.historicalFiles?.[file.id],
  );
  const selectedDirectory = selection.some((path) => path.endsWith('/'));
  const busy = operationBusy || props.reviewBusy;
  const allReviewed =
    selectedFiles.length > 0 && selectedFiles.every((file) => props.approvals[file.id] === file.fingerprint);
  const noneReviewed = selectedFiles.every((file) => props.approvals[file.id] !== file.fingerprint);

  async function reviewFiles(files: ReviewFile[], approved: boolean) {
    files = files.filter((file) => !latest.current.props.historicalFiles?.[file.id]);
    if (busy || files.length === 0) return;
    setOperationBusy(true);
    setError('');
    try {
      await latest.current.props.onReviewFiles(files, approved);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setOperationBusy(false);
    }
  }

  const onClickCapture: MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.button !== 0) return;
    const row = event.nativeEvent
      .composedPath()
      .find(
        (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.itemPath !== undefined,
      );
    const path = row?.dataset.itemPath;
    if (!path) return;
    if (!event.shiftKey) {
      selectionAnchor.current = path;
      // Scroll tracking may already highlight this row. Pierre then emits no
      // selection change, but clicking it still requests diff navigation.
      if (!event.metaKey && !event.ctrlKey && model.getSelectedPaths().includes(path)) {
        const file = byPath.get(path);
        if (file) props.onSelect(file.id);
      }
      return;
    }
    // Public item.select() does not reset Pierre's private range anchor.
    // Keep Shift-click anchored to the active file after App-driven navigation.
    const rows = model.getVisibleRows(0, model.getVisibleCount() - 1);
    const end = rows.findIndex((item) => item.path === path);
    if (end < 0) return;
    const foundStart = rows.findIndex((item) => item.path === selectionAnchor.current);
    const start = foundStart < 0 ? end : foundStart;
    if (foundStart < 0) selectionAnchor.current = path;
    const range = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
    const next = new Set(event.metaKey || event.ctrlKey ? model.getSelectedPaths() : []);
    for (const item of range) next.add(item.path);
    event.preventDefault();
    event.stopPropagation();
    selecting.current = true;
    try {
      for (const selected of model.getSelectedPaths())
        if (!next.has(selected)) model.getItem(selected)?.deselect();
      for (const selected of next) model.getItem(selected)?.select();
      model.focusPath(path);
    } finally {
      selecting.current = false;
    }
    syncProjection();
    const endpointOrder = end >= start ? [...range].reverse() : range;
    const endpoint = endpointOrder.find((item) => byPath.has(item.path));
    const file = endpoint ? byPath.get(endpoint.path) : undefined;
    navigateToFile(file);
  };

  return {
    model,
    visibleFiles,
    byPath,
    query,
    selectedFiles,
    selectedDirectory,
    busy,
    allReviewed,
    noneReviewed,
    error,
    setError,
    reviewFiles,
    onClickCapture,
  };
}
