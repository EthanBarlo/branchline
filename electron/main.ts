import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectRepo } from './git';
import { ReviewStore } from './store';
import { ProjectService } from './project-service';
import { ReviewService } from './review-service';
import type { FileApproval, NewComment, NewProject, NewReview } from '../shared/types';

// A separate location is used by the automated desktop smoke test.
if (process.env.BRANCHLINE_DATA_DIR) app.setPath('userData', process.env.BRANCHLINE_DATA_DIR);
app.setName('Branchline');
let store: ReviewStore;
let projects: ProjectService;
let reviews: ReviewService;
let window: BrowserWindow | null = null;
let closeListenerReady = false;
let closeRequested = false;
let permitClose = false;
let quitting = false;
const rendererFile = join(__dirname, '../dist/index.html');
const devURL = !app.isPackaged ? process.env.BRANCHLINE_DEV_URL : undefined;

function installHandlers() {
  const handle = (name: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(`review:${name}`, (event, ...args) => {
      const sender = event.senderFrame;
      const url = sender?.url;
      const trustedURL = devURL ? `${devURL}/` : pathToFileURL(rendererFile).href;
      if (!window || event.sender !== window.webContents || sender !== window.webContents.mainFrame || url !== trustedURL) {
        throw new Error('This request did not come from the review window.');
      }
      return fn(...args);
    });
  };
  handle('state', () => store.getState());
  handle('close-listener', (ready: boolean) => { closeListenerReady = ready === true; });
  handle('close-ready', (saved: boolean) => {
    if (!closeRequested) return;
    closeRequested = false;
    if (saved !== true) { quitting = false; return; }
    permitClose = true;
    // Return the IPC reply before closing its renderer.
    setImmediate(() => { if (quitting) app.quit(); else window?.close(); });
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
  handle('project-delete', (id: string) => reviews.deleteProject(id));
  handle('create', (input: NewReview) => projects.createReview(input));
  handle('delete', (id: string) => reviews.deleteReview(id));
  handle('refresh', (id: string) => reviews.refreshReview(id));
  handle('current-target', (projectId: string, target: string) => reviews.setCurrentTarget(projectId, target));
  handle('approve', (id: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string) => reviews.setApproval(id, fileId, fingerprint, approved, contextKey));
  handle('approve-many', (id: string, files: FileApproval[], approved: boolean, contextKey?: string) => reviews.setApprovals(id, files, approved, contextKey));
  handle('comment-add', (id: string, input: NewComment, contextKey?: string) => reviews.addComment(id, input, contextKey));
  handle('comment-update', (id: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string) => reviews.updateComment(id, commentId, changes, contextKey));
  handle('comment-delete', (id: string, commentId: string, contextKey?: string) => reviews.deleteComment(id, commentId, contextKey));
  handle('copy', async (id: string, contextKey?: string) => {
    const output = await reviews.copyFeedback(id, contextKey);
    clipboard.writeText(output);
    return output;
  });
}

function createWindow() {
  closeListenerReady = false; closeRequested = false; permitClose = false;
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
    closeListenerReady = false;
    closeRequested = false;
    permitClose = false;
    quitting = false;
  });
  window.on('close', event => {
    if (permitClose || !closeListenerReady || window?.webContents.isDestroyed()) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    window?.webContents.send('review:before-close');
  });
  window.on('closed', () => { window = null; });
  if (devURL) void window.loadURL(devURL);
  else void window.loadFile(rendererFile);
}

app.whenReady().then(async () => {
  try {
    store = new ReviewStore(join(app.getPath('userData'), 'reviews.json'));
    await store.load();
    projects = new ProjectService(store);
    reviews = new ReviewService(store);
    installHandlers();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Branchline', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox('Branchline could not start', error instanceof Error ? error.message : String(error));
    app.quit();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { quitting = true; });
