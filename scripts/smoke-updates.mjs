import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-updates-'));
const repo = join(fixture, 'repo'), dataDir = join(fixture, 'data');
await mkdir(repo); await mkdir('artifacts', { recursive: true });
const git = (...args) => execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], {
  cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
git('init', '-b', 'main'); await writeFile(join(repo, 'example.ts'), 'export const answer = 1;\n');
git('add', '.'); git('commit', '-m', 'Initial'); git('checkout', '-b', 'feature/update');
await writeFile(join(repo, 'example.ts'), 'export const answer = 2;\n');
const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir, BRANCHLINE_UPDATE_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
const errors = [];
let desktop, page;
async function launch(test = true) {
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [resolve('.')], env: { ...env, BRANCHLINE_UPDATE_TEST: test ? '1' : '0' } });
  page = await desktop.firstWindow(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Updates', exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(window.reviewAPI));
}
const state = () => page.evaluate(() => window.reviewAPI.getUpdateState());
const phase = value => page.waitForFunction(expected => window.reviewAPI.getUpdateState().then(state => state.phase === expected), value);

try {
  await launch();
  console.log('Update test app opened.');
  await desktop.evaluate(({ app, Menu }) => {
    app.branchlineUpdateTest.failCheckOnce = true;
    Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Check for Updates…').click();
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Retry check', exact: true }).waitFor();
  await page.evaluate(() => {
    window.updateEventCounts = { kept: 0, removed: 0 };
    window.stopUpdateEvents = window.reviewAPI.onUpdateStateChanged(() => window.updateEventCounts.kept++);
    window.reviewAPI.onUpdateStateChanged(() => window.updateEventCounts.removed++)();
  });
  await page.getByRole('button', { name: 'Retry check', exact: true }).click();
  await phase('available');
  console.log('Manual check and error retry verified.');
  const counts = await page.evaluate(() => { window.stopUpdateEvents(); return window.updateEventCounts; });
  assert.ok(counts.kept >= 2); assert.equal(counts.removed, 0);
  await page.getByRole('button', { name: 'Download update', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/update-available.png', animations: 'disabled' });
  await desktop.evaluate(({ app }) => { app.branchlineUpdateTest.failDownloadOnce = true; });
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await page.getByRole('progressbar', { name: 'Update download progress' }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await phase('available');
  await page.getByRole('button', { name: 'Update available', exact: true }).click();
  await page.getByRole('button', { name: 'Retry download', exact: true }).click();
  await phase('downloaded');
  console.log('Download progress and retry verified.');
  await page.getByRole('dialog').getByRole('button', { name: 'Restart to update', exact: true }).waitFor();
  await page.getByText('Restart to install. Your review work will be saved first. macOS may ask for an administrator password.', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/update-ready.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  const closed = page.waitForEvent('close');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.installs), 0, 'Ordinary close must not install.');
  const reopened = desktop.waitForEvent('window');
  await desktop.evaluate(({ app }) => app.emit('activate'));
  page = await reopened; page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Restart to update', exact: true }).waitFor();
  assert.equal((await state()).phase, 'downloaded');
  console.log('Postponement and window recreation verified.');

  await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
  await page.locator('#project-repo-path').fill(repo);
  await page.locator('#project-name').fill('Update test');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('combobox', { name: 'Current target branch', exact: true }).click();
  await page.getByRole('option', { name: 'main', exact: true }).click();
  await page.locator('[data-column-number="1"][data-line-type="change-addition"]').click();
  let editor = page.getByRole('textbox', { name: 'Comment text', exact: true });
  await mkdir(join(dataDir, 'reviews.json.tmp'));
  await editor.fill('Keep this feedback when saving fails.');
  await page.evaluate(() => {
    window.closeCancellations = [];
    window.stopCloseCancellations = window.reviewAPI.onCloseCancelled(message => window.closeCancellations.push(message));
  });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForFunction(() => window.closeCancellations.length === 1);
  assert.equal(page.isClosed(), false, 'A failed ordinary close must leave the review window open.');
  assert.equal(await editor.inputValue(), 'Keep this feedback when saving fails.');
  assert.equal(await page.locator('.app-shell').getAttribute('inert'), null, 'Cancelled close must restore editing.');
  await page.evaluate(() => window.stopCloseCancellations());
  const failed = await page.evaluate(() => window.reviewAPI.installUpdate());
  assert.equal(failed.phase, 'downloaded'); assert.equal(failed.error.action, 'install');
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.installs), 0);
  assert.equal(await editor.inputValue(), 'Keep this feedback when saving fails.');
  assert.equal(await page.locator('.app-shell').getAttribute('inert'), null);
  await rm(join(dataDir, 'reviews.json.tmp'), { recursive: true });

  await desktop.evaluate(({ app }) => { app.branchlineUpdateTest.failInstallOnce = true; });
  await editor.fill('Saved before native staging starts.');
  assert.equal((await page.evaluate(() => window.reviewAPI.installUpdate())).phase, 'downloaded');
  let saved = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(saved.reviews[0].comments[0].body, 'Saved before native staging starts.');

  const feedbackBeforeWindowClose = 'Keep this saved feedback when installation fails after closing the window.';
  await editor.fill(feedbackBeforeWindowClose);
  await desktop.evaluate(({ app, BrowserWindow }) => {
    const driver = app.branchlineUpdateTest;
    const originalInstall = driver.install;
    driver.install = async function () {
      driver.install = originalInstall;
      const reviewWindow = BrowserWindow.getAllWindows()[0];
      await new Promise(resolve => { reviewWindow.once('closed', resolve); reviewWindow.close(); });
      throw new Error('Native installation failed after closing the review window.');
    };
  });
  const failedInstallWindow = page;
  const restoredWindow = desktop.waitForEvent('window');
  await page.evaluate(() => { void window.reviewAPI.installUpdate(); });
  page = await restoredWindow; page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Restart to update', exact: true }).waitFor();
  assert.equal(failedInstallWindow.isClosed(), true, 'The simulated native failure must occur after the original window closes.');
  assert.equal((await state()).phase, 'downloaded');
  assert.equal((await state()).error.action, 'install');
  assert.equal((await state()).availableVersion, '99.0.0');
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.installs), 0);
  assert.equal(await page.locator('.app-shell').getAttribute('inert'), null, 'A failed native restart must restore an editable window.');
  saved = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(saved.reviews[0].comments[0].body, feedbackBeforeWindowClose);
  await page.locator('.review-comment').waitFor();
  editor = page.getByRole('textbox', { name: 'Comment text', exact: true });
  if (!await editor.isVisible()) await page.getByRole('button', { name: 'Edit comment', exact: true }).click();
  assert.equal(await editor.inputValue(), feedbackBeforeWindowClose);
  assert.equal(await editor.isEditable(), true);
  console.log('A native install failure after window close restores the saved, editable workspace and cached update.');

  const downloadsBeforeAuthorization = await desktop.evaluate(({ app }) => {
    app.branchlineUpdateTest.pauseForAuthorization = true;
    return app.branchlineUpdateTest.downloads;
  });
  const authorizationFeedback = 'Save these pending keystrokes before asking for administrator approval.';
  await editor.fill(authorizationFeedback);
  await page.evaluate(() => {
    void window.reviewAPI.getState().then(state => {
      void window.reviewAPI.updateProject(state.projects[0].id, { name: 'Saved during update' });
      void window.reviewAPI.installUpdate();
    });
  });
  await phase('installing');
  await page.getByText('Your review work is saved. If macOS asks for an administrator password, use the system prompt to continue.', { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.authorizationPending), true);
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.installs), 0);
  assert.equal(page.isClosed(), false, 'The app must stay open until administrator authorization finishes.');
  assert.notEqual(await page.locator('.app-shell').getAttribute('inert'), null, 'The saved workspace stays locked during authorization.');
  saved = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(saved.reviews[0].comments[0].body, authorizationFeedback, 'Pending feedback must reach disk before authorization.');
  assert.equal(saved.projects[0].name, 'Saved during update');
  await page.screenshot({ path: 'artifacts/update-authorization.png', animations: 'disabled' });
  await desktop.evaluate(({ app }) => app.branchlineUpdateTest.resolveAuthorization('cancel'));
  await phase('downloaded');
  const cancelled = await state();
  assert.equal(cancelled.error.action, 'install');
  assert.match(cancelled.error.message, /cancelled/i);
  assert.equal(cancelled.availableVersion, '99.0.0');
  assert.equal(cancelled.progress, 100);
  assert.equal(page.isClosed(), false);
  assert.equal(await page.locator('.app-shell').getAttribute('inert'), null, 'Cancelling authorization must restore editing.');
  assert.equal(await editor.inputValue(), authorizationFeedback);
  console.log('Administrator authorization waits until work is saved; cancellation preserves the download and restores editing.');

  const finalFeedback = 'The final keystrokes must survive the update.';
  await editor.fill(finalFeedback);
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Retry update', exact: true }).click();
  await phase('installing');
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.authorizationPending), true);
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.authorizationRequests), 2);
  assert.equal(await desktop.evaluate(({ app }) => app.branchlineUpdateTest.downloads), downloadsBeforeAuthorization, 'Retrying authorization must reuse the downloaded update.');
  saved = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(saved.reviews[0].comments[0].body, finalFeedback);
  const appClosed = desktop.waitForEvent('close');
  await desktop.evaluate(({ app }) => app.branchlineUpdateTest.resolveAuthorization('allow'));
  await appClosed; desktop = undefined;
  saved = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.equal(saved.reviews[0].comments[0].body, finalFeedback);
  assert.equal(saved.projects[0].name, 'Saved during update');
  console.log('Pending comments and concurrent project writes survived restart.');

  await launch(false);
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByText(/Development builds do not check/).waitFor();
  assert.equal((await state()).phase, 'disabled');
  const persisted = await page.evaluate(() => window.reviewAPI.getState());
  assert.equal(persisted.reviews[0].comments[0].body, finalFeedback);
  assert.deepEqual(errors, []);
  console.log('Update desktop smoke passed: UI, retries, postponement, window recreation, save failure, administrator authorization cancellation and safe restart.');
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: 'artifacts/update-failure.png', timeout: 3000 }).catch(() => {});
  throw error;
} finally {
  if (desktop) {
    const kill = setTimeout(() => desktop?.process().kill('SIGKILL'), 5000);
    try { await desktop.close(); } finally { clearTimeout(kill); }
  }
  await rm(fixture, { recursive: true, force: true });
}
