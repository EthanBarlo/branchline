import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager, ProviderError, type SecureStorage } from '../electron/integrations/connection-manager';

const storage: SecureStorage = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Session only'); }, decryptString: () => { throw new Error('Session only'); } };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const option = (number: number) => ({ key: `APP-${number}`, summaryText: `Ticket ${number}` });

async function fixture(t: TestContext, respond: (url: URL, headers: Headers) => Response = () => json({ sections: [] })) {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-jira-picker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests: URL[] = [];
  const manager = new ConnectionManager(join(dir, 'connections.json'), storage, async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(init?.redirect, 'manual');
    if (url.pathname === '/_edge/tenant_info') {
      assert.equal(headers.has('Authorization'), false);
      return json({ cloudId: `cloud-${url.hostname.split('.')[0]}` });
    }
    const account = Buffer.from(headers.get('Authorization')!.slice(6), 'base64').toString().split(':')[0];
    if (url.pathname.endsWith('/myself')) return json({ accountId: account, displayName: account, active: true });
    if (url.pathname === '/2.0/user') return json({ uuid: account, display_name: account });
    requests.push(url);
    return respond(url, headers);
  });
  const connect = (name = 'one') => manager.save({ kind: 'jira', siteUrl: `https://${name}.atlassian.net`, email: `${name}@example.invalid`, token: `${name}-token` });
  const connection = await connect();
  return { manager, connection, connect, requests };
}

test('Jira picker uses API history for an empty query without requesting a full search', async t => {
  const f = await fixture(t, url => {
    assert.equal(url.origin, 'https://api.atlassian.com');
    assert.equal(url.pathname, '/ex/jira/cloud-one/rest/api/3/issue/picker');
    assert.equal(url.searchParams.get('query'), '');
    assert.equal(url.searchParams.has('currentJQL'), false);
    assert.equal(url.searchParams.get('showSubTasks'), 'true');
    assert.equal(url.searchParams.get('showSubTaskParent'), 'true');
    return json({ sections: [{ id: 'hs', label: 'Historique', issues: [option(1), option(2)] }, { id: 'cs', issues: [option(3)] }] });
  });
  assert.deepEqual(await f.manager.getIssueSuggestions(f.connection.id, '  '), { recent: [{ key: 'APP-1', title: 'Ticket 1' }, { key: 'APP-2', title: 'Ticket 2' }], matches: [] });
  assert.equal(f.requests.length, 1);
});

test('Jira picker encodes text separately from constant JQL and deduplicates plain-text suggestions', async t => {
  const query = 'APP-1 & "résumé" # + currentJQL=project=SECRET';
  const f = await fixture(t, url => {
    assert.equal(url.searchParams.get('query'), query);
    assert.equal(url.searchParams.get('currentJQL'), 'project is not EMPTY');
    assert.equal(url.searchParams.getAll('currentJQL').length, 1);
    return json({ sections: [
      { id: 'currentSearch', label: 'Recherche actuelle', issues: [option(1), { key: 'app-2', summaryText: 'Use <input> & "quotes"', summary: '<script>unsafe()</script>', keyHtml: '<b>APP-2</b>' }, { key: 'APP-3', summary: '<b>Never use this markup</b>' }, option(2)] },
      { id: 'historySearch', issues: [option(1), option(1), { key: 'APP-4', summaryText: '  ', summary: '<script>ignored()</script>' }] },
    ] });
  });
  assert.deepEqual(await f.manager.getIssueSuggestions(f.connection.id, ` ${query} `), {
    recent: [{ key: 'APP-1', title: 'Ticket 1' }, { key: 'APP-4', title: 'APP-4' }],
    matches: [{ key: 'APP-2', title: 'Use <input> & "quotes"' }, { key: 'APP-3', title: 'APP-3' }],
  });
});

test('Jira picker keeps accounts and Cloud environments independent', async t => {
  const f = await fixture(t, (url, headers) => {
    const second = url.pathname.includes('/cloud-two/');
    const name = second ? 'two' : 'one';
    assert.equal(headers.get('Authorization'), `Basic ${Buffer.from(`${name}@example.invalid:${name}-token`).toString('base64')}`);
    return json({ sections: [{ id: 'hs', issues: [option(second ? 2 : 1)] }] });
  });
  const other = await f.connect('two');
  const [first, second] = await Promise.all([f.manager.getIssueSuggestions(f.connection.id, ''), f.manager.getIssueSuggestions(other.id, '')]);
  assert.equal(first.recent[0].key, 'APP-1');
  assert.equal(second.recent[0].key, 'APP-2');
});

test('Jira picker limits display results and title size while accepting explicitly empty suggestions', async t => {
  const f = await fixture(t, url => json(url.searchParams.get('query') === 'empty' ? { sections: [] } : { sections: [
    { id: 'hs', issues: Array.from({ length: 30 }, (_, index) => option(index + 1)) },
    { id: 'cs', issues: Array.from({ length: 100 }, (_, index) => ({ ...option(index + 1), summaryText: 'x'.repeat(1500) })) },
  ] }));
  const result = await f.manager.getIssueSuggestions(f.connection.id, 'ticket');
  assert.equal(result.recent.length, 20);
  assert.equal(result.matches.length, 20);
  assert.equal(new Set([...result.recent, ...result.matches].map(issue => issue.key)).size, 40);
  assert.equal(result.matches[0].title.length, 1000);
  assert.deepEqual(await f.manager.getIssueSuggestions(f.connection.id, 'empty'), { recent: [], matches: [] });
});

test('invalid Jira picker queries and unavailable or wrong-provider connections make no request', async t => {
  const f = await fixture(t);
  for (const query of [null, 1, {}, [], 'x'.repeat(201), 'app\n123', 'app\t123', 'app\u0000123', 'app\u0085123']) {
    await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, query as string), /200 characters/);
  }
  const bitbucket = await f.manager.save({ kind: 'bitbucket', email: 'bb@example.invalid', token: 'bb-token' });
  await assert.rejects(() => f.manager.getIssueSuggestions(bitbucket.id, ''), /Choose a Jira connection/);
  await f.manager.disconnect(f.connection.id);
  await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, ''), /Reconnect/);
  await assert.rejects(() => f.manager.getIssueSuggestions('missing', ''), /Reconnect/);
  assert.equal(f.requests.length, 0);
});

test('malformed Jira picker responses never masquerade as empty suggestions', async t => {
  let response: unknown;
  const f = await fixture(t, () => json(response));
  for (const value of [null, {}, { sections: null }, { sections: [null] }, { sections: [{}] }, { sections: [{ id: 'hs' }] }, { sections: [{ id: 'hs', issues: {} }] }, { sections: [{ id: 'new-section', issues: [] }] },
    ...[null, {}, { key: '../APP-1' }, { key: 'APP-0' }, { key: 'APP-1', summaryText: {} }, { key: 'APP-1', summaryText: 42 }].map(issue => ({ sections: [{ id: 'hs', issues: [issue] }] })),
  ]) {
    response = value;
    await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, 'APP'), /incomplete ticket suggestion list/);
  }
});

test('Jira picker preserves auth and permission failures and never follows authenticated redirects', async t => {
  let status = 401;
  const f = await fixture(t, () => status === 302 ? new Response(null, { status, headers: { Location: 'https://other.example.invalid' } }) : json({}, status));
  for (const code of [401, 403, 500]) {
    status = code;
    await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, ''), error => error instanceof ProviderError && error.status === code);
  }
  status = 302;
  await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, ''), /redirected an authenticated request/);
  assert.equal(f.requests.length, 4);
});

test('Jira picker rate limits are shared with subsequent issue requests on the same account', async t => {
  const f = await fixture(t, () => json({}, 429, { 'Retry-After': '60' }));
  let retryAt: number | undefined;
  await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, ''), error => {
    if (!(error instanceof ProviderError)) return false;
    retryAt = error.retryAt;
    return error.status === 429 && !!retryAt && retryAt > Date.now();
  });
  await assert.rejects(() => f.manager.getIssueSuggestions(f.connection.id, 'APP'), error => error instanceof ProviderError && error.status === 429 && error.retryAt === retryAt);
  await assert.rejects(() => f.manager.getIssue(f.connection.id, 'APP-123'), /rate limited/);
  assert.equal(f.requests.length, 1);
});
