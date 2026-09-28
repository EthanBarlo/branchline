import { app, dialog, ipcMain, nativeTheme, safeStorage } from 'electron';
import { join } from 'node:path';
import { reviewEvents } from '../shared/ipc';
import { updatesBusy } from '../shared/updates';
import { createServices } from './application/create-services';
import { installApplicationMenu, setReloadEnabled } from './application/application-menu';
import { isHiddenSmokeRun } from './hidden-smoke-run';
import { ReviewWindow, resolvedTheme } from './application/review-window';
import { configureIntegrationDiagnostics } from './integrations/integration-diagnostics';
import { JiraBrowser } from './integrations/jira/jira-browser';
import { createReviewHandlerRegistrar } from './ipc/register-review-handlers';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers';
import { registerIntegrationHandlers } from './ipc/integration-handlers';
import { registerLifecycleHandlers } from './ipc/lifecycle-handlers';
import { createUpdateService } from './updates/update-runtime';
import type { UpdateService } from './updates/update-service';

// A separate location is used by the automated desktop smoke test.
if (process.env.BRANCHLINE_DATA_DIR) app.setPath('userData', process.env.BRANCHLINE_DATA_DIR);
app.setName('Branchline');
if (isHiddenSmokeRun && process.platform === 'darwin') app.setActivationPolicy('accessory');
let reviewWindow: ReviewWindow | undefined;
let updates: UpdateService | undefined;

app.whenReady().then(async () => {
  try {
    const dataDirectory = app.getPath('userData');
    const logDirectory = process.env.BRANCHLINE_DATA_DIR ? join(dataDirectory, 'logs') : app.getPath('logs');
    configureIntegrationDiagnostics(join(logDirectory, 'integrations.log'));
    const services = await createServices(dataDirectory, safeStorage);
    const { store, integrations, integrationStore } = services;
    nativeTheme.themeSource = store.getSettings().theme;
    const jira = new JiraBrowser(() => resolvedTheme(store));
    const window = new ReviewWindow(store, jira, () => updates!);
    reviewWindow = window;
    nativeTheme.on('updated', () => {
      if (store.getSettings().theme === 'system') window.updateTheme();
    });
    integrationStore.onReviewChanged((change) => window.send(reviewEvents.remoteReviewChanged, change));
    integrations.onRemoteReviewLoadProgress((change) => window.send(reviewEvents.remoteReviewLoad, change));
    updates = createUpdateService(
      () => window.lifecycle.prepareInstall(),
      () => window.lifecycle.releaseInstall(),
    );
    updates.subscribe((state) => {
      window.send(reviewEvents.updateStateChanged, state);
      setReloadEnabled(!updatesBusy(state));
    });
    const handle = createReviewHandlerRegistrar({
      register: (channel, handler) => ipcMain.handle(channel, handler),
      getContents: () => window.current?.webContents ?? null,
      trustedURL: window.trustedURL,
      closeGate: window.lifecycle.closeGate,
      installGate: window.lifecycle.installGate,
    });
    registerWorkspaceHandlers(handle, { ...services, window });
    registerIntegrationHandlers(handle, integrations, jira, window);
    registerLifecycleHandlers(handle, window, updates);
    installApplicationMenu(window);
    window.create();
    updates.start();
    app.on('activate', () => {
      if (!window.current || window.current.isDestroyed()) window.create();
    });
  } catch (error) {
    if (isHiddenSmokeRun) console.error('Branchline could not start:', error);
    else
      dialog.showErrorBox(
        'Branchline could not start',
        error instanceof Error ? error.message : String(error),
      );
    app.quit();
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => reviewWindow?.lifecycle.beforeQuit());
app.on('will-quit', () => updates?.dispose());
