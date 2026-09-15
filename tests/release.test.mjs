import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { load } from 'js-yaml';
import { createMacUpdateInstaller, installMacUpdate } from '../electron/mac-install.ts';
import { validateReleaseVersion, verifyUpdateMetadata } from '../scripts/release-utils.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('native authorization retry refreshes the feed before staging, even with a stale MacUpdater ready flag', async () => {
  const { MacUpdater } = createRequire(import.meta.url)('electron-updater');
  const updater = Object.create(MacUpdater.prototype), native = new EventEmitter();
  const refreshed = deferred(), order = [];
  let quits = 0, checks = 0, refreshes = 0;
  native.checkForUpdates = () => { checks++; order.push('native check'); };
  native.quitAndInstall = () => { quits++; order.push('native quit'); };
  updater.squirrelDownloadedUpdate = false;
  const permanent = () => { updater.squirrelDownloadedUpdate = true; };
  native.on('update-downloaded', permanent);
  const install = createMacUpdateInstaller(native, async () => {
    refreshes++; order.push('refresh feed'); await refreshed.promise; order.push('feed ready');
  });
  assert.equal(checks, 0); assert.equal(quits, 0);
  const first = install();
  assert.equal(install(), first, 'repeated install actions share the active attempt');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['native check']);
  assert.equal(refreshes, 0, 'the initial download has already configured the native feed');
  const cancelled = Object.assign(new Error('The operation could not be completed.'), { code: -60006, domain: 'NSOSStatusErrorDomain' });
  native.emit('error', cancelled);
  await assert.rejects(first, error => error === cancelled);
  assert.deepEqual(native.listeners('update-downloaded'), [permanent]);
  native.emit('update-downloaded');
  assert.equal(updater.squirrelDownloadedUpdate, true);
  assert.equal(quits, 0, 'late completion after cancellation must leave the app open');
  const retry = install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  assert.equal(checks, 1, 'retry must wait for the replacement native feed');
  assert.equal(quits, 0);
  native.emit('update-downloaded');
  assert.equal(quits, 0, 'a stale ready event during feed replacement cannot quit the app');
  refreshed.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2, 'a stale MacUpdater ready flag cannot skip native staging for the fresh feed');
  assert.equal(quits, 0);
  assert.deepEqual(order, ['native check', 'refresh feed', 'feed ready', 'native check']);
  native.emit('update-downloaded');
  native.emit('update-downloaded');
  assert.equal(quits, 1);
  assert.deepEqual(native.listeners('update-downloaded'), [permanent]);
  assert.deepEqual(order, ['native check', 'refresh feed', 'feed ready', 'native check', 'native quit']);
  native.emit('error', new Error('Native quit did not complete'));
  await assert.rejects(retry, /Native quit did not complete/);
});

test('a failed native feed refresh does not quit or suppress the next retry refresh', async () => {
  const native = new EventEmitter(), refreshed = deferred();
  let checks = 0, quits = 0, refreshes = 0, failRefresh = true;
  native.checkForUpdates = () => { checks++; };
  native.quitAndInstall = () => { quits++; };
  const install = createMacUpdateInstaller(native, async () => {
    refreshes++;
    if (failRefresh) throw new Error('Cached feed unavailable');
    await refreshed.promise;
  });
  const first = install();
  await new Promise(resolve => setImmediate(resolve));
  native.emit('error', Object.assign(new Error('Authorization denied'), { code: -60005, domain: 'NSOSStatusErrorDomain' }));
  await assert.rejects(first, /Authorization denied/);
  await assert.rejects(install(), /Cached feed unavailable/);
  assert.equal(checks, 1); assert.equal(refreshes, 1); assert.equal(quits, 0);
  assert.equal(native.listenerCount('update-downloaded'), 0);
  failRefresh = false;
  const retry = install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 2);
  assert.equal(checks, 1); assert.equal(quits, 0);
  refreshed.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  native.emit('update-downloaded');
  native.emit('update-downloaded');
  assert.equal(quits, 1);
  assert.equal(native.listenerCount('update-downloaded'), 0);
  native.emit('error', new Error('Native quit did not complete'));
  await assert.rejects(retry, /Native quit did not complete/);
});

for (const timing of ['before await', 'after await'])
test(`a native error ${timing} during feed refresh cannot resume staging when the feed later settles`, async () => {
  const native = new EventEmitter(), refreshing = deferred(), finishRefresh = deferred();
  let checks = 0, quits = 0, failed = false;
  const permanentError = () => {};
  native.on('error', permanentError); // electron-updater also observes native errors.
  native.checkForUpdates = () => { checks++; };
  native.quitAndInstall = () => { quits++; };
  const failure = Object.assign(new Error('Cached native feed rejected'), { code: -60005, domain: 'NSOSStatusErrorDomain' });
  const install = createMacUpdateInstaller(native, async () => {
    if (timing === 'before await') native.emit('error', failure);
    await refreshing.promise;
    if (timing === 'after await') native.emit('error', failure);
    await finishRefresh.promise;
  });
  const first = install();
  await new Promise(resolve => setImmediate(resolve));
  native.emit('error', new Error('Initial authorization canceled'));
  await assert.rejects(first, /Initial authorization canceled/);
  const retry = install();
  const rejection = assert.rejects(retry, error => error === failure).then(() => { failed = true; });
  await new Promise(resolve => setImmediate(resolve));
  if (timing === 'after await') refreshing.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed, true, 'a native feed error must restore editing without waiting for stalled feed work');
  assert.equal(checks, 1); assert.equal(quits, 0);
  refreshing.resolve(); finishRefresh.resolve();
  await rejection;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1, 'finishing an already failed feed reset cannot start native staging');
  native.emit('update-downloaded');
  assert.equal(quits, 0);
  assert.deepEqual(native.listeners('error'), [permanentError]);
  assert.equal(native.listenerCount('update-downloaded'), 0);
});

for (const mode of ['throw', 'emit', 'async error'])
test(`native quit ${mode} rejects the installation and duplicate ready events never quit twice`, async () => {
  const native = new EventEmitter();
  const failure = new Error('Native quit was refused');
  const permanentError = () => {};
  let quits = 0, settled = false;
  native.on('error', permanentError);
  native.checkForUpdates = () => {};
  native.quitAndInstall = () => {
    quits++;
    if (mode === 'throw') throw failure;
    if (mode === 'emit') native.emit('error', failure);
  };
  const installing = createMacUpdateInstaller(native, async () => {})();
  const rejected = assert.rejects(installing, error => error === failure).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => native.emit('update-downloaded'));
  native.emit('update-downloaded');
  assert.equal(quits, 1);
  if (mode === 'async error') {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'a handoff to native quit stays observed until exit or error');
    assert.equal(native.listenerCount('error'), 2);
    native.emit('error', failure);
  }
  await rejected;
  assert.deepEqual(native.listeners('error'), [permanentError]);
  assert.equal(native.listenerCount('update-downloaded'), 0);
});

test('retry drains a still-running failed feed refresh before replacing the feed again', async () => {
  const native = new EventEmitter(), finishOldRefresh = deferred();
  let checks = 0, quits = 0, refreshes = 0;
  native.checkForUpdates = () => { checks++; };
  native.quitAndInstall = () => { quits++; };
  const install = createMacUpdateInstaller(native, async () => {
    refreshes++;
    if (refreshes === 1) {
      native.emit('error', new Error('Old feed refresh failed'));
      await finishOldRefresh.promise;
    }
  });
  const first = install();
  await new Promise(resolve => setImmediate(resolve));
  native.emit('error', new Error('Initial staging failed'));
  await assert.rejects(first, /Initial staging failed/);
  await assert.rejects(install(), /Old feed refresh failed/);
  const retry = install();
  assert.equal(install(), retry);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1, 'the new feed cannot be installed while old work may still replace it');
  assert.equal(checks, 1); assert.equal(quits, 0);
  finishOldRefresh.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 2); assert.equal(checks, 2);
  native.emit('update-downloaded');
  assert.equal(quits, 1);
  native.emit('error', new Error('Quit handoff failed'));
  await assert.rejects(retry, /Quit handoff failed/);
});

test('native staging without an available update rejects instead of leaving installation pending', async () => {
  const native = Object.assign(new EventEmitter(), { checkForUpdates() {}, quitAndInstall() { assert.fail('no update may be installed'); } });
  const installing = createMacUpdateInstaller(native, async () => {})();
  await new Promise(resolve => setImmediate(resolve));
  native.emit('update-not-available');
  await assert.rejects(installing, /no longer available/);
  assert.equal(native.listenerCount('error'), 0);
  assert.equal(native.listenerCount('update-downloaded'), 0);
});

for (const failure of ['Signature rejected', 'Administrator authorization canceled (-60006)', 'Administrator authorization denied (-60005)'])
test(`the pinned MacUpdater cannot quit on late native completion after ${failure}`, async () => {
  const { MacUpdater } = createRequire(import.meta.url)('electron-updater');
  // Exercise the installed library's methods without launching Electron or an installer.
  const updater = Object.create(MacUpdater.prototype);
  const native = new EventEmitter();
  let quits = 0;
  native.checkForUpdates = () => {};
  native.quitAndInstall = () => { quits++; };
  Object.assign(updater, { nativeUpdater: native, squirrelDownloadedUpdate: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, _logger: { debug() {} } });
  const permanent = () => { updater.squirrelDownloadedUpdate = true; };
  native.on('update-downloaded', permanent);
  const first = installMacUpdate(native, () => updater.quitAndInstall());
  native.emit('error', new Error(failure));
  await assert.rejects(first, error => error.message === failure);
  assert.deepEqual(native.listeners('update-downloaded'), [permanent]);
  native.emit('update-downloaded'); assert.equal(quits, 0);
  await installMacUpdate(native, () => updater.quitAndInstall());
  assert.equal(quits, 1);
  assert.deepEqual(native.listeners('update-downloaded'), [permanent]);
});
test('native staging succeeds once and synchronous failures clean up attempt listeners', async () => {
  const { MacUpdater } = createRequire(import.meta.url)('electron-updater');
  const updater = Object.create(MacUpdater.prototype), native = new EventEmitter();
  let quits = 0;
  native.checkForUpdates = () => {}; native.quitAndInstall = () => { quits++; };
  Object.assign(updater, { nativeUpdater: native, squirrelDownloadedUpdate: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, _logger: { debug() {} } });
  const first = installMacUpdate(native, () => updater.quitAndInstall());
  native.emit('update-downloaded'); await first; assert.equal(quits, 1);
  native.emit('update-downloaded'); assert.equal(quits, 1);
  native.checkForUpdates = () => { native.emit('error', new Error('Staging unavailable')); };
  await assert.rejects(installMacUpdate(native, () => updater.quitAndInstall()), /Staging unavailable/);
  assert.equal(native.listenerCount('update-downloaded'), 0);
});
test('release tags must be stable and match both manifests', () => {
  const pkg = { version: '0.10.0' }, lock = { version: '0.10.0', packages: { '': pkg } };
  validateReleaseVersion('v0.10.0', pkg, lock);
  for (const tag of ['v0.10.0-beta.1', 'v0.11.0', '0.10.0', 'v01.2.3']) assert.throws(() => validateReleaseVersion(tag, pkg, lock));
});
test('release metadata must include intact universal DMG and ZIP files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'branchline-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = Buffer.from('signed artifact fixture');
  const files = ['dmg', 'zip'].map(ext => ({ url: `Branchline-0.10.0-universal.${ext}`, size: content.length, sha512: createHash('sha512').update(content).digest('base64') }));
  for (const file of files) await writeFile(join(directory, file.url), content);
  await verifyUpdateMetadata({ version: '0.10.0', files }, directory, '0.10.0');
  await assert.rejects(verifyUpdateMetadata({ version: '0.10.0', files: [files[0]] }, directory, '0.10.0'), /both/);
  await assert.rejects(verifyUpdateMetadata({ version: '0.10.0', files: [{ ...files[0], url: '../escape' }] }, directory, '0.10.0'), /Unexpected/);
  await writeFile(join(directory, files[1].url), 'corrupted');
  await assert.rejects(verifyUpdateMetadata({ version: '0.10.0', files }, directory, '0.10.0'), /SHA-512/);
});
test('release workflow parses and runs verification before draft upload', async () => {
  const workflow = load(await readFile('.github/workflows/release.yml', 'utf8'));
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  const steps = workflow.jobs.release.steps;
  assert.ok(steps.findIndex(s => s.run === 'npm run release:verify') < steps.findIndex(s => s.run === 'node scripts/release-draft.mjs'));
  const build = steps.find(s => s.run?.includes('electron-builder'));
  assert.match(build.run, /--publish never/); assert.match(build.run, /forceCodeSigning=true/);
});
