import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteReviewLoadProgress, RemoteReviewState } from '../../../../shared/integrations';
import type { Review, ReviewFile, ReviewRefresh, ReviewSnapshot } from '../../../../shared/types';
import { reviewContextKey } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../diff/commentAutosave';
import {
  approvalHistoryKey,
  mergeReview,
  nextPendingFile,
  readApprovalHistory,
  reviewViewKey,
} from './reviewSession';

type ReviewDataOptions = {
  reviews: Review[];
  setReviews: Dispatch<SetStateAction<Review[]>>;
  selectedReviewId: string | null;
  selectedProjectId: string | null;
  paused: boolean;
  updateBusyRef: RefObject<boolean>;
  onContextChange: () => void;
  onTargetChanged: (projectId: string, baseBranch: string) => void;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useReviewData({
  reviews,
  setReviews,
  selectedReviewId,
  selectedProjectId,
  paused,
  updateBusyRef,
  onContextChange,
  onTargetChanged,
  setError,
}: ReviewDataOptions) {
  const [snapshots, setSnapshots] = useState<Record<string, ReviewSnapshot>>({});
  const [reviewMetadata, setReviewMetadata] = useState<
    Record<string, Pick<ReviewRefresh, 'inspection' | 'requiresTarget'>>
  >({});
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [changingTarget, setChangingTarget] = useState(false);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteReviewState>>({});
  const [remoteLoads, setRemoteLoads] = useState<Record<string, RemoteReviewLoadProgress>>({});
  const selectedIdRef = useRef(selectedReviewId);
  const selectedProjectRef = useRef(selectedProjectId);
  const deletedReviewIds = useRef(new Set<string>());
  const refreshInFlight = useRef(new Set<string>());
  const targetInFlight = useRef(new Set<string>());
  const targetVersions = useRef<Record<string, number>>({});
  const contexts = useRef<Record<string, string>>({});
  const mutationVersions = useRef<Record<string, number>>({});
  const latestFiles = useRef<Record<string, ReviewFile[]>>({});
  const explorerOrder = useRef<Record<string, string[]>>({});
  const [initialApprovalHistory] = useState(readApprovalHistory);
  const knownApprovals = useRef(initialApprovalHistory);
  const remoteLoadSequences = useRef<Record<string, number>>({});
  const refreshMutationVersions = useRef<Record<string, number>>({});
  const latestReviews = useRef(reviews);
  const retireClosedReview = useRef<(result: ReviewRefresh) => Promise<boolean>>(async () => false);
  const mounted = useRef(true);
  const contextChangeRef = useRef(onContextChange);
  const targetChangeRef = useRef(onTargetChanged);

  selectedIdRef.current = selectedReviewId;
  selectedProjectRef.current = selectedProjectId;
  latestReviews.current = reviews;
  contextChangeRef.current = onContextChange;
  targetChangeRef.current = onTargetChanged;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const initializeReviews = useCallback(
    (loaded: Review[]) => {
      const activeIds = new Set(loaded.map((item) => item.id));
      knownApprovals.current = Object.fromEntries(
        Object.entries(knownApprovals.current).filter(([key]) =>
          [...activeIds].some((id) => key.startsWith(`${id}:`)),
        ),
      );
      for (const item of loaded) {
        const key = reviewViewKey(item);
        knownApprovals.current[key] = { ...knownApprovals.current[key], ...item.approvals };
        for (const [context, feedback] of Object.entries(item.currentContexts || {})) {
          const contextKey = `${item.id}:${context}`;
          knownApprovals.current[contextKey] = {
            ...knownApprovals.current[contextKey],
            ...feedback.approvals,
          };
        }
      }
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
      contexts.current = Object.fromEntries(loaded.map((item) => [item.id, reviewContextKey(item)]));
      latestReviews.current = loaded;
      setReviews(loaded);
    },
    [setReviews],
  );

  const applyRefresh = useCallback(
    (id: string, result: ReviewRefresh, mutationVersion?: number) => {
      if (updateBusyRef.current) return;
      if (!mounted.current || selectedIdRef.current !== id || deletedReviewIds.current.has(id)) return;
      const context = reviewContextKey(result.review);
      const viewKey = reviewViewKey(result.review);
      const changedContext = contexts.current[id] !== undefined && contexts.current[id] !== context;
      if (changedContext) contextChangeRef.current();
      contexts.current[id] = context;
      latestFiles.current[viewKey] = result.snapshot.files;
      knownApprovals.current[viewKey] = { ...knownApprovals.current[viewKey], ...result.review.approvals };
      setReviewMetadata((previous) => ({
        ...previous,
        [id]: { inspection: result.inspection, requiresTarget: result.requiresTarget },
      }));
      setSnapshots((previous) => {
        const oldFiles = new Map(previous[viewKey]?.files.map((file) => [file.id, file]));
        const files = result.snapshot.files.map((file) => {
          const old = oldFiles.get(file.id);
          return old &&
            old.fingerprint === file.fingerprint &&
            old.source === file.source &&
            old.unavailable === file.unavailable &&
            old.tooLarge === file.tooLarge
            ? old
            : file;
        });
        return { ...previous, [viewKey]: { ...result.snapshot, files } };
      });
      const acceptReview =
        changedContext ||
        mutationVersion === undefined ||
        mutationVersion === (mutationVersions.current[id] || 0);
      if (acceptReview) setReviews((previous) => mergeReview(previous, result.review));
      // A refresh may finish after a comment or approval was saved. Preserve that
      // feedback when choosing the first file from newly available repositories.
      const selectionReview = acceptReview
        ? result.review
        : latestReviews.current.find((item) => item.id === id) || result.review;
      setSelectedFiles((previous) => {
        if (result.snapshot.files.some((file) => file.id === previous[viewKey])) return previous;
        const nextId = nextPendingFile(result.snapshot.files, selectionReview)?.id || '';
        return previous[viewKey] === nextId ? previous : { ...previous, [viewKey]: nextId };
      });
      setError(null);
    },
    [setError, setReviews, updateBusyRef],
  );

  useEffect(
    () =>
      window.reviewAPI?.onRemoteReviewLoadProgress?.((event) => {
        const { reviewId: id, result } = event;
        if (
          !mounted.current ||
          selectedIdRef.current !== id ||
          (result && selectedProjectRef.current !== result.review.projectId) ||
          deletedReviewIds.current.has(id)
        )
          return;
        if (event.sequence <= (remoteLoadSequences.current[id] ?? -1)) return;
        remoteLoadSequences.current[id] = event.sequence;
        setRemoteLoads((previous) => ({ ...previous, [id]: event }));
        if (result)
          applyRefresh(id, result, refreshMutationVersions.current[id] ?? mutationVersions.current[id] ?? 0);
        if (event.error) setError(event.error);
      }),
    [applyRefresh, setError],
  );

  const refresh = useCallback(
    async (id: string, _manual = false) => {
      if (updateBusyRef.current) return;
      if (refreshInFlight.current.has(id) || targetInFlight.current.has(id)) return;
      refreshInFlight.current.add(id);
      const version = mutationVersions.current[id] || 0;
      refreshMutationVersions.current[id] = version;
      const targetVersion = targetVersions.current[id] || 0;
      if (selectedIdRef.current === id) setRefreshing(true);
      try {
        const result = await window.reviewAPI.refreshReview(id);
        if (targetVersion !== (targetVersions.current[id] || 0)) return;
        applyRefresh(id, result, version);
        if (await retireClosedReview.current(result)) return;
        if (result.review.remote) {
          const remote = await window.reviewAPI.getRemoteReview(id);
          if (remote && mounted.current && !deletedReviewIds.current.has(id))
            setRemoteStates((previous) => ({ ...previous, [id]: remote }));
        }
      } catch (reason) {
        if (
          mounted.current &&
          selectedIdRef.current === id &&
          targetVersion === (targetVersions.current[id] || 0)
        )
          setError(errorMessage(reason));
      } finally {
        refreshInFlight.current.delete(id);
        if (mounted.current && selectedIdRef.current === id) setRefreshing(false);
      }
    },
    [applyRefresh, setError, updateBusyRef],
  );

  const selectedIsRemote = Boolean(reviews.find((item) => item.id === selectedReviewId)?.remote);
  useEffect(() => {
    if (!selectedReviewId || paused) return;
    void refresh(selectedReviewId);
    // Remote diffs stay stable until explicitly reopened, refreshed, or published.
    if (selectedIsRemote) return;
    const onFocus = () => {
      if (!document.hidden) void refresh(selectedReviewId);
    };
    const interval = setInterval(onFocus, 4000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [selectedReviewId, selectedIsRemote, paused, refresh]);

  const mutate = useCallback(
    async (operation: (id: string, context: string) => Promise<Review>) => {
      const review = reviews.find(
        (item) => item.id === selectedReviewId && item.projectId === selectedProjectId,
      );
      if (!review || selectedIdRef.current !== review.id)
        throw new Error('This review changed. Please try again in the current view.');
      const id = review.id;
      const context = reviewContextKey(review);
      const originalViewKey = reviewViewKey(review);
      mutationVersions.current[id] = (mutationVersions.current[id] || 0) + 1;
      const updated = await operation(id, context);
      if (mounted.current && !deletedReviewIds.current.has(id)) {
        latestReviews.current = mergeReview(latestReviews.current, updated);
        knownApprovals.current[originalViewKey] = {
          ...knownApprovals.current[originalViewKey],
          ...updated.approvals,
        };
        localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
        if (contexts.current[id] === context && reviewContextKey(updated) === context)
          setReviews((previous) => mergeReview(previous, updated));
        if (updated.remote) {
          const remote = await window.reviewAPI.getRemoteReview(id);
          if (remote && mounted.current && !deletedReviewIds.current.has(id))
            setRemoteStates((previous) => ({ ...previous, [id]: remote }));
        }
      }
      return updated;
    },
    [reviews, selectedProjectId, selectedReviewId, setReviews],
  );

  const forgetReviews = useCallback((ids: Iterable<string>) => {
    const removed = new Set(ids);
    const removedIds = [...removed];
    for (const id of removed) deletedReviewIds.current.add(id);
    const belongsToRemoved = (key: string) =>
      removed.has(key) || removedIds.some((id) => key.startsWith(`${id}:`));
    const withoutRemoved = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !belongsToRemoved(key)));
    setSnapshots(withoutRemoved);
    setReviewMetadata(withoutRemoved);
    setSelectedFiles(withoutRemoved);
    setRemoteStates(withoutRemoved);
    setRemoteLoads(withoutRemoved);
    contexts.current = withoutRemoved(contexts.current);
    mutationVersions.current = withoutRemoved(mutationVersions.current);
    targetVersions.current = withoutRemoved(targetVersions.current);
    refreshMutationVersions.current = withoutRemoved(refreshMutationVersions.current);
    remoteLoadSequences.current = withoutRemoved(remoteLoadSequences.current);
    latestFiles.current = withoutRemoved(latestFiles.current);
    explorerOrder.current = withoutRemoved(explorerOrder.current);
    knownApprovals.current = withoutRemoved(knownApprovals.current);
    for (const id of removed) {
      refreshInFlight.current.delete(id);
      targetInFlight.current.delete(id);
    }
    try {
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
    } catch {
      /* Optional display history cannot block confirmed removal. */
    }
  }, []);

  const isMounted = useCallback(() => mounted.current, []);
  const isReviewRemoved = useCallback((id: string) => deletedReviewIds.current.has(id), []);
  const getSelection = useCallback(
    () => ({ reviewId: selectedIdRef.current, projectId: selectedProjectRef.current }),
    [],
  );
  const isCurrentContext = useCallback(
    (review: Review) =>
      selectedIdRef.current === review.id && contexts.current[review.id] === reviewContextKey(review),
    [],
  );
  const getReviewedVersions = useCallback(
    (viewKey: string): Readonly<Record<string, string>> => knownApprovals.current[viewKey] || {},
    [],
  );
  const getExplorerOrder = useCallback((viewKey: string) => explorerOrder.current[viewKey]?.slice(), []);
  const recordExplorerOrder = useCallback((viewKey: string, ids: string[]) => {
    explorerOrder.current[viewKey] = [...ids];
  }, []);
  const selectFile = useCallback(
    (review: Review, fileId: string) => {
      if (!isCurrentContext(review)) return;
      const viewKey = reviewViewKey(review);
      setSelectedFiles((previous) => ({ ...previous, [viewKey]: fileId }));
    },
    [isCurrentContext],
  );
  const updateRemoteState = useCallback((id: string, state: RemoteReviewState) => {
    if (!deletedReviewIds.current.has(id)) setRemoteStates((previous) => ({ ...previous, [id]: state }));
  }, []);
  const registerReview = useCallback(
    (review: Review) => {
      contexts.current[review.id] = reviewContextKey(review);
      setReviews((previous) => mergeReview(previous, review));
    },
    [setReviews],
  );
  const registerReviews = useCallback(
    (loaded: Review[]) => {
      for (const review of loaded) contexts.current[review.id] = reviewContextKey(review);
      setReviews(loaded);
    },
    [setReviews],
  );
  const markReviewsDeleted = useCallback((ids: Iterable<string>) => {
    for (const id of ids) deletedReviewIds.current.add(id);
  }, []);
  const reconcileRemovedReviews = useCallback(
    (remaining: Review[], confirmedIds: Iterable<string>) => {
      const savedIds = new Set(remaining.map((review) => review.id));
      const removed = new Set([
        ...confirmedIds,
        ...latestReviews.current.filter((review) => !savedIds.has(review.id)).map((review) => review.id),
      ]);
      markReviewsDeleted(removed);
      if (!mounted.current) return null;
      latestReviews.current = remaining;
      setReviews(remaining);
      forgetReviews(removed);
      return removed;
    },
    [forgetReviews, markReviewsDeleted, setReviews],
  );
  const onReviewRefreshed = useCallback((handler: (result: ReviewRefresh) => Promise<boolean>) => {
    retireClosedReview.current = handler;
    return () => {
      if (retireClosedReview.current === handler) retireClosedReview.current = async () => false;
    };
  }, []);

  async function changeCurrentTarget(review: Review, target: string) {
    if (review.kind !== 'current' || !target || targetInFlight.current.has(review.id)) return;
    try {
      await flushPendingComments();
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    const id = review.id;
    targetVersions.current[id] = (targetVersions.current[id] || 0) + 1;
    targetInFlight.current.add(id);
    setChangingTarget(true);
    setError(null);
    try {
      const result = await window.reviewAPI.setCurrentTarget(review.projectId, target);
      if (!mounted.current || deletedReviewIds.current.has(id)) return;
      targetChangeRef.current(review.projectId, result.review.baseBranch);
      applyRefresh(id, result);
    } catch (reason) {
      if (selectedIdRef.current === id) setError(errorMessage(reason));
    } finally {
      targetInFlight.current.delete(id);
      if (mounted.current) setChangingTarget(false);
    }
  }

  async function refreshAfterRemoteChange(id: string) {
    if (deletedReviewIds.current.has(id)) return false;
    mutationVersions.current[id] = (mutationVersions.current[id] || 0) + 1;
    await refresh(id, true);
    return !deletedReviewIds.current.has(id);
  }

  async function saveFileApprovals({
    review,
    files,
    reviewed,
    activeFileId,
    availableFiles,
    historicalFiles,
  }: {
    review: Review;
    files: ReviewFile[];
    reviewed: boolean;
    activeFileId?: string;
    availableFiles: ReviewFile[];
    historicalFiles: Record<string, string>;
  }) {
    const viewKey = reviewViewKey(review);
    const chosenIds = new Set(files.map((file) => file.id));
    // Capture row order before reviewed rows disappear from the tree.
    const order = explorerOrder.current[viewKey]?.slice();
    await flushPendingComments();
    const updated = await mutate((id, context) =>
      window.reviewAPI.setApprovals(
        id,
        files.map((file) => ({ fileId: file.id, fingerprint: file.fingerprint })),
        reviewed,
        context,
      ),
    );
    if (!reviewed && knownApprovals.current[viewKey]) {
      for (const id of chosenIds) delete knownApprovals.current[viewKey][id];
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
    }
    if (
      reviewed &&
      activeFileId &&
      chosenIds.has(activeFileId) &&
      mounted.current &&
      isCurrentContext(review)
    ) {
      const available = (latestFiles.current[viewKey] || availableFiles).filter(
        (file) => !historicalFiles[file.id],
      );
      const nextId = nextPendingFile(available, updated, activeFileId, order)?.id || '';
      // Keep any file the user chose while the approval was saving.
      setSelectedFiles((previous) =>
        previous[viewKey] === activeFileId ? { ...previous, [viewKey]: nextId } : previous,
      );
    }
  }

  return {
    snapshots,
    reviewMetadata,
    selectedFiles,
    refreshing,
    changingTarget,
    remoteStates,
    remoteLoads,
    isMounted,
    isReviewRemoved,
    getSelection,
    isCurrentContext,
    getReviewedVersions,
    getExplorerOrder,
    recordExplorerOrder,
    selectFile,
    updateRemoteState,
    registerReview,
    registerReviews,
    markReviewsDeleted,
    reconcileRemovedReviews,
    onReviewRefreshed,
    changeCurrentTarget,
    refreshAfterRemoteChange,
    saveFileApprovals,
    initializeReviews,
    refresh,
    mutate,
    forgetReviews,
  };
}

export type ReviewData = ReturnType<typeof useReviewData>;
