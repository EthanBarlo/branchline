import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ConnectionInfo, ConnectionInput, JiraIssue } from '../shared/integrations';
import { diagnosticMethod, diagnosticProvider, recordIntegrationDiagnostic, safeProviderEndpoint, type IntegrationDiagnosticEvent } from './integration-diagnostics';

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export interface ConnectionCredentials { info: ConnectionInfo; email: string; token: string }
type ConnectionMetadata = Omit<ConnectionInfo, 'connected'>;
interface ConnectionEntry { info: ConnectionMetadata; token?: string; encryptedToken?: string }
export type FetchImplementation = typeof fetch;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number, public readonly retryAt?: number, public readonly diagnosticId?: string) { super(message); }
}

/** No redirects or cross-origin credential forwarding; failed writes are never retried. */
export class ProviderHttp {
  private retryAt = 0;
  private requests = new WeakMap<Response, Extract<IntegrationDiagnosticEvent, { event: 'http' }>>();
  constructor(private fetchImpl: FetchImplementation, private origin: string, private authorization?: string) {}

  private describe(event: Extract<IntegrationDiagnosticEvent, { event: 'http' }>, detail: string, status?: number, retryAt?: number): ProviderError {
    const provider = event.provider === 'bitbucket' ? 'Bitbucket' : event.provider === 'jira' ? 'Jira' : 'The provider';
    // An unreadable success response does not prove that a write was rejected.
    return new ProviderError(`${provider} ${event.method} ${event.endpoint}${status ? ` returned HTTP ${status}` : ' failed'}. ${detail} Diagnostic request: ${event.requestId}.`, status && status >= 300 ? status : undefined, retryAt, event.requestId);
  }

  private responseFailure(response: Response, outcome: Extract<IntegrationDiagnosticEvent, { event: 'http' }>['outcome'], detail: string): ProviderError {
    const event = this.requests.get(response)!;
    recordIntegrationDiagnostic({ ...event, outcome });
    return this.describe(event, detail, response.status);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, `${this.origin}/`);
    if (url.origin !== this.origin || url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('The provider returned an unsafe request URL.');
    const event: Extract<IntegrationDiagnosticEvent, { event: 'http' }> = { event: 'http', provider: diagnosticProvider(this.origin), requestId: randomUUID(), method: diagnosticMethod(init.method), endpoint: safeProviderEndpoint(this.origin, path), outcome: 'response' };
    if (Date.now() < this.retryAt) {
      recordIntegrationDiagnostic({ ...event, outcome: 'rate_limited', status: 429 });
      throw this.describe(event, `The provider is rate limited. Try again after ${new Date(this.retryAt).toLocaleTimeString()}.`, 429, this.retryAt);
    }
    const headers = new Headers(init.headers);
    if (this.authorization) headers.set('Authorization', this.authorization);
    const started = Date.now();
    let response: Response;
    try { response = await this.fetchImpl(url.href, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) }); }
    catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
      const outcome = name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'cancelled' : 'network_error';
      recordIntegrationDiagnostic({ ...event, outcome, durationMs: Math.max(0, Date.now() - started) });
      throw this.describe(event, outcome === 'timeout' ? 'The request timed out. Check your connection and retry.' : outcome === 'cancelled' ? 'The request was cancelled.' : 'The network request could not be completed. Check your connection, proxy or firewall settings.');
    }
    event.status = response.status;
    event.durationMs = Math.max(0, Date.now() - started);
    // Provider-generated identifiers only, validated again by the diagnostic writer.
    event.providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('atl-traceid') ?? response.headers.get('x-b3-traceid') ?? undefined;
    this.requests.set(response, event);
    recordIntegrationDiagnostic(event);
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
      const parsed = retry ? Date.parse(retry) : NaN;
      const delay = seconds !== null ? seconds * 1000 : Number.isFinite(parsed) ? parsed - Date.now() : 60_000;
      this.retryAt = Date.now() + Math.max(1000, Math.min(3_600_000, delay));
      await response.body?.cancel();
      throw this.describe(event, 'The provider request limit was reached. Wait before refreshing again.', 429, this.retryAt);
    }
    if (response.status >= 300 && response.status < 400) return response;
    if (!response.ok) {
      // Error bodies can contain user input. Keep credentials and raw server HTML out of messages.
      await response.body?.cancel();
      const detail = response.status === 401 ? 'Reconnect with a valid API token.' : response.status === 403 ? 'The connected account or token does not have permission for this action. Check the token scopes in Settings and the account permissions in the provider.' : response.status === 404 ? 'The requested item was not found or is not accessible to this account. Check the project repository mapping or Jira connection.' : response.status === 409 ? 'The provider rejected this action because the remote state changed or merge requirements are not met.' : response.status >= 500 ? 'The provider could not complete the request. Try again later.' : 'The provider rejected the request. Open Settings → Diagnostics for the request details.';
      throw this.describe(event, detail, response.status);
    }
    return response;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, { ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...Object.fromEntries(new Headers(init.headers)) } });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw this.responseFailure(response, 'redirect', 'The provider redirected an authenticated request. Reconnect using the supported Cloud endpoint.'); }
    if (response.status === 204) return undefined as T;
    let body: Awaited<ReturnType<typeof readBoundedBody>>;
    try { body = await readBoundedBody(response, 16 * 1024 * 1024); }
    catch { throw this.responseFailure(response, 'body_error', 'The response download was interrupted. Check your connection and retry.'); }
    const { bytes, tooLarge } = body;
    if (tooLarge || !bytes) throw this.responseFailure(response, 'response_too_large', 'The provider response is too large to read safely.');
    try { return JSON.parse(bytes.toString('utf8')) as T; } catch { throw this.responseFailure(response, 'invalid_json', 'The provider returned an invalid JSON response. Check whether a proxy or sign-in page is intercepting the connection.'); }
  }
}

export async function readBoundedBody(response: Response, limit: number): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) { await response.body?.cancel(); return { bytes: null, tooLarge: true }; }
  if (!response.body) return { bytes: Buffer.alloc(0), tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let count = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      count += item.value.byteLength;
      if (count > limit) { await reader.cancel(); return { bytes: null, tooLarge: true }; }
      chunks.push(Buffer.from(item.value));
    }
    return { bytes: Buffer.concat(chunks), tooLarge: false };
  } finally { reader.releaseLock(); }
}

function jiraSite(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter your Jira Cloud site URL.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a Jira Cloud URL such as https://team.atlassian.net.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use your HTTPS Jira Cloud site URL, such as https://team.atlassian.net.');
  return url.origin;
}

export class ConnectionManager {
  private entries = new Map<string, ConnectionEntry>();
  private clients = new Map<string, ProviderHttp>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private filePath: string, private storage: SecureStorage, private fetchImpl: FetchImplementation = fetch) {}

  private secure(): boolean {
    try { if (!this.storage.isEncryptionAvailable()) return false; } catch { return false; }
    try { return this.storage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return process.platform !== 'linux'; }
  }

  async load(): Promise<void> {
    let data: unknown;
    try { data = JSON.parse(await readFile(this.filePath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('The saved connections could not be read.'); }
    if (!object(data) || data.version !== 1 || !Array.isArray(data.connections)) throw new Error('The saved connections have an unsupported format.');
    const next = new Map<string, ConnectionEntry>();
    for (const entry of data.connections) {
      if (!object(entry) || !object(entry.info) || typeof entry.info.id !== 'string' || !['jira', 'bitbucket'].includes(entry.info.kind) || typeof entry.info.email !== 'string' || typeof entry.info.accountId !== 'string' || typeof entry.info.displayName !== 'string' || typeof entry.info.label !== 'string' || !['secure', 'session'].includes(entry.info.storage) || next.has(entry.info.id)) throw new Error('A saved connection is invalid.');
      const info: ConnectionMetadata = { id: entry.info.id, kind: entry.info.kind, email: entry.info.email, accountId: entry.info.accountId,
        displayName: entry.info.displayName, label: entry.info.label, storage: entry.info.storage,
        ...(entry.info.kind === 'jira' ? { siteUrl: entry.info.siteUrl, cloudId: entry.info.cloudId } : {}) };
      if (info.kind === 'jira') { info.siteUrl = jiraSite(info.siteUrl); if (typeof info.cloudId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(info.cloudId)) throw new Error('A saved Jira connection is invalid.'); }
      let token: string | undefined;
      if (typeof entry.encryptedToken === 'string' && this.secure()) { try { token = this.storage.decryptString(Buffer.from(entry.encryptedToken, 'base64')); } catch { /* Reconnect when the operating-system key is unavailable. */ } }
      next.set(info.id, { info, token, encryptedToken: typeof entry.encryptedToken === 'string' ? entry.encryptedToken : undefined });
    }
    this.entries = next;
    this.clients.clear();
  }

  list(): ConnectionInfo[] { return [...this.entries.values()].map(entry => ({ ...entry.info, connected: !!entry.token })); }
  credentials(id: string): ConnectionCredentials {
    const entry = this.entries.get(id);
    if (!entry?.token) throw new Error('Reconnect this account. Its API token is not available in this session.');
    return { info: { ...entry.info, connected: true }, email: entry.info.email, token: entry.token };
  }
  private client(id: string): ProviderHttp {
    const credentials = this.credentials(id);
    let client = this.clients.get(id);
    if (!client) { client = new ProviderHttp(this.fetchImpl, credentials.info.kind === 'jira' ? 'https://api.atlassian.com' : 'https://api.bitbucket.org', `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`); this.clients.set(id, client); }
    return client;
  }
  private async persist(): Promise<void> {
    const data = JSON.stringify({ version: 1, connections: [...this.entries.values()].map(({ info, encryptedToken }) => ({ info, ...(encryptedToken ? { encryptedToken } : {}) })) }, null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, this.filePath);
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> { const next = this.pending.catch(() => undefined).then(action); this.pending = next; return next; }

  save(input: ConnectionInput): Promise<ConnectionInfo> {
    return this.enqueue(async () => {
      if (!object(input) || !['jira', 'bitbucket'].includes(input.kind) || typeof input.email !== 'string' || !/^[^\s:@]+@[^\s@]+$/.test(input.email.trim()) || input.email.length > 320) throw new Error('Enter a valid account email and connection type.');
      if (input.id && !this.entries.has(input.id)) throw new Error('The connection no longer exists.');
      const previous = input.id ? this.entries.get(input.id) : undefined;
      if (previous && previous.info.kind !== input.kind) throw new Error('A connection cannot change provider.');
      const token = input.token || previous?.token;
      if (typeof token !== 'string' || !token.trim() || token.length > 16_384 || /[\u0000-\u0020\u007f]/.test(token)) throw new Error('Enter a valid API token.');
      const email = input.email.trim();
      const siteUrl = input.kind === 'jira' ? jiraSite(input.siteUrl) : undefined;
      if (previous?.info.kind === 'jira' && previous.info.siteUrl !== siteUrl) throw new Error('Create a separate connection for a different Jira site. Existing project links must keep their original site.');
      const id = input.id ?? randomUUID();
      const http = new ProviderHttp(this.fetchImpl, input.kind === 'jira' ? 'https://api.atlassian.com' : 'https://api.bitbucket.org', `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`);
      let cloudId: string | undefined;
      if (siteUrl) {
        const tenant = await new ProviderHttp(this.fetchImpl, siteUrl).json('/_edge/tenant_info');
        if (!object(tenant) || typeof tenant.cloudId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(tenant.cloudId)) throw new Error('Jira did not return a valid Cloud site identifier.');
        cloudId = tenant.cloudId;
        if (previous?.info.cloudId && previous.info.cloudId !== cloudId) throw new Error('This Jira site now identifies a different Cloud environment. Create a separate connection.');
      }
      const user = await http.json(input.kind === 'jira' ? `/ex/jira/${cloudId}/rest/api/3/myself` : '/2.0/user');
      const accountId = input.kind === 'jira' ? user?.accountId : user?.uuid ?? user?.account_id;
      const displayName = input.kind === 'jira' ? user?.displayName : user?.display_name;
      if (typeof accountId !== 'string' || !accountId || typeof displayName !== 'string' || !displayName || user.active === false) throw new Error('The provider did not return an active verified account.');
      if (previous && previous.info.accountId !== accountId) throw new Error('This token belongs to a different account. Create a separate connection to keep existing reviews tied to their original author.');
      const secure = this.secure();
      const info: ConnectionMetadata = { id, kind: input.kind, label: typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 200) : siteUrl ? new URL(siteUrl).hostname : displayName, email, accountId, displayName, storage: secure ? 'secure' : 'session', ...(siteUrl ? { siteUrl, cloudId } : {}) };
      let encryptedToken: string | undefined;
      if (secure) {
        try { encryptedToken = this.storage.encryptString(token).toString('base64'); }
        catch { info.storage = 'session'; }
      }
      const entry = { info, token, ...(encryptedToken ? { encryptedToken } : {}) };
      this.entries.set(id, entry);
      try { await this.persist(); } catch (error) { if (previous) this.entries.set(id, previous); else this.entries.delete(id); throw error; }
      this.clients.set(id, http);
      return { ...info, connected: true };
    });
  }
  async test(id: string): Promise<ConnectionInfo> {
    const { info } = this.credentials(id);
    const user = await this.client(id).json(info.kind === 'jira' ? `/ex/jira/${info.cloudId}/rest/api/3/myself` : '/2.0/user');
    const accountId = info.kind === 'jira' ? user?.accountId : user?.uuid ?? user?.account_id;
    if (accountId !== info.accountId || user.active === false) throw new Error('The account identity changed. Reconnect this account.');
    return info;
  }
  disconnect(id: string): Promise<void> {
    return this.enqueue(async () => {
      const prior = this.entries.get(id); if (!prior) return;
      // Keep verified identity and the stable ID so saved reviews can reconnect.
      this.entries.set(id, { info: prior.info });
      try { await this.persist(); } catch (error) { this.entries.set(id, prior); throw error; }
      this.clients.delete(id);
    });
  }
  async getIssue(id: string, key: string): Promise<JiraIssue> {
    const { info } = this.credentials(id);
    if (info.kind !== 'jira') throw new Error('Choose a Jira connection.');
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(key)) throw new Error('Enter a Jira ticket key such as APP-123.');
    const issue = await this.client(id).json(`/ex/jira/${info.cloudId}/rest/api/3/issue/${encodeURIComponent(key.toUpperCase())}?fields=summary,description`);
    if (!object(issue) || typeof issue.key !== 'string' || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(issue.key) || !object(issue.fields) || typeof issue.fields.summary !== 'string') throw new Error('Jira returned an incomplete ticket.');
    return { key: issue.key, title: issue.fields.summary, description: issue.fields.description ?? null, url: `${info.siteUrl}/browse/${encodeURIComponent(issue.key)}` };
  }
}
