import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { load } from 'js-yaml';
import { installMacUpdate } from '../electron/mac-install.ts';
import { validateReleaseVersion, verifyUpdateMetadata } from '../scripts/release-utils.mjs';

test('the pinned MacUpdater cannot quit on late native completion after a failed attempt', async () => {
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
  native.emit('error', new Error('Signature rejected'));
  await assert.rejects(first, /Signature rejected/);
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
