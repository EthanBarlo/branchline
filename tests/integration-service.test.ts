import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { IntegrationService } from '../electron/integration-service';
import { IntegrationStore } from '../electron/integration-store';
import { ReviewStore } from '../electron/store';
import { ReviewService } from '../electron/review-service';
import { ProviderError, type ConnectionCredentials, type ConnectionManager } from '../electron/connection-manager';
import type { BitbucketClient } from '../electron/bitbucket-client';
import type { PointerService } from '../electron/pointer-service';
import { pullRequestKey, type ConnectionInput, type InlinePayload, type ProjectIntegration, type PullRequest, type RemoteComment, type RepositoryMapping, type RemoteReviewLoadProgress } from '../shared/integrations';
import { currentReviewId, reviewContextKey, type Review, type ReviewFile, type ReviewSnapshot } from '../shared/types';

const hash = (value: string) => value.repeat(40);
const root: RepositoryMapping = { relativePath: '.', workspace: 'team', repoSlug: 'root' };
const child: RepositoryMapping = { relativePath: 'packages/child', workspace: 'team', repoSlug: 'child', parentRelativePath: '.', submodulePath: 'packages/child' };
const pr = (mapping = root, id = 7): PullRequest => ({ id, repository: mapping, title: `PR ${id}`, url: `https://bitbucket.org/team/${mapping.repoSlug}/pull-requests/${id}`,
  sourceBranch: 'APP-123-feature', targetBranch: 'main', sourceHash: hash('a'), targetHash: hash('b'),
  author: { id: 'author', name: 'Author' }, reviewers: [{ id: 'bb-account', name: 'Reviewer' }], participants: [], state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'] });
const file: ReviewFile = { id: 'src/new.ts', repoRelativePath: '.', path: 'src/new.ts', oldPath: 'src/old.ts', remotePath: 'src/new.ts', status: 'R', additions: 2, deletions: 1,
  oldContent: 'old\nline\n', newContent: 'new\nline\nlast\n', binary: false, fingerprint: 'contents-v1', baseCommit: hash('c'), headCommit: hash('a'), source: 'committed' };

async function fixture(t: TestContext, progressive = false) {
  const directory = await mkdtemp(join(tmpdir(), 'branchline-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reviewsPath = join(directory, 'reviews.json'), statePath = join(directory, 'integrations.json');
  const reviews = new ReviewStore(reviewsPath); await reviews.load();
  const project = await reviews.createProject({ repoPath: '/local/unchanged/project', name: 'Project' });
  const state = new IntegrationStore(statePath); await state.load();
  const accounts = new Map<string, ConnectionCredentials>([
    ['bb', { info: { id: 'bb', kind: 'bitbucket', label: 'BB', email: 'bb@example.com', accountId: 'bb-account', displayName: 'BB User', storage: 'session', connected: true }, email: 'bb@example.com', token: 'bb-private-token' }],
    ['jira', { info: { id: 'jira', kind: 'jira', label: 'Jira', email: 'jira@other.example', accountId: 'jira-account', displayName: 'Jira User', storage: 'session', connected: true, cloudId: 'separate-cloud', siteUrl: 'https://separate.atlassian.net' }, email: 'jira@other.example', token: 'jira-private-token' }],
  ]);
  const calls = { clientTokens: [] as string[], clients: [] as string[], prs: [] as { repository: RepositoryMapping; id: number }[], jira: [] as [string, string][], localSnapshots: 0, localInspections: 0, remoteSnapshots: 0, credentialReads: 0, commentReads: 0, discoveries: [] as string[], saves: 0 };
  const hooks: { beforeRepository?: (repository: RepositoryMapping) => Promise<void>; beforeComments?: () => Promise<void>; beforeSnapshot?: () => Promise<void>; beforeSave?: () => Promise<void>; snapshotError?: Error; snapshot?: (value: ReviewSnapshot) => ReviewSnapshot; localSnapshot?: (review: Review) => Promise<ReviewSnapshot>; pr?: (value: PullRequest) => PullRequest; listError?: Error; publishError?: Error } = {};
  const live = new Map([pr(), pr(child, 8)].map(value => [pullRequestKey(value), value]));
  const comments: RemoteComment[] = [], sent: InlinePayload[] = [];
  const credentials = (id: string) => { calls.credentialReads++; const value = accounts.get(id); if (!value?.token) throw new Error('Reconnect this account.'); return structuredClone(value); };
  const connections = {
    list: () => [...accounts.values()].map(value => structuredClone(value.info)), credentials,
    async save(input: ConnectionInput) { calls.saves++; await hooks.beforeSave?.(); const value = structuredClone(accounts.get(input.id ?? 'bb')!); value.token = input.token; value.info.connected = true; accounts.set(value.info.id, value); return structuredClone(value.info); },
    async test(id: string) { return credentials(id).info; },
    async disconnect(id: string) { const value = accounts.get(id); if (value) { value.token = ''; value.info.connected = false; } },
    async getIssue(id: string, key: string) { credentials(id); calls.jira.push([id, key]); return { key, title: `Issue ${key}`, description: { type: 'doc', version: 1, content: [] }, url: `https://separate.atlassian.net/browse/${key}` }; },
  } as unknown as ConnectionManager;
  const client = {
    async getRepository() { return { defaultBranch: 'main' }; },
    async getBranch(mapping: RepositoryMapping, name: string) { const value = [...live.values()].find(pr => pr.repository.relativePath === mapping.relativePath); return value ? { name, hash: name === value.sourceBranch ? value.sourceHash : value.targetHash } : null; },
    async mergeBase() { return hash('c'); },
    async getMergeConflicts() { return []; },
    async findPullRequests(mapping: RepositoryMapping, source: string, states = ['OPEN']) { if (hooks.listError) throw hooks.listError; return [...live.values()].filter(value => value.repository.relativePath === mapping.relativePath && value.sourceBranch === source && states.includes(value.state)).map(value => structuredClone(value)); },
    async listPullRequests(mapping: RepositoryMapping) { if (hooks.listError) throw hooks.listError; return [...live.values()].filter(value => value.repository.relativePath === mapping.relativePath).map(value => structuredClone(value)); },
    async getPullRequest(repository: RepositoryMapping, id: number) { calls.prs.push({ repository: structuredClone(repository), id }); const value = live.get(`${repository.relativePath}#${id}`); if (!value) throw new Error('PR not found'); return structuredClone(hooks.pr?.(value) ?? value); },
    async listComments() { calls.commentReads++; const result = structuredClone(comments); await hooks.beforeComments?.(); if (hooks.publishError) throw hooks.publishError; return result; },
    async createComment(_pr: PullRequest, payload: InlinePayload) { if (hooks.publishError) throw hooks.publishError; sent.push(structuredClone(payload)); const comment = { id: comments.length + 1, authorId: 'bb-account', body: payload.content.raw, resolved: false, deleted: false, path: payload.inline.path, from: payload.inline.from, to: payload.inline.to, startFrom: payload.inline.start_from, startTo: payload.inline.start_to }; comments.push(comment); return structuredClone(comment); },
    async updateComment(_pr: PullRequest, id: number, body: string) { comments.find(c => c.id === id)!.body = body; return structuredClone(comments.find(c => c.id === id)!); },
    async resolveComment(_pr: PullRequest, id: number, resolved: boolean) { comments.find(c => c.id === id)!.resolved = resolved; },
    async deleteComment(_pr: PullRequest, id: number) { comments.find(c => c.id === id)!.deleted = true; },
  } as unknown as BitbucketClient;
  const remoteSnapshot = (id: string): ReviewSnapshot => ({ reviewId: id, files: [structuredClone(file)], repos: [root, child].map(repo => ({ relativePath: repo.relativePath, workingTreeIncluded: false, currentBranch: null })), warnings: [], fingerprint: 'snapshot-v1', refreshedAt: new Date().toISOString() });
  let currentBranch: string | null = 'APP-999-current';
  const inspect = async () => { calls.localInspections++; return { rootPath: project.repoPath, name: project.name, branches: ['main', currentBranch ?? ''], currentBranch }; };
  let service: IntegrationService;
  const reviewService = new ReviewService(reviews, inspect, async config => {
    if (config.remote) return service.buildSnapshot(config as Review);
    calls.localSnapshots++;
    if (hooks.localSnapshot) return hooks.localSnapshot(config as Review);
    throw new Error('Local Git must not run for a remote review.');
  });
  service = new IntegrationService(reviews, reviewService, state, connections, {} as PointerService, {
    createClient: value => { calls.clients.push(value.info.id); calls.clientTokens.push(value.token); return client; }, inspect,
    discover: async repoPath => { calls.discoveries.push(repoPath); return [structuredClone(root), structuredClone(child)]; },
    ...(progressive ? {
      repositorySnapshot: async (_client: BitbucketClient, id: string, row: import('../shared/integrations').BranchReviewRepository, pr?: PullRequest) => {
        calls.remoteSnapshots++; await hooks.beforeRepository?.(row.repository);
        const mapping = row.repository;
        const snapshot: ReviewSnapshot = { ...remoteSnapshot(id), files: [{ ...file, id: mapping.relativePath === '.' ? file.id : `${mapping.relativePath}/${file.id}`, repoRelativePath: mapping.relativePath }],
          repos: [{ relativePath: mapping.relativePath, workingTreeIncluded: false, currentBranch: row.sourceBranch }] };
        return { snapshot: hooks.snapshot?.(snapshot) ?? snapshot, pullRequests: pr ? [pr] : [], repositories: [row] };
      },
    } : { snapshot: async (_client: BitbucketClient, id: string, prs: PullRequest[]) => { calls.remoteSnapshots++; await hooks.beforeSnapshot?.(); if (hooks.snapshotError) throw hooks.snapshotError; const snapshot = remoteSnapshot(id); return { snapshot: hooks.snapshot?.(snapshot) ?? snapshot, pullRequests: structuredClone(prs) }; } }),
  });
  const settings: ProjectIntegration = { jiraConnectionId: 'jira', bitbucketConnectionId: 'bb', repositories: [root, child], updateSubmodulePointers: false };
  await service.configureProjectIntegration(project.id, settings);
  const open = () => service.openPullRequestReview(project.id, [{ repositoryPath: '.', prId: 7 }]);
  const add = async (id: string) => {
    await service.refreshReview(id);
    const review = await service.addComment(id, { fileId: file.id, repoRelativePath: file.repoRelativePath, path: file.path, side: 'additions', lineStart: 1, lineEnd: 2, body: 'Initial comment', context: 'new\nline', fingerprint: file.fingerprint });
    return review.comments.at(-1)!;
  };
  return { directory, reviewsPath, statePath, project, reviews, state, service, reviewService, settings, hooks, live, calls, accounts, comments, sent, client, open, add, currentBranch: (value: string | null) => { currentBranch = value; } };
}

test('PR selection trusts fetched identities and mapped repositories, and reuses a group regardless of selection order', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.discoverRepositories(f.project.id), [root, child]);
  assert.deepEqual(f.calls.discoveries, [f.project.repoPath]);
  const refs = [{ repositoryPath: '.', prId: 7 }, { repositoryPath: 'packages/child', prId: 8 }];
  const review = await f.service.openPullRequestReview(f.project.id, refs);
  const duplicate = await f.service.openPullRequestReview(f.project.id, [...refs].reverse());
  assert.equal(duplicate.id, review.id);
  assert.equal(f.reviews.getState().reviews.filter(value => value.remote).length, 1);
  assert.deepEqual(f.calls.prs.slice(0, 2), [{ repository: root, id: 7 }, { repository: child, id: 8 }]);
  assert.equal(review.remote, true); assert.equal(review.includeWorkingTree, false);
  for (const bad of [null, [null], [], [{ repositoryPath: '.', prId: 0 }], [{ repositoryPath: '../outside', prId: 7 }], [refs[0], refs[0]]]) {
    await assert.rejects(() => f.service.openPullRequestReview(f.project.id, bad as any), /Select one|mapped project/);
  }
  f.hooks.pr = value => ({ ...value, id: 99 });
  await assert.rejects(() => f.open(), /does not match/);
  f.hooks.pr = value => ({ ...value, repository: { ...value.repository, workspace: 'other' } });
  await assert.rejects(() => f.open(), /does not match/);
  f.hooks.pr = value => ({ ...value, state: 'MERGED' });
  await assert.rejects(() => f.open(), /no longer open/);
  f.hooks.pr = value => ({ ...value, sourceBranch: value.id === 8 ? 'different' : value.sourceBranch });
  await assert.rejects(() => f.service.openPullRequestReview(f.project.id, refs), /matching source/);
});

test('API refresh persists the remote marker and fails closed when integration metadata is lost', async t => {
  const f = await fixture(t); const review = await f.open();
  const result = await f.service.refreshReview(review.id);
  assert.equal(result.snapshot.files[0].newContent, file.newContent);
  assert.equal(f.calls.remoteSnapshots, 1); assert.equal(f.calls.localSnapshots, 0); assert.equal(f.calls.localInspections, 0);
  const restored = new ReviewStore(f.reviewsPath); await restored.load();
  assert.equal(restored.getReview(review.id).remote, true);
  await f.state.removeReview(review.id);
  await assert.rejects(() => f.service.refreshReview(review.id), /lost its integration metadata/);
  assert.equal(f.calls.localSnapshots, 0); assert.equal(f.calls.localInspections, 0);
  assert.equal(f.reviews.getReview(review.id).remote, true);
});

test('local scans stay tracked without blocking file markers or pending comment saves through integrations', async t => {
  const f = await fixture(t);
  const snapshot = (review: Review): ReviewSnapshot => ({ reviewId: review.id, files: [{ ...file, source: 'working-tree' }], repos: [], warnings: [], fingerprint: 'local-v1', refreshedAt: new Date().toISOString() });
  f.hooks.localSnapshot = async review => snapshot(review);
  const loaded = await f.service.setCurrentTarget(f.project.id, 'main');
  const key = reviewContextKey(loaded.review);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release());
  f.hooks.localSnapshot = async review => { entered(); await blocked; return snapshot(review); };
  const refreshing = f.service.refreshReview(loaded.review.id);
  await started;
  assert.equal(f.service.busy, true);
  let drained = false;
  const draining = f.service.idle().then(() => { drained = true; });
  await assert.rejects(() => f.service.disconnectConnection('bb'), /Wait for/);
  await assert.rejects(() => f.service.configureProjectIntegration(f.project.id, f.settings), /current review operation/);

  const saving = (async () => {
    await f.service.addComment(loaded.review.id, { fileId: file.id, repoRelativePath: file.repoRelativePath, path: file.path, side: 'additions', lineStart: 1, lineEnd: 1, body: 'Saved during background scan', context: 'new', fingerprint: file.fingerprint }, key);
    return f.service.setApprovals(loaded.review.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true, key);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const saved = await Promise.race([saving, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The background scan blocked local feedback.')), 1500); })]);
    assert.equal(saved.comments[0].body, 'Saved during background scan');
    assert.equal(saved.approvals[file.id], file.fingerprint);
    assert.equal(f.calls.localSnapshots, 2, 'Saving feedback and markers starts no additional comparison.');
    assert.equal(f.calls.remoteSnapshots, 0);
    assert.equal(drained, false, 'Shutdown tracking still includes the unfinished scan.');
  } finally { clearTimeout(timer); release(); }
  const result = await refreshing;
  await draining;
  assert.equal(f.service.busy, false);
  assert.equal(result.review.comments[0].body, 'Saved during background scan');
  assert.equal(result.review.approvals[file.id], file.fingerprint);
});

test('remote file markers use the loaded grouped snapshot without provider reads, even after a push or disconnect', async t => {
  const f = await fixture(t);
  const childFile: ReviewFile = { ...file, id: 'packages/child/src/new.ts', repoRelativePath: child.relativePath, fingerprint: 'child-v1' };
  f.hooks.snapshot = snapshot => ({ ...snapshot, files: [...snapshot.files, childFile], repos: [...snapshot.repos, { relativePath: child.relativePath, workingTreeIncluded: false, currentBranch: null }] });
  const review = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }, { repositoryPath: child.relativePath, prId: 8 }]);
  const loaded = await f.service.refreshReview(review.id);
  const selection = loaded.snapshot.files.map(value => ({ fileId: value.id, fingerprint: value.fingerprint }));
  f.live.get('.#7')!.sourceHash = hash('d');
  f.live.get('packages/child#8')!.sourceHash = hash('e');
  f.hooks.snapshotError = new Error('No network connection');
  await f.service.disconnectConnection('bb');
  const before = structuredClone(f.calls);

  const marked = await f.service.setApprovals(review.id, selection, true);
  assert.deepEqual(marked.approvals, { [file.id]: file.fingerprint, [childFile.id]: childFile.fingerprint });
  assert.deepEqual(f.calls, before, 'Mark reviewed only writes the versions already displayed; it reads neither credentials nor Bitbucket.');
  const restored = new ReviewStore(f.reviewsPath); await restored.load();
  assert.deepEqual(restored.getReview(review.id).approvals, marked.approvals, 'The local markers are durable before navigation completes.');
  const unmarked = await f.service.setApprovals(review.id, selection, false);
  assert.deepEqual(unmarked.approvals, {});
  assert.deepEqual(f.calls, before, 'Unmark reviewed also reuses the loaded snapshot.');
});

test('explicit remote refresh clears changed file markers while retaining markers for unchanged files', async t => {
  const f = await fixture(t); const review = await f.open();
  const unchanged: ReviewFile = { ...file, id: 'src/unchanged.ts', path: 'src/unchanged.ts', remotePath: 'src/unchanged.ts', fingerprint: 'unchanged-v1' };
  f.hooks.snapshot = snapshot => ({ ...snapshot, files: [...snapshot.files, unchanged] });
  const loaded = await f.service.refreshReview(review.id);
  const selection = loaded.snapshot.files.map(value => ({ fileId: value.id, fingerprint: value.fingerprint }));
  await f.service.setApprovals(review.id, selection, true);
  const before = f.calls.remoteSnapshots;
  f.hooks.snapshot = snapshot => ({ ...snapshot, fingerprint: 'snapshot-v2', files: [{ ...file, newContent: 'Changed after review\n', fingerprint: 'contents-v2', headCommit: hash('d') }, unchanged] });

  const refreshed = await f.service.refreshReview(review.id);
  assert.equal(f.calls.remoteSnapshots, before + 1);
  assert.deepEqual(refreshed.review.approvals, { [unchanged.id]: unchanged.fingerprint });
  const providerCalls = structuredClone(f.calls);
  await assert.rejects(() => f.service.setApprovals(review.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true), /changed|version/i);
  assert.deepEqual(f.calls, providerCalls, 'An old renderer version is rejected against the refreshed cache without another refresh.');
  const marked = await f.service.setApprovals(review.id, [{ fileId: file.id, fingerprint: 'contents-v2' }], true);
  assert.deepEqual(marked.approvals, { [unchanged.id]: unchanged.fingerprint, [file.id]: 'contents-v2' });
  assert.deepEqual(f.calls, providerCalls);
});

test('remote marking requires a loaded snapshot on first open and after restart, while unmarking remains local', async t => {
  const f = await fixture(t); const review = await f.open();
  const selection = [{ fileId: file.id, fingerprint: file.fingerprint }];
  const beforeLoad = structuredClone(f.calls);
  await assert.rejects(() => f.service.setApprovals(review.id, selection, true), /load|open|refresh/i);
  assert.deepEqual((await f.service.setApprovals(review.id, selection, false)).approvals, {});
  assert.deepEqual(f.calls, beforeLoad, 'Missing cache never initiates an implicit provider refresh.');
  assert.deepEqual(f.reviews.getReview(review.id).approvals, {});
  await f.service.refreshReview(review.id);
  await f.service.setApprovals(review.id, selection, true);

  const restored = new ReviewStore(f.reviewsPath); await restored.load();
  const restarted = new ReviewService(restored,
    async () => { throw new Error('Remote marking must not inspect the local repository.'); },
    async config => f.service.buildSnapshot(config as Review));
  const beforeReopen = structuredClone(f.calls);
  await assert.rejects(() => restarted.setApprovals(review.id, selection, true), /load|open|refresh/i);
  assert.deepEqual(restored.getReview(review.id).approvals, { [file.id]: file.fingerprint });
  assert.deepEqual(f.calls, beforeReopen, 'Persisted markers do not stand in for a server-owned loaded snapshot.');
  assert.deepEqual((await restarted.setApprovals(review.id, [{ fileId: file.id, fingerprint: 'an-older-version' }], false)).approvals, {});
  assert.deepEqual(f.calls, beforeReopen, 'Unmarking is safe even without cached contents or a matching version.');
  await restarted.refreshReview(review.id);
  const afterReopen = structuredClone(f.calls);
  assert.deepEqual((await restarted.setApprovals(review.id, selection, true)).approvals, { [file.id]: file.fingerprint });
  assert.deepEqual((await restarted.setApprovals(review.id, selection, false)).approvals, {});
  assert.deepEqual(f.calls, afterReopen);
});

test('remote marker batches validate every cached file before marking any selection', async t => {
  const f = await fixture(t); const review = await f.open();
  const second: ReviewFile = { ...file, id: 'src/second.ts', path: 'src/second.ts', fingerprint: 'second-v1' };
  const unavailable: ReviewFile = { ...file, id: 'src/unavailable.ts', path: 'src/unavailable.ts', fingerprint: 'unavailable-v1', oldContent: null, newContent: null, unavailable: 'Bitbucket did not return this file.' };
  f.hooks.snapshot = snapshot => ({ ...snapshot, files: [...snapshot.files, second, unavailable] });
  await f.service.refreshReview(review.id);
  const valid = { fileId: file.id, fingerprint: file.fingerprint };
  const invalid = [
    { fileId: second.id, fingerprint: 'not-the-loaded-version' },
    { fileId: 'src/missing.ts', fingerprint: 'invented-version' },
    { fileId: unavailable.id, fingerprint: unavailable.fingerprint },
  ];
  const providerCalls = structuredClone(f.calls);
  for (const invalidFile of invalid) {
    await assert.rejects(() => f.service.setApprovals(review.id, [valid, invalidFile], true), /changed|version|could not be loaded/i);
    assert.deepEqual(f.reviews.getReview(review.id).approvals, {}, 'A rejected later selection leaves earlier file markers untouched.');
    assert.deepEqual(f.calls, providerCalls);
  }
  await f.service.setApprovals(review.id, [valid], true);
  assert.deepEqual((await f.service.setApprovals(review.id, [{ ...valid, fingerprint: 'older-version' }, invalid[1]], false)).approvals, {});
  assert.deepEqual(f.calls, providerCalls, 'Clearing stale or removed markers needs no provider validation.');
});

test('publishing still checks live PR revisions after marking the cached file reviewed', async t => {
  const f = await fixture(t); const review = await f.open(); const comment = await f.add(review.id);
  await f.service.setApprovals(review.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true);
  f.live.get('.#7')!.sourceHash = hash('d');
  const before = structuredClone(f.calls);

  await assert.rejects(() => f.service.publishFeedback(review.id), /branch changed/);
  assert.equal(f.state.review(review.id)!.publications[comment.id].state, 'draft');
  assert.ok(f.calls.prs.length > before.prs.length, 'Publication validates the current remote commit before sending.');
  assert.deepEqual(f.sent, [], 'A draft from the earlier snapshot is never posted to changed PR lines.');
  assert.equal(f.calls.remoteSnapshots, before.remoteSnapshots);
  assert.equal(f.reviews.getReview(review.id).comments[0].body, comment.body);
  assert.deepEqual(f.reviews.getReview(review.id).approvals, { [file.id]: file.fingerprint });
});

test('Jira and Bitbucket remain separately bound per project, and UI/store state excludes API tokens', async t => {
  const f = await fixture(t); const review = await f.open();
  const issue = await f.service.getJiraIssue(review.id);
  assert.equal(issue.key, 'APP-123'); assert.deepEqual(f.calls.jira, [['jira', 'APP-123']]);
  await f.service.setReviewTicket(review.id, 'app-456');
  assert.equal((await f.service.getJiraIssue(review.id)).key, 'APP-456');
  assert.equal((await f.service.getJiraIssue(review.id, 'app-789')).key, 'APP-789');
  const second = await f.reviews.createProject({ repoPath: '/other/project', name: 'Other' });
  await f.service.configureProjectIntegration(second.id, { ...f.settings, jiraConnectionId: undefined });
  const otherReview = await f.service.openPullRequestReview(second.id, [{ repositoryPath: '.', prId: 7 }]);
  await assert.rejects(() => f.service.getJiraIssue(otherReview.id), /Choose a Jira/);
  await assert.rejects(() => f.service.configureProjectIntegration(f.project.id, { ...f.settings, jiraConnectionId: 'bb' }), /available jira/);
  const exposed = JSON.stringify([f.service.getIntegrations(), f.service.getRemoteReview(review.id), f.reviews.getState(), await readFile(f.statePath, 'utf8'), await readFile(f.reviewsPath, 'utf8')]);
  assert.ok(!exposed.includes('bb-private-token') && !exposed.includes('jira-private-token'));
  assert.equal(f.service.getRemoteReview(review.id)?.connectionId, 'bb');
});

test('Current Jira inference reinspects the branch while saved and explicitly linked tickets use their fixed context', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.getJiraIssue(currentReviewId(f.project.id))).key, 'APP-999');
  f.currentBranch('APP-888-new');
  assert.equal((await f.service.getJiraIssue(currentReviewId(f.project.id))).key, 'APP-888');
  await f.service.setReviewTicket(currentReviewId(f.project.id), 'APP-321');
  f.currentBranch(null);
  assert.equal((await f.service.getJiraIssue(currentReviewId(f.project.id))).key, 'APP-321');
  assert.equal(f.calls.localInspections, 2);
  await f.service.setReviewTicket(currentReviewId(f.project.id), '');
  await assert.rejects(() => f.service.getJiraIssue(currentReviewId(f.project.id)), /ticket key/);
});

test('Jira browser links use the selected account and explicit ticket without requiring a usable API token', async t => {
  const f = await fixture(t); const review = await f.open();
  await f.reviews.updateSettings({ jiraBaseUrl: 'https://unrelated.atlassian.net' });
  assert.deepEqual(await f.service.getJiraTicketLink(review.id), { key: 'APP-123', url: 'https://separate.atlassian.net/browse/APP-123' });
  await f.service.setReviewTicket(review.id, 'ops-789');
  await f.service.disconnectConnection('jira');
  assert.deepEqual(await f.service.getJiraTicketLink(review.id), { key: 'OPS-789', url: 'https://separate.atlassian.net/browse/OPS-789' });
  assert.deepEqual(f.calls.jira, [], 'Opening a browser link does not request ticket contents.');
  assert.equal(f.calls.localInspections, 0, 'A saved PR ticket never depends on the local checkout.');
  await assert.rejects(() => f.service.getJiraTicketLink('missing-review'), /review/i);
});

test('Jira browser links preserve legacy site paths and follow Current or an explicitly selected ticket', async t => {
  const f = await fixture(t); const id = currentReviewId(f.project.id);
  await f.service.configureProjectIntegration(f.project.id, { ...f.settings, jiraConnectionId: undefined });
  assert.equal(await f.service.getJiraTicketLink(id), null);
  await f.reviews.updateSettings({ jiraBaseUrl: 'http://jira.internal/jira' });
  assert.deepEqual(await f.service.getJiraTicketLink(id), { key: 'APP-999', url: 'http://jira.internal/jira/browse/APP-999' });
  f.currentBranch(null);
  assert.equal(await f.service.getJiraTicketLink(id), null);
  await f.service.setReviewTicket(id, 'APP-321');
  assert.deepEqual(await f.service.getJiraTicketLink(id), { key: 'APP-321', url: 'http://jira.internal/jira/browse/APP-321' });
  assert.equal(f.calls.localInspections, 2);
});

test('inline wrappers preserve edited bodies, anchors, resolution and deletion through publication', async t => {
  const f = await fixture(t); const review = await f.open(); const comment = await f.add(review.id);
  const publication = f.service.getRemoteReview(review.id)!.publications[comment.id];
  assert.equal(publication.anchor.path, 'src/new.ts'); assert.equal(publication.anchor.sourceHash, hash('a'));
  await f.service.updateComment(review.id, comment.id, { body: 'Edited before publish' });
  assert.equal((await f.service.previewFeedback(review.id)).items[0].body, 'Edited before publish');
  await f.service.publishFeedback(review.id);
  assert.deepEqual(f.sent[0], { content: { raw: 'Edited before publish' }, inline: { path: 'src/new.ts', to: 2, start_to: 1 } });
  await f.service.updateComment(review.id, comment.id, { body: 'Edited after publish', resolved: true });
  await f.service.publishFeedback(review.id);
  assert.equal(f.comments[0].body, 'Edited after publish'); assert.equal(f.comments[0].resolved, true);
  await f.service.deleteComment(review.id, comment.id);
  assert.equal(f.service.getRemoteReview(review.id)!.publications[comment.id].backup?.body, 'Edited after publish');
  await f.service.publishFeedback(review.id);
  assert.equal(f.comments[0].deleted, true); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.reviews.getReview(review.id).comments, []);
});

test('connection replacement and verification invalidate cached clients while saved reviews stay bound to their original account', async t => {
  const f = await fixture(t); const review = await f.open();
  await f.service.listPullRequests(f.project.id, 'all');
  assert.deepEqual(f.calls.clientTokens, ['bb-private-token']);
  await f.service.saveConnection({ id: 'bb', kind: 'bitbucket', email: 'BB@example.com', token: 'replacement-private-token' });
  await f.service.refreshReview(review.id);
  assert.deepEqual(f.calls.clientTokens, ['bb-private-token', 'replacement-private-token']);
  await f.service.testConnection('bb'); await f.service.listPullRequests(f.project.id, 'all');
  assert.equal(f.calls.clientTokens.length, 3);
  await assert.rejects(() => f.service.saveConnection({ id: 'bb', kind: 'bitbucket', email: 'other@example.com', token: 'other' }), /separate connection/);
  assert.equal(f.calls.saves, 1);
  await f.service.disconnectConnection('bb');
  await assert.rejects(() => f.service.refreshReview(review.id), /Reconnect/);
  assert.equal(f.service.getRemoteReview(review.id)?.connectionId, 'bb');
  assert.equal(f.calls.localSnapshots, 0);
  assert.equal(f.service.getIntegrations().connections.find(connection => connection.id === 'bb')?.connected, false);
  await f.service.saveConnection({ id: 'bb', kind: 'bitbucket', email: 'bb@example.com', token: 'reconnected-private-token' });
  await f.service.refreshReview(review.id);
  assert.equal(f.service.getRemoteReview(review.id)?.connectionId, 'bb');
  assert.equal(f.service.getIntegrations().connections.find(connection => connection.id === 'bb')?.connected, true);
});

test('permission loss preserves local feedback, reports unavailable refresh, and never switches to local Git', async t => {
  const f = await fixture(t); const review = await f.open(); const comment = await f.add(review.id);
  f.hooks.snapshotError = new ProviderError('Permission removed', 403);
  await assert.rejects(() => f.service.refreshReview(review.id), /Permission removed/);
  assert.equal(f.reviews.getReview(review.id).comments[0].id, comment.id);
  f.hooks.listError = new ProviderError('Permission removed', 403);
  await assert.rejects(() => f.service.listPullRequests(f.project.id, 'all'), /Permission removed/);
  f.hooks.publishError = new ProviderError('Permission removed', 403);
  await assert.rejects(() => f.service.publishFeedback(review.id), /Permission removed/);
  assert.equal(f.state.review(review.id)!.publications[comment.id].state, 'draft');
  assert.equal(f.sent.length, 0); assert.equal(f.calls.localSnapshots, 0);
});

test('project configuration and account changes cannot race a queued review operation', async t => {
  const f = await fixture(t); const review = await f.open();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.beforeSnapshot = async () => { entered(); await blocked; };
  const refreshing = f.service.refreshReview(review.id); await started;
  await assert.rejects(() => f.service.configureProjectIntegration(f.project.id, { ...f.settings, updateSubmodulePointers: true }), /current review operation/);
  await assert.rejects(() => f.service.disconnectConnection('bb'), /Wait for/);
  await assert.rejects(() => f.service.saveConnection({ id: 'bb', kind: 'bitbucket', email: 'bb@example.com', token: 'replacement' }), /Wait for/);
  assert.equal(f.state.project(f.project.id).updateSubmodulePointers, false);
  release(); await refreshing;
  await f.service.idle(); assert.equal(f.service.busy, false);
});

test('user-activated integration links allow external HTTPS documentation without admitting credentials or control characters', async t => {
  const f = await fixture(t);
  assert.equal(f.service.validateLink('https://docs.example.com/page?q=hello#section'), 'https://docs.example.com/page?q=hello#section');
  for (const value of ['http://docs.example.com', 'https://user:token@example.com', 'file:///tmp/private', 'javascript:alert(1)', 'https://exa\nmple.com', `https://example.com/${'a'.repeat(8192)}`]) {
    assert.throws(() => f.service.validateLink(value), /HTTPS/);
  }
});

test('connection changes stay tracked across verification and prevent new review requests until completion', async t => {
  const f = await fixture(t); const review = await f.open();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.beforeSave = async () => { entered(); await blocked; };
  const saving = f.service.saveConnection({ id: 'bb', kind: 'bitbucket', email: 'bb@example.com', token: 'new-private-token' });
  await started;
  await assert.rejects(() => f.service.refreshReview(review.id), /connection change/);
  await assert.rejects(() => f.service.listPullRequests(f.project.id, 'all'), /connection change/);
  await assert.rejects(() => f.service.getJiraIssue(review.id), /connection change/);
  await assert.rejects(() => f.service.disconnectConnection('bb'), /Wait for/);
  let drained = false;
  const draining = f.service.idle().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await saving; await draining;
  assert.equal(f.service.busy, false);
  await f.service.refreshReview(review.id);
  assert.deepEqual(f.calls.clientTokens, ['bb-private-token', 'new-private-token']);
});

test('approval preview retains freshness blockers without imposing merge strategies or pointer requirements', async t => {
  const f = await fixture(t); const review = await f.open(); await f.service.refreshReview(review.id);
  await f.service.configureProjectIntegration(f.project.id, { ...f.settings, updateSubmodulePointers: true });
  f.live.get('.#7')!.mergeStrategies = ['squash'];
  assert.deepEqual((await f.service.previewMerge(review.id, 'approve')).blockers, []);
  f.live.get('.#7')!.sourceHash = hash('d');
  assert.match((await f.service.previewMerge(review.id, 'approve')).blockers.join(' '), /changed/);
});

test('invalid nested persisted integration data is rejected without overwrite or local-review fallback', async t => {
  const f = await fixture(t); const review = await f.open(); const comment = await f.add(review.id);
  const valid = JSON.parse(await readFile(f.statePath, 'utf8'));
  const corruptions = [
    (value: any) => { delete value.reviews[review.id].publications[comment.id].anchor; },
    (value: any) => { value.reviews[review.id].publications[comment.id].anchor.path = '../escape'; },
    (value: any) => { value.reviews[review.id].operation = { action: 'merge', state: 'running', updatedAt: new Date().toISOString() }; },
    (value: any) => { value.reviews[review.id].pullRequests[0].sourceHash = 'main'; },
    (value: any) => { value.projects[f.project.id].repositories[0].relativePath = '/absolute'; },
    (value: any) => { value.tickets[review.id] = { key: 'APP-123' }; },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(valid); corrupt(value); const content = JSON.stringify(value); await writeFile(f.statePath, content);
    const reopened = new IntegrationStore(f.statePath);
    await assert.rejects(() => reopened.load(), /invalid.*left untouched/);
    await assert.rejects(() => reopened.setProject(f.project.id, f.settings), /invalid.*left untouched/);
    assert.equal(await readFile(f.statePath, 'utf8'), content);
  }
  await writeFile(f.statePath, '{broken'); const unreadable = new IntegrationStore(f.statePath);
  await assert.rejects(() => unreadable.load(), /could not be read.*left untouched/);
  await assert.rejects(() => unreadable.setTicket(review.id, 'APP-123'), /left untouched/);
  assert.equal(await readFile(f.statePath, 'utf8'), '{broken');
});

test('invalid in-memory state mutations leave the last valid snapshot and disk state intact', async t => {
  const f = await fixture(t); const review = await f.open();
  const before = await readFile(f.statePath, 'utf8');
  await assert.rejects(() => f.state.updateReview(review.id, value => { value.publications.bad = { state: 'sending' } as any; }), /invalid/);
  assert.equal(await readFile(f.statePath, 'utf8'), before);
  assert.deepEqual(f.state.review(review.id)?.publications, {});
  await f.service.setReviewTicket(review.id, 'APP-123');
  assert.equal(f.state.ticket(review.id), 'APP-123');
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function promptly<T>(action: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([action, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('A remote read blocked the local interaction.')), 1500); })]); }
  finally { clearTimeout(timer); }
}

test('remote repositories stream independently and allow comments and markers before all files arrive', async t => {
  const f = await fixture(t, true), review = await f.open();
  const slow = barrier(), childStarted = barrier(), firstFiles = barrier();
  t.after(() => slow.release());
  f.hooks.beforeRepository = async repository => { if (repository.relativePath === child.relativePath) { childStarted.release(); await slow.promise; } };
  const events: RemoteReviewLoadProgress[] = [];
  const unsubscribe = f.service.onRemoteReviewLoadProgress(event => {
    events.push(structuredClone(event));
    if (event.result?.snapshot.files.some(value => value.id === file.id)) firstFiles.release();
  });
  t.after(unsubscribe);
  const refreshing = f.service.refreshReview(review.id);
  await promptly(Promise.all([childStarted.promise, firstFiles.promise]));
  const partial = events.find(event => event.result?.snapshot.files.length)!;
  assert.equal(partial.complete, false); assert.equal(partial.result!.snapshot.loading, true);
  assert.deepEqual(partial.result!.snapshot.files.map(value => value.id), [file.id]);
  assert.equal(partial.result!.snapshot.repos.find(repo => repo.relativePath === child.relativePath)?.loading, true);
  assert.ok(events.some(event => event.repositories.filter(row => ['checking', 'files'].includes(row.phase)).length === 2));
  assert.ok(events.some(event => !event.result), 'Phase-only progress does not resend cumulative file contents.');
  assert.equal(f.calls.remoteSnapshots, 2);
  const joined = f.service.refreshReview(review.id);
  assert.equal(events.at(-1)!.result!.snapshot.files.length, 1, 'Reopening an in-flight review replays its cached files.');
  const before = structuredClone(f.calls);
  const marked = await promptly(f.service.setApprovals(review.id, [{ fileId: file.id, fingerprint: file.fingerprint }], true));
  assert.equal(marked.approvals[file.id], file.fingerprint);
  assert.deepEqual(f.calls, before, 'Mark reviewed performs no remote request.');
  const saved = await promptly(f.service.addComment(review.id, { fileId: file.id, repoRelativePath: '.', path: file.path, side: 'additions', lineStart: 1, lineEnd: 1, body: 'Saved while child loads', context: 'new', fingerprint: file.fingerprint }));
  assert.equal(f.state.review(review.id)!.publications[saved.comments[0].id].anchor.sourceHash, hash('a'));
  for (const action of [() => f.service.previewFeedback(review.id), () => f.service.publishFeedback(review.id), () => f.service.previewMerge(review.id), () => f.service.runPullRequestAction(review.id, 'merge')]) await assert.rejects(action, /finish loading/);
  await assert.rejects(() => f.service.disconnectConnection('bb'), /Wait for/);
  await assert.rejects(() => f.service.configureProjectIntegration(f.project.id, f.settings), /current review operation/);
  slow.release();
  const [result, sameResult] = await Promise.all([refreshing, joined]);
  assert.deepEqual(result, sameResult);
  assert.equal(f.calls.remoteSnapshots, 2, 'Joined refreshes do not repeat discovery/downloads.');
  assert.equal(result.snapshot.files.length, 2); assert.equal(result.snapshot.loading, false);
  assert.equal(result.review.comments[0].body, 'Saved while child loads');
  assert.equal(result.review.approvals[file.id], file.fingerprint);
  assert.equal(events.at(-1)!.complete, true);
  assert.ok(events.every((event, index) => !index || event.sequence > events[index - 1].sequence));
  await f.service.idle(); assert.equal(f.service.busy, false);
  assert.equal(f.calls.localSnapshots, 0); assert.equal(f.calls.localInspections, 0);
});

test('progressive refresh retains markers for pending repositories and clears changed versions only when loaded', async t => {
  const f = await fixture(t, true), review = await f.open();
  const initial = await f.service.refreshReview(review.id);
  await f.service.setApprovals(review.id, initial.snapshot.files.map(value => ({ fileId: value.id, fingerprint: value.fingerprint })), true);
  const slow = barrier(), rootLoaded = barrier(); t.after(() => slow.release());
  f.hooks.beforeRepository = async repository => { if (repository.relativePath === child.relativePath) await slow.promise; };
  f.hooks.snapshot = snapshot => ({ ...snapshot, files: snapshot.files.map(value => value.repoRelativePath === child.relativePath ? { ...value, fingerprint: 'child-changed', newContent: 'changed\n' } : value) });
  const unsubscribe = f.service.onRemoteReviewLoadProgress(event => { if (event.repositories.some(row => row.repository.relativePath === '.' && row.phase === 'ready')) rootLoaded.release(); });
  t.after(unsubscribe);
  const refreshing = f.service.refreshReview(review.id);
  await promptly(rootLoaded.promise);
  const childFile = initial.snapshot.files.find(value => value.repoRelativePath === child.relativePath)!;
  assert.equal(f.reviews.getReview(review.id).approvals[childFile.id], childFile.fingerprint);
  const saved = await promptly(f.service.addComment(review.id, { fileId: file.id, repoRelativePath: '.', path: file.path, side: 'additions', lineStart: 1, lineEnd: 1, body: 'Second load draft', context: 'new', fingerprint: file.fingerprint }));
  slow.release(); const final = await refreshing;
  assert.equal(final.review.approvals[childFile.id], undefined);
  assert.equal(final.review.approvals[file.id], file.fingerprint);
  assert.equal(final.review.comments[0].id, saved.comments[0].id);
});

test('remote comment reconciliation reads outside the save queue and preserves concurrent edits as conflicts', async t => {
  const f = await fixture(t, true), review = await f.open();
  const comment = await f.add(review.id); await f.service.publishFeedback(review.id);
  f.comments[0].body = 'Edited in Bitbucket';
  const slow = barrier(), entered = barrier(); t.after(() => slow.release());
  f.hooks.beforeComments = async () => { entered.release(); await slow.promise; };
  const refreshing = f.service.refreshReview(review.id);
  await promptly(entered.promise);
  await promptly(f.service.updateComment(review.id, comment.id, { body: 'Edited locally while syncing' }));
  slow.release(); const result = await refreshing;
  assert.equal(result.review.comments[0].body, 'Edited locally while syncing');
  const publication = f.state.review(review.id)!.publications[comment.id];
  assert.equal(publication.state, 'conflict'); assert.equal(publication.remote?.body, 'Edited in Bitbucket');
});

test('a delayed feedback response cannot undo an explicit conflict resolution', async t => {
  const f = await fixture(t, true), review = await f.open();
  const comment = await f.add(review.id); await f.service.publishFeedback(review.id);
  await f.service.updateComment(review.id, comment.id, { body: 'Local edit' });
  f.comments[0].body = 'Chosen remote version';
  await f.service.previewFeedback(review.id);
  assert.equal(f.state.review(review.id)!.publications[comment.id].state, 'conflict');
  // A stale provider read returns the original version after the user chooses
  // the already-known newer remote version from the conflict preview.
  f.comments[0].body = 'Initial comment';
  const slow = barrier(), entered = barrier(); t.after(() => slow.release());
  f.hooks.beforeComments = async () => { entered.release(); await slow.promise; };
  const refreshing = f.service.refreshReview(review.id);
  await promptly(entered.promise);
  await promptly(f.service.resolveCommentConflict(review.id, comment.id, 'remote'));
  slow.release(); const result = await refreshing;
  assert.equal(result.review.comments[0].body, 'Chosen remote version');
  assert.equal(f.state.review(review.id)!.publications[comment.id].acknowledged?.body, 'Chosen remote version');
  assert.equal(f.state.review(review.id)!.publications[comment.id].state, 'synced');
});

test('a failed snapshot commit cannot authorize unaccepted files or leave an endless loading state', async t => {
  const f = await fixture(t, true), review = await f.open();
  const accept = f.reviewService.acceptRemoteSnapshot.bind(f.reviewService);
  let commits = 0;
  f.reviewService.acceptRemoteSnapshot = async (...args) => {
    if (++commits >= 3) throw new Error('Review storage unavailable');
    return accept(...args);
  };
  const events: RemoteReviewLoadProgress[] = [];
  const unsubscribe = f.service.onRemoteReviewLoadProgress(event => events.push(structuredClone(event))); t.after(unsubscribe);
  await assert.rejects(() => f.service.refreshReview(review.id), /storage unavailable/);
  const failure = events.at(-1)!;
  assert.equal(failure.complete, true); assert.match(failure.error!, /storage unavailable/);
  assert.equal(failure.result!.snapshot.loading, false);
  assert.equal(failure.result!.snapshot.files.length, 1, 'Only successfully accepted repository files are exposed.');
  assert.ok(failure.result!.snapshot.repos.every(repo => repo.error));
  for (const action of [() => f.service.previewFeedback(review.id), () => f.service.publishFeedback(review.id), () => f.service.previewMerge(review.id), () => f.service.runPullRequestAction(review.id, 'merge')]) await assert.rejects(action, /last load could not finish/);
  f.reviewService.acceptRemoteSnapshot = accept;
  const retried = await f.service.refreshReview(review.id);
  assert.equal(retried.snapshot.files.length, 2); assert.equal(retried.snapshot.loading, false);
  assert.deepEqual((await f.service.previewFeedback(review.id)).blockers, []);
});

test('failure accepting the final grouped snapshot stops loading and blocks actions until retry', async t => {
  const f = await fixture(t, true), review = await f.open();
  const accept = f.reviewService.acceptRemoteSnapshot.bind(f.reviewService);
  f.reviewService.acceptRemoteSnapshot = async (...args) => {
    if (!args[1].loading) throw new Error('Final snapshot could not be saved');
    return accept(...args);
  };
  const events: RemoteReviewLoadProgress[] = [];
  const unsubscribe = f.service.onRemoteReviewLoadProgress(event => events.push(structuredClone(event))); t.after(unsubscribe);
  await assert.rejects(() => f.service.refreshReview(review.id), /could not be saved/);
  assert.equal(events.at(-1)!.complete, true);
  assert.equal(events.at(-1)!.result!.snapshot.loading, false);
  await assert.rejects(() => f.service.previewMerge(review.id), /last load could not finish/);
  f.reviewService.acceptRemoteSnapshot = accept;
  assert.equal((await f.service.refreshReview(review.id)).snapshot.loading, false);
});

async function completedMerge(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return f.state.updateReview(id, remote => {
    remote.operation = { action: 'merge', state: 'complete', updatedAt: new Date().toISOString(), items: remote.pullRequests.map(pr => ({
      prKey: pullRequestKey(pr), sourceHash: pr.sourceHash, targetHash: pr.targetHash, approval: 'approved', merge: 'merged', cleanup: 'deleted', mergeCommit: hash('d'),
    })) };
    for (const row of remote.repositories || []) row.cleanup = { state: row.status === 'missing-branch' ? 'skipped' : 'deleted' };
  });
}

test('completed merge removal persists, is retryable, and leaves published feedback and the project intact', async t => {
  const f = await fixture(t), review = await f.open();
  await f.add(review.id);
  await f.service.publishFeedback(review.id);
  await f.service.setReviewTicket(review.id, 'OPS-987');
  const link = await f.service.getJiraTicketLink(review.id);
  await completedMerge(f, review.id);
  const calls = structuredClone(f.calls), comments = structuredClone(f.comments);
  const result = await f.service.completeMergedReview(review.id);
  assert.ok(!result.reviews.some(item => item.id === review.id));
  assert.ok(result.reviews.some(item => item.id === currentReviewId(f.project.id)));
  assert.equal(result.projects[0].id, f.project.id);
  assert.equal(f.state.review(review.id), null);
  assert.equal(f.state.ticket(review.id), undefined);
  assert.equal(f.service.validateLink(link!.url), 'https://separate.atlassian.net/browse/OPS-987');
  assert.deepEqual(await f.service.completeMergedReview(review.id), result, 'A lost completion response can be retried.');
  assert.deepEqual(f.comments, comments, 'Removing local history never deletes published Bitbucket comments.');
  assert.deepEqual(f.calls, calls, 'Completion needs no provider requests, credentials or Git operations.');
  const reloaded = new ReviewStore(f.reviewsPath); await reloaded.load();
  const integrations = new IntegrationStore(f.statePath); await integrations.load();
  assert.ok(!reloaded.getState().reviews.some(item => item.id === review.id));
  assert.equal(integrations.review(review.id), null);
});

test('merge completion cannot remove partial, changed, retained or unconfirmed reviews', async t => {
  const f = await fixture(t), review = await f.open();
  await f.service.refreshReview(review.id);
  const clean = await completedMerge(f, review.id);
  const cases: Array<(remote: typeof clean) => void> = [
    remote => { remote.operation!.action = 'approve'; },
    remote => { remote.operation!.state = 'paused'; },
    remote => { remote.operation!.items[0].merge = 'unknown'; },
    remote => { remote.operation!.items[0].cleanup = 'retained'; },
    remote => { remote.operation!.items[0].cleanup = 'unknown'; },
    remote => { remote.operation!.items[0].error = 'Recheck the source revision'; },
    remote => { remote.pullRequests[0].sourceHash = hash('e'); },
    remote => { remote.operation!.items[0].pointerState = 'review'; },
    remote => { remote.repositories = [{ repository: child, sourceBranch: review.featureBranch, targetBranch: review.baseBranch, sourceHash: hash('a'), targetHash: hash('b'), status: 'no-changes', cleanup: { state: 'pending' } }]; },
  ];
  for (const change of cases) {
    const pending = structuredClone(clean); change(pending);
    await f.state.setReview(review.id, pending);
    await assert.rejects(() => f.service.completeMergedReview(review.id), /Finish merging and confirm branch cleanup/);
    assert.equal(f.reviews.getReview(review.id).id, review.id);
  }
  await assert.rejects(() => f.service.completeMergedReview(currentReviewId(f.project.id)), /Finish merging/);
});

test('startup retires completed saved reviews without loading remote branches and preserves pending cleanup', async t => {
  const f = await fixture(t), completed = await f.open();
  await completedMerge(f, completed.id);
  const pending = await f.reviews.createReview({ projectId: f.project.id, name: 'Cleanup still needed', featureBranch: 'APP-123-feature', baseBranch: 'main', includeWorkingTree: false }, true);
  const remote = f.state.review(completed.id)!;
  remote.operation!.items[0].cleanup = 'retained';
  await f.state.setReview(pending.id, remote);
  const reloaded = new ReviewStore(f.reviewsPath); await reloaded.load();
  const integrations = new IntegrationStore(f.statePath); await integrations.load();
  const unavailableConnections = {} as ConnectionManager;
  const local = new ReviewService(reloaded, async () => { throw new Error('Startup must not inspect Git'); }, async () => { throw new Error('Startup must not build a snapshot'); });
  const service = new IntegrationService(reloaded, local, integrations, unavailableConnections, {} as PointerService);
  await service.removeCompletedReviews();
  assert.ok(!reloaded.getState().reviews.some(item => item.id === completed.id));
  assert.ok(reloaded.getState().reviews.some(item => item.id === pending.id));
  assert.equal(integrations.review(completed.id), null);
  assert.equal(integrations.review(pending.id)!.operation!.items[0].cleanup, 'retained');
});

test('completion recovers if integration cleanup fails after the local review was removed', async t => {
  const f = await fixture(t), review = await f.open();
  await completedMerge(f, review.id);
  const remove = f.state.removeReview.bind(f.state);
  let fail = true;
  f.state.removeReview = async id => { if (fail) { fail = false; throw new Error('Storage temporarily unavailable'); } return remove(id); };
  await assert.rejects(() => f.service.completeMergedReview(review.id), /Storage temporarily unavailable/);
  assert.ok(!f.reviews.getState().reviews.some(item => item.id === review.id));
  assert.ok(f.state.review(review.id));
  const retried = await f.service.completeMergedReview(review.id);
  assert.ok(!retried.reviews.some(item => item.id === review.id));
  assert.equal(f.state.review(review.id), null);
});

test('startup finishes orphan metadata cleanup after interruption between review and integration removal', async t => {
  const f = await fixture(t), review = await f.open();
  await completedMerge(f, review.id);
  await f.service.setReviewTicket(review.id, 'OPS-987');
  await f.service.setReviewTicket(currentReviewId(f.project.id), 'APP-123');
  await f.reviews.deleteReview(review.id); // Simulate termination before integrations.json was updated.
  const reloaded = new ReviewStore(f.reviewsPath); await reloaded.load();
  const integrations = new IntegrationStore(f.statePath); await integrations.load();
  const local = new ReviewService(reloaded, async () => { throw new Error('Unexpected Git'); }, async () => { throw new Error('Unexpected snapshot'); });
  const service = new IntegrationService(reloaded, local, integrations, {} as ConnectionManager, {} as PointerService);
  await service.removeCompletedReviews();
  const checked = new IntegrationStore(f.statePath); await checked.load();
  assert.equal(checked.review(review.id), null);
  assert.equal(checked.ticket(review.id), undefined);
  assert.equal(checked.ticket(currentReviewId(f.project.id)), 'APP-123');
  assert.deepEqual(checked.project(f.project.id), f.settings);
});

test('closed-review checks use saved PR identities and remove only locally after every grouped PR is closed', async t => {
  const f = await fixture(t);
  const review = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }, { repositoryPath: child.relativePath, prId: 8 }]);
  const before = structuredClone(f.calls);
  for (const method of ['getRepository', 'getBranch', 'findPullRequests', 'listPullRequests', 'approve', 'merge', 'createPullRequest', 'createComment', 'updateComment', 'resolveComment', 'deleteComment']) {
    (f.client as any)[method] = async () => { throw new Error(`Unexpected provider operation: ${method}`); };
  }
  f.live.get('.#7')!.state = 'MERGED';
  for (const closedState of ['DECLINED', 'SUPERSEDED', 'MERGED']) {
    f.live.get(`${child.relativePath}#8`)!.state = closedState;
    const checked = await f.service.checkClosedReview(review.id);
    assert.equal(checked.status, 'closed'); assert.equal(checked.name, review.name);
    assert.deepEqual(checked.pullRequests.map(pr => pr.state), ['MERGED', closedState]);
    assert.equal(f.reviews.getReview(review.id).id, review.id, 'Checking does not delete the review.');
  }
  const removed = await f.service.removeClosedReviews(f.project.id, [review.id, review.id]);
  assert.deepEqual(removed.removedIds, [review.id]); assert.deepEqual(removed.retained, []);
  assert.equal(f.state.review(review.id), null);
  assert.ok(!removed.state.reviews.some(value => value.id === review.id));
  assert.ok(removed.state.reviews.some(value => value.id === currentReviewId(f.project.id)));
  assert.equal(f.calls.localInspections, before.localInspections);
  assert.equal(f.calls.localSnapshots, before.localSnapshots); assert.equal(f.calls.remoteSnapshots, before.remoteSnapshots);
  assert.deepEqual(f.calls.prs.slice(before.prs.length).map(({ repository, id }) => [repository.repoSlug, id]), Array.from({ length: 4 }, () => [['root', 7], ['child', 8]]).flat());
  const reloaded = new ReviewStore(f.reviewsPath); await reloaded.load();
  assert.ok(!reloaded.getState().reviews.some(value => value.id === review.id));
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, [review.id], 'Lost responses can be retried.');
});

test('closed-review checks retain groups with open PRs and recheck a reopened PR before removing', async t => {
  const f = await fixture(t);
  const review = await f.service.openPullRequestReview(f.project.id, [{ repositoryPath: '.', prId: 7 }, { repositoryPath: child.relativePath, prId: 8 }]);
  f.live.get('.#7')!.state = 'MERGED';
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'open');
  f.live.get(`${child.relativePath}#8`)!.state = 'DECLINED';
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'closed');
  f.live.get(`${child.relativePath}#8`)!.state = 'OPEN';
  const result = await f.service.removeClosedReviews(f.project.id, [review.id]);
  assert.deepEqual(result.removedIds, []); assert.equal(result.retained[0].status, 'open');
  assert.deepEqual(result.retained[0].pullRequests.map(pr => pr.state), ['MERGED', 'OPEN']);
  assert.equal(f.reviews.getReview(review.id).id, review.id);
});

test('closed-review checks keep unknown, inaccessible and mismatched PRs without assuming 404 means closed', async t => {
  const f = await fixture(t), review = await f.open();
  for (const status of [401, 403, 404, 429, 500]) {
    f.hooks.pr = () => { throw new ProviderError(`Bitbucket returned ${status}`, status); };
    const check = await f.service.checkClosedReview(review.id);
    assert.equal(check.status, 'unavailable'); assert.equal(check.pullRequests[0].state, 'UNAVAILABLE');
    assert.match(check.reason!, new RegExp(String(status)));
    assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, []);
  }
  f.hooks.pr = value => ({ ...value, state: 'UNRECOGNIZED' });
  assert.match((await f.service.checkClosedReview(review.id)).reason!, /unrecognized PR state/);
  for (const change of [(value: PullRequest) => ({ ...value, id: 99 }), (value: PullRequest) => ({ ...value, repository: { ...value.repository, workspace: 'elsewhere' } })]) {
    f.hooks.pr = value => change({ ...value, state: 'MERGED' });
    const check = await f.service.checkClosedReview(review.id);
    assert.equal(check.status, 'unavailable'); assert.match(check.reason!, /different repository or PR identity/);
  }
  f.hooks.pr = undefined;
  await f.service.disconnectConnection('bb');
  const disconnected = await f.service.checkClosedReview(review.id);
  assert.equal(disconnected.status, 'unavailable'); assert.match(disconnected.reason!, /original Bitbucket account/);
  assert.equal(f.reviews.getReview(review.id).id, review.id);
});

test('closed-review checks use the original account and repository mappings after project settings change', async t => {
  const f = await fixture(t), review = await f.open();
  const other = structuredClone(f.accounts.get('bb')!);
  other.info.id = 'another-account'; other.info.accountId = 'another-user'; other.token = 'another-token';
  f.accounts.set(other.info.id, other);
  await f.service.configureProjectIntegration(f.project.id, { ...f.settings, bitbucketConnectionId: other.info.id, repositories: [{ ...root, workspace: 'different', repoSlug: 'new-root' }] });
  f.live.get('.#7')!.state = 'MERGED';
  const before = f.calls.prs.length;
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'closed');
  assert.deepEqual(f.calls.clients, ['bb']);
  assert.deepEqual(f.calls.prs.slice(before), [{ repository: root, id: 7 }]);
  await f.service.disconnectConnection('bb');
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'unavailable', 'The replacement project account cannot be used silently.');
});

test('closed-review removal protects local reviews, missing metadata and reviews belonging to another project', async t => {
  const f = await fixture(t), review = await f.open();
  const local = await f.reviews.createReview({ projectId: f.project.id, name: 'Local branch', featureBranch: 'feature', baseBranch: 'main', includeWorkingTree: false });
  const other = await f.reviews.createProject({ repoPath: '/local/other-project', name: 'Other project' });
  const otherReview = await f.reviews.createReview({ projectId: other.id, name: 'Other Bitbucket review', featureBranch: review.featureBranch, baseBranch: 'main', includeWorkingTree: false }, true);
  await f.state.setReview(otherReview.id, f.state.review(review.id)!);
  const before = f.calls.prs.length;
  for (const id of [local.id, currentReviewId(f.project.id)]) assert.equal((await f.service.checkClosedReview(id)).status, 'blocked');
  const result = await f.service.removeClosedReviews(f.project.id, [local.id, currentReviewId(f.project.id), otherReview.id]);
  assert.deepEqual(result.removedIds, []); assert.ok(result.retained.every(check => check.status === 'blocked'));
  assert.match(result.retained.find(check => check.reviewId === otherReview.id)!.reason!, /another project/);
  await f.state.removeReview(review.id);
  assert.match((await f.service.checkClosedReview(review.id)).reason!, /missing Bitbucket metadata/);
  assert.equal(f.calls.prs.length, before, 'Ineligible reviews do not call the provider.');
  for (const invalid of [null, [], [null], ['__proto__', review.id], new Array(1001).fill(review.id)]) await assert.rejects(() => f.service.removeClosedReviews(f.project.id, invalid as any), /Choose saved reviews/);
  await assert.rejects(() => f.service.checkClosedReview('__proto__'), /Choose a saved review/);
});

test('closed-review cleanup preserves incomplete merge, approval, pointer and branch-deletion operations', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  const clean = await completedMerge(f, review.id);
  const cases: Array<(remote: typeof clean) => void> = [
    remote => { remote.operation!.state = 'running'; },
    remote => { remote.operation!.state = 'paused'; },
    remote => { remote.operation!.action = 'approve'; remote.operation!.state = 'paused'; },
    remote => { remote.operation!.items[0].merge = 'failed'; },
    remote => { remote.operation!.items[0].merge = 'unknown'; },
    remote => { remote.operation!.items[0].cleanup = 'retained'; },
    remote => { remote.operation!.items[0].cleanup = 'unknown'; },
    remote => { delete remote.operation!.items[0].cleanup; },
    remote => { remote.operation!.items[0].pointerState = 'review'; },
    remote => { remote.operation!.items[0].error = 'Cleanup failed'; },
    remote => { remote.operation!.error = 'Checks still pending'; },
  ];
  const reads = f.calls.prs.length;
  for (const change of cases) {
    const pending = structuredClone(clean); change(pending); await f.state.setReview(review.id, pending);
    const check = await f.service.checkClosedReview(review.id);
    assert.equal(check.status, 'blocked'); assert.match(check.reason!, /unfinished.*resume or reconcile/);
    assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, []);
  }
  assert.ok(f.calls.prs.length > reads, 'Paused operations are reconciled against remote state before retaining them.');
  await f.state.setReview(review.id, clean);
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'closed');
});

test('closed-review checks keep no-PR work and uncertain branch operations but tolerate previously deleted merged branches', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  const legacy = f.state.review(review.id)!;
  const row = { repository: child, sourceBranch: review.featureBranch, targetBranch: review.baseBranch, sourceHash: hash('a'), targetHash: hash('b'), status: 'no-changes' as const };
  for (const pending of [
    { ...row, status: 'changes' as const },
    { ...row, status: 'unavailable' as const },
    { ...row, creation: { state: 'unknown' as const, sourceHash: hash('a'), targetHash: hash('b'), startedAt: new Date().toISOString(), marker: 'a'.repeat(24) } },
    ...(['pending', 'checking', 'sending', 'retained', 'unknown'] as const).map(state => ({ ...row, cleanup: { state, expectedHead: hash('a') } })),
  ]) {
    await f.state.setReview(review.id, { ...legacy, repositories: [pending] });
    const check = await f.service.checkClosedReview(review.id);
    assert.equal(check.status, 'blocked');
    assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, []);
  }
  await f.state.setReview(review.id, { ...legacy, repositories: [{ repository: root, sourceBranch: review.featureBranch, targetBranch: review.baseBranch, status: 'missing-branch', prId: 7, cleanup: { state: 'deleted' } }] });
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'closed');
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, [review.id]);
});

test('closed-review check reports unpublished drafts, edits and deletion records without publishing or losing them during checking', async t => {
  const f = await fixture(t), review = await f.open();
  const initial = await f.add(review.id);
  assert.equal((await f.service.checkClosedReview(review.id)).unpublishedComments, 1);
  await f.service.publishFeedback(review.id);
  assert.equal((await f.service.checkClosedReview(review.id)).unpublishedComments, 0);
  await f.service.updateComment(review.id, initial.id, { body: 'Pending edit' });
  assert.equal((await f.service.checkClosedReview(review.id)).unpublishedComments, 1);
  await f.service.updateComment(review.id, initial.id, { body: 'Initial comment' });
  assert.equal((await f.service.checkClosedReview(review.id)).unpublishedComments, 0);
  await f.service.deleteComment(review.id, initial.id);
  const draft = await f.add(review.id);
  const before = structuredClone(f.comments);
  f.live.get('.#7')!.state = 'MERGED';
  f.live.get(`${child.relativePath}#8`)!.state = 'MERGED';
  const checked = await f.service.checkClosedReview(review.id);
  assert.equal(checked.status, 'closed'); assert.equal(checked.unpublishedComments, 2);
  assert.equal(f.reviews.getReview(review.id).comments[0].id, draft.id);
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id])).removedIds, [review.id]);
  assert.deepEqual(f.comments, before, 'Explicitly removing local feedback never edits published Bitbucket comments.');
});

test('closed-review cleanup handles partial metadata storage failure and retries without repeating successful deletions', async t => {
  const f = await fixture(t), review = await f.open();
  const second = await f.reviews.createReview({ projectId: f.project.id, name: 'Second old review', featureBranch: review.featureBranch, baseBranch: review.baseBranch, includeWorkingTree: false }, true);
  await f.state.setReview(second.id, f.state.review(review.id)!);
  f.live.get('.#7')!.state = 'MERGED';
  const remove = f.state.removeReview.bind(f.state);
  let fail = true;
  f.state.removeReview = async id => { if (id === review.id && fail) { fail = false; throw new Error('Metadata storage unavailable'); } return remove(id); };
  const result = await f.service.removeClosedReviews(f.project.id, [review.id, second.id]);
  assert.deepEqual(result.removedIds, [second.id]);
  assert.equal(result.retained[0].reviewId, review.id); assert.match(result.retained[0].reason!, /metadata still needs cleanup/);
  assert.ok(!result.state.reviews.some(value => [review.id, second.id].includes(value.id)));
  assert.ok(f.state.review(review.id)); assert.equal(f.state.review(second.id), null);
  const calls = f.calls.prs.length;
  const retried = await f.service.removeClosedReviews(f.project.id, [review.id, second.id]);
  assert.deepEqual(new Set(retried.removedIds), new Set([review.id, second.id])); assert.deepEqual(retried.retained, []);
  assert.equal(f.state.review(review.id), null); assert.equal(f.calls.prs.length, calls, 'Metadata-only retries need no remote requests.');
});

test('closed-review cleanup retains reviews if primary storage cannot remove them and continues the batch', async t => {
  const f = await fixture(t), review = await f.open();
  const second = await f.reviews.createReview({ projectId: f.project.id, name: 'Second old review', featureBranch: review.featureBranch, baseBranch: review.baseBranch, includeWorkingTree: false }, true);
  await f.state.setReview(second.id, f.state.review(review.id)!);
  f.live.get('.#7')!.state = 'MERGED';
  const remove = f.reviewService.deleteReview.bind(f.reviewService);
  f.reviewService.deleteReview = async id => { if (id === review.id) throw new Error('Review storage unavailable'); return remove(id); };
  const result = await f.service.removeClosedReviews(f.project.id, [review.id, second.id]);
  assert.deepEqual(result.removedIds, [second.id]); assert.match(result.retained[0].reason!, /Review storage unavailable/);
  assert.ok(result.state.reviews.some(value => value.id === review.id)); assert.ok(f.state.review(review.id));
  f.reviewService.deleteReview = remove;
  f.live.get('.#7')!.state = 'OPEN';
  assert.equal((await f.service.removeClosedReviews(f.project.id, [review.id])).retained[0].status, 'open', 'A failed primary deletion must be revalidated.');
});

test('closed-review checking locks account and project settings and rejects overlapping review actions', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  const get = f.client.getPullRequest.bind(f.client);
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.client.getPullRequest = async (...args) => { entered(); await pending; return get(...args); };
  const checking = f.service.checkClosedReview(review.id); await started;
  const overlap = await f.service.checkClosedReview(review.id);
  assert.equal(overlap.status, 'blocked'); assert.match(overlap.reason!, /current operation/);
  assert.equal((await f.service.removeClosedReviews(f.project.id, [review.id])).retained[0].status, 'blocked');
  await assert.rejects(() => f.service.disconnectConnection('bb'), /current integration operation/);
  await assert.rejects(() => f.service.configureProjectIntegration(f.project.id, f.settings), /current review operation/);
  release(); assert.equal((await checking).status, 'closed');
  assert.equal(f.reviews.getReview(review.id).id, review.id);
});

test('closed-review cleanup reconciles missing targets and externally merged branch-only work using exact closed PRs', async t => {
  const f = await fixture(t), review = await f.open();
  for (const value of f.live.values()) value.state = 'MERGED';
  const empty: RepositoryMapping = { relativePath: 'empty', workspace: 'team', repoSlug: 'empty' };
  await f.state.updateReview(review.id, binding => {
    binding.repositories = [root, child, empty].map(repository => ({ repository, sourceBranch: review.featureBranch, targetBranch: review.baseBranch,
      sourceHash: hash('a'), targetHash: hash('b'), mergeBaseHash: repository === empty ? hash('a') : hash('c'),
      status: 'unavailable', error: 'Target branch missing', ...(repository === root ? { prId: 7 } : {}) }));
  });
  f.client.getBranch = async () => null;
  const checked = await f.service.checkClosedReview(review.id);
  assert.equal(checked.status, 'closed');
  assert.deepEqual(checked.pullRequests.map(value => value.id), [7, 8]);
  const removed = await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true });
  assert.deepEqual(removed.removedIds, [review.id]);
  assert.equal(f.calls.localSnapshots, 0); assert.equal(f.calls.localInspections, 0);
  assert.equal(f.sent.length, 0); assert.deepEqual(f.comments, []);
});

test('automatic cleanup keeps deleted branch-only work until a matching closure or remote ancestry proves completion', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  await f.state.updateReview(review.id, binding => {
    binding.repositories = [{ repository: child, sourceBranch: review.featureBranch, targetBranch: review.baseBranch,
      sourceHash: hash('a'), targetHash: hash('b'), mergeBaseHash: hash('c'), status: 'unavailable', error: 'Branch missing' }];
  });
  f.client.getBranch = async () => null;
  // An open PR remains unfinished even if its source branch was deleted.
  assert.equal((await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true })).retained[0].status, 'blocked');
  f.live.get(`${child.relativePath}#8`)!.state = 'MERGED';
  f.live.get(`${child.relativePath}#8`)!.sourceHash = hash('d');
  assert.match((await f.service.checkClosedReview(review.id)).reason!, /captured changes have not been confirmed merged/);
  f.hooks.listError = new ProviderError('Permission denied', 403);
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'unavailable');
  f.hooks.listError = undefined;
  f.client.getBranch = async (_repo, name) => name === review.baseBranch ? { name, hash: hash('e') } : null;
  f.client.mergeBase = async (_repo, source, target) => { assert.equal(source, hash('a')); assert.equal(target, hash('e')); return source; };
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true })).removedIds, [review.id]);
});

test('a recreated source branch keeps a closed PR review even when cleanup previously recorded deletion', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  await f.state.updateReview(review.id, binding => {
    binding.repositories = [{ repository: root, sourceBranch: review.featureBranch, targetBranch: review.baseBranch,
      sourceHash: hash('a'), targetHash: hash('b'), mergeBaseHash: hash('c'), status: 'pull-request', prId: 7, cleanup: { state: 'deleted' } }];
  });
  f.client.getBranch = async (_repo, name) => ({ name, hash: hash('e') });
  const result = await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true });
  assert.deepEqual(result.removedIds, []); assert.match(result.retained[0].reason!, /different revision/);
});

test('refresh proposes automatic retirement without deleting drafts accepted before final removal', async t => {
  const f = await fixture(t);
  await f.service.configureProjectIntegration(f.project.id, { ...f.settings, repositories: [root] });
  const review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  f.client.getBranch = async () => null;
  const refreshed = await f.service.refreshReview(review.id);
  assert.equal(refreshed.closedReview?.status, 'closed');
  assert.equal(f.reviews.getReview(review.id).id, review.id, 'Refresh only proposes retirement so the renderer can flush pending feedback.');
  const withDraft = await f.service.addComment(review.id, { fileId: file.id, repoRelativePath: '.', path: file.path, side: 'additions',
    lineStart: 1, lineEnd: 1, body: 'Do not discard this pending draft', context: 'new', fingerprint: file.fingerprint });
  const retained = await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true });
  assert.deepEqual(retained.removedIds, []); assert.match(retained.retained[0].reason!, /unpublished feedback/);
  assert.equal((await f.service.refreshReview(review.id)).closedReview?.status, 'blocked');
  await f.service.deleteComment(review.id, withDraft.comments[0].id);
  const removed = await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true });
  assert.deepEqual(removed.removedIds, [review.id]);
  assert.equal(f.state.review(review.id), null);
});

test('automatic retirement rechecks reopened PRs and can reconcile paused cleanup after every branch disappears', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  const remote = await completedMerge(f, review.id);
  remote.operation!.state = 'paused'; remote.operation!.items[0].cleanup = 'unknown';
  remote.repositories = [{ repository: root, sourceBranch: review.featureBranch, targetBranch: review.baseBranch,
    sourceHash: hash('a'), targetHash: hash('b'), mergeBaseHash: hash('c'), status: 'pull-request', prId: 7, cleanup: { state: 'unknown' } }];
  await f.state.setReview(review.id, remote);
  f.client.getBranch = async () => null;
  assert.equal((await f.service.checkClosedReview(review.id)).status, 'closed');
  f.live.get('.#7')!.state = 'OPEN';
  assert.equal((await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true })).retained[0].status, 'open');
  f.live.get('.#7')!.state = 'MERGED';
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true })).removedIds, [review.id]);
});

test('automatic retirement keeps a replacement open PR even when its source hash matches the closed PR', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'DECLINED';
  f.live.set('.#9', pr(root, 9));
  const result = await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true });
  assert.deepEqual(result.removedIds, []);
  assert.match(result.retained[0].reason!, /PR for this branch is still open/);
  assert.equal(f.reviews.getReview(review.id).id, review.id);
});

test('stale open-list entries cannot keep a freshly confirmed closed PR active forever', async t => {
  const f = await fixture(t), review = await f.open();
  f.live.get('.#7')!.state = 'MERGED';
  f.client.findPullRequests = async () => [pr()];
  f.client.getBranch = async () => null;
  assert.deepEqual((await f.service.removeClosedReviews(f.project.id, [review.id], { automatic: true })).removedIds, [review.id]);
});
