import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateService, UPDATE_INTERVAL, newerStable, releaseNotesToText } from '../electron/update-service';
import { InstallGate } from '../electron/install-gate';
import { isTrustedReviewSender } from '../electron/ipc-trust';
import { validateInstallLocation } from '../electron/install-location';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class FakeUpdater extends EventEmitter {
  autoDownload = true; autoInstallOnAppQuit = true; autoRunAppAfterInstall = false; allowPrerelease = true; allowDowngrade = true;
  version = '0.11.0'; checks = 0; downloads = 0;
  checkError?: Error; downloadError?: Error; checking?: Promise<void>;
  async checkForUpdates() {
    this.checks++;
    if (this.checking) await this.checking;
    if (this.checkError) throw this.checkError;
    this.emit('update-available', { version: this.version, releaseNotes: '<script>never execute me</script>' });
  }
  async downloadUpdate() {
    this.downloads++; this.emit('download-progress', { percent: 42 });
    if (this.downloadError) { this.emit('error', this.downloadError); throw this.downloadError; }
    this.emit('update-downloaded', { version: this.version });
  }
}
function fixture(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = new FakeUpdater();
  let installs = 0, releases = 0, now = 100;
  const service = new UpdateService({ updater, version: '0.10.0', prepare: async () => {}, install: async () => { installs++; }, release: () => { releases++; }, now: () => now, ...overrides });
  return { updater, service, get installs() { return installs; }, get releases() { return releases; }, advance() { now += UPDATE_INTERVAL; } };
}

test('only newer stable versions can be offered', () => {
  for (const version of ['0.9.9', '0.10.0', '0.11.0-beta.1', 'v0.11.0', '00.11.0', 'wat']) assert.equal(newerStable(version, '0.10.0'), false, version);
  assert.equal(newerStable('0.11.0', '0.10.0'), true);
  assert.equal(newerStable('1.0.0', '0.99.99'), true);
});
test('GitHub HTML release notes become readable plain text', () => {
  assert.equal(releaseNotesToText('<h2>Fixes &amp; improvements</h2><ul><li>Save comments</li></ul><script>bad()</script>'), 'Fixes & improvements\n• Save comments');
});
test('checks never download; download never installs; actions and progress are explicit', async () => {
  const f = fixture(); const states: string[] = [];
  const unsubscribe = f.service.subscribe(state => states.push(state.phase));
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowPrerelease, false); assert.equal(f.updater.allowDowngrade, false);
  assert.equal((await f.service.check()).phase, 'available');
  assert.equal(f.updater.downloads, 0);
  assert.equal((await f.service.download()).phase, 'downloaded');
  assert.equal(f.installs, 0);
  assert.equal((await f.service.install()).phase, 'installing');
  assert.equal(f.installs, 1);
  assert.ok(states.includes('downloading')); assert.ok(states.includes('preparing'));
  const count = states.length; unsubscribe(); f.service.dispose();
  f.updater.emit('download-progress', { percent: 10 }); assert.equal(states.length, count);
  assert.equal(f.updater.listenerCount('update-available'), 0);
});
test('concurrent actions share a check and stale/beta updates are ignored', async () => {
  const f = fixture(); const d = deferred(); f.updater.checking = d.promise;
  const first = f.service.check(); assert.equal(f.service.check(), first); assert.equal(f.service.download(), first);
  f.updater.version = '0.11.0-beta.1'; d.resolve();
  assert.equal((await first).phase, 'idle'); assert.equal(f.updater.checks, 1);
});
test('failed checks and corrupt downloads recover without becoming installable', async () => {
  const f = fixture(); f.updater.checkError = new Error('Offline');
  assert.equal((await f.service.check()).error?.action, 'check');
  f.updater.checkError = undefined; await f.service.check();
  f.updater.downloadError = new Error('sha512 checksum mismatch');
  const failed = await f.service.download();
  assert.equal(failed.phase, 'available'); assert.match(failed.error!.message, /verified/);
  f.updater.emit('update-downloaded', { version: f.updater.version });
  await f.service.install(); assert.equal(f.installs, 0);
  f.updater.downloadError = undefined;
  assert.equal((await f.service.download()).phase, 'downloaded');
});
test('save failure cancels restart and preserves the download for retry', async () => {
  let fail = true;
  const f = fixture({ prepare: async () => { if (fail) throw new Error('Disk unavailable'); } });
  await f.service.check(); await f.service.download();
  const failed = await f.service.install();
  assert.equal(failed.phase, 'downloaded'); assert.equal(f.installs, 0); assert.equal(f.releases, 1);
  fail = false; await f.service.install(); assert.equal(f.installs, 1);
});
test('native staging failure restores the workspace and retry succeeds', async () => {
  let fail = true;
  const f = fixture({ install: async () => { if (fail) throw new Error('Signature verification failed'); } });
  await f.service.check(); await f.service.download();
  assert.equal((await f.service.install()).phase, 'downloaded'); assert.equal(f.releases, 1);
  fail = false; assert.equal((await f.service.install()).phase, 'installing');
});
test('automatic checks are throttled; disabled builds make no network requests', async () => {
  const f = fixture(); f.service.checkIfDue(); await f.service.check();
  f.service.checkIfDue(); assert.equal(f.updater.checks, 1);
  f.advance(); f.service.checkIfDue(); await f.service.check(); assert.equal(f.updater.checks, 2);
  const disabled = fixture({ disabledReason: 'Development build' });
  disabled.service.start(); disabled.service.checkIfDue();
  await disabled.service.check(); await disabled.service.download(); await disabled.service.install();
  assert.equal(disabled.updater.checks, 0); assert.equal(disabled.installs, 0); disabled.service.dispose();
});
test('installation drains accepted Git/project work and flushed comments, then seals writes', async () => {
  const gate = new InstallGate(); const git = deferred(); const save = deferred(); const order: string[] = [];
  const project = gate.run('project-create', async () => { await git.promise; order.push('project saved'); });
  const preparation = gate.prepare(async () => { await gate.run('comment-update', async () => { await save.promise; order.push('comment saved'); }); });
  await assert.rejects(gate.run('refresh', () => {}), /preparing/);
  save.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['comment saved']);
  git.resolve(); await project; await preparation;
  assert.deepEqual(order, ['comment saved', 'project saved']);
  await assert.rejects(gate.run('comment-add', () => {}), /preparing/);
  gate.reset(); await gate.run('refresh', () => {});
});
test('failed in-flight writes abort installation, even when they finish before the flush', async () => {
  const gate = new InstallGate(); const write = deferred(); const flush = deferred();
  const work = gate.run('approve', () => write.promise);
  const preparation = gate.prepare(() => flush.promise);
  write.reject(new Error('Disk full')); await assert.rejects(work, /Disk full/);
  flush.resolve(); await assert.rejects(preparation, /Disk full/);
  await gate.run('approve', () => {});
});
test('missing acknowledgement and late acknowledgement never seal a recovered workspace', async () => {
  const gate = new InstallGate(); const flush = deferred();
  await assert.rejects(gate.prepare(() => flush.promise, 10), /too long/);
  flush.resolve(); await new Promise(resolve => setImmediate(resolve));
  await gate.run('refresh', () => {});
});
test('only the current window, main frame and exact URL can invoke the bridge', () => {
  const mainFrame = {}; const contents = { mainFrame }; const url = 'file:///app/index.html';
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, contents, url, url), true);
  assert.equal(isTrustedReviewSender({ sender: {}, senderFrame: mainFrame }, contents, url, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: {} }, contents, url, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, contents, `${url}?evil`, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, null, url, url), false);
});
test('mounted images, translocated apps and unwritable installations explain how to recover', async () => {
  for (const path of ['/Volumes/Branchline/Branchline.app/Contents/MacOS/Branchline', '/private/var/AppTranslocation/x/Branchline.app/Contents/MacOS/Branchline']) {
    await assert.rejects(validateInstallLocation(path, async () => {}), /Applications/);
  }
  await assert.rejects(validateInstallLocation('/Applications/Branchline.app/Contents/MacOS/Branchline', async () => { throw new Error('EACCES'); }), /writable/);
  const checked: string[] = [];
  await validateInstallLocation('/Applications/Branchline.app/Contents/MacOS/Branchline', async path => { checked.push(path); });
  assert.deepEqual(checked, ['/Applications/Branchline.app', '/Applications']);
});
