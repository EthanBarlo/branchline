import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-jira-browser-'));
const repo = join(fixture, 'checkout');
const entry = join(fixture, 'main.cjs');
const env = { ...process.env, BRANCHLINE_DATA_DIR: join(fixture, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
let desktop;

// Replace transport only. The production browser, preload, session isolation and
// main-process handlers run unchanged, without visiting Jira or using real tokens.
function installTransport() {
  const { app, safeStorage, shell, Menu } = require('electron');
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  safeStorage.isEncryptionAvailable = () => false;
  globalThis.jiraSmoke = { requests: [], apiRequests: [], pickerQueries: [], external: [] };
  Menu.prototype.popup = function () { globalThis.jiraSmoke.menu = this; };
  shell.openExternal = async url => { globalThis.jiraSmoke.external.push(url); };
  globalThis.fetch = async input => {
    const url = new URL(input);
    globalThis.jiraSmoke.apiRequests.push(url.href);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/_edge/tenant_info') return json({ cloudId: 'fake-cloud' });
    if (url.pathname.endsWith('/myself')) return json({ accountId: 'fake-user', displayName: 'Test Reviewer' });
    if (url.pathname.endsWith('/issue/picker')) {
      const query = url.searchParams.get('query') || '';
      globalThis.jiraSmoke.pickerQueries.push(query);
      if (query === 'denied') return json({ message: 'Issue search permission denied' }, 403);
      if (query === 'slow') {
        globalThis.jiraSmoke.slowPickerHeld = true;
        await new Promise(resolve => { globalThis.jiraSmoke.releaseSlowPicker = resolve; });
      }
      const issue = (key, summaryText, summary = summaryText) => ({ key, keyHtml: `<b>${key}</b>`, summaryText, summary });
      const issues = query === '' ? [issue('REC-101', 'Recently viewed incident', 'Recently <b>viewed</b> incident')]
        : query === 'build' ? [issue('BUILD-202', 'Repair build & release', 'Repair <b>build</b> &amp; release'), issue('SAFE-203', '<img src=x onerror=window.jiraPickerUnsafe=true>')]
          : query === 'slow' ? [issue('OLD-111', 'Stale search result')]
            : query === 'fast' ? [issue('FAST-222', 'Latest search result')]
              : [issue('MATCH-303', 'Matching Jira ticket')];
      return json({ sections: [{ id: query ? 'cs' : 'hs', label: query ? 'Current Search' : 'History Search', issues }] });
    }
    // Browser access must remain available when the API token cannot read issues.
    if (url.pathname.includes('/issue/')) return json({ message: 'No issue permission' }, 403);
    throw new Error(`Unmocked API request: ${url.href}`);
  };
  app.on('session-created', isolated => {
    isolated.protocol.handle('https', request => {
      globalThis.jiraSmoke.requests.push({ url: request.url, authorization: request.headers.get('authorization') });
      const html = `<!doctype html><html><head><title>Mock Jira</title></head><body>
        <h1>Mock Jira ticket</h1><form id="login"><label>Email <input id="email" type="email"></label>
        <label>Password <input id="password" type="password"></label><button>Sign in</button></form>
        <section id="issue" hidden><h2>APP-123</h2><label>Comment <textarea id="comment"></textarea></label>
        <button id="save">Add comment</button><p id="saved"></p></section>
        <a id="unsafe" href="file:///etc/passwd">Unsafe link</a>
        <button id="popup">Open sign-in popup</button>
        <script>
          const show = () => { const signedIn = document.cookie.includes('jira_session=mock'); document.querySelector('#login').hidden = signedIn; document.querySelector('#issue').hidden = !signedIn; };
          document.querySelector('#login').onsubmit = event => { event.preventDefault(); document.cookie = 'jira_session=mock; Secure; SameSite=Lax; Max-Age=86400; Path=/'; show(); };
          document.querySelector('#save').onclick = () => { document.querySelector('#saved').textContent = document.querySelector('#comment').value; };
          document.querySelector('#popup').onclick = () => window.open('https://login.example.invalid/signin', '_blank');
          show();
        </script></body></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN' } });
    });
  });
}

async function launch() {
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [entry], env, timeout: 30000 });
  // Electron's will-prevent-unload handler owns this native confirmation. Stop
  // Playwright from trying to answer the same dialog through Chrome DevTools.
  desktop.context().on('dialog', dialog => { if (dialog.type() !== 'beforeunload') void dialog.dismiss(); });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.reviewAPI);
  return page;
}

async function viewScript(kind, script) {
  return desktop.evaluate(async ({ BrowserWindow }, { kind, script }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const view = main?.contentView.children.find(view => {
      const url = view.webContents?.getURL();
      return kind === 'chrome' ? url?.endsWith('/jira-browser.html') : url?.startsWith('https:');
    });
    if (!view) throw new Error(`No embedded Jira ${kind} view.`);
    return view.webContents.executeJavaScript(script, true);
  }, { kind, script });
}
const contents = script => viewScript('website', script);
const chrome = script => viewScript('chrome', script);

async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if (await predicate()) return; } catch { /* Native views may be attaching, navigating or closing. */ }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
const waitForPage = () => until(() => contents('!!document.querySelector("#login")'), 'the embedded Jira fixture');
const waitForCompactToolbar = () => until(() => chrome("document.querySelector('header')?.getBoundingClientRect().height === 48"), 'the compact Jira toolbar');
const clickToolbar = action => chrome(`document.querySelector('[data-action="${action}"]').click(); true;`);

async function nativeViews() {
  return desktop.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    return { mainId: main.id, windows: BrowserWindow.getAllWindows().length, size: main.getContentSize(),
      views: main.contentView.children.filter(view => view.webContents).map(view => ({ id: view.webContents.id, url: view.webContents.getURL(), bounds: view.getBounds() })) };
  });
}
async function openTicket(page, ticket = 'APP-123') {
  await page.getByRole('button', { name: `View Jira ticket ${ticket}`, exact: true }).click();
  await page.getByRole('dialog', { name: `Jira ticket ${ticket}`, exact: true }).waitFor();
  await waitForPage();
  await waitForCompactToolbar();
  assert.equal((await nativeViews()).windows, 1, 'The full Jira ticket opens inside the existing Branchline window.');
}
async function waitForViewerClosed(page, ticket = 'APP-123') {
  await until(async () => !(await nativeViews()).views.some(view => view.url.endsWith('/jira-browser.html')), 'native Jira views to close');
  await page.getByRole('dialog', { name: `Jira ticket ${ticket}`, exact: true }).waitFor({ state: 'hidden' });
  assert.equal(page.isClosed(), false, 'Closing Jira keeps the review window alive.');
  assert.equal((await nativeViews()).windows, 1);
}

async function closeDesktop() {
  if (!desktop) return;
  const instance = desktop; desktop = undefined;
  let forced = false;
  const timeout = setTimeout(() => { forced = true; instance.process().kill('SIGKILL'); }, 10000);
  try { await instance.close(); } finally { clearTimeout(timeout); }
  assert.equal(forced, false, 'App shutdown must finish without forcing the test process to quit.');
}

try {
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, stdio: 'pipe', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-b', 'feature/APP-123');
  await writeFile(join(repo, 'file.txt'), 'review fixture\n'); git('add', '.'); git('commit', '-m', 'Fixture');
  await writeFile(entry, `(${installTransport.toString()})();\nrequire(${JSON.stringify(resolve('dist-electron/main.cjs'))});\n`);
  let page = await launch();
  const setup = await page.evaluate(async repoPath => {
    const api = window.reviewAPI;
    const first = await api.saveConnection({ kind: 'jira', email: 'one@example.invalid', token: 'fake-token', siteUrl: 'https://smoke.atlassian.net' });
    const second = await api.saveConnection({ kind: 'jira', email: 'two@example.invalid', token: 'second-fake-token', siteUrl: 'https://smoke.atlassian.net' });
    const project = await api.createProject({ repoPath, name: 'Jira browser test' });
    await api.configureProjectIntegration(project.id, { jiraConnectionId: first.id, repositories: [], updateSubmodulePointers: false });
    return { project, first, second, reviewId: `current:${project.id}` };
  }, repo);
  // The default entry point opens the full ticket directly, without an API
  // summary request or any additional BrowserWindow.
  await page.reload();
  await page.evaluate(() => { window.jiraClosedEvents = []; window.reviewAPI.onJiraBrowserClosed(id => window.jiraClosedEvents.push(id)); });
  await openTicket(page);
  const mainId = (await nativeViews()).mainId;
  assert.equal(await page.getByRole('dialog', { name: 'Jira ticket', exact: true }).count(), 0, 'No intermediate summary dialog opens.');
  assert.equal((await desktop.evaluate(() => globalThis.jiraSmoke.apiRequests)).filter(url => url.includes('/issue/') && !url.includes('/issue/picker')).length, 0, 'The full-page default does not require an issue API request.');
  console.log('One click opened the full Jira page inside the review window.');
  assert.match(await chrome("document.querySelector('#connection').textContent"), /one@example.invalid/);
  assert.match(await chrome("document.querySelector('#origin').textContent"), /https:\/\/smoke.atlassian.net/);
  const assertToolbarFits = async () => {
    const layout = await chrome("({ height: document.querySelector('header').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth, originWidth: document.querySelector('#origin').getBoundingClientRect().width })");
    assert.equal(layout.height, 48, 'Ready Jira uses a single compact row.');
    assert.equal(layout.overflow, false, 'All toolbar controls fit without horizontal scrolling.');
    assert.ok(layout.originWidth >= 140, 'The website origin remains visible.');
    const native = await nativeViews();
    const toolbar = native.views.find(view => view.url.endsWith('/jira-browser.html')).bounds;
    const website = native.views.find(view => view.url.startsWith('https:')).bounds;
    const surface = await page.locator('.jira-browser-surface').boundingBox();
    assert.ok(surface, 'The native views have a visible modal surface.');
    assert.ok(surface.width > Math.min(native.size[0], 1500) * .85, 'The full Jira page uses most of the available review window.');
    assert.equal(native.mainId, mainId);
    assert.equal(native.windows, 1);
    assert.equal(toolbar.height, layout.height);
    assert.equal(website.x, toolbar.x);
    assert.equal(website.y, toolbar.y + toolbar.height);
    assert.equal(website.width, toolbar.width);
    assert.ok(Math.abs(toolbar.x - surface.x) <= 1 && Math.abs(toolbar.y - surface.y) <= 1, 'Native Jira views align with the modal surface.');
    assert.ok(Math.abs(website.height + toolbar.height - surface.height) <= 1, 'Jira fills the modal below its compact toolbar.');
    assert.ok(website.x >= 0 && website.y >= 0 && website.x + website.width <= native.size[0] && website.y + website.height <= native.size[1], 'Native views remain within the main window.');
  };
  await assertToolbarFits();
  await desktop.evaluate(({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    app.focus({ steal: true }); main.show(); main.focus(); main.webContents.focus();
  });
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Tab');
  await until(() => desktop.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL().endsWith('/jira-browser.html')), 'Tab from the modal footer to focus the native Jira controls');
  const oldWidth = (await nativeViews()).views.find(view => view.url.endsWith('/jira-browser.html')).bounds.width;
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(1050, 700);
  });
  await until(async () => (await nativeViews()).views.find(view => view.url.endsWith('/jira-browser.html')).bounds.width < oldWidth, 'Jira modal to resize with the main window');
  await assertToolbarFits();
  await clickToolbar('menu');
  await until(() => desktop.evaluate(() => !!globalThis.jiraSmoke.menu), 'the Jira browser options menu');
  assert.ok((await desktop.evaluate(() => globalThis.jiraSmoke.menu.items.map(item => item.label))).some(label => label.includes('one@example.invalid')), 'Connection details remain available in the native options menu.');
  assert.deepEqual(await contents('({ require: typeof require, process: typeof process, reviewAPI: typeof window.reviewAPI })'), { require: 'undefined', process: 'undefined', reviewAPI: 'undefined' });
  await contents(`document.querySelector('#email').value='test@example.invalid'; document.querySelector('#password').value='not-a-real-password'; document.querySelector('#login').requestSubmit(); document.querySelector('#comment').value='Mock comment'; document.querySelector('#save').click();`);
  assert.equal(await contents('document.querySelector("#saved").textContent'), 'Mock comment');
  assert.equal(await contents('document.querySelector("#issue").hidden'), false);
  const initialViews = await nativeViews();
  const toolbarBounds = initialViews.views.find(view => view.url.endsWith('/jira-browser.html')).bounds;
  const websiteBounds = initialViews.views.find(view => view.url.startsWith('https:')).bounds;
  const bounds = { ...toolbarBounds, height: toolbarBounds.height + websiteBounds.height };
  const viewerId = await page.evaluate(({ reviewId, bounds }) => window.reviewAPI.openJiraBrowser(reviewId, bounds), { reviewId: setup.reviewId, bounds });
  assert.equal(typeof viewerId, 'string');
  assert.deepEqual((await nativeViews()).views.map(view => view.id), initialViews.views.map(view => view.id), 'Repeated opens reuse the existing embedded native views.');
  assert.equal((await nativeViews()).windows, 1);
  await assert.rejects(() => page.evaluate(({ viewerId, bounds }) => window.reviewAPI.resizeJiraBrowser(viewerId, { ...bounds, width: -1 }), { viewerId, bounds }), /bounds are invalid/);
  const size = (await nativeViews()).size;
  await page.evaluate(({ viewerId, size }) => window.reviewAPI.resizeJiraBrowser(viewerId, { x: size[0] - 12, y: size[1] - 12, width: 99999, height: 99999 }), { viewerId, size });
  assert.ok((await nativeViews()).views.every(view => view.bounds.x + view.bounds.width <= size[0] && view.bounds.y + view.bounds.height <= size[1]), 'Oversized native rectangles are clipped to the main window.');
  await page.evaluate(({ viewerId, bounds }) => window.reviewAPI.resizeJiraBrowser(viewerId, bounds), { viewerId, bounds });
  await assertToolbarFits();
  await clickToolbar('external');
  await until(async () => (await desktop.evaluate(() => globalThis.jiraSmoke.external)).length === 1, 'Open in browser');
  assert.deepEqual(await desktop.evaluate(() => globalThis.jiraSmoke.external), ['https://smoke.atlassian.net/browse/APP-123']);
  await contents('document.querySelector("#unsafe").click()');
  assert.equal(await contents('location.protocol'), 'https:');
  const trust = await desktop.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const remote = host.contentView.children.find(view => view.webContents?.getURL().startsWith('https:')).webContents;
    const event = { sender: remote, senderFrame: remote.mainFrame };
    const result = [];
    for (const [channel, args] of [['review:state', []], ['jira-browser:action', ['external']], ['jira-browser:resize', [100]], ['review:jira-browser-resize', ['untrusted', { x: 0, y: 0, width: 800, height: 600 }]], ['review:jira-browser-close', ['untrusted']], ['review:jira-browser-focus', ['untrusted']], ['review:jira-ticket-suggestions', ['untrusted', 'query']]]) {
      try { await ipcMain._invokeHandlers.get(channel)(event, ...args); result.push('allowed'); } catch (error) { result.push(error.message); }
    }
    return result;
  });
  assert.match(trust[0], /review window/); assert.match(trust[1], /toolbar/); assert.match(trust[2], /toolbar/); assert.match(trust[3], /review window/); assert.match(trust[4], /review window/); assert.match(trust[5], /review window/); assert.match(trust[6], /review window/);
  await desktop.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    host.contentView.children.find(view => view.webContents?.getURL().startsWith('https:')).webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://smoke.atlassian.net/browse/APP-123', true);
  });
  await until(() => chrome("document.querySelector('header').getBoundingClientRect().height > 48"), 'the temporary load-error notice');
  const noticeHeight = await chrome("document.querySelector('header').getBoundingClientRect().height");
  assert.ok(noticeHeight > 48 && noticeHeight <= 160, 'A load error expands the toolbar only while it is needed.');
  await clickToolbar('reload'); await waitForPage();
  await waitForCompactToolbar();
  console.log('Website editing and isolation verified.');
  await contents('document.querySelector("#popup").click()');
  for (let i = 0; i < 100 && !desktop.windows().some(item => item.url().startsWith('https://login.example.invalid')); i++) await delay(50);
  const popup = desktop.windows().find(item => item.url().startsWith('https://login.example.invalid'));
  assert.ok(popup, 'HTTPS sign-in popups open inside the isolated session.');
  assert.equal(await popup.evaluate(() => typeof window.reviewAPI), 'undefined');
  await clickToolbar('close').catch(error => { if (!/destroyed|closed/.test(error.message)) throw error; });
  await waitForViewerClosed(page);
  assert.ok((await page.evaluate(() => window.jiraClosedEvents)).includes(viewerId), 'Native close identifies the embedded viewer through the trusted preload event.');
  assert.ok(popup.isClosed(), 'Closing the viewer closes its sign-in popups.');
  console.log('Closed Jira and its sign-in popup.');
  await openTicket(page);
  assert.equal(await contents('document.querySelector("#issue").hidden'), false, 'Reopening retains sign-in.');
  await desktop.evaluate(({ dialog }) => {
    globalThis.jiraSmoke.originalDialog = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = () => 0;
  });
  await contents(`window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; return ''; }; true;`);
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Ticket details', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.jira-browser-details')?.disabled === false);
  assert.equal(await page.getByRole('dialog', { name: 'Jira ticket', exact: true }).count(), 0, 'Cancelling beforeunload keeps the website instead of switching to the summary.');
  await assert.rejects(() => page.evaluate(id => window.reviewAPI.disconnectConnection(id), setup.first.id), /unsaved changes/);
  assert.equal(await contents('document.querySelector("#issue").hidden'), false, 'Staying on an unsaved ticket cancels disconnect and preserves cookies.');
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).close();
  });
  await page.getByText('Jira is still open. Save your edits before closing.', { exact: true }).waitFor();
  assert.equal(page.isClosed(), false, 'The review window stays open when Jira cancels closing.');
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page);
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = globalThis.jiraSmoke.originalDialog; });
  await page.evaluate(async ({ project, second }) => {
    await window.reviewAPI.configureProjectIntegration(project.id, { jiraConnectionId: second.id, repositories: [], updateSubmodulePointers: false });
  }, setup);
  await page.reload(); await openTicket(page);
  assert.equal(await contents('document.querySelector("#issue").hidden'), true, 'Different Jira connections never reuse browser sign-in.');
  await page.evaluate(id => window.reviewAPI.disconnectConnection(id), setup.second.id);
  await page.evaluate(async ({ project, first }) => {
    await window.reviewAPI.configureProjectIntegration(project.id, { jiraConnectionId: first.id, repositories: [], updateSubmodulePointers: false });
  }, setup);
  await page.reload(); await openTicket(page);
  assert.equal(await contents('document.querySelector("#issue").hidden'), false);
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    await host.contentView.children.find(view => view.webContents?.getURL().startsWith('https:')).webContents.session.cookies.flushStore();
  });
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page);
  console.log('Account isolation verified; restarting the app.');
  await closeDesktop();
  page = await launch();
  await openTicket(page);
  assert.equal(await contents('document.querySelector("#issue").hidden'), false, 'Sign-in survives application restart.');
  await assert.rejects(() => page.evaluate(() => window.reviewAPI.installUpdate()), /Close (?:the )?Jira/);
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await desktop.evaluate(({ BrowserWindow, ipcMain }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const isolated = main.contentView.children.find(view => view.webContents?.getURL().startsWith('https:')).webContents.session;
    const clear = isolated.clearStorageData;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    isolated.clearStorageData = async function (...args) { globalThis.jiraSmoke.resetHeld = true; await gate; return clear.apply(this, args); };
    const resize = ipcMain._invokeHandlers.get('review:jira-browser-resize');
    ipcMain._invokeHandlers.set('review:jira-browser-resize', async (...args) => {
      const result = await resize(...args);
      if (globalThis.jiraSmoke.resetHeld) globalThis.jiraSmoke.resizedDuringReset = args[2];
      return result;
    });
    globalThis.jiraSmoke.releaseReset = () => { isolated.clearStorageData = clear; ipcMain._invokeHandlers.set('review:jira-browser-resize', resize); release(); };
  });
  await clickToolbar('menu');
  await desktop.evaluate(() => {
    const reset = globalThis.jiraSmoke.menu.getMenuItemById('jira-reset-sign-in');
    reset.click();
  });
  try {
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.resetHeld), 'the delayed Jira session reset');
    const width = await page.evaluate(() => innerWidth);
    await desktop.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(width > 1250 ? 1100 : 1400, 820);
    }, width);
    await until(() => desktop.evaluate(() => !!globalThis.jiraSmoke.resizedDuringReset), 'the modal resize while native views are detached');
  } finally { await desktop.evaluate(() => globalThis.jiraSmoke.releaseReset()); }
  await until(() => contents('document.querySelector("#issue")?.hidden === true'), 'reset sign-in to reopen a logged-out ticket');
  await waitForPage();
  await waitForCompactToolbar();
  await assertToolbarFits();
  assert.equal(await contents('document.querySelector("#issue").hidden'), true, 'Reset sign-in clears the account session and reopens the ticket.');
  await contents('document.querySelector("#login").requestSubmit(); true;');
  assert.equal(await contents('document.querySelector("#issue").hidden'), false);
  await page.evaluate(id => window.reviewAPI.disconnectConnection(id), setup.first.id);
  await openTicket(page);
  assert.equal(await contents('document.querySelector("#issue").hidden'), true, 'Disconnect clears browser cookies.');
  assert.ok((await desktop.evaluate(() => globalThis.jiraSmoke.requests)).every(request => request.authorization === null), 'Browser navigation never receives API authorization.');
  await mkdir('artifacts', { recursive: true });
  const screenshot = await desktop.evaluate(async ({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    return { host: (await host.capturePage()).toPNG().toString('base64'),
      toolbar: (await host.contentView.children.find(view => view.webContents?.getURL().endsWith('/jira-browser.html')).webContents.capturePage()).toPNG().toString('base64'),
      website: (await host.contentView.children.find(view => view.webContents?.getURL().startsWith('https:')).webContents.capturePage()).toPNG().toString('base64') };
  });
  // Electron captures each WebContents separately; the host capture deliberately
  // omits its native child surfaces, whose alignment is verified above.
  await writeFile('artifacts/jira-browser-modal-host.png', Buffer.from(screenshot.host, 'base64'));
  await writeFile('artifacts/jira-browser.png', Buffer.from(screenshot.toolbar, 'base64'));
  await writeFile('artifacts/jira-browser-website.png', Buffer.from(screenshot.website, 'base64'));
  await desktop.evaluate(({ BrowserWindow, ipcMain, dialog }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    const chrome = main.contentView.children.find(view => view.webContents?.getURL().endsWith('/jira-browser.html')).webContents;
    dialog.showMessageBox = () => new Promise(resolve => { globalThis.jiraSmoke.answerReset = resolve; });
    const event = { sender: chrome, senderFrame: chrome.mainFrame };
    globalThis.jiraSmoke.pendingReset = ipcMain._invokeHandlers.get('jira-browser:action')(event, 'reset').then(() => { globalThis.jiraSmoke.resetSettled = true; });
  });
  await until(() => desktop.evaluate(() => !!globalThis.jiraSmoke.answerReset), 'the pending reset confirmation');
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page);
  await desktop.evaluate(() => globalThis.jiraSmoke.answerReset({ response: 1, checkboxChecked: false }));
  await until(() => desktop.evaluate(() => globalThis.jiraSmoke.resetSettled), 'the cancelled viewer reset to settle');
  assert.equal((await nativeViews()).views.length, 0, 'Confirming reset after the ticket closes does not reopen native views over the review.');
  assert.equal(page.isClosed(), false);
  await page.evaluate(id => window.reviewAPI.saveConnection({ id, kind: 'jira', email: 'one@example.invalid', token: 'fake-token', siteUrl: 'https://smoke.atlassian.net' }), setup.first.id);
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Jira', exact: true }).click();
  assert.equal(await page.getByLabel('Default ticket view', { exact: true }).inputValue(), 'website');
  await page.getByLabel('Default ticket view', { exact: true }).selectOption('summary');
  await page.getByText('Preference saved', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.reviewAPI.getState())).settings.jiraTicketView, 'summary');
  await page.getByRole('button', { name: 'Back to review', exact: true }).click();
  await page.getByRole('button', { name: 'View Jira ticket APP-123', exact: true }).click();
  const ticketDialog = page.getByRole('dialog', { name: 'Jira ticket', exact: true });
  await ticketDialog.getByRole('alert').filter({ hasText: /403/ }).waitFor();
  assert.equal((await nativeViews()).views.length, 0, 'The opt-in summary creates no native website views.');
  await ticketDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await closeDesktop();
  page = await launch();
  assert.equal((await page.evaluate(() => window.reviewAPI.getState())).settings.jiraTicketView, 'summary');
  await page.getByRole('button', { name: 'View Jira ticket APP-123', exact: true }).click();
  const persistedSummary = page.getByRole('dialog', { name: 'Jira ticket', exact: true });
  await persistedSummary.getByRole('alert').waitFor();
  assert.equal((await nativeViews()).views.length, 0, 'Summary remains the selected view after restart.');
  await persistedSummary.getByRole('button', { name: 'Open in Branchline', exact: true }).click();
  await waitForPage();
  assert.equal((await nativeViews()).windows, 1, 'Summary can switch to the full page in the same main window.');
  await page.getByRole('dialog', { name: 'Jira ticket APP-123', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page);
  await page.evaluate(id => window.reviewAPI.saveConnection({ id, kind: 'jira', email: 'one@example.invalid', token: 'fake-token', siteUrl: 'https://smoke.atlassian.net' }), setup.first.id);
  await page.evaluate(() => window.reviewAPI.updateSettings({ jiraTicketView: 'website' }));
  await page.reload();
  let fullTicket, picker, keyInput, useTicket, suggestions, recentOption;
  const bindTicketControls = () => {
    fullTicket = page.locator('.jira-browser-modal:not(.jira-browser-picker)');
    picker = page.getByRole('dialog', { name: 'Choose a Jira ticket', exact: true });
    keyInput = picker.getByRole('combobox', { name: 'Review ticket key', exact: true });
    useTicket = picker.getByRole('button', { name: 'Use ticket', exact: true });
    suggestions = picker.getByRole('listbox');
    recentOption = suggestions.getByRole('option').filter({ hasText: 'REC-101' });
  };
  bindTicketControls();
  const savedTicket = async () => JSON.parse(await readFile(join(env.BRANCHLINE_DATA_DIR, 'integrations.json'), 'utf8')).tickets?.[setup.reviewId];
  const linkedTicket = () => page.evaluate(id => window.reviewAPI.getJiraTicketLink(id), setup.reviewId);
  const issueRequestCount = async () => (await desktop.evaluate(() => globalThis.jiraSmoke.apiRequests)).filter(url => url.includes('/issue/') && !url.includes('/issue/picker')).length;
  const issueRequestsBeforeChoosing = await issueRequestCount();
  const assertSelected = async ticket => {
    await page.getByRole('dialog', { name: `Jira ticket ${ticket}`, exact: true }).waitFor();
    await until(() => contents(`location.href === "https://smoke.atlassian.net/browse/${ticket}"`), 'the selected Jira ticket');
    await waitForPage(); await waitForCompactToolbar();
    assert.equal(await fullTicket.getByRole('combobox', { name: 'Review ticket key', exact: true }).count(), 0, 'The selected Jira page has no ticket selector.');
    assert.equal(await fullTicket.locator('.jira-browser-footer form').count(), 0, 'The full page footer has no ticket form.');
    assert.equal(await chrome("document.querySelector('#ticket').textContent"), ticket);
    assert.equal(await chrome("document.querySelector('[data-action=\"clear-ticket\"]')?.getAttribute('aria-label')"), 'Clear ticket');
    assert.equal((await nativeViews()).windows, 1);
  };
  const assertPicker = async () => {
    await picker.waitFor();
    await until(async () => (await nativeViews()).views.length === 0, 'native Jira views to detach before choosing another ticket');
    await until(() => keyInput.isEnabled(), 'the ticket chooser to become ready');
    assert.equal(await linkedTicket(), null);
    const bounds = await picker.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(bounds && bounds.width >= 300 && bounds.width <= 650 && bounds.height <= 450, 'The ticket chooser is a compact dialog.');
    assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 20 && Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2) <= 20, 'The compact chooser stays centered in the review window.');
  };
  const clearSelectedTicket = async () => {
    await clickToolbar('clear-ticket').catch(error => { if (!/destroyed|closed/.test(error.message)) throw error; });
    await assertPicker();
    assert.equal(await savedTicket(), null, 'Clearing persists an explicit empty ticket selection.');
  };
  const closePicker = async () => {
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
  };
  const chooseManually = async key => {
    await keyInput.fill(key);
    if (await keyInput.getAttribute('aria-expanded') === 'true') await keyInput.press('Escape');
    await useTicket.click();
    await assertSelected(key.toUpperCase());
    assert.equal(await savedTicket(), key.toUpperCase());
  };

  await openTicket(page);
  await assertSelected('APP-123');
  await contents('document.querySelector("#login").requestSubmit(); true;');
  await clearSelectedTicket();
  assert.equal(git('branch', '--show-current').toString().trim(), 'feature/APP-123');
  await closePicker();
  await page.reload();
  await page.getByRole('button', { name: 'View Jira ticket', exact: true }).click();
  await assertPicker();
  assert.equal(await savedTicket(), null, 'Reopening a cleared review does not restore its branch-derived Jira ticket.');
  assert.equal(await keyInput.inputValue(), '');
  await keyInput.fill('not a ticket');
  if (await keyInput.getAttribute('aria-expanded') === 'true') await keyInput.press('Escape');
  await useTicket.click();
  await picker.getByRole('alert').filter({ hasText: /(?:ticket|issue) key/i }).waitFor();
  assert.equal(await savedTicket(), null, 'Invalid input cannot alter the cleared ticket selection.');
  assert.equal((await nativeViews()).views.length, 0, 'Invalid input creates no native website views.');
  await chooseManually('ops-789');
  assert.equal(await contents('document.querySelector("#issue").hidden'), false, 'Clearing and choosing another ticket retains the Jira login.');
  await fullTicket.getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page, 'OPS-789');
  await desktop.evaluate(({ ipcMain }, reviewId) => {
    const channel = 'review:jira-ticket-link';
    const original = ipcMain._invokeHandlers.get(channel);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.jiraSmoke.ticketLinkCalls = 0;
    ipcMain._invokeHandlers.set(channel, async (event, id) => {
      if (id === reviewId && ++globalThis.jiraSmoke.ticketLinkCalls === 1) {
        globalThis.jiraSmoke.firstTicketLinkHeld = true;
        await gate;
      }
      return original(event, id);
    });
    globalThis.jiraSmoke.releaseTicketLink = () => {
      ipcMain._invokeHandlers.set(channel, original);
      globalThis.jiraSmoke.firstTicketLinkReleased = true;
      release();
    };
  }, setup.reviewId);
  try {
    await page.reload();
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.firstTicketLinkHeld), 'the delayed initial ticket lookup');
    const ticketButton = page.getByRole('button', { name: /^View Jira ticket(?: [A-Z][A-Z0-9]*-[1-9][0-9]*)?$/ });
    await ticketButton.waitFor();
    const callsBeforeOpening = await desktop.evaluate(() => globalThis.jiraSmoke.ticketLinkCalls);
    console.log('Held ticket lookup before opening:', JSON.stringify({ label: await ticketButton.getAttribute('aria-label'), calls: callsBeforeOpening }));
    await ticketButton.click();
    await assertSelected('OPS-789');
    assert.equal(await savedTicket(), 'OPS-789');
    const earlyOpen = await desktop.evaluate(() => ({ calls: globalThis.jiraSmoke.ticketLinkCalls, released: !!globalThis.jiraSmoke.firstTicketLinkReleased }));
    assert.ok(earlyOpen.calls > callsBeforeOpening, 'The modal resolves its saved ticket independently of the unfinished header lookup.');
    assert.equal(earlyOpen.released, false);
  } finally { await desktop.evaluate(() => globalThis.jiraSmoke.releaseTicketLink()); }

  const originalViews = (await nativeViews()).views.map(view => view.id);
  await desktop.evaluate(({ dialog }) => {
    globalThis.jiraSmoke.clearOriginalDialog = dialog.showMessageBoxSync;
    dialog.showMessageBoxSync = () => { globalThis.jiraSmoke.clearPrompts = (globalThis.jiraSmoke.clearPrompts || 0) + 1; return 0; };
  });
  await contents(`window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; return ''; }; true;`);
  try {
    await clickToolbar('clear-ticket');
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.clearPrompts === 1), 'the unsaved-edit confirmation for clearing');
    await until(() => fullTicket.getByRole('button', { name: 'Ticket details', exact: true }).isEnabled(), 'the cancelled clear action');
    assert.equal(await savedTicket(), 'OPS-789', 'Staying with unsaved edits leaves ticket metadata unchanged.');
    assert.equal((await linkedTicket()).key, 'OPS-789');
    assert.deepEqual((await nativeViews()).views.map(view => view.id), originalViews, 'Staying preserves the existing native Jira views.');
    assert.equal(await picker.count(), 0);
    await assertSelected('OPS-789');
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    await clearSelectedTicket();
  } finally { await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = globalThis.jiraSmoke.clearOriginalDialog; }); }

  if (await keyInput.getAttribute('aria-expanded') === 'true') await keyInput.press('Escape');
  const collapsedPicker = await picker.boundingBox();
  const assertSuggestionsVisible = async () => {
    await suggestions.waitFor();
    const bounds = await picker.boundingBox();
    for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(bounds[axis] - collapsedPicker[axis]) <= 1, 'Search suggestions do not move or resize the compact dialog.');
    const popup = await picker.locator('.jira-ticket-popup').boundingBox();
    const input = await keyInput.boundingBox();
    assert.ok(popup && input && popup.y >= input.y + input.height - 1, 'Ticket suggestions float below the input.');
    assert.equal((await nativeViews()).views.length, 0, 'The chooser never overlays an embedded native website.');
    assert.equal(await suggestions.locator('img, b').count(), 0, 'Jira highlight HTML is not injected into ticket suggestions.');
  };
  await keyInput.click();
  await recentOption.waitFor();
  assert.match(await recentOption.innerText(), /Recently viewed incident/);
  assert.ok((await desktop.evaluate(() => globalThis.jiraSmoke.pickerQueries)).includes(''), 'Opening the selector requests Jira recent history.');
  await assertSuggestionsVisible();
  await page.screenshot({ path: '/private/tmp/branchline-jira-compact-picker.png' });
  await keyInput.press('Escape');
  await suggestions.waitFor({ state: 'hidden' });
  assert.equal(await picker.isVisible(), true, 'Escape dismisses suggestions without closing the chooser.');
  await keyInput.click(); await recentOption.click();
  await assertSelected('REC-101');
  assert.equal(await savedTicket(), 'REC-101');
  assert.equal(await contents('document.querySelector("#issue").hidden'), false, 'Selecting a recent ticket keeps Jira signed in.');
  const selectedHeader = await desktop.evaluate(async ({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    return (await host.contentView.children.find(view => view.webContents?.getURL().endsWith('/jira-browser.html')).webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile('/private/tmp/branchline-jira-selected-header.png', Buffer.from(selectedHeader, 'base64'));

  await clearSelectedTicket();
  const searchQueryStart = (await desktop.evaluate(() => globalThis.jiraSmoke.pickerQueries)).length;
  await keyInput.fill('b'); await keyInput.fill('bu'); await keyInput.fill('build');
  await suggestions.getByRole('option').filter({ hasText: 'BUILD-202' }).waitFor();
  assert.match(await suggestions.innerText(), /Repair build & release/);
  assert.match(await suggestions.innerText(), /<img src=x onerror=window\.jiraPickerUnsafe=true>/, 'Untrusted plain titles remain literal text.');
  assert.equal(await page.evaluate(() => window.jiraPickerUnsafe), undefined);
  const typedQueries = (await desktop.evaluate(() => globalThis.jiraSmoke.pickerQueries)).slice(searchQueryStart);
  assert.equal(typedQueries.filter(query => query === 'build').length, 1, 'Rapid typing produces one debounced search.');
  assert.equal(typedQueries.some(query => query === 'b' || query === 'bu'), false, 'Intermediate keystrokes do not make API requests.');
  await assertSuggestionsVisible();
  await keyInput.press('ArrowDown');
  const chosenKey = await keyInput.evaluate(input => document.getElementById(input.getAttribute('aria-activedescendant'))?.textContent?.match(/(?:BUILD-202|SAFE-203)/)?.[0]);
  assert.ok(chosenKey, 'ArrowDown makes a result active through aria-activedescendant.');
  await keyInput.press('Enter');
  await assertSelected(chosenKey);
  assert.equal(await savedTicket(), chosenKey);

  await clearSelectedTicket();
  await keyInput.fill('slow');
  await until(() => desktop.evaluate(() => globalThis.jiraSmoke.slowPickerHeld), 'the delayed first search');
  try {
    await keyInput.fill('fast');
    await suggestions.getByRole('option').filter({ hasText: 'FAST-222' }).waitFor();
  } finally { await desktop.evaluate(() => globalThis.jiraSmoke.releaseSlowPicker()); }
  await delay(350);
  assert.equal(await suggestions.getByRole('option').filter({ hasText: 'OLD-111' }).count(), 0, 'An older response cannot replace the latest search.');
  await suggestions.getByRole('option').filter({ hasText: 'FAST-222' }).waitFor();
  await keyInput.press('Enter');
  await assertSelected('FAST-222');
  assert.equal(await savedTicket(), 'FAST-222', 'Enter selects the first title-search result without an arrow key.');
  await clearSelectedTicket();
  await keyInput.fill('denied');
  await picker.getByRole('alert').filter({ hasText: /403|permission/i }).waitFor();
  assert.equal((await nativeViews()).views.length, 0);
  assert.equal(await savedTicket(), null, 'Search errors leave the cleared selection unchanged.');
  await chooseManually('MANUAL-404');
  assert.equal(await page.getByRole('dialog', { name: 'Jira ticket', exact: true }).count(), 0, 'Choosing tickets never opens the API summary.');
  assert.equal(await issueRequestCount(), issueRequestsBeforeChoosing, 'Ticket selection uses local metadata and the picker endpoint without downloading issue summaries.');

  await clearSelectedTicket();
  await keyInput.fill('DIRECT-505');
  await suggestions.getByRole('option').filter({ hasText: 'MATCH-303' }).waitFor();
  assert.equal(await keyInput.getAttribute('aria-activedescendant'), null, 'A complete ticket key leaves search matches unselected.');
  await keyInput.press('Enter');
  await assertSelected('DIRECT-505');
  assert.equal(await savedTicket(), 'DIRECT-505', 'Enter opens an exact manually typed key instead of an unrelated suggestion.');
  await clearSelectedTicket();
  await closePicker();
  await desktop.evaluate(({ ipcMain }, reviewId) => {
    const channel = 'review:jira-ticket-link';
    const original = ipcMain._invokeHandlers.get(channel);
    ipcMain._invokeHandlers.set(channel, (event, id) => {
      if (id === reviewId) throw new Error('Mock ticket lookup failed');
      return original(event, id);
    });
    globalThis.jiraSmoke.restoreTicketLookup = () => ipcMain._invokeHandlers.set(channel, original);
  }, setup.reviewId);
  try {
    await page.getByRole('button', { name: 'View Jira ticket', exact: true }).click();
    await picker.getByRole('alert').filter({ hasText: 'Mock ticket lookup failed' }).waitFor();
    assert.equal((await nativeViews()).views.length, 0);
    await desktop.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      app.focus({ steal: true }); main.show(); main.focus(); main.webContents.focus();
    });
    await picker.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Close ticket picker'), 'Tab to wrap past hidden error controls to the visible picker close button');
    await page.keyboard.press('Shift+Tab');
    await until(() => page.evaluate(() => document.activeElement?.textContent === 'Cancel'), 'Shift+Tab to wrap back to the visible picker cancel button');
  } finally { await desktop.evaluate(() => globalThis.jiraSmoke.restoreTicketLookup()); }
  await picker.getByRole('button', { name: 'Try again', exact: true }).click();
  await picker.getByRole('alert').filter({ hasText: 'Mock ticket lookup failed' }).waitFor({ state: 'hidden' });
  await assertPicker();
  await closePicker();

  const detectCheckout = async branch => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(async () => (await page.locator('.feature-branch').innerText()) === (branch || 'Detached HEAD'), 'Current to detect the actual checkout through its focus refresh');
  };
  await closeDesktop();
  page = await launch(); bindTicketControls();
  await page.getByRole('button', { name: 'View Jira ticket', exact: true }).click();
  await assertPicker();
  assert.equal(await savedTicket(), null, 'An explicit clear survives restart on the same checkout branch.');
  await chooseManually('KEEP-900');
  await fullTicket.getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page, 'KEEP-900');
  await closeDesktop();
  page = await launch(); bindTicketControls();
  assert.equal(git('branch', '--show-current').toString().trim(), 'feature/APP-123');
  await openTicket(page, 'KEEP-900'); await assertSelected('KEEP-900');
  assert.equal(await savedTicket(), 'KEEP-900', 'A manual Current ticket survives restart on the same checkout branch.');

  git('checkout', '-b', 'feature/BRANCH-202');
  await detectCheckout('feature/BRANCH-202');
  await waitForViewerClosed(page, 'KEEP-900');
  assert.equal((await linkedTicket()).key, 'BRANCH-202');
  assert.equal(await savedTicket(), undefined, 'Changing the checkout expires the previous branch’s manual ticket.');
  await openTicket(page, 'BRANCH-202'); await assertSelected('BRANCH-202');
  git('checkout', '-b', 'bugfix/BRANCH-202-alternate');
  await detectCheckout('bugfix/BRANCH-202-alternate');
  await waitForViewerClosed(page, 'BRANCH-202');
  assert.equal((await linkedTicket()).key, 'BRANCH-202', 'A distinct checkout closes the old modal even when both branch names identify the same Jira ticket.');
  await openTicket(page, 'BRANCH-202');

  await clearSelectedTicket();
  git('checkout', '-b', 'feature/CLEAR-303');
  await detectCheckout('feature/CLEAR-303');
  await picker.waitFor({ state: 'hidden' });
  assert.equal((await linkedTicket()).key, 'CLEAR-303');
  assert.equal(await savedTicket(), undefined, 'A new checkout also expires an explicit cleared ticket.');
  await openTicket(page, 'CLEAR-303');
  await clearSelectedTicket(); await chooseManually('KEYLESS-404');
  git('checkout', '-b', 'current-work');
  await detectCheckout('current-work');
  await waitForViewerClosed(page, 'KEYLESS-404');
  assert.equal(await linkedTicket(), null, 'A keyless branch does not inherit the last branch’s manual ticket.');
  await page.getByRole('button', { name: 'View Jira ticket', exact: true }).click();
  await assertPicker(); await chooseManually('DET-707');
  git('checkout', '--detach', 'HEAD');
  await detectCheckout(null);
  await waitForViewerClosed(page, 'DET-707');
  assert.equal(await linkedTicket(), null, 'Detached HEAD does not inherit the previous branch’s manual ticket.');
  assert.equal(await savedTicket(), undefined);

  git('checkout', 'feature/CLEAR-303');
  await detectCheckout('feature/CLEAR-303');
  await openTicket(page, 'CLEAR-303');
  await clearSelectedTicket(); await chooseManually('PIN-606');
  await contents('document.querySelector("#login").requestSubmit(); document.querySelector("#comment").value = "Unsaved note before changing branch"; true;');
  const pinnedViews = (await nativeViews()).views.map(view => view.id);
  await desktop.evaluate(({ dialog }) => {
    globalThis.jiraSmoke.branchOriginalDialog = dialog.showMessageBoxSync;
    globalThis.jiraSmoke.branchPrompts = 0;
    dialog.showMessageBoxSync = () => { globalThis.jiraSmoke.branchPrompts++; return 0; };
  });
  await contents(`window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; return ''; }; true;`);
  try {
    git('checkout', '-b', 'feature/NEXT-808');
    await detectCheckout('feature/NEXT-808');
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.branchPrompts === 1), 'the branch-change unsaved-edit confirmation');
    await until(() => fullTicket.getByRole('button', { name: 'Close', exact: true }).isEnabled(), 'the cancelled branch-change close');
    assert.deepEqual((await nativeViews()).views.map(view => view.id), pinnedViews, 'Stay keeps the existing native Jira page after Current changes branch.');
    assert.equal(await contents('location.href'), 'https://smoke.atlassian.net/browse/PIN-606');
    assert.equal(await contents('document.querySelector("#comment").value'), 'Unsaved note before changing branch');
    assert.equal((await linkedTicket()).key, 'NEXT-808', 'Current resolves the new branch while the old Jira page stays open for editing.');
    await assertSelected('PIN-606');
    assert.equal(await savedTicket(), undefined);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await delay(4500);
    assert.equal(await desktop.evaluate(() => globalThis.jiraSmoke.branchPrompts), 1, 'Focus refresh and the next background poll do not repeat a declined close prompt.');
    assert.deepEqual((await nativeViews()).views.map(view => view.id), pinnedViews);
    assert.equal(await contents('document.querySelector("#comment").value'), 'Unsaved note before changing branch');
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => { globalThis.jiraSmoke.branchPrompts++; return 1; }; });
    await clickToolbar('clear-ticket').catch(error => { if (!/destroyed|closed/.test(error.message)) throw error; });
    await waitForViewerClosed(page, 'PIN-606');
    assert.equal(await desktop.evaluate(() => globalThis.jiraSmoke.branchPrompts), 2, 'Clearing the pinned page asks before leaving its unsaved edits.');
    assert.equal((await linkedTicket()).key, 'NEXT-808', 'Clearing an old pinned page cannot clear the new checkout’s ticket.');
    assert.equal(await savedTicket(), undefined, 'A stale clear action creates no null override for the new branch.');
  } finally {
    if ((await nativeViews()).views.some(view => view.url.startsWith('https:'))) await contents('window.onbeforeunload = null; true;');
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = globalThis.jiraSmoke.branchOriginalDialog; });
  }
  await openTicket(page, 'NEXT-808'); await assertSelected('NEXT-808');

  await contents('document.querySelector("#comment").value = "Unsaved during pending clear"; true;');
  await contents(`window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; return ''; }; true;`);
  const racingViews = (await nativeViews()).views.map(view => view.id);
  await desktop.evaluate(({ ipcMain, dialog }) => {
    const channel = 'review:jira-browser-close';
    const original = ipcMain._invokeHandlers.get(channel);
    const originalDialog = dialog.showMessageBoxSync;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    globalThis.jiraSmoke.clearBranchRacePrompts = 0;
    dialog.showMessageBoxSync = () => { globalThis.jiraSmoke.clearBranchRacePrompts++; return 0; };
    ipcMain._invokeHandlers.set(channel, async (...args) => {
      if (!held) { held = true; globalThis.jiraSmoke.pendingClearHeld = true; await gate; }
      return original(...args);
    });
    globalThis.jiraSmoke.releasePendingClear = () => { ipcMain._invokeHandlers.set(channel, original); release(); };
    globalThis.jiraSmoke.restorePendingClearDialog = () => { dialog.showMessageBoxSync = originalDialog; };
  });
  try {
    await clickToolbar('clear-ticket');
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.pendingClearHeld), 'the held native close requested by Clear');
    git('checkout', '-b', 'feature/RACE-909');
    await detectCheckout('feature/RACE-909');
    await desktop.evaluate(() => globalThis.jiraSmoke.releasePendingClear());
    await until(() => desktop.evaluate(() => globalThis.jiraSmoke.clearBranchRacePrompts >= 1), 'the pending Clear unsaved-edit confirmation');
    await until(() => fullTicket.getByRole('button', { name: 'Close', exact: true }).isEnabled(), 'Stay to finish the pending Clear');
    await assertSelected('NEXT-808');
    assert.deepEqual((await nativeViews()).views.map(view => view.id), racingViews);
    assert.equal(await contents('document.querySelector("#comment").value'), 'Unsaved during pending clear');
    assert.equal((await linkedTicket()).key, 'RACE-909');
    assert.equal(await savedTicket(), undefined, 'A cancelled Clear in flight during checkout cannot clear the new branch ticket.');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await delay(4500);
    assert.equal(await desktop.evaluate(() => globalThis.jiraSmoke.clearBranchRacePrompts), 1, 'Branch detection during a pending Clear does not queue another prompt after Stay.');
    assert.deepEqual((await nativeViews()).views.map(view => view.id), racingViews);
    assert.equal(await contents('document.querySelector("#comment").value'), 'Unsaved during pending clear');
  } finally {
    await desktop.evaluate(() => globalThis.jiraSmoke.releasePendingClear());
    if ((await nativeViews()).views.some(view => view.url.startsWith('https:'))) await contents('window.onbeforeunload = null; true;');
    await desktop.evaluate(() => globalThis.jiraSmoke.restorePendingClearDialog());
  }
  await fullTicket.getByRole('button', { name: 'Close', exact: true }).click();
  await waitForViewerClosed(page, 'NEXT-808');
  await openTicket(page, 'RACE-909'); await assertSelected('RACE-909');
  console.log('Jira browser desktop check passed: one-click embedded modal, native sizing and keyboard focus, isolated website and popup, editing fixture, persistent per-account login, reset/close races, summary preference persistence, early explicit-ticket restore, native clear with unsaved-edit protection, persistent cleared selection, compact centered chooser, stable floating suggestions, recent and searched selection, debounced and stale searches, exact-key Enter, picker error focus and recovery, branch-scoped Current tickets, branch-change modal closure and one-time unsaved-edit protection, pending-clear checkout race, disconnect cleanup and trusted IPC.');
} catch (error) {
  if (desktop) {
    console.error('Jira modal geometry:', JSON.stringify(await nativeViews().catch(() => 'Unavailable')));
    console.error('Jira modal focus:', await desktop.evaluate(async ({ BrowserWindow, webContents }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
      return { focused: webContents.getFocusedWebContents()?.getURL(), active: await main?.webContents.executeJavaScript('document.activeElement?.outerHTML?.slice(0, 2000)') };
    }).catch(() => 'Unavailable'));
  }
  console.error(error);
  throw error;
} finally {
  await closeDesktop();
  await rm(fixture, { recursive: true, force: true });
}
