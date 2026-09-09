import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildSnapshot, inspectRepo } from './git';
import { IntegrationService } from './integration-service';
import { IntegrationStore } from './integration-store';
import { ConnectionManager } from './connection-manager';
import { configureIntegrationDiagnostics, flushIntegrationDiagnostics, getIntegrationDiagnosticsPath } from './integration-diagnostics';
import { PointerService } from './pointer-service';
import { connectionScopes } from '../shared/connection-scopes';
import type { ConnectionInput, ProjectIntegration, PullRequestFilter, PullRequestRef, ReanchorInput } from '../shared/integrations';
import { ReviewStore } from './store';
import { ProjectService } from './project-service';
import { ReviewService } from './review-service';
import { JiraService } from './jira-service';
import { InstallGate } from './install-gate';
import { createUpdateService } from './update-runtime';
import { isTrustedReviewSender } from './ipc-trust';
import type { UpdateService } from './update-service';
import { updatesBusy } from '../shared/updates';
import type { FileApproval, NewComment, NewProject, NewReview } from '../shared/types';

// A separate location is used by the automated desktop smoke test.
if (process.env.BRANCHLINE_DATA_DIR) app.setPath('userData', process.env.BRANCHLINE_DATA_DIR);
app.setName('Branchline');
let store: ReviewStore;
let projects: ProjectService;
let reviews: ReviewService;
let jira: JiraService;
let integrations: IntegrationService;
let updates: UpdateService;
const installGate = new InstallGate();
const closeGate = new InstallGate('close');
let window: BrowserWindow | null = null;
let closeListenerReady = false;
let closeRequested = false;
let permitClose = false;
let quitting = false;
let closeSequence = 0;
let pendingFlush: { id: number; resolve: () => void; reject: (error: Error) => void } | null = null;
let showUpdatesOnReady = false;
const rendererFile = join(__dirname, '../dist/index.html');
const devURL = !app.isPackaged ? process.env.BRANCHLINE_DEV_URL : undefined;

function cancelFlush() {
  pendingFlush?.reject(new Error('The window did not finish saving.'));
  pendingFlush = null;
}

function flushWindow(reason: 'close' | 'install'): Promise<void> {
  if (!window || window.webContents.isDestroyed() || !closeListenerReady || pendingFlush) {
    return Promise.reject(new Error('The workspace is not ready to save. Keep the window open and try again.'));
  }
  return new Promise((resolve, reject) => {
    pendingFlush = { id: ++closeSequence, resolve, reject };
    window!.webContents.send('review:before-close', { id: pendingFlush.id, reason });
  });
}

function showUpdates() {
  if (!window) { showUpdatesOnReady = true; createWindow(); }
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    if (closeListenerReady) window.webContents.send('review:update-show');
    else showUpdatesOnReady = true;
  }
  void updates.check();
}

function installHandlers() {
  const handle = (name: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(`review:${name}`, (event, ...args) => {
      const sender = event.senderFrame;
      const url = sender?.url;
      const trustedURL = devURL ? `${devURL}/` : pathToFileURL(rendererFile).href;
      if (!isTrustedReviewSender(event, window?.webContents ?? null, url, trustedURL)) {
        throw new Error('This request did not come from the review window.');
      }
      const control = name === 'state' || name.startsWith('close-') || name.startsWith('update-');
      return control ? fn(...args) : closeGate.run(name, () => installGate.run(name, () => fn(...args)));
    });
  };
  handle('state', () => store.getState());
  handle('update-state', () => updates.getState());
  handle('update-check', () => updates.check());
  handle('update-download', () => updates.download());
  handle('update-install', () => {
    if (closeRequested) throw new Error('The window is preparing to close. Finish saving before installing an update.');
    return updates.install();
  });
  handle('settings-update', (changes: { jiraBaseUrl: string }) => store.updateSettings(changes));
  handle('jira-open', async (id: string) => {
    const link = await integrations.getJiraTicketLink(id);
    if (link) return shell.openExternal(link.url);
    return jira.openJiraTicket(id);
  });
  handle('integrations-state', () => integrations.getIntegrations());
  handle('integration-diagnostics', async () => {
    await flushIntegrationDiagnostics();
    const path = getIntegrationDiagnosticsPath() ?? '';
    const available = !!path && await stat(path).then(file => file.isFile(), () => false);
    return { path, available };
  });
  handle('integration-log-open', async () => {
    await flushIntegrationDiagnostics();
    const path = getIntegrationDiagnosticsPath();
    if (!path || !await stat(path).then(file => file.isFile(), () => false)) {
      throw new Error('The integration log is not available yet. Retry the connection or pull request, then open Diagnostics again.');
    }
    shell.showItemInFolder(path);
  });
  handle('connection-copy-scopes', (kind: 'jira' | 'bitbucket') => {
    if (kind !== 'jira' && kind !== 'bitbucket') throw new Error('Choose Jira or Bitbucket permissions to copy.');
    clipboard.writeText(connectionScopes[kind].map(([scope]) => scope).join('\n'));
  });
  handle('connection-save', (input: ConnectionInput) => integrations.saveConnection(input));
  handle('connection-test', (id: string) => integrations.testConnection(id));
  handle('connection-disconnect', (id: string) => integrations.disconnectConnection(id));
  handle('integrations-project', (id: string, input: ProjectIntegration) => integrations.configureProjectIntegration(id, input));
  handle('integrations-discover', (id: string) => integrations.discoverRepositories(id));
  handle('pullrequests-list', (id: string, filter: PullRequestFilter) => integrations.listPullRequests(id, filter));
  handle('pullrequests-open', (id: string, refs: PullRequestRef[]) => integrations.openPullRequestReview(id, refs));
  handle('pullrequests-state', (id: string) => integrations.getRemoteReview(id));
  handle('jira-issue', (id: string, key?: string) => integrations.getJiraIssue(id, key));
  handle('jira-ticket-link', (id: string) => integrations.getJiraTicketLink(id));
  handle('jira-ticket', (id: string, key: string) => integrations.setReviewTicket(id, key));
  handle('feedback-preview', (id: string) => integrations.previewFeedback(id));
  handle('feedback-publish', (id: string) => integrations.publishFeedback(id));
  handle('feedback-reanchor', (id: string, commentId: string, input: ReanchorInput) => integrations.reanchorComment(id, commentId, input));
  handle('feedback-conflict', (id: string, commentId: string, choice: 'local' | 'remote') => integrations.resolveCommentConflict(id, commentId, choice));
  handle('feedback-unknown', (id: string, commentId: string, remoteId: number | null) => integrations.resolveUnknownPublication(id, commentId, remoteId));
  handle('merge-preview', (id: string, action?: 'approve' | 'merge') => integrations.previewMerge(id, action));
  handle('pullrequests-action', (id: string, action: 'approve' | 'merge') => integrations.runPullRequestAction(id, action));
  handle('integration-open', (url: string) => shell.openExternal(integrations.validateLink(url)));
  handle('close-listener', (ready: boolean) => {
    closeListenerReady = ready === true;
    if (!ready) cancelFlush();
    if (ready && showUpdatesOnReady) { showUpdatesOnReady = false; window?.webContents.send('review:update-show'); }
  });
  handle('close-ready', (id: number, saved: boolean) => {
    if (!pendingFlush || pendingFlush.id !== id) return;
    const request = pendingFlush;
    pendingFlush = null;
    // Let the acknowledgement reach the renderer before attempting installation.
    setImmediate(() => saved === true ? request.resolve() : request.reject(new Error('Your pending comments could not be saved. Fix the save error and retry.')));
  });
  handle('choose-repo', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Choose a repository', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('inspect', (path: string) => {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Choose a valid repository path.');
    return inspectRepo(path);
  });
  handle('project-create', (input: NewProject) => projects.createProject(input));
  handle('project-update', (id: string, changes: { name?: string; defaultBaseBranch?: string }) => store.updateProject(id, changes));
  handle('project-delete', (id: string) => integrations.deleteProject(id));
  handle('create', (input: NewReview) => projects.createReview(input));
  handle('delete', (id: string) => integrations.deleteReview(id));
  handle('refresh', (id: string) => integrations.refreshReview(id));
  handle('current-target', (projectId: string, target: string) => integrations.setCurrentTarget(projectId, target));
  handle('approve', (id: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string) => integrations.setApprovals(id, [{ fileId, fingerprint }], approved, contextKey));
  handle('approve-many', (id: string, files: FileApproval[], approved: boolean, contextKey?: string) => integrations.setApprovals(id, files, approved, contextKey));
  handle('comment-add', (id: string, input: NewComment, contextKey?: string) => integrations.addComment(id, input, contextKey));
  handle('comment-update', (id: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string) => integrations.updateComment(id, commentId, changes, contextKey));
  handle('comment-delete', (id: string, commentId: string, contextKey?: string) => integrations.deleteComment(id, commentId, contextKey));
  handle('copy', async (id: string, contextKey?: string) => {
    const output = await integrations.copyFeedback(id, contextKey);
    clipboard.writeText(output);
    return output;
  });
}

function createWindow() {
  closeListenerReady = false; closeRequested = false; permitClose = false;
  closeGate.reset();
  window = new BrowserWindow({
    width: 1500, height: 980, minWidth: 1050, minHeight: 680,
    title: 'Branchline', backgroundColor: '#181818',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('did-start-loading', () => {
    cancelFlush();
    closeGate.reset();
    closeListenerReady = false;
    closeRequested = false;
    permitClose = false;
    quitting = false;
  });
  window.on('close', event => {
    if (!permitClose && updatesBusy(updates.getState())) { event.preventDefault(); return; }
    if (permitClose || !closeListenerReady || window?.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    const closingWindow = window!;
    void closeGate.prepare(() => flushWindow('close')).then(() => {
      if (window !== closingWindow || closingWindow.isDestroyed()) return;
      permitClose = true;
      setImmediate(() => { if (quitting) app.quit(); else window?.close(); });
    }).catch(error => {
      quitting = false;
      cancelFlush();
      if (window === closingWindow && !closingWindow.webContents.isDestroyed()) {
        closingWindow.webContents.send('review:close-cancelled', error instanceof Error ? error.message : 'The workspace could not finish saving. Try closing again.');
      }
    }).finally(() => { closeRequested = false; });
  });
  window.on('closed', () => { cancelFlush(); window = null; });
  window.on('focus', () => { if (closeListenerReady) updates.checkIfDue(); });
  if (devURL) void window.loadURL(devURL);
  else void window.loadFile(rendererFile);
}

app.whenReady().then(async () => {
  try {
    configureIntegrationDiagnostics(join(process.env.BRANCHLINE_DATA_DIR ? join(app.getPath('userData'), 'logs') : app.getPath('logs'), 'integrations.log'));
    store = new ReviewStore(join(app.getPath('userData'), 'reviews.json'));
    await store.load();
    projects = new ProjectService(store);
    reviews = new ReviewService(store, inspectRepo, config => config.remote ? integrations.buildSnapshot(config as import('../shared/types').Review) : buildSnapshot(config));
    const integrationStore = new IntegrationStore(join(app.getPath('userData'), 'integrations.json'));
    const connections = new ConnectionManager(join(app.getPath('userData'), 'credentials.json'), safeStorage);
    await integrationStore.load();
    integrationStore.onReviewChanged(change => {
      if (window && !window.webContents.isDestroyed()) window.webContents.send('review:remote-review-changed', change);
    });
    await connections.load();
    integrations = new IntegrationService(store, reviews, integrationStore, connections, new PointerService(join(app.getPath('userData'), 'pointer-workspaces')));
    jira = new JiraService(store, url => shell.openExternal(url));
    updates = createUpdateService(async () => {
      await installGate.prepare(() => flushWindow('install'));
      permitClose = true;
    }, () => {
      cancelFlush(); installGate.reset(); permitClose = false; quitting = false;
    });
    updates.subscribe(state => {
      if (window && !window.webContents.isDestroyed()) window.webContents.send('review:update-state-changed', state);
      const reload = Menu.getApplicationMenu()?.getMenuItemById('reload');
      if (reload) reload.enabled = !updatesBusy(state);
    });
    installHandlers();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Branchline', submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: showUpdates }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { if (!updatesBusy(updates.getState()) && !closeRequested) window?.webContents.reload(); } }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    createWindow();
    updates.start();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox('Branchline could not start', error instanceof Error ? error.message : String(error));
    app.quit();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => updates?.dispose());
