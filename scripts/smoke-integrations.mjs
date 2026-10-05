import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

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
  const cleanupReviews = [
    ['closed-merged', 'Old merged review'], ['closed-declined', 'Old declined review'], ['closed-reopened', 'Reopened during cleanup'],
    ['closed-open', 'Still active review'], ['closed-unavailable', 'Unavailable review'], ['closed-blocked', 'Unfinished cleanup review'],
  ].map(([id, name]) => ({ ...local, id, name, kind: 'saved', remote: true, includeWorkingTree: false, comments: id === 'closed-merged' ? [comment(6, 'An unpublished local note.')] : [] }));
  const state = { projects: [project], reviews: [local, ...cleanupReviews], settings: { jiraBaseUrl: '', jiraTicketView: 'summary', theme: 'system' } };
  const integrations = { connections: [], projects: {} };
  const calls = { scopeCopies: [], filters: [], opens: [], actions: [], publish: 0, reanchors: [], links: [], unknown: [], conflicts: [], refreshes: [], logOpens: 0, completed: [], mergePreviews: 0 };
  Object.assign(calls, { cleanupChecks: [], cleanupRemovals: [], activeCleanupChecks: 0, maxCleanupChecks: 0 });
  let holdCleanupChecks = true;
  const cleanupWaiters = [];
  let reopenedDuringCleanup = false;
  let recoveredCleanupAccess = false;
  let cleanupMetadataFailed = false;
  const automaticScenarios = new Map();
  let releaseAutomaticRemoval;
  Object.assign(calls, { automaticRemovals: [], remoteReads: [] });
  const automaticResult = id => ({ ...cleanupResult(id), status: 'closed', unpublishedComments: 0, reason: undefined });
  const cleanupResult = id => {
    const saved = cleanupReviews.find(item => item.id === id);
    if (!saved) throw new Error('Unknown cleanup fixture review');
    const status = id === 'closed-open' || id === 'closed-reopened' && reopenedDuringCleanup ? 'open' : id === 'closed-unavailable' && !recoveredCleanupAccess ? 'unavailable' : id === 'closed-blocked' ? 'blocked' : 'closed';
    return { reviewId: id, name: saved.name, status, unpublishedComments: id === 'closed-merged' ? 1 : 0,
      pullRequests: [{ repositoryPath: '.', repoSlug: 'platform', id: 31, url: 'https://bitbucket.org/acme/platform/pull-requests/31', state: status === 'open' ? 'OPEN' : id === 'closed-declined' ? 'DECLINED' : 'MERGED' }],
      ...(status === 'open' ? { reason: 'A pull request is still open.' } : status === 'unavailable' ? { reason: 'Bitbucket could not verify this review. Reconnect and check again.' } : status === 'blocked' ? { reason: 'Finish branch cleanup before removing this review.' } : {}) };
  };
  const remoteListeners = new Set();
  const loadListeners = new Set();
  let loadSequence = 0;
  let advanceLoad;
  let advancePreview;
  let firstRemoteLoad = true;
  let firstMergePreview = true;
  let hasMergeConflicts = false;
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
  const getReview = id => state.reviews.find(item => item.id === id) || local;
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
    onGitWorkflowChanged: () => () => {},
    getGitStatus: async projectId => ({ projectId, repositories: [], branches: [] }),
    fetchGit: async projectId => ({ projectId, repositories: [], branches: [] }),
    onBeforeClose: () => () => {}, onCloseCancelled: () => () => {}, onUpdateStateChanged: () => () => {}, onUpdateDialogRequested: () => () => {},
    onRemoteReviewLoadProgress: listener => { loadListeners.add(listener); return () => { loadListeners.delete(listener); }; },
    onRemoteReviewChanged: listener => { remoteListeners.add(listener); return () => { remoteListeners.delete(listener); }; },
    getUpdateState: async () => ({ revision: 0, currentVersion: '0.10.0', phase: 'disabled', disabledReason: 'Updates disabled in fixture.' }),
    getState: async () => clone(state),
    updateSettings: async changes => { state.settings = { ...state.settings, ...changes }; return clone(state.settings); },
    refreshReview: async id => { calls.refreshes.push(id);
      const automatic = automaticScenarios.get(id);
      if (automatic) {
        const result = { review: getReview(id), snapshot: snapshot(id) };
        if (automatic === 'partial') return clone(result);
        if (automatic === 'failed') return clone({ ...result, closedReview: { ...automaticResult(id), status: 'unavailable', reason: 'Core could not be checked. This review was kept.' } });
        return clone({ ...result, closedReview: automaticResult(id) });
      }
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
    openPullRequestReview: async (_, refs) => { calls.opens.push(refs); state.reviews = [local, review, ...cleanupReviews]; return clone(review); },
    getRemoteReview: async id => {
      calls.remoteReads.push(id);
      if (automaticScenarios.has(id)) {
        if (!state.reviews.some(item => item.id === id)) throw new Error('Read after automatic deletion');
        const pullRequests = [pr(31, mappings[0], local.featureBranch, { state: 'MERGED' })];
        if (automaticScenarios.get(id) === 'partial') pullRequests.push(pr(32, mappings[1]));
        return clone({ connectionId: 'bb', pullRequests, publications: {}, repositories: [
          { repository: mappings[0], sourceBranch: local.featureBranch, targetBranch: 'main', status: 'pull-request', prId: 31 },
          { repository: mappings[2], sourceBranch: local.featureBranch, targetBranch: 'main', status: 'changes' },
        ] });
      }
      return id === review.id && state.reviews.some(item => item.id === id) ? clone(remote) : cleanupReviews.some(item => item.id === id) ? { connectionId: 'bb', pullRequests: [pr(31, mappings[0], local.featureBranch, { state: 'MERGED' })], publications: {} } : null;
    },
    checkClosedReview: async id => {
      calls.cleanupChecks.push(id); calls.activeCleanupChecks++;
      calls.maxCleanupChecks = Math.max(calls.maxCleanupChecks, calls.activeCleanupChecks);
      try { if (holdCleanupChecks) await new Promise(resolve => cleanupWaiters.push(resolve)); return clone(cleanupResult(id)); }
      finally { calls.activeCleanupChecks--; }
    },
    removeClosedReviews: async (projectId, reviewIds, options) => {
      if (projectId !== project.id) throw new Error('Wrong cleanup project');
      if (options?.automatic) {
        calls.automaticRemovals.push(clone(reviewIds));
        await new Promise(resolve => { releaseAutomaticRemoval = resolve; });
        const retained = reviewIds.filter(id => automaticScenarios.get(id) === 'drafts').map(id => ({ ...automaticResult(id), status: 'blocked', unpublishedComments: 1, reason: 'This completed review has unpublished feedback and was kept.' }));
        const removedIds = reviewIds.filter(id => !retained.some(item => item.reviewId === id));
        state.reviews = state.reviews.filter(item => !removedIds.includes(item.id));
        return clone({ state, removedIds, retained });
      }
      calls.cleanupRemovals.push(clone(reviewIds)); reopenedDuringCleanup = true;
      const results = reviewIds.map(cleanupResult);
      const removedIds = results.filter(item => item.status === 'closed').map(item => item.reviewId);
      state.reviews = state.reviews.filter(item => !removedIds.includes(item.id));
      if (removedIds.includes('closed-unavailable') && !cleanupMetadataFailed) {
        cleanupMetadataFailed = true;
        const failed = results.find(item => item.reviewId === 'closed-unavailable');
        return clone({ state, removedIds: removedIds.filter(id => id !== failed.reviewId), retained: [{ ...failed, status: 'unavailable', reason: 'The review was removed, but its local metadata still needs cleanup. Retry this removal or restart Branchline.' }] });
      }
      return clone({ state, removedIds, retained: results.filter(item => item.status !== 'closed') });
    },
    completeMergedReview: async id => { calls.completed.push(id); state.reviews = state.reviews.filter(item => item.id !== id); if (calls.completed.length === 1) throw new Error('The completion response was lost. Retry finishing this review.'); return clone(state); },
    getJiraTicketLink: async id => { if (id === review.id && !state.reviews.some(item => item.id === id)) throw new Error('Review not found.'); return { key: remote.ticketKey || 'APP-123', url: `https://jira.example.atlassian.net/browse/${remote.ticketKey || 'APP-123'}` }; },
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
      calls.mergePreviews++;
      for (const row of remote.repositories) row.check = { state: 'checking' };
      emitRemote();
      if (firstMergePreview) {
        firstMergePreview = false;
        await previewStep();
        for (const row of remote.repositories.slice(0, 2)) row.check = { state: 'ready' };
        emitRemote();
        await previewStep();
        for (const row of remote.repositories.slice(0, 2)) row.check = { state: 'queued' };
        emitRemote();
        await previewStep();
        for (const row of remote.repositories.slice(0, 2)) row.check = { state: 'checking' };
        emitRemote();
        await previewStep();
      }
      for (const row of remote.repositories) row.check = { state: row.status === 'unavailable' ? 'failed' : 'ready', ...(row.error ? { error: row.error } : {}) };
      if (hasMergeConflicts) remote.repositories[1].check = { state: 'failed', error: 'Merge conflicts' };
      emitRemote();
      return clone({ pullRequests: remote.pullRequests, repositories: remote.repositories, blockers: [...remote.repositories.filter(row => row.status === 'unavailable').map(row => row.error), ...(hasMergeConflicts ? ['core #12: Merge conflicts'] : [])], warnings: [], updateSubmodulePointers: !!integrations.projects[project.id]?.updateSubmodulePointers, operation: remote.operation });
    },
    runPullRequestAction: async (_, action) => {
      calls.actions.push(action);
      const previous = remote.operation;
      remote.operation = { action, state: 'running', updatedAt: now, items: remote.pullRequests.map(pr => ({ prKey: `${pr.repository.relativePath}#${pr.id}`, approval: action === 'approve' ? 'approved' : 'pending', merge: 'pending', sourceHash: pr.sourceHash, targetHash: pr.targetHash })) };
      const [parent, child, docs] = remote.operation.items;
      if (action === 'merge' && docs && previous?.action === 'merge') { Object.assign(docs, { merge: 'merged' }); remote.pullRequests[2].state = 'MERGED'; }
      if (action === 'approve') {
        emitRemote();
        await new Promise(resolve => setTimeout(resolve, 80));
        remote.operation.state = 'complete';
      } else if (calls.actions.filter(item => item === 'merge').length === 1) {
        Object.assign(child, { approval: 'approved', merge: 'merging', phase: 'merging' });
        Object.assign(docs, { approval: 'approved', merge: 'merging', phase: 'merging' });
        parent.phase = 'checking';
        remote.repositories[0].check = { state: 'checking' };
        emitRemote();
        await operationStep();
        Object.assign(parent, { approval: 'sending', phase: 'approving' });
        remote.repositories[0].check = { state: 'ready' };
        emitRemote();
        await operationStep();
        Object.assign(parent, { approval: 'approved', phase: 'merging' });
        emitRemote();
        await operationStep();
        remote.repositories[0].check = { state: 'queued' };
        emitRemote();
        await operationStep();
        remote.repositories[0].check = { state: 'checking' };
        Object.assign(child, { merge: 'merged', mergeCommit: 'core-merge-result' }); delete child.phase;
        remote.pullRequests[1].state = 'MERGED';
        emitRemote();
        await operationStep();
        Object.assign(docs, { merge: 'merged' }); delete docs.phase;
        remote.pullRequests[2].state = 'MERGED';
        Object.assign(parent, { merge: 'merging', phase: 'merging' });
        remote.repositories[0].check = { state: 'ready' };
        emitRemote();
        await operationStep();
        remote.repositories[0].check = { state: 'checking' };
        emitRemote();
        await operationStep();
        remote.repositories[0].check = { state: 'ready' };
        remote.operation.state = 'paused'; remote.operation.error = 'Core merged. The parent is waiting for its required build.';
        parent.merge = 'failed'; parent.error = 'Required build is still pending.'; delete parent.phase;
      } else {
        Object.assign(child, previous.items.find(item => item.prKey === child.prKey), { skipped: true });
        Object.assign(parent, { merge: 'merging', phase: 'merging' });
        emitRemote();
        await operationStep();
        Object.assign(parent, { merge: 'merged', phase: 'cleanup', mergeCommit: 'parent-merge-result' });
        remote.pullRequests[0].state = 'MERGED';
        remote.repositories[0].cleanup = { state: 'checking' };
        remote.repositories[2].cleanup = { state: 'checking' };
        remote.repositories[3].cleanup = { state: 'checking' };
        remote.repositories[4].cleanup = { state: 'skipped' };
        emitRemote();
        await operationStep();
        parent.cleanup = 'deleted'; delete parent.phase;
        remote.repositories[0].cleanup = { state: 'deleted' };
        remote.repositories[3].cleanup = { state: 'deleted' };
        remote.repositories[0].check = { state: 'queued' };
        remote.repositories[2].cleanup = { state: 'checking' }; emitRemote(); await operationStep();
        remote.repositories[0].check = { state: 'checking' };
        remote.repositories[2].cleanup = { state: 'sending' }; emitRemote(); await operationStep();
        remote.repositories[0].check = { state: 'ready' };
        remote.repositories[2].cleanup = { state: 'deleted' }; docs.cleanup = 'deleted';
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
  let beforeAsyncScenario;
  contextBridge.exposeInMainWorld('integrationSmoke', {
    inspect: () => clone({ calls, integrations, state, review, remote }),
    releaseCleanupChecks: () => { holdCleanupChecks = false; for (const resolve of cleanupWaiters.splice(0)) resolve(); },
    recoverCleanupAccess: () => { recoveredCleanupAccess = true; },
    setAutomaticScenario: (id, scenario) => { automaticScenarios.set(id, scenario); if (scenario === 'drafts') getReview(id).comments = [comment(7, 'Keep my unfinished feedback.')]; },
    finishAutomaticRemoval: () => { if (!releaseAutomaticRemoval) throw new Error('No automatic removal is waiting.'); releaseAutomaticRemoval(); releaseAutomaticRemoval = undefined; },
    advanceLoad: () => { if (!advanceLoad) throw new Error('No repository load is waiting.'); advanceLoad(); },
    advancePreview: () => { if (!advancePreview) throw new Error('No merge preview is waiting.'); advancePreview(); },
    emitOldLoad: () => { for (const listener of loadListeners) listener(clone({ ...lastLoadEvent, sequence: loadSequence - 1, complete: false, result: { review, snapshot: { ...snapshot(review.id), files: [], loading: true } } })); },
    failNextPublication: () => { failNextPublication = true; },
    setRepositoryUnavailable: unavailable => { remote.repositories[2].status = unavailable ? 'unavailable' : 'changes'; if (unavailable) remote.repositories[2].error = 'Docs repository permission is missing.'; else delete remote.repositories[2].error; emitRemote(); },
    setMergeConflicts: conflicts => { hasMergeConflicts = conflicts; },
    setSnapshotMode: mode => { snapshotMode = mode; },
    advanceOperation: () => { if (!advanceOperation) throw new Error('No operation step is waiting.'); advanceOperation(); },
    restorePausedOperation: () => { Object.assign(remote, beforeAsyncScenario); emitRemote(); },
    markLegacyCoreDeleted: () => { remote.operation.items[1].cleanup = 'deleted'; remote.repositories[1].cleanup = { state: 'deleted' }; emitRemote(); },
    markAsyncFinishedAwaitingResume: () => {
      beforeAsyncScenario = clone(remote);
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
  await writeFile(join(fixture, 'main.cjs'), `const {app,BrowserWindow}=require('electron'); const hidden=!app.isPackaged&&process.env.BRANCHLINE_SMOKE_HIDDEN==='1'; if(hidden&&process.platform==='darwin') app.setActivationPolicy('accessory'); app.setPath('userData',${JSON.stringify(join(fixture, 'data'))}); app.whenReady().then(()=>{ const window=new BrowserWindow({width:1500,height:980,webPreferences:{preload:${JSON.stringify(join(fixture, 'preload.cjs'))}},show:!hidden,focusable:!hidden,paintWhenInitiallyHidden:true}); window.loadFile(${JSON.stringify(resolve('dist/index.html'))}); }); app.on('window-all-closed',()=>app.quit());`);
  const env = smokeEnv(); delete env.ELECTRON_RUN_AS_NODE;
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
  const appearanceTab = settingsView.getByRole('tab', { name: 'Appearance', exact: true });
  const jiraTab = settingsView.getByRole('tab', { name: 'Jira', exact: true });
  const bitbucketTab = settingsView.getByRole('tab', { name: 'Bitbucket', exact: true });
  const updatesTab = settingsView.getByRole('tab', { name: 'Updates', exact: true });
  const diagnosticsTab = settingsView.getByRole('tab', { name: 'Diagnostics', exact: true });
  assert.equal(await appearanceTab.getAttribute('aria-selected'), 'true', 'Appearance is the initial settings section.');
  const appearancePanel = settingsView.getByRole('tabpanel', { name: 'Appearance', exact: true });
  assert.equal(await appearancePanel.getByRole('radio', { name: /System/ }).isChecked(), true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await appearancePanel.getByRole('radio', { name: /Light/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().state.settings.theme), 'light');
  await page.screenshot({ path: 'artifacts/settings-appearance-light.png', animations: 'disabled' });
  await appearancePanel.getByRole('radio', { name: /Dark/ }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().state.settings.theme), 'dark');
  await appearancePanel.getByRole('radio', { name: /System/ }).click();
  await page.waitForFunction(() => window.integrationSmoke.inspect().state.settings.theme === 'system');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await jiraTab.click();
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
  assert.equal(await appearanceTab.getAttribute('aria-selected'), 'true', 'Home returns to the first settings section.');
  await jiraTab.click();
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
  assert.equal(await page.getByRole('dialog').count(), 0, 'Repository and ticket details never open automatically.');
  assert.equal(await page.getByRole('list', { name: 'Branch review repositories', exact: true }).count(), 0, 'Repository details consume no review space while closed.');
  await page.screenshot({ path: 'artifacts/integration-review-compact.png', animations: 'disabled' });
  await page.getByRole('button', { name: /^Repositories:/ }).click();
  panel = await dialog(page, 'Repositories in this review');
  const repositoryRoster = page.getByRole('list', { name: 'Branch review repositories', exact: true });
  await repositoryRoster.getByRole('listitem', { name: 'docs branch review', exact: true }).getByText('Changes without a PR', { exact: true }).waitFor();
  await repositoryRoster.getByRole('listitem', { name: 'assets branch review', exact: true }).getByText('No changes', { exact: true }).waitFor();
  await repositoryRoster.getByRole('listitem', { name: 'absent branch review', exact: true }).getByText('Branch missing', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: /^Repositories:/ }).evaluate(button => button === document.activeElement), true, 'Closing repository details restores keyboard focus to its toolbar button.');
  await page.locator('[data-item-path="review.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'review.ts' }).waitFor();
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByText('Checking repositories…', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 5, 'Every repository has its own preflight spinner.');
  assert.equal(await panel.locator('.integration-loading').count(), 0, 'Merge checks do not add a separate generic spinner above the repositories.');
  await page.screenshot({ path: 'artifacts/integration-merge-parallel-checks.png', animations: 'disabled' });
  for (const checkState of ['ready', 'queued', 'checking']) {
    await page.evaluate(() => window.integrationSmoke.advancePreview());
    await page.waitForFunction(expected => window.integrationSmoke.inspect().remote.repositories.slice(0, 2).every(row => row.check.state === expected), checkState);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await panel.getByText('Checking…', { exact: true }).count(), 5, 'Intermediate safety-check receipts do not change the preview stage.');
    assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 5);
    assert.equal(await panel.getByText('Checked', { exact: true }).count(), 0);
    assert.equal(await panel.getByText('Queued…', { exact: true }).count(), 0);
    await panel.getByText('0 / 5', { exact: true }).waitFor();
  }
  await page.evaluate(() => window.integrationSmoke.advancePreview());
  await panel.getByRole('listitem', { name: 'core pull request 12', exact: true }).getByText('Ready', { exact: true }).waitFor();
  await panel.getByRole('listitem', { name: 'docs branch cleanup', exact: true }).getByText('Create PR, then merge', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).isEnabled(), true, 'A missing PR does not block merging reviewed changes.');
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.integrationSmoke.setRepositoryUnavailable(true));
  await page.getByRole('button', { name: /^Repositories:.*1 unavailable/ }).click();
  panel = await dialog(page, 'Repositories in this review');
  await repositoryRoster.getByRole('listitem', { name: 'docs branch review', exact: true }).getByText('Unavailable', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('alert').filter({ hasText: 'Docs repository permission is missing.' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).isDisabled(), true, 'Unavailable repositories cannot silently disappear from a merge.');
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.integrationSmoke.setRepositoryUnavailable(false));
  await page.evaluate(() => window.integrationSmoke.setMergeConflicts(true));
  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  const conflictRow = panel.getByRole('listitem', { name: 'core pull request 12', exact: true });
  await conflictRow.getByText('Merge conflicts', { exact: true }).waitFor();
  await conflictRow.getByRole('link', { name: '#12', exact: true }).click();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.links)).at(-1), 'https://bitbucket.org/acme/core/pull-requests/12', 'The conflict identifies its repository and opens the affected PR.');
  await panel.getByRole('alert').filter({ hasText: 'core #12: Merge conflicts' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).isDisabled(), true, 'Merge conflicts block the entire operation before any branches can be deleted.');
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.actions)).length, 0);
  await page.screenshot({ path: 'artifacts/integration-merge-conflicts.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() => window.integrationSmoke.setMergeConflicts(false));
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

  await page.getByRole('button', { name: 'View Jira ticket APP-123', exact: true }).click();
  panel = await dialog(page, 'Jira ticket');
  await page.getByText('Keep feedback on the exact lines.').waitFor();
  assert.equal(await page.locator('.jira-description img').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Unsafe link', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Engineering docs', exact: true }).click();
  await page.getByRole('textbox', { name: 'Review ticket key', exact: true }).fill('OPS-789');
  await page.getByRole('button', { name: 'Use ticket', exact: true }).click();
  await page.getByText('A manually linked ticket', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'View Jira ticket OPS-789', exact: true }).count(), 1, 'The linked ticket remains a compact toolbar action.');
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
  assert.equal(await page.getByRole('dialog', { name: 'Pull requests merged', exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Approve and merge', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true }).getByText('Skipped · no changes', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Approve, merge and delete branches', exact: true }).click();
  let coreRow = panel.getByRole('listitem', { name: 'core pull request 12', exact: true });
  let parentRow = panel.getByRole('listitem', { name: 'platform pull request 11', exact: true });
  const assetsRow = panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true });
  const assertParallelMergeStages = async () => {
    await panel.getByText('Merging repositories', { exact: true }).waitFor();
    await panel.getByText('0 / 5', { exact: true }).waitFor();
    await coreRow.getByText('Merging…', { exact: true }).waitFor();
    await panel.getByRole('listitem', { name: 'docs pull request 13', exact: true }).getByText('Merging…', { exact: true }).waitFor();
    await assetsRow.getByText('Waiting for merges', { exact: true }).waitFor();
    assert.equal(await coreRow.locator('.spin').count(), 1, 'Other repositories retain their merge spinner during a repository check.');
    assert.equal(await assetsRow.locator('.spin').count(), 0, 'Empty branches wait for all required merges before cleanup.');
    assert.equal(await panel.getByText('Checking repositories…', { exact: true }).count(), 0, 'A scoped check does not replace the operation heading.');
    assert.equal(await panel.getByText('Checked', { exact: true }).count(), 0);
    assert.equal(await panel.getByText('Waiting', { exact: true }).count(), 0);
  };
  await parentRow.getByText('Checking…', { exact: true }).waitFor();
  await assertParallelMergeStages();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await parentRow.getByText('Approving…', { exact: true }).waitFor();
  await assertParallelMergeStages();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await assertParallelMergeStages();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await page.waitForFunction(() => window.integrationSmoke.inspect().remote.repositories[0].check.state === 'queued');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await assertParallelMergeStages();
  await page.screenshot({ path: 'artifacts/integration-merge-running.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await coreRow.getByText('Merged · waiting for other merges', { exact: true }).waitFor();
  await assetsRow.getByText('Waiting for merges', { exact: true }).waitFor();
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await panel.getByText('Merging repositories', { exact: true }).waitFor();
  await panel.getByText('0 / 5', { exact: true }).waitFor();
  assert.equal(await coreRow.getByText('Deleted', { exact: true }).count(), 0, 'Deletion is not claimed before cleanup is confirmed.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await coreRow.getByText('Merged · waiting for other merges', { exact: true }).waitFor();
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await panel.getByText('0 / 5', { exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await page.waitForFunction(() => window.integrationSmoke.inspect().remote.repositories[0].check.state === 'checking');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await coreRow.getByText('Merged · waiting for other merges', { exact: true }).waitFor();
  await assetsRow.getByText('Waiting for merges', { exact: true }).waitFor();
  await panel.getByRole('listitem', { name: 'docs pull request 13', exact: true }).getByText('Merged · waiting for other merges', { exact: true }).waitFor();
  await panel.getByText('Merging repositories', { exact: true }).waitFor();
  await panel.getByText('0 / 5', { exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await panel.getByText('Operation paused', { exact: true }).waitFor();
  const failedMergeState = await page.evaluate(() => window.integrationSmoke.inspect().remote);
  assert.ok(failedMergeState.repositories.every(row => !row.cleanup), 'A failed merge leaves every repository source branch available.');
  assert.equal(await panel.getByText('Deleted', { exact: true }).count(), 0, 'Partial success does not report any new branch deletion.');
  await page.screenshot({ path: 'artifacts/integration-merge-paused.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Return to review', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'remote-review', 'A partial merge keeps the original review open for recovery.');
  assert.equal(await page.getByRole('dialog', { name: 'Pull requests merged', exact: true }).count(), 0);
  await page.evaluate(() => window.integrationSmoke.markAsyncFinishedAwaitingResume());
  await page.getByRole('button', { name: 'Resume operation', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByText('Bitbucket accepted the merge. Resume to confirm its result.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().remote.pullRequests.every(pr => pr.state === 'MERGED')), true);
  assert.equal(await panel.getByRole('button', { name: 'Resume operation', exact: true }).isEnabled(), true, 'A paused asynchronous merge can reconcile after every PR has finished remotely.');
  await panel.getByRole('button', { name: 'Return to review', exact: true }).click();
  const refreshesBeforeReviewed = await refreshCount('remote-review');
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), false, 'A remotely merged file is no longer pending review.');
  await page.getByText('This PR was merged. These are its historical changes; no further review is needed for this repository.', { exact: true }).waitFor();
  assert.equal(await refreshCount('remote-review'), refreshesBeforeReviewed, 'Displaying historical changes does not refresh the snapshot.');
  await page.evaluate(() => window.integrationSmoke.restorePausedOperation());
  await page.evaluate(() => window.integrationSmoke.markLegacyCoreDeleted());
  await page.getByRole('button', { name: 'Resume operation', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('button', { name: 'Resume operation', exact: true }).click();
  coreRow = panel.getByRole('listitem', { name: 'core pull request 12', exact: true });
  parentRow = panel.getByRole('listitem', { name: 'platform pull request 11', exact: true });
  await coreRow.getByText('Done', { exact: true }).waitFor();
  await coreRow.getByText('Skipped · already merged', { exact: true }).waitFor();
  await coreRow.getByText('Deleted', { exact: true }).waitFor();
  await parentRow.getByText('Merging…', { exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/integration-merge-resuming.png', animations: 'disabled' });
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await panel.getByText('Deleting branches', { exact: true }).waitFor();
  await parentRow.getByText('Deleting branch…', { exact: true }).waitFor();
  await assetsRow.getByText('Deleting branch…', { exact: true }).waitFor();
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 3, 'After all PRs merge, remaining repositories clean up their branches in parallel.');
  assert.equal(await page.evaluate(() => window.integrationSmoke.inspect().remote.operation.items.every(item => item.merge === 'merged')), true);
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  const docsCleanupRow = panel.getByRole('listitem', { name: 'docs pull request 13', exact: true });
  await docsCleanupRow.getByText('Deleting branch…', { exact: true }).waitFor();
  await parentRow.getByText('Done', { exact: true }).waitFor();
  await assetsRow.getByText('Done', { exact: true }).waitFor();
  await panel.getByText('4 / 5', { exact: true }).waitFor();
  assert.equal(await docsCleanupRow.locator('.spin').count(), 1, 'Cleanup checks stay within the deleting stage after the merge barrier.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await docsCleanupRow.getByText('Deleting branch…', { exact: true }).waitFor();
  await coreRow.getByText('Done', { exact: true }).waitFor();
  await coreRow.getByText('Deleted', { exact: true }).waitFor();
  await parentRow.getByText('Done', { exact: true }).waitFor();
  await parentRow.getByText('Deleted', { exact: true }).waitFor();
  await panel.getByText('Deleting branches', { exact: true }).waitFor();
  await panel.getByText('4 / 5', { exact: true }).waitFor();
  assert.equal(await docsCleanupRow.locator('.spin').count(), 1, 'Independent PR branch deletion displays a spinner.');
  assert.equal(await panel.locator('.merge-repository-icon .spin').count(), 1, 'The final repository continues cleanup after other repositories finish.');
  await panel.getByRole('listitem', { name: 'assets branch cleanup', exact: true }).getByText('Deleted', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Pull requests merged', exact: true }).count(), 0, 'The review stays open until every branch cleanup completes.');
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().state.reviews)).some(review => review.id === 'remote-review'), true, 'A merged PR with cleanup in progress remains resumable.');
  await page.evaluate(() => window.integrationSmoke.advanceOperation());
  await panel.getByText('The completion response was lost. Retry finishing this review.', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Finish review', exact: true }).isEnabled(), true, 'A failed local completion remains retryable after the remote merge finishes.');
  const callsBeforeFinish = await page.evaluate(() => window.integrationSmoke.inspect().calls);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Finish review', exact: true }).click();
  panel = await dialog(page, 'Approve and merge');
  await panel.getByRole('button', { name: 'Finish review', exact: true }).click();
  const receipt = page.getByRole('dialog', { name: 'Pull requests merged', exact: true });
  await receipt.getByRole('heading', { name: 'Pull requests merged', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'current:project-1');
  assert.equal(await page.getByRole('dialog').count(), 1, 'The operation dialog becomes a completion modal.');
  assert.equal(await page.locator('.remote-review-controls').count(), 0, 'The completed review leaves no stale Bitbucket controls behind the modal.');
  assert.equal(await receipt.getByText('Deleted', { exact: true }).count(), 4, 'The completion modal retains every confirmed branch deletion.');
  const savedAfterMerge = await page.evaluate(() => window.integrationSmoke.inspect().state.reviews.find(review => review.id === 'remote-review'));
  assert.equal(savedAfterMerge, undefined, 'The completed saved review is removed from Branchline.');
  assert.deepEqual(await page.evaluate(() => window.integrationSmoke.inspect().calls.completed), ['remote-review', 'remote-review']);
  const callsAfterFinish = await page.evaluate(() => window.integrationSmoke.inspect().calls);
  assert.equal(callsAfterFinish.mergePreviews, callsBeforeFinish.mergePreviews, 'Finishing local removal does not repeat provider preflight.');
  assert.deepEqual(callsAfterFinish.actions, callsBeforeFinish.actions, 'Finishing local removal never repeats provider merge actions.');
  await receipt.getByRole('button', { name: 'Open in Jira', exact: true }).click();
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.links)).at(-1), 'https://jira.example.atlassian.net/browse/OPS-789', 'Jira opens from the captured ticket URL after the saved review is removed.');
  await page.screenshot({ path: 'artifacts/integration-merge-complete.png', animations: 'disabled' });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 680));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The completion modal fits the minimum desktop width.');
  const doneBounds = await receipt.locator('.modal-footer').getByRole('button', { name: 'Done', exact: true }).boundingBox();
  assert.ok(doneBounds && doneBounds.y >= 0 && doneBounds.y + doneBounds.height <= 680, 'Completion actions remain visible while results scroll.');
  await page.screenshot({ path: 'artifacts/integration-merge-complete-minimum.png', animations: 'disabled' });
  await receipt.getByRole('button', { name: 'Done', exact: true }).click();
  await receipt.waitFor({ state: 'hidden' });
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'APP-123 · 2 pull requests', exact: true }).count(), 0, 'Completed reviews are absent from the active review selector.');
  await page.keyboard.press('Escape');
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
  assert.deepEqual(data.calls.links, ['https://id.atlassian.com/manage-profile/security/api-tokens', 'https://id.atlassian.com/manage-profile/security/api-tokens', 'https://bitbucket.org/acme/core/pull-requests/12', 'https://docs.example.org/reviews', 'https://bitbucket.org/acme/platform/pull-requests/11', 'https://bitbucket.org/acme/platform/pull-requests/11', 'https://bitbucket.org/acme/core/pull-requests/12', 'https://jira.example.atlassian.net/browse/OPS-789']);
  assert.equal(data.integrations.projects['project-1'].repositories[1].workspace, 'corrected-workspace');
  assert.equal(data.integrations.projects['project-1'].updateSubmodulePointers, true);
  assert.equal(data.integrations.connections.find(item => item.kind === 'jira').id, 'jira');
  assert.equal(data.integrations.connections.find(item => item.kind === 'jira').connected, true);
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Old merged review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'closed-merged');
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clean up closed Bitbucket reviews', exact: true }).click();
  const cleanupDialog = await dialog(page, 'Clean up closed Bitbucket reviews');
  await page.waitForFunction(() => window.integrationSmoke.inspect().calls.activeCleanupChecks === 4);
  assert.equal(await cleanupDialog.getByRole('button', { name: /Remove .*closed reviews/ }).count(), 0, 'Removal is unavailable before any closed review is verified.');
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.cleanupRemovals)).length, 0, 'Opening cleanup only checks reviews.');
  await page.evaluate(() => window.integrationSmoke.releaseCleanupChecks());
  await cleanupDialog.getByRole('button', { name: 'Remove 3 closed reviews', exact: true }).waitFor();
  await page.waitForFunction(() => window.integrationSmoke.inspect().calls.cleanupChecks.length === 6 && window.integrationSmoke.inspect().calls.activeCleanupChecks === 0);
  assert.equal(await cleanupDialog.getByRole('button', { name: 'Remove 3 closed reviews', exact: true }).isEnabled(), true);
  await cleanupDialog.getByText('Bitbucket could not verify this review. Reconnect and check again.', { exact: true }).waitFor();
  await cleanupDialog.getByText('Finish branch cleanup before removing this review.', { exact: true }).waitFor();
  assert.match(await cleanupDialog.innerText(), /1 unpublished/i);
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.maxCleanupChecks)), 4, 'Status reads have a bounded four-review concurrency.');
  await page.screenshot({ path: 'artifacts/integration-closed-review-cleanup.png', animations: 'disabled' });
  await cleanupDialog.getByRole('button', { name: 'Remove 3 closed reviews', exact: true }).click();
  await cleanupDialog.getByText('Removed 2 reviews. 1 review was kept after rechecking. See the reasons below.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'current:project-1');
  const cleaned = await page.evaluate(() => window.integrationSmoke.inspect());
  assert.deepEqual(cleaned.calls.cleanupRemovals, [['closed-merged', 'closed-declined', 'closed-reopened']]);
  assert.equal(cleaned.state.reviews.some(item => ['closed-merged', 'closed-declined'].includes(item.id)), false);
  assert.ok(['current:project-1', 'closed-open', 'closed-reopened', 'closed-unavailable', 'closed-blocked'].every(id => cleaned.state.reviews.some(item => item.id === id)), 'Open, reopened, unavailable and unfinished reviews stay saved.');
  assert.deepEqual(cleaned.calls.actions, data.calls.actions, 'List cleanup never merges or deletes remote branches.');
  await cleanupDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'Old merged review', exact: true }).count(), 0);
  assert.equal(await page.getByRole('option', { name: 'Old declined review', exact: true }).count(), 0);
  assert.equal(await page.getByRole('option', { name: 'Reopened during cleanup', exact: true }).count(), 1);
  await page.getByRole('option', { name: 'Unavailable review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'closed-unavailable');
  await page.evaluate(() => window.integrationSmoke.recoverCleanupAccess());
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clean up closed Bitbucket reviews', exact: true }).click();
  const retryDialog = await dialog(page, 'Clean up closed Bitbucket reviews');
  await retryDialog.getByRole('button', { name: 'Remove 1 closed review', exact: true }).click();
  await retryDialog.getByText('Cleanup pending', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'current:project-1');
  await retryDialog.getByRole('button', { name: 'Rescan', exact: true }).click();
  await retryDialog.getByText('Review check complete', { exact: true }).waitFor();
  await retryDialog.getByText('Cleanup pending', { exact: true }).waitFor();
  await retryDialog.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await retryDialog.getByRole('listitem', { name: 'Unavailable review', exact: true }).getByText('Removed', { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.integrationSmoke.inspect().calls.cleanupRemovals)).slice(1), [['closed-unavailable'], ['closed-unavailable']], 'Metadata-only failure retains a retry action even after rescan and review removal.');
  await retryDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'Unavailable review', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.integrationSmoke.setAutomaticScenario('closed-open', 'partial'));
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Still active review', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'closed-open');
  await page.locator('[data-item-path="review.ts"]').click();
  await page.getByText('This PR was merged. These are its historical changes; no further review is needed for this repository.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), false, 'Merged files are identified as historical rather than new work.');
  assert.match(await page.locator('[data-item-path="review.ts"]').innerText(), /Merged/);
  await page.locator('.compact-progress').getByText('0 / 1 reviewed', { exact: true }).waitFor();
  await page.locator('[data-item-path="review.ts"]').click({ button: 'right' });
  const historicalMenu = page.getByRole('menu', { name: 'File review actions', exact: true });
  await historicalMenu.waitFor();
  assert.equal(await historicalMenu.getByRole('menuitem', { name: 'Mark reviewed', exact: true }).isEnabled(), false, 'Historical selections cannot be bulk marked reviewed.');
  assert.equal(await historicalMenu.getByRole('menuitem', { name: 'Mark unreviewed', exact: true }).isEnabled(), false);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next unreviewed file', exact: true }).click();
  await page.locator('.diff-file-name').filter({ hasText: 'guide.ts' }).waitFor();
  await page.getByRole('button', { name: 'Next unreviewed file', exact: true }).click();
  assert.equal(await page.locator('.diff-file-name').filter({ hasText: 'review.ts' }).count(), 0, 'Next wraps only through actionable files.');
  await page.getByRole('combobox', { name: 'Filter changed files', exact: true }).click();
  await page.getByRole('option', { name: 'Unreviewed', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-item-path="review.ts"]'));
  assert.equal(await page.locator('[data-item-path="modules/docs/guide.ts"]').count(), 1);
  await page.getByRole('combobox', { name: 'Filter changed files', exact: true }).click();
  await page.getByRole('option', { name: 'All files', exact: true }).click();
  await page.locator('[data-item-path="review.ts"]').click();
  await page.getByText('This PR was merged. These are its historical changes; no further review is needed for this repository.', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Repositories:/ }).click();
  const historyDialog = await dialog(page, 'Repositories in this review');
  await historyDialog.getByRole('listitem', { name: 'platform branch review', exact: true }).getByText('Merged', { exact: true }).waitFor();
  await historyDialog.getByRole('listitem', { name: 'docs branch review', exact: true }).getByText('Changes without a PR', { exact: true }).waitFor();
  await historyDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.screenshot({ path: 'artifacts/integration-historical-diff.png', animations: 'disabled' });
  await page.locator('[data-item-path="modules/docs/guide.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'guide.ts' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mark reviewed', exact: true }).isEnabled(), true, 'Branch-only work remains actionable in a partially completed group.');
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.automaticRemovals)).length, 0);
  await page.evaluate(() => window.integrationSmoke.setAutomaticScenario('closed-open', 'closed'));
  const readsBeforeRetiring = (await page.evaluate(() => window.integrationSmoke.inspect().calls.remoteReads)).filter(id => id === 'closed-open').length;
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByRole('heading', { name: 'Closing completed review…', exact: true }).waitFor();
  assert.equal(await page.locator('.app-shell').getAttribute('inert'), '', 'Editing is blocked while autosave and closure checks finish.');
  await page.evaluate(() => window.integrationSmoke.finishAutomaticRemoval());
  await page.getByText('Still active review is complete and was removed from Branchline.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Select review"]')?.getAttribute('data-value') === 'current:project-1');
  assert.equal((await page.evaluate(() => window.integrationSmoke.inspect().calls.remoteReads)).filter(id => id === 'closed-open').length, readsBeforeRetiring, 'Retirement does not read an already deleted remote review.');
  await page.getByRole('button', { name: 'Dismiss completed review notice', exact: true }).click();
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: 'Still active review', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.integrationSmoke.setAutomaticScenario('closed-blocked', 'drafts'));
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Unfinished cleanup review', exact: true }).click();
  await page.getByRole('heading', { name: 'Closing completed review…', exact: true }).waitFor();
  await page.evaluate(() => window.integrationSmoke.finishAutomaticRemoval());
  await page.getByText('This completed review has unpublished feedback and was kept.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'closed-blocked');
  assert.ok((await page.evaluate(() => window.integrationSmoke.inspect().state.reviews)).find(item => item.id === 'closed-blocked').comments.some(item => item.body === 'Keep my unfinished feedback.'));
  await page.evaluate(() => window.integrationSmoke.setAutomaticScenario('closed-reopened', 'failed'));
  await page.getByRole('combobox', { name: 'Select review', exact: true }).click();
  await page.getByRole('option', { name: 'Reopened during cleanup', exact: true }).click();
  await page.getByText('Core could not be checked. This review was kept.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Select review', exact: true }).getAttribute('data-value'), 'closed-reopened');
  assert.deepEqual(await page.evaluate(() => window.integrationSmoke.inspect().calls.automaticRemovals), [['closed-open'], ['closed-blocked']], 'Unverified groups are never sent for automatic retirement.');
  await page.evaluate(() => {
    const scope = `closed-reopened:${JSON.stringify(['main', 'feature/APP-123-review', false])}`;
    localStorage.setItem(`branchline.commentDraft:${encodeURIComponent(scope)}:${encodeURIComponent('missing:unavailable.ts')}:recovered-comment`, JSON.stringify({ id: 'recovered-comment', scope, fileId: 'missing:unavailable.ts', body: 'Do not lose this recovered draft.', anchor: { side: 'additions', lineStart: 4, lineEnd: 4, context: '' }, persisted: false, savedBody: '', resolved: false }));
    window.integrationSmoke.setAutomaticScenario('closed-reopened', 'closed');
  });
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await page.getByText('This completed review has recovered comment drafts. Open the affected files to save or discard them, or use closed-review cleanup to remove the review explicitly.', { exact: true }).waitFor();
  const recovered = await page.evaluate(() => window.integrationSmoke.inspect());
  assert.equal(recovered.state.reviews.find(item => item.id === 'closed-reopened').comments.length, 0, 'This draft has not reached the backend.');
  assert.deepEqual(recovered.calls.automaticRemovals, [['closed-open'], ['closed-blocked']], 'Recovered drafts for non-selected, unavailable files prevent automatic deletion before calling the backend.');
  await page.screenshot({ path: 'artifacts/integration-automatic-retirement.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Integration desktop smoke passed: full-page settings, keyboard sidebar tabs, preserved setup drafts, token generator links, copied scope guidance, separate credentials, invalid/replaced tokens, mappings, whole-branch entry with fixed membership, missing PR draft/publication creation links, empty and missing branch visibility and live deletion, filters/grouping/forks, cached remote snapshots with explicit opening/publication refresh, local checkout polling, progressive parallel repository loading with early review and preserved feedback/selection, stable per-repository preview/merge/cleanup stages across repeated safety checks with unchanged completion counts and deletion receipts, conflict-blocked merging with direct PR links, no branch cleanup after partial merge failure, parallel cleanup after every required merge, marking reviewed without refresh, Jira ADF/manual key, stale re-anchoring, delivery recovery, conflicts, publish with grouped PR links after failure and success, approve-only preservation, live repository merge/cleanup, paused merge/resume with skipped children, automatic removal of completed reviews, compact repository and Jira dialogs, modal completion with captured Jira link and lost-response retry without more provider calls, and minimum-width layout. Atlassian calls were stubbed.');
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await page.screenshot({ path: 'artifacts/integration-smoke-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 16000));
  }
  console.error('Renderer errors:', errors);
  throw error;
} finally { await desktop?.close().catch(() => {}); await rm(fixture, { recursive: true, force: true }); }
