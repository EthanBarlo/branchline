import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reviewEvents } from '../../shared/ipc';
import { updatesBusy } from '../../shared/updates';
import type { ReviewStore } from '../reviews/review-store';
import type { JiraBrowser } from '../integrations/jira/jira-browser';
import type { UpdateService } from '../updates/update-service';
import { isHiddenSmokeRun } from '../hidden-smoke-run';
import { JiraBrowserOperations } from './jira-browser-operations';
import { WorkspaceLifecycle } from './workspace-lifecycle';

export function resolvedTheme(store: ReviewStore): 'light' | 'dark' {
  const preference = store.getSettings().theme;
  return preference === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : preference;
}

export class ReviewWindow {
  readonly lifecycle: WorkspaceLifecycle;
  readonly jiraChanges = new JiraBrowserOperations();
  private window: BrowserWindow | null = null;
  private showUpdatesOnReady = false;
  private readonly rendererFile = join(__dirname, '../dist/index.html');
  private readonly devURL = !app.isPackaged ? process.env.BRANCHLINE_DEV_URL : undefined;

  constructor(
    private readonly store: ReviewStore,
    private readonly jira: JiraBrowser,
    private readonly updates: () => UpdateService,
  ) {
    this.lifecycle = new WorkspaceLifecycle({
      getWindow: () => this.window,
      waitForJiraChanges: () => this.jiraChanges.idle(),
      jira,
      updatesBusy: () => updatesBusy(this.updates().getState()),
      quit: () => app.quit(),
      restoreWindow: () => this.create(),
    });
  }

  get current(): BrowserWindow | null {
    return this.window;
  }
  get trustedURL(): string {
    return this.devURL ? `${this.devURL}/` : pathToFileURL(this.rendererFile).href;
  }

  private backgroundColor(): string {
    return resolvedTheme(this.store) === 'dark' ? '#181818' : '#f7f7f6';
  }

  updateTheme(): void {
    if (this.window && !this.window.isDestroyed()) this.window.setBackgroundColor(this.backgroundColor());
    this.jira.updateTheme();
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.webContents.isDestroyed()) this.window.webContents.send(channel, ...args);
  }

  setListenerReady(ready: boolean): void {
    this.lifecycle.setListenerReady(ready);
    if (ready && this.showUpdatesOnReady) {
      this.showUpdatesOnReady = false;
      this.send(reviewEvents.updateShow);
    }
  }

  showUpdates(): void {
    if (!this.window) {
      this.showUpdatesOnReady = true;
      this.create();
    } else {
      if (!isHiddenSmokeRun) {
        if (this.window.isMinimized()) this.window.restore();
        this.window.show();
      }
      if (this.lifecycle.ready) this.send(reviewEvents.updateShow);
      else this.showUpdatesOnReady = true;
    }
    void this.updates().check();
  }

  reload(): void {
    if (!updatesBusy(this.updates().getState()) && !this.lifecycle.closing && !this.jira.reloadFocused())
      this.window?.webContents.reload();
  }

  create(): void {
    this.lifecycle.windowCreated();
    this.window = new BrowserWindow({
      show: !isHiddenSmokeRun,
      focusable: !isHiddenSmokeRun,
      paintWhenInitiallyHidden: true,
      width: 1500,
      height: 980,
      minWidth: 1050,
      minHeight: 680,
      title: 'Branchline',
      backgroundColor: this.backgroundColor(),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event) => event.preventDefault());
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    this.window.webContents.session.setPermissionCheckHandler(() => false);
    this.window.webContents.on('did-start-loading', () => this.lifecycle.loadingStarted());
    this.window.on('close', (event) => this.lifecycle.requestClose(event));
    this.window.on('closed', () => {
      this.lifecycle.windowClosed();
      this.window = null;
    });
    this.window.on('focus', () => {
      if (this.lifecycle.ready) this.updates().checkIfDue();
    });
    if (this.devURL) void this.window.loadURL(this.devURL);
    else void this.window.loadFile(this.rendererFile);
  }
}
