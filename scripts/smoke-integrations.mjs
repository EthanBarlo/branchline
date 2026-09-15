import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

// Real Electron renderer with an isolated fixture bridge: no Atlassian requests,
// credentials, user storage, or repository mutations are possible in this test.
const fixture = await mkdtemp(join(tmpdir(), 'branchline-integrations-ui-'));
let desktop;
const errors = [];

function fixtureBridge() {
  const { contextBridge } = require('electron');
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = '2026-09-08T10:00:00.000Z';
  const project = { id: 'project-1', name: 'Platform', repoPath: '/fixture/platform', defaultBaseBranch: 'main', createdAt: now };
  const local = { id: 'current:project-1', projectId: project.id, kind: 'current', name: 'Current', repoPath: project.repoPath, baseBranch: 'main', featureBranch: 'feature/APP-123-review', includeWorkingTree: true, createdAt: now, comments: [], approvals: {} };
  const files = [{ id: '.:review.ts', repoRelativePath: '.', path: 'review.ts', status: 'M', additions: 3, deletions: 2, oldContent: 'export function ready() {\n  const enabled = false;\n  return enabled;\n}\n', newContent: 'export function ready() {\n  const enabled = true;\n  const reviewed = true;\n  return enabled && reviewed;\n}\n', binary: false, fingerprint: 'current-file', baseCommit: 'target-hash', headCommit: 'source-hash', source: 'committed' }];
  const mappings = [{ relativePath: '.', workspace: 'acme', repoSlug: 'platform', uuid: 'repo-root' }, { relativePath: 'modules/core', workspace: 'acme', repoSlug: 'core', uuid: 'repo-core', parentRelativePath: '.', submodulePath: 'modules/core' }];
  mappings.push(...['docs', 'assets', 'absent'].map(repoSlug => ({ relativePath: `modules/${repoSlug}`, workspace: 'acme', repoSlug, uuid: `repo-${repoSlug}`, parentRelativePath: '.', submodulePath: `modules/${repoSlug}` })));
  files.push({ ...files[0], id: 'modules/docs:guide.ts', repoRelativePath: 'modules/docs', path: 'guide.ts', fingerprint: 'docs-file' });
  const pr = (id, repository, sourceBranch = local.featureBranch, extra = {}) => ({ id, repository, title: `${id === 12 ? 'Core: ' : ''}Make reviews available`, url: `https://bitbucket.org/acme/${repository.repoSlug}/pull-requests/${id}`, sourceBranch, targetBranch: 'main', sourceHash: 'source-hash', targetHash: 'target-hash', author: { id: 'author-2', name: 'Alex Reviewer' }, reviewers: [{ id: 'bb-user', name: 'Casey' }], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'], ...extra });
  const prs = [pr(11, mappings[0]), pr(12, mappings[1]), pr(21, mappings[0], 'feature/APP-456-settings'), pr(99, mappings[0], local.featureBranch, { unsupportedReason: 'Fork pull requests are not supported yet.' })];
  const comment = (suffix, body, fingerprint = 'current-file') => ({ id: `10000000-0000-4000-8000-00000000000${suffix}`, fileId: files[0].id, repoRelativePath: '.', path: 'review.ts', side: 'additions', lineStart: 2, lineEnd: 3, body, fingerprint, context: '  const enabled = true;\n  const reviewed = true;', createdAt: now, resolved: false });
  const review = { ...local, id: 'remote-review', kind: 'saved', name: 'APP-123 · 2 pull requests', includeWorkingTree: false, remote: true, comments: [comment(1, 'Name the flag after the behavior it enables.'), comment(2, 'This comment needs current lines.', 'earlier-file'), comment(3, 'Confirm delivery before retrying.'), comment(4, 'Local wording for the shared comment.')] };
  review.comments.push({ ...comment(5, 'Explain the new guide option.', 'docs-file'), fileId: files[1].id, repoRelativePath: 'modules/docs', path: 'guide.ts' });
  const anchor = comment => ({ prKey: comment.repoRelativePath === 'modules/docs' ? 'modules/docs#branch' : '.#11', sourceHash: 'source-hash', targetHash: 'target-hash', path: comment.path, side: comment.side, lineStart: comment.lineStart, lineEnd: comment.lineEnd, fingerprint: comment.fingerprint });
  const remote = { connectionId: 'bb', pullRequests: [prs[0], prs[1]], publications: Object.fromEntries(review.comments.map(comment => [comment.id, { commentId: comment.id, anchor: anchor(comment), state: 'draft' }])) };
  remote.repositories = mappings.map((repository, index) => ({ repository, sourceBranch: local.featureBranch, targetBranch: 'main', sourceHash: 'source-hash', targetHash: 'target-hash', status: index < 2 ? 'pull-request' : index === 2 ? 'changes' : index === 3 ? 'no-changes' : 'missing-branch', ...(index < 2 ? { prId: remote.pullRequests[index].id } : {}) }));
  remote.publications[review.comments[2].id].state = 'unknown';
  Object.assign(remote.publications[review.comments[3].id], { state: 'conflict', remoteId: 104, authorId: 'bb-user', acknowledged: { body: 'Original wording.', resolved: false, deleted: false }, remote: { body: 'Wording edited in Bitbucket.', resolved: false, deleted: false } });
  const state = { projects: [project], reviews: [local], settings: { jiraBaseUrl: '' } };
  const integrations = { connections: [], projects: {} };
  const calls = { scopeCopies: [], filters: [], opens: [], actions: [], publish: 0, reanchors: [], links: [], unknown: [], conflicts: [], refreshes: [], logOpens: 0 };
  const remoteListeners = new Set();
  const loadListeners = new Set();
  let loadSequence = 0;
  let advanceLoad;
  let advancePreview;
  let firstRemoteLoad = true;
  let firstMergePreview = true;
  let lastLoadEvent;
  const loadStep = () => new Promise(resolve => { advanceLoad = () => { advanceLoad = undefined; resolve(); }; });
  const previewStep = () => new Promise(resolve => { advancePreview = () => { advancePreview = undefined; resolve(); }; });
  const emitLoad = (loadedFiles, phases, complete = false, reviewValue = review) => {
    const result = { review: clone(reviewValue), snapshot: { ...snapshot(review.id), files: clone(loadedFiles), loading: !complete } };
    lastLoadEvent = { reviewId: review.id, sequence: ++loadSequence, repositories: mappings.map((repository, index) => ({ repository, phase: phases[index] })), result, complete };
    for (const listener of loadListeners) listener(clone(lastLoadEvent));
    emitRemote();
    return result;
  };
  let failNextPublication = false;
  let advanceOperation;
  const emitRemote = () => { for (const listener of remoteListeners) listener(clone({ reviewId: review.id, state: remote })); };
  const operationStep = () => new Promise(resolve => { advanceOperation = () => { advanceOperation = undefined; resolve(); }; });
  let snapshotMode = 'normal';
  const snapshot = id => ({ reviewId: id, files: snapshotMode === 'pointers' || snapshotMode === 'incomplete' ? [] : files.map(file => ({ ...file, ...(snapshotMode === 'unavailable' ? { unavailable: 'Bitbucket could not return this file.' } : {}) })), repos: [{ relativePath: '.', currentBranch: local.featureBranch, workingTreeIncluded: false, baseCommit: 'target-hash', headCommit: 'source-hash', ...(snapshotMode === 'pointers' ? { pointers: [{ path: 'modules/core', oldHash: 'abc1234567890123456789', newHash: 'def1234567890123456789' }] } : {}), ...(snapshotMode === 'incomplete' ? { error: 'The parent repository is temporarily unavailable.' } : {}) }], warnings: snapshotMode === 'incomplete' ? ['The parent repository is temporarily unavailable.'] : [], refreshedAt: now, fingerprint: `snapshot-${snapshotMode}` });
  const getReview = id => id === review.id ? review : local;
  function previewFeedback() {
    const items = Object.values(remote.publications).flatMap(publication => {
      const comment = review.comments.find(comment => comment.id === publication.commentId);
      const body = comment?.body || publication.acknowledged?.body || '';
      const unchanged = comment && publication.acknowledged?.body === comment.body && publication.acknowledged?.resolved === comment.resolved;
      if (unchanged && !['unknown', 'conflict', 'failed'].includes(publication.state)) return [];
      const state = publication.state;
      const repositoryPath = comment?.repoRelativePath || '.';
      const destination = remote.pullRequests.find(pr => pr.repository.relativePath === repositoryPath);
      return [{ commentId: publication.commentId, repositoryPath, prId: destination?.id || 0, createsPullRequest: !destination, path: publication.anchor.path, side: publication.anchor.side, lineStart: publication.anchor.lineStart, lineEnd: publication.anchor.lineEnd, body, action: !comment ? 'delete' : publication.remoteId ? 'update' : 'create', state, remote: publication.remote, error: comment?.fingerprint !== files.find(file => file.id === comment?.fileId)?.fingerprint && !publication.remoteId ? 'The PR changed. Choose current lines before publishing.' : publication.error }];
    });
    return { items, blockers: items.filter(item => item.error || item.state === 'unknown' || item.state === 'conflict').map(item => item.error || `${item.state === 'unknown' ? 'Check delivery' : 'Resolve the conflict'} before publishing.`) };
  }
  const api = {
    onBeforeClose: () => () => {}, onCloseCancelled: () => () => {}, onUpdateStateChanged: () => () => {}, onUpdateDialogRequested: () => () => {},
    onRemoteReviewLoadProgress: listener => { loadListeners.add(listener); return () => { loadListeners.delete(listener); }; },
    onRemoteReviewChanged: listener => { remoteListeners.add(listener); return () => { remoteListeners.delete(listener); }; },
    getUpdateState: async () => ({ revision: 0, currentVersion: '0.10.0', phase: 'disabled', disabledReason: 'Updates disabled in fixture.' }),
    getState: async () => clone(state),
    updateSettings: async changes => { state.settings = changes; return clone(changes); },
    refreshReview: async id => { calls.refreshes.push(id);
      if (id === review.id && firstRemoteLoad) {
        firstRemoteLoad = false;
        const originalReview = clone(review);
        emitLoad([], mappings.map(() => 'checking'));
        await loadStep();
        emitLoad([files[0]], ['ready', 'files', 'files', 'checking', 'checking']);
        await loadStep();
        emitLoad(files, ['ready', 'ready', 'ready', 'checking', 'checking'], false, originalReview);
        await loadStep();
        return emitLoad(files, mappings.map(() => 'ready'), true, originalReview);
      }
      return clone({ review: getReview(id), snapshot: snapshot(id), ...(id === local.id ? { inspection: { rootPath: project.repoPath, name: project.name, branches: ['main', local.featureBranch], currentBranch: local.featureBranch } } : {}) }); },
    getIntegrations: async () => clone(integrations),
    getIntegrationDiagnostics: async () => ({ path: '/fixture/logs/integrations.log', available: true }),
    openIntegrationLog: async () => { calls.logOpens++; },
    saveConnection: async input => {
      if (input.token === 'expired') throw new Error('The API token is expired or invalid.');
      const connection = { id: input.id || (input.kind === 'jira' ? 'jira' : 'bb'), kind: input.kind, label: input.label || input.kind, email: input.email, accountId: input.kind === 'jira' ? 'jira-user' : 'bb-user', displayName: 'Casey', siteUrl: input.siteUrl, storage: 'session', connected: true };
      integrations.connections = integrations.connections.filter(item => item.id !== connection.id).concat(connection); return clone(connection);
    },
    testConnection: async id => clone(integrations.connections.find(item => item.id === id)),
    disconnectConnection: async id => { integrations.connections = integrations.connections.map(item => item.id === id ? { ...item, connected: false } : item); return clone(integrations); },
    configureProjectIntegration: async (id, value) => { integrations.projects[id] = clone(value); return clone(value); },
    discoverRepositories: async () => clone(mappings),
    listPullRequests: async (_, filter) => { calls.filters.push(filter); return clone(filter === 'author' ? [prs[2]] : filter === 'reviewer' ? prs.slice(0, 2) : prs); },
    openPullRequestReview: async (_, refs) => { calls.opens.push(refs); state.reviews = [local, review]; return clone(review); },
    getRemoteReview: async id => id === review.id ? clone(remote) : null,
    getJiraTicketLink: async () => ({ key: remote.ticketKey || 'APP-123', url: `https://jira.example.atlassian.net/browse/${remote.ticketKey || 'APP-123'}` }),
    openJiraTicket: async () => { const link = await api.getJiraTicketLink(); calls.links.push(link.url); return link; },
    getJiraIssue: async () => ({ key: remote.ticketKey || 'APP-123', title: remote.ticketKey ? 'A manually linked ticket' : 'Bring code review into the desktop app', url: `https://jira.example.atlassian.net/browse/${remote.ticketKey || 'APP-123'}`, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review changes with the ticket alongside the diff.', marks: [{ type: 'strong' }] }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep feedback on the exact lines.' }] }] }] }, { type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }, { type: 'text', text: 'Unsafe link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }, { type: 'text', text: 'Engineering docs', marks: [{ type: 'link', attrs: { href: 'https://docs.example.org/reviews' } }] }] }] } }),
    setReviewTicket: async (_, key) => { remote.ticketKey = key; },
    openIntegrationLink: async url => { calls.links.push(url); },
    copyConnectionScopes: async kind => { calls.scopeCopies.push(kind); },
    previewFeedback: async () => clone(previewFeedback()),
    reanchorComment: async (_, id, input) => { const comment = review.comments.find(item => item.id === id); Object.assign(comment, input); remote.publications[id].anchor = anchor(comment); calls.reanchors.push({ id, ...input }); return clone(review); },
    resolveCommentConflict: async (_, id, choice) => { const publication = remote.publications[id]; const comment = review.comments.find(item => item.id === id); if (choice === 'remote') Object.assign(comment, publication.remote); publication.acknowledged = clone(publication.remote); publication.state = 'synced'; delete publication.remote; calls.conflicts.push(choice); return clone(review); },
    resolveUnknownPublication: async (_, id, remoteId) => { const publication = remote.publications[id]; publication.state = remoteId ? 'synced' : 'draft'; if (remoteId) { publication.remoteId = remoteId; const comment = review.comments.find(item => item.id === id); publication.acknowledged = { body: comment.body, resolved: comment.resolved, deleted: false }; } calls.unknown.push({ id, remoteId }); return clone(remote); },
    publishFeedback: async () => { calls.publish++; if (failNextPublication) { failNextPublication = false; throw new Error('Bitbucket is temporarily unavailable. Try publishing again.'); } if (!remote.pullRequests.some(pr => pr.repository.repoSlug === 'docs')) { remote.repositories[2].creation = { state: 'sending' }; emitRemote(); await new Promise(resolve => setTimeout(resolve, 50)); remote.pullRequests.push(pr(13, mappings[2])); Object.assign(remote.repositories[2], { status: 'pull-request', prId: 13 }); delete remote.repositories[2].creation; } for (const comment of review.comments) Object.assign(remote.publications[comment.id], { state: 'synced', remoteId: remote.publications[comment.id].remoteId || 200 + Number(comment.id.at(-1)), acknowledged: { body: comment.body, resolved: comment.resolved, deleted: false } }); return clone(remote); },
    previewMerge: async () => {
      for (const row of remote.repositories) row.check = { state: 'checking' };
      emitRemote();
      if (firstMergePreview) {
        firstMergePreview = false;
        await previewStep();
        for (const row of remote.repositories.slice(0, 2)) row.check = { state: 'ready' };
        emitRemote();
        await previewStep();
      }
      for (const row of remote.repositories) row.check = { state: row.status === 'unavailable' ? 'failed' : 'ready', ...(row.error ? { error: row.error } : {}) };
      emitRemote();
      return clone({ pullRequests: remote.pullRequests, repositories: remote.repositories, blockers: remote.repositories.filter(row => row.status === 'unavailable').map(row => row.error), warnings: [], updateSubmodulePointers: !!integrations.projects[project.id]?.updateSubmodulePointers, operation: remote.operation });
    },
    runPullRequestAction: async (_, action) => {
      calls.actions.push(action);
      const previous = remote.operation;
      remote.operation = { action, state: 'running', updatedAt: now, items: remote.pullRequests.map(pr => ({ prKey: `${pr.repository.relativePath}#${pr.id}`, approval: 'approved', merge: 'pending', sourceHash: pr.sourceHash, targetHash: pr.targetHash })) };
      const [parent, child, docs] = remote.operation.items;
      if (action === 'merge' && docs && previous?.action === 'merge') { Object.assign(docs, { merge: 'merged', cleanup: 'retained' }); remote.pullRequests[2].state = 'MERGED'; }
      if (action === 'approve') {
        emitRemote();
        await new Promise(resolve => setTimeout(resolve, 80));
        remote.operation.state = 'complete';
      } else if (calls.actions.filter(item => item === 'merge').length === 1) {
        Object.assign(child, { merge: 'merging', phase: 'merging' });
        Object.assign(docs, { merge: 'merging', phase: 'merging' });
        emitRemote();
        await operationStep();
        Object.assign(child, { merge: 'merged', phase: 'cleanup', mergeCommit: 'core-merge-result' });
        emitRemote();
        await operationStep();
        Object.assign(child, { cleanup: 'deleted' }); delete child.phase;
        remote.pullRequests[1].state = 'MERGED';
        Object.assign(docs, { merge: 'merged', cleanup: 'retained' }); delete docs.phase;
        remote.pullRequests[2].state = 'MERGED';
        Object.assign(parent, { merge: 'merging', phase: 'merging' });
        emitRemote();
        await operationStep();
        remote.operation.state = 'paused'; remote.operation.error = 'Core merged. The parent is waiting for its required build.';
        parent.merge = 'failed'; parent.error = 'Required build is still pending.'; delete parent.phase;
      } else {
        Object.assign(child, previous.items.find(item => item.prKey === child.prKey), { skipped: true });
        Object.assign(parent, { merge: 'merging', phase: 'merging' });
        emitRemote();
        await operationStep();
        Object.assign(parent, { merge: 'merged', phase: 'cleanup', mergeCommit: 'parent-merge-result' });
        emitRemote();
        await operationStep();
        parent.cleanup = 'deleted'; delete parent.phase;
        remote.pullRequests[0].state = 'MERGED';
        remote.repositories[2].cleanup = { state: 'checking' }; emitRemote(); await operationStep();
        remote.repositories[2].cleanup = { state: 'sending' }; remote.repositories[3].cleanup = { state: 'sending' }; emitRemote(); await operationStep();
        remote.repositories[2].cleanup = { state: 'deleted' }; docs.cleanup = 'deleted';
        remote.repositories[3].cleanup = { state: 'sending' }; emitRemote(); await operationStep();
        remote.repositories[3].cleanup = { state: 'deleted' }; remote.repositories[4].cleanup = { state: 'skipped' };
        remote.operation.state = 'complete';
      }
      emitRemote();
      return clone(remote);
    },
    addComment: async (_, input) => { review.comments.push({ ...input, createdAt: now, resolved: false }); remote.publications[input.id] = { commentId: input.id, anchor: anchor(input), state: 'draft' }; return clone(review); },
    updateComment: async (_, id, changes) => { Object.assign(review.comments.find(item => item.id === id), changes); return clone(review); },
    deleteComment: async (_, id) => { review.comments = review.comments.filter(item => item.id !== id); return clone(review); },
    setApprovals: async (_, chosen, approved) => { for (const file of chosen) { if (approved) review.approvals[file.fileId] = file.fingerprint; else delete review.approvals[file.fileId]; } return clone(review); },
    copyFeedback: async () => 'Feedback copied',
  };
  contextBridge.exposeInMainWorld('reviewAPI', api);
  contextBridge.exposeInMainWorld('integrationSmoke', {
    inspect: () => clone({ calls, integrations, state, review, remote }),
    advanceLoad: () => { if (!advanceLoad) throw new Error('No repository load is waiting.'); advanceLoad(); },
    advancePreview: () => { if (!advancePreview) throw new Error('No merge preview is waiting.'); advancePreview(); },
    emitOldLoad: () => { for (const listener of loadListeners) listener(clone({ ...lastLoadEvent, sequence: loadSequence - 1, complete: false, result: { review, snapshot: { ...snapshot(review.id), files: [], loading: true } } })); },
    failNextPublication: () => { failNextPublication = true; },
    setRepositoryUnavailable: unavailable => { remote.repositories[2].status = unavailable ? 'unavailable' : 'changes'; if (unavailable) remote.repositories[2].error = 'Docs repository permission is missing.'; else delete remote.repositories[2].error; emitRemote(); },
    setSnapshotMode: mode => { snapshotMode = mode; },
    advanceOperation: () => { if (!advanceOperation) throw new Error('No operation step is waiting.'); advanceOperation(); },
    markAsyncFinishedAwaitingResume: () => {
      remote.operation.state = 'paused';
      remote.operation.error = 'Bitbucket accepted the merge. Resume to confirm its result.';
      Object.assign(remote.operation.items[0], { merge: 'merging', taskId: 'finished-merge-task' });
      for (const pr of remote.pullRequests) pr.state = 'MERGED';
      emitRemote();
    },
  });
}

async function dialog(page, title) {
  const panel = page.getByRole('dialog');
  await panel.getByRole('heading', { name: title, exact: true }).waitFor();
  return panel;
}

try {
  await mkdir('artifacts', { recursive: true });
  await writeFile(join(fixture, 'preload.cjs'), `(${fixtureBridge.toString()})();`);
  await mkdir(join(fixture, 'data'));
  await writeFile(join(fixture, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(fixture, 'data'))}); app.whenReady().then(()=>{ const window=new BrowserWindow({width:1500,height:980,webPreferences:{preload:${JSON.stringify(join(fixture, 'preload.cjs'))}},show:true}); window.loadFile(${JSON.stringify(resolve('dist/index.html'))}); }); app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [join(fixture, 'main.cjs')], env });
  const page = await desktop.firstWindow({ timeout: 20000 }); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  await page.getByRole('tab', { name: 'Platform', exact: true }).waitFor();
  // Each provider has a guided full-page setup. Hidden panels remain mounted
  // so moving between accounts never discards an unsubmitted token or site URL.
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  const settingsView = page.getByRole('region', { name: 'Settings', exact: true });
  await settingsView.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Settings replaces the review workspace rather than opening a modal.');
  assert.equal(await settingsView.getByRole('tablist', { name: 'Settings sections', exact: true }).getAttribute('aria-orientation'), 'vertical');
  const jiraTab = settingsView.getByRole('tab', { name: 'Jira', exact: true });
  const bitbucketTab = settingsView.getByRole('tab', { name: 'Bitbucket', exact: true });
  const updatesTab = settingsView.getByRole('tab', { name: 'Updates', exact: true });
  const diagnosticsTab = settingsView.getByRole('tab', { name: 'Diagnostics', exact: true });
  assert.equal(await jiraTab.getAttribute('aria-selected'), 'true');
  let panel = settingsView.getByRole('tabpanel', { name: 'Jira', exact: true });
  await panel.getByRole('textbox', { name: 'Jira site URL', exact: true }).fill('https://jira.example.atlassian.net');
  await panel.getByRole('textbox', { name: 'Account email', exact: true }).fill('jira@example.org');
  await panel.getByRole('textbox', { name: 'Account label (optional)', exact: true }).fill('Work Jira');
  await panel.getByLabel('API token', { exact: true }).fill('jira-fixture-token');
  for (const scope of ['read:jira-user', 'read:jira-work']) await panel.getByText(scope, { exact: true }).waitFor();
  await panel.getByRole('link', { name: 'Create Jira API token', exact: true }).click();
  await panel.getByRole('button', { name: 'Copy required scopes', exact: true }).click();
  await settingsView.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/settings-jira-setup.png', animations: 'disabled' });
  await jiraTab.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await bitbucketTab.getAttribute('aria-selected'), 'true', 'ArrowDown selects the next settings section.');
  assert.equal(await bitbucketTab.evaluate(element => element === document.activeElement), true);
  panel = settingsView.getByRole('tabpanel', { name: 'Bitbucket', exact: true });
  for (const scope of ['read:user:bitbucket', 'read:repository:bitbucket', 'read:pullrequest:bitbucket', 'write:pullrequest:bitbucket', 'write:repository:bitbucket']) await panel.getByText(scope, { exact: true }).waitFor();
  await panel.getByRole('link', { name: 'Create Bitbucket API token', exact: true }).click();
  await panel.getByRole('button', { name: 'Copy required scopes', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.integrationSmoke.inspect().calls.scopeCopies), ['jira', 'bitbucket'], 'Scope buttons send only the provider identity to the trusted clipboard handler.');
  assert.equal(await panel.getByRole('textbox', { name: 'Jira site URL', exact: true }).count(), 0);
  await panel.getByRole('textbox', { name: 'Account label (optional)', exact: true }).fill('Work Bitbucket');
  await panel.getByRole('textbox', { name: 'Account email', exact: true }).fill('bitbucket@example.org');
  await panel.getByLabel('API token', { exact: true }).fill('expired');
  await settingsView.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/settings-bitbucket-setup.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The guided setup form must fit the minimum desktop width.');
  await page.screenshot({ path: 'artifacts/settings-bitbucket-setup-minimum.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
  await bitbucketTab.focus();
  await page.keyboard.press('End');
  assert.equal(await diagnosticsTab.getAttribute('aria-selected'), 'true', 'End selects the last settings section.');
  const diagnosticsPanel = settingsView.getByRole('tabpanel', { name: 'Diagnostics', exact: true });
  await diagnosticsPanel.getByText('/fixture/logs/integrations.log', { exact: true }).waitFor();
  await diagnosticsPanel.getByRole('button', { name: 'Open integration log', exact: true }).click();
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().calls.logOpens), 1);
  await diagnosticsTab.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await updatesTab.getAttribute('aria-selected'), 'true', 'ArrowUp selects Updates before Diagnostics.');
  await page.keyboard.press('Home');
  assert.equal(await jiraTab.getAttribute('aria-selected'), 'true', 'Home returns to Jira.');
  panel = settingsView.getByRole('tabpanel', { name: 'Jira', exact: true });
  assert.equal(await panel.getByRole('textbox', { name: 'Jira site URL', exact: true }).inputValue(), 'https://jira.example.atlassian.net');
  assert.equal(await panel.getByRole('textbox', { name: 'Account email', exact: true }).inputValue(), 'jira@example.org');
  assert.equal(await panel.getByRole('textbox', { name: 'Account label (optional)', exact: true }).inputValue(), 'Work Jira');
  assert.equal(await panel.getByLabel('API token', { exact: true }).inputValue(), 'jira-fixture-token', 'Unsubmitted Jira credentials survive tab changes.');
  await bitbucketTab.click();
  panel = settingsView.getByRole('tabpanel', { name: 'Bitbucket', exact: true });
  assert.equal(await panel.getByLabel('API token', { exact: true }).inputValue(), 'expired', 'The Bitbucket draft survives independently.');
  await panel.getByRole('button', { name: 'Verify and save account', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'expired or invalid' }).waitFor();
  await panel.getByLabel('API token', { exact: true }).fill('fixture-token');
  await panel.getByRole('button', { name: 'Verify and save account', exact: true }).click();
  await panel.getByText(/account verified and saved\. Choose it in your project integrations\./).waitFor();
  assert.equal(await panel.getByLabel('API token', { exact: true }).count(), 0, 'Token editor closes after successful verification.');
  await panel.getByRole('button', { name: 'Test', exact: true }).click();
  await panel.getByText('Work Bitbucket: connection verified.').waitFor();
  await panel.getByRole('button', { name: 'Replace token', exact: true }).click();
  assert.equal(await panel.getByLabel('API token', { exact: true }).inputValue(), '', 'Stored tokens are never returned to the form.');
  await panel.getByLabel('API token', { exact: true }).fill('replacement-fixture-token');
  await panel.getByRole('button', { name: 'Verify and save account', exact: true }).click();
  await panel.getByText(/account verified and saved\. Choose it in your project integrations\./).waitFor();
  await jiraTab.click();
  panel = settingsView.getByRole('tabpanel', { name: 'Jira', exact: true });
  assert.equal(await panel.getByText('Work Bitbucket', { exact: true }).count(), 0, 'Each section lists only its own provider accounts.');
  await panel.getByRole('button', { name: 'Verify and save account', exact: true }).click();
  await panel.getByText('Work Jira', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Add another Jira account', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/integration-connections.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Settings must not create horizontal overflow at minimum size.');
  const backBox = await settingsView.getByRole('button', { name: 'Back to review', exact: true }).boundingBox();
  const sidebarBox = await settingsView.getByRole('tablist', { name: 'Settings sections', exact: true }).boundingBox();
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  assert.ok(backBox && backBox.x >= 0 && backBox.y >= 0 && backBox.x + backBox.width <= size.width && backBox.y + backBox.height <= size.height, 'Back to review remains reachable at minimum size.');
  assert.ok(sidebarBox && sidebarBox.x >= 0 && sidebarBox.x + sidebarBox.width < size.width / 2, 'Settings tabs remain in the left-hand sidebar.');
  await page.screenshot({ path: 'artifacts/integration-settings-minimum.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
  await settingsView.getByRole('button', { name: 'Back to review', exact: true }).click();
  await settingsView.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Browse Bitbucket pull requests', exact: true }).click();
  panel = await dialog(page, 'Platform integrations');
  await panel.getByRole('combobox', { name: 'Bitbucket account', exact: true }).selectOption('bb');
  await panel.getByRole('combobox', { name: 'Jira account', exact: true }).selectOption('jira');
  await panel.getByRole('button', { name: 'Discover', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Repository 2 local path', exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Repository 2 workspace', exact: true }).fill('corrected-workspace');
  await panel.getByRole('checkbox', { name: /Update submodule pointers when merging/ }).check();
  await panel.getByRole('button', { name: 'Save integrations', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Browse Bitbucket pull requests', exact: true }).click();
  panel = await dialog(page, 'Pull requests');
  await panel.getByRole('button', { name: 'Review branch', exact: true }).first().waitFor();
  await panel.getByText('Fork pull requests are not supported yet.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('checkbox').count(), 0, 'Repository inclusion cannot silently exclude changes from a branch review.');
  await panel.getByRole('button', { name: 'Created by me', exact: true }).click();
  await panel.getByRole('button', { name: 'Review branch', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Needs my review', exact: true }).click();
  await panel.getByRole('button', { name: 'Review branch', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'All open', exact: true }).click();
  await panel.getByText('Fork pull requests are not supported yet.', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/integration-inbox.png', animations: 'disabled' });
  // Install before selecting the remote review so any newly scheduled refresh
  // interval is advanced by the clock instead of waiting a real minute.
  await page.clock.install();
  await panel.getByRole('button', { name: 'Review branch', exact: true }).first().click();
  await page.getByRole('button', { name: 'Publish feedback', exact: true }).waitFor();
  const centralLoading = page.getByRole('region', { name: 'Repository loading progress', exact: true });
  await centralLoading.getByRole('listitem', { name: 'platform loading progress', exact: true }).waitFor();
  assert.equal(await centralLoading.locator('.spin').count(), 5, 'Repository loading is visible in the empty review area.');
  assert.equal(await page.getByRole('button', { name: 'Publish feedback', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Approve and merge', exact: true }).isDisabled(), true);
  await page.screenshot({ path: 'artifacts/integration-loading-repositories.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceLoad());
  await page.locator('.diff-file-name').filter({ hasText: 'review.ts' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), true, 'The first repository is reviewable before the remaining repositories load.');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByText('Loaded files reviewed.', { exact: true }).waitFor();
  assert.equal(await page.getByText('You’re all caught up.', { exact: true }).count(), 0, 'Finishing the loaded files must not imply the whole review is complete.');
  assert.equal(await page.getByText('All caught up', { exact: true }).count(), 0, 'The file tree also waits until all repositories finish loading.');
  await page.evaluate(() => window.integrationSmoke.advanceLoad());
  await page.locator('.diff-file-name').filter({ hasText: 'guide.ts' }).waitFor();
  await page.locator('.diff-content').evaluate(node => { window.integrationDiffNode = node; node.scrollTop = 12; window.integrationDiffScroll = node.scrollTop; });
  await page.screenshot({ path: 'artifacts/integration-review-while-loading.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceLoad());
  await page.locator('.remote-review-actions > .button:not([disabled])').first().waitFor();
  await page.evaluate(() => window.integrationSmoke.emitOldLoad());
  assert.equal(await page.locator('.diff-content').evaluate(node => node === window.integrationDiffNode && node.scrollTop === window.integrationDiffScroll), true, 'Later repository arrivals retain the selected diff and scroll position.');
  assert.equal(await page.locator('.diff-file-name').filter({ hasText: 'guide.ts' }).count(), 1, 'Older progress cannot replace a finished snapshot.');
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().review.approvals['.:review.ts']), 'current-file');
  await page.getByRole('combobox', { name: 'Filter changed files', exact: true }).click();
  await page.getByRole('option', { name: 'All files', exact: true }).click();
  await page.locator('[data-item-path="review.ts"]').click();
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter changed files', exact: true }).click();
  await page.getByRole('option', { name: 'Unreviewed', exact: true }).click();
  const repositoryRoster = page.getByRole('list', { name: 'Branch review repositories', exact: true });
  await repositoryRoster.getByRole('listitem', { name: 'docs branch review', exact: true }).getByText('Changes without a PR', { exact: true }).waitFor();
  await repositoryRoster.getByRole('listitem', { name: 'assets branch review', exact: true }).getByText('No changes', { exact: true }).waitFor();
  await repositoryRoster.getByRole('listitem', { name: 'absent branch review', exact: true }).getByText('Branch missing', { exact: true }).waitFor();
  await page.locator('[data-item-path="review.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'review.ts' }).waitFor();
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByText('Checking repositories…', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 5, 'Every repository has its own preflight spinner.');
  assert.equal(await panel.locator('.integration-loading').count(), 0, 'Merge checks do not add a separate generic spinner above the repositories.');
  await page.screenshot({ path: 'artifacts/integration-merge-parallel-checks.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advancePreview());
  await panel.getByText('2 / 5', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 3);
  await page.evaluate(() => window.integrationSmoke.advancePreview());
  await panel.getByRole('listitem', { name: 'docs branch cleanup', exact: true }).getByText('Create PR, then merge', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).isEnabled(), true, 'A missing PR does not block merging reviewed changes.');
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.integrationSmoke.setRepositoryUnavailable(true));
  await repositoryRoster.getByRole('listitem', { name: 'docs branch review', exact: true }).getByText('Unavailable', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('alert').filter({ hasText: 'Docs repository permission is missing.' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).isDisabled(), true, 'Unavailable repositories cannot silently disappear from a merge.');
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.integrationSmoke.setRepositoryUnavailable(false));
  await page.locator('[aria-label="Refresh review"]:not([disabled])').waitFor();
  const refreshCount = id => page.evaluate(id => window.integrationSmoke.inspect().calls.refreshes.filter(value => value === id).length, id);
  const initialRemoteRefreshes = await refreshCount('remote-review');
  assert.ok(initialRemoteRefreshes > 0, 'Opening a remote review loads a fresh snapshot.');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(61000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await refreshCount('remote-review'), initialRemoteRefreshes, 'A remote review keeps its loaded snapshot when the window regains focus, becomes visible, or a minute passes.');
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Current', exact: true }).click();
  await page.locator('[aria-label="Select review"][data-value="current:project-1"]').waitFor();
  await page.locator('[aria-label="Refresh review"]:not([disabled])').waitFor();
  const currentRefreshes = await refreshCount('current:project-1');
  await page.clock.fastForward(4500);
  await page.waitForFunction(count => window.integrationSmoke.inspect().calls.refreshes.filter(id => id === 'current:project-1').length > count, currentRefreshes);
  assert.equal(await refreshCount('remote-review'), initialRemoteRefreshes, 'Local checkout polling does not refresh an inactive remote review.');
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'APP-123 · 2 pull requests', exact: true }).click();
  await page.locator('[data-item-path="review.ts"]').click();
  await page.waitForFunction(count => window.integrationSmoke.inspect().calls.refreshes.filter(id => id === 'remote-review').length > count, initialRemoteRefreshes);
  await page.locator('[aria-label="Refresh review"]:not([disabled])').waitFor();
  assert.equal(await refreshCount('remote-review'), initialRemoteRefreshes + 1, 'Reopening a saved remote review refreshes its snapshot once.');
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.locator('[aria-label="Refresh review"]:not([disabled])').waitFor();
  assert.equal(await refreshCount('remote-review'), initialRemoteRefreshes + 2, 'The explicit refresh button still reloads a remote review.');

  await page.getByRole('button', { name: /APP-123.*Bring code review/ }).click();
  await page.getByText('Keep feedback on the exact lines.').waitFor();
  assert.equal(await page.locator('.jira-description img').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Unsafe link', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Engineering docs', exact: true }).click();
  await page.getByRole('textbox', { name: 'Review ticket key', exact: true }).fill('OPS-789');
  await page.getByRole('button', { name: 'Use ticket', exact: true }).click();
  await page.getByText('A manually linked ticket', { exact: true }).waitFor();
  await page.getByRole('button', { name: /OPS-789.*A manually linked ticket/ }).click();
  const refreshesBeforePublicationPreview = await refreshCount('remote-review');
  await page.getByRole('button', { name: 'Publish feedback', exact: true }).click();
  panel = await dialog(page, 'Publish feedback');
  await panel.getByText('The PR changed. Choose current lines before publishing.', { exact: true }).first().waitFor();
  assert.equal(await refreshCount('remote-review'), refreshesBeforePublicationPreview + 1, 'Opening publication refreshes the reviewed snapshot before validating feedback anchors.');
  assert.equal(await panel.getByRole('region', { name: 'Pull requests in Bitbucket', exact: true }).getByRole('link', { name: /^Open PR\s*:/ }).count(), 2, 'Each grouped PR is accessible even when publication is blocked.');
  assert.equal(await panel.getByRole('button', { name: 'Publish to Bitbucket', exact: true }).isDisabled(), true);
  const stale = panel.locator('.feedback-publication').filter({ hasText: 'This comment needs current lines.' });
  await stale.getByRole('button', { name: 'Choose current lines…', exact: true }).click();
  await page.locator('.reanchor-banner').waitFor();
  // Pierre renders line-number elements into open shadow roots.
  const gutter = page.locator('[data-column-number="2"][data-line-type="change-addition"]');
  await gutter.waitFor();
  await gutter.click();
  await page.locator('.reanchor-banner').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Publish feedback', exact: true }).click();
  panel = await dialog(page, 'Publish feedback');
  const unknown = panel.locator('.feedback-publication').filter({ hasText: 'Confirm delivery before retrying.' });
  assert.equal(await unknown.getByRole('button', { name: 'Allow retry', exact: true }).isDisabled(), true);
  await unknown.getByRole('checkbox', { name: 'I checked Bitbucket: this comment was not posted.', exact: true }).check();
  await unknown.getByRole('button', { name: 'Allow retry', exact: true }).click();
  await panel.getByRole('button', { name: 'Use Bitbucket version', exact: true }).click();
  await panel.getByRole('button', { name: 'Use Bitbucket version', exact: true }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'artifacts/integration-publish-preview.png', animations: 'disabled' });
  await panel.getByText('modules/docs · Create PR on publish', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().remote.pullRequests)).length, 2, 'Draft comments do not create a PR.');
  await page.evaluate(() => window.integrationSmoke.failNextPublication());
  await panel.getByRole('button', { name: 'Publish to Bitbucket', exact: true }).click();
  await panel.getByText('Bitbucket is temporarily unavailable. Try publishing again.', { exact: true }).waitFor();
  await panel.getByRole('link', { name: /^Open PR\s*:\s*platform #11$/ }).click();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.links)).at(-1), 'https://bitbucket.org/acme/platform/pull-requests/11', 'Publication failures retain the actual PR link for manual inspection.');
  await panel.getByRole('button', { name: 'Publish to Bitbucket', exact: true }).click();
  await panel.getByText('Feedback published to Bitbucket.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Publish to Bitbucket', exact: true }).isDisabled(), true, 'Already-published comments cannot be posted twice.');
  assert.equal(await panel.locator('.feedback-publication').count(), 0);
  await panel.getByRole('link', { name: /^Open PR\s*:\s*platform #11$/ }).click();
  await panel.getByRole('link', { name: /^Open PR\s*:\s*core #12$/ }).click();
  assert.deepEqual((await page.evaluate(() => window.integrationSmoke.inspect().calls.links)).slice(-2), ['https://bitbucket.org/acme/platform/pull-requests/11', 'https://bitbucket.org/acme/core/pull-requests/12'], 'Publishing keeps both repository links after successful items leave the preview.');
  await panel.getByRole('button', { name: 'Refresh delivery status', exact: true }).click();
  await panel.getByText('No feedback to publish.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('region', { name: 'Pull requests in Bitbucket', exact: true }).getByRole('link', { name: /^Open PR\s*:/ }).count(), 3, 'PR links also remain after refreshing an empty publication preview.');
  await panel.getByRole('link', { name: /^Open PR\s*:\s*docs #13$/ }).waitFor();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().remote.pullRequests)).length, 3, 'Publishing creates the missing PR and keeps its link visible.');
  await page.screenshot({ path: 'artifacts/integration-published-pr-links.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.locator('[data-comment-id="10000000-0000-4000-8000-000000000001"]').getByRole('button', { name: 'Edit comment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Comment text', exact: true }).fill('Updated feedback after the first publication.');
  await page.getByRole('button', { name: 'Publish feedback', exact: true }).click();
  panel = await dialog(page, 'Publish feedback');
  await panel.getByText('Updated feedback after the first publication.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Publish to Bitbucket', exact: true }).click();
  await panel.getByText('Feedback published to Bitbucket.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.screenshot({ path: 'artifacts/integration-review-minimum.png', animations: 'disabled' });
  const controls = await page.locator('.remote-review-actions').boundingBox();
  assert.ok(controls && controls.x >= 0 && controls.x + controls.width <= 1050, 'Connected review actions fit the minimum desktop width.');
  await page.evaluate(() => window.integrationSmoke.setSnapshotMode('pointers'));
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByText('Review the submodule pointers above.', { exact: true }).waitFor();
  await page.getByText('abc123456789', { exact: true }).waitFor();
  await page.getByText('def123456789', { exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.setSnapshotMode('incomplete'));
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByText('This review is incomplete.', { exact: true }).waitFor();
  assert.equal(await page.getByText('You’re all caught up.', { exact: true }).count(), 0);
  await page.evaluate(() => window.integrationSmoke.setSnapshotMode('unavailable'));
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByText('This file could not be loaded', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.integrationSmoke.setSnapshotMode('normal'));
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 980));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  panel = await dialog(page, 'Approve pull requests');
  await panel.getByRole('button', { name: 'Approve pull requests', exact: true }).click();
  await panel.getByText('Repositories approved', { exact: true }).waitFor();
  await panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true }).getByText('Skipped · no changes', { exact: true }).waitFor();
  await panel.getByRole('listitem', { name: 'absent branch cleanup', exact: true }).getByText('Skipped · branch missing', { exact: true }).waitFor();
  await panel.getByText('5 / 5', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'remote-review', 'Approval alone keeps the review open.');
  assert.equal(await page.getByRole('region', { name: 'Merge complete', exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true }).getByText('Skipped · no changes', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).click();
  let coreRow = panel.getByRole('listitem', { name: 'core pull request 12', exact: true });
  let parentRow = panel.getByRole('listitem', { name: 'platform pull request 11', exact: true });
  await coreRow.getByText('Merging…', { exact: true }).waitFor();
  await parentRow.getByText('Waiting', { exact: true }).waitFor();
  assert.equal(await coreRow.locator('.spin').count(), 1, 'The active child repository displays a spinning status.');
  await panel.getByRole('listitem', { name: 'docs pull request 13', exact: true }).getByText('Merging…', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 2, 'Independent repositories show simultaneous merge progress.');
  assert.equal(await parentRow.locator('.spin').count(), 0, 'Waiting repositories do not appear to be merging.');
  await page.screenshot({ path: 'artifacts/integration-merge-running.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await coreRow.getByText('Checking branch deletion…', { exact: true }).waitFor();
  assert.equal(await coreRow.getByText('Deleted', { exact: true }).count(), 0, 'Deletion is not claimed before cleanup is confirmed.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await coreRow.getByText('Merged', { exact: true }).waitFor();
  await coreRow.getByText('Deleted', { exact: true }).waitFor();
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await panel.getByText('Operation paused', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/integration-merge-paused.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Return to review', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'remote-review', 'A partial merge keeps the original review open for recovery.');
  assert.equal(await page.getByRole('region', { name: 'Merge complete', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Resume operation', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('button', { name: 'Resume operation', exact: true }).click();
  coreRow = panel.getByRole('listitem', { name: 'core pull request 12', exact: true });
  parentRow = panel.getByRole('listitem', { name: 'platform pull request 11', exact: true });
  await coreRow.getByText('Skipped · already merged', { exact: true }).waitFor();
  await coreRow.getByText('Deleted', { exact: true }).waitFor();
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/integration-merge-resuming.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await parentRow.getByText('Checking branch deletion…', { exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  const docsCleanupRow = panel.getByRole('listitem', { name: 'docs pull request 13', exact: true });
  await docsCleanupRow.getByText('Checking branch…', { exact: true }).waitFor();
  assert.equal(await docsCleanupRow.locator('.spin').count(), 1, 'Checking a retained source branch shows progress even after its PR has merged.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await docsCleanupRow.getByText('Deleting branch…', { exact: true }).waitFor();
  assert.equal(await docsCleanupRow.locator('.spin').count(), 1, 'Independent PR branch deletion displays a spinner.');
  await panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true }).getByText('Deleting branch…', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 2, 'Independent branch deletions show simultaneous progress.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await docsCleanupRow.getByText('Deleted', { exact: true }).waitFor();
  const assetsRow = panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true });
  await assetsRow.getByText('Deleting branch…', { exact: true }).waitFor();
  assert.equal(await assetsRow.locator('.spin').count(), 1, 'Empty repositories show live cleanup progress.');
  assert.equal(await page.getByRole('region', { name: 'Merge complete', exact: true }).count(), 0, 'The review stays open until empty branch cleanup completes.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  const receipt = page.getByRole('region', { name: 'Merge complete', exact: true });
  await receipt.getByRole('heading', { name: 'Pull requests merged', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'current:project-1');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'A successful group merge closes the operation dialog and active review.');
  assert.equal(await page.locator('.remote-review-controls').count(), 0, 'The closed review leaves no stale Bitbucket controls behind the completion receipt.');
  assert.equal(await receipt.getByText('Deleted', { exact: true }).count(), 4, 'The completed receipt retains every confirmed branch deletion.');
  await receipt.getByRole('button', { name: 'Open in Jira', exact: true }).click();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.links)).at(-1), 'https://jira.example.atlassian.net/browse/OPS-789', 'The completion action opens the explicitly linked Jira ticket.');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The completion receipt fits the minimum desktop width.');
  await page.screenshot({ path: 'artifacts/integration-merge-complete-minimum.png', animations: 'disabled' });
  const savedAfterMerge = await page.evaluate(() => window.integrationSmoke.inspect().state.reviews.find(review => review.id === 'remote-review'));
  assert.equal(savedAfterMerge.comments[0].body, 'Updated feedback after the first publication.', 'Closing the review preserves its saved feedback.');
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'APP-123 · 2 pull requests', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await receipt.getByRole('button', { name: 'Dismiss merge results', exact: true }).click();
  await receipt.waitFor({ state: 'hidden' });
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'APP-123 · 2 pull requests', exact: true }).click();
  await page.locator('[data-item-path="review.ts"]').click();
  await page.locator('[data-comment-id="10000000-0000-4000-8000-000000000001"]').getByText('Updated feedback after the first publication.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'remote-review', 'A completed saved review can still be reopened to inspect its feedback.');
  await page.evaluate(() => window.integrationSmoke.markAsyncFinishedAwaitingResume());
  await page.getByRole('button', { name: 'Resume operation', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByText('Bitbucket accepted the merge. Resume to confirm its result.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().remote.pullRequests.every(pr => pr.state === 'MERGED')), true);
  assert.equal(await panel.getByRole('button', { name: 'Resume operation', exact: true }).isEnabled(), true, 'A paused asynchronous merge can reconcile after every PR has finished remotely.');
  await panel.getByRole('button', { name: 'Return to review', exact: true }).click();
  const refreshesBeforeReviewed = await refreshCount('remote-review');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.getByText('You’re all caught up.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().review.approvals['.:review.ts']), 'current-file');
  assert.equal(await refreshCount('remote-review'), refreshesBeforeReviewed, 'Mark reviewed saves the displayed fingerprint and advances without refreshing the remote snapshot.');
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Current', exact: true }).click();
  await page.getByRole('button', { name: 'App settings', exact: true }).click();
  await settingsView.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await settingsView.getByRole('tab', { name: 'Jira', exact: true }).click();
  panel = settingsView.getByRole('tabpanel', { name: 'Jira', exact: true });
  await panel.getByRole('button', { name: 'Disconnect Work Jira', exact: true }).click();
  await panel.getByText('Reconnect to continue using this account.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Reconnect', exact: true }).click();
  assert.equal(await panel.getByRole('textbox', { name: 'Account email', exact: true }).inputValue(), 'jira@example.org');
  await panel.getByLabel('API token', { exact: true }).fill('reconnected-jira-fixture-token');
  await panel.getByRole('button', { name: 'Verify and save account', exact: true }).click();
  await panel.getByText(/account verified and saved\. Choose it in your project integrations\./).waitFor();
  await settingsView.getByRole('button', { name: 'Back to review', exact: true }).click();
  const data = await page.evaluate(() => window.integrationSmoke.inspect());
  assert.deepEqual(data.calls.filters.slice(0, 4), ['all', 'author', 'reviewer', 'all']);
  assert.deepEqual(data.calls.opens, [[{ repositoryPath: '.', prId: 11 }]]);
  assert.equal(data.calls.publish, 3);
  assert.equal(data.review.comments[0].body, 'Updated feedback after the first publication.');
  assert.equal(data.calls.reanchors.length, 1);
  assert.equal(data.calls.unknown[0].remoteId, null);
  assert.deepEqual(data.calls.conflicts, ['remote']);
  assert.equal(data.review.comments[3].body, 'Wording edited in Bitbucket.');
  assert.deepEqual(data.calls.actions, ['approve', 'merge', 'merge']);
  assert.deepEqual(data.calls.links, ['https://id.atlassian.com/manage-profile/security/api-tokens', 'https://id.atlassian.com/manage-profile/security/api-tokens', 'https://docs.example.org/reviews', 'https://bitbucket.org/acme/platform/pull-requests/11', 'https://bitbucket.org/acme/platform/pull-requests/11', 'https://bitbucket.org/acme/core/pull-requests/12', 'https://jira.example.atlassian.net/browse/OPS-789']);
  assert.equal(data.integrations.projects['project-1'].repositories[1].workspace, 'corrected-workspace');
  assert.equal(data.integrations.projects['project-1'].updateSubmodulePointers, true);
  assert.equal(data.integrations.connections.find(item => item.kind === 'jira').id, 'jira');
  assert.equal(data.integrations.connections.find(item => item.kind === 'jira').connected, true);
  assert.deepEqual(errors, []);
  console.log('Integration desktop smoke passed: full-page settings, keyboard sidebar tabs, preserved setup drafts, token generator links, copied scope guidance, separate credentials, invalid/replaced tokens, mappings, whole-branch entry with fixed membership, missing PR draft/publication creation links, empty and missing branch visibility and live deletion, filters/grouping/forks, cached remote snapshots with explicit opening/publication refresh, local checkout polling, progressive parallel repository loading with early review and preserved feedback/selection, per-repository preflight spinners, marking reviewed without refresh, Jira ADF/manual key, stale re-anchoring, delivery recovery, conflicts, publish with grouped PR links after failure and success, approve-only preservation, live repository merge/cleanup, paused merge/resume with skipped children, automatic review closing with saved feedback, Jira completion action, and minimum-width layout. Atlassian calls were stubbed.');
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await page.screenshot({ path: 'artifacts/integration-smoke-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 16000));
  }
  console.error('Renderer errors:', errors);
  throw error;
} finally { await desktop?.close().catch(() => {}); await rm(fixture, { recursive: true, force: true }); }
