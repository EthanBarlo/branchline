import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewAPI } from '../shared/api';
import {
  reviewEvents,
  type ReviewRequestName,
  type ReviewRequestArguments,
  type ReviewRequestResult,
} from '../shared/ipc';

function invoke<Name extends ReviewRequestName>(
  name: Name,
  ...args: ReviewRequestArguments<Name>
): Promise<ReviewRequestResult<Name>> {
  return ipcRenderer.invoke(`review:${name}`, ...args);
}

const api: ReviewAPI = {
  getCachedGitStatus: (id) => invoke('git-cache', id),
  getGitStatus: (id) => invoke('git-status', id),
  fetchGit: (id) => invoke('git-fetch', id),
  previewGitAction: (...args) => invoke('git-preview', ...args),
  runGitAction: (...args) => invoke('git-run', ...args),
  acknowledgeGitOperation: (id) => invoke('git-acknowledge', id),
  onGitWorkflowChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: import('../shared/git-workflow').GitWorkflowChange,
    ) => callback(change);
    ipcRenderer.on(reviewEvents.gitWorkflowChanged, listener);
    return () => ipcRenderer.removeListener(reviewEvents.gitWorkflowChanged, listener);
  },
  getIntegrations: () => invoke('integrations-state'),
  getIntegrationDiagnostics: () => invoke('integration-diagnostics'),
  openIntegrationLog: () => invoke('integration-log-open'),
  copyConnectionScopes: (kind) => invoke('connection-copy-scopes', kind),
  saveConnection: (input) => invoke('connection-save', input),
  testConnection: (id) => invoke('connection-test', id),
  disconnectConnection: (id) => invoke('connection-disconnect', id),
  configureProjectIntegration: (...args) => invoke('integrations-project', ...args),
  discoverRepositories: (id) => invoke('integrations-discover', id),
  listPullRequests: (...args) => invoke('pullrequests-list', ...args),
  openPullRequestReview: (...args) => invoke('pullrequests-open', ...args),
  getRemoteReview: (id) => invoke('pullrequests-state', id),
  onRemoteReviewLoadProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: import('../shared/integrations').RemoteReviewLoadProgress,
    ) => callback(change);
    ipcRenderer.on(reviewEvents.remoteReviewLoad, listener);
    return () => ipcRenderer.removeListener(reviewEvents.remoteReviewLoad, listener);
  },
  onRemoteReviewChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: import('../shared/integrations').RemoteReviewChanged,
    ) => callback(change);
    ipcRenderer.on(reviewEvents.remoteReviewChanged, listener);
    return () => {
      ipcRenderer.removeListener(reviewEvents.remoteReviewChanged, listener);
    };
  },
  getJiraIssue: (...args) => invoke('jira-issue', ...args),
  getJiraTicketSuggestions: (...args) => invoke('jira-ticket-suggestions', ...args),
  getJiraTicketLink: (id) => invoke('jira-ticket-link', id),
  openJiraBrowser: (...args) => invoke('jira-browser-open', ...args),
  resizeJiraBrowser: (...args) => invoke('jira-browser-resize', ...args),
  focusJiraBrowser: (id) => invoke('jira-browser-focus', id),
  closeJiraBrowser: (id) => invoke('jira-browser-close', id),
  onJiraBrowserClosed: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id);
    ipcRenderer.on(reviewEvents.jiraBrowserClosed, listener);
    return () => ipcRenderer.removeListener(reviewEvents.jiraBrowserClosed, listener);
  },
  onJiraBrowserClearTicket: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string) => callback(id);
    ipcRenderer.on(reviewEvents.jiraBrowserClearTicket, listener);
    return () => ipcRenderer.removeListener(reviewEvents.jiraBrowserClearTicket, listener);
  },
  setReviewTicket: (...args) => invoke('jira-ticket', ...args),
  previewFeedback: (id) => invoke('feedback-preview', id),
  publishFeedback: (id) => invoke('feedback-publish', id),
  reanchorComment: (...args) => invoke('feedback-reanchor', ...args),
  resolveCommentConflict: (...args) => invoke('feedback-conflict', ...args),
  resolveUnknownPublication: (...args) => invoke('feedback-unknown', ...args),
  previewMerge: (...args) => invoke('merge-preview', ...args),
  runPullRequestAction: (...args) => invoke('pullrequests-action', ...args),
  completeMergedReview: (id) => invoke('pullrequests-complete', id),
  checkClosedReview: (id) => invoke('closed-review-check', id),
  removeClosedReviews: (...args) => invoke('closed-reviews-remove', ...args),
  openIntegrationLink: (url) => invoke('integration-open', url),
  getUpdateState: () => invoke('update-state'),
  checkForUpdates: () => invoke('update-check'),
  downloadUpdate: () => invoke('update-download'),
  installUpdate: () => invoke('update-install'),
  onUpdateStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('../shared/updates').UpdateState) =>
      callback(state);
    ipcRenderer.on(reviewEvents.updateStateChanged, listener);
    return () => {
      ipcRenderer.removeListener(reviewEvents.updateStateChanged, listener);
    };
  },
  onUpdateDialogRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(reviewEvents.updateShow, listener);
    return () => {
      ipcRenderer.removeListener(reviewEvents.updateShow, listener);
    };
  },
  onBeforeClose: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: { id: number; reason: 'close' | 'install' },
    ) => {
      void Promise.resolve()
        .then(() => callback(request.reason))
        .then(
          () => invoke('close-ready', request.id, true),
          () => invoke('close-ready', request.id, false),
        )
        .catch(() => undefined);
    };
    ipcRenderer.on(reviewEvents.beforeClose, listener);
    void invoke('close-listener', true);
    return () => {
      ipcRenderer.removeListener(reviewEvents.beforeClose, listener);
      void invoke('close-listener', false).catch(() => undefined);
    };
  },
  onCloseCancelled: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on(reviewEvents.closeCancelled, listener);
    return () => {
      ipcRenderer.removeListener(reviewEvents.closeCancelled, listener);
    };
  },
  getState: () => invoke('state'),
  updateSettings: (changes) => invoke('settings-update', changes),
  openJiraTicket: (id) => invoke('jira-open', id),
  chooseRepo: () => invoke('choose-repo'),
  inspectRepo: (path) => invoke('inspect', path),
  createProject: (input) => invoke('project-create', input),
  updateProject: (...args) => invoke('project-update', ...args),
  deleteProject: (id) => invoke('project-delete', id),
  createReview: (input) => invoke('create', input),
  deleteReview: (id) => invoke('delete', id),
  refreshReview: (id) => invoke('refresh', id),
  setCurrentTarget: (...args) => invoke('current-target', ...args),
  setApproval: (...args) => invoke('approve', ...args),
  setApprovals: (...args) => invoke('approve-many', ...args),
  addComment: (...args) => invoke('comment-add', ...args),
  updateComment: (...args) => invoke('comment-update', ...args),
  deleteComment: (...args) => invoke('comment-delete', ...args),
  copyFeedback: (...args) => invoke('copy', ...args),
};
contextBridge.exposeInMainWorld('reviewAPI', api);
