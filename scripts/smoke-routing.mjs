import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-routing-'));
const dataDir = join(fixture, 'data');
const firstRepo = join(fixture, 'first-project');
const secondRepo = join(fixture, 'second-project');
const featureBranch = 'feature/routing';
const firstProjectName = 'Routing first project';
const secondProjectName = 'Routing second project';
const savedReviewName = 'Saved routing review';
const firstFeedback = 'This feedback must be durable before opening Settings.';
const failedFeedback = 'Keep this draft on the original review when navigation fails.';
const storageError = 'Routing smoke: storage unavailable';
const errors = [];
let desktop;

function git(repo, ...args) {
  return execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

async function createRepo(repo) {
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  for (const file of ['a-first.ts', 'z-next.ts']) {
    await writeFile(join(repo, file), 'export function calculate() {\n  const value = 0;\n  return value;\n}\n');
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial files');
  git(repo, 'checkout', '-b', featureBranch);
  for (const file of ['a-first.ts', 'z-next.ts']) {
    await writeFile(join(repo, file), 'export function calculate() {\n  const value = 1;\n  return value;\n}\n');
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Changes to review');
}

async function until(read, predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const readState = page => page.evaluate(() => window.reviewAPI.getState());
const selectedReview = page => page.getByRole('combobox', { name: 'Select review', exact: true });
const settingsView = page => page.getByRole('region', { name: 'Settings', exact: true });
const controls = () => desktop.evaluate(() => ({
  held: globalThis.routingSmoke.held,
  heldSettings: globalThis.routingSmoke.heldSettings,
  writes: globalThis.routingSmoke.writes,
  failures: globalThis.routingSmoke.failures,
}));

async function waitForReview(page, projectName, reviewId) {
  await page.waitForFunction(({ projectName, reviewId }) => {
    const project = document.querySelector(`[role="tab"][aria-label="${projectName}"]`);
    const review = document.querySelector('[aria-label="Select review"]');
    return project?.getAttribute('aria-selected') === 'true' && review?.getAttribute('data-value') === reviewId;
  }, { projectName, reviewId });
  await page.locator('.review-diff-viewer').waitFor();
}

async function activateWithKeyboard(locator) {
  await locator.focus();
  await locator.press('Enter');
}

async function chooseReview(page, name) {
  await selectedReview(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function waitForSection(page, name) {
  const section = settingsView(page).getByRole('tab', { name, exact: true });
  await section.waitFor();
  await until(() => section.getAttribute('aria-selected'), value => value === 'true', `${name} Settings section`);
}

async function comment(page, body) {
  await page.locator('[data-column-number="2"][data-line-type="change-addition"]').first().click();
  const editor = page.getByRole('textbox', { name: 'Comment text', exact: true });
  await editor.fill(body);
  return editor;
}

async function assertTrustedDocument(page, expectedURL, projectCount = 2) {
  assert.equal(page.url(), expectedURL, 'Memory navigation must not change the trusted renderer document URL.');
  assert.equal((await readState(page)).projects.length, projectCount, 'The real preload IPC remains trusted after navigation.');
}

try {
  await Promise.all([createRepo(firstRepo), createRepo(secondRepo)]);
  const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BRANCHLINE_DEV_URL;
  desktop = await electron.launch({
    executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable,
    args: [resolve('.')], env, timeout: 30000,
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('button', { name: 'Add your first project', exact: true }).waitFor();
  const documentURL = page.url();
  assert.equal(new URL(documentURL).protocol, 'file:', 'Exercise the production file renderer, rather than a development server.');

  const setup = await page.evaluate(async input => {
    const first = await window.reviewAPI.createProject({ repoPath: input.firstRepo, name: input.firstProjectName });
    const second = await window.reviewAPI.createProject({ repoPath: input.secondRepo, name: input.secondProjectName });
    await window.reviewAPI.setCurrentTarget(first.id, 'main');
    await window.reviewAPI.setCurrentTarget(second.id, 'main');
    const saved = await window.reviewAPI.createReview({
      projectId: first.id, baseBranch: 'main', featureBranch: input.featureBranch,
      name: input.savedReviewName, includeWorkingTree: false,
    });
    localStorage.setItem('branchline.selectedProject', first.id);
    return { firstId: first.id, secondId: second.id, savedId: saved.id };
  }, { firstRepo, secondRepo, firstProjectName, secondProjectName, featureBranch, savedReviewName });
  const firstCurrent = `current:${setup.firstId}`;
  const secondCurrent = `current:${setup.secondId}`;
  await page.reload();
  await waitForReview(page, firstProjectName, firstCurrent);

  // Hold/fail only actual comment writes in main. Normal calls still execute the
  // production trust check, service and durable store through the real preload.
  await desktop.evaluate(({ ipcMain }, storageError) => {
    const state = globalThis.routingSmoke = {
      writes: 0, failures: 0, held: false, holdNextSave: false, failSaves: false, release: null,
      heldSettings: false, holdNextSettings: false, releaseSettings: null,
    };
    for (const channel of ['review:comment-add', 'review:comment-update']) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain._invokeHandlers.set(channel, async (...args) => {
        state.writes++;
        if (state.failSaves) {
          state.failures++;
          throw new Error(storageError);
        }
        if (state.holdNextSave) {
          state.holdNextSave = false;
          state.held = true;
          await new Promise(resolve => { state.release = resolve; });
          state.held = false;
          state.release = null;
        }
        return original(...args);
      });
    }
    const settingsHandler = ipcMain._invokeHandlers.get('review:settings-update');
    ipcMain._invokeHandlers.set('review:settings-update', async (...args) => {
      if (state.holdNextSettings) {
        state.holdNextSettings = false;
        state.heldSettings = true;
        await new Promise(resolve => { state.releaseSettings = resolve; });
        state.heldSettings = false;
        state.releaseSettings = null;
      }
      return settingsHandler(...args);
    });
  }, storageError);

  await chooseReview(page, savedReviewName);
  await waitForReview(page, firstProjectName, setup.savedId);
  await page.getByRole('tab', { name: secondProjectName, exact: true }).click();
  await waitForReview(page, secondProjectName, secondCurrent);
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForReview(page, firstProjectName, setup.savedId);
  await page.keyboard.press('Alt+ArrowRight');
  await waitForReview(page, secondProjectName, secondCurrent);
  await page.keyboard.press('Meta+[');
  await waitForReview(page, firstProjectName, setup.savedId);
  await assertTrustedDocument(page, documentURL);

  await page.locator('[data-item-path="z-next.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'z-next.ts' }).waitFor();
  const viewerNode = await page.locator('.review-diff-viewer').elementHandle();
  await desktop.evaluate(() => { globalThis.routingSmoke.holdNextSave = true; });
  const editor = await comment(page, firstFeedback);
  const editorNode = await editor.elementHandle();
  // Keyboard activation avoids the editor's intentional outside-click close.
  await activateWithKeyboard(page.getByRole('button', { name: 'App settings', exact: true }));
  await until(controls, state => state.held, 'comment persistence to be held during navigation');
  assert.equal(await settingsView(page).isVisible(), false, 'Settings must wait for the pending comment write.');
  assert.equal(await selectedReview(page).getAttribute('data-value'), setup.savedId);
  assert.equal((await readState(page)).reviews.find(review => review.id === setup.savedId).comments.length, 0);
  await desktop.evaluate(() => globalThis.routingSmoke.release());
  await waitForSection(page, 'Appearance');
  const durable = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  assert.ok(durable.reviews.find(review => review.id === setup.savedId).comments.some(item => item.body === firstFeedback), 'The comment must be on disk before Settings opens.');
  assert.equal(await viewerNode.evaluate(node => node.isConnected), true, 'Settings keeps the existing diff mounted.');
  assert.equal(await editorNode.evaluate(node => node.isConnected), true, 'Settings keeps the existing comment editor mounted.');

  await activateWithKeyboard(settingsView(page).getByRole('tab', { name: 'Jira', exact: true }));
  await waitForSection(page, 'Jira');
  await activateWithKeyboard(settingsView(page).getByRole('tab', { name: 'Bitbucket', exact: true }));
  await waitForSection(page, 'Bitbucket');
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForSection(page, 'Jira');
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForSection(page, 'Appearance');
  await page.keyboard.press('Alt+ArrowRight');
  await waitForSection(page, 'Jira');
  await page.keyboard.press('Meta+]');
  await waitForSection(page, 'Bitbucket');
  await assertTrustedDocument(page, documentURL);
  await activateWithKeyboard(settingsView(page).getByRole('button', { name: 'Back to review', exact: true }));
  await waitForReview(page, firstProjectName, setup.savedId);
  await page.locator('.diff-file-name').filter({ hasText: 'z-next.ts' }).waitFor();
  assert.equal(await viewerNode.evaluate(node => node === document.querySelector('.review-diff-viewer')), true, 'Returning from Settings preserves the same diff DOM.');
  assert.equal(await editorNode.evaluate(node => node.isConnected), true, 'Returning from Settings preserves the same editor DOM.');
  assert.equal(await editor.inputValue(), firstFeedback);

  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await waitForSection(page, 'Appearance');
  await desktop.evaluate(() => { globalThis.routingSmoke.holdNextSettings = true; });
  await settingsView(page).getByRole('radio', { name: /Light/ }).click();
  await until(controls, state => state.heldSettings, 'appearance preference persistence to be held');
  await page.keyboard.press('Alt+ArrowLeft');
  await delay(150);
  await waitForSection(page, 'Appearance');
  assert.equal((await readState(page)).settings.theme, 'system', 'The Settings write is still pending.');
  assert.equal(await settingsView(page).getByRole('button', { name: 'Back to review', exact: true }).isDisabled(), true);
  await desktop.evaluate(() => globalThis.routingSmoke.releaseSettings());
  await until(() => readState(page), state => state.settings.theme === 'light', 'appearance preference to be durable');
  const backToReview = settingsView(page).getByRole('button', { name: 'Back to review', exact: true });
  await until(() => backToReview.isEnabled(), enabled => enabled, 'Settings save to finish');
  await waitForSection(page, 'Appearance');
  await backToReview.click();
  await waitForReview(page, firstProjectName, setup.savedId);

  // Create a real previous review entry, then refuse persistence. Both the
  // history shortcut and normal Settings navigation must leave the draft here.
  await chooseReview(page, 'Current');
  await waitForReview(page, firstProjectName, firstCurrent);
  await desktop.evaluate(() => { globalThis.routingSmoke.failSaves = true; });
  const failingEditor = await comment(page, failedFeedback);
  const beforeBack = (await controls()).failures;
  await page.keyboard.press('Alt+ArrowLeft');
  await until(controls, state => state.failures > beforeBack, 'history navigation to attempt the pending comment save');
  await page.getByText(new RegExp(storageError)).first().waitFor();
  assert.equal(await selectedReview(page).getAttribute('data-value'), firstCurrent, 'A failed comment save must block history navigation.');
  assert.equal(await failingEditor.inputValue(), failedFeedback);
  const beforeSettings = (await controls()).failures;
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await until(controls, state => state.failures > beforeSettings, 'Settings navigation to retry the pending comment save');
  assert.equal(await settingsView(page).isVisible(), false, 'A failed comment save must block Settings navigation.');
  assert.equal(await selectedReview(page).getAttribute('data-value'), firstCurrent);
  assert.equal(await failingEditor.inputValue(), failedFeedback);
  assert.equal((await readState(page)).reviews.find(review => review.id === firstCurrent).comments.length, 0);

  await desktop.evaluate(() => { globalThis.routingSmoke.failSaves = false; });
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForReview(page, firstProjectName, setup.savedId);
  const finalState = await readState(page);
  assert.ok(finalState.reviews.find(review => review.id === firstCurrent).comments.some(item => item.body === failedFeedback), 'Retrying navigation saves the draft on the original review.');
  assert.equal(finalState.reviews.find(review => review.id === setup.savedId).comments.some(item => item.body === failedFeedback), false, 'Navigation must never transfer a draft to another review.');
  await assertTrustedDocument(page, documentURL);
  // Keep an earlier saved-review entry in history, then remove the review via
  // the UI. Settings and the missing review must both fall back safely.
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await waitForSection(page, 'Appearance');
  await settingsView(page).getByRole('button', { name: 'Back to review', exact: true }).click();
  await waitForReview(page, firstProjectName, setup.savedId);
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete this review', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete review', exact: true }).click();
  await waitForReview(page, firstProjectName, firstCurrent);
  assert.equal((await readState(page)).reviews.some(review => review.id === setup.savedId), false);
  for (let attempts = 0; attempts < 3 && !await settingsView(page).isVisible(); attempts++) {
    await page.keyboard.press('Alt+ArrowLeft');
    await delay(150);
    if (!await settingsView(page).isVisible()) await waitForReview(page, firstProjectName, firstCurrent);
  }
  await waitForSection(page, 'Appearance');
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForReview(page, firstProjectName, firstCurrent);

  await page.getByRole('tab', { name: secondProjectName, exact: true }).click();
  await waitForReview(page, secondProjectName, secondCurrent);
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await waitForSection(page, 'Appearance');
  await settingsView(page).getByRole('button', { name: 'Back to review', exact: true }).click();
  await waitForReview(page, secondProjectName, secondCurrent);
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove project', exact: true }).click();
  await waitForReview(page, firstProjectName, firstCurrent);
  assert.equal((await readState(page)).projects.some(project => project.id === setup.secondId), false);
  // Removal may replace the active route or add its fallback. Traverse either
  // shape until the known Settings entry retaining the removed project appears.
  for (let attempts = 0; attempts < 3 && !await settingsView(page).isVisible(); attempts++) {
    await page.keyboard.press('Alt+ArrowLeft');
    await delay(150);
  }
  await waitForSection(page, 'Appearance');
  await page.keyboard.press('Alt+ArrowLeft');
  await waitForReview(page, firstProjectName, firstCurrent);
  await assertTrustedDocument(page, documentURL, 1);
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);
  console.log('Routing desktop passed: Current/saved/project history, Settings section history and return, retained diff/editor DOM, durable comments before navigation, failed-save blocking and retry, pending Settings-save blocking, deleted-review/project history fallbacks, and unchanged trusted file URL.');
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/routing-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(0, 12000));
    console.error('Renderer errors:', errors);
  }
  throw error;
} finally {
  if (desktop) {
    await desktop.evaluate(() => {
      if (!globalThis.routingSmoke) return;
      globalThis.routingSmoke.failSaves = false;
      globalThis.routingSmoke.release?.();
      globalThis.routingSmoke.releaseSettings?.();
    }).catch(() => {});
  }
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
