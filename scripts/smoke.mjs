import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

const executablePath = process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable;

const fixture = await mkdtemp(join(tmpdir(), 'branchline-desktop-'));
const repo = join(fixture, 'sample-monorepo');
const secondRepo = join(fixture, 'sample-service');
const actionsRepo = join(fixture, 'review-actions');
const dataDir = join(fixture, 'app-data');
await mkdir(join(repo, 'src'), { recursive: true });
function gitAt(directory, ...args) {
  return execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
const git = (...args) => gitAt(repo, ...args);
git('init', '-b', 'main');
await writeFile(join(repo, 'src/greeting.ts'), 'export function greet(name: string) {\n  return `Hello, ${name}`;\n}\n');
git('add', '.'); git('commit', '-m', 'Initial greeting'); git('checkout', '-b', 'feature/greeting');
await writeFile(join(repo, 'src/greeting.ts'), 'export function greet(name: string) {\n  const trimmed = name.trim();\n  return `Welcome, ${trimmed}!`;\n}\n');
git('add', '.'); git('commit', '-m', 'Improve greeting'); git('checkout', 'main');
await writeFile(join(repo, 'target-only.ts'), 'export const targetOnly = true;\n');
git('add', '.'); git('commit', '-m', 'Target-only work'); git('branch', 'release'); git('checkout', 'feature/greeting');
git('update-ref', 'refs/remotes/origin/v3.4.3', 'main');
await mkdir(join(repo, 'docs'), { recursive: true });
const notesContents = '# Greeting\n\nHandle blank names before shipping.\n';
await writeFile(join(repo, 'docs/notes.md'), notesContents);
await mkdir(secondRepo);
gitAt(secondRepo, 'init', '-b', 'main');
await writeFile(join(secondRepo, 'service.ts'), 'export const timeout = 1000;\n');
gitAt(secondRepo, 'add', '.'); gitAt(secondRepo, 'commit', '-m', 'Initial service');
gitAt(secondRepo, 'checkout', '-b', 'feature/service');
await writeFile(join(secondRepo, 'service.ts'), 'export const timeout = 3000;\n');
const actionPaths = ['a-root.ts', 'zeta/part1.ts', 'zeta/part2.ts', 'zeta/part10.ts'];
const actionContents = value => `export function calculate() {\n  const value = ${value};\n  return value;\n}\n`;
await mkdir(join(actionsRepo, 'zeta'), { recursive: true });
gitAt(actionsRepo, 'init', '-b', 'main');
for (const path of actionPaths) await writeFile(join(actionsRepo, path), actionContents(0));
gitAt(actionsRepo, 'add', '.'); gitAt(actionsRepo, 'commit', '-m', 'Initial files');
gitAt(actionsRepo, 'checkout', '-b', 'feature/actions');
for (const path of actionPaths) await writeFile(join(actionsRepo, path), actionContents(1));

const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BRANCHLINE_DEV_URL;
let desktop;
const errors = [];
const feedback = 'Handle an empty name before constructing the greeting.';
const nextFeedback = 'Feedback for the next branch only.';
const readState = page => page.evaluate(() => window.reviewAPI.getState());
const contextKey = review => JSON.stringify([review.featureBranch, review.baseBranch]);
const picker = (page, label) => page.getByRole('combobox', { name: label, exact: true });
const option = (page, label) => page.getByRole('option', { name: label, exact: true });

async function waitForState(page, predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = predicate(await readState(page));
    if (result) return result;
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function chooseOption(page, label, value) {
  await picker(page, label).click();
  await option(page, value).click();
}

async function dismissPicker(page) {
  await page.keyboard.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
}

async function checkReviewOption(page, name, present) {
  await picker(page, 'Select review').click();
  await page.getByRole('listbox', { name: 'Select review options', exact: true }).waitFor();
  if (present) await option(page, name).waitFor();
  else assert.equal(await option(page, name).count(), 0);
  await dismissPicker(page);
}

async function waitSelectedReview(page, name) {
  await page.waitForFunction(expected => {
    const select = document.querySelector('[aria-label="Select review"]');
    return select?.textContent?.includes(expected);
  }, name);
}

async function addProject(page, path, name, first = false) {
  await page.getByRole('button', { name: first ? 'Add your first project' : 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#project-repo-path').fill(path);
  await dialog.locator('#project-name').fill(name);
  assert.equal(await dialog.locator('#project-repo-path').inputValue(), path);
  assert.equal(await dialog.locator('#project-name').inputValue(), name);
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('tab', { name, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
}

async function chooseCurrentTarget(page, target) {
  await chooseOption(page, 'Current target branch', target);
  await page.waitForFunction(() => {
    const select = document.querySelector('[aria-label="Current target branch"]');
    return select && !select.disabled;
  });
}

async function waitCurrentBranch(page, branch) {
  await waitSelectedReview(page, 'Current');
  await page.locator('.feature-branch').filter({ hasText: branch }).waitFor();
  await waitForState(page,
    ({ reviews }) => reviews.some(review => review.kind === 'current' && review.featureBranch === branch),
    `Current to follow ${branch}`);
}

async function selectGreeting(page) {
  const previousFilter = await picker(page, 'Filter changed files').getAttribute('data-value');
  const revealReviewed = await page.locator('[data-item-path="src/greeting.ts"]').count() === 0;
  if (revealReviewed) await chooseOption(page, 'Filter changed files', 'All files');
  await page.locator('[data-item-path="src/greeting.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'src/greeting.ts' }).waitFor();
  if (revealReviewed && previousFilter === 'unreviewed') await chooseOption(page, 'Filter changed files', 'Unreviewed');
}

async function waitForComment(page, id, body) {
  return waitForState(page,
    ({ reviews }) => reviews.find(review => review.id === id)?.comments.find(comment => comment.body === body),
    `comment to save in ${id}: ${body}`);
}

async function commentOnGreeting(page, body) {
  // Click an actual rendered line number in Diffs' shadow DOM.
  await page.locator('[data-column-number="2"][data-line-type="change-addition"]').click();
  await page.getByRole('textbox', { name: 'Comment text', exact: true }).fill(body);
  await waitForComment(page, await picker(page, 'Select review').getAttribute('data-value'), body);
  await page.locator('.diff-file-name').click();
  await page.getByRole('textbox', { name: 'Comment text', exact: true }).waitFor({ state: 'hidden' });
  await page.getByText(body, { exact: true }).first().waitFor();
}

try {
  desktop = await electron.launch({ executablePath, args: [resolve('.')], env, timeout: 30000 });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await addProject(page, repo, 'Monorepo', true);
  await waitSelectedReview(page, 'Current');
  assert.equal(await picker(page, 'Current target branch').getAttribute('data-value'), '');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/current-unconfigured.png', animations: 'disabled' });
  let state = await readState(page);
  const firstProject = state.projects.find(project => project.name === 'Monorepo');
  const reviewId = `current:${firstProject.id}`;
  assert.equal(await picker(page, 'Select review').getAttribute('data-value'), reviewId);
  assert.equal(firstProject.defaultBaseBranch, null, 'Adding a project must not silently choose its target.');
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].id, reviewId);
  assert.equal(state.reviews[0].kind, 'current');
  assert.equal(state.reviews[0].baseBranch, '');
  await chooseCurrentTarget(page, 'release');
  await waitCurrentBranch(page, 'feature/greeting');
  await selectGreeting(page);
  await picker(page, 'Current target branch').click();
  await option(page, 'release').waitFor();
  await option(page, 'main').waitFor();
  await option(page, 'origin/v3.4.3').waitFor();
  assert.equal(await page.getByRole('searchbox', { name: 'Search options', exact: true }).evaluate(input => input.value), '');
  await page.screenshot({ path: 'artifacts/current-picker.png', animations: 'disabled' });
  await dismissPicker(page);
  assert.equal(await page.locator('select, datalist').count(), 0, 'Branch and review pickers must use the themed controls.');
  assert.equal(await picker(page, 'Filter changed files').getAttribute('data-value'), 'unreviewed');
  await page.locator('[data-item-path="docs/notes.md"]').getByText('Unreviewed', { exact: true }).waitFor();
  const sidebarBefore = await page.locator('.files-sidebar').boundingBox();
  const resizeGrip = page.getByRole('separator', { name: 'Resize file pane', exact: true });
  const gripBox = await resizeGrip.boundingBox();
  assert.ok(sidebarBefore && gripBox);
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 64, gripBox.y + gripBox.height / 2, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await page.locator('.files-sidebar').boundingBox();
  assert.ok(afterDrag && afterDrag.width > sidebarBefore.width + 50, 'Dragging the separator should widen the file pane.');
  await resizeGrip.press('ArrowRight');
  const afterKeyboard = await page.locator('.files-sidebar').boundingBox();
  assert.ok(afterKeyboard && Math.abs(afterKeyboard.width - afterDrag.width - 10) <= 1, 'The separator should also resize with the keyboard.');
  await resizeGrip.press('ArrowLeft');
  const resizedPaneWidth = (await page.locator('.files-sidebar').boundingBox()).width;
  const withFiles = await page.locator('.review-code-diff').boundingBox();
  assert.ok(withFiles, 'The code pane should be visible.');
  await page.getByRole('button', { name: 'Hide files', exact: true }).click();
  await page.getByRole('button', { name: 'Show files', exact: true }).waitFor();
  const withoutFiles = await page.locator('.review-code-diff').boundingBox();
  assert.ok(withoutFiles && withoutFiles.width > withFiles.width + 100, 'Hiding files must give the diff more horizontal space.');
  console.log(`Code pane: top=${Math.round(withFiles.y)}px; width with files=${Math.round(withFiles.width)}px; width with files hidden=${Math.round(withoutFiles.width)}px.`);
  await page.getByRole('button', { name: 'Show files', exact: true }).click();
  await page.getByRole('button', { name: 'Hide files', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Project settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Project settings', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  const { snapshot } = await page.evaluate(id => window.reviewAPI.refreshReview(id), reviewId);
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), ['docs/notes.md', 'src/greeting.ts']);
  assert.ok(snapshot.repos[0].workingTreeIncluded);

  const editor = page.getByRole('textbox', { name: 'Comment text', exact: true });
  await page.locator('[data-column-number="2"][data-line-type="change-addition"]').click();
  await editor.fill('Handle an empty name.');
  const firstAutosave = await waitForComment(page, reviewId, 'Handle an empty name.');
  assert.equal(await editor.isVisible(), true, 'Autosave should not interrupt typing.');
  assert.equal(await page.getByRole('button', { name: 'Add comment', exact: true }).count(), 0);
  await editor.fill(feedback);
  const updatedAutosave = await waitForComment(page, reviewId, feedback);
  assert.equal(updatedAutosave.id, firstAutosave.id, 'Continued typing must update the same comment.');
  assert.equal((await readState(page)).reviews.find(review => review.id === reviewId).comments.length, 1);
  await page.locator('.diff-file-name').click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByText(feedback, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Resolve comment', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen comment', exact: true }).waitFor();
  assert.equal((await readState(page)).reviews.find(review => review.id === reviewId).comments[0].resolved, true);
  await page.getByRole('button', { name: 'Reopen comment', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve comment', exact: true }).waitFor();

  // Leaving a file immediately must flush its pending comment before navigation.
  const temporaryFeedback = 'This comment must survive an immediate file switch.';
  await page.locator('[data-item-path="docs/notes.md"]').click();
  await page.locator('[data-column-number="1"][data-line-type="change-addition"]').click();
  await editor.fill(temporaryFeedback);
  await selectGreeting(page);
  const flushedComment = await waitForComment(page, reviewId, temporaryFeedback);
  await page.locator('[data-item-path="docs/notes.md"]').click();
  await page.getByText(temporaryFeedback, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete comment', exact: true }).click();
  await waitForState(page, ({ reviews }) => {
    const review = reviews.find(item => item.id === reviewId);
    return review && !review.comments.some(comment => comment.id === flushedComment.id);
  }, 'the temporary comment to be deleted');
  await selectGreeting(page);
  await page.screenshot({ path: 'artifacts/compact-comment.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  // Greeting is last in snapshot order: advancing must wrap to the pending notes.
  assert.ok(snapshot.files.findIndex(file => file.path === 'src/greeting.ts') > snapshot.files.findIndex(file => file.path === 'docs/notes.md'));
  await page.locator('.diff-file-name').filter({ hasText: 'docs/notes.md' }).waitFor();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
  await page.locator('[data-item-path="src/greeting.ts"]').waitFor({ state: 'hidden' });
  await chooseOption(page, 'Filter changed files', 'All files');
  await page.locator('[data-item-path="src/greeting.ts"]').waitFor();
  await page.locator('[data-item-path="src/greeting.ts"]').getByText('✓ Reviewed', { exact: true }).waitFor();
  await chooseOption(page, 'Filter changed files', 'Unreviewed');
  await page.locator('[data-item-path="src/greeting.ts"]').waitFor({ state: 'hidden' });

  // Completing the remaining file must skip reviewed files and stay complete on refresh.
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('heading', { name: /caught up/i }).waitFor();
  assert.equal(await page.locator('.diff-file-name').count(), 0);
  assert.equal(Object.keys((await readState(page)).reviews.find(review => review.id === reviewId).approvals).length, 2);
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  await page.getByRole('heading', { name: /caught up/i }).waitFor();
  assert.equal(await page.locator('.diff-file-name').count(), 0, 'Refreshing a completed review must not reopen an approved file.');

  // Unapproving stays on that file; approving it again skips the approved greeting.
  await chooseOption(page, 'Filter changed files', 'All files');
  await page.locator('[data-item-path="docs/notes.md"]').click();
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
  await page.locator('.diff-file-name').filter({ hasText: 'docs/notes.md' }).waitFor();
  assert.equal(Object.keys((await readState(page)).reviews.find(review => review.id === reviewId).approvals).length, 1);
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('heading', { name: /caught up/i }).waitFor();
  assert.equal(await page.locator('.diff-file-name').count(), 0);
  await chooseOption(page, 'Filter changed files', 'Unreviewed');

  // New changes reopen the first pending file automatically after completion.
  await writeFile(join(repo, 'docs/notes.md'), `${notesContents}\nConfirm whitespace-only names too.\n`);
  await page.locator('.diff-file-name').filter({ hasText: 'docs/notes.md' }).waitFor();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
  await page.locator('[data-item-path="docs/notes.md"]').getByText('↻ Changed', { exact: true }).waitFor();
  assert.equal(Object.keys((await readState(page)).reviews.find(review => review.id === reviewId).approvals).length, 1);
  await writeFile(join(repo, 'docs/notes.md'), notesContents);
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  await page.getByRole('button', { name: /Copy feedback/ }).first().click();
  await page.getByRole('button', { name: /Copied feedback/ }).first().waitFor();
  const copied = await desktop.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(copied, `src/greeting.ts:2\n${feedback}`);
  await selectGreeting(page);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/review.png', animations: 'disabled' });

  // The same Current review follows checkout, isolating empty editors and saved feedback.
  const greetingContext = JSON.stringify(['feature/greeting', 'release']);
  await page.locator('[data-item-path="docs/notes.md"]').click();
  await page.locator('[data-column-number="1"][data-line-type="change-addition"]').click();
  await editor.waitFor();
  git('checkout', '-b', 'feature/next');
  await waitCurrentBranch(page, 'feature/next'); // Deliberately waits for automatic refresh.
  assert.equal(await editor.count(), 0, 'An empty comment editor leaked into another branch context.');
  state = await readState(page);
  let current = state.reviews.find(review => review.id === reviewId);
  assert.equal(state.reviews.length, 1);
  assert.equal(current.baseBranch, 'release');
  assert.deepEqual(current.comments, []);
  assert.deepEqual(current.approvals, {});
  await assert.rejects(page.evaluate(({ id, key }) => window.reviewAPI.copyFeedback(id, key), { id: reviewId, key: greetingContext }), 'Stale Current actions must not act on another branch context.');
  await selectGreeting(page);
  await commentOnGreeting(page, nextFeedback);
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.locator('.diff-file-name').filter({ hasText: 'docs/notes.md' }).waitFor();
  git('checkout', 'feature/greeting');
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await waitCurrentBranch(page, 'feature/greeting');
  await selectGreeting(page);
  await page.getByRole('button', { name: 'Reviewed', exact: true }).waitFor();
  await page.getByText(feedback, { exact: true }).first().waitFor();
  assert.equal(await page.getByText(nextFeedback, { exact: true }).count(), 0);
  state = await readState(page);
  current = state.reviews.find(review => review.id === reviewId);
  assert.equal(current.comments.length, 1);
  assert.equal(current.comments[0].body, feedback);
  assert.equal(Object.keys(current.approvals).length, 1);

  // Even targets pointing to the same commit have separate review feedback.
  await chooseCurrentTarget(page, 'main');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
  state = await readState(page);
  current = state.reviews.find(review => review.id === reviewId);
  assert.equal(current.baseBranch, 'main');
  assert.deepEqual(current.comments, []);
  assert.deepEqual(current.approvals, {});
  await chooseCurrentTarget(page, 'release');
  await page.getByRole('button', { name: 'Reviewed', exact: true }).waitFor();
  await page.getByText(feedback, { exact: true }).first().waitFor();

  await writeFile(join(repo, 'src/greeting.ts'), 'export function greet(name: string) {\n  const trimmed = name.trim() || "friend";\n  return `Welcome, ${trimmed}!`;\n}\n');
  // Wait for automatic refresh; do not invoke the API to cause invalidation.
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor({ timeout: 15000 });
  const changedRow = page.locator('[data-item-path="src/greeting.ts"]');
  await changedRow.waitFor();
  await changedRow.getByText('↻ Changed', { exact: true }).waitFor();
  await changedRow.getByTitle(/^Needs re-review/).waitFor();
  await page.getByText(/^Earlier version/).first().waitFor();
  await page.locator('.review-code-diff').getByText(feedback, { exact: true }).waitFor();
  assert.equal(await page.locator('.review-earlier-comments').count(), 0, 'Earlier feedback should remain beside code instead of at the bottom.');
  state = await readState(page);
  assert.deepEqual(state.reviews.find(review => review.id === reviewId).approvals, {});
  assert.equal(state.reviews.find(review => review.id === reviewId).comments.length, 1);
  current = state.reviews.find(review => review.id === reviewId);
  const outdated = await page.evaluate(({ id, key }) => window.reviewAPI.copyFeedback(id, key), { id: reviewId, key: contextKey(current) });
  assert.equal(outdated, `src/greeting.ts:2\n${feedback}`);
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await page.screenshot({ path: 'artifacts/review-updated.png', animations: 'disabled' });

  // Saved comparisons remain explicit and fixed while Current follows checkout.
  await selectGreeting(page);
  await page.locator('[data-column-number="2"][data-line-type="change-addition"]').click();
  await editor.waitFor();
  await page.getByRole('button', { name: 'Review another branch', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Review another branch', exact: true }).waitFor();
  assert.equal(await dialog.locator('#repo-path, #project-repo-path').count(), 0);
  assert.equal(await dialog.locator('#base-branch').getAttribute('data-value'), 'release');
  assert.equal(await dialog.getByRole('checkbox', { name: /Include uncommitted changes/ }).isChecked(), false);
  assert.equal(await dialog.locator('select, datalist').count(), 0);

  // Search works with remote branch suffixes; Escape dismisses only the picker.
  await picker(page, 'Target branch').click();
  const search = page.getByRole('searchbox', { name: 'Search options', exact: true });
  assert.equal(await search.evaluate(input => input.value), '');
  await option(page, 'main').waitFor();
  await option(page, 'release').waitFor();
  await search.fill('v3.4');
  await option(page, 'origin/v3.4.3').waitFor();
  assert.equal(await page.getByRole('option').count(), 1);
  await page.screenshot({ path: 'artifacts/branch-picker.png', animations: 'disabled' });
  await search.press('Escape');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await dialog.isVisible(), true, 'Escape should close the branch picker without closing the review dialog.');
  assert.equal(await dialog.locator('#base-branch').getAttribute('data-value'), 'release');

  await picker(page, 'Target branch').click();
  assert.equal(await search.evaluate(input => input.value), '', 'Reopening a selected branch must show every option.');
  await option(page, 'main').waitFor();
  await option(page, 'release').waitFor();
  await search.fill('no-such-branch');
  await page.getByText('No matching options', { exact: true }).waitFor();
  assert.equal(await page.getByRole('option').count(), 0);
  assert.equal(await dialog.locator('#base-branch').getAttribute('data-value'), 'release');
  await search.fill('v3.4');
  await search.press('ArrowDown');
  await search.press('Enter');
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await dialog.locator('#base-branch').getAttribute('data-value'), 'origin/v3.4.3');
  await picker(page, 'Target branch').click();
  assert.equal(await search.evaluate(input => input.value), '');
  await option(page, 'main').waitFor();
  await option(page, 'origin/v3.4.3').waitFor();
  await dismissPicker(page);
  await chooseOption(page, 'Feature branch', 'feature/greeting');
  await dialog.locator('#review-name').fill('Pinned greeting');
  await page.screenshot({ path: 'artifacts/new-review.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Create review', exact: true }).click();
  await waitSelectedReview(page, 'Pinned greeting');
  await selectGreeting(page);
  assert.equal(await editor.count(), 0, 'An empty comment editor leaked into another saved review.');
  state = await readState(page);
  assert.equal(state.reviews.length, 2);
  const savedId = state.reviews.find(review => review.name === 'Pinned greeting').id;
  const saved = state.reviews.find(review => review.id === savedId);
  assert.equal(saved.kind, 'saved');
  assert.equal(saved.baseBranch, 'origin/v3.4.3');
  assert.equal(saved.includeWorkingTree, false);
  assert.deepEqual(saved.comments, []);
  const savedSnapshot = await page.evaluate(id => window.reviewAPI.refreshReview(id), savedId);
  assert.deepEqual(savedSnapshot.snapshot.files.map(file => file.path), ['src/greeting.ts']);
  git('checkout', 'feature/next');
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  state = await readState(page);
  assert.equal(state.reviews.find(review => review.id === savedId).featureBranch, 'feature/greeting');
  await waitSelectedReview(page, 'Pinned greeting');
  await chooseOption(page, 'Select review', 'Current');
  await waitCurrentBranch(page, 'feature/next');
  await selectGreeting(page);
  await page.getByText(nextFeedback, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: /^Feedback/ }).click();
  await page.screenshot({ path: 'artifacts/multiple-reviews.png', animations: 'disabled' });

  // A second project also starts with one Current review and no inherited target.
  await addProject(page, secondRepo, 'Service');
  await waitSelectedReview(page, 'Current');
  assert.equal(await picker(page, 'Current target branch').getAttribute('data-value'), '');
  await checkReviewOption(page, 'Pinned greeting', false);
  state = await readState(page);
  const secondProject = state.projects.find(project => project.name === 'Service');
  const secondCurrentId = `current:${secondProject.id}`;
  assert.equal(secondProject.defaultBaseBranch, null);
  assert.equal(state.reviews.filter(review => review.projectId === secondProject.id).length, 1);
  await chooseCurrentTarget(page, 'main');
  await page.locator('[data-item-path="service.ts"]').waitFor();
  state = await readState(page);
  assert.equal(state.reviews.find(review => review.id === secondCurrentId).comments.length, 0);
  assert.equal(state.projects.find(project => project.id === firstProject.id).defaultBaseBranch, 'origin/v3.4.3');
  await page.getByRole('tab', { name: 'Monorepo', exact: true }).click();
  await waitCurrentBranch(page, 'feature/next');
  assert.equal(await picker(page, 'Current target branch').getAttribute('data-value'), 'release');
  await checkReviewOption(page, 'Pinned greeting', true);
  await page.getByRole('tab', { name: 'Service', exact: true }).click();
  await waitCurrentBranch(page, 'feature/service');
  assert.equal(await picker(page, 'Current target branch').getAttribute('data-value'), 'main');
  await page.screenshot({ path: 'artifacts/project-tabs.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const minimumPane = await page.locator('.review-code-diff').boundingBox();
  assert.ok(minimumPane);
  console.log(`Code pane at 1050×680: top=${Math.round(minimumPane.y)}px; width=${Math.round(minimumPane.width)}px.`);
  await page.screenshot({ path: 'artifacts/current-minimum-window.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);

  // Closing the real window must save pending typing before destroying its renderer.
  const closingFeedback = 'Check that this timeout also covers a slow service response.';
  await page.locator('[data-item-path="service.ts"]').click();
  await page.locator('[data-column-number="1"][data-line-type="change-addition"]').click();
  const closingCommentId = await editor.evaluate(input => input.closest('[data-comment-id]')?.getAttribute('data-comment-id'));
  assert.ok(closingCommentId);
  const windowClosed = page.waitForEvent('close');
  await editor.fill(closingFeedback);
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await windowClosed;
  const closedState = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8'));
  const closedComments = closedState.reviews.find(review => review.id === secondCurrentId).comments;
  assert.equal(closedComments.length, 1, 'Window close must flush the comment to disk before a relaunch can recover drafts.');
  assert.equal(closedComments[0].id, closingCommentId);
  assert.equal(closedComments[0].body, closingFeedback);
  await desktop.close();
  desktop = await electron.launch({ executablePath, args: [resolve('.')], env });
  const reopened = await desktop.firstWindow();
  reopened.setDefaultTimeout(15000);
  reopened.on('pageerror', error => errors.push(error.message));
  await reopened.getByRole('tab', { name: 'Monorepo', exact: true }).waitFor();
  await reopened.getByRole('tab', { name: 'Service', exact: true }).waitFor();
  const persistedPane = await reopened.locator('.files-sidebar').boundingBox();
  assert.ok(persistedPane && Math.abs(persistedPane.width - resizedPaneWidth) <= 1, 'The file pane width should survive an app restart.');
  const persisted = await readState(reopened);
  assert.equal(persisted.projects.length, 2);
  assert.equal(persisted.reviews.length, 3);
  assert.equal(persisted.projects.find(project => project.id === firstProject.id).defaultBaseBranch, 'origin/v3.4.3');
  assert.equal(persisted.projects.find(project => project.id === secondProject.id).defaultBaseBranch, 'main');
  const persistedCurrent = persisted.reviews.find(review => review.id === reviewId);
  assert.equal(persistedCurrent.comments[0].body, nextFeedback);
  assert.equal(persistedCurrent.currentContexts[greetingContext].comments[0].body, feedback);
  assert.equal(persisted.reviews.find(review => review.id === savedId).featureBranch, 'feature/greeting');
  const reopenedComments = persisted.reviews.find(review => review.id === secondCurrentId).comments;
  assert.equal(reopenedComments.length, 1);
  assert.equal(reopenedComments[0].id, closingCommentId);
  assert.equal(reopenedComments[0].body, closingFeedback);
  await reopened.getByRole('tab', { name: 'Monorepo', exact: true }).click();
  await waitCurrentBranch(reopened, 'feature/next');
  await checkReviewOption(reopened, 'Pinned greeting', true);
  git('checkout', 'feature/greeting');
  await reopened.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await waitCurrentBranch(reopened, 'feature/greeting');
  await selectGreeting(reopened);
  await reopened.getByText(feedback, { exact: true }).first().waitFor();
  assert.equal((await readState(reopened)).reviews.length, 3, 'Checkout changes must never create another Current review.');
  await reopened.getByRole('tab', { name: 'Service', exact: true }).click();
  await waitCurrentBranch(reopened, 'feature/service');
  await checkReviewOption(reopened, 'Pinned greeting', false);
  await reopened.locator('[data-item-path="service.ts"]').click();
  await reopened.getByText(closingFeedback, { exact: true }).waitFor();

  // Explorer order is directories-first and natural, not Git's flat lexical order.
  await addProject(reopened, actionsRepo, 'Review actions');
  await chooseCurrentTarget(reopened, 'main');
  const actionState = await readState(reopened);
  const actionProject = actionState.projects.find(project => project.name === 'Review actions');
  const actionReviewId = `current:${actionProject.id}`;
  const row = path => reopened.locator(`[data-item-path="${path}"]`).first();
  const actionMenu = () => reopened.getByRole('menu', { name: 'File review actions' });
  const explorerOrder = ['zeta/part1.ts', 'zeta/part2.ts', 'zeta/part10.ts', 'a-root.ts'];
  const rowPositions = [];
  for (const path of explorerOrder) { await row(path).waitFor(); rowPositions.push((await row(path).boundingBox()).y); }
  assert.ok(rowPositions.every((y, index) => index === 0 || rowPositions[index - 1] < y), 'The fixture must exercise actual explorer natural/folder ordering.');
  await row('zeta/part1.ts').click();
  await reopened.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await reopened.locator('.diff-file-name').filter({ hasText: 'zeta/part2.ts' }).waitFor();
  await row('zeta/part2.ts').click({ button: 'right' });
  await actionMenu().getByRole('menuitem', { name: 'Mark reviewed', exact: true }).click();
  await reopened.locator('.diff-file-name').filter({ hasText: 'zeta/part10.ts' }).waitFor();
  await row('zeta/part2.ts').waitFor({ state: 'hidden' });

  // A Shift range stays selected through refresh and right-click, then saves as a batch.
  // Auto-advance must establish the range anchor without another normal click.
  await row('a-root.ts').click({ modifiers: ['Shift'] });
  assert.equal(await row('zeta/part10.ts').getAttribute('aria-selected'), 'true');
  assert.equal(await row('a-root.ts').getAttribute('aria-selected'), 'true');
  await reopened.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await reopened.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  assert.equal(await row('zeta/part10.ts').getAttribute('aria-selected'), 'true');
  assert.equal(await row('a-root.ts').getAttribute('aria-selected'), 'true');
  await row('zeta/part10.ts').click({ button: 'right' });
  await actionMenu().waitFor();
  await reopened.screenshot({ path: 'artifacts/batch-review.png', animations: 'disabled' });
  await actionMenu().getByRole('menuitem', { name: 'Mark reviewed', exact: true }).click();
  await reopened.getByRole('heading', { name: /caught up/i }).waitFor();
  assert.equal(Object.keys((await readState(reopened)).reviews.find(review => review.id === actionReviewId).approvals).length, 4);
  await chooseOption(reopened, 'Filter changed files', 'All files');
  await row('zeta/part1.ts').click({ button: 'right' });
  await actionMenu().getByRole('menuitem', { name: 'Mark unreviewed', exact: true }).click();
  const remainingApprovals = await waitForState(reopened, ({ reviews }) => {
    const approvals = reviews.find(review => review.id === actionReviewId)?.approvals;
    return approvals && !Object.hasOwn(approvals, 'zeta/part1.ts') && approvals;
  }, 'the right-clicked file to become unreviewed');
  assert.equal(Object.keys(remainingApprovals).length, 3, 'Right-clicking an unselected file should affect only that file.');
  assert.equal(remainingApprovals['zeta/part1.ts'], undefined);

  // Earlier comments follow edited code after insertions and remain inline after restart.
  await row('zeta/part1.ts').click();
  await reopened.locator('[data-column-number="2"][data-line-type="change-addition"]').click();
  const movingFeedback = 'Verify this value before returning it.';
  await reopened.getByRole('textbox', { name: 'Comment text', exact: true }).fill(movingFeedback);
  const movingComment = await waitForComment(reopened, actionReviewId, movingFeedback);
  await reopened.locator('.diff-file-name').click();
  const movedContents = `// Inserted before the reviewed code.\n// Keep feedback with its code.\n${actionContents(2)}`;
  await writeFile(join(actionsRepo, 'zeta/part1.ts'), movedContents);
  const inlineComment = reopened.locator(`.review-code-diff [data-comment-id="${movingComment.id}"]`);
  await reopened.locator(`.review-code-diff [data-comment-id="${movingComment.id}"][data-comment-line="4"]`).waitFor();
  await inlineComment.getByText(/^Earlier version/).waitFor();
  assert.equal(await inlineComment.getAttribute('data-comment-side'), 'additions');
  await reopened.screenshot({ path: 'artifacts/inline-earlier-feedback.png', animations: 'disabled' });
  await desktop.close();
  desktop = await electron.launch({ executablePath, args: [resolve('.')], env });
  const restoredActions = await desktop.firstWindow();
  restoredActions.setDefaultTimeout(15000);
  restoredActions.on('pageerror', error => errors.push(error.message));
  const restoredInline = restoredActions.locator(`.review-code-diff [data-comment-id="${movingComment.id}"]`);
  await restoredInline.waitFor();
  assert.equal(await restoredInline.getAttribute('data-comment-line'), '4');
  await restoredInline.getByText(movingFeedback, { exact: true }).waitFor();
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);
  console.log('Desktop smoke passed: explorer-order navigation, right-click and Shift-range batch approvals, inline earlier feedback and restart relocation, autosave, completion, resizing, pickers, context isolation, clipboard, and persistence.');
} catch (error) {
  if (desktop) {
    const windows = desktop.windows();
    if (windows[0]) {
      await mkdir('artifacts', { recursive: true });
      await windows[0].screenshot({ path: 'artifacts/smoke-failure.png' }).catch(() => {});
      console.error((await windows[0].locator('body').innerText()).slice(0, 12000));
      console.error('Renderer errors:', errors);
    }
  }
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
