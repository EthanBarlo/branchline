import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { UpdateState } from '../shared/updates';
import { updatesBusy } from '../shared/updates';
import { UpdateButton, UpdateDetails } from './components/UpdateControls';
import {
  ArrowDownLeft, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown,
  Circle, CircleCheck, Clipboard, ExternalLink, FileCode2, FolderGit2, FolderOpen,
  GitBranch, GitCompareArrows, GitFork, HelpCircle, Layers3, LoaderCircle,
  MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2,
  TriangleAlert, X,
} from 'lucide-react';
import type { AppSettings, DiffSide, Project, RepoInspection, Review, ReviewFile, ReviewSnapshot, ReviewRefresh } from '../shared/types';
import { currentReviewId, reviewContextKey } from '../shared/types';
import { extractJiraTicketKey, jiraTicketUrl, normalizeJiraBaseUrl } from '../shared/jira';
import { DiffViewer } from './components/DiffViewer';
import { ReviewTree } from './components/ReviewTree';
import { orderReviewFiles } from './components/reviewFileOrder';
import { Select } from './components/Select';
import { flushPendingComments } from './components/commentAutosave';

type FileFilter = 'all' | 'unreviewed' | 'commented';
type CommentSelection = { side: DiffSide; lineStart: number; lineEnd: number; context: string; contextBefore?: string; contextAfter?: string; fingerprint?: string; path?: string };

const errorMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
const repositoryName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const fileLocation = (file: { repoRelativePath: string; path: string }) => [file.repoRelativePath === '.' ? '' : file.repoRelativePath, file.path].filter(Boolean).join('/');
const reviewViewKey = (review: Review) => `${review.id}:${reviewContextKey(review)}`;
const isApproved = (review: Review, file: ReviewFile) => review.approvals[file.id] === file.fingerprint;
function nextPendingFile(files: ReviewFile[], review: Review, afterId?: string, explorerIds?: string[]) {
  const byId = new Map(files.map(file => [file.id, file]));
  const findNext = (ids: string[]) => {
    const start = ids.indexOf(afterId || '');
    for (const id of [...ids.slice(start + 1), ...ids.slice(0, start + 1)]) {
      const file = byId.get(id);
      if (file && !isApproved(review, file)) return file;
    }
  };
  const visible = explorerIds && findNext(explorerIds);
  return visible || findNext(orderReviewFiles(files).map(file => file.id));
}
const approvalHistoryKey = 'branchline.reviewedVersions';
function readApprovalHistory(): Record<string, Record<string, string>> {
  try {
    const saved = JSON.parse(localStorage.getItem(approvalHistoryKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, files]) => files && typeof files === 'object' && !Array.isArray(files) && Object.values(files).every(value => typeof value === 'string'))) as Record<string, Record<string, string>>;
  } catch { return {}; }
}
const clampFileWidth = (width: number) => Math.max(180, Math.min(520, window.innerWidth - 500, width));

function mergeReview(previous: Review[], incoming: Review): Review[] {
  const index = previous.findIndex(review => review.id === incoming.id);
  if (index === -1) return [incoming, ...previous];
  if (JSON.stringify(previous[index]) === JSON.stringify(incoming)) return previous;
  return previous.map(review => review.id === incoming.id ? incoming : review);
}

function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-symbol"><GitCompareArrows size={small ? 19 : 22} strokeWidth={2.2} /></span><span>branchline<span className="brand-dot">.</span></span></div>;
}

export default function App() {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updatePreparing, setUpdatePreparing] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [updateBridgeError, setUpdateBridgeError] = useState<string | null>(null);
  const updateBusyRef = useRef(false);
  const updateRevision = useRef(-1);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ReviewSnapshot>>({});
  const [reviewMetadata, setReviewMetadata] = useState<Record<string, Pick<ReviewRefresh, 'inspection' | 'requiresTarget'>>>({});
  const [changingTarget, setChangingTarget] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [initializing, setInitializing] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewReview, setShowNewReview] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ jiraBaseUrl: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [openingJira, setOpeningJira] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRepoDetails, setShowRepoDetails] = useState(false);
  const [deleteReview, setDeleteReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FileFilter>(() => {
    const saved = localStorage.getItem('branchline.fileFilter');
    return saved === 'all' || saved === 'commented' ? saved : 'unreviewed';
  });
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied'>('idle');
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [showFiles, setShowFiles] = useState(() => localStorage.getItem('branchline.showFiles') !== 'false');
  const [filePaneWidth, setFilePaneWidth] = useState(() => clampFileWidth(Number(localStorage.getItem('branchline.filePaneWidth')) || 260));
  const [resizingFiles, setResizingFiles] = useState(false);
  const resizeOrigin = useRef<{ pointerId: number; x: number; width: number } | null>(null);
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

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    if (!window.reviewAPI) {
      setError('The desktop connection is unavailable. Open Branchline from the desktop application.');
      setInitializing(false);
      return;
    }
    window.reviewAPI.getState().then(state => {
      if (cancelled) return;
      setProjects(state.projects);
      setReviews(state.reviews);
      setSettings(state.settings);
      const activeIds = new Set(state.reviews.map(item => item.id));
      knownApprovals.current = Object.fromEntries(Object.entries(knownApprovals.current).filter(([key]) => [...activeIds].some(id => key.startsWith(`${id}:`))));
      for (const item of state.reviews) {
        const key = reviewViewKey(item);
        knownApprovals.current[key] = { ...knownApprovals.current[key], ...item.approvals };
        for (const [context, feedback] of Object.entries(item.currentContexts || {})) {
          const contextKey = `${item.id}:${context}`;
          knownApprovals.current[contextKey] = { ...knownApprovals.current[contextKey], ...feedback.approvals };
        }
      }
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
      contexts.current = Object.fromEntries(state.reviews.map(item => [item.id, reviewContextKey(item)]));
      const legacyReview = state.reviews.find(item => item.id === localStorage.getItem('branchline.selectedReview'));
      const savedProjectId = localStorage.getItem('branchline.selectedProject');
      const firstProjectId = state.projects.find(item => item.id === savedProjectId)?.id || legacyReview?.projectId || state.projects[0]?.id || null;
      selectedProjectRef.current = firstProjectId;
      setSelectedProjectId(firstProjectId);
      const firstId = firstProjectId ? currentReviewId(firstProjectId) : null;
      selectedIdRef.current = firstId;
      setSelectedReviewId(firstId);
    }).catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setInitializing(false); });
    return () => { cancelled = true; mounted.current = false; clearTimeout(copyTimer.current); };
  }, []);

  useEffect(() => {
    const resize = () => setFilePaneWidth(previous => clampFileWidth(previous));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (!window.reviewAPI) return;
    let active = true;
    const receive = (state: UpdateState) => {
      if (!active || state.revision < updateRevision.current) return;
      updateRevision.current = state.revision;
      updateBusyRef.current = updatesBusy(state);
      flushSync(() => { setUpdateState(state); setUpdatePreparing(updatesBusy(state)); });
    };
    const unsubscribe = window.reviewAPI.onUpdateStateChanged(receive);
    const unshow = window.reviewAPI.onUpdateDialogRequested(() => setShowUpdates(true));
    void window.reviewAPI.getUpdateState().then(receive).catch(reason => { if (active) setUpdateBridgeError(errorMessage(reason)); });
    return () => { active = false; unsubscribe(); unshow(); };
  }, []);

  useEffect(() => {
    return window.reviewAPI?.onBeforeClose(async reason => {
      if (reason === 'install') {
        updateBusyRef.current = true;
        flushSync(() => setUpdatePreparing(true));
      }
      try { await flushPendingComments(); }
      catch (reason) { setError(errorMessage(reason)); throw reason; }
    });
  }, []);

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
    setReviewMetadata(previous => ({ ...previous, [id]: { inspection: result.inspection, requiresTarget: result.requiresTarget } }));
    setSnapshots(previous => {
      const oldFiles = new Map(previous[viewKey]?.files.map(file => [file.id, file]));
      const files = result.snapshot.files.map(file => {
        const old = oldFiles.get(file.id);
        return old && old.fingerprint === file.fingerprint && old.source === file.source ? old : file;
      });
      return { ...previous, [viewKey]: { ...result.snapshot, files } };
    });
    if (changedContext || mutationVersion === undefined || mutationVersion === (mutationVersions.current[id] || 0)) {
      setReviews(previous => mergeReview(previous, result.review));
      setSelectedFiles(previous => {
        if (result.snapshot.files.some(file => file.id === previous[viewKey])) return previous;
        const nextId = nextPendingFile(result.snapshot.files, result.review)?.id || '';
        return previous[viewKey] === nextId ? previous : { ...previous, [viewKey]: nextId };
      });
    }
    setError(null);
  }, []);

  const refresh = useCallback(async (id: string, manual = false) => {
    if (updateBusyRef.current) return;
    if (refreshInFlight.current.has(id) || targetInFlight.current.has(id)) return;
    refreshInFlight.current.add(id);
    const version = mutationVersions.current[id] || 0;
    const targetVersion = targetVersions.current[id] || 0;
    if (selectedIdRef.current === id) setRefreshing(true);
    try {
      const result = await window.reviewAPI.refreshReview(id);
      if (targetVersion !== (targetVersions.current[id] || 0)) return;
      applyRefresh(id, result, version);
    } catch (reason) {
      if (mounted.current && selectedIdRef.current === id && targetVersion === (targetVersions.current[id] || 0)) setError(errorMessage(reason));
    } finally {
      refreshInFlight.current.delete(id);
      if (mounted.current && selectedIdRef.current === id) setRefreshing(false);
    }
  }, [applyRefresh]);

  useEffect(() => {
    if (!selectedReviewId) return;
    void refresh(selectedReviewId);
    const interval = setInterval(() => { if (!document.hidden) void refresh(selectedReviewId); }, 4000);
    const onFocus = () => void refresh(selectedReviewId);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [selectedReviewId, refresh]);

  const project = projects.find(item => item.id === selectedProjectId);
  const projectReviews = reviews.filter(item => item.projectId === selectedProjectId);
  const savedReviews = projectReviews.filter(item => item.kind !== 'current');
  const review = projectReviews.find(item => item.id === selectedReviewId);
  const viewKey = review ? reviewViewKey(review) : '';
  const isCurrent = review?.kind === 'current';
  const metadata = review ? reviewMetadata[review.id] : undefined;
  const featureBranch = isCurrent && metadata?.inspection ? metadata.inspection.currentBranch || '' : review?.featureBranch || '';
  const jiraTicket = extractJiraTicketKey(featureBranch);
  const currentDetached = Boolean(isCurrent && metadata?.inspection && !metadata.inspection.currentBranch);
  const currentNeedsTarget = Boolean(isCurrent && (metadata?.requiresTarget || !review.baseBranch));
  const snapshot = review ? snapshots[viewKey] : undefined;
  const files = snapshot?.files || [];
  const selectedFile = files.find(file => file.id === selectedFiles[viewKey]);
  const fileComments = useMemo(() => review?.comments.filter(comment => comment.fileId === selectedFile?.id) || [], [review?.comments, selectedFile?.id]);
  const unresolvedComments = review?.comments.filter(comment => !comment.resolved) || [];
  const approvedCount = review ? files.filter(file => isApproved(review, file)).length : 0;
  const progress = files.length ? Math.round(approvedCount / files.length * 100) : 0;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const approved = Boolean(review && selectedFile && isApproved(review, selectedFile));
  const priorApproval = review && selectedFile ? knownApprovals.current[viewKey]?.[selectedFile.id] : undefined;
  const staleApproval = Boolean(priorApproval && selectedFile && !approved);

  function changeFilter(value: FileFilter) {
    setFilter(value);
    localStorage.setItem('branchline.fileFilter', value);
  }

  function finishResize() {
    resizeOrigin.current = null;
    setResizingFiles(false);
    localStorage.setItem('branchline.filePaneWidth', String(filePaneWidth));
  }

  function toggleFiles() {
    setShowFiles(visible => {
      localStorage.setItem('branchline.showFiles', String(!visible));
      return !visible;
    });
  }

  function activateReview(id: string | null) {
    selectedIdRef.current = id;
    setSelectedReviewId(id);

    setError(null);
    setRefreshing(false);
    setQuery('');
    setShowRepoDetails(false);
    setShowFeedback(false);
    setCopyState('idle');
    clearTimeout(copyTimer.current);
  }

  async function selectReview(id: string | null) {
    try { await flushPendingComments(); activateReview(id); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  async function selectProject(id: string | null) {
    try { await flushPendingComments(); }
    catch (reason) { setError(errorMessage(reason)); return; }
    selectedProjectRef.current = id;
    setSelectedProjectId(id);
    if (id) localStorage.setItem('branchline.selectedProject', id);
    else localStorage.removeItem('branchline.selectedProject');
    activateReview(id ? currentReviewId(id) : null);
    setShowNewReview(false);
  }

  async function mutate(operation: (id: string, context: string) => Promise<Review>) {
    if (!review || selectedIdRef.current !== review.id) throw new Error('This review changed. Please try again in the current view.');
    const id = review.id;
    const context = reviewContextKey(review);
    const originalViewKey = reviewViewKey(review);
    mutationVersions.current[id] = (mutationVersions.current[id] || 0) + 1;
    const updated = await operation(id, context);
    if (mounted.current && !deletedReviewIds.current.has(id)) {
      knownApprovals.current[originalViewKey] = { ...knownApprovals.current[originalViewKey], ...updated.approvals };
      localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
      if (contexts.current[id] === context && reviewContextKey(updated) === context) setReviews(previous => mergeReview(previous, updated));
    }
    return updated;
  }

  async function changeCurrentTarget(target: string) {
    if (!project || !review || review.kind !== 'current' || !target || targetInFlight.current.has(review.id)) return;
    try { await flushPendingComments(); }
    catch (reason) { setError(errorMessage(reason)); return; }
    const id = review.id;
    const projectId = project.id;
    targetVersions.current[id] = (targetVersions.current[id] || 0) + 1;
    targetInFlight.current.add(id);
    setChangingTarget(true);
    setError(null);
    try {
      const result = await window.reviewAPI.setCurrentTarget(projectId, target);
      if (!mounted.current || deletedReviewIds.current.has(id)) return;
      setProjects(previous => previous.map(item => item.id === projectId ? { ...item, defaultBaseBranch: result.review.baseBranch } : item));
      applyRefresh(id, result);
    } catch (reason) { if (selectedIdRef.current === id) setError(errorMessage(reason)); }
    finally { targetInFlight.current.delete(id); if (mounted.current) setChangingTarget(false); }
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
    await mutate((id, context) => window.reviewAPI.addComment(id, {
      id: commentId,
      fileId: selectedFile.id, repoRelativePath: selectedFile.repoRelativePath,
      ...selection,
      path: selection.path ?? (selection.side === 'deletions' ? selectedFile.oldPath ?? selectedFile.path : selectedFile.path),
      fingerprint: selection.fingerprint ?? selectedFile.fingerprint, body,
    }, context));
  }

  async function updateComment(id: string, changes: { body?: string; resolved?: boolean }) {
    await mutate((reviewId, context) => window.reviewAPI.updateComment(reviewId, id, changes, context));
  }

  async function removeComment(id: string) {
    await mutate((reviewId, context) => window.reviewAPI.deleteComment(reviewId, id, context));
  }

  async function reviewFiles(chosenFiles: ReviewFile[], markReviewed: boolean) {
    if (!review || !chosenFiles.length || approvalBusy) return;
    const chosenIds = new Set(chosenFiles.map(file => file.id));
    const activeId = selectedFile?.id;
    // Retain the visible row order before reviewed rows disappear from the tree.
    const order = explorerOrder.current[viewKey]?.slice();
    setApprovalBusy(true);
    setError(null);
    try {
      await flushPendingComments();
      const updated = await mutate((id, context) => window.reviewAPI.setApprovals(id,
        chosenFiles.map(file => ({ fileId: file.id, fingerprint: file.fingerprint })), markReviewed, context));
      if (!markReviewed && knownApprovals.current[viewKey]) {
        for (const id of chosenIds) delete knownApprovals.current[viewKey][id];
        localStorage.setItem(approvalHistoryKey, JSON.stringify(knownApprovals.current));
      }
      if (markReviewed && activeId && chosenIds.has(activeId) && mounted.current && selectedIdRef.current === review.id && contexts.current[review.id] === reviewContextKey(review)) {
        const nextId = nextPendingFile(latestFiles.current[viewKey] || files, updated, activeId, order)?.id || '';
        // Keep any file the user chose while the approval was saving.
        setSelectedFiles(previous => previous[viewKey] === activeId ? { ...previous, [viewKey]: nextId } : previous);
      }
    } catch (reason) {
      setError(errorMessage(reason));
      throw reason;
    } finally { setApprovalBusy(false); }
  }

  async function toggleApproval() {
    if (!selectedFile) return;
    try { await reviewFiles([selectedFile], !approved); } catch { /* The action error is shown above the review. */ }
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
      if (selectedIdRef.current === id && contexts.current[id] === context) { setError(errorMessage(reason)); setCopyState('idle'); }
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
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setRemoving(false); }
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
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setRemoving(false); }
  }

  async function selectFile(id: string) {
    if (!review) return;
    try {
      await flushPendingComments();
      if (selectedIdRef.current === review.id && contexts.current[review.id] === reviewContextKey(review)) setSelectedFiles(previous => ({ ...previous, [viewKey]: id }));
    } catch (reason) { setError(errorMessage(reason)); }
  }

  function nextUnreviewed() {
    if (!review) return;
    const next = nextPendingFile(files, review, selectedFile?.id, explorerOrder.current[viewKey]);
    if (next) selectFile(next.id);
  }

  async function openJira() {
    if (!review || openingJira) return;
    if (!settings.jiraBaseUrl) { setShowSettings(true); return; }
    setOpeningJira(true);
    try { await window.reviewAPI.openJiraTicket(review.id); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setOpeningJira(false); }
  }

  const copyButton = <button className={`button button-primary copy-button ${copyState === 'copied' ? 'is-copied' : ''}`} disabled={!unresolvedComments.length || copyState === 'copying'} onClick={() => void copyFeedback()} title="Copy unresolved comments grouped by file, with line references">{copyState === 'copying' ? <LoaderCircle className="spin" size={15} /> : copyState === 'copied' ? <CheckCheck size={16} /> : <Clipboard size={15} />}<span>{copyState === 'copied' ? 'Copied feedback' : 'Copy feedback'}</span>{unresolvedComments.length > 0 && <span className="button-count">{unresolvedComments.length}</span>}</button>;

  async function updateAction(action: 'check' | 'download' | 'install') {
    setUpdateBridgeError(null);
    try {
      await (action === 'check' ? window.reviewAPI.checkForUpdates() : action === 'download' ? window.reviewAPI.downloadUpdate() : window.reviewAPI.installUpdate());
    } catch (reason) { setUpdateBridgeError(errorMessage(reason)); }
  }

  return <><div className="app-shell compact-workspace" inert={updatePreparing}>
    <div className="project-tab-strip window-chrome">
      <div className="project-tabs" role="tablist" aria-label="Projects">
        {projects.map((item, index) => <button key={item.id} id={`project-tab-${item.id}`} className={`project-tab ${selectedProjectId === item.id ? 'active' : ''}`} role="tab" aria-label={item.name} aria-selected={selectedProjectId === item.id} aria-controls="project-workspace" tabIndex={selectedProjectId === item.id ? 0 : -1} title={item.repoPath} onClick={() => selectProject(item.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % projects.length : event.key === 'ArrowLeft' ? (index - 1 + projects.length) % projects.length : event.key === 'Home' ? 0 : event.key === 'End' ? projects.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); selectProject(projects[next].id); document.getElementById(`project-tab-${projects[next].id}`)?.focus();
        }}><FolderGit2 size={13} /><span>{item.name}</span></button>)}
        <button className="add-project-tab" aria-label="Add project" title="Add project" onClick={() => setShowAddProject(true)}><Plus size={15} /></button>
      </div>
      <UpdateButton state={updateState} onClick={() => setShowUpdates(true)} />
      <span className="chrome-app-name">branchline<span>.</span></span>
      <button className="icon-button app-settings-button" aria-label="App settings" title="Settings" disabled={initializing || !window.reviewAPI} onClick={() => setShowSettings(true)}><Settings2 size={15} /></button>
    </div>
    <div className="application-body" id="project-workspace" role={project ? 'tabpanel' : undefined} aria-labelledby={project ? `project-tab-${project.id}` : undefined}>
      <main className="main-workspace">
        {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span>{review && <button onClick={() => void refresh(review.id, true)}>Retry</button>}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {initializing ? <div className="central-empty"><LoaderCircle size={28} className="spin" /><p>Opening your workspace…</p></div> : !review ? project ? <div className="central-empty"><LoaderCircle size={24} className="spin" /><h2>Opening Current</h2><p>Reading the branch checked out in {project.name}.</p></div> : <Welcome onCreate={() => setShowAddProject(true)} /> : <>
          <header className="review-toolbar" aria-label="Review controls">
            <button className="icon-button files-toggle" aria-label={showFiles ? 'Hide files' : 'Show files'} aria-expanded={showFiles} aria-controls="review-files" title={showFiles ? 'Hide file tree' : 'Show file tree'} onClick={toggleFiles}>{showFiles ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
            <Select className="review-picker" variant="quiet" label="Select review" title={isCurrent ? 'Current follows your checked-out branch' : review.name} value={review.id} searchPlaceholder="Find a review…" options={[
              { value: currentReviewId(review.projectId), label: 'Current', description: 'Follows your checkout' },
              ...savedReviews.map(item => ({ value: item.id, label: item.name, description: `${item.baseBranch} ← ${item.featureBranch}`, group: 'Saved reviews' })),
            ]} onChange={id => void selectReview(id)} />
            <button className="icon-button new-branch-review" aria-label="Review another branch" title="Review another branch" onClick={() => setShowNewReview(true)}><Plus size={14} /></button>
            <span className="toolbar-separator" />
            <div className="branch-comparison">
              {isCurrent ? <Select id="current-target-branch" className={`current-target-control ${!review.baseBranch ? 'needs-target' : ''}`} label="Current target branch" title={review.baseBranch ? `Target: ${review.baseBranch}` : 'Choose the target branch'} value={review.baseBranch} placeholder="Select target branch" searchPlaceholder="Find a branch…" icon={<GitBranch size={12} />} disabled={!metadata?.inspection || changingTarget} loading={changingTarget} options={(metadata?.inspection?.branches || []).map(branch => ({ value: branch, label: branch }))} onChange={target => void changeCurrentTarget(target)} /> : <span className="branch-chip" title={`Target: ${review.baseBranch}`}><GitBranch size={12} />{review.baseBranch}</span>}
              <ArrowLeft size={13} className="compare-arrow" />
              <span className="branch-chip feature-branch" title={`${isCurrent ? 'Checked out' : 'Feature branch'}: ${featureBranch || 'Detached HEAD'}`}><GitBranch size={12} />{featureBranch || (metadata?.inspection ? 'Detached HEAD' : 'Reading checkout…')}</span>
            </div>
            {jiraTicket && <button className="jira-ticket-button" aria-label={`Open ${jiraTicket} in Jira`} title={settings.jiraBaseUrl ? `Open ${jiraTicket} in Jira · ${settings.jiraBaseUrl}` : `Set up Jira to open ${jiraTicket}`} disabled={openingJira} onClick={() => void openJira()}><span>{jiraTicket}</span>{openingJira ? <LoaderCircle size={12} className="spin" /> : <ExternalLink size={12} />}</button>}
            <span className="working-tree-label" title={review.includeWorkingTree ? 'Includes eligible uncommitted changes and new files' : 'Reviewing committed changes only'}>{review.includeWorkingTree ? 'Local edits' : 'Commits only'}</span>
            <div className="toolbar-actions">
              <button className={`icon-button refresh-button ${error ? 'refresh-error' : ''}`} disabled={refreshing} onClick={() => void refresh(review.id, true)} aria-label="Refresh review" title={`${error ? 'Refresh failed. Click to retry.' : 'Automatically checks for changes every 4 seconds.'}${snapshot ? ` Last checked ${new Date(snapshot.refreshedAt).toLocaleTimeString()}.` : ''}`}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /></button>
              <button className={`button button-feedback ${showFeedback ? 'active' : ''}`} aria-label={`Feedback${unresolvedComments.length ? ` (${unresolvedComments.length})` : ''}`} aria-pressed={showFeedback} onClick={() => setShowFeedback(!showFeedback)} title="Show review feedback"><MessageSquare size={15} />{unresolvedComments.length > 0 && <span className="soft-count">{unresolvedComments.length}</span>}</button>
              {copyButton}
              <WorkspaceMenu key={`${project?.id}:${review.id}`} onSettings={() => project && setSettingsProject(project)} onRepositories={() => setShowRepoDetails(!showRepoDetails)} onHelp={() => setShowHelp(true)} onDelete={isCurrent ? undefined : () => setDeleteReview(review)} />
            </div>
          </header>
          {showRepoDetails && <div className="repository-details"><div className="repository-details-title"><strong>Repositories in this review</strong><span>Each comparison starts at its own merge base.</span><button className="icon-button" aria-label="Close repository details" onClick={() => setShowRepoDetails(false)}><X size={14} /></button></div>{snapshot?.repos.length ? snapshot.repos.map(repo => <div className="repository-detail" key={repo.relativePath}><GitFork size={14} /><span className="repository-detail-name">{repo.relativePath === '.' || !repo.relativePath ? repositoryName(review.repoPath) : repo.relativePath}</span>{repo.error ? <span className="repository-detail-error">{repo.error}</span> : <span>{repo.workingTreeIncluded ? 'Branch + working tree' : 'Branch commits'}</span>}</div>) : <p>{currentNeedsTarget ? 'Choose a target to compare repositories.' : 'Discovering repositories…'}</p>}</div>}
          {!!snapshot?.warnings.length && <details className="warning-banner"><summary><TriangleAlert size={14} /><span>{snapshot.warnings.length} {snapshot.warnings.length === 1 ? 'repository notice' : 'repository notices'}</span><span className="warning-detail-label">View details</span><ChevronDown size={12} /></summary><ul>{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
          {isCurrent && (currentNeedsTarget || currentDetached) ? <CurrentSetup detached={currentDetached} onReviewBranch={() => setShowNewReview(true)} /> : <div className={`review-workbench ${resizingFiles ? 'resizing-files' : ''}`}>
            {showFiles && <><aside className="files-sidebar" id="review-files" aria-label="Changed files" style={{ width: filePaneWidth, minWidth: filePaneWidth }}>
              <div className="files-heading"><h2>Files <span>{filter === 'unreviewed' ? files.length - approvedCount : files.length}</span></h2><Select className="file-filter-select" variant="quiet" searchable={false} label="Filter changed files" value={filter} onChange={value => changeFilter(value as FileFilter)} options={[{ value: 'all', label: 'All files' }, { value: 'unreviewed', label: 'Unreviewed' }, { value: 'commented', label: 'Commented' }]} /></div>
              <label className="file-search"><Search size={13} /><input aria-label="Filter files by path" placeholder="Find a file…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="Clear file search" onClick={() => setQuery('')}><X size={12} /></button>}</label>
              <div className="tree-container"><ReviewTree key={viewKey} files={files} selectedFileId={selectedFile?.id ?? null} approvals={review.approvals} reviewedVersions={knownApprovals.current[viewKey] || {}} comments={review.comments} onSelect={selectFile} onReviewFiles={reviewFiles} reviewBusy={approvalBusy} onOrderChange={ids => { explorerOrder.current[viewKey] = ids; }} filter={filter} query={query} /></div>
              <div className="compact-progress" title={`${approvedCount} of ${files.length} files reviewed · +${additions} −${deletions}`}><span><CircleCheck size={12} />{approvedCount} / {files.length} reviewed</span><button className="icon-button" onClick={nextUnreviewed} disabled={approvedCount === files.length} aria-label="Next unreviewed file" title="Next unreviewed file"><ArrowRight size={13} /></button><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>
            </aside><div className="file-pane-resizer" role="separator" aria-label="Resize file pane" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={Math.min(520, window.innerWidth - 500)} aria-valuenow={Math.round(filePaneWidth)} tabIndex={0} title="Drag to resize · Arrow keys to adjust · Double-click to reset" onPointerDown={event => {
              if (event.button !== 0) return;
              event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
              resizeOrigin.current = { pointerId: event.pointerId, x: event.clientX, width: filePaneWidth }; setResizingFiles(true);
            }} onPointerMove={event => {
              const origin = resizeOrigin.current;
              if (origin?.pointerId === event.pointerId) setFilePaneWidth(clampFileWidth(origin.width + event.clientX - origin.x));
            }} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={() => { if (resizeOrigin.current) finishResize(); }} onDoubleClick={() => { setFilePaneWidth(260); localStorage.setItem('branchline.filePaneWidth', '260'); }} onKeyDown={event => {
              const next = event.key === 'ArrowLeft' ? filePaneWidth - 10 : event.key === 'ArrowRight' ? filePaneWidth + 10 : event.key === 'Home' ? 180 : event.key === 'End' ? 520 : null;
              if (next === null) return; event.preventDefault(); const width = clampFileWidth(next); setFilePaneWidth(width); localStorage.setItem('branchline.filePaneWidth', String(width));
            }} /></>}
            <section className="diff-workspace" aria-label="File diff">
              {!snapshot ? <div className="central-empty"><LoaderCircle size={26} className="spin" /><h2>Gathering your changes</h2><p>Comparing branches across your repositories.</p></div> : !selectedFile ? <div className="central-empty clean-state"><div className="empty-icon"><CheckCheck size={28} /></div><h2>{approvedCount < files.length ? 'Choose a file to review' : 'You’re all caught up.'}</h2><p>{approvedCount < files.length ? 'Select a changed file from the file tree.' : 'New changes will appear here automatically.'}</p>{!showFiles && files.length > 0 && <button className="button button-secondary" onClick={toggleFiles}>Show files</button>}</div> : <>
                <div className="diff-toolbar"><div className="diff-file-name" title={`${fileLocation(selectedFile)} · ${selectedFile.source === 'working-tree' ? 'Working tree' : 'Committed'} · +${selectedFile.additions} −${selectedFile.deletions}`}><FileCode2 size={14} /><span title={fileLocation(selectedFile)}>{fileLocation(selectedFile)}</span><span className={`file-status file-status-${selectedFile.status.toLowerCase()}`}>{({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', T: 'Type changed' })[selectedFile.status]}</span></div><div className="diff-toolbar-actions"><div className="diff-style-switch" role="group" aria-label="Diff layout"><button className={diffStyle === 'split' ? 'active' : ''} aria-pressed={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>Split</button><button className={diffStyle === 'unified' ? 'active' : ''} aria-pressed={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>Unified</button></div><span className="toolbar-separator" /><button className={`reviewed-button ${approved ? 'approved' : ''}`} disabled={approvalBusy} onClick={() => void toggleApproval()} aria-pressed={approved} title={approved ? 'Mark this file as unreviewed' : 'Mark this version of the file as reviewed'}>{approvalBusy ? <LoaderCircle className="spin" size={14} /> : approved ? <CircleCheck size={15} /> : <Circle size={15} />}<span>{approved ? 'Reviewed' : 'Mark reviewed'}</span></button></div></div>
                {staleApproval && <div className="changed-since-review"><RefreshCw size={13} />This file changed since you reviewed it. Take another look.</div>}
                <div className="diff-content"><DiffViewer key={`${viewKey}:${selectedFile.id}`} draftScope={viewKey} file={selectedFile} comments={fileComments} diffStyle={diffStyle} onAddComment={addComment} onUpdateComment={updateComment} onDeleteComment={removeComment} /></div>
              </>}
            </section>
            {showFeedback && <FeedbackPanel key={viewKey} review={review} files={files} onClose={() => setShowFeedback(false)} onSelect={selectFile} onUpdate={updateComment} onDelete={removeComment} onError={setError} copyButton={copyButton} />}
          </div>}
        </>}
      </main>
    </div>
    {showUpdates && <Modal title="Updates" onClose={() => setShowUpdates(false)} small><UpdateDetails state={updateState} bridgeError={updateBridgeError} onAction={action => void updateAction(action)} onClose={() => setShowUpdates(false)} /></Modal>}
    <div hidden={showUpdates}>
    {showAddProject && <AddProjectDialog onClose={() => setShowAddProject(false)} onCreated={projectCreated} />}
    {showSettings && <AppSettingsDialog settings={settings} ticket={jiraTicket} onClose={() => setShowSettings(false)} onSaved={updated => { setSettings(updated); setShowSettings(false); }} />}
    {showNewReview && project && <NewReviewDialog key={project.id} project={project} onClose={() => setShowNewReview(false)} onCreated={created => { contexts.current[created.id] = reviewContextKey(created); setReviews(previous => mergeReview(previous, created)); setProjects(previous => previous.map(item => item.id === created.projectId ? { ...item, defaultBaseBranch: created.baseBranch } : item)); void selectReview(created.id); setShowNewReview(false); }} />}
    {settingsProject && <ProjectSettingsDialog project={settingsProject} currentTarget={reviews.find(item => item.projectId === settingsProject.id && item.kind === 'current')?.baseBranch || ''} onClose={() => setSettingsProject(null)} onUpdated={updated => { setProjects(previous => previous.map(item => item.id === updated.id ? updated : item)); setSettingsProject(null); }} onRemove={() => { setDeleteProject(settingsProject); setSettingsProject(null); }} />}
    {deleteProject && <Modal title="Remove this project?" onClose={() => !removing && setDeleteProject(null)} small><div className="confirm-copy"><p><strong>{deleteProject.name}</strong> will be removed from Branchline, along with its {reviews.filter(item => item.projectId === deleteProject.id && item.kind === 'saved').length} saved reviews, their comments, and all Current feedback and review progress.</p><p>Your repository and local files will remain untouched.</p></div><div className="modal-footer"><button className="button button-secondary" disabled={removing} onClick={() => setDeleteProject(null)}>Cancel</button><button className="button button-danger" disabled={removing} onClick={() => void confirmDeleteProject()}>{removing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Remove project</button></div></Modal>}
    {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
    {deleteReview && <Modal title="Delete this review?" onClose={() => !removing && setDeleteReview(null)} small><div className="confirm-copy"><p><strong>{deleteReview.name}</strong> and its saved comments and review progress will be removed.</p><p>The repository and your code remain on disk.</p></div><div className="modal-footer"><button className="button button-secondary" disabled={removing} onClick={() => setDeleteReview(null)}>Cancel</button><button className="button button-danger" disabled={removing} onClick={() => void confirmDelete()}>{removing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Delete review</button></div></Modal>}
    </div>
  </div>{updatePreparing && <div className="update-lock" role="status" aria-live="polite"><LoaderCircle className="spin" size={26} /><h2>{updateState?.phase === 'installing' ? 'Installing your update…' : 'Saving your workspace…'}</h2><p>Branchline will restart when the update is ready.</p></div>}</>;
}

function AppSettingsDialog({ settings, ticket, onClose, onSaved }: {
  settings: AppSettings; ticket: string | null; onClose: () => void; onSaved: (settings: AppSettings) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.jiraBaseUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let previewUrl = '';
  try { if (baseUrl.trim()) previewUrl = jiraTicketUrl(normalizeJiraBaseUrl(baseUrl), ticket || 'APP-123'); }
  catch { /* Show validation errors on save; let the user finish typing first. */ }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try { onSaved(await window.reviewAPI.updateSettings({ jiraBaseUrl: normalizeJiraBaseUrl(baseUrl) })); }
    catch (reason) { setError(errorMessage(reason)); setSaving(false); }
  }

  return <Modal title="Settings" onClose={() => !saving && onClose()} small>
    <form onSubmit={event => void save(event)} noValidate>
      <div className="modal-body app-settings-form">
        <h3>Jira</h3>
        <p className="settings-description">Open tickets directly from your review’s branch name.</p>
        <label className="field-label" htmlFor="jira-base-url">Jira base URL</label>
        <input className="text-input jira-url-input" id="jira-base-url" type="url" inputMode="url" placeholder="https://your-team.atlassian.net" autoComplete="off" spellCheck={false} value={baseUrl} aria-describedby="jira-url-hint" aria-invalid={error ? true : undefined} disabled={saving} onChange={event => { setBaseUrl(event.target.value); setError(null); }} />
        <p className="settings-hint" id="jira-url-hint">Use your Jira site address, including any path such as <code>/jira</code>. Leave blank to clear it.</p>
        <div className="jira-link-preview"><span>{ticket ? `Detected ${ticket}` : 'Example: feature/APP-123-update'}</span><code>{previewUrl || `${baseUrl.trim() ? 'Your Jira URL' : 'https://your-team.atlassian.net'}/browse/${ticket || 'APP-123'}`}</code></div>
        {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      </div>
      <div className="modal-footer"><span className="modal-local-note">Applies to all projects</span><button type="button" className="button button-secondary" disabled={saving} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={saving || baseUrl === settings.jiraBaseUrl}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save settings</button></div>
    </form>
  </Modal>;
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return <div className="central-empty welcome-simple"><Brand small /><h1>Review your local changes.</h1><p>Choose a Git repository to review your branch and its submodules.</p><button className="button button-primary" onClick={onCreate}><FolderOpen size={15} />Add your first project</button></div>;
}

function CurrentSetup({ detached, onReviewBranch }: { detached: boolean; onReviewBranch: () => void }) {
  return <div className="current-setup"><div className="current-setup-content"><GitCompareArrows size={24} strokeWidth={1.4} /><h2>{detached ? 'Check out a branch to continue.' : 'Choose a target branch.'}</h2><p>{detached ? 'Current will resume automatically when you check out a branch.' : 'Select a target in the toolbar above. It will stay selected as you work.'}</p>{detached && <button className="button button-secondary" onClick={onReviewBranch}><GitBranch size={14} />Review another branch</button>}</div></div>;
}

function WorkspaceMenu({ onSettings, onRepositories, onHelp, onDelete }: {
  onSettings: () => void; onRepositories: () => void; onHelp: () => void; onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  function choose(action: () => void) { setOpen(false); trigger.current?.focus(); action(); }
  return <div className="workspace-menu" ref={container}>
    <button className="icon-button" ref={trigger} aria-label="Workspace menu" aria-haspopup="menu" aria-expanded={open} title="Workspace menu" onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}><MoreHorizontal size={17} /></button>
    {open && <div className="workspace-menu-popover" ref={menu} role="menu" aria-label="Workspace" onKeyDown={event => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
      if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      if (event.key === 'Tab') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    }}>
      <button role="menuitem" onClick={() => choose(onSettings)}><Settings2 size={14} />Project settings</button>
      <button role="menuitem" onClick={() => choose(onRepositories)}><Layers3 size={14} />Repositories</button>
      <button role="menuitem" onClick={() => choose(onHelp)}><HelpCircle size={14} />How Branchline works</button>
      {onDelete && <button role="menuitem" className="menu-danger" onClick={() => choose(onDelete)}><Trash2 size={14} />Delete this review</button>}
    </div>}
  </div>;
}

function Modal({ title, onClose, children, small = false }: { title: string; onClose: () => void; children: React.ReactNode; small?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = container.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || []).filter(item => item.offsetParent !== null);
    focusables()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialog?.offsetParent === null) return;
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previousFocus?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${small ? 'modal-small' : ''}`} ref={container} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><span className="eyebrow">BRANCHLINE</span><h2 id="modal-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>{children}</div></div>;
}

function AddProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => Promise<void> }) {
  const [repoPath, setRepoPath] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function browse() {
    setChoosing(true);
    setError(null);
    try {
      const path = await window.reviewAPI.chooseRepo();
      if (alive.current && path) setRepoPath(path);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setChoosing(false); }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!repoPath.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await window.reviewAPI.createProject({ repoPath: repoPath.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      if (alive.current) await onCreated(created);
    } catch (reason) { if (alive.current) { setError(errorMessage(reason)); setSaving(false); } }
  }

  return <Modal title="Add a project" onClose={() => !saving && onClose()}>
    <form onSubmit={event => void create(event)}>
      <div className="modal-body add-project-form">
        <p className="modal-introduction">Give your repository a place in your workspace. Its reviews, comments, and target branch stay together.</p>
        <label className="field-label" htmlFor="project-repo-path">Repository path</label>
        <div className="repository-input-row"><div className="input-with-icon"><FolderGit2 size={16} /><input id="project-repo-path" placeholder="/path/to/your/repository" value={repoPath} onChange={event => setRepoPath(event.target.value)} disabled={saving || choosing} /></div><button type="button" className="button button-secondary" onClick={() => void browse()} disabled={saving || choosing}>{choosing ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}Browse</button></div>
        <label className="field-label" htmlFor="project-name">Project name <span className="inline-optional">Optional</span></label>
        <input className="text-input" id="project-name" placeholder={repoPath ? repositoryName(repoPath) : 'e.g. Platform'} value={name} onChange={event => setName(event.target.value)} disabled={saving} />
        <div className="project-folder-note"><GitFork size={17} /><p>Point to the parent repository. Initialized submodules are included automatically when you start a review.</p></div>
        {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      </div>
      <div className="modal-footer"><span className="modal-local-note"><ShieldCheck size={13} />Saved on this device</span><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={!repoPath.trim() || saving || choosing}>{saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}{saving ? 'Adding project…' : 'Add project'}</button></div>
    </form>
  </Modal>;
}

function ProjectSettingsDialog({ project, currentTarget, onClose, onUpdated, onRemove }: { project: Project; currentTarget: string; onClose: () => void; onUpdated: (project: Project) => void; onRemove: () => void }) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try { onUpdated(await window.reviewAPI.updateProject(project.id, { name: name.trim() })); }
    catch (reason) { setError(errorMessage(reason)); setSaving(false); }
  }
  return <Modal title="Project settings" onClose={() => !saving && onClose()}>
    <form onSubmit={event => void save(event)}><div className="modal-body project-settings-form">
      <label className="field-label" htmlFor="settings-project-name">Project name</label><input className="text-input" id="settings-project-name" value={name} onChange={event => setName(event.target.value)} disabled={saving} />
      <div className="settings-project-location"><FolderGit2 size={16} /><span>{project.repoPath}</span></div>
      <div className="settings-target"><span>Current target</span><code>{currentTarget || 'Not selected'}</code><p>Choose or change the target in Current. It stays selected as you switch branches.</p></div>
      {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      <div className="remove-project-setting"><div><strong>Remove project</strong><span>Remove its saved reviews and feedback from Branchline.</span></div><button type="button" className="button button-remove-project" onClick={onRemove} disabled={saving}><Trash2 size={14} />Remove…</button></div>
    </div><div className="modal-footer"><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save changes</button></div></form>
  </Modal>;
}

function NewReviewDialog({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (review: Review) => void }) {
  const [inspection, setInspection] = useState<RepoInspection | null>(null);
  const [inspecting, setInspecting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseBranch, setBaseBranch] = useState(project.defaultBaseBranch || '');
  const [featureBranch, setFeatureBranch] = useState('');
  const [name, setName] = useState('');
  const [includeWorkingTree, setIncludeWorkingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setInspecting(true);
    setError(null);
    window.reviewAPI.inspectRepo(project.repoPath).then(result => { if (!cancelled) setInspection(result); }).catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setInspecting(false); });
    return () => { cancelled = true; };
  }, [project.id, project.repoPath, inspectionAttempt]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!inspection || saving || !baseBranch.trim() || !featureBranch.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.reviewAPI.createReview({ projectId: project.id, baseBranch: baseBranch.trim(), featureBranch: featureBranch.trim(), includeWorkingTree, ...(name.trim() ? { name: name.trim() } : {}) });
      if (alive.current) onCreated(result);
    } catch (reason) { if (alive.current) { setError(errorMessage(reason)); setSaving(false); } }
  }

  return <Modal title="Review another branch" onClose={() => !saving && onClose()}>
    <form onSubmit={event => void create(event)}>
      <div className="modal-body new-review-form saved-review-form">
        <p className="modal-introduction">Create a separate review for a specific branch. It stays on that branch when your checkout changes.</p>
        <div className="review-project-context"><FolderGit2 size={16} /><strong>{project.name}</strong><span title={project.repoPath}>{project.repoPath}</span></div>
        {inspecting && <div className="saved-review-loading"><LoaderCircle size={13} className="spin" />Reading available branches…</div>}
        <div className="branch-fields"><div><label className="field-label" htmlFor="base-branch">Target branch</label><Select id="base-branch" className="branch-picker" variant="field" label="Target branch" icon={<GitBranch size={15} />} placeholder="Choose target branch" searchPlaceholder="Find a branch…" value={baseBranch} options={(inspection?.branches || []).map(branch => ({ value: branch, label: branch }))} onChange={setBaseBranch} disabled={!inspection || saving} /></div><ArrowLeft className="branch-fields-arrow" size={15} /><div><label className="field-label" htmlFor="feature-branch">Feature branch</label><Select id="feature-branch" className="branch-picker" variant="field" label="Feature branch" icon={<GitBranch size={15} />} placeholder="Choose feature branch" searchPlaceholder="Find a branch…" value={featureBranch} options={(inspection?.branches || []).map(branch => ({ value: branch, label: branch }))} onChange={setFeatureBranch} disabled={!inspection || saving} /></div></div>
        <div className="merge-base-note"><GitCompareArrows size={16} /><p>Only changes introduced by the feature branch are shown. Changes made only on the target are excluded.</p></div>
        <label className="field-label" htmlFor="review-name">Review name <span className="inline-optional">Optional</span></label><input className="text-input" id="review-name" placeholder={featureBranch || 'Name this review'} value={name} onChange={event => setName(event.target.value)} disabled={saving} />
        <label className="working-tree-option"><input type="checkbox" checked={includeWorkingTree} onChange={event => setIncludeWorkingTree(event.target.checked)} disabled={saving} /><span><strong>Include uncommitted changes</strong><span>Include local edits and new files when this feature branch is checked out.</span></span></label>
        {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span>{!inspection && <button type="button" onClick={() => setInspectionAttempt(previous => previous + 1)}>Retry</button>}</div>}
      </div>
      <div className="modal-footer"><span className="modal-local-note"><GitBranch size={13} />Saved to this branch</span><button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Cancel</button><button className="button button-primary" type="submit" disabled={!inspection || !baseBranch.trim() || !featureBranch.trim() || saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={16} />}{saving ? 'Creating review…' : 'Create review'}</button></div>
    </form>
  </Modal>;
}

function FeedbackPanel({ review, files, onClose, onSelect, onUpdate, onDelete, onError, copyButton }: { review: Review; files: ReviewFile[]; onClose: () => void; onSelect: (id: string) => void; onUpdate: (id: string, changes: { resolved?: boolean; body?: string }) => Promise<void>; onDelete: (id: string) => Promise<void>; onError: (error: string) => void; copyButton: React.ReactNode }) {
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const comments = review.comments.filter(comment => showResolved || !comment.resolved);
  const resolvedCount = review.comments.filter(comment => comment.resolved).length;
  async function action(id: string, operation: () => Promise<void>) {
    setBusy(id);
    try { await flushPendingComments(); await operation(); } catch (reason) { onError(errorMessage(reason)); } finally { setBusy(null); }
  }
  return <aside className="feedback-panel" aria-label="Review feedback"><div className="feedback-panel-heading"><h2>Feedback <span>{review.comments.filter(comment => !comment.resolved).length}</span></h2><button className="icon-button" aria-label="Close feedback" onClick={onClose}><X size={16} /></button></div><p className="feedback-description">Your notes, ready for the next iteration.</p>{resolvedCount > 0 && <label className="resolved-filter"><input type="checkbox" checked={showResolved} onChange={event => setShowResolved(event.target.checked)} />Show {resolvedCount} resolved</label>}<div className="feedback-comments">{comments.length ? comments.map(comment => {
    const file = files.find(item => item.id === comment.fileId);
    const stale = !file || file.fingerprint !== comment.fingerprint;
    return <article key={comment.id} className={`feedback-card ${comment.resolved ? 'resolved' : ''}`}><button className="feedback-location" onClick={() => onSelect(comment.fileId)} disabled={!file} title={fileLocation(comment)}><FileCode2 size={13} /><span>{comment.path.split('/').pop()}</span><code>{comment.lineStart === 0 ? 'File' : `L${comment.lineStart}${comment.lineEnd !== comment.lineStart ? `–${comment.lineEnd}` : ''}`}</code><ArrowDownLeft size={12} /></button><span className="feedback-card-path" title={fileLocation(comment)}>{fileLocation(comment)}</span><div className="feedback-card-meta"><span>{comment.side === 'deletions' ? 'Original version' : 'Feature version'}</span>{stale && <span className="stale-label">Earlier revision</span>}</div><p>{comment.body}</p>{stale && comment.context && <details className="saved-context"><summary>Saved line context</summary><pre>{comment.context}</pre></details>}<div className="feedback-card-actions"><button className={comment.resolved ? 'comment-resolved' : ''} disabled={busy === comment.id} onClick={() => void action(comment.id, () => onUpdate(comment.id, { resolved: !comment.resolved }))}>{busy === comment.id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{comment.resolved ? 'Reopen' : 'Resolve'}</button><button disabled={busy === comment.id} onClick={() => void action(comment.id, () => onDelete(comment.id))} aria-label={`Delete comment on ${comment.path} line ${comment.lineStart}`} title="Delete comment"><Trash2 size={13} /></button></div></article>;
  }) : <div className="feedback-empty"><MessageSquare size={26} /><h3>{review.comments.length ? 'All notes resolved.' : 'Room for your thoughts.'}</h3><p>Click a line number in the diff to leave a comment. Your feedback will appear here.</p></div>}</div><div className="feedback-panel-footer">{copyButton}<span>Unresolved comments · paths · line references</span></div></aside>;
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return <Modal title="Review at the speed of work." onClose={onClose}><div className="modal-body help-content"><div><FolderGit2 size={20} /><section><h3>Give each repository a home</h3><p>Add a project once, then switch between projects in the tabs. Current follows the branch checked out in your project. Choose its target once, then review as you work. Use Review another branch for a separate review that stays attached to a specific branch.</p></section></div><div><GitCompareArrows size={20} /><section><h3>See your feature’s changes</h3><p>Branchline compares the feature branch to its merge base with the target. Changes made only on the target stay out of your review.</p></section></div><div><GitFork size={20} /><section><h3>Bring every submodule along</h3><p>The same branch names are compared inside each initialized submodule, even when the parent hasn’t committed new submodule pointers. Missing branches appear as notices.</p></section></div><div><RefreshCw size={20} /><section><h3>Keep pace with your agent</h3><p>Changes refresh every four seconds while the window is visible. Uncommitted edits and new files are included when that repository is checked out on your feature branch.</p></section></div><div><CircleCheck size={20} /><section><h3>Review a file with confidence</h3><p>Mark a file reviewed when it looks good and the next unreviewed file opens automatically. If its content changes, that approval becomes out of date so the file returns to your unreviewed list.</p></section></div><div><Clipboard size={20} /><section><h3>Give all your feedback at once</h3><p>Click a line number to comment. Feedback saves as you type; click away to finish editing. Copy feedback groups unresolved comments by file, with just their paths and line references. Comments on an earlier revision are kept for reference.</p></section></div></div><div className="modal-footer"><button className="button button-primary" onClick={onClose}>Got it<Check size={15} /></button></div></Modal>;
}
