import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-history-'));
const local = join(fixture, 'project');
const data = join(fixture, 'data');
const env = smokeEnv({ BRANCHLINE_DATA_DIR: data, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
delete env.ELECTRON_RUN_AS_NODE;
delete env.BRANCHLINE_DEV_URL;
let date = '2026-09-28T10:00:00Z';
function git(directory, ...args) {
  return execFileSync('git', ['-c', 'user.name=History Test', '-c', 'user.email=history@example.invalid', '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false', ...args], { cwd: directory, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function commit(directory, file, message) {
  await writeFile(join(directory, file), message);
  git(directory, 'add', file);
  git(directory, 'commit', '-qm', message);
}
await mkdir(local);
git(local, 'init', '-q', '-b', 'main');
await commit(local, 'initial.txt', 'Initial project');
// A long ancestor chain proves infinite scrolling continues beyond the old 5,000 cap.
const base = git(local, 'rev-parse', 'HEAD');
let history = '';
for (let index = 1; index <= 5500; index++) {
  const message = `Older history ${index}`;
  history += `commit refs/heads/main\nmark :${index}\nauthor History Test <history@example.invalid> ${1500000000 + index} +0000\ncommitter History Test <history@example.invalid> ${1500000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${index === 1 ? base : `:${index - 1}`}\n\n`;
}
execFileSync('git', ['fast-import', '--quiet'], { cwd: local, env, input: history });
git(local, 'reset', '--hard', '-q', 'main');

const children = [];
for (const name of ['core', 'tara', 'central', 'cloud']) {
  const source = join(fixture, `source-${name}`);
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  await commit(source, 'module.txt', `Initial ${name}`);
  git(local, 'submodule', 'add', '-q', source, name);
  children.push(join(local, name));
}
git(local, 'commit', '-qm', 'Add project repositories');
const directories = [...children, local];
const merges = [];
for (let wave = 0; wave < 2; wave++) {
  date = `2026-10-0${wave * 2 + 1}T10:00:00Z`;
  for (const [index, repository] of directories.entries()) {
    git(repository, 'switch', wave === 0 ? '-qc' : '-q', 'v3.5');
    await commit(repository, `feature-${wave}.txt`, `Feature ${wave + 1} in ${index === 4 ? 'root' : ['core', 'tara', 'central', 'cloud'][index]}`);
    git(repository, 'switch', '-q', 'main');
  }
  for (const [index, repository] of directories.entries()) {
    // Consecutive merge rows share source and target, even across multiple days.
    date = `2026-10-0${wave * 2 + 2}T10:00:0${index}Z`;
    git(repository, 'merge', '--no-ff', '-qm', "Merge branch 'v3.5' into main", 'v3.5');
    merges.push({ path: index === 4 ? '.' : ['core', 'tara', 'central', 'cloud'][index], hash: git(repository, 'rev-parse', 'HEAD') });
  }
}
let desktop;
const errors = [];
try {
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [resolve('.')], env });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
  await page.locator('#project-repo-path').fill(local);
  await page.locator('#project-name').fill('Five repositories');
  await page.getByRole('dialog').getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('button', { name: 'Project Git workflow', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Git · Five repositories', exact: true });
  const log = panel.getByRole('grid', { name: 'Commit log', exact: true });
  await log.getByText("Merge branch 'v3.5' into main · 5 merges", { exact: true }).first().waitFor();
  assert.equal(await log.locator('[data-timeline-kind="group"]').count(), 2);
  assert.equal(await panel.getByRole('combobox', { name: 'History view', exact: true }).count(), 0);
  assert.equal(await panel.getByRole('combobox', { name: 'History repository', exact: true }).count(), 0);
  for (const name of ['root', 'core', 'tara', 'central', 'cloud']) {
    for (const wave of [1, 2]) await log.getByText(`Feature ${wave} in ${name}`, { exact: true }).waitFor();
  }
  const paths = await log.locator('[data-repository-path]').evaluateAll((elements) => [...new Set(elements.map((element) => element.dataset.repositoryPath))]);
  assert.equal(paths.length, 5);
  assert.ok(await log.locator('svg path').count() > 0);
  await log.getByRole('button', { name: 'Show 5 grouped merges', exact: true }).first().click();
  const details = panel.getByRole('region', { name: 'Commit details', exact: true });
  for (const merge of merges.slice(5)) await details.locator('summary').filter({ hasText: merge.hash.slice(0, 7) }).waitFor();
  await details.locator('summary').first().click();
  await details.getByText(`Commit ${merges[9].hash}`, { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Close commit details', exact: true }).click();
  const search = panel.getByRole('textbox', { name: 'Search loaded commits', exact: true });
  await search.fill(merges[5].hash);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  assert.match(await log.locator('[aria-selected="true"]').innerText(), /5 merges/);
  await search.fill('');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  if (process.env.BRANCHLINE_GIT_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.BRANCHLINE_GIT_HISTORY_SCREENSHOT });
  const widths = await log.locator('[role="gridcell"]:nth-child(3) svg').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  assert.ok(widths.every((width) => width > 36 && width <= 184));
  assert.equal(await panel.getByRole('group', { name: 'Commit history summary', exact: true }).count(), 0);
  assert.equal(await panel.locator('summary').filter({ hasText: 'Branch details' }).count(), 0);
  const waitForCount = (count) => page.waitForFunction((expected) =>
    Number(document.querySelector('[aria-label="Commit log"]')?.dataset.loadedCommits) === expected, count);
  const total = directories.reduce((sum, directory) => sum + Number(git(directory, 'rev-list', '--all', '--count')), 0);
  assert.equal(await panel.getByRole('button', { name: 'Load older commits', exact: true }).count(), 0);
  await waitForCount(250);
  // Preload while still 400px from the bottom, without changing selection or scroll.
  await log.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 400; });
  await page.waitForFunction(() => Number(document.querySelector('[aria-label="Commit log"] [data-commit-hash]')?.getAttribute('aria-rowindex')) > 100);
  await log.locator('[data-commit-hash]').last().click();
  const selectedHash = await log.locator('[aria-selected="true"]').getAttribute('data-commit-hash');
  const scroll = await log.evaluate((element) => element.scrollTop);
  await waitForCount(500);
  assert.equal(await log.locator('[aria-selected="true"]').getAttribute('data-commit-hash'), selectedHash);
  assert.equal(await log.evaluate((element) => element.scrollTop), scroll);
  assert.ok(await log.locator('[data-commit-hash]').count() < 100);
  // Repeated scroll events must not queue duplicate page increments.
  await log.evaluate((element) => { for (let index = 0; index < 20; index++) element.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(300);
  await waitForCount(500);
  for (let expected = 750; expected < total + 250; expected += 250) {
    await log.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 400; });
    await waitForCount(Math.min(expected, total));
    assert.ok(await log.locator('[data-commit-hash]').count() < 100, 'DOM stays bounded as history grows');
  }
  await page.waitForFunction(() => document.querySelector('[aria-label="Commit log"]')?.dataset.historyHasMore === 'false');
  await log.focus();
  await log.press('End');
  await log.getByText('Older history 1', { exact: true }).waitFor();
  await log.press('Home');
  await log.getByText("Merge branch 'v3.5' into main · 5 merges", { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 1200, height: 750 });
  assert.ok(await log.locator('[data-commit-hash]').count() < 60, 'virtual window responds to resizing');
  await log.press('End');
  await log.getByText('Older history 1', { exact: true }).waitFor();

  for (const directory of directories) assert.equal(git(directory, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.deepEqual(errors, []);
  console.log('Commit graph desktop smoke passed: all five repositories together, every side-branch commit visible, matching source/target merge rows grouped, original merge details and hashes preserved, search, graph ancestry, dark rendering, automatic preloading beyond 5,000 commits, stable selection and scroll, duplicate-load protection, bounded DOM, resize and keyboard navigation.');
} catch (error) {
  const page = desktop && (await desktop.windows())[0];
  if (page) console.error((await page.locator('body').innerText()).slice(-6000));
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
