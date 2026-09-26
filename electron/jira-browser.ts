import { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, session, shell } from 'electron';
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JiraBrowserBounds } from '../shared/integrations';
import { pathToFileURL } from 'node:url';
import { isJiraBrowserURL, jiraBrowserPartition, validateJiraBrowserTarget } from './jira-browser-policy';
import type { JiraBrowserTarget } from './jira-browser-policy';

export type { JiraBrowserTarget } from './jira-browser-policy';

const chromeFile = join(__dirname, '../dist/electron/jira-browser.html');
const devURL = !app.isPackaged ? process.env.BRANCHLINE_DEV_URL : undefined;
const chromeURL = devURL ? `${devURL}/electron/jira-browser.html` : pathToFileURL(chromeFile).href;
const minimumToolbarHeight = 48;
const maximumToolbarHeight = 160;
const stateChannel = 'jira-browser:state';
const actionChannel = 'jira-browser:action';
const resizeChannel = 'jira-browser:resize';

// Electron needs a concrete view color before the StyleX toolbar stylesheet loads.
function chromeBackgroundColor(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? '#222222' : '#ffffff';
}

interface Viewer {
  id: string;
  bounds: JiraBrowserBounds;
  chromeView: WebContentsView;
  dispose: () => void;
  target: JiraBrowserTarget;
  window: BrowserWindow;
  view: WebContentsView;
  contents: WebContents;
  chrome: WebContents;
  toolbarHeight: number;
  popups: Map<BrowserWindow, WebContents>;
  error: string;
  message: string;
  closing: boolean;
  closePromise?: Promise<boolean>;
}

/** The website never receives Branchline's preload or API credentials. */
export class JiraBrowser {
  private viewers = new Set<Viewer>();
  private sessions = new Map<string, Session>();
  private resettingBounds = new Map<string, JiraBrowserBounds>();
  private queues = new Map<string, Promise<unknown>>();
  private pendingClosures = new Map<WebContents, (closed: boolean) => void>();
  private closePreparation: Promise<boolean> | null = null;
  private closingAll = false;

  constructor(private readonly theme: () => 'light' | 'dark') {
    ipcMain.handle(actionChannel, async (event, action: unknown) => {
      const viewer = this.trustedViewer(event);
      if (viewer.closing || this.closingAll) return;
      try {
        switch (action) {
          case 'state': this.publish(viewer); break;
          case 'back':
            if (viewer.contents.navigationHistory.canGoBack()) viewer.contents.navigationHistory.goBack();
            break;
          case 'reload':
            viewer.error = '';
            if (viewer.contents.getURL()) viewer.contents.reload();
            else this.navigate(viewer);
            break;
          case 'external': await shell.openExternal(viewer.target.url); break;
          case 'clear-ticket':
            if (!viewer.window.webContents.isDestroyed()) viewer.window.webContents.send('review:jira-browser-clear-ticket', viewer.id);
            break;
          case 'close': await this.closeViewer(viewer); break;
          case 'menu': this.showMenu(viewer); break;
          case 'focus-page': viewer.contents.focus(); break;
          case 'focus-host': viewer.window.webContents.focus(); break;
          case 'reset': await this.resetSignIn(viewer); break;
          default: throw new Error('Unknown Jira browser control.');
        }
      } catch (error) {
        this.reportActionError(viewer, error);
        throw error;
      }
    });
    ipcMain.handle(resizeChannel, (event, height: unknown) => {
      const viewer = this.trustedViewer(event);
      if (typeof height !== 'number' || !Number.isInteger(height) || height < minimumToolbarHeight || height > maximumToolbarHeight) {
        throw new Error('The Jira toolbar height is invalid.');
      }
      if (viewer.closing || this.closingAll) return;
      viewer.toolbarHeight = height;
      this.resize(viewer);
    });
  }

  private trustedViewer(event: IpcMainInvokeEvent): Viewer {
    const viewer = [...this.viewers].find(item => item.chrome === event.sender);
    if (!viewer || viewer.window.isDestroyed() || viewer.chrome.isDestroyed()
      || event.senderFrame !== viewer.chrome.mainFrame || event.senderFrame?.url !== chromeURL) {
      throw new Error('Only the Jira window toolbar can use these controls.');
    }
    return viewer;
  }

  private validateBounds(bounds: JiraBrowserBounds): void {
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => {
      const value = bounds[key as keyof JiraBrowserBounds];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100000;
    }) || bounds.width < 1 || bounds.height < 1) throw new Error('The Jira modal bounds are invalid.');
  }

  resizeEmbedded(id: string, bounds: JiraBrowserBounds): void {
    this.validateBounds(bounds);
    if (this.resettingBounds.has(id)) this.resettingBounds.set(id, { ...bounds });
    const viewer = [...this.viewers].find(item => item.id === id);
    if (!viewer) return;
    viewer.bounds = { ...bounds };
    this.resize(viewer);
  }

  focusEmbedded(id: string): void {
    const viewer = [...this.viewers].find(item => item.id === id);
    if (viewer && !viewer.closing && !viewer.chrome.isDestroyed()) viewer.chrome.focus();
  }

  updateTheme(): void {
    for (const viewer of this.viewers) {
      if (viewer.chrome.isDestroyed()) continue;
      viewer.chromeView.setBackgroundColor(chromeBackgroundColor(this.theme()));
      this.publish(viewer);
    }
  }

  async closeEmbedded(id: string): Promise<boolean> {
    await Promise.allSettled([...this.queues.values()]);
    const viewer = [...this.viewers].find(item => item.id === id);
    return viewer ? this.closeViewer(viewer) : Promise.resolve(true);
  }

  private resize(viewer: Viewer): void {
    if (viewer.window.isDestroyed() || viewer.contents.isDestroyed() || viewer.chrome.isDestroyed()) return;
    const [windowWidth, windowHeight] = viewer.window.getContentSize();
    const zoom = viewer.window.webContents.getZoomFactor();
    const x = Math.min(windowWidth, Math.round(viewer.bounds.x * zoom));
    const y = Math.min(windowHeight, Math.round(viewer.bounds.y * zoom));
    const width = Math.min(windowWidth - x, Math.round(viewer.bounds.width * zoom));
    const height = Math.min(windowHeight - y, Math.round(viewer.bounds.height * zoom));
    const toolbarHeight = Math.min(height, Math.round(viewer.toolbarHeight * zoom));
    viewer.chrome.setZoomFactor(zoom);
    viewer.chromeView.setBounds({ x, y, width, height: toolbarHeight });
    viewer.view.setBounds({ x, y: y + toolbarHeight, width, height: height - toolbarHeight });
  }

  private reportActionError(viewer: Viewer, error: unknown): void {
    viewer.error = error instanceof Error ? error.message : 'The Jira browser action failed.';
    this.publish(viewer);
  }

  private showMenu(viewer: Viewer): void {
    if (!this.viewers.has(viewer) || viewer.closing || this.closingAll || viewer.window.isDestroyed()) return;
    let currentOrigin = 'Opening Jira…';
    if (!viewer.contents.isDestroyed()) {
      try { currentOrigin = new URL(viewer.contents.getURL()).origin; } catch { /* Before first navigation. */ }
    }
    const menu = Menu.buildFromTemplate([
      { label: `Connection: ${viewer.target.accountLabel}`, enabled: false },
      { label: `Site: ${new URL(viewer.target.siteUrl).host}`, enabled: false },
      { label: `Viewing: ${currentOrigin}`, enabled: false },
      { type: 'separator' },
      { id: 'jira-reset-sign-in', label: 'Reset sign-in…', click: () => {
        void this.resetSignIn(viewer).catch(error => this.reportActionError(viewer, error));
      } },
    ]);
    menu.popup({ window: viewer.window });
  }

  private async resetSignIn(viewer: Viewer): Promise<void> {
    if (!this.viewers.has(viewer) || viewer.closing || this.closingAll || viewer.window.isDestroyed()) return;
    const answer = await dialog.showMessageBox(viewer.window, {
      type: 'question', title: 'Reset Jira sign-in?',
      message: 'Close this Jira page and clear this connection’s website sign-in?',
      detail: 'Your API token and saved reviews stay unchanged. You will need to sign in to Jira again.',
      buttons: ['Cancel', 'Reset sign-in'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1 || !this.viewers.has(viewer) || viewer.closing || this.closingAll || viewer.window.isDestroyed()) return;
    await this.serialize(viewer.target.connectionId, async () => {
      // Disconnect may have removed this viewer while the confirmation was open.
      if (!this.viewers.has(viewer) || viewer.closing || this.closingAll || viewer.window.isDestroyed()) return;
      const parent = viewer.window;
      const { id, target, bounds } = viewer;
      this.resettingBounds.set(id, bounds);
      try {
        if (!await this.closeViewer(viewer, false)) return;
        await this.clearSession(target.connectionId);
        if (!this.closingAll && !parent.isDestroyed()) await this.createViewer(target, parent, this.resettingBounds.get(id) || bounds, id);
        else if (!parent.isDestroyed()) parent.webContents.send('review:jira-browser-closed', id);
      } catch (error) {
        if (!parent.isDestroyed()) parent.webContents.send('review:jira-browser-closed', id);
        throw error;
      } finally { this.resettingBounds.delete(id); }
    });
  }

  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(id, pending);
    void pending.finally(() => { if (this.queues.get(id) === pending) this.queues.delete(id); }).catch(() => {});
    return pending;
  }

  private connectionSession(id: string): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const isolated = session.fromPartition(jiraBrowserPartition(id));
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on('will-download', event => {
      event.preventDefault();
      for (const viewer of this.viewers) if (viewer.target.connectionId === id) {
        viewer.message = 'To download attachments, choose Open in browser. Downloads are disabled in this preview.';
        this.publish(viewer);
      }
    });
    this.sessions.set(id, isolated);
    return isolated;
  }

  async open(target: JiraBrowserTarget, parent: BrowserWindow, bounds: JiraBrowserBounds): Promise<string> {
    validateJiraBrowserTarget(target);
    this.validateBounds(bounds);
    return this.serialize(target.connectionId, () => this.createViewer(target, parent, bounds));
  }

  private async createViewer(target: JiraBrowserTarget, parent: BrowserWindow, bounds: JiraBrowserBounds, id: string = randomUUID()): Promise<string> {
    if (this.closingAll) throw new Error('Branchline is closing. Reopen Jira after closing has finished.');
    if (parent.isDestroyed()) throw new Error('The Branchline window has closed.');
    for (const existing of this.viewers) {
      if (existing.window !== parent) continue;
      if (existing.target.connectionId === target.connectionId && existing.target.url === target.url && !existing.closing) {
        this.resizeEmbedded(existing.id, bounds);
        existing.chrome.focus();
        return existing.id;
      }
      if (!await this.closeViewer(existing)) throw new Error('Finish editing or close the current Jira ticket first.');
    }
    const chromeView = new WebContentsView({ webPreferences: {
      preload: join(__dirname, 'jira-browser-preload.cjs'),
      additionalArguments: [`--branchline-jira-theme=${this.theme()}`],
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    } });
    const view = new WebContentsView({ webPreferences: {
      session: this.connectionSession(target.connectionId), nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
    } });
    const contents = view.webContents;
    const chrome = chromeView.webContents;
    const owner = parent.webContents;
    const viewer: Viewer = { id, target: { ...target }, window: parent, bounds: { ...bounds }, chromeView,
      view, contents, chrome, toolbarHeight: minimumToolbarHeight, popups: new Map(), error: '', message: '', closing: false, dispose: () => {} };
    this.viewers.add(viewer);
    parent.contentView.addChildView(chromeView);
    parent.contentView.addChildView(view);
    chromeView.setBackgroundColor(chromeBackgroundColor(this.theme()));
    view.setBackgroundColor('#ffffff');
    const resize = () => this.resize(viewer);
    const parentClosed = () => this.destroyViewer(viewer);
    const rendererGone = () => this.destroyViewer(viewer);
    // A reloaded renderer no longer owns the modal. Normal menu reload targets Jira instead.
    const rendererNavigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) this.destroyViewer(viewer);
    };
    parent.on('resize', resize);
    parent.once('closed', parentClosed);
    owner.on('render-process-gone', rendererGone);
    owner.on('did-start-navigation', rendererNavigated);
    viewer.dispose = () => {
      parent.removeListener('resize', resize);
      parent.removeListener('closed', parentClosed);
      if (!owner.isDestroyed()) {
        owner.removeListener('render-process-gone', rendererGone);
        owner.removeListener('did-start-navigation', rendererNavigated);
      }
    };
    this.resize(viewer);
    chrome.setWindowOpenHandler(() => ({ action: 'deny' }));
    chrome.on('will-navigate', event => event.preventDefault());
    chrome.on('will-frame-navigate', event => event.preventDefault());
    this.configureRemote(viewer, contents, parent);
    try {
      await chrome.loadURL(chromeURL);
      if (parent.isDestroyed() || chrome.isDestroyed()) throw new Error('The Jira modal closed before it was ready.');
      this.publish(viewer);
      chrome.focus();
      this.navigate(viewer);
      return id;
    } catch (error) { this.destroyViewer(viewer); throw error; }
  }

  private destroyViewer(viewer: Viewer, notify = true): void {
    if (!this.viewers.delete(viewer)) return;
    viewer.dispose();
    for (const popup of viewer.popups.keys()) if (!popup.isDestroyed()) popup.destroy();
    if (!viewer.window.isDestroyed()) {
      viewer.window.contentView.removeChildView(viewer.view);
      viewer.window.contentView.removeChildView(viewer.chromeView);
    }
    if (!viewer.contents.isDestroyed()) viewer.contents.close({ waitForBeforeUnload: false });
    if (!viewer.chrome.isDestroyed()) viewer.chrome.close({ waitForBeforeUnload: false });
    if (notify && !viewer.window.isDestroyed() && !viewer.window.webContents.isDestroyed()) {
      viewer.window.webContents.send('review:jira-browser-closed', viewer.id);
      viewer.window.webContents.focus();
    }
  }

  private navigate(viewer: Viewer) {
    void viewer.contents.loadURL(viewer.target.url).catch(error => {
      if (viewer.window.isDestroyed() || viewer.contents.isDestroyed() || error?.code === 'ERR_ABORTED') return;
      viewer.error = 'Jira could not be loaded. Reload, or choose Open in browser to continue.';
      this.publish(viewer);
    });
  }

  private configureRemote(viewer: Viewer, contents: WebContents, host: BrowserWindow) {
    const blockedLink = () => {
      viewer.error = 'That link cannot open here. This preview only supports HTTPS websites. Use Open in browser if sign-in requires another app.';
      this.publish(viewer);
    };
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (!isJiraBrowserURL(url)) {
        event.preventDefault();
        blockedLink();
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!isJiraBrowserURL(url)) { event.preventDefault(); blockedLink(); }
    });
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame && !isJiraBrowserURL(event.url)) { event.preventDefault(); blockedLink(); }
    });
    contents.on('will-prevent-unload', event => {
      const response = dialog.showMessageBoxSync(host, {
        type: 'warning', title: 'Leave Jira?', message: 'Jira may have unsaved changes.',
        detail: 'Stay to finish editing, or leave and discard any unsaved changes.',
        buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0,
      });
      if (response === 1) event.preventDefault();
      else this.pendingClosures.get(contents)?.(false);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (!isJiraBrowserURL(url)) {
        viewer.error = 'This sign-in popup cannot open here. Choose Open in browser to continue in your normal browser.';
        this.publish(viewer);
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: host, width: 850, height: 750, autoHideMenuBar: true,
        webPreferences: {
          session: contents.session, nodeIntegration: false, contextIsolation: true, sandbox: true,
          webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false,
          preload: undefined,
        },
      } };
    });
    contents.on('did-create-window', popup => {
      const popupContents = popup.webContents;
      viewer.popups.set(popup, popupContents);
      this.configureRemote(viewer, popupContents, popup);
      popup.once('closed', () => viewer.popups.delete(popup));
      const title = () => {
        try { popup.setTitle(`${new URL(popupContents.getURL()).origin} · Jira sign-in`); } catch { /* Initial blank page. */ }
      };
      popupContents.on('page-title-updated', event => { event.preventDefault(); title(); });
      popupContents.on('did-navigate', title);
    });
    contents.on('did-start-loading', () => { viewer.error = ''; this.publish(viewer); });
    contents.on('did-stop-loading', () => this.publish(viewer));
    contents.on('did-navigate', () => this.publish(viewer));
    contents.on('did-navigate-in-page', () => this.publish(viewer));
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      viewer.error = `Jira could not load (${description}). Reload, or choose Open in browser.`;
      this.publish(viewer);
    });
    contents.on('render-process-gone', () => {
      viewer.error = 'The Jira page stopped responding. Reload, or choose Open in browser.';
      this.publish(viewer);
    });
  }

  private publish(viewer: Viewer) {
    if (viewer.window.isDestroyed() || viewer.chrome.isDestroyed()) return;
    const contents = viewer.contents;
    let currentOrigin = '';
    if (!contents.isDestroyed()) { try { currentOrigin = new URL(contents.getURL()).origin; } catch { /* Before first navigation. */ } }
    viewer.chrome.send(stateChannel, {
      key: viewer.target.key, accountLabel: viewer.target.accountLabel, site: new URL(viewer.target.siteUrl).host,
      currentOrigin, loading: !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      error: viewer.error, message: viewer.message, theme: this.theme(),
    });
  }

  private closeViewer(viewer: Viewer, notify = true): Promise<boolean> {
    if (viewer.window.isDestroyed()) return Promise.resolve(true);
    if (viewer.closePromise) return viewer.closePromise;
    const pending = this.finishClose(viewer, notify);
    viewer.closePromise = pending;
    void pending.finally(() => { if (viewer.closePromise === pending) viewer.closePromise = undefined; }).catch(() => {});
    return pending;
  }

  private async finishClose(viewer: Viewer, notify: boolean): Promise<boolean> {
    viewer.closing = true;
    try {
      for (const [popup, popupContents] of viewer.popups) {
        if (popup.isDestroyed()) continue;
        const closed = await new Promise<boolean>(resolve => {
          const finish = (value: boolean) => { popup.removeListener('closed', onClosed); this.pendingClosures.delete(popupContents); resolve(value); };
          const onClosed = () => finish(true);
          popup.once('closed', onClosed);
          this.pendingClosures.set(popupContents, finish);
          popup.close();
        });
        if (!closed) return false;
      }
      const contents = viewer.contents;
      if (!contents.isDestroyed()) {
        const closed = await new Promise<boolean>(resolve => {
          const finish = (value: boolean) => { contents.removeListener('destroyed', destroyed); this.pendingClosures.delete(contents); resolve(value); };
          const destroyed = () => finish(true);
          this.pendingClosures.set(contents, finish);
          contents.once('destroyed', destroyed);
          contents.close({ waitForBeforeUnload: true });
        });
        if (!closed) return false;
      }
      this.destroyViewer(viewer, notify);
      return true;
    } finally { viewer.closing = false; }
  }

  async clearConnection(connectionId: string): Promise<void> {
    jiraBrowserPartition(connectionId);
    await this.serialize(connectionId, () => this.clearSession(connectionId));
  }

  private async clearSession(connectionId: string): Promise<void> {
    for (const viewer of [...this.viewers]) if (viewer.target.connectionId === connectionId && !await this.closeViewer(viewer)) {
      throw new Error('Jira is still open with unsaved changes. Finish editing or close the ticket before resetting this connection.');
    }
    const isolated = this.connectionSession(connectionId);
    await isolated.clearStorageData();
    await isolated.clearCache();
    await isolated.clearAuthCache();
    await isolated.closeAllConnections();
  }

  closeAll(): void {
    for (const viewer of [...this.viewers]) void this.closeViewer(viewer);
  }

  hasOpenWindows(): boolean {
    return this.queues.size > 0 || [...this.viewers].some(viewer => !viewer.window.isDestroyed());
  }

  reloadFocused(): boolean {
    const focused = BrowserWindow.getFocusedWindow();
    for (const viewer of this.viewers) {
      if (viewer.window === focused && !viewer.contents.isDestroyed()) {
        viewer.error = '';
        if (viewer.contents.getURL()) viewer.contents.reload();
        else this.navigate(viewer);
        return true;
      }
      const popupContents = focused ? viewer.popups.get(focused) : undefined;
      if (popupContents && !popupContents.isDestroyed()) { popupContents.reload(); return true; }
    }
    return false;
  }

  prepareClose(): Promise<boolean> {
    if (this.closePreparation) return this.closePreparation;
    this.closingAll = true;
    const pending = (async () => {
      await Promise.allSettled([...this.queues.values()]);
      for (const viewer of [...this.viewers]) if (!await this.closeViewer(viewer)) return false;
      return true;
    })();
    this.closePreparation = pending;
    void pending.finally(() => {
      this.closingAll = false;
      if (this.closePreparation === pending) this.closePreparation = null;
    }).catch(() => {});
    return pending;
  }
}
