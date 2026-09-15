import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConnectionManager, ProviderHttp, type ConnectionCredentials, type SecureStorage } from '../electron/connection-manager';
import { BitbucketClient } from '../electron/bitbucket-client';
import { buildRemoteRepositorySnapshot, buildRemoteSnapshot } from '../electron/remote-snapshot';
import { discoverRepositories, parseBitbucketRemote, validateRepositoryMappings } from '../electron/repository-mapping';
import type { BranchReviewRepository, RepositoryMapping } from '../shared/integrations';

const S = 'a'.repeat(40), D = 'b'.repeat(40), M = 'c'.repeat(40), CHILD = 'd'.repeat(40);
const mapping: RepositoryMapping = { relativePath: '.', workspace: 'team', repoSlug: 'repo' };
const credentials: ConnectionCredentials = { info: { id: 'bb', kind: 'bitbucket', label: 'Bitbucket', email: 'user@example.com', accountId: '{user}', displayName: 'User', storage: 'secure', connected: true }, email: 'user@example.com', token: 'very-private-token' };
const secure: SecureStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const rawPR = () => ({ id: 3, title: 'Review me', source: { branch: { name: 'feature/APP-123' }, commit: { hash: S }, repository: { uuid: '{11111111-1111-1111-1111-111111111111}', full_name: 'team/repo' } }, destination: { branch: { name: 'main', merge_strategies: ['merge_commit'] }, commit: { hash: D }, repository: { uuid: '{11111111-1111-1111-1111-111111111111}', full_name: 'team/repo' } }, author: { uuid: '{author}', display_name: 'Author' }, reviewers: [], participants: [], state: 'OPEN', links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/3' } } });

test('connections verify identity and encrypt tokens separately, then decrypt after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-connections-'));
  try {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => { calls.push(String(input)); assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('user@example.com:very-private-token').toString('base64')}`); return json({ uuid: '{user}', display_name: 'User' }); };
    const manager = new ConnectionManager(join(dir, 'connections.json'), secure, fetcher);
    const info = await manager.save({ kind: 'bitbucket', email: 'user@example.com', token: credentials.token });
    assert.equal(info.accountId, '{user}');
    assert.equal(info.storage, 'secure');
    assert.equal(info.connected, true);
    assert.ok(!JSON.stringify(manager.list()).includes(credentials.token));
    assert.ok(!(await readFile(join(dir, 'connections.json'), 'utf8')).includes(credentials.token));
    const reopened = new ConnectionManager(join(dir, 'connections.json'), secure, fetcher);
    await reopened.load();
    assert.equal(reopened.credentials(info.id).token, credentials.token);
    assert.equal((await reopened.test(info.id)).id, info.id);
    await reopened.disconnect(info.id);
    assert.deepEqual(reopened.list(), [{ ...info, connected: false }]);
    assert.throws(() => reopened.credentials(info.id), /Reconnect/);
    const disconnected = JSON.parse(await readFile(join(dir, 'connections.json'), 'utf8'));
    assert.equal(disconnected.connections[0].encryptedToken, undefined);
    const afterDisconnect = new ConnectionManager(join(dir, 'connections.json'), secure, fetcher);
    await afterDisconnect.load();
    assert.equal(afterDisconnect.list()[0].connected, false);
    assert.equal((await afterDisconnect.save({ id: info.id, kind: 'bitbucket', email: info.email, token: credentials.token })).id, info.id);
    assert.equal(afterDisconnect.list()[0].connected, true);
    assert.equal(calls.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('basic_text storage keeps tokens in session only and disconnected identities require reconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-session-connections-'));
  try {
    const storage = { ...secure, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw new Error('must not encrypt'); } };
    const fetcher: typeof fetch = async () => json({ uuid: '{user}', display_name: 'User' });
    const manager = new ConnectionManager(join(dir, 'connections.json'), storage, fetcher);
    const info = await manager.save({ kind: 'bitbucket', email: 'user@example.com', token: credentials.token });
    assert.equal(info.storage, 'session');
    assert.equal(manager.credentials(info.id).token, credentials.token);
    const saved = await readFile(join(dir, 'connections.json'), 'utf8');
    assert.ok(!saved.includes(credentials.token)); assert.ok(!saved.includes('encryptedToken'));
    const reopened = new ConnectionManager(join(dir, 'connections.json'), storage, fetcher);
    await reopened.load();
    assert.throws(() => reopened.credentials(info.id), /Reconnect/);
    assert.equal(reopened.list()[0].connected, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('replacing credentials cannot switch the verified account or Jira environment behind existing reviews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-connection-identity-'));
  try {
    let account = 'original'; let cloud = 'cloud-one';
    const manager = new ConnectionManager(join(dir, 'connections.json'), secure, async input => String(input).includes('_edge') ? json({ cloudId: cloud }) : json({ accountId: account, displayName: 'User', active: true }));
    const input = { kind: 'jira' as const, siteUrl: 'https://team.atlassian.net', email: 'user@example.com', token: credentials.token };
    const info = await manager.save(input);
    account = 'someone-else';
    await assert.rejects(() => manager.save({ ...input, id: info.id, token: 'replacement-token' }), /different account/);
    assert.equal(manager.credentials(info.id).token, credentials.token);
    await assert.rejects(() => manager.save({ ...input, id: info.id, siteUrl: 'https://other.atlassian.net' }), /different Jira site/);
    account = 'original'; cloud = 'cloud-two';
    await assert.rejects(() => manager.save({ ...input, id: info.id }), /different Cloud environment/);
    assert.equal(manager.credentials(info.id).info.cloudId, 'cloud-one');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('keychain failures retain reconnectable identity and use session-only tokens without plaintext persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-keychain-failure-'));
  try {
    const path = join(dir, 'connections.json');
    const fetcher: typeof fetch = async () => json({ uuid: '{user}', display_name: 'User' });
    const original = new ConnectionManager(path, secure, fetcher);
    const info = await original.save({ kind: 'bitbucket', email: 'user@example.com', token: credentials.token });
    const unavailableStorage: SecureStorage = { ...secure, decryptString: () => { throw new Error('Keychain locked'); }, encryptString: () => { throw new Error('Keychain locked'); } };
    const reopened = new ConnectionManager(path, unavailableStorage, fetcher);
    await reopened.load();
    assert.equal(reopened.list()[0].id, info.id);
    assert.equal(reopened.list()[0].connected, false);
    assert.throws(() => reopened.credentials(info.id), /Reconnect/);
    const replacement = await reopened.save({ id: info.id, kind: 'bitbucket', email: info.email, token: 'new-session-private-token' });
    assert.equal(replacement.connected, true); assert.equal(replacement.storage, 'session');
    assert.equal(reopened.credentials(info.id).token, 'new-session-private-token');
    const content = await readFile(path, 'utf8');
    assert.ok(!content.includes('new-session-private-token'));
    assert.ok(!content.includes('encryptedToken'));
    const restart = new ConnectionManager(path, secure, fetcher); await restart.load();
    assert.equal(restart.list()[0].connected, false);
    assert.equal(restart.list()[0].id, info.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scoped Jira token uses tenant discovery without credentials and api.atlassian.com for identity and issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-jira-provider-'));
  try {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); requests.push(url);
      if (url === 'https://team.atlassian.net/_edge/tenant_info') { assert.equal(new Headers(init?.headers).has('Authorization'), false); return json({ cloudId: 'cloud-123' }); }
      assert.ok(url.startsWith('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/'));
      assert.ok(new Headers(init?.headers).get('Authorization')?.startsWith('Basic '));
      return url.endsWith('/myself') ? json({ accountId: 'jira-account', displayName: 'Jira User', active: true }) : json({ key: 'APP-123', fields: { summary: 'Ticket title', description: { type: 'doc', version: 1, content: [] } } });
    };
    const manager = new ConnectionManager(join(dir, 'connections.json'), secure, fetcher);
    const info = await manager.save({ kind: 'jira', siteUrl: 'https://team.atlassian.net/', email: 'user@example.com', token: credentials.token });
    const issue = await manager.getIssue(info.id, 'app-123');
    assert.equal(issue.title, 'Ticket title'); assert.equal(issue.url, 'https://team.atlassian.net/browse/APP-123');
    assert.equal(requests.length, 3);
    await assert.rejects(() => manager.getIssue(info.id, 'APP-123/../../myself'), /ticket key/);
    await assert.rejects(() => manager.save({ kind: 'jira', siteUrl: 'https://team.atlassian.net.attacker.example', email: 'user@example.com', token: credentials.token }), /Jira Cloud/);
    assert.equal(requests.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('authenticated redirects and cross-origin pagination do not forward credentials; 429 sets a retry deadline', async () => {
  let requests = 0;
  const http = new ProviderHttp(async (_input, init) => { requests++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } }); }, 'https://api.bitbucket.org', 'Basic secret');
  await assert.rejects(() => http.json('/2.0/user'), /redirected/);
  await assert.rejects(() => http.json('https://attacker.example/next'), /unsafe/);
  assert.equal(requests, 1);
  const limited = new ProviderHttp(async () => { requests++; return json({}, 429, { 'Retry-After': '60' }); }, 'https://api.bitbucket.org');
  await assert.rejects(() => limited.json('/2.0/user'), /request limit/);
  await assert.rejects(() => limited.json('/2.0/user'), /rate limited/);
  assert.equal(requests, 2);
  const client = new BitbucketClient(credentials, async () => json({ values: [], next: 'https://attacker.example/next' }));
  await assert.rejects(() => client.pages('/2.0/repositories'), /unsafe/);
});

test('Bitbucket merges request a normal merge and source cleanup, then handle asynchronous progress', async () => {
  const sent: any[] = [];
  const client = new BitbucketClient(credentials, async (input, init) => {
    sent.push({ url: String(input), method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
    if (String(input).endsWith('/merge')) return json({ task_id: 'task-123' }, 202);
    if (String(input).endsWith('/merge/task-status/task-123')) return json({ task_status: 'SUCCESS' });
    return new Response(null, { status: 404 });
  });
  const pr = client.normalizePullRequest(mapping, rawPR());
  assert.deepEqual(await client.merge(pr), { taskId: 'task-123' });
  assert.deepEqual(sent[0].body, { type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: true });
  assert.deepEqual(await client.mergeStatus(pr, 'task-123'), { state: 'success' });
  assert.equal(await client.branchExists(pr), false);
  const fork = rawPR(); fork.source.repository.uuid = '{fork}';
  assert.throws(() => client.normalizePullRequest(mapping, fork), /forks/);
});

test('branch reads validate repository identity, preserve encoded branch names and resolve captured abbreviated commits', async () => {
  const requests: string[] = [];
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname === '/2.0/repositories/team/repo') return json({ full_name: 'team/repo', uuid: '{11111111-1111-1111-1111-111111111111}', mainbranch: { name: 'main' } });
    if (url.pathname.endsWith('/refs/branches/feature%2FAPP-123')) return json({ name: 'feature/APP-123', target: { hash: S.slice(0, 12) } });
    if (url.pathname.endsWith(`/commit/${S.slice(0, 12)}`)) return json({ hash: S });
    if (url.pathname.includes('/merge-base/')) return json({ hash: M });
    return json({}, 404);
  });
  assert.deepEqual(await client.getRepository({ ...mapping, uuid: '{11111111-1111-1111-1111-111111111111}' }), { defaultBranch: 'main' });
  assert.deepEqual(await client.getBranch(mapping, 'feature/APP-123'), { name: 'feature/APP-123', hash: S });
  assert.equal(await client.getBranch(mapping, 'missing'), null);
  assert.equal(await client.mergeBase(mapping, S, D), M);
  assert.ok(requests.some(path => path.endsWith(`/commit/${S.slice(0, 12)}`)));
  await assert.rejects(() => client.getRepository({ ...mapping, uuid: '{22222222-2222-2222-2222-222222222222}' }), /different or incomplete repository/);
  for (const name of ['', '..', '../main', 'main\n', '/main']) await assert.rejects(() => client.getBranch(mapping, name), /valid branch/);
  const invalid = new BitbucketClient(credentials, async () => json({ full_name: 'other/repo', mainbranch: { name: 'main' } }));
  await assert.rejects(() => invalid.getRepository(mapping), /different or incomplete repository/);
});

test('incomplete branch responses and commit lookup failures never masquerade as missing branches', async () => {
  for (const value of [{ name: 'other', target: { hash: S } }, { name: 'main' }, { name: 'main', target: { hash: 'invalid' } }]) {
    const client = new BitbucketClient(credentials, async () => json(value));
    await assert.rejects(() => client.getBranch(mapping, 'main'), /incomplete branch|invalid captured commit/);
  }
  for (const response of [json({}, 404), json({ hash: D })]) {
    const client = new BitbucketClient(credentials, async input => String(input).includes('/refs/branches/') ? json({ name: 'main', target: { hash: S.slice(0, 12) } }) : response);
    await assert.rejects(() => client.getBranch(mapping, 'main'));
  }
  for (const status of [401, 403, 500]) {
    const client = new BitbucketClient(credentials, async () => json({}, status));
    await assert.rejects(() => client.getBranch(mapping, 'main'), error => (error as { status?: number }).status === status);
  }
});

test('branch PR discovery escapes the source filter, paginates and preserves divergent targets', async () => {
  const sourceBranch = 'feature/quoted"branch';
  const one = rawPR(); one.source.branch.name = sourceBranch;
  const two = rawPR(); two.id = 4; two.source.branch.name = sourceBranch; two.destination.branch.name = 'release';
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('q'), `source.branch.name=${JSON.stringify(sourceBranch)}`);
    assert.deepEqual(url.searchParams.getAll('state'), ['OPEN', 'MERGED']);
    if (url.searchParams.get('page') === '2') return json({ values: [two] });
    url.searchParams.set('page', '2'); return json({ values: [one], next: url.href });
  });
  const found = await client.findPullRequests(mapping, sourceBranch, ['OPEN', 'MERGED']);
  assert.deepEqual(found.map(pr => pr.targetBranch), ['main', 'release']);
  const wrongBranch = new BitbucketClient(credentials, async () => json({ values: [rawPR()] }));
  await assert.rejects(() => wrongBranch.findPullRequests(mapping, sourceBranch), /outside the requested branch/);
});

test('explicit PR creation sends native branches and cleanup intent and validates the returned identity', async () => {
  const sent: any[] = [];
  const client = new BitbucketClient(credentials, async (input, init) => { sent.push({ path: new URL(String(input)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) }); return json(rawPR(), 201); });
  const input = { sourceBranch: 'feature/APP-123', targetBranch: 'main', title: 'Review me', description: 'Branchline review reference' };
  const result = await client.createPullRequest(mapping, input);
  assert.equal(result.id, 3);
  assert.deepEqual(sent, [{ path: '/2.0/repositories/team/repo/pullrequests', method: 'POST', body: { title: input.title, description: input.description, source: { branch: { name: input.sourceBranch } }, destination: { branch: { name: input.targetBranch } }, close_source_branch: true } }]);
  const changed = rawPR(); changed.destination.branch.name = 'release';
  const wrong = new BitbucketClient(credentials, async () => json(changed, 201));
  await assert.rejects(() => wrong.createPullRequest(mapping, input), /different branch pair/);
  const short = rawPR(); short.source.commit.hash = S.slice(0, 12);
  const unresolved = new BitbucketClient(credentials, async (_input, init) => init?.method === 'POST' ? json(short, 201) : json({}, 403));
  await assert.rejects(() => unresolved.createPullRequest(mapping, input), error => { assert.equal((error as { status?: number }).status, undefined); assert.match((error as Error).message, /accepted PR creation/); return true; });
});

test('comments preserve inline ranges and map remote identity/resolution', async () => {
  let sent: any;
  const client = new BitbucketClient(credentials, async (_input, init) => { sent = JSON.parse(String(init?.body)); return json({ id: 12, user: { uuid: '{user}' }, content: sent.content, inline: sent.inline, resolution: null }); });
  const pr = client.normalizePullRequest(mapping, rawPR());
  const comment = await client.createComment(pr, { content: { raw: 'Please change this.' }, inline: { path: 'src/a.ts', start_to: 2, to: 5 } });
  assert.equal(comment.authorId, '{user}'); assert.equal(comment.startTo, 2); assert.equal(comment.to, 5); assert.equal(comment.resolved, false);
  assert.deepEqual(sent.inline, { path: 'src/a.ts', start_to: 2, to: 5 });
});

test('merge status read failures preserve uncertainty instead of permitting a blind merge retry', async () => {
  for (const status of [403, 409, 500]) {
    const client = new BitbucketClient(credentials, async () => json({}, status));
    const pr = client.normalizePullRequest(mapping, rawPR());
    await assert.rejects(() => client.mergeStatus(pr, 'accepted-task'), error => (error as { status?: number }).status === status);
  }
  const unknown = new BitbucketClient(credentials, async () => json({ task_status: 'NEW_STATE' }));
  await assert.rejects(() => unknown.mergeStatus(unknown.normalizePullRequest(mapping, rawPR()), 'task'), /unrecognized/);
  const failed = new BitbucketClient(credentials, async () => json({}, 400));
  assert.equal((await failed.mergeStatus(failed.normalizePullRequest(mapping, rawPR()), 'task')).state, 'failed');
});

test('mixed fork inbox preserves supported PRs and missing merge strategy expands the destination branch', async () => {
  const regular = rawPR(); const fork = rawPR(); fork.id = 4; fork.source.repository.uuid = '{fork}';
  const urls: string[] = [];
  const client = new BitbucketClient(credentials, async input => {
    const url = String(input); urls.push(url);
    if (url.includes('?state=OPEN')) return json({ values: [regular, fork] });
    if (url.endsWith('/pullrequests/3')) { const value: any = rawPR(); delete value.destination.branch.merge_strategies; return json(value); }
    if (url.endsWith('/refs/branches/main')) return json({ name: 'main', merge_strategies: ['merge_commit', 'squash'] });
    if (url.includes('/statuses')) return json({ values: [] });
    return json(fork);
  });
  const listed = await client.listPullRequests(mapping);
  assert.equal(listed.length, 2); assert.equal(listed[0].id, 3);
  assert.match((listed[1] as any).unsupportedReason, /forks/);
  const pr = await client.getPullRequest(mapping, 3);
  assert.deepEqual(pr.mergeStrategies, ['merge_commit', 'squash']);
  assert.ok(urls.some(url => url.endsWith('/refs/branches/main')));
  await assert.rejects(() => client.getPullRequest(mapping, 4), /forks/);
});

test('Bitbucket abbreviated PR commits resolve by captured IDs for inbox and detail without a cross-refresh cache', async () => {
  const requests: string[] = [];
  const shortened = () => { const pr = rawPR(); pr.source.commit.hash = S.slice(0, 12); pr.destination.commit.hash = D.slice(0, 12); return pr; };
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith('/pullrequests')) return json({ values: [shortened(), { ...shortened(), id: 4 }] });
    if (url.pathname.endsWith('/pullrequests/3')) return json(shortened());
    if (url.pathname.endsWith(`/commit/${S.slice(0, 12)}`)) return json({ hash: S });
    if (url.pathname.endsWith(`/commit/${D.slice(0, 12)}`)) return json({ hash: D });
    if (url.pathname.endsWith('/statuses')) return json({ values: [] });
    throw new Error('Unexpected request');
  });
  const inbox = await client.listPullRequests(mapping);
  assert.equal(inbox.length, 2);
  for (const pr of inbox) { assert.equal(pr.sourceHash, S); assert.equal(pr.targetHash, D); }
  assert.equal(requests.filter(url => /\/commit\/[a-f0-9]+$/.test(url)).length, 2, 'one immutable lookup per captured ID in a list');
  const detail = await client.getPullRequest(mapping, 3);
  assert.equal(detail.sourceHash, S); assert.equal(detail.targetHash, D);
  assert.equal(requests.filter(url => /\/commit\/[a-f0-9]+$/.test(url)).length, 4, 'a later detail read resolves again');
  await client.listPullRequests(mapping);
  assert.equal(requests.filter(url => /\/commit\/[a-f0-9]+$/.test(url)).length, 6, 'a later refresh cannot reuse a formerly unambiguous prefix');
  assert.ok(!requests.some(url => /\/refs\//.test(url)), 'commit resolution never reads a movable branch');
  assert.throws(() => client.normalizePullRequest(mapping, shortened()), /source\.commit\.hash.*12 characters.*destination\.commit\.hash.*12 characters/);
});

test('fully qualified PR commits do not trigger additional commit resolution reads', async () => {
  const requests: string[] = [];
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith('/pullrequests')) return json({ values: [rawPR()] });
    if (url.pathname.endsWith('/pullrequests/3')) return json(rawPR());
    if (url.pathname.endsWith('/statuses')) return json({ values: [] });
    throw new Error('Unexpected request');
  });
  await client.listPullRequests(mapping); await client.getPullRequest(mapping, 3);
  assert.ok(!requests.some(url => /\/commit\/[a-f0-9]+$/.test(url)));
});

test('abbreviated fork rows remain disabled without resolving their source in the destination repository', async () => {
  const fork = rawPR(); fork.id = 4; fork.source.repository.uuid = '{fork}'; fork.source.commit.hash = 'd'.repeat(12); fork.destination.commit.hash = D.slice(0, 12);
  const requests: string[] = [];
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    return url.pathname.endsWith('/pullrequests') ? json({ values: [rawPR(), fork] }) : json(fork);
  });
  const listed = await client.listPullRequests(mapping);
  assert.equal(listed.length, 2); assert.equal(listed[0].sourceHash, S); assert.match(listed[1].unsupportedReason!, /forks/);
  await assert.rejects(() => client.getPullRequest(mapping, 4), /forks/);
  assert.ok(!requests.some(url => url.includes('/commit/')));
});

test('abbreviated commit resolution rejects missing, malformed, mismatched, and inaccessible commit identities', async () => {
  const pr = rawPR(); pr.source.commit.hash = S.slice(0, 12);
  for (const response of [{}, { hash: 'not-a-hash' }, { hash: S.slice(0, 12) }, { hash: D }]) {
    const client = new BitbucketClient(credentials, async input => new URL(String(input)).pathname.endsWith('/pullrequests/3') ? json(pr) : json(response));
    await assert.rejects(() => client.getPullRequest(mapping, 3), /team\/repo PR #3: source\.commit\.hash.*full hash matching the captured abbreviated ID/);
  }
  for (const status of [403, 404, 409]) {
    const client = new BitbucketClient(credentials, async input => new URL(String(input)).pathname.endsWith('/pullrequests/3') ? json(pr) : json({}, status));
    await assert.rejects(() => client.getPullRequest(mapping, 3), error => {
      assert.match((error as Error).message, /Could not resolve source\.commit\.hash for team\/repo PR #3/);
      assert.equal((error as { status?: number }).status, status);
      return true;
    });
  }
});

test('invalid PR fields expose shape details without returning private response values', async () => {
  const value: any = rawPR(); value.title = { secret: 'private-title' }; value.source.commit.hash = 'private-secret'; delete value.destination.branch.name;
  const client = new BitbucketClient(credentials, async () => json({ values: [value] }));
  await assert.rejects(() => client.listPullRequests(mapping), error => {
    const message = (error as Error).message;
    assert.match(message, /team\/repo PR #3/);
    assert.match(message, /title \(object; invalid type\)/);
    assert.match(message, /source\.commit\.hash \(string, 14 characters; invalid format\)/);
    assert.match(message, /destination\.branch\.name \(missing; missing\)/);
    assert.match(message, /Settings → Diagnostics/);
    assert.ok(!message.includes('private-title')); assert.ok(!message.includes('private-secret'));
    return true;
  });
});

test('synchronous merged PR responses retain actual full merge-result commits', async () => {
  const requests: string[] = [];
  const client = new BitbucketClient(credentials, async input => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith('/merge')) return json({ ...rawPR(), state: 'MERGED', merge_commit: { hash: M.slice(0, 12) } });
    if (url.pathname.endsWith(`/commit/${M.slice(0, 12)}`)) return json({ hash: M });
    throw new Error('Unexpected request');
  });
  const result = await client.merge(client.normalizePullRequest(mapping, rawPR()));
  assert.equal(result.pr?.state, 'MERGED'); assert.equal(result.pr?.mergeCommit, M);
  assert.equal(requests.length, 2);
});

test('commit lookup failures after an accepted merge preserve uncertain delivery', async () => {
  const client = new BitbucketClient(credentials, async input => new URL(String(input)).pathname.endsWith('/merge')
    ? json({ ...rawPR(), state: 'MERGED', merge_commit: { hash: M.slice(0, 12) } }) : json({}, 403));
  await assert.rejects(() => client.merge(client.normalizePullRequest(mapping, rawPR())), error => {
    assert.equal((error as { status?: number }).status, undefined, 'the later read rejection does not prove the merge was rejected');
    assert.match((error as Error).message, /HTTP 403/);
    assert.match((error as Error).message, /Bitbucket accepted the merge; refresh to reconcile/);
    return true;
  });
});

function snapshotClient(options: { move?: boolean; lfs?: boolean; large?: boolean; pointer?: boolean; missingSide?: boolean; noContent?: boolean; emptyContent?: boolean } = {}) {
  const requests: string[] = [];
  let prReads = 0;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url.href);
    if (url.pathname.endsWith('/pullrequests/3')) { const pr = rawPR(); if (options.move && ++prReads > 1) pr.source.commit.hash = 'e'.repeat(40); return json(pr); }
    if (url.pathname.includes('/statuses')) return json({ values: [] });
    if (url.pathname.includes('/merge-base/')) return json({ hash: M });
    if (url.pathname.includes('/diffstat/')) {
      assert.ok(url.pathname.endsWith(`${S}..${M}`)); assert.equal(url.searchParams.get('topic'), 'false');
      return json({ values: [{ status: 'renamed', lines_added: 1, lines_removed: 1, old: options.missingSide ? undefined : { path: 'old name.txt' }, new: { path: 'new name.txt' } }] });
    }
    const path = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (url.searchParams.get('format') === 'meta') return json({ type: 'commit_file', path, size: options.large ? 2 * 1024 * 1024 : url.pathname.includes(M) ? 9 : 8, attributes: options.pointer ? ['subrepository'] : [] });
    if (options.noContent) return new Response(null, { status: 204 });
    if (options.emptyContent) return new Response('');
    if (options.lfs) return new Response(null, { status: 301, headers: { Location: 'https://media.example/object' } });
    if (options.large) return new Response('oversize', { headers: { 'content-length': String(2 * 1024 * 1024), etag: 'large-object' } });
    return new Response(options.pointer ? url.pathname.includes(M) ? D : CHILD : url.pathname.includes(M) ? 'original\n' : 'changed\n', { headers: { etag: url.pathname.includes(M) ? 'old-content' : 'new-content' } });
  };
  const client = new BitbucketClient(credentials, fetcher);
  return { client, pr: client.normalizePullRequest(mapping, rawPR()), requests };
}

test('remote snapshots use exact merge-base file pairs, preserve rename paths and content fingerprints', async () => {
  const { client, pr, requests } = snapshotClient();
  const first = await buildRemoteSnapshot(client, 'review', [pr]);
  assert.deepEqual(first.snapshot.warnings, []);
  const file = first.snapshot.files[0];
  assert.equal(file.oldPath, 'old name.txt'); assert.equal(file.path, 'new name.txt');
  assert.equal(file.oldContent, 'original\n'); assert.equal(file.newContent, 'changed\n');
  assert.equal(file.baseCommit, M); assert.equal(file.headCommit, S);
  assert.equal(first.pullRequests[0].mergeBaseHash, M);
  assert.ok(requests.some(url => url.includes(`/src/${M}/old%20name.txt`)));
  assert.ok(requests.some(url => url.includes(`/src/${S}/new%20name.txt`)));
  assert.ok(!requests.some(url => /\/src\/(main|feature)/.test(url)));
  const reads = requests.filter(url => url.includes('/src/')).length;
  const second = await buildRemoteSnapshot(client, 'review', [pr]);
  assert.equal(second.snapshot.files[0].fingerprint, file.fingerprint);
  assert.equal(requests.filter(url => url.includes('/src/')).length, reads, 'immutable file bodies and metadata are cached');
});

test('missing diff sides and incomplete file bodies never become empty reviewed content', async () => {
  for (const options of [{ missingSide: true }, { noContent: true }, { emptyContent: true }]) {
    const { client, pr } = snapshotClient(options);
    const { snapshot } = await buildRemoteSnapshot(client, 'review', [pr]);
    assert.ok(snapshot.repos[0].error, 'the repository must remain incomplete');
    assert.ok(snapshot.files.length === 0 || snapshot.files.every(file => !!file.unavailable));
    assert.ok(!snapshot.files.some(file => file.oldContent === '' || file.newContent === ''));
  }
});

test('remote snapshots never silently approve an LFS/incomplete response or a moving head', async () => {
  for (const options of [{ lfs: true }, { move: true }]) {
    const { client, pr, requests } = snapshotClient(options);
    const { snapshot } = await buildRemoteSnapshot(client, 'review', [pr]);
    assert.ok(snapshot.repos[0].error);
    assert.ok(snapshot.warnings.length);
    if (options.lfs) { assert.match(snapshot.files[0].unavailable ?? '', /LFS/); assert.ok(!requests.some(url => url.includes('media.example'))); }
    if (options.move) assert.equal(snapshot.files.length, 0);
  }
});

test('large files stay metadata-only and gitlinks avoid combined-tree file/directory collisions', async () => {
  const large = snapshotClient({ large: true });
  const file = (await buildRemoteSnapshot(large.client, 'review', [large.pr])).snapshot.files[0];
  assert.equal(file.tooLarge, true); assert.equal(file.oldContent, null); assert.equal(file.newContent, null);
  const pointer = snapshotClient({ pointer: true });
  const snapshot = (await buildRemoteSnapshot(pointer.client, 'review', [pointer.pr])).snapshot;
  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.repos[0].pointers, [{ path: 'new name.txt', oldHash: D, newHash: CHILD }]);
});

function branchSnapshotClient(options: { move?: string; missing?: string; failed?: string; empty?: boolean; historical?: boolean } = {}) {
  const child: RepositoryMapping = { relativePath: 'packages/core', workspace: 'team', repoSlug: 'core' };
  const empty: RepositoryMapping = { relativePath: 'packages/empty', workspace: 'team', repoSlug: 'empty' };
  const missing: RepositoryMapping = { relativePath: 'packages/missing', workspace: 'team', repoSlug: 'missing' };
  const requests: string[] = [];
  const branch = 'feature/APP-123';
  const client = new BitbucketClient(credentials, async (input, init) => {
    assert.ok(!init?.method || init.method === 'GET', 'opening a review cannot create PRs, comments or branches');
    const url = new URL(String(input)); requests.push(url.href);
    const slug = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/pullrequests/3')) {
      const pr = rawPR();
      if (options.historical) { pr.state = 'MERGED'; pr.destination.commit.hash = 'f'.repeat(40); }
      return json(pr);
    }
    if (url.pathname.includes('/statuses')) return json({ values: [] });
    if (url.pathname.includes('/refs/branches/')) {
      const name = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (slug === options.failed) return json({}, 403);
      if (name === branch && (slug === 'missing' && options.move !== 'missing' || slug === options.missing || slug === 'repo' && options.historical)) return json({}, 404);
      return json({ name, target: { hash: name === 'main' ? D : slug === options.move ? CHILD : slug === 'empty' ? D : S } });
    }
    if (url.pathname.includes('/merge-base/')) return json({ hash: slug === 'empty' ? D : M });
    if (url.pathname.includes('/diffstat/')) {
      if (slug === 'empty' || options.empty) return json({ values: [] });
      return json({ values: [{ status: 'renamed', lines_added: 1, lines_removed: 1, old: { path: 'old.txt' }, new: { path: 'new.txt' } }] });
    }
    const path = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (url.searchParams.get('format') === 'meta') return json({ type: 'commit_file', path, size: url.pathname.includes(M) ? 9 : 8, attributes: [] });
    return new Response(url.pathname.includes(M) ? 'original\n' : 'changed\n');
  });
  const pr = client.normalizePullRequest(mapping, rawPR());
  if (options.historical) pr.state = 'MERGED';
  const rows: BranchReviewRepository[] = [
    { repository: mapping, sourceBranch: branch, targetBranch: 'main', sourceHash: S, targetHash: D, mergeBaseHash: M, prId: 3, status: 'pull-request' },
    { repository: child, sourceBranch: branch, targetBranch: 'main', sourceHash: S, targetHash: D, mergeBaseHash: M, status: 'changes' },
    { repository: empty, sourceBranch: branch, targetBranch: 'main', sourceHash: D, targetHash: D, mergeBaseHash: D, status: 'no-changes' },
    { repository: missing, sourceBranch: branch, targetBranch: 'main', targetHash: D, status: 'missing-branch' },
  ];
  return { client, pr, rows, requests };
}

test('branch snapshots include repositories without PRs with exact rename paths and explicit empty or missing status', async () => {
  const { client, pr, rows, requests } = branchSnapshotClient();
  const { snapshot, pullRequests, repositories } = await buildRemoteSnapshot(client, 'branch-review', [pr], rows);
  assert.deepEqual(snapshot.files.map(file => file.id), ['new.txt', 'packages/core/new.txt']);
  assert.deepEqual(snapshot.files.map(file => file.oldPath), ['old.txt', 'old.txt']);
  assert.equal(snapshot.files[1].newContent, 'changed\n');
  assert.equal(snapshot.files[1].baseCommit, M); assert.equal(snapshot.files[1].headCommit, S);
  assert.equal(pullRequests.length, 1, 'no synthetic PR IDs are introduced');
  assert.deepEqual(repositories?.map(row => row.status), ['pull-request', 'changes', 'no-changes', 'missing-branch']);
  assert.ok(snapshot.repos.every(repo => !repo.error), 'a branch that never existed is not an incomplete download');
  assert.match(snapshot.warnings[0], /Source branch feature\/APP-123 does not exist/);
  assert.ok(requests.some(url => url.includes('/core/src/')));
  assert.ok(requests.some(url => url.includes('/empty/refs/branches/feature%2FAPP-123')), 'empty branches are rechecked too');
  assert.ok(!requests.some(url => /\/core\/pullrequests\//.test(url)));
});

test('a single captured repository without a PR becomes reviewable independently of its starter PR', async () => {
  const { client, rows, requests } = branchSnapshotClient();
  const result = await buildRemoteRepositorySnapshot(client, 'branch-review', rows[1]);
  assert.deepEqual(result.snapshot.files.map(file => file.id), ['packages/core/new.txt']);
  assert.deepEqual(result.snapshot.repos.map(repo => repo.relativePath), ['packages/core']);
  assert.deepEqual(result.pullRequests, []);
  assert.equal(result.repositories![0].status, 'changes');
  assert.ok(!requests.some(url => url.includes('/repo/') || url.includes('/pullrequests/')));
  assert.equal(result.snapshot.files[0].oldContent, 'original\n');
  assert.equal(result.snapshot.files[0].newContent, 'changed\n');
});

test('whole-group snapshot downloads run concurrently with four repository pipelines and stable output order', { timeout: 10000 }, async () => {
  const { client, rows } = branchSnapshotClient();
  const input = Array.from({ length: 6 }, (_, index): BranchReviewRepository => ({ ...rows[1], repository: { relativePath: `repo${index}`, workspace: 'team', repoSlug: `repo${index}` } }));
  let release!: () => void, fourStarted!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { fourStarted = resolve; });
  const requests: string[] = [];
  const pages = client.pages.bind(client);
  client.pages = async path => {
    if (path.includes('/diffstat/')) { requests.push(path); if (requests.length === 4) fourStarted(); await hold; }
    return pages(path);
  };
  const task = buildRemoteSnapshot(client, 'branch-review', [], input);
  try {
    await started;
    assert.equal(requests.length, 4, 'a slow repository does not serialize other repository downloads');
  } finally { release(); }
  const result = await task;
  assert.equal(requests.length, 6);
  assert.equal(result.snapshot.files.length, 6);
  assert.ok(result.snapshot.repos.every(repo => !repo.error));
  assert.deepEqual(result.repositories!.map(row => row.repository.relativePath), input.map(row => row.repository.relativePath));
});

test('new pushes, newly appearing branches, disappeared branches and denied branch reads remain explicit blockers', async () => {
  for (const options of [{ move: 'core' }, { move: 'empty' }, { move: 'missing' }, { missing: 'core' }, { failed: 'core' }]) {
    const { client, pr, rows } = branchSnapshotClient(options);
    const { snapshot, repositories } = await buildRemoteSnapshot(client, 'branch-review', [pr], rows);
    const slug = options.move ?? options.missing ?? options.failed;
    const row = repositories!.find(item => item.repository.repoSlug === slug)!;
    assert.equal(row.status, 'unavailable');
    assert.ok(row.error);
    assert.ok(snapshot.repos.find(repo => repo.relativePath === row.repository.relativePath)?.error);
    assert.ok(!snapshot.files.some(file => file.repoRelativePath === row.repository.relativePath), 'a stale repository never contributes reviewable file pairs');
  }
});

test('merged PR snapshots retain captured history after deletion while no-file unique commits still require merging', async () => {
  const historical = branchSnapshotClient({ historical: true });
  const result = await buildRemoteSnapshot(historical.client, 'branch-review', [historical.pr], historical.rows);
  assert.equal(result.snapshot.repos[0].error, undefined);
  assert.equal(result.pullRequests[0].targetHash, D, 'the merged destination tip must not replace the reviewed comparison');
  assert.ok(!historical.requests.some(url => url.includes('/repo/refs/branches/')), 'a deleted merged source need not exist');
  const empty = branchSnapshotClient({ empty: true });
  const resultEmpty = await buildRemoteSnapshot(empty.client, 'branch-review', [empty.pr], empty.rows);
  assert.equal(resultEmpty.repositories![1].status, 'changes', 'unique empty commits still participate in merge');
  assert.deepEqual(resultEmpty.snapshot.files, []);
});

test('remote mapping accepts Cloud SSH/HTTPS remotes and rejects traversal or duplicate repositories', () => {
  assert.deepEqual(parseBitbucketRemote('git@bitbucket.org:team/repo.git'), { workspace: 'team', repoSlug: 'repo' });
  assert.deepEqual(parseBitbucketRemote('https://user:private@bitbucket.org/team/repo.git'), { workspace: 'team', repoSlug: 'repo' });
  assert.equal(parseBitbucketRemote('https://bitbucket.org.attacker.example/team/repo.git'), null);
  assert.throws(() => validateRepositoryMappings([{ ...mapping, relativePath: '../escape' }]), /safe relative/);
  assert.throws(() => validateRepositoryMappings([mapping, { ...mapping, relativePath: 'child' }]), /only.*once/);
  assert.throws(() => validateRepositoryMappings([{ ...mapping, relativePath: 'child', parentRelativePath: 'other', submodulePath: 'child' }]), /parent/);
});

test('repository discovery reads remotes without changing refs, index, or worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-discover-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    await writeFile(join(dir, 'a.txt'), 'hello\n'); git('add', 'a.txt'); git('commit', '-qm', 'initial'); git('remote', 'add', 'origin', 'git@bitbucket.org:team/repo.git');
    const before = git('rev-parse', 'HEAD'); const index = await readFile(join(dir, '.git/index'));
    assert.deepEqual(await discoverRepositories(dir), [mapping]);
    assert.equal(git('rev-parse', 'HEAD'), before); assert.deepEqual(await readFile(join(dir, '.git/index')), index); assert.equal(git('status', '--porcelain'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
