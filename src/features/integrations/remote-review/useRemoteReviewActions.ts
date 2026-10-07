import { useEffect, useRef, useState } from 'react';
import type { FeedbackPreview, MergePreview, RemoteReviewState } from '../../../../shared/integrations';
import { isMergeComplete } from '../../../../shared/integrations';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../../reviews/diff/commentAutosave';
import { remoteReviewState, type RemoteReviewAction } from './remoteReviewState';

interface RemoteReviewActionsOptions {
  reviewId: string;
  remote: RemoteReviewState | null;
  onRemote: (state: RemoteReviewState) => void;
  onChanged: () => Promise<boolean>;
  onMergeComplete: (state: RemoteReviewState) => Promise<void>;
}

export function useRemoteReviewActions({
  reviewId,
  remote,
  onRemote,
  onChanged,
  onMergeComplete,
}: RemoteReviewActionsOptions) {
  const [dialog, setDialog] = useState<RemoteReviewAction | null>(null);
  const [feedback, setFeedback] = useState<FeedbackPreview | null>(null);
  const [merge, setMerge] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [jiraError, setJiraError] = useState('');
  const [unknownIds, setUnknownIds] = useState<Record<string, string>>({});
  const [checkedDelivery, setCheckedDelivery] = useState<Record<string, boolean>>({});
  const [requestChanges, setRequestChanges] = useState(true);
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;
  useEffect(() => {
    return window.reviewAPI.onRemoteReviewChanged((event) => {
      if (event.reviewId === reviewId) {
        onRemoteRef.current(event.state);
      }
    });
  }, [reviewId]);
  async function preview(action: RemoteReviewAction) {
    setDialog(action);
    setLoading(true);
    setError('');
    setResult('');
    setJiraError('');
    setFeedback(null);
    setMerge(null);
    try {
      await flushPendingComments();
      if (action === 'merge' && isMergeComplete(remote)) {
        // Completion is already confirmed. Retrying local removal must also
        // work after the server saved it but its response was lost.
        setMerge({
          pullRequests: remote!.pullRequests,
          repositories: remote!.repositories,
          operation: remote!.operation,
          blockers: [],
          warnings: [],
          updateSubmodulePointers: false,
        });
        return;
      }
      if (action === 'publish') {
        setRequestChanges(true);
        // Publishing leaves the diff unchanged, so list local drafts at once and
        // confirm them against Bitbucket instead of reloading every file.
        setFeedback(await window.reviewAPI.previewFeedback(reviewId, { remote: false }));
        setFeedback(await window.reviewAPI.previewFeedback(reviewId));
      } else setMerge(await window.reviewAPI.previewMerge(reviewId, action));
      const state = await window.reviewAPI.getRemoteReview(reviewId);
      if (state) onRemote(state);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }
  async function run() {
    if (!dialog || busy) return;
    setBusy(true);
    setError('');
    setResult('');
    try {
      await flushPendingComments();
      if (dialog === 'merge' && isMergeComplete(remote)) {
        await onMergeComplete(remote!);
        setDialog(null);
        return;
      }
      if (dialog === 'publish') {
        const published = await window.reviewAPI.publishFeedback(reviewId, { requestChanges });
        onRemote(published.state);
        setFeedback(published.preview);
        if (published.warnings.length) setError(published.warnings.join('\n'));
        const requested = published.requestedChanges.length
          ? ` Changes requested on ${published.requestedChanges.map((id) => `PR #${id}`).join(', ')}.`
          : '';
        setResult(
          published.preview.items.length
            ? `Completed items are saved.${requested} Review the remaining items below.`
            : `Feedback published to Bitbucket.${requested}`,
        );
        return;
      }
      const state = await window.reviewAPI.runPullRequestAction(reviewId, dialog);
      onRemote(state);
      if (dialog === 'merge' && isMergeComplete(state)) {
        await onMergeComplete(state);
        setDialog(null);
        return;
      }
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      setMerge(await window.reviewAPI.previewMerge(reviewId, dialog));
    } catch (reason) {
      setError(errorMessage(reason));
      const state = await window.reviewAPI.getRemoteReview(reviewId).catch(() => null);
      if (state) onRemote(state);
    } finally {
      setBusy(false);
    }
  }
  async function conflict(commentId: string, choice: 'local' | 'remote') {
    setBusy(true);
    setError('');
    try {
      await flushPendingComments();
      await window.reviewAPI.resolveCommentConflict(reviewId, commentId, choice);
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      setFeedback(await window.reviewAPI.previewFeedback(reviewId));
      const state = await window.reviewAPI.getRemoteReview(reviewId);
      if (state) onRemote(state);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function reconcileUnknown(commentId: string, remoteId: number | null) {
    setBusy(true);
    setError('');
    try {
      onRemote(await window.reviewAPI.resolveUnknownPublication(reviewId, commentId, remoteId));
      if (!(await onChanged())) {
        setDialog(null);
        return;
      }
      setFeedback(await window.reviewAPI.previewFeedback(reviewId));
      setCheckedDelivery((previous) => ({ ...previous, [commentId]: false }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  async function openTicket() {
    setJiraError('');
    try {
      await window.reviewAPI.openJiraTicket(reviewId);
    } catch (reason) {
      setJiraError(errorMessage(reason));
    }
  }

  const view = remoteReviewState({ remote, feedback, merge, dialog, busy, loading });
  return {
    dialog,
    feedback,
    merge,
    busy,
    loading,
    error,
    result,
    jiraError,
    unknownIds,
    checkedDelivery,
    requestChanges,
    setRequestChanges,
    view,
    preview,
    run,
    conflict,
    reconcileUnknown,
    openTicket,
    close: () => setDialog(null),
    updateUnknownId: (commentId: string, value: string) =>
      setUnknownIds((previous) => ({ ...previous, [commentId]: value })),
    checkDelivery: (commentId: string, checked: boolean) =>
      setCheckedDelivery((previous) => ({ ...previous, [commentId]: checked })),
  };
}
export type RemoteReviewActions = ReturnType<typeof useRemoteReviewActions>;
