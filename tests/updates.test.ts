import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateService, UPDATE_INTERVAL, newerStable, releaseNotesToText } from '../electron/update-service';
import { InstallGate } from '../electron/install-gate';
import { isTrustedReviewSender } from '../electron/ipc-trust';
import { validateInstallLocation } from '../electron/install-location';
import { createMacUpdateInstaller, installMacUpdate } from '../electron/mac-install';

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
test('native authorization starts only after an explicit install and all pending work is saved', async () => {
  const gate = new InstallGate();
  const write = deferred(), flush = deferred(), native = new EventEmitter();
  const order: string[] = [];
  let authorizations = 0, quits = 0;
  const pendingWrite = gate.run('comment-update', async () => { await write.promise; order.push('saved comment'); });
  const f = fixture({
    prepare: () => gate.prepare(async () => { await flush.promise; order.push('flushed renderer'); }),
    install: () => installMacUpdate(native, () => {
      authorizations++;
      order.push('native authorization');
      native.once('update-downloaded', () => { quits++; });
    }),
    release: () => gate.reset(),
  });
  await f.service.check(); await f.service.download();
  assert.equal(authorizations, 0);
  assert.equal(quits, 0);
  const installing = f.service.install();
  assert.equal(f.service.install(), installing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.getState().phase, 'preparing');
  assert.equal(authorizations, 0);
  flush.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authorizations, 0, 'flushing the renderer must not skip an accepted main-process write');
  write.resolve(); await pendingWrite;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['flushed renderer', 'saved comment', 'native authorization']);
  assert.equal(authorizations, 1);
  assert.equal(quits, 0, 'waiting for administrator credentials must not quit the app');
  assert.equal(f.service.getState().phase, 'installing');
  await assert.rejects(gate.run('comment-update', () => {}), /preparing/);
  native.emit('update-downloaded');
  assert.equal((await installing).phase, 'installing');
  assert.equal(quits, 1);
  f.service.dispose();
});
for (const [name, code, expectedMessage] of [
  ['canceled authorization', -60006, /authorization was cancelled/i],
  ['denied authorization', -60005, /administrator account/i],
  ['authorization interaction unavailable', -60007, /administrator account/i],
] as const) test(`${name} restores editing and can retry the cached update`, async () => {
  const error = Object.assign(new Error('The operation could not be completed.'), { code, domain: 'NSOSStatusErrorDomain' });
  const gate = new InstallGate(), native = new EventEmitter();
  let authorizations = 0, quits = 0, releases = 0;
  const f = fixture({
    prepare: () => gate.prepare(async () => {}),
    install: () => installMacUpdate(native, () => {
      authorizations++;
      native.once('update-downloaded', () => { quits++; });
    }),
    release: () => { releases++; gate.reset(); },
  });
  await f.service.check(); await f.service.download();
  const installing = f.service.install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authorizations, 1);
  native.emit('error', error);
  const failed = await installing;
  assert.equal(failed.phase, 'downloaded');
  assert.equal(failed.error?.action, 'install');
  assert.match(failed.error!.message, expectedMessage);
  assert.doesNotMatch(failed.error!.message, /Applications|writable installation/i);
  assert.equal(failed.availableVersion, f.updater.version);
  assert.equal(failed.progress, 100);
  assert.equal(releases, 1);
  await gate.run('comment-update', () => {});
  assert.equal(native.listenerCount('update-downloaded'), 0);
  native.emit('update-downloaded');
  assert.equal(quits, 0, 'late completion of a canceled authorization must not restart the restored workspace');
  const retry = f.service.install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authorizations, 2);
  assert.equal(f.updater.downloads, 1, 'the already downloaded update remains reusable');
  native.emit('update-downloaded');
  assert.equal((await retry).phase, 'installing');
  assert.equal(quits, 1);
  assert.equal(releases, 1);
  f.service.dispose();
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
test('a native failure after update readiness releases editing instead of leaving installation stuck', async () => {
  const gate = new InstallGate();
  let quits = 0, releases = 0;
  const native = Object.assign(new EventEmitter(), {
    checkForUpdates() {},
    quitAndInstall() { quits++; },
  });
  const f = fixture({
    prepare: () => gate.prepare(async () => {}),
    install: createMacUpdateInstaller(native, async () => {}),
    release: () => { releases++; gate.reset(); },
  });
  await f.service.check(); await f.service.download();
  const installing = f.service.install();
  await new Promise(resolve => setImmediate(resolve));
  native.emit('update-downloaded');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(f.service.getState().phase, 'installing');
  await assert.rejects(gate.run('comment-update', () => {}), /preparing/);
  native.emit('error', Object.assign(new Error('Relaunch request denied'), { code: -60005, domain: 'NSOSStatusErrorDomain' }));
  const state = await installing;
  assert.equal(state.phase, 'downloaded');
  assert.equal(state.availableVersion, f.updater.version);
  assert.match(state.error!.message, /administrator account/i);
  assert.equal(releases, 1);
  await gate.run('comment-update', () => {});
  f.service.dispose();
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
test('normal close drains all accepted IPC writes, permits only flushing comments, and recovers from cancellation', async () => {
  const gate = new InstallGate('close');
  const connection = deferred();
  const flush = deferred();
  const order: string[] = [];
  const save = gate.run('connection-save', async () => { await connection.promise; order.push('connection'); });
  const closing = gate.prepare(async () => { await gate.run('comment-update', async () => { await flush.promise; order.push('comment'); }); });
  await assert.rejects(gate.run('pullrequests-action', () => {}), /preparing to close/);
  flush.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['comment']);
  connection.resolve();
  await save; await closing;
  assert.deepEqual(order, ['comment', 'connection']);
  await assert.rejects(gate.run('comment-update', () => {}), /preparing to close/);
  gate.reset();
  const acknowledgement = deferred();
  await assert.rejects(gate.prepare(() => acknowledgement.promise, 10), /try closing again/);
  acknowledgement.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await gate.run('feedback-publish', () => {});
});
test('only the current window, main frame and exact URL can invoke the bridge', () => {
  const mainFrame = {}; const contents = { mainFrame }; const url = 'file:///app/index.html';
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, contents, url, url), true);
  assert.equal(isTrustedReviewSender({ sender: {}, senderFrame: mainFrame }, contents, url, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: {} }, contents, url, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, contents, `${url}?evil`, url), false);
  assert.equal(isTrustedReviewSender({ sender: contents, senderFrame: mainFrame }, null, url, url), false);
});
test('mounted images, translocated apps and invalid bundle paths explain how to recover', async () => {
  for (const path of ['/Volumes/Branchline/Branchline.app/Contents/MacOS/Branchline', '/private/var/AppTranslocation/x/Branchline.app/Contents/MacOS/Branchline', '/usr/local/bin/Branchline']) {
    await assert.rejects(validateInstallLocation(path), /Applications/);
  }
});
test('protected Applications and per-user installations can reach the native authorization flow', async () => {
  await assert.doesNotReject(validateInstallLocation('/Applications/Branchline.app/Contents/MacOS/Branchline'));
  await assert.doesNotReject(validateInstallLocation('/Users/reviewer/Applications/Branchline.app/Contents/MacOS/Branchline'));
});
