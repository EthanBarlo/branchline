import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewAPI } from '../shared/types';

const api: ReviewAPI = {
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
