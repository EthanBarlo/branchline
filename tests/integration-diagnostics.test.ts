import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, ProviderHttp } from '../electron/connection-manager';
import { configureIntegrationDiagnostics, flushIntegrationDiagnostics, getIntegrationDiagnosticsPath, IntegrationDiagnostics, safeProviderEndpoint } from '../electron/integration-diagnostics';

const bitbucket = 'https://api.bitbucket.org';
const requestId = '12345678-1234-1234-1234-123456789012';
const secret = 'private-token-do-not-log';

test('provider endpoint templates redact accounts, repository names, branches, files and every query', () => {
  const base = '/2.0/repositories/:workspace/:repository';
  assert.equal(safeProviderEndpoint(bitbucket, `/2.0/repositories/${secret}/${secret}/pullrequests?token=${secret}`), `${base}/pullrequests`);
  assert.equal(safeProviderEndpoint(bitbucket, `/2.0/repositories/${secret}/${secret}/pullrequests/17/comments/${secret}`), `${base}/pullrequests/17/comments/:comment`);
  assert.equal(safeProviderEndpoint(bitbucket, `/2.0/repositories/${secret}/${secret}/refs/branches/private/branch`), `${base}/refs/branches/:branch`);
  assert.equal(safeProviderEndpoint(bitbucket, `/2.0/repositories/${secret}/${secret}/src/${secret}/private/file.ts`), `${base}/src/:revision/:path`);
  assert.equal(safeProviderEndpoint(bitbucket, `/2.0/repositories/${secret}/${secret}/pullrequests/17/merge/task-status/${secret}`), `${base}/pullrequests/17/merge/task-status/:task`);
  assert.equal(safeProviderEndpoint('https://api.atlassian.com', `/ex/jira/${secret}/rest/api/3/issue/SECRET-123?fields=${secret}`), '/ex/jira/:site/rest/api/3/issue/:issue');
  assert.equal(safeProviderEndpoint(`https://${secret}.atlassian.net`, '/_edge/tenant_info'), '/_edge/tenant_info');
  assert.equal(safeProviderEndpoint(bitbucket, `/private/${secret}`), '/:unknown');
});

test('HTTP rejection messages identify provider, status, safe action and matching diagnostic request without recording secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); configureIntegrationDiagnostics(path);
    const http = new ProviderHttp(async () => new Response(`server included ${secret}`, { status: 403, headers: { 'x-request-id': requestId, 'authorization': secret } }), bitbucket, `Basic ${secret}`);
    let error: ProviderError | undefined;
    try { await http.json(`/2.0/repositories/${secret}/${secret}/pullrequests?access_token=${secret}`); }
    catch (caught) { error = caught as ProviderError; }
    assert.equal(error?.status, 403); assert.match(error!.message, /Bitbucket GET .*pullrequests returned HTTP 403/); assert.match(error!.message, /token scopes/);
    assert.ok(error!.diagnosticId); assert.ok(!error!.message.includes(secret));
    await flushIntegrationDiagnostics();
    assert.equal(getIntegrationDiagnosticsPath(), path);
    const content = await readFile(path, 'utf8'); assert.ok(!content.includes(secret));
    const entry = content.trim().split('\n').map(line => JSON.parse(line)).find(value => value.event === 'http');
    assert.equal(entry.requestId, error!.diagnosticId); assert.equal(entry.status, 403); assert.equal(entry.providerRequestId, requestId); assert.equal(typeof entry.durationMs, 'number');
    assert.deepEqual(Object.keys(entry).sort(), ['time', 'version', 'event', 'provider', 'requestId', 'method', 'endpoint', 'outcome', 'status', 'durationMs', 'providerRequestId'].sort());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('successes are logged and invalid JSON from a successful write preserves uncertain delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-json-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); configureIntegrationDiagnostics(path);
    const http = new ProviderHttp(async () => new Response(`invalid JSON ${secret}`, { status: 201 }), bitbucket);
    await assert.rejects(() => http.json(`/2.0/repositories/${secret}/${secret}/pullrequests/3/comments`, { method: 'POST', body: JSON.stringify({ content: { raw: secret } }) }), (error: unknown) => {
      assert.ok(error instanceof ProviderError); assert.equal(error.status, undefined); assert.match(error.message, /HTTP 201/); assert.match(error.message, /invalid JSON/); assert.ok(!error.message.includes(secret)); return true;
    });
    await flushIntegrationDiagnostics();
    const content = await readFile(path, 'utf8'); assert.ok(!content.includes(secret));
    const entries = content.trim().split('\n').map(line => JSON.parse(line)).filter(value => value.event === 'http');
    assert.deepEqual(entries.map(entry => entry.outcome), ['response', 'invalid_json']);
    assert.equal(entries[0].requestId, entries[1].requestId); assert.equal(entries[0].status, 201);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('network and response stream failures hide raw errors and preserve uncertain delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-network-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); configureIntegrationDiagnostics(path);
    for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
      const http = new ProviderHttp(async () => { const error = new Error(secret); error.name = name; throw error; }, bitbucket);
      await assert.rejects(() => http.json('/2.0/user'), (error: unknown) => { assert.ok(error instanceof ProviderError); assert.equal(error.status, undefined); assert.ok(!error.message.includes(secret)); return true; });
    }
    const http = new ProviderHttp(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }), { status: 200 }), bitbucket);
    await assert.rejects(() => http.json('/2.0/user'), (error: unknown) => { assert.ok(error instanceof ProviderError); assert.equal(error.status, undefined); assert.match(error.message, /download was interrupted/); return true; });
    await flushIntegrationDiagnostics();
    const content = await readFile(path, 'utf8'); assert.ok(!content.includes(secret));
    const outcomes = content.trim().split('\n').map(line => JSON.parse(line)).filter(value => value.event === 'http').map(value => value.outcome);
    assert.deepEqual(outcomes, ['timeout', 'cancelled', 'network_error', 'response', 'body_error']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('oversized JSON bodies and request backoff produce correlated safe diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-limits-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); configureIntegrationDiagnostics(path);
    const large = new ProviderHttp(async () => new Response(secret, { headers: { 'content-length': String(32 * 1024 * 1024) } }), bitbucket);
    await assert.rejects(() => large.json('/2.0/user'), (error: unknown) => { assert.ok(error instanceof ProviderError); assert.equal(error.status, undefined); assert.match(error.message, /too large/); return true; });
    let calls = 0;
    const limited = new ProviderHttp(async () => { calls++; return new Response(secret, { status: 429, headers: { 'retry-after': '60' } }); }, bitbucket);
    await assert.rejects(() => limited.json('/2.0/user'), /request limit/);
    await assert.rejects(() => limited.json('/2.0/user'), /rate limited/);
    assert.equal(calls, 1);
    await flushIntegrationDiagnostics();
    const content = await readFile(path, 'utf8'); assert.ok(!content.includes(secret)); assert.ok(content.includes('response_too_large')); assert.ok(content.includes('rate_limited'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime event allowlisting excludes extra fields, raw route strings and untrusted identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-event-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); const logger = new IntegrationDiagnostics(path);
    logger.record({ event: 'http', provider: 'bitbucket', requestId, method: 'GET', endpoint: `/private/${secret}`, outcome: 'response', providerRequestId: secret, responseBody: secret, authorization: secret } as any);
    logger.record({ event: 'pull_request_invalid', operation: 'list', pullRequestId: 3, issues: [{ field: 'source.commit.hash', type: 'string', reason: 'unsupported_length', length: 12, value: secret }, { field: secret, type: 'string', reason: 'empty' }], raw: secret } as any);
    logger.record({ event: 'pull_request_commit_resolved', operation: 'detail', pullRequestId: 3, field: 'source.commit.hash', length: 12, hash: secret } as any);
    await logger.flush();
    const content = await readFile(path, 'utf8'); assert.ok(!content.includes(secret));
    const entries = content.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries[0].endpoint, '/:unknown'); assert.equal(entries[0].providerRequestId, undefined);
    assert.deepEqual(entries[1].issues, [{ field: 'source.commit.hash', type: 'string', reason: 'unsupported_length', length: 12 }]);
    assert.equal(entries[2].event, 'pull_request_commit_resolved');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('diagnostic files rotate within a bounded size and are readable only by the current user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-rotating-diagnostics-'));
  try {
    const path = join(dir, 'integrations.log'); const logger = new IntegrationDiagnostics(path, 1024);
    for (let index = 0; index < 40; index++) logger.record({ event: 'session_started' });
    await logger.flush();
    for (const file of [path, `${path}.1`]) {
      const info = await stat(file); assert.ok(info.size <= 1024); assert.ok(info.size > 0);
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
      for (const line of (await readFile(file, 'utf8')).trim().split('\n')) assert.equal(JSON.parse(line).event, 'session_started');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('logging write failures never throw into provider operations or flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-failed-diagnostics-'));
  try { const logger = new IntegrationDiagnostics(dir); logger.record({ event: 'session_started' }); await logger.flush(); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
