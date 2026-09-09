import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewAPI } from '../shared/types';

const api: ReviewAPI = {
  getIntegrations: () => ipcRenderer.invoke('review:integrations-state'),
  getIntegrationDiagnostics: () => ipcRenderer.invoke('review:integration-diagnostics'),
  openIntegrationLog: () => ipcRenderer.invoke('review:integration-log-open'),
  copyConnectionScopes: kind => ipcRenderer.invoke('review:connection-copy-scopes', kind),
  saveConnection: input => ipcRenderer.invoke('review:connection-save', input),
  testConnection: id => ipcRenderer.invoke('review:connection-test', id),
  disconnectConnection: id => ipcRenderer.invoke('review:connection-disconnect', id),
  configureProjectIntegration: (...args) => ipcRenderer.invoke('review:integrations-project', ...args),
  discoverRepositories: id => ipcRenderer.invoke('review:integrations-discover', id),
  listPullRequests: (...args) => ipcRenderer.invoke('review:pullrequests-list', ...args),
  openPullRequestReview: (...args) => ipcRenderer.invoke('review:pullrequests-open', ...args),
  getRemoteReview: id => ipcRenderer.invoke('review:pullrequests-state', id),
  onRemoteReviewChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, change: import('../shared/integrations').RemoteReviewChanged) => callback(change);
    ipcRenderer.on('review:remote-review-changed', listener);
    return () => { ipcRenderer.removeListener('review:remote-review-changed', listener); };
  },
  getJiraIssue: (...args) => ipcRenderer.invoke('review:jira-issue', ...args),
  getJiraTicketLink: id => ipcRenderer.invoke('review:jira-ticket-link', id),
  setReviewTicket: (...args) => ipcRenderer.invoke('review:jira-ticket', ...args),
  previewFeedback: id => ipcRenderer.invoke('review:feedback-preview', id),
  publishFeedback: id => ipcRenderer.invoke('review:feedback-publish', id),
  reanchorComment: (...args) => ipcRenderer.invoke('review:feedback-reanchor', ...args),
  resolveCommentConflict: (...args) => ipcRenderer.invoke('review:feedback-conflict', ...args),
  resolveUnknownPublication: (...args) => ipcRenderer.invoke('review:feedback-unknown', ...args),
  previewMerge: (...args) => ipcRenderer.invoke('review:merge-preview', ...args),
  runPullRequestAction: (...args) => ipcRenderer.invoke('review:pullrequests-action', ...args),
  openIntegrationLink: url => ipcRenderer.invoke('review:integration-open', url),
  getUpdateState: () => ipcRenderer.invoke('review:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('review:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('review:update-download'),
  installUpdate: () => ipcRenderer.invoke('review:update-install'),
  onUpdateStateChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('../shared/updates').UpdateState) => callback(state);
    ipcRenderer.on('review:update-state-changed', listener);
    return () => { ipcRenderer.removeListener('review:update-state-changed', listener); };
  },
  onUpdateDialogRequested: callback => {
    const listener = () => callback();
    ipcRenderer.on('review:update-show', listener);
    return () => { ipcRenderer.removeListener('review:update-show', listener); };
  },
  onBeforeClose: callback => {
    const listener = (_event: Electron.IpcRendererEvent, request: { id: number; reason: 'close' | 'install' }) => {
      void Promise.resolve().then(() => callback(request.reason)).then(
        () => ipcRenderer.invoke('review:close-ready', request.id, true),
        () => ipcRenderer.invoke('review:close-ready', request.id, false),
      ).catch(() => undefined);
    };
    ipcRenderer.on('review:before-close', listener);
    void ipcRenderer.invoke('review:close-listener', true);
    return () => { ipcRenderer.removeListener('review:before-close', listener); void ipcRenderer.invoke('review:close-listener', false).catch(() => undefined); };
  },
  onCloseCancelled: callback => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('review:close-cancelled', listener);
    return () => { ipcRenderer.removeListener('review:close-cancelled', listener); };
  },
  getState: () => ipcRenderer.invoke('review:state'),
  updateSettings: changes => ipcRenderer.invoke('review:settings-update', changes),
  openJiraTicket: id => ipcRenderer.invoke('review:jira-open', id),
  chooseRepo: () => ipcRenderer.invoke('review:choose-repo'),
  inspectRepo: path => ipcRenderer.invoke('review:inspect', path),
  createProject: input => ipcRenderer.invoke('review:project-create', input),
  updateProject: (...args) => ipcRenderer.invoke('review:project-update', ...args),
  deleteProject: id => ipcRenderer.invoke('review:project-delete', id),
  createReview: input => ipcRenderer.invoke('review:create', input),
  deleteReview: id => ipcRenderer.invoke('review:delete', id),
  refreshReview: id => ipcRenderer.invoke('review:refresh', id),
  setCurrentTarget: (...args) => ipcRenderer.invoke('review:current-target', ...args),
  setApproval: (...args) => ipcRenderer.invoke('review:approve', ...args),
  setApprovals: (...args) => ipcRenderer.invoke('review:approve-many', ...args),
  addComment: (...args) => ipcRenderer.invoke('review:comment-add', ...args),
  updateComment: (...args) => ipcRenderer.invoke('review:comment-update', ...args),
  deleteComment: (...args) => ipcRenderer.invoke('review:comment-delete', ...args),
  copyFeedback: (...args) => ipcRenderer.invoke('review:copy', ...args),
};
contextBridge.exposeInMainWorld('reviewAPI', api);
