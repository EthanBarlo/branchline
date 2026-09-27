import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { DiffSide, Project, Review, ReviewFile } from '../../../../shared/types';
import { reviewContextKey } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../diff/commentAutosave';
import { approvalHistoryKey, isApproved, nextPendingFile, reviewViewKey } from './reviewSession';
import type { ReviewData } from './useReviewData';
import type { useReviewViewPreferences } from './useReviewViewPreferences';

export type CommentSelection = {
  side: DiffSide;
  lineStart: number;
  lineEnd: number;
  context: string;
  contextBefore?: string;
  contextAfter?: string;
  fingerprint?: string;
  path?: string;
};

type ReviewActionsOptions = {
  data: ReviewData;
  review: Review | undefined;
  project: Project | undefined;
  files: ReviewFile[];
  selectedFile: ReviewFile | undefined;
  historicalFiles: Record<string, string>;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  viewPreferences: ReturnType<typeof useReviewViewPreferences>;
};

export function useReviewActions({
  data,
  review,
  project,
  files,
  selectedFile,
  historicalFiles,
  setProjects,
  setError,
  viewPreferences,
}: ReviewActionsOptions) {
  const [changingTarget, setChangingTarget] = useState(false);
  const [reanchorId, setReanchorId] = useState<string | null>(null);
  const [anchorRevision, setAnchorRevision] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { setQuery, setShowFiles, changeFilter } = viewPreferences;
  const {
    applyRefresh,
    contexts,
    deletedReviewIds,
    explorerOrder,
    knownApprovals,
    latestFiles,
    mounted,
    mutate,
    mutationVersions,
    refresh,
    selectedIdRef,
    setSelectedFiles,
    targetInFlight,
    targetVersions,
  } = data;
  const viewKey = review ? reviewViewKey(review) : '';
  const approved = Boolean(review && selectedFile && isApproved(review, selectedFile));
  const pendingReviewFiles = files.filter((file) => !historicalFiles[file.id]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const resetView = useCallback(() => {
    setReanchorId(null);
    setQuery('');
    setCopyState('idle');
    clearTimeout(copyTimer.current);
  }, [setQuery]);

  async function changeCurrentTarget(target: string) {
    if (!project || !review || review.kind !== 'current' || !target || targetInFlight.current.has(review.id))
      return;
    try {
      await flushPendingComments();
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    const id = review.id;
    const projectId = project.id;
    targetVersions.current[id] = (targetVersions.current[id] || 0) + 1;
    targetInFlight.current.add(id);
    setChangingTarget(true);
    setError(null);
    try {
      const result = await window.reviewAPI.setCurrentTarget(projectId, target);
      if (!mounted.current || deletedReviewIds.current.has(id)) return;
      setProjects((previous) =>
        previous.map((item) =>
          item.id === projectId ? { ...item, defaultBaseBranch: result.review.baseBranch } : item,
        ),
      );
      applyRefresh(id, result);
    } catch (reason) {
      if (selectedIdRef.current === id) setError(errorMessage(reason));
    } finally {
      targetInFlight.current.delete(id);
      if (mounted.current) setChangingTarget(false);
    }
  }

  async function addComment(selection: CommentSelection, body: string, commentId: string) {
    if (!selectedFile) throw new Error('Select a file before adding feedback.');
    await mutate((id, context) =>
      window.reviewAPI.addComment(
        id,
        {
          id: commentId,
          fileId: selectedFile.id,
          repoRelativePath: selectedFile.repoRelativePath,
          ...selection,
          path:
            selection.path ??
            (selection.side === 'deletions'
              ? (selectedFile.oldPath ?? selectedFile.path)
              : selectedFile.path),
          fingerprint: selection.fingerprint ?? selectedFile.fingerprint,
          body,
        },
        context,
      ),
    );
  }

  async function updateComment(id: string, changes: { body?: string; resolved?: boolean }) {
    await mutate((reviewId, context) => window.reviewAPI.updateComment(reviewId, id, changes, context));
  }

  async function removeComment(id: string) {
    await mutate((reviewId, context) => window.reviewAPI.deleteComment(reviewId, id, context));
  }

  function beginReanchor(id: string) {
    const comment = review?.comments.find((item) => item.id === id);
    if (!comment) return;
    setReanchorId(id);
    setShowFiles(true);
    changeFilter('all');
    const file = files.find((item) => item.id === comment.fileId);
    if (file) selectFile(file.id);
  }

  async function reanchorSelection(selection: CommentSelection) {
    if (!reanchorId || !selectedFile) return;
    await flushPendingComments();
    await mutate((id) =>
      window.reviewAPI.reanchorComment(id, reanchorId, {
        fileId: selectedFile.id,
        fingerprint: selectedFile.fingerprint,
        side: selection.side,
        lineStart: selection.lineStart,
        lineEnd: selection.lineEnd,
      }),
    );
    setReanchorId(null);
    setAnchorRevision((value) => value + 1);
  }

  async function remoteChanged() {
    if (!review || deletedReviewIds.current.has(review.id)) return false;
    mutationVersions.current[review.id] = (mutationVersions.current[review.id] || 0) + 1;
    await refresh(review.id, true);
    return !deletedReviewIds.current.has(review.id);
  }

  async function reviewFiles(chosenFiles: ReviewFile[], markReviewed: boolean) {
    if (!review || !chosenFiles.length || approvalBusy) return;
    chosenFiles = chosenFiles.filter((file) => !historicalFiles[file.id]);
    if (!chosenFiles.length) return;
    if (markReviewed && chosenFiles.some((file) => file.unavailable)) {
      setError('Some selected files could not be loaded. Refresh them before marking them reviewed.');
      return;
    }
    const chosenIds = new Set(chosenFiles.map((file) => file.id));
    const activeId = selectedFile?.id;
    // Retain the visible row order before reviewed rows disappear from the tree.
    const order = explorerOrder.current[viewKey]?.slice();
    setApprovalBusy(true);
    setError(null);
    try {
      await flushPendingComments();
      const updated = await mutate((id, context) =>
        window.reviewAPI.setApprovals(
          id,
          chosenFiles.map((file) => ({ fileId: file.id, fingerprint: file.fingerprint })),
          markReviewed,
          context,
        ),
      );
      if (!markReviewed && knownApprovals.current[viewKey]) {
        for (const id of chosenIds) delete knownApprovals.current[viewKey][id];
        localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
      }
      if (
        markReviewed &&
        activeId &&
        chosenIds.has(activeId) &&
        mounted.current &&
        selectedIdRef.current === review.id &&
        contexts.current[review.id] === reviewContextKey(review)
      ) {
        const availableFiles = (latestFiles.current[viewKey] || files).filter(
          (file) => !historicalFiles[file.id],
        );
        const nextId = nextPendingFile(availableFiles, updated, activeId, order)?.id || '';
        // Keep any file the user chose while the approval was saving.
        setSelectedFiles((previous) =>
          previous[viewKey] === activeId ? { ...previous, [viewKey]: nextId } : previous,
        );
      }
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    } finally {
      setApprovalBusy(false);
    }
  }

  async function toggleApproval() {
    if (!selectedFile) return;
    try {
      await reviewFiles([selectedFile], !approved);
    } catch {
      /* The action error is shown above the review. */
    }
  }

  async function copyFeedback() {
    if (!review || copyState === 'copying') return;
    const id = review.id;
    const context = reviewContextKey(review);
    setCopyState('copying');
    try {
      await flushPendingComments();
      await window.reviewAPI.copyFeedback(id, context);
      if (selectedIdRef.current !== id || contexts.current[id] !== context) return;
      setCopyState('copied');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2500);
    } catch (reason) {
      if (selectedIdRef.current === id && contexts.current[id] === context) {
        setError(errorMessage(reason));
        setCopyState('idle');
      }
    }
  }

  async function selectFile(id: string) {
    if (!review) return;
    try {
      await flushPendingComments();
      if (selectedIdRef.current === review.id && contexts.current[review.id] === reviewContextKey(review))
        setSelectedFiles((previous) => ({ ...previous, [viewKey]: id }));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function nextUnreviewed() {
    if (!review) return;
    const next = nextPendingFile(
      pendingReviewFiles,
      review,
      selectedFile?.id,
      explorerOrder.current[viewKey],
    );
    if (next) selectFile(next.id);
  }

  return {
    changingTarget,
    reanchorId,
    setReanchorId,
    anchorRevision,
    copyState,
    approvalBusy,
    resetView,
    changeCurrentTarget,
    addComment,
    updateComment,
    removeComment,
    beginReanchor,
    reanchorSelection,
    remoteChanged,
    reviewFiles,
    toggleApproval,
    copyFeedback,
    selectFile,
    nextUnreviewed,
  };
}

export type ReviewActions = ReturnType<typeof useReviewActions>;
