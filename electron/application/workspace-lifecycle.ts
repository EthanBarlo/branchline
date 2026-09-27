import { reviewEvents } from '../../shared/ipc';
import { InstallGate } from './install-gate';

export interface WorkspaceWindow {
  isDestroyed(): boolean;
  close(): void;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

interface LifecycleDependencies {
  getWindow(): WorkspaceWindow | null;
  waitForJiraChanges(): Promise<unknown>;
  jira: { hasOpenWindows(): boolean; prepareClose(): Promise<boolean> };
  updatesBusy(): boolean;
  quit(): void;
  restoreWindow(): void;
}

/** Owns the save acknowledgement and the write gates shared by close and update. */
export class WorkspaceLifecycle {
  readonly installGate = new InstallGate();
  readonly closeGate = new InstallGate('close');
  private listenerReady = false;
  private closeRequested = false;
  private permitClose = false;
  private quitting = false;
  private sequence = 0;
  private pendingFlush: { id: number; resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly dependencies: LifecycleDependencies) {}

  get ready(): boolean {
    return this.listenerReady;
  }
  get closing(): boolean {
    return this.closeRequested;
  }

  windowCreated(): void {
    this.listenerReady = false;
    this.closeRequested = false;
    this.permitClose = false;
    this.closeGate.reset();
  }

  loadingStarted(): void {
    this.cancelFlush();
    this.windowCreated();
    this.quitting = false;
  }

  beforeQuit(): void {
    this.quitting = true;
  }
  windowClosed(): void {
    this.cancelFlush();
  }

  setListenerReady(ready: boolean): void {
    this.listenerReady = ready === true;
    if (!ready) this.cancelFlush();
  }

  acknowledgeFlush(id: number, saved: boolean): void {
    if (!this.pendingFlush || this.pendingFlush.id !== id) return;
    const request = this.pendingFlush;
    this.pendingFlush = null;
    // Deliver the acknowledgement before close or native installation proceeds.
    setImmediate(() =>
      saved === true
        ? request.resolve()
        : request.reject(
            new Error('Your pending comments could not be saved. Fix the save error and retry.'),
          ),
    );
  }

  flushWindow(reason: 'close' | 'install'): Promise<void> {
    const window = this.dependencies.getWindow();
    if (!window || window.webContents.isDestroyed() || !this.listenerReady || this.pendingFlush) {
      return Promise.reject(
        new Error('The workspace is not ready to save. Keep the window open and try again.'),
      );
    }
    return new Promise((resolve, reject) => {
      this.pendingFlush = { id: ++this.sequence, resolve, reject };
      window.webContents.send(reviewEvents.beforeClose, { id: this.pendingFlush.id, reason });
    });
  }

  cancelFlush(): void {
    this.pendingFlush?.reject(new Error('The window did not finish saving.'));
    this.pendingFlush = null;
  }

  assertCanInstall(): void {
    if (this.closeRequested)
      throw new Error('The window is preparing to close. Finish saving before installing an update.');
    this.assertJiraClosedForInstall();
  }

  async prepareInstall(): Promise<void> {
    await this.installGate.prepare(() => this.flushWindow('install'));
    this.assertJiraClosedForInstall();
    this.permitClose = true;
  }

  releaseInstall(): void {
    this.cancelFlush();
    this.installGate.reset();
    this.permitClose = false;
    this.quitting = false;
    const window = this.dependencies.getWindow();
    if (!window || window.isDestroyed()) this.dependencies.restoreWindow();
  }

  private assertJiraClosedForInstall(): void {
    if (this.dependencies.jira.hasOpenWindows())
      throw new Error(
        'Close the Jira ticket before installing an update so any Jira edits can finish saving.',
      );
  }

  requestClose(event: { preventDefault(): void }): void {
    const window = this.dependencies.getWindow();
    if (!this.permitClose && this.dependencies.updatesBusy()) {
      event.preventDefault();
      return;
    }
    if (this.permitClose || window?.webContents.isDestroyed()) return;
    if (!this.listenerReady && !this.dependencies.jira.hasOpenWindows()) return;
    event.preventDefault();
    if (this.closeRequested || !window) return;
    this.closeRequested = true;
    void this.closeGate
      .prepare(async () => {
        await this.dependencies.waitForJiraChanges();
        if (!(await this.dependencies.jira.prepareClose()))
          throw new Error('Jira is still open. Save your edits before closing.');
        if (this.listenerReady) await this.flushWindow('close');
      })
      .then(async () => {
        if (this.dependencies.getWindow() !== window || window.isDestroyed()) return;
        if (!(await this.dependencies.jira.prepareClose())) {
          this.closeGate.reset();
          throw new Error('Jira is still open. Save your edits before closing.');
        }
        this.permitClose = true;
        setImmediate(() => {
          if (this.quitting) this.dependencies.quit();
          else this.dependencies.getWindow()?.close();
        });
      })
      .catch((error) => {
        this.quitting = false;
        this.cancelFlush();
        if (this.dependencies.getWindow() === window && !window.webContents.isDestroyed()) {
          window.webContents.send(
            reviewEvents.closeCancelled,
            error instanceof Error
              ? error.message
              : 'The workspace could not finish saving. Try closing again.',
          );
        }
      })
      .finally(() => {
        this.closeRequested = false;
      });
  }
}
