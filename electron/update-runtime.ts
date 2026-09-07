import { app, autoUpdater as nativeUpdater } from 'electron';
import updaterModule from 'electron-updater';
import log from 'electron-log/main';
import { installMacUpdate } from './mac-install';
import { UpdateService } from './update-service';
import { UpdateTestDriver } from './update-test-driver';
import { validateInstallLocation } from './install-location';

export function createUpdateService(prepare: () => Promise<void>, release: () => void): UpdateService {
  // The test driver has no feed URL or installer path and cannot run in a packaged app.
  const test = !app.isPackaged && process.env.BRANCHLINE_UPDATE_TEST === '1';
  const disabledReason = !app.isPackaged && !test ? 'Updates are available in the installed macOS application. Development builds do not check for updates.'
    : process.platform !== 'darwin' && !test ? 'In-app updates currently support macOS. Download other platform releases from GitHub.' : undefined;
  const driver = test ? new UpdateTestDriver(() => app.quit()) : undefined;
  if (driver) (app as unknown as { branchlineUpdateTest: UpdateTestDriver }).branchlineUpdateTest = driver;
  const updater = disabledReason ? undefined : driver || updaterModule.autoUpdater;
  log.transports.file.fileName = 'updates.log';
  log.transports.file.maxSize = 1024 * 1024;
  log.transports.console.level = false;
  // Log state and sanitized user-facing errors, without remote response bodies or headers.
  if (updater && !driver) updaterModule.autoUpdater.logger = null;
  return new UpdateService({ version: app.getVersion(), updater, disabledReason,
    prepare: async () => { if (!test) await validateInstallLocation(app.getPath('exe')); await prepare(); },
    install: () => driver ? driver.install() : installMacUpdate(nativeUpdater, () => updaterModule.autoUpdater.quitAndInstall()),
    release, log: message => log.info(message),
  });
}
