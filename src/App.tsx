import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type {
  ClosedReviewCleanupResult,
  IntegrationState,
  RemoteReviewLoadProgress,
  RemoteReviewState,
} from '../shared/integrations';
import { isMergeComplete } from '../shared/integrations';
import { extractJiraTicketKey } from '../shared/jira';
import type {
  AppSettings,
  DiffSide,
  Project,
  Review,
  ReviewFile,
  ReviewRefresh,
  ReviewSnapshot,
} from '../shared/types';
import { currentReviewId, reviewContextKey } from '../shared/types';
import type { UpdateState } from '../shared/updates';
import { updatesBusy } from '../shared/updates';
import { ClosedReviewCleanup } from './features/integrations/ClosedReviewCleanup';
import {
  JiraIssuePanel,
  ProjectIntegrationDialog,
  PullRequestsDialog,
  RemoteReviewControls,
} from './features/integrations/index';
import { MergeCompletion } from './features/integrations/MergeCompletion';
import { AddProjectDialog } from './features/projects/AddProjectDialog';
import { ProjectSettingsDialog } from './features/projects/ProjectSettingsDialog';
import { ClosedReviewNotice } from './features/reviews/ClosedReviewNotice';
import { flushPendingComments, hasReviewCommentBackups } from './features/reviews/commentAutosave';
import { CopyFeedbackButton } from './features/reviews/CopyFeedbackButton';
import { CurrentSetup } from './features/reviews/CurrentSetup';
import { DiffWorkspace } from './features/reviews/DiffWorkspace';
import { ErrorBanner } from './features/reviews/ErrorBanner';
import { FeedbackPanel } from './features/reviews/FeedbackPanel';
import { FileSidebar } from './features/reviews/FileSidebar';
import { NewReviewDialog } from './features/reviews/NewReviewDialog';
import { PointerChanges } from './features/reviews/PointerChanges';
import { ReanchorBanner } from './features/reviews/ReanchorBanner';
import { RepositoryDetailsDialog } from './features/reviews/RepositoryDetailsDialog';
import { RepositoryWarnings } from './features/reviews/RepositoryWarnings';
import { orderReviewFiles } from './features/reviews/reviewFileOrder';
import { ReviewToolbar } from './features/reviews/ReviewToolbar';
import { useReviewViewPreferences } from './features/reviews/useReviewViewPreferences';
import { SettingsView, type SettingsSection } from './features/settings/SettingsView';
import { UpdateDetails } from './features/settings/UpdateControls';
import { AppChrome } from './features/workspace/AppChrome';
import { ConfirmDeletionDialog } from './features/workspace/ConfirmDeletionDialog';
import { HelpDialog } from './features/workspace/HelpDialog';
import { OpeningWorkspace } from './features/workspace/OpeningWorkspace';
import { useAppearance } from './features/workspace/useAppearance';
import { Welcome } from './features/workspace/Welcome';
import { WorkspaceLock } from './features/workspace/WorkspaceLock';
import { WorkspaceMenu } from './features/workspace/WorkspaceMenu';
import { readBootTheme } from './theme';
import { Dialog as Modal } from './ui/Dialog';
import { errorMessage } from './ui/errorMessage';

type CommentSelection = {
  side: DiffSide;
  lineStart: number;
  lineEnd: number;
  context: string;
  contextBefore?: string;
  contextAfter?: string;
  fingerprint?: string;
  path?: string;
};

const reviewViewKey = (review: Review) => `${review.id}:${reviewContextKey(review)}`;
const isApproved = (review: Review, file: ReviewFile) => review.approvals[file.id] === file.fingerprint;
function nextPendingFile(files: ReviewFile[], review: Review, afterId?: string, explorerIds?: string[]) {
  const byId = new Map(files.map((file) => [file.id, file]));
  const findNext = (ids: string[]) => {
    const start = ids.indexOf(afterId || '');
    for (const id of [...ids.slice(start + 1), ...ids.slice(0, start + 1)]) {
      const file = byId.get(id);
      if (file && !isApproved(review, file)) return file;
    }
  };
  const visible = explorerIds && findNext(explorerIds);
  return visible || findNext(orderReviewFiles(files).map((file) => file.id));
}
const approvalHistoryKey = 'branchline.reviewedVersions';
function readApprovalHistory(): Record<string, Record<string, string>> {
  try {
    const saved = JSON.parse(localStorage.getItem(approvalHistoryKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, files]) =>
          files &&
          typeof files === 'object' &&
          !Array.isArray(files) &&
          Object.values(files).every((value) => typeof value === 'string'),
      ),
    ) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function mergeReview(previous: Review[], incoming: Review): Review[] {
  const index = previous.findIndex((review) => review.id === incoming.id);
  if (index === -1) return [incoming, ...previous];
  if (JSON.stringify(previous[index]) === JSON.stringify(incoming)) return previous;
  return previous.map((review) => (review.id === incoming.id ? incoming : review));
}

export default function App() {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updatePreparing, setUpdatePreparing] = useState(false);
  const [closePreparing, setClosePreparing] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [updateBridgeError, setUpdateBridgeError] = useState<string | null>(null);
  const updateBusyRef = useRef(false);
  const updateRevision = useRef(-1);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ReviewSnapshot>>({});
  const [reviewMetadata, setReviewMetadata] = useState<
    Record<string, Pick<ReviewRefresh, 'inspection' | 'requiresTarget'>>
  >({});
  const [changingTarget, setChangingTarget] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [initializing, setInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewReview, setShowNewReview] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ jiraBaseUrl: '', theme: readBootTheme() });
  const resolvedTheme = useAppearance(settings.theme);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('appearance');
  const [showLegacyLinks, setShowLegacyLinks] = useState(false);
  const openingSettings = useRef(false);
  const [integrations, setIntegrations] = useState<IntegrationState>({ connections: [], projects: {} });
  const [integrationRevision, setIntegrationRevision] = useState(0);
  const [integrationProject, setIntegrationProject] = useState<Project | null>(null);
  const [showPullRequests, setShowPullRequests] = useState(false);
  const [cleanupProject, setCleanupProject] = useState<Project | null>(null);
  const [closingReviewId, setClosingReviewId] = useState<string | null>(null);
  const closingReviewIds = useRef(new Set<string>());
  const closingDialogs = useRef(new Map<HTMLElement, boolean>());
  const [closedReviewNotice, setClosedReviewNotice] = useState<{
    projectId: string;
    reviewId?: string;
    message: string;
    warning?: boolean;
  } | null>(null);
  const retireClosedReview = useRef<(result: ReviewRefresh) => Promise<boolean>>(async () => false);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteReviewState>>({});
  const [remoteLoads, setRemoteLoads] = useState<Record<string, RemoteReviewLoadProgress>>({});
  const remoteLoadSequences = useRef<Record<string, number>>({});
  const refreshMutationVersions = useRef<Record<string, number>>({});
  const latestReviews = useRef(reviews);
  latestReviews.current = reviews;
  const [jiraLinks, setJiraLinks] = useState<Record<string, { key: string; url: string } | null>>({});
  const [jiraLinkRevision, setJiraLinkRevision] = useState(0);
  const [mergeCompletion, setMergeCompletion] = useState<{
    reviewId: string;
    projectId: string;
    remote: RemoteReviewState;
    jiraLink: { key: string; url: string } | null;
  } | null>(null);
  const [reanchorId, setReanchorId] = useState<string | null>(null);
  const [anchorRevision, setAnchorRevision] = useState(0);
  const [openingJira, setOpeningJira] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRepoDetails, setShowRepoDetails] = useState(false);
  const [deleteReview, setDeleteReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState(false);
  const {
    query,
    setQuery,
    filter,
    changeFilter,
    diffStyle,
    setDiffStyle,
    showFiles,
    setShowFiles,
    toggleFiles,
    resizingFiles,
    setResizingFiles,
  } = useReviewViewPreferences();
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const selectedIdRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  const deletedReviewIds = useRef(new Set<string>());
  const refreshInFlight = useRef(new Set<string>());
  const targetInFlight = useRef(new Set<string>());
  const targetVersions = useRef<Record<string, number>>({});
  const contexts = useRef<Record<string, string>>({});
  const mutationVersions = useRef<Record<string, number>>({});
  const latestFiles = useRef<Record<string, ReviewFile[]>>({});
  const explorerOrder = useRef<Record<string, string[]>>({});
  const knownApprovals = useRef<Record<string, Record<string, string>>>(readApprovalHistory());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const loadIntegrations = useCallback(() => {
    if (!window.reviewAPI?.getIntegrations) return;
    void window.reviewAPI
      .getIntegrations()
      .then((state) => {
        if (mounted.current) {
          setIntegrations(state);
          setIntegrationRevision((value) => value + 1);
        }
      })
      .catch((reason) => {
        if (mounted.current) setError(errorMessage(reason));
      });
  }, []);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (!window.reviewAPI) {
      setError('The desktop connection is unavailable. Open Branchline from the desktop application.');
      setInitializing(false);
      return;
    }
    window.reviewAPI
      .getState()
      .then((state) => {
        if (cancelled) return;
        setProjects(state.projects);
        setReviews(state.reviews);
        setSettings(state.settings);
        const activeIds = new Set(state.reviews.map((item) => item.id));
        knownApprovals.current = Object.fromEntries(
          Object.entries(knownApprovals.current).filter(([key]) =>
            [...activeIds].some((id) => key.startsWith(`${id}:`)),
          ),
        );
        for (const item of state.reviews) {
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
        contexts.current = Object.fromEntries(state.reviews.map((item) => [item.id, reviewContextKey(item)]));
        const legacyReview = state.reviews.find(
          (item) => item.id === localStorage.getItem('branchline.selectedReview'),
        );
        const savedProjectId = localStorage.getItem('branchline.selectedProject');
        const firstProjectId =
          state.projects.find((item) => item.id === savedProjectId)?.id ||
          legacyReview?.projectId ||
          state.projects[0]?.id ||
          null;
        selectedProjectRef.current = firstProjectId;
        setSelectedProjectId(firstProjectId);
        const firstId = firstProjectId ? currentReviewId(firstProjectId) : null;
        selectedIdRef.current = firstId;
        setSelectedReviewId(firstId);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!window.reviewAPI) return;
    let active = true;
    const receive = (state: UpdateState) => {
      if (!active || state.revision < updateRevision.current) return;
      updateRevision.current = state.revision;
      updateBusyRef.current = updatesBusy(state);
      flushSync(() => {
        setUpdateState(state);
        setUpdatePreparing(updatesBusy(state));
      });
    };
    const unsubscribe = window.reviewAPI.onUpdateStateChanged(receive);
    const unshow = window.reviewAPI.onUpdateDialogRequested(() => setShowUpdates(true));
    void window.reviewAPI
      .getUpdateState()
      .then(receive)
      .catch((reason) => {
        if (active) setUpdateBridgeError(errorMessage(reason));
      });
    return () => {
      active = false;
      unsubscribe();
      unshow();
    };
  }, []);

  useEffect(() => {
    return window.reviewAPI?.onBeforeClose(async (reason) => {
      if (reason === 'install') {
        updateBusyRef.current = true;
        flushSync(() => setUpdatePreparing(true));
      } else flushSync(() => setClosePreparing(true));
      try {
        await flushPendingComments();
      } catch (error) {
        if (reason === 'close') setClosePreparing(false);
        setError(errorMessage(error));
        throw error;
      }
    });
  }, []);

  useEffect(
    () =>
      window.reviewAPI?.onCloseCancelled?.((reason) => {
        setClosePreparing(false);
        if (reason) setError(reason);
      }),
    [],
  );

  const applyRefresh = useCallback((id: string, result: ReviewRefresh, mutationVersion?: number) => {
    if (updateBusyRef.current) return;
    if (!mounted.current || selectedIdRef.current !== id || deletedReviewIds.current.has(id)) return;
    const context = reviewContextKey(result.review);
    const viewKey = reviewViewKey(result.review);
    const changedContext = contexts.current[id] !== undefined && contexts.current[id] !== context;
    if (changedContext) {
      setQuery('');
      setShowFeedback(false);
      setShowRepoDetails(false);
      setCopyState('idle');
      clearTimeout(copyTimer.current);
    }
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
    if (acceptReview) {
      setReviews((previous) => mergeReview(previous, result.review));
    }
    // New repositories may arrive after a local approval or comment save. Keep
    // that feedback, but still offer the first newly available unreviewed file.
    const selectionReview = acceptReview
      ? result.review
      : latestReviews.current.find((item) => item.id === id) || result.review;
    setSelectedFiles((previous) => {
      if (result.snapshot.files.some((file) => file.id === previous[viewKey])) return previous;
      const nextId = nextPendingFile(result.snapshot.files, selectionReview)?.id || '';
      return previous[viewKey] === nextId ? previous : { ...previous, [viewKey]: nextId };
    });
    setError(null);
  }, []);

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
    [applyRefresh],
  );

  const refresh = useCallback(
    async (id: string, manual = false) => {
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
    [applyRefresh],
  );

  const selectedIsRemote = Boolean(reviews.find((item) => item.id === selectedReviewId)?.remote);
  useEffect(() => {
    if (!selectedReviewId || showSettings) return;
    void refresh(selectedReviewId);
    // Keep a PR's captured diff stable while reviewing. Opening the review,
    // manual refresh and publication are the explicit remote refresh points.
    if (selectedIsRemote) return;
    const interval = setInterval(() => {
      if (!document.hidden) void refresh(selectedReviewId);
    }, 4000);
    const onFocus = () => {
      if (!document.hidden) void refresh(selectedReviewId);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [selectedReviewId, selectedIsRemote, showSettings, refresh]);

  const project = projects.find((item) => item.id === selectedProjectId);
  const projectReviews = reviews.filter((item) => item.projectId === selectedProjectId);
  const savedReviews = projectReviews.filter((item) => item.kind !== 'current');
  const review = projectReviews.find((item) => item.id === selectedReviewId);
  const remote = review ? remoteStates[review.id] || null : null;
  const projectIntegration = project ? integrations.projects[project.id] : undefined;
  const viewKey = review ? reviewViewKey(review) : '';
  const isCurrent = review?.kind === 'current';
  const metadata = review ? reviewMetadata[review.id] : undefined;
  const featureBranch =
    isCurrent && metadata?.inspection ? metadata.inspection.currentBranch || '' : review?.featureBranch || '';
  const jiraTicket = extractJiraTicketKey(featureBranch);
  useEffect(() => {
    if (
      !review ||
      (!review.remote && !projectIntegration?.jiraConnectionId) ||
      !window.reviewAPI.getJiraTicketLink
    )
      return;
    let live = true;
    const id = review.id;
    void window.reviewAPI
      .getJiraTicketLink(id)
      .then((link) => {
        if (live && !deletedReviewIds.current.has(id))
          setJiraLinks((previous) => ({ ...previous, [id]: link }));
      })
      .catch(() => {
        if (live && !deletedReviewIds.current.has(id))
          setJiraLinks((previous) => ({ ...previous, [id]: null }));
      });
    return () => {
      live = false;
    };
  }, [
    review?.id,
    review?.remote,
    featureBranch,
    projectIntegration?.jiraConnectionId,
    integrationRevision,
    jiraLinkRevision,
    settings.jiraBaseUrl,
  ]);
  const currentDetached = Boolean(isCurrent && metadata?.inspection && !metadata.inspection.currentBranch);
  const currentNeedsTarget = Boolean(isCurrent && (metadata?.requiresTarget || !review.baseBranch));
  const snapshot = review ? snapshots[viewKey] : undefined;
  const remoteLoad = review ? remoteLoads[review.id] : undefined;
  const remoteLoading = Boolean(
    review?.remote && (refreshing || snapshot?.loading || (remoteLoad && !remoteLoad.complete)),
  );
  const loadingRepositories =
    remoteLoad?.repositories ||
    (review?.remote
      ? projectIntegration?.repositories.map((repository) => ({ repository, phase: 'queued' as const }))
      : undefined);
  const files = snapshot?.files || [];
  const incompleteSnapshot = Boolean(
    snapshot?.repos.some((repo) => repo.error) || files.some((file) => file.unavailable),
  );
  const pointerChanges =
    snapshot?.repos.flatMap((repo) =>
      (repo.pointers || []).map((pointer) => ({ ...pointer, repositoryPath: repo.relativePath })),
    ) || [];
  const historicalFiles = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        files.flatMap((file) => {
          const state = remote?.pullRequests.find(
            (pr) => pr.repository.relativePath === file.repoRelativePath,
          )?.state;
          const label =
            state === 'MERGED'
              ? 'Merged'
              : state === 'DECLINED'
                ? 'Declined'
                : state === 'SUPERSEDED'
                  ? 'Closed'
                  : undefined;
          return label ? [[file.id, label]] : [];
        }),
      ),
    [files, remote],
  );
  const pendingReviewFiles = useMemo(
    () => files.filter((file) => !historicalFiles[file.id]),
    [files, historicalFiles],
  );
  const selectedFile = files.find((file) => file.id === selectedFiles[viewKey]);
  const historicalFile = Boolean(selectedFile && historicalFiles[selectedFile.id]);
  const historicalState = selectedFile ? historicalFiles[selectedFile.id]?.toLowerCase() : undefined;
  const fileComments = useMemo(
    () => review?.comments.filter((comment) => comment.fileId === selectedFile?.id) || [],
    [review?.comments, selectedFile?.id],
  );
  const unresolvedComments = review?.comments.filter((comment) => !comment.resolved) || [];
  const approvedCount = review ? pendingReviewFiles.filter((file) => isApproved(review, file)).length : 0;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const approved = Boolean(review && selectedFile && isApproved(review, selectedFile));
  const priorApproval =
    review && selectedFile ? knownApprovals.current[viewKey]?.[selectedFile.id] : undefined;
  const staleApproval = Boolean(priorApproval && selectedFile && !approved);

  useEffect(() => {
    if (!review || filter !== 'unreviewed' || !selectedFile || !historicalFiles[selectedFile.id]) return;
    const nextId = nextPendingFile(pendingReviewFiles, review)?.id || '';
    setSelectedFiles((previous) => ({ ...previous, [viewKey]: nextId }));
  }, [review, filter, selectedFile, historicalFiles, pendingReviewFiles, viewKey]);

  function activateReview(id: string | null) {
    if (id && deletedReviewIds.current.has(id)) return;
    selectedIdRef.current = id;
    setSelectedReviewId(id);
    setReanchorId(null);

    setError(null);
    setRefreshing(false);
    setQuery('');
    setShowRepoDetails(false);
    setShowFeedback(false);
    setCopyState('idle');
    clearTimeout(copyTimer.current);
  }

  async function selectReview(id: string | null) {
    try {
      await flushPendingComments();
      const reopenRemote =
        id === selectedIdRef.current && reviews.some((item) => item.id === id && item.remote);
      activateReview(id);
      if (reopenRemote && id) await refresh(id, true);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function selectProject(id: string | null) {
    try {
      await flushPendingComments();
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    selectedProjectRef.current = id;
    setSelectedProjectId(id);
    if (id) localStorage.setItem('branchline.selectedProject', id);
    else localStorage.removeItem('branchline.selectedProject');
    activateReview(id ? currentReviewId(id) : null);
    setShowNewReview(false);
  }

  async function mutate(operation: (id: string, context: string) => Promise<Review>) {
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
  }

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

  async function projectCreated(created: Project) {
    const state = await window.reviewAPI.getState();
    setProjects(state.projects);
    setReviews(state.reviews);
    for (const item of state.reviews) contexts.current[item.id] = reviewContextKey(item);
    await selectProject(created.id);
    setShowAddProject(false);
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
    setRemoteStates((previous) => {
      const next = { ...previous };
      delete next[mergedReview.id];
      return next;
    });
    setRemoteLoads((previous) => {
      const next = { ...previous };
      delete next[mergedReview.id];
      return next;
    });
    for (const key of Object.keys(knownApprovals.current))
      if (key.startsWith(`${mergedReview.id}:`)) delete knownApprovals.current[key];
    try {
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
    } catch {
      /* Optional display history cannot block a confirmed completion. */
    }
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
    const removedIds = [...removed];
    for (const id of removed) deletedReviewIds.current.add(id);
    if (!mounted.current) return;
    const belongsToRemoved = (key: string) =>
      removed.has(key) || removedIds.some((id) => key.startsWith(`${id}:`));
    const withoutRemoved = <T,>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !belongsToRemoved(key)));
    latestReviews.current = result.state.reviews;
    setProjects(result.state.projects);
    setReviews(result.state.reviews);
    setSettings(result.state.settings);
    setSnapshots(withoutRemoved);
    setReviewMetadata(withoutRemoved);
    setSelectedFiles(withoutRemoved);
    setRemoteStates(withoutRemoved);
    setRemoteLoads(withoutRemoved);
    setJiraLinks(withoutRemoved);
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

  retireClosedReview.current = async (result) => {
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

  function remoteOpened(created: Review) {
    contexts.current[created.id] = reviewContextKey(created);
    setReviews((previous) => mergeReview(previous, created));
    void selectReview(created.id);
    setShowPullRequests(false);
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

  async function confirmDelete() {
    if (!deleteReview || removing) return;
    setRemoving(true);
    const id = deleteReview.id;
    try {
      await flushPendingComments();
      const state = await window.reviewAPI.deleteReview(id);
      deletedReviewIds.current.add(id);
      setProjects(state.projects);
      setReviews(state.reviews);
      if (selectedIdRef.current === id) {
        const next = selectedProjectRef.current ? currentReviewId(selectedProjectRef.current) : null;
        selectReview(next);
      }
      setDeleteReview(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
    }
  }

  async function confirmDeleteProject() {
    if (!deleteProject || removing) return;
    setRemoving(true);
    const id = deleteProject.id;
    try {
      await flushPendingComments();
      const state = await window.reviewAPI.deleteProject(id);
      for (const item of reviews) if (item.projectId === id) deletedReviewIds.current.add(item.id);
      setProjects(state.projects);
      setReviews(state.reviews);
      localStorage.removeItem(`branchline.selectedReview.${id}`);
      if (selectedProjectRef.current === id) void selectProject(state.projects[0]?.id || null);
      setDeleteProject(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
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

  async function openJira() {
    if (!review || openingJira) return;
    if (!settings.jiraBaseUrl) {
      void openSettings('jira', true);
      return;
    }
    setOpeningJira(true);
    try {
      await window.reviewAPI.openJiraTicket(review.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setOpeningJira(false);
    }
  }

  async function openSettings(section: SettingsSection = 'appearance', legacy = false) {
    if (openingSettings.current) return;
    openingSettings.current = true;
    try {
      await flushPendingComments();
      setSettingsSection(section);
      setShowLegacyLinks(legacy);
      setShowSettings(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      openingSettings.current = false;
    }
  }

  function closeSettings() {
    setShowSettings(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.app-settings-button')?.focus());
  }

  const copyButton = (inToolbar = false) => (
    <CopyFeedbackButton
      state={copyState}
      count={unresolvedComments.length}
      inToolbar={inToolbar}
      onCopy={() => void copyFeedback()}
    />
  );

  async function updateAction(action: 'check' | 'download' | 'install') {
    setUpdateBridgeError(null);
    try {
      await (action === 'check'
        ? window.reviewAPI.checkForUpdates()
        : action === 'download'
          ? window.reviewAPI.downloadUpdate()
          : window.reviewAPI.installUpdate());
    } catch (reason) {
      setUpdateBridgeError(errorMessage(reason));
    }
  }

  return (
    <>
      <div
        className={`app-shell compact-workspace ${stylex.props(styles.shell).className}`}
        inert={updatePreparing || closePreparing || !!closingReviewId}
      >
        <AppChrome
          projects={projects}
          selectedProjectId={selectedProjectId}
          showSettings={showSettings}
          initializing={initializing}
          updateState={updateState}
          onSelectProject={(id) => void selectProject(id)}
          onAddProject={() => setShowAddProject(true)}
          onShowUpdates={() => setShowUpdates(true)}
          onOpenSettings={() => void openSettings()}
        />
        {showSettings && (
          <SettingsView
            initialSection={settingsSection}
            showLegacyLinks={showLegacyLinks}
            settings={settings}
            ticket={jiraTicket}
            onSaved={setSettings}
            onConnectionsChanged={loadIntegrations}
            onClose={closeSettings}
            updateState={updateState}
            updateBridgeError={updateBridgeError}
            onUpdateAction={(action) => void updateAction(action)}
          />
        )}
        <div
          className={`application-body ${stylex.props(styles.body).className}`}
          hidden={showSettings}
          id="project-workspace"
          role={project ? 'tabpanel' : undefined}
          aria-labelledby={project && !showSettings ? `project-tab-${project.id}` : undefined}
        >
          <main className={`main-workspace ${stylex.props(styles.main).className}`}>
            {closedReviewNotice?.projectId === selectedProjectId &&
              (!closedReviewNotice.reviewId || closedReviewNotice.reviewId === selectedReviewId) && (
                <ClosedReviewNotice
                  message={closedReviewNotice.message}
                  warning={closedReviewNotice.warning}
                  onDismiss={() => setClosedReviewNotice(null)}
                />
              )}
            {error && (
              <ErrorBanner
                message={error}
                retry={review ? () => void refresh(review.id, true) : undefined}
                onDismiss={() => setError(null)}
              />
            )}
            {mergeCompletion?.projectId === selectedProjectId && (
              <MergeCompletion
                reviewId={mergeCompletion.reviewId}
                remote={mergeCompletion.remote}
                jiraLink={mergeCompletion.jiraLink}
                onDismiss={() => setMergeCompletion(null)}
              />
            )}
            {initializing ? (
              <OpeningWorkspace />
            ) : !review ? (
              project ? (
                <OpeningWorkspace projectName={project.name} />
              ) : (
                <Welcome onCreate={() => setShowAddProject(true)} />
              )
            ) : (
              <>
                <ReviewToolbar
                  review={review}
                  savedReviews={savedReviews}
                  isCurrent={isCurrent}
                  showFiles={showFiles}
                  onToggleFiles={toggleFiles}
                  onSelectReview={(id) => void selectReview(id)}
                  onNewReview={() => setShowNewReview(true)}
                  onBrowsePullRequests={() =>
                    projectIntegration?.bitbucketConnectionId
                      ? setShowPullRequests(true)
                      : project && setIntegrationProject(project)
                  }
                  inspection={metadata?.inspection}
                  changingTarget={changingTarget}
                  onChangeTarget={(target) => void changeCurrentTarget(target)}
                  featureBranch={featureBranch}
                  jiraTicket={jiraTicket}
                  jiraBaseUrl={settings.jiraBaseUrl}
                  jiraConnected={!!projectIntegration?.jiraConnectionId}
                  openingJira={openingJira}
                  onOpenJira={() => void openJira()}
                  refreshing={refreshing}
                  refreshError={!!error}
                  snapshot={snapshot}
                  onRefresh={() => void refresh(review.id, true)}
                  showFeedback={showFeedback}
                  feedbackCount={unresolvedComments.length}
                  onToggleFeedback={() => setShowFeedback(!showFeedback)}
                  remoteControls={
                    review.remote && (
                      <RemoteReviewControls
                        key={`remote:${review.id}`}
                        review={review}
                        remote={remote}
                        loadingRepositories={remoteLoading ? loadingRepositories : undefined}
                        reviewLoading={remoteLoading}
                        onRemote={(state) => {
                          if (!deletedReviewIds.current.has(review.id))
                            setRemoteStates((previous) => ({ ...previous, [review.id]: state }));
                        }}
                        onChanged={remoteChanged}
                        onReanchor={beginReanchor}
                        onMergeComplete={(state) => mergeFinished(review, state)}
                        jiraLink={jiraLinks[review.id] || null}
                      />
                    )
                  }
                  jiraPanel={
                    projectIntegration?.jiraConnectionId && (
                      <JiraIssuePanel
                        key={`jira:${review.id}`}
                        review={review}
                        ticket={
                          jiraLinks[review.id] === undefined ? jiraTicket : jiraLinks[review.id]?.key || null
                        }
                        currentBranch={isCurrent ? featureBranch || null : undefined}
                        ticketView={settings.jiraTicketView}
                        refreshKey={String(integrationRevision)}
                        onTicketChanged={() => setJiraLinkRevision((value) => value + 1)}
                      />
                    )
                  }
                  copyButton={!review.remote && copyButton(true)}
                  workspaceMenu={
                    <WorkspaceMenu
                      key={`${project?.id}:${review.id}`}
                      onCleanupClosed={
                        projectReviews.some((item) => item.remote)
                          ? () => project && setCleanupProject(project)
                          : undefined
                      }
                      onSettings={() => project && setSettingsProject(project)}
                      onRepositories={() => setShowRepoDetails(!showRepoDetails)}
                      onIntegrations={() => project && setIntegrationProject(project)}
                      onHelp={() => setShowHelp(true)}
                      onDelete={isCurrent ? undefined : () => setDeleteReview(review)}
                    />
                  }
                />
                <PointerChanges pointers={pointerChanges} fileCount={files.length} />
                {reanchorId && <ReanchorBanner onCancel={() => setReanchorId(null)} />}
                {showRepoDetails && (
                  <RepositoryDetailsDialog
                    snapshot={snapshot}
                    repoPath={review.repoPath}
                    needsTarget={currentNeedsTarget}
                    onClose={() => setShowRepoDetails(false)}
                  />
                )}
                <RepositoryWarnings warnings={snapshot?.warnings || []} />
                {isCurrent && (currentNeedsTarget || currentDetached) ? (
                  <CurrentSetup detached={currentDetached} onReviewBranch={() => setShowNewReview(true)} />
                ) : (
                  <div
                    className={`review-workbench ${resizingFiles ? 'resizing-files' : ''} ${stylex.props(styles.workbench, resizingFiles && styles.resizing).className}`}
                  >
                    {showFiles && (
                      <FileSidebar
                        viewKey={viewKey}
                        theme={resolvedTheme}
                        review={review}
                        files={files}
                        selectedFileId={selectedFile?.id ?? null}
                        historicalFiles={historicalFiles}
                        reviewedVersions={knownApprovals.current[viewKey] || {}}
                        pendingCount={pendingReviewFiles.length}
                        approvedCount={approvedCount}
                        additions={additions}
                        deletions={deletions}
                        filter={filter}
                        query={query}
                        loading={remoteLoading}
                        approvalBusy={approvalBusy}
                        onFilterChange={changeFilter}
                        onQueryChange={setQuery}
                        onSelectFile={selectFile}
                        onReviewFiles={reviewFiles}
                        onOrderChange={(ids) => {
                          explorerOrder.current[viewKey] = ids;
                        }}
                        onNextUnreviewed={nextUnreviewed}
                        onResizingChange={setResizingFiles}
                      />
                    )}
                    <DiffWorkspace
                      selectedFile={selectedFile}
                      snapshot={snapshot}
                      remoteLoading={remoteLoading}
                      loadingRepositories={loadingRepositories || undefined}
                      approvedCount={approvedCount}
                      pendingCount={pendingReviewFiles.length}
                      pointerChangeCount={pointerChanges.length}
                      incompleteSnapshot={incompleteSnapshot}
                      showFiles={showFiles}
                      onShowFiles={toggleFiles}
                      historicalState={historicalFile ? historicalState : undefined}
                      staleApproval={staleApproval}
                      diffStyle={diffStyle}
                      onDiffStyleChange={setDiffStyle}
                      approved={approved}
                      approvalBusy={approvalBusy}
                      onToggleApproval={() => void toggleApproval()}
                      viewerKey={`${viewKey}:${selectedFile?.id}:${anchorRevision}`}
                      viewerProps={{
                        theme: resolvedTheme,
                        draftScope: viewKey,
                        file: selectedFile!,
                        comments: fileComments,
                        diffStyle,
                        onAddComment: addComment,
                        onUpdateComment: updateComment,
                        onDeleteComment: removeComment,
                        isRemote: !!review.remote,
                        allowNewComments: !historicalFile,
                        publications: remote?.publications,
                        onBeginReanchor: beginReanchor,
                        reanchorCommentId: reanchorId,
                        onReanchorSelection: reanchorSelection,
                      }}
                    />
                    {showFeedback && (
                      <FeedbackPanel
                        key={viewKey}
                        review={review}
                        files={files}
                        onClose={() => setShowFeedback(false)}
                        onSelect={selectFile}
                        onUpdate={updateComment}
                        onDelete={removeComment}
                        onError={setError}
                        copyButton={copyButton()}
                        remote={remote}
                        onReanchor={beginReanchor}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </main>
        </div>
        {showUpdates && (
          <Modal title="Updates" onClose={() => setShowUpdates(false)} small>
            <UpdateDetails
              state={updateState}
              bridgeError={updateBridgeError}
              onAction={(action) => void updateAction(action)}
              onClose={() => setShowUpdates(false)}
            />
          </Modal>
        )}
        <div hidden={showUpdates}>
          {showAddProject && (
            <AddProjectDialog onClose={() => setShowAddProject(false)} onCreated={projectCreated} />
          )}
          {integrationProject && (
            <ProjectIntegrationDialog
              key={integrationProject.id}
              project={integrationProject}
              onClose={() => setIntegrationProject(null)}
              onSaved={loadIntegrations}
              onAccounts={() => {
                setIntegrationProject(null);
                void openSettings('bitbucket');
              }}
            />
          )}
          {cleanupProject && (
            <ClosedReviewCleanup
              key={cleanupProject.id}
              project={cleanupProject}
              reviews={reviews.filter((item) => item.projectId === cleanupProject.id && item.remote)}
              onClose={() => {
                setCleanupProject(null);
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>('[aria-label="Workspace menu"]')?.focus(),
                );
              }}
              onRemoved={closedReviewsRemoved}
            />
          )}
          {showPullRequests && project && (
            <PullRequestsDialog
              key={project.id}
              project={project}
              onClose={() => setShowPullRequests(false)}
              onOpened={remoteOpened}
              onSettings={() => {
                setShowPullRequests(false);
                setIntegrationProject(project);
              }}
            />
          )}
          {showNewReview && project && (
            <NewReviewDialog
              key={project.id}
              project={project}
              onClose={() => setShowNewReview(false)}
              onCreated={(created) => {
                contexts.current[created.id] = reviewContextKey(created);
                setReviews((previous) => mergeReview(previous, created));
                setProjects((previous) =>
                  previous.map((item) =>
                    item.id === created.projectId ? { ...item, defaultBaseBranch: created.baseBranch } : item,
                  ),
                );
                void selectReview(created.id);
                setShowNewReview(false);
              }}
            />
          )}
          {settingsProject && (
            <ProjectSettingsDialog
              project={settingsProject}
              currentTarget={
                reviews.find((item) => item.projectId === settingsProject.id && item.kind === 'current')
                  ?.baseBranch || ''
              }
              onClose={() => setSettingsProject(null)}
              onUpdated={(updated) => {
                setProjects((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
                setSettingsProject(null);
              }}
              onRemove={() => {
                setDeleteProject(settingsProject);
                setSettingsProject(null);
              }}
            />
          )}
          {deleteProject && (
            <ConfirmDeletionDialog
              target={{
                project: deleteProject,
                reviewCount: reviews.filter(
                  (item) => item.projectId === deleteProject.id && item.kind === 'saved',
                ).length,
              }}
              removing={removing}
              onClose={() => setDeleteProject(null)}
              onConfirm={() => void confirmDeleteProject()}
            />
          )}
          {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
          {deleteReview && (
            <ConfirmDeletionDialog
              target={{ review: deleteReview }}
              removing={removing}
              onClose={() => setDeleteReview(null)}
              onConfirm={() => void confirmDelete()}
            />
          )}
        </div>
      </div>
      <WorkspaceLock
        closingReview={!!closingReviewId}
        updatePreparing={updatePreparing}
        closePreparing={closePreparing}
        phase={updateState?.phase}
      />
    </>
  );
}

const styles = stylex.create({
  shell: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
  },
  body: {
    display: 'flex',
    flex: '1',
    minHeight: '0',
  },
  main: {
    minWidth: '0',
    flex: '1',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  },
  workbench: {
    position: 'relative',
    display: 'flex',
    flex: '1',
    minHeight: '0',
  },
  resizing: {},
});
