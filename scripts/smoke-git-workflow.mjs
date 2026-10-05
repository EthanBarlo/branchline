import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-git-desktop-'));
const local = join(fixture, 'local');
const remote = join(fixture, 'remote.git');
const peer = join(fixture, 'peer');
const data = join(fixture, 'data');
const env = smokeEnv({ BRANCHLINE_DATA_DIR: data, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
delete env.ELECTRON_RUN_AS_NODE;
delete env.BRANCHLINE_DEV_URL;
function git(directory, ...args) {
  return execFileSync('git', ['-c', 'user.name=Desktop Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function commit(directory, file, text) {
  await writeFile(join(directory, file), text);
  git(directory, 'add', file);
  git(directory, 'commit', '-qm', file);
  return git(directory, 'rev-parse', 'HEAD');
}
await mkdir(local);
git(fixture, 'init', '-q', '--bare', '-b', 'main', remote);
git(local, 'init', '-q', '-b', 'main');
await commit(local, 'hello.ts', 'export const hello = "initial";\n');
git(local, 'remote', 'add', 'origin', remote);
git(local, 'push', '-qu', 'origin', 'main');
// Three repositories share one logical branch tree, including a nested submodule.
const childSource = join(fixture, 'child-source');
const leafSource = join(fixture, 'leaf-source');
await mkdir(childSource); await mkdir(leafSource);
for (const source of [childSource, leafSource]) {
  git(source, 'init', '-q', '-b', 'main');
  await commit(source, 'module.ts', 'export const module = true;\n');
}
git(childSource, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leafSource, 'nested');
git(childSource, 'commit', '-qm', 'Add nested module');
git(local, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childSource, 'packages/core');
git(local, 'commit', '-qm', 'Add core');
git(local, 'push', '-q');
git(local, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive');
const child = join(local, 'packages/core');
const leaf = join(child, 'nested');
git(leaf, 'switch', '-q', 'main');
for (const module of [child, leaf]) git(module, 'branch', 'feature/demo');
git(child, 'branch', 'codex/submodule-only');
git(leaf, 'branch', 'codex/nested/leaf-only');
git(local, 'branch', 'codex/root-only');
await commit(child, 'outgoing.ts', 'export const outgoing = true;\n');
git(local, 'switch', '-qc', 'feature/demo');
await commit(local, 'hello.ts', 'export const hello = "feature";\n');
git(local, 'switch', '-q', 'main');
git(fixture, 'clone', '-q', remote, peer);
const incomingHead = await commit(peer, 'incoming.ts', 'export const incoming = true;\n');
git(peer, 'push', '-q');

let desktop;
const errors = [];
try {
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [resolve('.')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
  await page.locator('#project-repo-path').fill(local);
  await page.locator('#project-name').fill('Git fixture');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  let panel = page.getByRole('region', { name: 'Git · Git fixture', exact: true });
  await panel.getByText('Incoming', { exact: true }).waitFor();
  await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Fetch'); return button && !button.disabled; });
  const tree = panel.getByRole('tree', { name: 'Project branches' });
  assert.equal(await tree.getByRole('treeitem', { name: 'feature/demo', exact: true }).count(), 1);
  assert.equal(await tree.getByRole('treeitem', { name: 'main', exact: true }).getByLabel('Incoming 1', { exact: true }).count(), 1);
  assert.equal(await tree.getByRole('treeitem', { name: 'main', exact: true }).getByLabel('Outgoing 1', { exact: true }).count(), 1);
  await tree.getByRole('treeitem', { name: 'Local', exact: true }).waitFor();
  await tree.getByRole('treeitem', { name: 'Remote', exact: true }).waitFor();
  const localGroup = tree.getByRole('group', { name: 'Local', exact: true });
  const originGroup = tree.getByRole('group', { name: 'origin', exact: true });
  await originGroup.getByRole('treeitem', { name: 'origin/main', exact: true }).waitFor();
  assert.equal(await localGroup.getByRole('treeitem', { name: 'main', exact: true }).getByLabel('Checked out in all repositories', { exact: true }).count(), 1);
  await tree.getByRole('button', { name: 'Favourite feature/demo', exact: true }).click();
  assert.equal(await localGroup.locator('[data-branch-key]').first().getAttribute('aria-label'), 'feature/demo');
  assert.equal(await tree.getByRole('treeitem', { name: 'feature/demo', exact: true }).getByLabel('Favourite', { exact: true }).count(), 1);
  await tree.getByRole('treeitem', { name: 'feature/demo', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Branch actions for feature/demo', exact: true }).getByRole('menuitem', { name: 'Remove from favourites', exact: true }).click();
  await tree.getByRole('button', { name: 'Favourite main', exact: true }).click();
  await tree.getByRole('button', { name: 'Favourite origin/main', exact: true }).click();
  assert.equal(await localGroup.locator('[data-branch-key]').first().getAttribute('aria-label'), 'main');
  assert.equal(await originGroup.locator('[data-branch-key]').first().getAttribute('aria-label'), 'origin/main');
  await originGroup.getByRole('treeitem', { name: 'origin/main', exact: true }).click();
  assert.equal(await originGroup.getByRole('treeitem', { name: 'origin/main', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await localGroup.getByRole('treeitem', { name: 'main', exact: true }).getAttribute('aria-selected'), 'false');
  await panel.getByRole('button', { name: 'Review', exact: true }).click();
  const remoteReview = page.getByRole('dialog', { name: 'Review another branch', exact: true });
  assert.match(await remoteReview.getByRole('combobox', { name: 'Feature branch', exact: true }).innerText(), /origin\/main/);
  await remoteReview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'origin/main', exact: true }).click({ button: 'right' });
  assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: 'Rename…', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).click({ button: 'right' });
  let menu = page.getByRole('menu', { name: 'Branch actions for codex/submodule-only', exact: true });
  assert.equal(await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).getAttribute('aria-selected'), 'true');
  for (const name of ['Review branch…', 'Pull project…', 'Push project…']) assert.equal(await menu.getByRole('menuitem', { name, exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.match(await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).innerText(), /\[packages\/core\]/);
  assert.equal(await panel.getByRole('button', { name: 'Review', exact: true }).isDisabled(), true);
  await panel.getByRole('button', { name: 'Check out', exact: true }).click();
  let confirmation = page.getByRole('dialog', { name: 'Checkout preview', exact: true });
  assert.equal(await confirmation.getByRole('button', { name: 'Confirm checkout', exact: true }).isDisabled(), true);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'main');
  await confirmation.getByRole('button', { name: 'Cancel preview' }).click();
  await panel.getByRole('textbox', { name: 'Find a branch' }).fill('codex/nested/leaf-only');
  await tree.getByRole('treeitem', { name: 'codex/nested/leaf-only', exact: true }).click();
  assert.match(await tree.innerText(), /\[packages\/core\/nested\]/);
  assert.equal(await tree.getByRole('treeitem', { name: 'main', exact: true }).count(), 0);
  await panel.getByRole('textbox', { name: 'Find a branch' }).fill('');
  const splitter = panel.getByRole('separator', { name: 'Resize branch sidebar' });
  const originalWidth = Number(await splitter.getAttribute('aria-valuenow'));
  await splitter.press('ArrowRight');
  assert.equal(Number(await splitter.getAttribute('aria-valuenow')), originalWidth + 10);
  await splitter.press('ArrowLeft');
  await tree.getByRole('treeitem', { name: 'codex', exact: true }).click();
  assert.equal(await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).count(), 0);
  await tree.getByRole('treeitem', { name: 'codex', exact: true }).press('ArrowRight');
  await tree.getByRole('treeitem', { name: 'codex/submodule-only', exact: true }).waitFor();
  await tree.getByRole('treeitem', { name: 'main', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: 'Review', exact: true }).isDisabled(), false);
  // Right-click targets the inspected branch; opening the menu never changes checkout.
  const featureRow = tree.getByRole('treeitem', { name: 'feature/demo', exact: true });
  await featureRow.click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Branch actions for feature/demo', exact: true });
  assert.equal(await featureRow.getAttribute('aria-selected'), 'true');
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(await menu.getByRole('menuitem', { name: 'Pull project…', exact: true }).isDisabled(), true);
  await page.keyboard.press('End');
  assert.equal(await menu.getByRole('menuitem', { name: 'Add to favourites', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  assert.equal(await menu.getByRole('menuitem', { name: 'Add to favourites', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await menu.getByRole('menuitem', { name: 'Rename…', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await menu.getByRole('menuitem', { name: 'Fetch project', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Escape');
  await featureRow.press('Shift+F10');
  await menu.waitFor();
  if (process.env.BRANCHLINE_BRANCH_MENU_SCREENSHOT) await page.screenshot({ path: process.env.BRANCHLINE_BRANCH_MENU_SCREENSHOT });
  await menu.getByRole('menuitem', { name: "New branch from 'feature/demo'…", exact: true }).click();
  let nameDialog = page.getByRole('dialog', { name: 'New branch', exact: true });
  await nameDialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('topic/context-created');
  await nameDialog.getByRole('button', { name: 'Preview new branch', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Create branch preview', exact: true });
  await confirmation.waitFor();
  assert.equal(await confirmation.getByText('Create local branch', { exact: true }).count(), 3);
  await confirmation.getByRole('button', { name: 'Confirm create branch', exact: true }).click();
  await panel.getByText('Last create branch · completed', { exact: true }).waitFor();
  for (const repo of [local, child, leaf]) {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(repo, 'rev-parse', 'topic/context-created'), git(repo, 'rev-parse', 'feature/demo'));
  }
  await panel.getByRole('textbox', { name: 'Find a branch' }).fill('topic/context-created');
  await tree.getByRole('treeitem', { name: 'topic/context-created', exact: true }).click({ button: 'right' });
  menu = page.getByRole('menu', { name: 'Branch actions for topic/context-created', exact: true });
  await menu.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  nameDialog = page.getByRole('dialog', { name: 'Rename branch', exact: true });
  assert.equal(await nameDialog.getByRole('textbox', { name: 'New branch name', exact: true }).inputValue(), 'topic/context-created');
  await nameDialog.getByRole('textbox', { name: 'New branch name', exact: true }).fill('topic/context-renamed');
  await nameDialog.getByRole('button', { name: 'Preview rename', exact: true }).click();
  confirmation = page.getByRole('dialog', { name: 'Rename preview', exact: true });
  await confirmation.waitFor();
  assert.equal(await confirmation.getByText('Rename local branch', { exact: true }).count(), 3);
  await confirmation.getByRole('button', { name: 'Confirm rename', exact: true }).click();
  await panel.getByText('Last rename · completed', { exact: true }).waitFor();
  for (const repo of [local, child, leaf]) {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(repo, 'rev-parse', 'topic/context-renamed'), git(repo, 'rev-parse', 'feature/demo'));
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/heads/topic/context-created'));
  }
  await panel.getByRole('textbox', { name: 'Find a branch' }).fill('');
  const mainRow = tree.getByRole('treeitem', { name: 'main', exact: true });
  await mainRow.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: innerWidth - 1, clientY: innerHeight - 1 })));
  menu = page.getByRole('menu', { name: 'Branch actions for main', exact: true });
  await menu.waitFor();
  const bounds = await menu.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds.x + bounds.width <= viewport.width - 7 && bounds.y + bounds.height <= viewport.height - 7);
  await panel.getByRole('heading', { name: 'main', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await mainRow.press('Shift+F10');
  await menu.getByRole('menuitem', { name: 'Fetch project', exact: true }).click();
  await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Fetch'); return button && !button.disabled; });
  if (process.env.BRANCHLINE_GIT_WORKSPACE_SCREENSHOT) await page.screenshot({ path: process.env.BRANCHLINE_GIT_WORKSPACE_SCREENSHOT });
  await mainRow.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Pull project…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm pull', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm pull'); return button && !button.disabled; });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm pull', exact: true }).click();
  await panel.getByText('Last pull · completed', { exact: true }).waitFor();
  assert.equal(git(local, 'rev-parse', 'HEAD'), incomingHead);
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();

  // Review another branch without changing checkout, then add feedback through the real API.
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  await panel.getByRole('treeitem', { name: 'feature/demo', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Branch actions for feature/demo', exact: true }).getByRole('menuitem', { name: 'Review branch…', exact: true }).click();
  const reviewDialog = page.getByRole('dialog', { name: 'Review another branch', exact: true });
  await reviewDialog.getByRole('combobox', { name: 'Feature branch', exact: true }).waitFor();
  assert.match(await reviewDialog.getByRole('combobox', { name: 'Feature branch', exact: true }).innerText(), /feature\/demo/);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  await reviewDialog.getByRole('combobox', { name: 'Target branch', exact: true }).click();
  await page.getByRole('option', { name: 'main', exact: true }).click();
  await reviewDialog.getByRole('button', { name: 'Create review', exact: true }).click();
  await reviewDialog.waitFor({ state: 'hidden' });
  const feedback = await page.evaluate(async () => {
    const state = await window.reviewAPI.getState();
    const review = state.reviews.find(review => review.kind === 'saved');
    const result = await window.reviewAPI.refreshReview(review.id);
    const file = result.snapshot.files[0];
    await window.reviewAPI.addComment(review.id, { fileId: file.id, repoRelativePath: file.repoRelativePath, path: file.path, side: 'additions', lineStart: 0, lineEnd: 0, body: 'Feedback survives checkout.', fingerprint: file.fingerprint, context: '' }, JSON.stringify([review.featureBranch, review.baseBranch]));
    return review.id;
  });
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  panel = page.getByRole('region', { name: 'Git · Git fixture', exact: true });
  await panel.getByRole('treeitem', { name: 'feature/demo', exact: true }).press('Shift+F10');
  await page.getByRole('menu', { name: 'Branch actions for feature/demo', exact: true }).getByRole('menuitem', { name: 'Check out…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm checkout', exact: true }).click();
  await panel.getByText('Last checkout · completed', { exact: true }).waitFor();
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'feature/demo');
  assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'feature/demo');
  assert.equal(git(leaf, 'symbolic-ref', '--short', 'HEAD'), 'feature/demo');
  await panel.getByRole('treeitem', { name: 'feature/demo', exact: true }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Branch actions for feature/demo', exact: true }).getByRole('menuitem', { name: 'Push project…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm push', exact: true }).click();
  await panel.getByText('Last push · completed', { exact: true }).waitFor();
  assert.equal(git(remote, 'rev-parse', 'feature/demo'), git(local, 'rev-parse', 'HEAD'));
  // Renaming a current branch also updates nested checkouts and keeps remote tracking destinations.
  for (const [source, target] of [['feature/demo', 'feature/context-current'], ['feature/context-current', 'feature/demo']]) {
    await panel.getByRole('treeitem', { name: source, exact: true }).click({ button: 'right' });
    await page.getByRole('menu', { name: `Branch actions for ${source}`, exact: true }).getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    nameDialog = page.getByRole('dialog', { name: 'Rename branch', exact: true });
    await nameDialog.getByRole('textbox', { name: 'New branch name', exact: true }).fill(target);
    await nameDialog.getByRole('button', { name: 'Preview rename', exact: true }).click();
    confirmation = page.getByRole('dialog', { name: 'Rename preview', exact: true });
    await confirmation.getByRole('button', { name: 'Confirm rename', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
    await panel.getByRole('treeitem', { name: target, exact: true }).waitFor();
    await page.waitForFunction(name => document.querySelector(`[role="treeitem"][aria-label="${name}"]`)?.getAttribute('aria-selected') === 'true', target);
    for (const repo of [local, child, leaf]) {
      assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), target);
      assert.equal(git(repo, 'config', `branch.${target}.merge`), 'refs/heads/feature/demo');
    }
  }
  const stored = JSON.parse(await readFile(join(data, 'reviews.json'), 'utf8'));
  assert.equal(stored.reviews.find(review => review.id === feedback).comments[0].body, 'Feedback survives checkout.');

  // Preserve an inspected branch distinct from the checked-out branch across Settings.
  await panel.getByRole('treeitem', { name: 'codex/root-only', exact: true }).click();
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Git', exact: true }).click();
  await panel.waitFor();
  assert.equal(await panel.getByRole('treeitem', { name: 'codex/root-only', exact: true }).getAttribute('aria-selected'), 'true');
  await panel.getByRole('treeitem', { name: 'feature/demo', exact: true }).click();

  // History returns to the same dedicated area and inspected branch.
  await page.getByRole('button', { name: 'Reviews', exact: true }).click();
  await page.keyboard.press('Alt+ArrowLeft');
  await panel.waitFor();
  await page.keyboard.press('Alt+ArrowRight');
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  await panel.waitFor();

  // A clean, conflict-free divergence must still disable Pull.
  await commit(local, 'local-only.ts', 'export const localOnly = true;\n');
  git(peer, 'fetch', '-q');
  git(peer, 'switch', '-qc', 'feature/demo', '--track', 'origin/feature/demo');
  await commit(peer, 'remote-only.ts', 'export const remoteOnly = true;\n');
  git(peer, 'push', '-q');
  await panel.getByRole('button', { name: 'Pull project', exact: true }).click();
  await page.getByRole('dialog').getByText('Branches have diverged. Merge or rebase manually, then refresh.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Confirm pull', exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(fixture, 'git-panel.png') });
  if (process.env.BRANCHLINE_GIT_SCREENSHOT) await page.screenshot({ path: process.env.BRANCHLINE_GIT_SCREENSHOT });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel preview', exact: true }).click();
  // Project tabs stay in Git and restore each project's inspected branch.
  const other = join(fixture, 'other');
  await mkdir(other);
  git(other, 'init', '-q', '-b', 'main');
  await commit(other, 'other.ts', 'export const other = true;\n');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.locator('#project-repo-path').fill(other);
  await page.locator('#project-name').fill('Other Git fixture');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  const otherPanel = page.getByRole('region', { name: 'Git · Other Git fixture', exact: true });
  await otherPanel.getByRole('treeitem', { name: 'main', exact: true }).waitFor();
  assert.equal(await otherPanel.locator('[data-branch-key]').count(), 1);
  await page.getByRole('tab', { name: 'Git fixture', exact: true }).click();
  await panel.waitFor();
  assert.equal(await panel.getByRole('treeitem', { name: 'feature/demo', exact: true }).getAttribute('aria-selected'), 'true');
  // A preview finishing after a project switch must never publish its status into the new area.
  await desktop.evaluate(({ ipcMain }) => {
    const driver = globalThis.gitPreviewSmoke = { held: false, released: false, statusCompleted: false, projectId: null, release: null };
    const preview = ipcMain._invokeHandlers.get('review:git-preview');
    const status = ipcMain._invokeHandlers.get('review:git-status');
    ipcMain._invokeHandlers.set('review:git-preview', async (...args) => {
      const result = await preview(...args);
      driver.projectId = args[1]; driver.held = true;
      await new Promise(resolve => { driver.release = resolve; });
      driver.released = true;
      return result;
    });
    ipcMain._invokeHandlers.set('review:git-status', async (...args) => {
      const result = await status(...args);
      if (driver.released && args[1] === driver.projectId) driver.statusCompleted = true;
      return result;
    });
  });
  await panel.getByRole('button', { name: 'Check out', exact: true }).click();
  for (let attempt = 0; attempt < 100 && !await desktop.evaluate(() => globalThis.gitPreviewSmoke.held); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await desktop.evaluate(() => globalThis.gitPreviewSmoke.held), true);
  await page.getByRole('tab', { name: 'Other Git fixture', exact: true }).click();
  await otherPanel.getByRole('treeitem', { name: 'main', exact: true }).waitFor();
  await desktop.evaluate(() => globalThis.gitPreviewSmoke.release());
  for (let attempt = 0; attempt < 100 && !await desktop.evaluate(() => globalThis.gitPreviewSmoke.statusCompleted); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await desktop.evaluate(() => globalThis.gitPreviewSmoke.statusCompleted), true);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await otherPanel.locator('[data-branch-key]').count(), 1);
  assert.equal(await otherPanel.getByRole('treeitem', { name: 'main', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await desktop.evaluate(({ ipcMain }) => {
    const driver = globalThis.gitCacheSmoke = { calls: 0, release: null };
    const held = new Promise(resolve => { driver.release = resolve; });
    for (const channel of ['review:git-fetch', 'review:git-status']) {
      const original = ipcMain._invokeHandlers.get(channel);
      ipcMain._invokeHandlers.set(channel, async (...args) => { driver.calls++; await held; return original(...args); });
    }
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Git fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  panel = page.getByRole('region', { name: 'Git · Git fixture', exact: true });
  await panel.getByRole('treeitem', { name: 'main', exact: true }).waitFor();
  await panel.getByText('Cached · refreshing…', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Unfavourite main', exact: true }).count(), 1);
  assert.equal(await panel.getByRole('button', { name: 'Unfavourite origin/main', exact: true }).count(), 1);
  if (process.env.BRANCHLINE_GIT_SIDEBAR_SCREENSHOT) await page.screenshot({ path: process.env.BRANCHLINE_GIT_SIDEBAR_SCREENSHOT });
  await desktop.evaluate(() => globalThis.gitCacheSmoke.release());
  assert.deepEqual(errors, []);
  console.log('Git workspace desktop smoke passed: Local/Remote sections, checkout icons, persisted favourites and cached startup before fresh results, branch context menu, keyboard/focus/dismissal, New Branch and Rename with previews across nested repositories, unified nested branch tree, coverage labels, aggregate counts, search/folders/keyboard/resize, missing-branch preflight, navigation, fast-forward pull, branch review/checkout, publication, feedback preservation, and divergence blocking.');
} catch (error) {
  const page = desktop && (await desktop.windows())[0];
  if (page) console.error((await page.locator('body').innerText()).slice(-6000));
  throw error;
} finally {
  await desktop?.evaluate(() => { globalThis.gitPreviewSmoke?.release?.(); globalThis.gitCacheSmoke?.release?.(); }).catch(() => {});
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
