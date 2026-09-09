import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DiagnosticProvider = 'bitbucket' | 'jira' | 'unknown';
export type DiagnosticMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'OTHER';
export type PullRequestField = 'id' | 'title' | 'source' | 'destination' | 'source.commit' | 'destination.commit' | 'source.commit.hash' | 'destination.commit.hash' | 'source.branch' | 'destination.branch' | 'source.branch.name' | 'destination.branch.name' | 'source.repository' | 'destination.repository' | 'source.repository.uuid' | 'destination.repository.uuid' | 'source.repository.full_name' | 'destination.repository.full_name' | 'merge_commit' | 'merge_commit.hash';
export interface PullRequestFieldIssue {
  field: PullRequestField;
  type: 'missing' | 'null' | 'string' | 'number' | 'boolean' | 'object' | 'array' | 'other';
  reason: 'missing' | 'invalid_type' | 'empty' | 'invalid_format' | 'unsupported_length';
  length?: number;
}
export type IntegrationDiagnosticEvent = {
  event: 'http'; provider: DiagnosticProvider; requestId: string; method: DiagnosticMethod; endpoint: string;
  outcome: 'response' | 'network_error' | 'timeout' | 'cancelled' | 'rate_limited' | 'invalid_json' | 'response_too_large' | 'body_error' | 'redirect';
  status?: number; durationMs?: number; providerRequestId?: string;
} | {
  event: 'pull_request_invalid'; operation: 'list' | 'detail' | 'normalization' | 'merge'; pullRequestId?: number; issues: PullRequestFieldIssue[];
} | {
  event: 'pull_request_commit_resolved'; operation: 'list' | 'detail' | 'merge'; pullRequestId?: number; field: 'source.commit.hash' | 'destination.commit.hash' | 'merge_commit.hash'; length: number;
} | { event: 'session_started' };

const methods: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'OTHER'];
const outcomes: readonly string[] = ['response', 'network_error', 'timeout', 'cancelled', 'rate_limited', 'invalid_json', 'response_too_large', 'body_error', 'redirect'];
const fields: readonly string[] = ['id', 'title', 'source', 'destination', 'source.commit', 'destination.commit', 'source.commit.hash', 'destination.commit.hash', 'source.branch', 'destination.branch', 'source.branch.name', 'destination.branch.name', 'source.repository', 'destination.repository', 'source.repository.uuid', 'destination.repository.uuid', 'source.repository.full_name', 'destination.repository.full_name', 'merge_commit', 'merge_commit.hash'];
const types: readonly string[] = ['missing', 'null', 'string', 'number', 'boolean', 'object', 'array', 'other'];
const reasons: readonly string[] = ['missing', 'invalid_type', 'empty', 'invalid_format', 'unsupported_length'];
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{16,64}|\{?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}?)$/i.test(value);

export function diagnosticProvider(origin: string): DiagnosticProvider {
  try {
    const host = new URL(origin).hostname;
    if (host === 'api.bitbucket.org') return 'bitbucket';
    if (host === 'api.atlassian.com' || /^[a-z0-9-]+\.atlassian\.net$/.test(host)) return 'jira';
  } catch { /* An unsupported endpoint has no diagnostic identity. */ }
  return 'unknown';
}

export function diagnosticMethod(method?: string): DiagnosticMethod {
  const normalized = (method ?? 'GET').toUpperCase();
  return methods.includes(normalized) ? normalized as DiagnosticMethod : 'OTHER';
}

/** Only static route templates are returned: never tenant, repository, revision, path, or query text. */
export function safeProviderEndpoint(origin: string, path: string): string {
  let pathname: string;
  try { pathname = new URL(path, `${origin}/`).pathname; } catch { return '/:unknown'; }
  if (diagnosticProvider(origin) === 'jira') {
    if (pathname === '/_edge/tenant_info') return '/_edge/tenant_info';
    if (/^\/ex\/jira\/[^/]+\/rest\/api\/3\/myself\/?$/.test(pathname)) return '/ex/jira/:site/rest/api/3/myself';
    if (/^\/ex\/jira\/[^/]+\/rest\/api\/3\/issue\/[^/]+\/?$/.test(pathname)) return '/ex/jira/:site/rest/api/3/issue/:issue';
    return '/:unknown';
  }
  if (diagnosticProvider(origin) !== 'bitbucket') return '/:unknown';
  if (pathname === '/2.0/user' || pathname === '/2.0/repositories') return pathname;
  const repository = pathname.match(/^\/2\.0\/repositories\/[^/]+\/[^/]+(?:\/(.*))?$/);
  if (!repository) return '/:unknown';
  const base = '/2.0/repositories/:workspace/:repository';
  const suffix = repository[1] ?? '';
  if (!suffix) return base;
  if (suffix === 'pullrequests') return `${base}/pullrequests`;
  const pr = suffix.match(/^pullrequests\/([1-9][0-9]{0,14})(?:\/(.*))?$/);
  if (pr) {
    const prBase = `${base}/pullrequests/${pr[1]}`;
    if (!pr[2]) return prBase;
    if (['approve', 'merge', 'comments', 'diff', 'diffstat', 'commits', 'activity', 'request-changes'].includes(pr[2])) return `${prBase}/${pr[2]}`;
    if (/^comments\/[^/]+$/.test(pr[2])) return `${prBase}/comments/:comment`;
    if (/^comments\/[^/]+\/resolve$/.test(pr[2])) return `${prBase}/comments/:comment/resolve`;
    if (/^merge\/task-status\/[^/]+$/.test(pr[2])) return `${prBase}/merge/task-status/:task`;
    return '/:unknown';
  }
  if (/^refs\/branches\/.+/.test(suffix)) return `${base}/refs/branches/:branch`;
  if (/^commit\/[^/]+\/statuses$/.test(suffix)) return `${base}/commit/:revision/statuses`;
  if (/^commit\/[^/]+$/.test(suffix)) return `${base}/commit/:revision`;
  if (/^(?:merge-base|diffstat|diff)\/[^/]+$/.test(suffix)) return `${base}/${suffix.split('/')[0]}/:revision`;
  if (/^src\/[^/]+(?:\/.*)?$/.test(suffix)) return `${base}/src/:revision/:path`;
  return '/:unknown';
}

function safeEndpointTemplate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 220) return '/:unknown';
  if (['/:unknown', '/_edge/tenant_info', '/ex/jira/:site/rest/api/3/myself', '/ex/jira/:site/rest/api/3/issue/:issue', '/2.0/user', '/2.0/repositories'].includes(value)) return value;
  return /^\/2\.0\/repositories\/:workspace\/:repository(?:\/(?:pullrequests(?:\/[1-9][0-9]{0,14}(?:\/(?:approve|merge(?:\/task-status\/:task)?|comments(?:\/:comment(?:\/resolve)?)?|diff|diffstat|commits|activity|request-changes))?)?|refs\/branches\/:branch|commit\/:revision(?:\/statuses)?|(?:merge-base|diffstat|diff)\/:revision|src\/:revision\/:path))?$/.test(value) ? value : '/:unknown';
}

function safeEvent(event: IntegrationDiagnosticEvent): object | null {
  if (event.event === 'session_started') return { event: event.event };
  if (event.event === 'http') {
    if (!identifier(event.requestId) || !['bitbucket', 'jira', 'unknown'].includes(event.provider) || !outcomes.includes(event.outcome)) return null;
    return { event: 'http', provider: event.provider, requestId: event.requestId, method: diagnosticMethod(event.method), endpoint: safeEndpointTemplate(event.endpoint), outcome: event.outcome,
      ...(integer(event.status, 599) ? { status: event.status } : {}), ...(integer(event.durationMs, 86_400_000) ? { durationMs: event.durationMs } : {}), ...(identifier(event.providerRequestId) ? { providerRequestId: event.providerRequestId } : {}) };
  }
  if (event.event === 'pull_request_invalid') {
    if (!['list', 'detail', 'normalization', 'merge'].includes(event.operation) || !Array.isArray(event.issues)) return null;
    return { event: event.event, operation: event.operation, ...(integer(event.pullRequestId, Number.MAX_SAFE_INTEGER) ? { pullRequestId: event.pullRequestId } : {}),
      issues: event.issues.slice(0, 24).filter(issue => issue && fields.includes(issue.field) && types.includes(issue.type) && reasons.includes(issue.reason)).map(issue => ({ field: issue.field, type: issue.type, reason: issue.reason, ...(integer(issue.length, Number.MAX_SAFE_INTEGER) ? { length: issue.length } : {}) })) };
  }
  if (event.event === 'pull_request_commit_resolved') {
    if (!['list', 'detail', 'merge'].includes(event.operation) || !['source.commit.hash', 'destination.commit.hash', 'merge_commit.hash'].includes(event.field) || !integer(event.length, 64)) return null;
    return { event: event.event, operation: event.operation, ...(integer(event.pullRequestId, Number.MAX_SAFE_INTEGER) ? { pullRequestId: event.pullRequestId } : {}), field: event.field, length: event.length };
  }
  return null;
}

/** A separate bounded log; logging failures cannot interrupt review or publish operations. */
export class IntegrationDiagnostics {
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(readonly filePath: string, private maxBytes = 1024 * 1024) {}
  record(event: IntegrationDiagnosticEvent): void {
    const sanitized = safeEvent(event);
    if (!sanitized || this.queued >= 256) return;
    const line = `${JSON.stringify({ time: new Date().toISOString(), version: 1, ...sanitized })}\n`;
    if (Buffer.byteLength(line) > this.maxBytes) return;
    this.queued++;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = (await stat(this.filePath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > this.maxBytes) await rename(this.filePath, `${this.filePath}.1`);
      await appendFile(this.filePath, line, { mode: 0o600 });
      await chmod(this.filePath, 0o600);
    }).catch(() => { /* Diagnostics are best effort; never include the failing path or OS error text. */ }).finally(() => { this.queued--; });
  }
  async flush(): Promise<void> { await this.pending; }
}

let diagnostics: IntegrationDiagnostics | null = null;
export function configureIntegrationDiagnostics(filePath: string): void {
  diagnostics = new IntegrationDiagnostics(filePath);
  diagnostics.record({ event: 'session_started' });
}
export function getIntegrationDiagnosticsPath(): string | null { return diagnostics?.filePath ?? null; }
export function recordIntegrationDiagnostic(event: IntegrationDiagnosticEvent): void { diagnostics?.record(event); }
export async function flushIntegrationDiagnostics(): Promise<void> { await diagnostics?.flush(); }
