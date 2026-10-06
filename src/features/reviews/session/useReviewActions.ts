import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiffSide, Project, Review, ReviewFile } from '../../../../shared/types';
import { reviewContextKey } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../diff/commentAutosave';
import { isApproved, nextPendingFile, reviewViewKey } from './reviewSession';
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
  setError,
  viewPreferences,
}: ReviewActionsOptions) {
  const [reanchorId, setReanchorId] = useState<string | null>(null);
  const [anchorRevision, setAnchorRevision] = useState(0);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { setQuery, setShowFiles, changeFilter } = viewPreferences;
  const { mutate, changingTarget, isCurrentContext, getExplorerOrder } = data;
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
    if (project && review) await data.changeCurrentTarget(review, target);
  }

  async function addComment(selection: CommentSelection, body: string, commentId: string) {
    if (!selectedFile) throw new Error('Select a file before adding feedback.');
    return addCommentForFile(selectedFile, selection, body, commentId);
  }

  async function addCommentForFile(
    file: ReviewFile,
    selection: CommentSelection,
    body: string,
    commentId: string,
  ) {
    await mutate((id, context) =>
      window.reviewAPI.addComment(
        id,
        {
          id: commentId,
          fileId: file.id,
          repoRelativePath: file.repoRelativePath,
          ...selection,
          path: selection.path ?? (selection.side === 'deletions' ? (file.oldPath ?? file.path) : file.path),
          fingerprint: selection.fingerprint ?? file.fingerprint,
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
    return review ? data.refreshAfterRemoteChange(review.id) : false;
  }

  async function reviewFiles(chosenFiles: ReviewFile[], markReviewed: boolean) {
    if (!review || !chosenFiles.length || approvalBusy) return;
    chosenFiles = chosenFiles.filter((file) => !historicalFiles[file.id]);
    if (!chosenFiles.length) return;
    if (markReviewed && chosenFiles.some((file) => file.unavailable)) {
      setError('Some selected files could not be loaded. Refresh them before marking them reviewed.');
      return;
    }
    setApprovalBusy(true);
    setError(null);
    try {
      await data.saveFileApprovals({
        review,
        files: chosenFiles,
        reviewed: markReviewed,
        activeFileId: selectedFile?.id,
        availableFiles: files,
        historicalFiles,
      });
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
      if (!isCurrentContext(review)) return;
      setCopyState('copied');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2500);
    } catch (reason) {
      if (isCurrentContext(review)) {
        setError(errorMessage(reason));
        setCopyState('idle');
      }
    }
  }

  async function selectFile(id: string) {
    if (!review) return;
    try {
      await flushPendingComments();
      data.selectFile(review, id);
      setNavigationRevision((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function nextUnreviewed() {
    if (!review) return;
    const next = nextPendingFile(pendingReviewFiles, review, selectedFile?.id, getExplorerOrder(viewKey));
    if (next) selectFile(next.id);
  }

  return {
    changingTarget,
    reanchorId,
    setReanchorId,
    anchorRevision,
    navigationRevision,
    copyState,
    approvalBusy,
    resetView,
    changeCurrentTarget,
    addComment,
    addCommentForFile,
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
