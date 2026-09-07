import { EventEmitter } from 'node:events';

/** Inert update simulator, reachable only from an unpackaged desktop test launch. */
export class UpdateTestDriver extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = true;
  allowPrerelease = false;
  allowDowngrade = false;
  failCheckOnce = false;
  failDownloadOnce = false;
  failInstallOnce = false;
  checks = 0;
  installs = 0;
  version = '99.0.0';
  constructor(private quit: () => void) { super(); }
  async checkForUpdates() {
    this.checks++;
    if (this.failCheckOnce) { this.failCheckOnce = false; throw new Error('Offline'); }
    this.emit('update-available', { version: this.version, releaseNotes: 'A better Branchline.\n\n• Faster reviews\n• Reliable updates' });
  }
  async downloadUpdate() {
    this.emit('download-progress', { percent: 42 });
    await new Promise(resolve => setTimeout(resolve, 500));
    if (this.failDownloadOnce) { this.failDownloadOnce = false; throw new Error('Download interrupted'); }
    this.emit('update-downloaded', { version: this.version });
  }
  async install() {
    if (this.failInstallOnce) { this.failInstallOnce = false; throw new Error('Native staging failed; please retry.'); }
    this.installs++;
    setImmediate(this.quit);
  }
}
