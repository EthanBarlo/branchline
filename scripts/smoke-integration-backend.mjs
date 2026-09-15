import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

// Exercise the production main process and sandboxed preload. Network transport
// (including the narrowly scoped cleanup Git remote) is replaced only in this
// temporary entrypoint; no provider credentials or real remotes are used.
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
  globalThis.providerSmoke = { requests: [], git: [], comments: [], merged: {}, approved: {}, childCreated: false, emptyDeleted: false, mergePolls: {}, mergeRequests: [] };
  globalThis.providerSmokeGates = {};
  cp.execFile = function (command, args, ...rest) {
    if (command === 'git') {
      globalThis.providerSmoke.git.push(args);
      if (args.includes('ls-remote') || args.includes('push')) {
        const state = globalThis.providerSmoke;
        const options = rest[0]; const callback = rest.at(-1);
        const workspace = require('node:path').join(process.env.BRANCHLINE_DATA_DIR, 'pointer-workspaces') + require('node:path').sep;
        if (!options?.cwd?.startsWith(workspace) || !args.includes('https://bitbucket.org/smoke/empty.git') || !state.merged.repository || !state.merged.core) throw new Error('Only the scratch cleanup workspace may contact a simulated remote, after all reviewed changes merge.');
        let output;
        if (args.includes('push')) {
          if (!args.includes(`--force-with-lease=refs/heads/feature/APP-123:${'b'.repeat(40)}`) || args.at(-1) !== ':refs/heads/feature/APP-123') throw new Error('Cleanup must send one exact-ref deletion with the captured commit lease.');
          state.emptyDeleted = true; output = 'To simulated remote\n-\t:refs/heads/feature/APP-123\t[deleted]\nDone\n';
        } else output = state.emptyDeleted ? '' : `${'b'.repeat(40)}\trefs/heads/feature/APP-123\n`;
        queueMicrotask(() => callback(null, output, ''));
        return { stdin: null };
      }
      if (args.some(arg => ['fetch', 'checkout', 'switch', 'reset', 'update-ref', 'update-index', 'read-tree'].includes(arg))) throw new Error('Remote reviews must not mutate or fetch local Git.');
    }
    return original.call(this, command, args, ...rest);
  };
  cp.execFile[require('node:util').promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
    cp.execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  const hash = letter => letter.repeat(40);
  const repository = slug => ({ uuid: `{00000000-0000-0000-0000-00000000000${slug === 'repository' ? 1 : slug === 'core' ? 2 : 3}}`, full_name: `smoke/${slug}` });
  const pr = (slug = 'repository') => ({ id: slug === 'repository' ? 7 : 8, title: 'Remote review', state: globalThis.providerSmoke.merged[slug] ? 'MERGED' : 'OPEN', draft: false,
    source: { repository: repository(slug), branch: { name: 'feature/APP-123' }, commit: { hash: globalThis.providerSmoke.invalidPullRequest && slug === 'repository' ? undefined : hash('a').slice(0, 12) } },
    destination: { repository: repository(slug), branch: { name: 'main', merge_strategies: ['merge_commit'] }, commit: { hash: hash('b').slice(0, 12) } },
    author: { uuid: 'author', display_name: 'Author' }, reviewers: [{ uuid: 'bb-user', display_name: 'BB Reviewer' }],
    participants: [{ user: { uuid: 'bb-user' }, approved: globalThis.providerSmoke.approved[slug] === true }],
    ...(globalThis.providerSmoke.merged[slug] ? { merge_commit: { hash: hash('d').slice(0, 12) } } : {}) });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input); const route = url.pathname; const method = init.method || 'GET';
    const state = globalThis.providerSmoke;
    state.requests.push({ url: url.href, method, body: init.body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route === '/_edge/tenant_info') return json({ cloudId: 'cloud-123' });
    if (route.endsWith('/myself')) return json({ accountId: 'jira-user', displayName: 'Jira Reviewer' });
    if (route.includes('/issue/')) return json({ key: 'APP-123', fields: { summary: 'Connected issue', description: { type: 'doc', content: [] } } });
    if (route === '/2.0/user') return json({ uuid: 'bb-user', display_name: 'BB Reviewer' });
    const slug = route.split('/')[4];
    if (/^\/2\.0\/repositories\/smoke\/(repository|core|empty)$/.test(route)) return json({ ...repository(slug), mainbranch: { name: 'main' } });
    if (route.endsWith('/statuses')) return json({ values: [] });
    const commit = /\/commit\/([abd]{12})$/.exec(route);
    if (commit) return json({ hash: hash(commit[1][0]) });
    if (route.endsWith('/pullrequests')) {
      if (method === 'POST') {
        if (slug !== 'core' || state.childCreated) throw new Error('Only the missing child PR may be created once.');
        const body = JSON.parse(init.body);
        if (body.source.branch.name !== 'feature/APP-123' || body.destination.branch.name !== 'main' || body.close_source_branch !== true) throw new Error('The created PR must match the reviewed branch pair.');
        state.childCreated = true; return json(pr(slug), 201);
      }
      const value = slug === 'repository' || slug === 'core' && state.childCreated ? pr(slug) : null;
      const states = url.searchParams.getAll('state');
      return json({ values: value && (state.invalidPullRequest || !states.length || states.includes(value.state)) ? [value] : [] });
    }
    if (/\/pullrequests\/(7|8)$/.test(route)) return json(pr(slug));
    if (route.includes('/merge-base/')) return json({ hash: hash(slug === 'empty' ? 'b' : 'c') });
    if (route.includes('/diffstat/')) return json({ values: slug === 'empty' ? [] : slug === 'core' ? [
      { status: 'renamed', old: { path: 'old.ts' }, new: { path: 'child.ts' }, lines_added: 2, lines_removed: 1 },
    ] : [
      { status: 'renamed', old: { path: 'old.ts' }, new: { path: 'new.ts' }, lines_added: 2, lines_removed: 1 },
      { status: 'modified', old: { path: 'z-last.ts' }, new: { path: 'z-last.ts' }, lines_added: 1, lines_removed: 1 },
    ] });
    if (route.includes('/src/')) {
      const path = route.split('/').at(-1);
      if (url.searchParams.has('format')) return json({ type: 'commit_file', path, attributes: [] });
      if (slug === 'core' && globalThis.providerSmokeGates.coreContent) {
        state.coreContentBlocked = true;
        await globalThis.providerSmokeGates.coreContent.promise;
      }
      if (path === 'z-last.ts') return new Response(route.includes(hash('c')) ? 'export const last = false;\n' : 'export const last = true;\n');
      return new Response(path === 'old.ts' ? 'const before = true;\n' : 'const after = true;\nexport { after };\n');
    }
    if (route.endsWith('/comments')) {
      if (method === 'GET') return json({ values: state.comments.filter(comment => comment.repoSlug === slug) });
      const input = JSON.parse(init.body);
      const comment = { id: state.comments.filter(comment => comment.repoSlug === slug).length + 1, repoSlug: slug, user: { uuid: 'bb-user' }, content: input.content, inline: input.inline, deleted: false, created_on: new Date().toISOString() };
      state.comments.push(comment); return json(comment, 201);
    }
    if (route.endsWith('/comments/1') && method === 'PUT') {
      const comment = state.comments.find(comment => comment.repoSlug === slug && comment.id === 1);
      comment.content = JSON.parse(init.body).content;
      return json(comment);
    }
    if (route.endsWith('/approve')) { state.approved[slug] = true; return json({}); }
    if (route.endsWith('/merge')) {
      if (!globalThis.providerSmokeGates.merges) {
        let resolve, reject;
        const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
        const timeout = setTimeout(() => reject(new Error('Independent repository merges did not start in parallel.')), 5000);
        globalThis.providerSmokeGates.merges = { promise, release: () => { clearTimeout(timeout); resolve(); } };
      }
      state.mergeRequests.push(slug);
      if (state.mergeRequests.length === 2) {
        state.mergeOverlapped = Object.keys(state.merged).length === 0;
        globalThis.providerSmokeGates.merges.release();
      }
      await globalThis.providerSmokeGates.merges.promise;
      return json({ task_id: `desktop-${slug}-merge-task` }, 202);
    }
    if (route.includes('/merge/task-status/')) {
      state.mergePolls[slug] = (state.mergePolls[slug] || 0) + 1;
      if (state.mergePolls[slug] >= 2) state.merged[slug] = true;
      return json({ task_status: state.merged[slug] ? 'SUCCESS' : 'PENDING' });
    }
    if (route.includes('/refs/branches/')) {
      const name = decodeURIComponent(route.split('/').at(-1));
      if (name === 'feature/APP-123' && (state.merged[slug] || slug === 'empty' && state.emptyDeleted)) return json({}, 404);
      return json({ name, target: { hash: hash(name === 'main' || slug === 'empty' ? 'b' : 'a') }, merge_strategies: ['merge_commit'] });
    }
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
    repositories.push(
      { relativePath: 'zz-core', workspace: 'smoke', repoSlug: 'core', parentRelativePath: '.', submodulePath: 'zz-core' },
      { relativePath: 'zz-empty', workspace: 'smoke', repoSlug: 'empty', parentRelativePath: '.', submodulePath: 'zz-empty' },
    );
    await api.configureProjectIntegration(project.id, { bitbucketConnectionId: bb.id, repositories, updateSubmodulePointers: false });
    const inbox = await api.listPullRequests(project.id, 'reviewer');
    const review = await api.openPullRequestReview(project.id, [{ repositoryPath: '.', prId: inbox[0].id }]);
    return { bb, jira, project, repositories, inbox, review };
  }, repo);
  await desktop.evaluate(() => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    globalThis.providerSmokeGates.coreContent = { promise, release };
  });
  await page.evaluate(reviewId => {
    window.backendLoadSmoke = { events: [], settled: false };
    const state = window.backendLoadSmoke;
    state.unsubscribe = window.reviewAPI.onRemoteReviewLoadProgress(event => { if (event.reviewId === reviewId) state.events.push(event); });
    state.task = window.reviewAPI.refreshReview(reviewId).then(result => { state.result = result; state.settled = true; }, error => { state.error = error.message; state.settled = true; });
  }, setup.review.id);
  let incremental;
  try {
    await page.waitForFunction(() => window.backendLoadSmoke.events.some(event => !event.complete && event.result?.snapshot.files.some(file => file.id === 'new.ts')
      && event.repositories.some(row => row.repository.relativePath === 'zz-core' && row.phase === 'files')));
    assert.equal(await desktop.evaluate(() => globalThis.providerSmoke.coreContentBlocked), true);
    incremental = await page.evaluate(async reviewId => {
      const state = window.backendLoadSmoke;
      if (state.settled) throw new Error('The refresh should still be waiting for the child repository.');
      const event = state.events.findLast(event => event.result?.snapshot.files.some(file => file.id === 'new.ts'));
      const file = event.result.snapshot.files.find(file => file.id === 'new.ts');
      const start = performance.now();
      await window.reviewAPI.setApprovals(reviewId, [{ fileId: file.id, fingerprint: file.fingerprint }], true);
      const saved = await window.reviewAPI.addComment(reviewId, { fileId: file.id, path: file.path, repoRelativePath: '.', side: 'additions', lineStart: 1, lineEnd: 1,
        body: 'Feedback while the child still loads', fingerprint: file.fingerprint, context: file.newContent });
      if (state.settled) throw new Error('Local feedback should save before the blocked refresh finishes.');
      return { file, commentId: saved.comments.at(-1).id, elapsedMs: performance.now() - start, loading: event.result.snapshot.loading };
    }, setup.review.id);
    assert.equal(incremental.loading, true);
    assert.ok(incremental.elapsedMs < 1000, `Local markers and comments should stay responsive during downloads (${incremental.elapsedMs}ms).`);
  } finally {
    await desktop.evaluate(() => { const gate = globalThis.providerSmokeGates.coreContent; delete globalThis.providerSmokeGates.coreContent; gate.release(); });
  }
  const progressive = await page.evaluate(async ({ reviewId, incremental }) => {
    const state = window.backendLoadSmoke;
    await state.task; state.unsubscribe();
    if (state.error) throw new Error(state.error);
    const result = state.result;
    const saved = (await window.reviewAPI.getState()).reviews.find(review => review.id === reviewId);
    await window.reviewAPI.setApprovals(reviewId, [{ fileId: incremental.file.id, fingerprint: incremental.file.fingerprint }], false);
    await window.reviewAPI.deleteComment(reviewId, incremental.commentId);
    return { result, saved, events: state.events };
  }, { reviewId: setup.review.id, incremental });
  assert.equal(progressive.result.snapshot.loading, false);
  assert.deepEqual(progressive.result.snapshot.files.map(file => file.id), ['new.ts', 'z-last.ts', 'zz-core/child.ts']);
  assert.equal(progressive.saved.approvals[incremental.file.id], incremental.file.fingerprint, 'The final snapshot preserves a reviewed marker saved during loading.');
  assert.ok(progressive.saved.comments.some(comment => comment.id === incremental.commentId), 'The final snapshot preserves feedback saved during loading.');
  assert.equal(progressive.events.at(-1).complete, true);
  assert.ok(progressive.events.at(-1).repositories.every(row => row.phase === 'ready'));
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
    && document.querySelector('.diff-file-name')?.textContent
    && !document.querySelector('[aria-label="Refresh review"]')?.disabled, setup.review.id);
  const loaded = await counters();
  assert.ok(loaded.requests > beforeOpen.requests, 'Opening a saved remote review loads current provider data.');
  const selectedBefore = await page.locator('.diff-file-name').textContent();
  const started = Date.now();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.waitForFunction(previous => document.querySelector('.diff-file-name')?.textContent && document.querySelector('.diff-file-name').textContent !== previous, selectedBefore);
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
  const drafts = await page.evaluate(async ({ bb, jira, project, repositories, review }) => {
    const api = window.reviewAPI;
    await api.configureProjectIntegration(project.id, { bitbucketConnectionId: bb.id, jiraConnectionId: jira.id, repositories, updateSubmodulePointers: false });
    const refreshed = await api.refreshReview(review.id);
    const file = refreshed.snapshot.files.find(file => file.repoRelativePath === '.');
    const child = refreshed.snapshot.files.find(file => file.repoRelativePath === 'zz-core');
    if (!child) throw new Error('The child branch diff was omitted because it has no PR.');
    const saved = await api.addComment(review.id, { fileId: file.id, path: file.path, repoRelativePath: '.', side: 'additions', lineStart: 1, lineEnd: 2, body: 'Review this range', fingerprint: file.fingerprint, context: file.newContent });
    await api.addComment(review.id, { fileId: child.id, path: child.path, repoRelativePath: child.repoRelativePath, side: 'additions', lineStart: 1, lineEnd: 2, body: 'Review this child range', fingerprint: child.fingerprint, context: child.newContent });
    return { snapshot: refreshed.snapshot, commentId: saved.comments[0].id, binding: await api.getRemoteReview(review.id) };
  }, setup);
  const afterDraft = await desktop.evaluate(() => globalThis.providerSmoke);
  assert.equal(afterDraft.childCreated, false, 'Typing branch feedback does not create its PR.');
  assert.equal(afterDraft.comments.length, 0, 'Draft feedback remains local in every repository.');
  assert.ok(!afterDraft.git.some(args => args.includes('ls-remote') || args.includes('push') || args.includes('fetch') || args.includes('checkout')), 'Opening and commenting on PR-less branches uses only immutable API snapshots.');
  assert.deepEqual(drafts.binding.repositories.map(row => row.status), ['pull-request', 'changes', 'no-changes']);
  const result = await page.evaluate(async ({ setup: { bb, jira, project, inbox, review }, drafts }) => {
    const api = window.reviewAPI;
    const issue = await api.getJiraIssue(review.id);
    const inferredLink = await api.getJiraTicketLink(review.id);
    await api.setReviewTicket(review.id, 'OPS-789');
    const explicitLink = await api.getJiraTicketLink(review.id);
    await Promise.all([api.publishFeedback(review.id), api.publishFeedback(review.id)]);
    const published = await api.getRemoteReview(review.id);
    await api.updateComment(review.id, drafts.commentId, { body: 'Updated inline feedback' });
    const pendingEdit = await api.previewFeedback(review.id);
    await api.publishFeedback(review.id);
    const progress = [], checks = [];
    let actionReturned = false;
    const unsubscribe = api.onRemoteReviewChanged(event => {
      if (event.reviewId !== review.id) return;
      checks.push(event.state.repositories?.map(row => row.check?.state));
      if (event.state.operation) progress.push({ ...event, beforeResult: !actionReturned });
    });
    const operation = await api.runPullRequestAction(review.id, 'merge');
    actionReturned = true;
    await new Promise(resolve => setTimeout(resolve, 30));
    unsubscribe();
    await api.disconnectConnection(jira.id);
    const disconnectedJiraLink = await api.getJiraTicketLink(review.id);
    const disconnected = await api.disconnectConnection(bb.id);
    const reconnected = await api.saveConnection({ id: bb.id, kind: 'bitbucket', email: 'bb@example.invalid', token: 'fake-bb-token' });
    const restored = await api.getRemoteReview(review.id);
    return { bb, jira, project, inbox, review, snapshot: drafts.snapshot, issue, inferredLink, explicitLink, disconnectedJiraLink, published, operation, progress, checks, pendingEdit, disconnected, reconnected, restored };
  }, { setup, drafts });
  assert.equal(result.bb.accountId, 'bb-user'); assert.equal(result.jira.accountId, 'jira-user');
  assert.equal(result.issue.title, 'Connected issue'); assert.equal(result.review.remote, true);
  assert.deepEqual(result.inferredLink, { key: 'APP-123', url: 'https://smoke.atlassian.net/browse/APP-123' });
  assert.deepEqual(result.explicitLink, { key: 'OPS-789', url: 'https://smoke.atlassian.net/browse/OPS-789' });
  assert.deepEqual(result.disconnectedJiraLink, result.explicitLink, 'Opening the linked Jira ticket does not require a connected API token.');
  assert.equal(result.inbox[0].sourceHash, 'a'.repeat(40)); assert.equal(result.inbox[0].targetHash, 'b'.repeat(40));
  assert.equal(result.snapshot.files[0].oldPath, 'old.ts'); assert.equal(result.snapshot.files[0].newContent, 'const after = true;\nexport { after };\n');
  assert.deepEqual(result.snapshot.files.map(file => file.id), ['new.ts', 'z-last.ts', 'zz-core/child.ts']);
  assert.equal(result.published.repositories.find(row => row.repository.relativePath === 'zz-core').prId, 8);
  assert.deepEqual(result.snapshot.warnings, []);
  assert.equal(result.operation.operation.state, 'complete'); assert.equal(result.operation.operation.items[0].cleanup, 'deleted');
  assert.equal(result.operation.operation.items[0].mergeCommit, 'd'.repeat(40));
  assert.equal(result.operation.operation.items.length, 2, 'The newly created child PR participates in the grouped merge.');
  assert.ok(result.operation.operation.items.every(item => item.merge === 'merged' && item.cleanup === 'deleted'));
  assert.equal(result.operation.repositories.find(row => row.repository.relativePath === 'zz-empty').cleanup.state, 'deleted', 'The matching branch with no PR or changes is deleted too.');
  const phases = result.progress.flatMap(event => event.state.operation.items.map(item => item.phase).filter(Boolean));
  for (const phase of ['checking', 'approving', 'merging', 'cleanup']) assert.ok(phases.includes(phase), `The real preload delivers the ${phase} progress stage.`);
  assert.ok(result.progress.some(event => event.beforeResult && event.state.operation.state === 'running' && event.state.operation.items.some(item => item.phase === 'merging')), 'Progress arrives while the merge IPC request is still running.');
  assert.ok(result.progress.some(event => event.beforeResult && event.state.operation.items.some(item => item.taskId === 'desktop-core-merge-task' && item.merge === 'merging')), 'An accepted asynchronous merge stays visibly in progress until its task and PR confirm completion.');
  assert.ok(result.checks.some(states => states.filter(state => state === 'checking').length >= 2), 'The preload reports multiple repository preflight checks in progress together.');
  assert.ok(result.progress.some(event => event.beforeResult && event.state.repositories.find(row => row.repository.relativePath === 'zz-empty')?.cleanup?.state === 'sending'), 'The real preload reports no-PR repository cleanup while it is running.');
  assert.equal(result.progress.at(-1).state.operation.state, 'complete');
  const persisted = JSON.parse(await readFile(join(dataDir, 'integrations.json'), 'utf8')).reviews[result.review.id];
  assert.deepEqual(persisted.operation, JSON.parse(JSON.stringify(result.progress.at(-1).state.operation)), 'The completion event matches the durable operation result.');
  assert.equal(result.pendingEdit.items[0].state, 'draft'); assert.equal(result.pendingEdit.items[0].action, 'update');
  assert.equal(result.disconnected.connections.find(account => account.id === result.bb.id).connected, false);
  assert.equal(result.reconnected.id, result.bb.id); assert.equal(result.restored.connectionId, result.bb.id);
  const observed = await desktop.evaluate(() => globalThis.providerSmoke);
  assert.equal(observed.requests.filter(request => new URL(request.url).pathname.includes('/issue/')).length, 1, 'Ticket links reuse local ticket/site metadata without loading issue contents.');
  assert.deepEqual(observed.mergePolls, { core: 2, repository: 2 }, 'Each production merge observes an initially pending task through confirmation.');
  const merges = observed.requests.filter(request => request.method === 'POST' && request.url.endsWith('/merge'));
  assert.deepEqual(new Set(merges.map(request => new URL(request.url).pathname.split('/')[4])), new Set(['core', 'repository']), 'Every independent PR merges once.');
  assert.equal(merges.length, 2);
  assert.equal(observed.mergeOverlapped, true, 'Both merge requests arrive before either response can complete.');
  assert.equal(observed.requests.filter(request => request.method === 'POST' && request.url.endsWith('/pullrequests')).length, 1, 'Repeated publication creates exactly one missing PR.');
  assert.equal(observed.comments.length, 2, 'Repeated IPC publication cannot duplicate either comment.');
  const rootComment = observed.comments.find(comment => comment.repoSlug === 'repository');
  const childComment = observed.comments.find(comment => comment.repoSlug === 'core');
  assert.equal(rootComment.content.raw, 'Updated inline feedback');
  assert.deepEqual(rootComment.inline, { path: 'new.ts', to: 2, start_to: 1 });
  assert.deepEqual(childComment.inline, { path: 'child.ts', to: 2, start_to: 1 }, 'The created child PR gets its canonical file path and native range, without the project-relative prefix.');
  assert.deepEqual(JSON.parse(observed.requests.find(request => request.url.endsWith('/merge')).body), { type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: true });
  assert.ok(observed.git.length > 0, 'The production Git adapter was monitored.');
  assert.equal(observed.git.filter(args => args.includes('push')).length, 1, 'One leased remote deletion cleans up the empty repository branch.');
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
  console.log(`Production desktop provider IPC passed: early repository files arrive while child content is blocked, marker and feedback persist in ${Math.round(incremental.elapsedMs)}ms during loading; cached Mark reviewed advances in ${advanceMs}ms without provider or Git requests; branch-only child changes stay visible, publishing creates one PR and native inline range, independent merges overlap, preflight reports concurrent checks, empty branches use isolated leased cleanup; separate accounts, Jira links, durable progress, diagnostics, and unchanged local Git.`);
} catch (error) {
  if (desktop) {
    const pages = desktop.windows();
    console.error('Provider smoke UI at failure:', await pages[0]?.locator('body').innerText().catch(() => 'Unavailable'));
  }
  throw error;
} finally {
  if (desktop) await desktop.close();
  await rm(fixture, { recursive: true, force: true });
}
