import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

const executablePath = process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable;
const fixture = await mkdtemp(join(tmpdir(), 'branchline-jira-'));
const repo = join(fixture, 'jira-project');
const dataDir = join(fixture, 'app-data');
const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.BRANCHLINE_DEV_URL;
const baseURL = 'https://jira.example.invalid/team/jira';
const firstBranch = 'feature/APP-123-review';
const nextBranch = 'bugfix/OPS-456-follow-up';
const noTicketBranch = 'chore/cleanup';
let desktop;
const errors = [];

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

async function launch() {
  desktop = await electron.launch({ executablePath, args: [resolve('.')], env, timeout: 30000 });
  // Intercept every external open in the trusted main process. This test never
  // opens a real browser, contacts Jira, or uses the user's review data.
  await desktop.evaluate(({ shell }) => {
    globalThis.__jiraSmokeURLs = [];
    globalThis.__jiraSmokeLogPaths = [];
    shell.openExternal = async url => { globalThis.__jiraSmokeURLs.push(url); };
    shell.showItemInFolder = path => { globalThis.__jiraSmokeLogPaths.push(path); };
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return page;
}

const state = page => page.evaluate(() => window.reviewAPI.getState());
const openedURLs = () => desktop.evaluate(() => [...globalThis.__jiraSmokeURLs]);
const ticket = (page, key) => page.getByRole('button', { name: `Open ${key} in Jira`, exact: true });

async function waitForURLs(expected) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const actual = await openedURLs();
    if (actual.length >= expected.length) { assert.deepEqual(actual, expected); return; }
    await delay(100);
  }
  assert.deepEqual(await openedURLs(), expected, 'The expected Jira URL was not sent to the desktop browser handler.');
}

async function settings(page) {
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  const view = page.getByRole('region', { name: 'Settings', exact: true });
  await view.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Settings is a full application view, not a modal.');
  await browserLinks(view);
  return view;
}

async function browserLinks(view) {
  const details = view.locator('details').filter({ hasText: 'Browser links only' });
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
}

async function saveSettings(view) {
  await view.getByRole('button', { name: 'Save link settings', exact: true }).click();
  assert.equal(await view.isVisible(), true, 'Saving link preferences keeps Settings open.');
  await view.getByRole('button', { name: 'Back to review', exact: true }).click();
  await view.waitFor({ state: 'hidden' });
}

async function choose(page, label, value) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

try {
  await mkdir(repo);
  git('init', '-b', 'main');
  await writeFile(join(repo, 'review.ts'), 'export const ready = false;\n');
  git('add', '.'); git('commit', '-m', 'Initial code');
  git('checkout', '-b', firstBranch);
  await writeFile(join(repo, 'review.ts'), 'export const ready = true;\n');
  git('add', '.'); git('commit', '-m', 'Ready for review');
  git('branch', nextBranch); git('branch', noTicketBranch);
  await mkdir('artifacts', { recursive: true });

  let page = await launch();
  // Global settings must be usable before the first project exists.
  let dialog = await settings(page);
  assert.equal((await state(page)).projects.length, 0);
  // Exercise the real preload/main external-link path and Electron clipboard.
  // Preserve the system clipboard around this isolated permission check.
  await dialog.getByRole('link', { name: 'Create Jira API token', exact: true }).click();
  await waitForURLs(['https://id.atlassian.com/manage-profile/security/api-tokens']);
  await desktop.evaluate(() => { globalThis.__jiraSmokeURLs = []; });
  await desktop.evaluate(({ clipboard }) => { globalThis.__jiraSmokeClipboard = clipboard.readText(); });
  try {
    await dialog.getByRole('button', { name: 'Copy required scopes', exact: true }).click();
    await dialog.getByText('Scopes copied.', { exact: true }).waitFor();
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), 'read:jira-user\nread:jira-work', 'The real desktop permission policy must allow copying required scopes.');
    await dialog.getByRole('tab', { name: 'Bitbucket', exact: true }).click();
    const bitbucket = dialog.getByRole('tabpanel', { name: 'Bitbucket', exact: true });
    await bitbucket.getByRole('button', { name: 'Copy required scopes', exact: true }).click();
    await bitbucket.getByText('Scopes copied.', { exact: true }).waitFor();
    const bitbucketScopes = 'read:user:bitbucket\nread:repository:bitbucket\nwrite:repository:bitbucket\nread:pullrequest:bitbucket\nwrite:pullrequest:bitbucket';
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), bitbucketScopes, 'Bitbucket scope copy includes repository write for branch cleanup.');
    await assert.rejects(page.evaluate(() => window.reviewAPI.copyConnectionScopes('not-a-provider')), 'Unknown providers must be rejected by the main process.');
    assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), bitbucketScopes, 'Rejected inputs must leave the clipboard unchanged.');
  } finally {
    await desktop.evaluate(({ clipboard }) => { clipboard.writeText(globalThis.__jiraSmokeClipboard); delete globalThis.__jiraSmokeClipboard; });
  }
  await dialog.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
  const diagnostics = dialog.getByRole('tabpanel', { name: 'Diagnostics', exact: true });
  const logPath = join(dataDir, 'logs', 'integrations.log');
  await diagnostics.getByText(logPath, { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.reviewAPI.getIntegrationDiagnostics()), { path: logPath, available: true }, 'Desktop diagnostics must use the isolated test data directory.');
  await diagnostics.getByRole('button', { name: 'Open integration log', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#settings-panel-diagnostics button')?.disabled);
  assert.deepEqual(await desktop.evaluate(() => [...globalThis.__jiraSmokeLogPaths]), [logPath], 'Opening diagnostics reveals only the main-process log path.');
  await page.evaluate(() => window.reviewAPI.openIntegrationLog('/arbitrary-renderer-path'));
  assert.deepEqual(await desktop.evaluate(() => [...globalThis.__jiraSmokeLogPaths]), [logPath, logPath], 'Renderer inputs cannot change the revealed file.');
  await page.screenshot({ path: 'artifacts/settings-diagnostics.png', animations: 'disabled' });
  await dialog.getByRole('tab', { name: 'Jira', exact: true }).click();
  assert.equal(await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).inputValue(), '');
  await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Save link settings', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: /Enter a valid Jira base URL/ }).waitFor();
  assert.equal((await state(page)).settings.jiraBaseUrl, '');
  assert.deepEqual(await openedURLs(), []);
  await dialog.getByRole('button', { name: 'Back to review', exact: true }).click();

  await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.locator('#project-repo-path').fill(repo);
  await dialog.locator('#project-name').fill('Jira project');
  assert.equal(await dialog.locator('#project-repo-path').inputValue(), repo);
  assert.equal(await dialog.locator('#project-name').inputValue(), 'Jira project');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('tab', { name: 'Jira project', exact: true }).waitFor();
  await choose(page, 'Current target branch', 'main');
  await ticket(page, 'APP-123').waitFor();
  const currentId = (await state(page)).reviews.find(review => review.kind === 'current').id;

  // A detected key is still useful before configuration: it opens Settings.
  await ticket(page, 'APP-123').click();
  dialog = page.getByRole('region', { name: 'Settings', exact: true });
  await dialog.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await browserLinks(dialog);
  assert.deepEqual(await openedURLs(), []);
  await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).fill(` ${baseURL}/ `);
  await page.screenshot({ path: 'artifacts/jira-settings.png', animations: 'disabled' });
  await saveSettings(dialog);
  assert.equal((await state(page)).settings.jiraBaseUrl, baseURL);
  await ticket(page, 'APP-123').click();
  await waitForURLs([`${baseURL}/browse/APP-123`]);
  await page.screenshot({ path: 'artifacts/jira-ticket.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ticketBox = await ticket(page, 'APP-123').boundingBox();
  const settingsBox = await page.getByRole('button', { name: 'App settings', exact: true }).boundingBox();
  const actionsBox = await page.locator('.review-toolbar > .toolbar-actions').boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  assert.ok(ticketBox && ticketBox.width > 0 && ticketBox.x >= 0 && ticketBox.x + ticketBox.width <= viewportWidth, 'The Jira action must remain within the minimum window.');
  assert.ok(actionsBox && ticketBox.x + ticketBox.width <= actionsBox.x + 1, 'The Jira action must not overlap the review actions.');
  assert.ok(settingsBox && settingsBox.x >= 0 && settingsBox.x + settingsBox.width <= viewportWidth, 'Global settings must remain reachable at minimum width.');
  await page.screenshot({ path: 'artifacts/jira-ticket-minimum.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
  assert.deepEqual(errors, []);

  await desktop.close();
  page = await launch();
  await ticket(page, 'APP-123').waitFor();
  assert.equal((await state(page)).settings.jiraBaseUrl, baseURL, 'The normalized global setting must survive a restart.');
  dialog = await settings(page);
  assert.equal(await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).inputValue(), baseURL);
  await dialog.getByRole('button', { name: 'Back to review', exact: true }).click();

  // Pause background polling with its existing visibility guard. The main
  // process must resolve the new checkout even while Current still shows APP.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  git('checkout', nextBranch);
  assert.equal((await state(page)).reviews.find(review => review.id === currentId).featureBranch, firstBranch);
  await page.evaluate(id => window.reviewAPI.openJiraTicket(id), currentId);
  await waitForURLs([`${baseURL}/browse/OPS-456`]);
  await page.evaluate(() => { delete document.hidden; });
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await ticket(page, 'OPS-456').waitFor();
  assert.equal(await ticket(page, 'APP-123').count(), 0);

  // Saved reviews always open the ticket in their explicitly selected branch.
  await page.getByRole('button', { name: 'Review another branch', exact: true }).click();
  dialog = page.getByRole('dialog');
  await choose(page, 'Feature branch', firstBranch);
  await choose(page, 'Target branch', 'main');
  await dialog.locator('#review-name').fill('Pinned Jira review');
  await dialog.getByRole('button', { name: 'Create review', exact: true }).click();
  await ticket(page, 'APP-123').waitFor();
  git('checkout', noTicketBranch);
  await ticket(page, 'APP-123').click();
  await waitForURLs([`${baseURL}/browse/OPS-456`, `${baseURL}/browse/APP-123`]);
  await choose(page, 'Select review', 'Current');
  await page.locator('.feature-branch').filter({ hasText: noTicketBranch }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Open .+ in Jira$/ }).count(), 0, 'Branches without a key must not show a Jira action.');
  await assert.rejects(page.evaluate(id => window.reviewAPI.openJiraTicket(id), currentId), /does not contain a Jira ticket key/);
  assert.deepEqual(await openedURLs(), [`${baseURL}/browse/OPS-456`, `${baseURL}/browse/APP-123`]);

  dialog = await settings(page);
  await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).fill('');
  await saveSettings(dialog);
  assert.equal((await state(page)).settings.jiraBaseUrl, '');
  await choose(page, 'Select review', 'Pinned Jira review');
  await ticket(page, 'APP-123').click();
  dialog = page.getByRole('region', { name: 'Settings', exact: true });
  await dialog.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await browserLinks(dialog);
  assert.equal(await dialog.getByRole('textbox', { name: 'Jira base URL', exact: true }).inputValue(), '');
  assert.deepEqual(await openedURLs(), [`${baseURL}/browse/OPS-456`, `${baseURL}/browse/APP-123`]);
  await dialog.getByRole('button', { name: 'Back to review', exact: true }).click();
  assert.equal(JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8')).settings.jiraBaseUrl, '', 'Clearing the Jira URL must also persist to disk.');
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);
  console.log('Jira desktop smoke passed: full-page settings, isolated diagnostics and static log reveal, real scope clipboard and token-link handler, global settings, validation, normalization, restart persistence, context-path URLs, latest Current checkout, fixed saved branches, no-key branches, and clearing configuration. External opens were stubbed.');
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/jira-smoke-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 12000));
    console.error('Renderer errors:', errors);
  }
  throw error;
} finally {
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
