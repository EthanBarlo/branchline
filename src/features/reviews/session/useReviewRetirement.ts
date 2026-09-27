import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { flushSync } from 'react-dom';
import {
  isMergeComplete,
  type ClosedReviewCleanupResult,
  type RemoteReviewState,
} from '../../../../shared/integrations';
import { currentReviewId, type AppSettings, type Project, type Review } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments, hasReviewCommentBackups } from '../diff/commentAutosave';
import type { ReviewData } from './useReviewData';

type JiraLink = { key: string; url: string };
type JiraLinks = Record<string, JiraLink | null>;
type ClosedReviewNotice = {
  projectId: string;
  reviewId?: string;
  message: string;
  warning?: boolean;
};
type MergeCompletion = {
  reviewId: string;
  projectId: string;
  remote: RemoteReviewState;
  jiraLink: JiraLink | null;
};

type ReviewRetirementOptions = {
  data: ReviewData;
  closingReviewId: string | null;
  setClosingReviewId: (id: string | null) => void;
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setReviews: Dispatch<SetStateAction<Review[]>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  jiraLinks: JiraLinks;
  setJiraLinks: Dispatch<SetStateAction<JiraLinks>>;
  activateReview: (id: string | null) => void;
};

export function useReviewRetirement({
  data,
  closingReviewId,
  setClosingReviewId,
  setProjects,
  setReviews,
  setSettings,
  jiraLinks,
  setJiraLinks,
  activateReview,
}: ReviewRetirementOptions) {
  const [closedReviewNotice, setClosedReviewNotice] = useState<ClosedReviewNotice | null>(null);
  const [mergeCompletion, setMergeCompletion] = useState<MergeCompletion | null>(null);
  const closingReviewIds = useRef(new Set<string>());
  const closingDialogs = useRef(new Map<HTMLElement, boolean>());
  const { mounted, deletedReviewIds, selectedIdRef, selectedProjectRef, latestReviews } = data;

  async function mergeFinished(mergedReview: Review, state: RemoteReviewState) {
    if (!isMergeComplete(state)) return;
    await flushPendingComments();
    if (!mounted.current || deletedReviewIds.current.has(mergedReview.id)) return;
    // Capture navigation before removing the review; the result modal must not
    // depend on a review ID that no longer exists in storage.
    const jiraLink = await window.reviewAPI
      .getJiraTicketLink(mergedReview.id)
      .catch(() => jiraLinks[mergedReview.id] || null);
    const saved = await window.reviewAPI.completeMergedReview(mergedReview.id);
    deletedReviewIds.current.add(mergedReview.id);
    if (!mounted.current) return;
    setProjects(saved.projects);
    setReviews(saved.reviews);
    data.forgetReviews([mergedReview.id]);
    setMergeCompletion({
      reviewId: mergedReview.id,
      projectId: mergedReview.projectId,
      remote: state,
      jiraLink,
    });
    if (selectedIdRef.current === mergedReview.id) activateReview(currentReviewId(mergedReview.projectId));
  }

  function closedReviewsRemoved(result: ClosedReviewCleanupResult) {
    const savedIds = new Set(result.state.reviews.map((review) => review.id));
    const removed = new Set([
      ...result.removedIds,
      ...latestReviews.current.filter((review) => !savedIds.has(review.id)).map((review) => review.id),
    ]);
    for (const id of removed) deletedReviewIds.current.add(id);
    if (!mounted.current) return;
    const removedIds = [...removed];
    latestReviews.current = result.state.reviews;
    setProjects(result.state.projects);
    setReviews(result.state.reviews);
    setSettings(result.state.settings);
    data.forgetReviews(removedIds);
    setJiraLinks((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([key]) => !removed.has(key) && !removedIds.some((id) => key.startsWith(`${id}:`)),
        ),
      ),
    );
    try {
      if (removed.has(localStorage.getItem('branchline.selectedReview') || ''))
        localStorage.removeItem('branchline.selectedReview');
      for (const item of result.state.projects) {
        const key = `branchline.selectedReview.${item.id}`;
        if (removed.has(localStorage.getItem(key) || '')) localStorage.removeItem(key);
      }
    } catch {
      /* Optional display history cannot block confirmed removal. */
    }
    setMergeCompletion((previous) => (previous && removed.has(previous.reviewId) ? null : previous));
    if (selectedIdRef.current && removed.has(selectedIdRef.current)) {
      activateReview(selectedProjectRef.current ? currentReviewId(selectedProjectRef.current) : null);
    }
  }

  data.retireClosedReview.current = async (result) => {
    const { review: checkedReview, closedReview } = result;
    if (!mounted.current || !checkedReview.remote || deletedReviewIds.current.has(checkedReview.id))
      return deletedReviewIds.current.has(checkedReview.id);
    if (!closedReview) {
      setClosedReviewNotice((previous) => (previous?.reviewId === checkedReview.id ? null : previous));
      return false;
    }
    if (closedReview.status !== 'closed') {
      if (closedReview.reason)
        setClosedReviewNotice({
          projectId: checkedReview.projectId,
          reviewId: checkedReview.id,
          message: closedReview.reason,
          warning: true,
        });
      return false;
    }
    if (closingReviewIds.current.has(checkedReview.id)) return false;
    closingReviewIds.current.add(checkedReview.id);
    flushSync(() => setClosingReviewId(checkedReview.id));
    // Integration dialogs render outside the workspace through portals.
    for (const element of document.querySelectorAll<HTMLElement>('.integration-backdrop')) {
      if (!closingDialogs.current.has(element)) closingDialogs.current.set(element, element.inert);
      element.inert = true;
    }
    try {
      await flushPendingComments();
      if (hasReviewCommentBackups(checkedReview.id)) {
        setClosedReviewNotice({
          projectId: checkedReview.projectId,
          reviewId: checkedReview.id,
          message:
            'This completed review has recovered comment drafts. Open the affected files to save or discard them, or use closed-review cleanup to remove the review explicitly.',
          warning: true,
        });
        return false;
      }
      const removal = await window.reviewAPI.removeClosedReviews(
        checkedReview.projectId,
        [checkedReview.id],
        { automatic: true },
      );
      closedReviewsRemoved(removal);
      const retained = removal.retained.find((item) => item.reviewId === checkedReview.id);
      const removed = deletedReviewIds.current.has(checkedReview.id);
      if (mounted.current)
        setClosedReviewNotice({
          projectId: checkedReview.projectId,
          ...(removed ? {} : { reviewId: checkedReview.id }),
          warning: !!retained || !removed,
          message:
            retained?.reason ||
            (removed
              ? `${checkedReview.name} is complete and was removed from Branchline.`
              : 'This review was kept because its status changed. Refresh to check again.'),
        });
      return removed;
    } catch (reason) {
      if (mounted.current)
        setClosedReviewNotice({
          projectId: checkedReview.projectId,
          reviewId: checkedReview.id,
          message: `Could not close this completed review: ${errorMessage(reason)}`,
          warning: true,
        });
      return false;
    } finally {
      closingReviewIds.current.delete(checkedReview.id);
      if (!closingReviewIds.current.size) {
        for (const [element, inert] of closingDialogs.current) element.inert = inert;
        closingDialogs.current.clear();
      }
      if (mounted.current) setClosingReviewId([...closingReviewIds.current][0] || null);
    }
  };

  return {
    closingReviewId,
    closedReviewNotice,
    setClosedReviewNotice,
    mergeCompletion,
    setMergeCompletion,
    mergeFinished,
    closedReviewsRemoved,
  };
}
