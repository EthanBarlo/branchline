import type { ConnectionCredentials, FetchImplementation } from './connection-manager';
import { ProviderError, ProviderHttp, readBoundedBody } from './connection-manager';
import { validRelativePath, validateRepositoryMappings } from './repository-mapping';
import { recordIntegrationDiagnostic, type PullRequestField, type PullRequestFieldIssue } from './integration-diagnostics';
import type { InlinePayload, PullRequest, RemoteComment, RepositoryMapping } from '../shared/integrations';

const hashPattern = /^[a-f0-9]{40,64}$/i;
export const validCommitHash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
const abbreviatedCommitHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{7,39}$/i.test(value);
const validBranchName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));
type PullRequestOperation = 'list' | 'detail' | 'merge' | 'normalization';
type CommitResolutions = Map<string, Promise<unknown>>;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const forkPullRequest = (value: any): boolean => {
  const source = value?.source?.repository, destination = value?.destination?.repository;
  return !source || !destination || (source.uuid && destination.uuid ? source.uuid !== destination.uuid : typeof source.full_name !== 'string' || source.full_name.toLowerCase() !== destination.full_name?.toLowerCase());
};
function fieldIssue(field: PullRequestField, value: unknown, reason?: PullRequestFieldIssue['reason']): PullRequestFieldIssue {
  const type = value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : ['string', 'number', 'boolean', 'object'].includes(typeof value) ? typeof value as PullRequestFieldIssue['type'] : 'other';
  return { field, type, reason: reason ?? (value === undefined || value === null ? 'missing' : 'invalid_type'), ...(typeof value === 'string' ? { length: value.length } : {}) };
}
const identity = (user: any): string => typeof user?.uuid === 'string' ? user.uuid : typeof user?.account_id === 'string' ? user.account_id : '';
function webLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return url.origin === 'https://bitbucket.org' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export interface RawFile { bytes: Buffer | null; tooLarge: boolean; etag?: string; redirected?: boolean }

export class BitbucketClient {
  readonly accountId: string;
  private http: ProviderHttp;
  private rawCache = new Map<string, RawFile>();
  private metadataCache = new Map<string, any>();
  private cacheBytes = 0;
  constructor(credentials: ConnectionCredentials, fetchImpl: FetchImplementation = fetch) {
    if (credentials.info.kind !== 'bitbucket') throw new Error('Choose a Bitbucket connection.');
    this.accountId = credentials.info.accountId;
    this.http = new ProviderHttp(fetchImpl, 'https://api.bitbucket.org', `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`);
  }
  json<T = any>(path: string, init?: RequestInit): Promise<T> { return this.http.json<T>(path, init); }
  request(path: string, init?: RequestInit): Promise<Response> { return this.http.request(path, init); }
  repositoryPath(mapping: RepositoryMapping): string { const [valid] = validateRepositoryMappings([mapping]); return `/2.0/repositories/${encodeURIComponent(valid.workspace)}/${encodeURIComponent(valid.repoSlug)}`; }
  private prPath(pr: PullRequest): string { if (!Number.isSafeInteger(pr.id) || pr.id < 1) throw new Error('The pull request ID is invalid.'); return `${this.repositoryPath(pr.repository)}/pullrequests/${pr.id}`; }
  async pages(path: string): Promise<any[]> {
    const visited = new Set<string>();
    const values: any[] = [];
    let next: string | undefined = path;
    for (let page = 0; next; page++) {
      if (page >= 200 || visited.has(next)) throw new Error('The provider pagination is incomplete or repeated.');
      visited.add(next);
      const result: any = await this.json(next);
      if (!result || !Array.isArray(result.values) || result.truncated === true) throw new Error('The provider returned an incomplete list.');
      values.push(...result.values);
      if (values.length > 20_000) throw new Error('The provider list exceeds the supported size.');
      if (result.next !== undefined && result.next !== null && (typeof result.next !== 'string' || !result.next)) throw new Error('The provider returned an invalid next page.');
      next = result.next || undefined;
      if (!next && typeof result.size === 'number' && result.size > values.length) throw new Error('The provider omitted part of this list. Refresh to retry.');
    }
    return values;
  }
  normalizePullRequest(mapping: RepositoryMapping, value: any, allowUnsupported = false): PullRequest {
    return this.normalizedPullRequest(mapping, value, allowUnsupported, false, 'normalization');
  }
  private invalidPullRequest(mapping: RepositoryMapping, value: any, issues: PullRequestFieldIssue[], operation: PullRequestOperation, detail?: string): never {
    const pullRequestId = Number.isSafeInteger(value?.id) && value.id > 0 ? value.id : undefined;
    recordIntegrationDiagnostic({ event: 'pull_request_invalid', operation, ...(pullRequestId ? { pullRequestId } : {}), issues });
    const fields = issues.map(issue => `${issue.field} (${issue.type}${issue.length !== undefined ? `, ${issue.length} characters` : ''}; ${issue.reason.replaceAll('_', ' ')})`).join(', ');
    throw new Error(`Bitbucket returned incomplete or invalid data for ${mapping.workspace}/${mapping.repoSlug}${pullRequestId ? ` PR #${pullRequestId}` : ' pull request'}: ${fields}.${detail ? ` ${detail}` : ''} Open Settings → Diagnostics for request details.`);
  }
  private validatePullRequest(mapping: RepositoryMapping, value: any, allowAbbreviated: boolean, operation: PullRequestOperation): void {
    const issues: PullRequestFieldIssue[] = [];
    if (!Number.isSafeInteger(value?.id) || value.id < 1) issues.push(fieldIssue('id', value?.id, typeof value?.id === 'number' ? 'invalid_format' : undefined));
    if (typeof value?.title !== 'string') issues.push(fieldIssue('title', value?.title));
    for (const side of ['source', 'destination'] as const) {
      const endpoint = value?.[side];
      const hash = endpoint?.commit?.hash;
      if (!validCommitHash(hash) && !(allowAbbreviated && abbreviatedCommitHash(hash))) issues.push(fieldIssue(`${side}.commit.hash`, hash, typeof hash === 'string' ? /^[a-f0-9]+$/i.test(hash) ? 'unsupported_length' : 'invalid_format' : undefined));
      if (typeof endpoint?.branch?.name !== 'string' || !endpoint.branch.name) issues.push(fieldIssue(`${side}.branch.name`, endpoint?.branch?.name, endpoint?.branch?.name === '' ? 'empty' : undefined));
      if (!object(endpoint?.repository)) issues.push(fieldIssue(`${side}.repository`, endpoint?.repository));
      else {
        for (const field of ['uuid', 'full_name'] as const) if (endpoint.repository[field] !== undefined && typeof endpoint.repository[field] !== 'string') issues.push(fieldIssue(`${side}.repository.${field}`, endpoint.repository[field]));
      }
    }
    if (value?.merge_commit != null) {
      const hash = value.merge_commit.hash;
      if (!validCommitHash(hash) && !(allowAbbreviated && abbreviatedCommitHash(hash))) issues.push(fieldIssue('merge_commit.hash', hash, typeof hash === 'string' ? /^[a-f0-9]+$/i.test(hash) ? 'unsupported_length' : 'invalid_format' : undefined));
    }
    if (issues.length) this.invalidPullRequest(mapping, value, issues, operation);
  }
  private normalizedPullRequest(mapping: RepositoryMapping, value: any, allowUnsupported: boolean, allowAbbreviatedFork: boolean, operation: PullRequestOperation): PullRequest {
    this.validatePullRequest(mapping, value, allowAbbreviatedFork, operation);
    const source = value.source.repository;
    const destination = value.destination.repository;
    const fork = forkPullRequest(value);
    const unsupportedReason = 'Pull requests from forks are not supported yet. Review this pull request in Bitbucket.';
    if (!source || !destination || fork && !allowUnsupported) throw new Error(unsupportedReason);
    if (mapping.uuid && mapping.uuid !== destination.uuid || destination.full_name && destination.full_name.toLowerCase() !== `${mapping.workspace}/${mapping.repoSlug}`.toLowerCase()) throw new Error('This pull request belongs to a different repository. Update its mapping.');
    const result: PullRequest = {
      id: value.id, repository: { ...mapping, ...(typeof destination.uuid === 'string' ? { uuid: destination.uuid } : {}) }, title: value.title,
      url: webLink(value.links?.html?.href) ?? `https://bitbucket.org/${encodeURIComponent(mapping.workspace)}/${encodeURIComponent(mapping.repoSlug)}/pull-requests/${value.id}`,
      sourceBranch: value.source.branch.name, targetBranch: value.destination.branch.name, sourceHash: value.source.commit.hash, targetHash: value.destination.commit.hash,
      author: { id: identity(value.author), name: value.author?.display_name ?? 'Unknown author' },
      reviewers: Array.isArray(value.reviewers) ? value.reviewers.map((user: any) => ({ id: identity(user), name: user.display_name ?? 'Reviewer' })) : [],
      participants: Array.isArray(value.participants) ? value.participants.map((participant: any) => ({ id: identity(participant.user), approved: participant.approved === true })) : [],
      state: typeof value.state === 'string' ? value.state : 'UNKNOWN', draft: value.draft === true,
      mergeStrategies: Array.isArray(value.destination.branch.merge_strategies) ? value.destination.branch.merge_strategies.filter((strategy: unknown) => typeof strategy === 'string') : [],
      ...(validCommitHash(value.merge_commit?.hash) ? { mergeCommit: value.merge_commit.hash } : {}),
      sourceRepositoryUuid: source.uuid, destinationRepositoryUuid: destination.uuid, taskCount: typeof value.task_count === 'number' ? value.task_count : undefined,
    };
    return fork ? Object.assign(result, { unsupportedReason }) : result;
  }
  /** Resolve the captured commit ID itself; branch heads can move during these reads. */
  private async responsePullRequest(mapping: RepositoryMapping, value: any, operation: Exclude<PullRequestOperation, 'normalization'>, allowUnsupported = false, resolutions: CommitResolutions = new Map()): Promise<PullRequest> {
    this.validatePullRequest(mapping, value, true, operation);
    const source = value.source.repository, destination = value.destination.repository;
    if (mapping.uuid && mapping.uuid !== destination.uuid || destination.full_name && destination.full_name.toLowerCase() !== `${mapping.workspace}/${mapping.repoSlug}`.toLowerCase()) throw new Error('This pull request belongs to a different repository. Update its mapping.');
    if (forkPullRequest(value)) {
      // Inbox-only fork entries are disabled. They never enter saved reviews or
      // resolve a fork's source commit in the destination repository.
      if (allowUnsupported) return this.normalizedPullRequest(mapping, value, true, true, operation);
      throw new Error('Pull requests from forks are not supported yet. Review this pull request in Bitbucket.');
    }
    const resolve = async (field: 'source.commit.hash' | 'destination.commit.hash' | 'merge_commit.hash', hash: string): Promise<string> => {
      if (hashPattern.test(hash)) return hash;
      const path = `${this.repositoryPath(mapping)}/commit/${hash.toLowerCase()}`;
      let result: any;
      try {
        let pending = resolutions.get(path);
        if (!pending) { pending = this.json(path); resolutions.set(path, pending); }
        result = await pending;
      } catch (error) {
        const context = `Could not resolve ${field} for ${mapping.workspace}/${mapping.repoSlug} PR #${value.id}. `;
        if (error instanceof ProviderError) throw new ProviderError(`${context}${error.message}`, error.status, error.retryAt, error.diagnosticId);
        throw new Error(`${context}The commit response could not be read. Open Settings → Diagnostics for request details.`);
      }
      if (!validCommitHash(result?.hash) || !result.hash.toLowerCase().startsWith(hash.toLowerCase())) this.invalidPullRequest(mapping, value, [fieldIssue(field, result?.hash, 'invalid_format')], operation, 'The commit endpoint must return a full hash matching the captured abbreviated ID.');
      recordIntegrationDiagnostic({ event: 'pull_request_commit_resolved', operation, pullRequestId: value.id, field, length: hash.length });
      return result.hash;
    };
    const sourceHash = await resolve('source.commit.hash', value.source.commit.hash);
    const targetHash = await resolve('destination.commit.hash', value.destination.commit.hash);
    const mergeHash = value.merge_commit ? await resolve('merge_commit.hash', value.merge_commit.hash) : undefined;
    return this.normalizedPullRequest(mapping, { ...value, source: { ...value.source, commit: { ...value.source.commit, hash: sourceHash }, repository: source }, destination: { ...value.destination, commit: { ...value.destination.commit, hash: targetHash } }, ...(mergeHash ? { merge_commit: { ...value.merge_commit, hash: mergeHash } } : {}) }, false, false, operation);
  }
  async listPullRequests(mapping: RepositoryMapping): Promise<PullRequest[]> {
    const values = await this.pages(`${this.repositoryPath(mapping)}/pullrequests?state=OPEN&pagelen=50`);
    const resolutions: CommitResolutions = new Map();
    const result: PullRequest[] = [];
    for (const value of values) result.push(await this.responsePullRequest(mapping, value, 'list', true, resolutions));
    return result;
  }
  private async capturedCommit(mapping: RepositoryMapping, value: unknown): Promise<string> {
    if (validCommitHash(value)) return value;
    if (!abbreviatedCommitHash(value)) throw new Error(`Bitbucket returned an invalid captured commit for ${mapping.workspace}/${mapping.repoSlug}.`);
    const commit = await this.json(`${this.repositoryPath(mapping)}/commit/${value.toLowerCase()}`);
    if (!validCommitHash(commit?.hash) || !commit.hash.toLowerCase().startsWith(value.toLowerCase())) throw new Error(`Bitbucket did not resolve the captured commit to a matching full hash for ${mapping.workspace}/${mapping.repoSlug}.`);
    return commit.hash;
  }
  async getRepository(mapping: RepositoryMapping): Promise<{ defaultBranch: string }> {
    const value = await this.json(this.repositoryPath(mapping));
    if (!object(value) || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== `${mapping.workspace}/${mapping.repoSlug}`.toLowerCase() || mapping.uuid && value.uuid !== mapping.uuid) throw new Error('Bitbucket returned a different or incomplete repository. Check its mapping.');
    if (!validBranchName(value.mainbranch?.name)) throw new Error(`Bitbucket did not return a default branch for ${mapping.workspace}/${mapping.repoSlug}.`);
    return { defaultBranch: value.mainbranch.name };
  }
  async getBranch(mapping: RepositoryMapping, name: string): Promise<{ name: string; hash: string } | null> {
    if (!validBranchName(name)) throw new Error('Choose a valid branch name.');
    let value: any;
    try { value = await this.json(`${this.repositoryPath(mapping)}/refs/branches/${encodeURIComponent(name)}`); }
    catch (error) { if (error instanceof ProviderError && error.status === 404) return null; throw error; }
    if (!object(value) || value.name !== name) throw new Error(`Bitbucket returned a different or incomplete branch for ${mapping.workspace}/${mapping.repoSlug}.`);
    return { name, hash: await this.capturedCommit(mapping, value.target?.hash) };
  }
  async mergeBase(mapping: RepositoryMapping, sourceHash: string, targetHash: string): Promise<string> {
    if (!validCommitHash(sourceHash) || !validCommitHash(targetHash)) throw new Error('Capture complete branch revisions before comparing them.');
    const base = await this.json(`${this.repositoryPath(mapping)}/merge-base/${sourceHash}..${targetHash}`);
    return this.capturedCommit(mapping, base?.hash);
  }
  async findPullRequests(mapping: RepositoryMapping, sourceBranch: string, states: string[] = ['OPEN']): Promise<PullRequest[]> {
    if (!validBranchName(sourceBranch) || !states.length || states.some(state => !['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'].includes(state))) throw new Error('Choose a valid source branch and pull request states.');
    const query = new URLSearchParams({ pagelen: '50', q: `source.branch.name=${JSON.stringify(sourceBranch)}` });
    for (const state of new Set(states)) query.append('state', state);
    const values = await this.pages(`${this.repositoryPath(mapping)}/pullrequests?${query}`);
    const resolutions: CommitResolutions = new Map();
    const result: PullRequest[] = [];
    for (const value of values) {
      const pr = await this.responsePullRequest(mapping, value, 'list', true, resolutions);
      if (pr.sourceBranch !== sourceBranch || !states.includes(pr.state)) throw new Error('Bitbucket returned a pull request outside the requested branch or state. Refresh to retry.');
      result.push(pr);
    }
    return result;
  }
  async createPullRequest(mapping: RepositoryMapping, input: { sourceBranch: string; targetBranch: string; title: string; description: string }): Promise<PullRequest> {
    if (!input || !validBranchName(input.sourceBranch) || !validBranchName(input.targetBranch) || input.sourceBranch === input.targetBranch || typeof input.title !== 'string' || !input.title.trim() || typeof input.description !== 'string') throw new Error('Choose different source and target branches and enter a pull request title.');
    const value = await this.json(`${this.repositoryPath(mapping)}/pullrequests`, { method: 'POST', body: JSON.stringify({ title: input.title, description: input.description, source: { branch: { name: input.sourceBranch } }, destination: { branch: { name: input.targetBranch } }, close_source_branch: true }) });
    try {
      const pr = await this.responsePullRequest(mapping, value, 'detail');
      if (pr.sourceBranch !== input.sourceBranch || pr.targetBranch !== input.targetBranch || pr.state !== 'OPEN') throw new Error('Bitbucket accepted the request but returned a different branch pair or a closed pull request. Reconcile it before trying again.');
      return pr;
    } catch (error) {
      if (error instanceof ProviderError) throw new ProviderError(`${error.message} Bitbucket accepted PR creation; refresh to reconcile before retrying.`, undefined, error.retryAt, error.diagnosticId);
      throw error;
    }
  }
  async getPullRequest(mapping: RepositoryMapping, id: number): Promise<PullRequest> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('The pull request ID is invalid.');
    const pr = await this.responsePullRequest(mapping, await this.json(`${this.repositoryPath(mapping)}/pullrequests/${id}`), 'detail');
    if (!pr.mergeStrategies.length) {
      try {
        const branch = await this.json(`${this.repositoryPath(mapping)}/refs/branches/${encodeURIComponent(pr.targetBranch)}`);
        if (branch.name === pr.targetBranch && Array.isArray(branch.merge_strategies)) pr.mergeStrategies = branch.merge_strategies.filter((strategy: unknown) => typeof strategy === 'string');
      } catch { /* An unavailable branch policy must not prevent reading the review. */ }
    }
    try {
      const statuses = await this.pages(`${this.repositoryPath(mapping)}/commit/${pr.sourceHash}/statuses?pagelen=50`);
      Object.assign(pr, { checks: statuses.map(status => ({ name: typeof status.name === 'string' ? status.name : String(status.key ?? 'Check'), state: String(status.state ?? 'UNKNOWN'), ...(webLink(status.url) ? { url: webLink(status.url) } : {}) })) });
    } catch { /* Status visibility does not determine whether the PR can be reviewed. The merge endpoint enforces policy. */ }
    return pr;
  }
  private comment(value: any): RemoteComment {
    if (!value || !Number.isSafeInteger(value.id) || value.id < 1) throw new Error('Bitbucket returned an invalid comment.');
    return { id: value.id, authorId: identity(value.user), body: typeof value.content?.raw === 'string' ? value.content.raw : '', resolved: !!value.resolution, deleted: value.deleted === true,
      ...(typeof value.inline?.path === 'string' ? { path: value.inline.path } : {}),
      from: value.inline?.from, to: value.inline?.to, startFrom: value.inline?.start_from, startTo: value.inline?.start_to,
      createdAt: value.created_on, updatedAt: value.updated_on, url: webLink(value.links?.html?.href), };
  }
  async listComments(pr: PullRequest): Promise<RemoteComment[]> { return (await this.pages(`${this.prPath(pr)}/comments?pagelen=100`)).map(value => this.comment(value)); }
  async createComment(pr: PullRequest, payload: InlinePayload): Promise<RemoteComment> {
    if (!payload || typeof payload.content?.raw !== 'string' || !payload.content.raw.trim() || !validRelativePath(payload.inline?.path, false)) throw new Error('Choose a valid file and enter feedback.');
    return this.comment(await this.json(`${this.prPath(pr)}/comments`, { method: 'POST', body: JSON.stringify(payload) }));
  }
  private commentPath(pr: PullRequest, id: number): string { if (!Number.isSafeInteger(id) || id < 1) throw new Error('The comment ID is invalid.'); return `${this.prPath(pr)}/comments/${id}`; }
  async updateComment(pr: PullRequest, id: number, body: string): Promise<RemoteComment> {
    if (typeof body !== 'string' || !body.trim()) throw new Error('Enter feedback before updating the comment.');
    return this.comment(await this.json(this.commentPath(pr, id), { method: 'PUT', body: JSON.stringify({ content: { raw: body } }) }));
  }
  async deleteComment(pr: PullRequest, id: number): Promise<void> { await this.json(this.commentPath(pr, id), { method: 'DELETE' }); }
  async resolveComment(pr: PullRequest, id: number, resolved: boolean): Promise<void> { await this.json(`${this.commentPath(pr, id)}/resolve`, { method: resolved ? 'POST' : 'DELETE' }); }
  async approve(pr: PullRequest): Promise<void> { await this.json(`${this.prPath(pr)}/approve`, { method: 'POST' }); }
  async merge(pr: PullRequest): Promise<{ pr?: PullRequest; taskId?: string }> {
    const response = await this.request(`${this.prPath(pr)}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ type: 'pullrequest', merge_strategy: 'merge_commit', close_source_branch: true }) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Bitbucket redirected the merge request. Refresh its state before retrying.'); }
    const body = await readBoundedBody(response, 16 * 1024 * 1024);
    if (body.tooLarge || !body.bytes) throw new Error('Bitbucket returned an unreadable merge result. Refresh the PR before retrying.');
    let value: any;
    try { value = JSON.parse(body.bytes.toString('utf8')); } catch { throw new Error('Bitbucket returned an unreadable merge result. Refresh the PR before retrying.'); }
    if (response.status === 202) {
      const taskLink = value.links?.self?.href ?? response.headers.get('location');
      let taskId = value.task_id ?? value.taskId ?? value['task-id'];
      if (!taskId && typeof taskLink === 'string') { const url = new URL(taskLink, 'https://api.bitbucket.org'); if (url.origin !== 'https://api.bitbucket.org') throw new Error('Bitbucket returned an unsafe merge task URL.'); taskId = /\/merge\/task-status\/([^/?]+)$/.exec(url.pathname)?.[1]; }
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_{}-]+$/.test(taskId)) throw new Error('Bitbucket accepted the merge without a usable task ID. Refresh the PR before retrying.');
      return { taskId };
    }
    try { return { pr: await this.responsePullRequest(pr.repository, value, 'merge') }; }
    catch (error) {
      // A later commit lookup can fail after Bitbucket accepted the merge.
      // Its HTTP status cannot establish that the merge itself was rejected.
      if (error instanceof ProviderError) throw new ProviderError(`${error.message} Bitbucket accepted the merge; refresh to reconcile its result before retrying.`, undefined, error.retryAt, error.diagnosticId);
      throw error;
    }
  }
  async mergeStatus(pr: PullRequest, taskId: string): Promise<{ state: 'pending' | 'success' | 'failed'; error?: string }> {
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_{}-]+$/.test(taskId)) throw new Error('The merge task ID is invalid.');
    try {
      const result = await this.json(`${this.prPath(pr)}/merge/task-status/${encodeURIComponent(taskId)}`);
      if (result.task_status === 'SUCCESS') return { state: 'success' };
      if (result.task_status === 'PENDING') return { state: 'pending' };
      if (result.task_status === 'FAILED' || result.task_status === 'FAILURE') return { state: 'failed', error: 'Bitbucket reported that the merge task failed.' };
      throw new Error('Bitbucket returned an unrecognized merge task result. Refresh to reconcile before retrying.');
    } catch (error) {
      // A status-read permission or transport failure says nothing about whether
      // the already accepted merge ran. Only the documented task failure is final.
      if (error instanceof ProviderError && error.status === 400) return { state: 'failed', error: error.message };
      throw error;
    }
  }
  async branchExists(pr: PullRequest): Promise<boolean> {
    try { await this.json(`${this.repositoryPath(pr.repository)}/refs/branches/${encodeURIComponent(pr.sourceBranch)}`); return true; } catch (error) { if (error instanceof ProviderError && error.status === 404) return false; throw error; }
  }
  async checkWriteAccess(mapping: RepositoryMapping): Promise<void> {
    const query = `repository.full_name=${JSON.stringify(`${mapping.workspace}/${mapping.repoSlug}`)}`;
    const permissions = await this.pages(`/2.0/user/workspaces/${encodeURIComponent(mapping.workspace)}/permissions/repositories?q=${encodeURIComponent(query)}`);
    if (!permissions.some(value => ['write', 'admin'].includes(value.permission) && value.repository?.full_name?.toLowerCase() === `${mapping.workspace}/${mapping.repoSlug}`.toLowerCase())) throw new Error(`The connected account needs repository write access to update pointers in ${mapping.relativePath}.`);
  }
  async raw(path: string, limit = 1024 * 1024): Promise<RawFile> {
    const key = `${limit}:${path}`;
    const cached = this.rawCache.get(key);
    if (cached) return { ...cached, bytes: cached.bytes ? Buffer.from(cached.bytes) : null };
    const response = await this.request(path);
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { bytes: null, tooLarge: false, redirected: true }; }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Bitbucket did not return a complete file response.'); }
    const value: RawFile = { ...await readBoundedBody(response, limit), ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
    const bytes = value.bytes?.length ?? 0;
    while (this.rawCache.size && (this.cacheBytes + bytes > 24 * 1024 * 1024 || this.rawCache.size >= 2000)) { const first = this.rawCache.keys().next().value!; this.cacheBytes -= this.rawCache.get(first)?.bytes?.length ?? 0; this.rawCache.delete(first); }
    this.rawCache.set(key, value); this.cacheBytes += bytes;
    return { ...value, bytes: value.bytes ? Buffer.from(value.bytes) : null };
  }
  async fileMetadata(path: string): Promise<any> {
    if (this.metadataCache.has(path)) return this.metadataCache.get(path);
    const result = await this.json(path);
    if (this.metadataCache.size >= 4000) this.metadataCache.delete(this.metadataCache.keys().next().value!);
    this.metadataCache.set(path, result); return result;
  }
  async pointerEntries(pr: Pick<PullRequest, 'repository' | 'sourceHash'>): Promise<Array<{ path: string; hash: string }>> {
    const entries: Array<{ path: string; hash: string }> = [];
    const queue = [''];
    const seen = new Set<string>();
    while (queue.length) {
      const directory = queue.shift()!;
      if (seen.has(directory) || seen.size > 2000) throw new Error('The remote directory listing is incomplete.');
      seen.add(directory);
      for (const entry of await this.pages(`${this.repositoryPath(pr.repository)}/src/${pr.sourceHash}/${directory ? `${directory.split('/').map(encodeURIComponent).join('/')}/` : ''}?pagelen=100`)) {
        if (!validRelativePath(entry.path, false)) throw new Error('Bitbucket returned an unsafe repository path.');
        if (entry.type === 'commit_directory') queue.push(entry.path);
        else if (Array.isArray(entry.attributes) && entry.attributes.includes('subrepository')) {
          const value = await this.raw(`${this.repositoryPath(pr.repository)}/src/${pr.sourceHash}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, 1024);
          const hash = value.bytes?.toString('utf8').trim();
          if (!validCommitHash(hash)) throw new Error(`The pointer at ${entry.path} could not be read.`);
          entries.push({ path: entry.path, hash });
        }
      }
    }
    return entries;
  }
}
