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
  const editor = page.getByRole('textbox', { name: 'Comment text', exact: true });
  await mkdir(join(dataDir, 'reviews.json.tmp'));
  await editor.fill('Keep this feedback when saving fails.');
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
  const finalFeedback = 'The final keystrokes must survive the update.';
  await editor.fill(finalFeedback);
  const appClosed = desktop.waitForEvent('close');
  await page.evaluate(() => {
    void window.reviewAPI.getState().then(state => {
      void window.reviewAPI.updateProject(state.projects[0].id, { name: 'Saved during update' });
      void window.reviewAPI.installUpdate();
    });
  });
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
  console.log('Update desktop smoke passed: UI, retries, postponement, window recreation, save failure and safe restart.');
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
