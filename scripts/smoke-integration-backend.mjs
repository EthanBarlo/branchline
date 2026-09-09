import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

// Exercise the production main process and sandboxed preload. Only the network
// transport is replaced, in a temporary Electron entrypoint outside production.
const fixture = await mkdtemp(join(tmpdir(), 'branchline-provider-desktop-'));
const repo = join(fixture, 'checkout');
const dataDir = join(fixture, 'data');
let desktop;
function git(...args) {
  return execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
}
function installTransport() {
  const { safeStorage } = require('electron');
  safeStorage.isEncryptionAvailable = () => false;
  const cp = require('node:child_process');
  const original = cp.execFile;
  globalThis.providerSmoke = { requests: [], git: [], comments: [], merged: false, approved: false };
  cp.execFile = function (command, args, ...rest) {
    if (command === 'git') {
      globalThis.providerSmoke.git.push(args);
      if (args.some(arg => ['fetch', 'checkout', 'switch', 'reset', 'push', 'update-ref', 'update-index', 'read-tree'].includes(arg))) throw new Error('Remote reviews must not mutate or fetch local Git.');
    }
    return original.call(this, command, args, ...rest);
  };
  cp.execFile[require('node:util').promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
    cp.execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  const hash = letter => letter.repeat(40);
  const repository = { uuid: '{00000000-0000-0000-0000-000000000001}', full_name: 'smoke/repository' };
  const pr = () => ({ id: 7, title: 'Remote review', state: globalThis.providerSmoke.merged ? 'MERGED' : 'OPEN', draft: false,
    source: { repository, branch: { name: 'feature/APP-123' }, commit: { hash: globalThis.providerSmoke.invalidPullRequest ? undefined : hash('a').slice(0, 12) } },
    destination: { repository, branch: { name: 'main', merge_strategies: ['merge_commit'] }, commit: { hash: hash('b').slice(0, 12) } },
    author: { uuid: 'author', display_name: 'Author' }, reviewers: [{ uuid: 'bb-user', display_name: 'BB Reviewer' }],
    participants: [{ user: { uuid: 'bb-user' }, approved: globalThis.providerSmoke.approved }],
    ...(globalThis.providerSmoke.merged ? { merge_commit: { hash: hash('d').slice(0, 12) } } : {}) });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input); const route = url.pathname; const method = init.method || 'GET';
    const state = globalThis.providerSmoke;
    state.requests.push({ url: url.href, method, body: init.body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route === '/_edge/tenant_info') return json({ cloudId: 'cloud-123' });
    if (route.endsWith('/myself')) return json({ accountId: 'jira-user', displayName: 'Jira Reviewer' });
    if (route.includes('/issue/')) return json({ key: 'APP-123', fields: { summary: 'Connected issue', description: { type: 'doc', content: [] } } });
    if (route === '/2.0/user') return json({ uuid: 'bb-user', display_name: 'BB Reviewer' });
    if (route.endsWith('/statuses')) return json({ values: [] });
    const commit = /\/commit\/([abd]{12})$/.exec(route);
    if (commit) return json({ hash: hash(commit[1][0]) });
    if (route.endsWith('/pullrequests')) return json({ values: [pr()] });
    if (route.endsWith('/pullrequests/7')) return json(pr());
    if (route.includes('/merge-base/')) return json({ hash: hash('c') });
    if (route.includes('/diffstat/')) return json({ values: [
      { status: 'renamed', old: { path: 'old.ts' }, new: { path: 'new.ts' }, lines_added: 2, lines_removed: 1 },
      { status: 'modified', old: { path: 'z-last.ts' }, new: { path: 'z-last.ts' }, lines_added: 1, lines_removed: 1 },
    ] });
    if (route.includes('/src/')) {
      const path = route.split('/').at(-1);
      if (url.searchParams.has('format')) return json({ type: 'commit_file', path, attributes: [] });
      if (path === 'z-last.ts') return new Response(route.includes(hash('c')) ? 'export const last = false;\n' : 'export const last = true;\n');
      return new Response(path === 'old.ts' ? 'const before = true;\n' : 'const after = true;\nexport { after };\n');
    }
    if (route.endsWith('/comments')) {
      if (method === 'GET') return json({ values: state.comments });
      const input = JSON.parse(init.body);
      const comment = { id: state.comments.length + 1, user: { uuid: 'bb-user' }, content: input.content, inline: input.inline, deleted: false, created_on: new Date().toISOString() };
      state.comments.push(comment); return json(comment, 201);
    }
    if (route.endsWith('/comments/1') && method === 'PUT') {
      state.comments[0].content = JSON.parse(init.body).content;
      return json(state.comments[0]);
    }
    if (route.endsWith('/approve')) { state.approved = true; return json({}); }
    if (route.endsWith('/merge')) return json({ task_id: 'desktop-merge-task' }, 202);
    if (route.endsWith('/merge/task-status/desktop-merge-task')) {
      state.mergePolls = (state.mergePolls || 0) + 1;
      if (state.mergePolls >= 2) state.merged = true;
      return json({ task_status: state.merged ? 'SUCCESS' : 'PENDING' });
    }
    if (route.includes('/refs/branches/')) return json({}, state.merged ? 404 : 200);
    throw new Error(`Unmocked provider request: ${method} ${url.href}`);
  };
}

try {
  await mkdir(repo);
  git('init', '-b', 'main');
  await writeFile(join(repo, 'local.txt'), 'local checkout stays untouched\n');
  git('add', '.'); git('commit', '-m', 'Local fixture');
  git('remote', 'add', 'origin', 'https://bitbucket.org/smoke/repository.git');
  await writeFile(join(repo, 'local.txt'), 'unsaved user changes\n');
  const before = { head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain=v1'), index: await readFile(join(repo, '.git/index')), content: await readFile(join(repo, 'local.txt')) };
  const entry = join(fixture, 'main.cjs');
  await writeFile(entry, `(${installTransport.toString()})();\nrequire(${JSON.stringify(resolve('dist-electron/main.cjs'))});\n`);
  const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [entry], env, timeout: 30000 });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.reviewAPI);
  const setup = await page.evaluate(async repoPath => {
    const api = window.reviewAPI;
    const bb = await api.saveConnection({ kind: 'bitbucket', email: 'bb@example.invalid', token: 'fake-bb-token' });
    const jira = await api.saveConnection({ kind: 'jira', email: 'jira@example.invalid', token: 'fake-jira-token', siteUrl: 'https://smoke.atlassian.net' });
    const project = await api.createProject({ repoPath, name: 'Provider desktop' });
    const repositories = await api.discoverRepositories(project.id);
    await api.configureProjectIntegration(project.id, { bitbucketConnectionId: bb.id, repositories, updateSubmodulePointers: false });
    const inbox = await api.listPullRequests(project.id, 'reviewer');
    const review = await api.openPullRequestReview(project.id, [{ repositoryPath: '.', prId: inbox[0].id }]);
    return { bb, jira, project, repositories, inbox, review };
  }, repo);
  // Render the saved PR through the real app rather than replacing the preload.
  // Jira is selected afterward so these counters isolate remote file review.
  await page.reload();
  const reviewPicker = page.getByRole('combobox', { name: 'Select review', exact: true });
  const counters = () => desktop.evaluate(() => ({ requests: globalThis.providerSmoke.requests.length, git: globalThis.providerSmoke.git.length }));
  await reviewPicker.waitFor();
  const beforeOpen = await counters();
  await reviewPicker.click();
  await page.getByRole('option').filter({ hasText: setup.review.name }).click();
  await page.waitForFunction(reviewId => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === reviewId
    && document.querySelector('.diff-file-name')?.textContent?.includes('new.ts')
    && !document.querySelector('[aria-label="Refresh review"]')?.disabled, setup.review.id);
  const loaded = await counters();
  assert.ok(loaded.requests > beforeOpen.requests, 'Opening a saved remote review loads current provider data.');
  const started = Date.now();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.diff-file-name')?.textContent?.includes('z-last.ts'));
  const advanceMs = Date.now() - started;
  assert.deepEqual(await counters(), loaded, 'Mark reviewed advances to the next file with no provider or Git requests.');
  const marked = await page.evaluate(async reviewId => (await window.reviewAPI.getState()).reviews.find(review => review.id === reviewId), setup.review.id);
  assert.equal(Object.keys(marked.approvals).length, 1, 'The reviewed marker is persisted before advancing.');
  const firstFile = Object.keys(marked.approvals)[0];
  const unmarked = await page.evaluate(({ reviewId, fileId, fingerprint }) => window.reviewAPI.setApprovals(reviewId, [{ fileId, fingerprint }], false),
    { reviewId: setup.review.id, fileId: firstFile, fingerprint: marked.approvals[firstFile] });
  assert.equal(unmarked.approvals[firstFile], undefined);
  assert.deepEqual(await counters(), loaded, 'Removing a reviewed marker is also entirely local.');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(200);
  assert.deepEqual(await counters(), loaded, 'Returning focus to a cached remote review does not trigger a provider refresh.');
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  assert.ok((await counters()).requests > loaded.requests, 'Manual refresh still checks the provider.');
  const result = await page.evaluate(async ({ bb, jira, project, repositories, inbox, review }) => {
    const api = window.reviewAPI;
    await api.configureProjectIntegration(project.id, { bitbucketConnectionId: bb.id, jiraConnectionId: jira.id, repositories, updateSubmodulePointers: false });
    const refreshed = await api.refreshReview(review.id); const file = refreshed.snapshot.files[0];
    const issue = await api.getJiraIssue(review.id);
    const inferredLink = await api.getJiraTicketLink(review.id);
    await api.setReviewTicket(review.id, 'OPS-789');
    const explicitLink = await api.getJiraTicketLink(review.id);
    const saved = await api.addComment(review.id, { fileId: file.id, path: file.path, repoRelativePath: '.', side: 'additions', lineStart: 1, lineEnd: 2, body: 'Review this range', fingerprint: file.fingerprint, context: file.newContent });
    await Promise.all([api.publishFeedback(review.id), api.publishFeedback(review.id)]);
    await api.updateComment(review.id, saved.comments[0].id, { body: 'Updated inline feedback' });
    const pendingEdit = await api.previewFeedback(review.id);
    await api.publishFeedback(review.id);
    const progress = [];
    let actionReturned = false;
    const unsubscribe = api.onRemoteReviewChanged(event => { if (event.reviewId === review.id && event.state.operation) progress.push({ ...event, beforeResult: !actionReturned }); });
    const operation = await api.runPullRequestAction(review.id, 'merge');
    actionReturned = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    unsubscribe();
    await api.disconnectConnection(jira.id);
    const disconnectedJiraLink = await api.getJiraTicketLink(review.id);
    const disconnected = await api.disconnectConnection(bb.id);
    const reconnected = await api.saveConnection({ id: bb.id, kind: 'bitbucket', email: 'bb@example.invalid', token: 'fake-bb-token' });
    const restored = await api.getRemoteReview(review.id);
    return { bb, jira, project, inbox, review, snapshot: refreshed.snapshot, issue, inferredLink, explicitLink, disconnectedJiraLink, operation, progress, pendingEdit, disconnected, reconnected, restored };
  }, setup);
  assert.equal(result.bb.accountId, 'bb-user'); assert.equal(result.jira.accountId, 'jira-user');
  assert.equal(result.issue.title, 'Connected issue'); assert.equal(result.review.remote, true);
  assert.deepEqual(result.inferredLink, { key: 'APP-123', url: 'https://smoke.atlassian.net/browse/APP-123' });
  assert.deepEqual(result.explicitLink, { key: 'OPS-789', url: 'https://smoke.atlassian.net/browse/OPS-789' });
  assert.deepEqual(result.disconnectedJiraLink, result.explicitLink, 'Opening the linked Jira ticket does not require a connected API token.');
  assert.equal(result.inbox[0].sourceHash, 'a'.repeat(40)); assert.equal(result.inbox[0].targetHash, 'b'.repeat(40));
  assert.equal(result.snapshot.files[0].oldPath, 'old.ts'); assert.equal(result.snapshot.files[0].newContent, 'const after = true;\nexport { after };\n');
  assert.deepEqual(result.snapshot.warnings, []);
  assert.equal(result.operation.operation.state, 'complete'); assert.equal(result.operation.operation.items[0].cleanup, 'deleted');
  assert.equal(result.operation.operation.items[0].mergeCommit, 'd'.repeat(40));
  const phases = result.progress.flatMap(event => event.state.operation.items.map(item => item.phase).filter(Boolean));
  for (const phase of ['checking', 'approving', 'merging', 'cleanup']) assert.ok(phases.includes(phase), `The real preload delivers the ${phase} progress stage.`);
  assert.ok(result.progress.some(event => event.beforeResult && event.state.operation.state === 'running' && event.state.operation.items.some(item => item.phase === 'merging')), 'Progress arrives while the merge IPC request is still running.');
  assert.ok(result.progress.some(event => event.beforeResult && event.state.operation.items.some(item => item.taskId === 'desktop-merge-task' && item.merge === 'merging')), 'An accepted asynchronous merge stays visibly in progress until its task and PR confirm completion.');
  assert.equal(result.progress.at(-1).state.operation.state, 'complete');
  const persisted = JSON.parse(await readFile(join(dataDir, 'integrations.json'), 'utf8')).reviews[result.review.id];
  assert.deepEqual(persisted.operation, JSON.parse(JSON.stringify(result.progress.at(-1).state.operation)), 'The completion event matches the durable operation result.');
  assert.equal(result.pendingEdit.items[0].state, 'draft'); assert.equal(result.pendingEdit.items[0].action, 'update');
  assert.equal(result.disconnected.connections.find(account => account.id === result.bb.id).connected, false);
  assert.equal(result.reconnected.id, result.bb.id); assert.equal(result.restored.connectionId, result.bb.id);
  const observed = await desktop.evaluate(() => globalThis.providerSmoke);
  assert.equal(observed.requests.filter(request => new URL(request.url).pathname.includes('/issue/')).length, 1, 'Ticket links reuse local ticket/site metadata without loading issue contents.');
  assert.equal(observed.mergePolls, 2, 'The production operation observes an initially pending merge task through confirmation.');
  assert.equal(observed.requests.filter(request => request.method === 'POST' && request.url.endsWith('/merge')).length, 1, 'Polling an accepted merge never sends another merge request.');
  assert.equal(observed.comments.length, 1, 'Repeated IPC publication cannot duplicate a comment.');
  assert.equal(observed.comments[0].content.raw, 'Updated inline feedback');
  assert.deepEqual(observed.comments[0].inline, { path: 'new.ts', to: 2, start_to: 1 });
  assert.deepEqual(JSON.parse(observed.requests.find(request => request.url.endsWith('/merge')).body), { type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: true });
  assert.ok(observed.git.length > 0, 'The production Git adapter was monitored.');
  assert.equal(git('rev-parse', 'HEAD'), before.head); assert.equal(git('show-ref'), before.refs); assert.equal(git('status', '--porcelain=v1'), before.status);
  assert.deepEqual(await readFile(join(repo, '.git/index')), before.index); assert.deepEqual(await readFile(join(repo, 'local.txt')), before.content);
  const credentials = await readFile(join(dataDir, 'credentials.json'), 'utf8');
  assert.ok(!credentials.includes('fake-bb-token') && !credentials.includes('fake-jira-token'), 'Session-only tokens never reach disk.');
  await desktop.evaluate(() => { globalThis.providerSmoke.invalidPullRequest = true; });
  const invalid = await page.evaluate(async projectId => {
    try { await window.reviewAPI.listPullRequests(projectId, 'all'); return ''; }
    catch (error) { return error.message; }
  }, result.project.id);
  assert.match(invalid, /source\.commit\.hash/); assert.match(invalid, /#7/);
  const diagnostics = await page.evaluate(() => window.reviewAPI.getIntegrationDiagnostics());
  assert.equal(diagnostics.available, true); assert.equal(diagnostics.path, join(dataDir, 'logs', 'integrations.log'));
  const log = await readFile(diagnostics.path, 'utf8');
  assert.ok(log.includes('pull_request_commit_resolved')); assert.ok(log.includes('pull_request_invalid')); assert.ok(log.includes('source.commit.hash'));
  for (const secret of ['fake-bb-token', 'fake-jira-token', 'Updated inline feedback', 'Connected issue', 'Authorization', 'smoke/repository']) assert.ok(!log.includes(secret), `Diagnostics must exclude ${secret}.`);
  console.log(`Production desktop provider IPC passed: cached Mark reviewed advances in ${advanceMs}ms without provider or Git requests; opening/manual refresh reads the provider; abbreviated revisions, separate accounts, token-independent Jira links, remote rename/range, serialized publish, live durable merge progress, standard merge/cleanup, safe diagnostics, and unchanged local Git.`);
} finally {
  if (desktop) await desktop.close();
  await rm(fixture, { recursive: true, force: true });
}
