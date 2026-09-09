import type { NewComment, Review, ReviewSnapshot } from '../shared/types';
import { currentReviewId } from '../shared/types';
import type { ConnectionInput, IntegrationState, ProjectIntegration, PullRequest, PullRequestFilter, PullRequestRef, ReanchorInput, RemoteReviewState } from '../shared/integrations';
import { extractJiraTicketKey, jiraTicketUrl } from '../shared/jira';
import { BitbucketClient } from './bitbucket-client';
import { ConnectionManager, type ConnectionCredentials } from './connection-manager';
import { IntegrationStore } from './integration-store';
import { buildRemoteSnapshot } from './remote-snapshot';
import { discoverRepositories, validateRepositoryMappings } from './repository-mapping';
import { ReviewStore } from './store';
import { ReviewService } from './review-service';
import { PointerService } from './pointer-service';
import { PublicationService } from './publication-service';
import { MergeService } from './merge-service';
import { inspectRepo } from './git';

export interface IntegrationDependencies {
  client?: (connectionId: string) => BitbucketClient;
  createClient?: (credentials: ConnectionCredentials) => BitbucketClient;
  snapshot?: typeof buildRemoteSnapshot;
  discover?: typeof discoverRepositories;
  inspect?: typeof inspectRepo;
}

export class IntegrationService {
  private pending = new Map<string, Promise<unknown>>();
  private localRefreshes = new Map<string, Set<Promise<unknown>>>();
  private connectionChange: Promise<unknown> | null = null;
  private snapshots = new Map<string, ReviewSnapshot>();
  private clients = new Map<string, BitbucketClient>();
  private publication: PublicationService;
  private merger: MergeService;
  private readonly client: (id: string) => BitbucketClient;
  constructor(private readonly reviews: ReviewStore, private readonly reviewService: ReviewService,
    private readonly state: IntegrationStore, private readonly connections: ConnectionManager,
    pointers: PointerService, private readonly dependencies: IntegrationDependencies = {}) {
    this.client = dependencies.client ?? (id => {
      const credentials = this.connections.credentials(id);
      if (credentials.info.kind !== 'bitbucket') throw new Error('Select a Bitbucket connection.');
      let client = this.clients.get(id);
      if (!client) { client = this.dependencies.createClient?.(credentials) ?? new BitbucketClient(credentials); this.clients.set(id, client); }
      return client;
    });
    this.publication = new PublicationService(reviews, state, this.client, id => this.snapshots.get(id), id => this.connections.credentials(id).info.accountId);
    this.merger = new MergeService(reviews, state, connections, this.client, id => this.snapshots.get(id), pointers);
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.connectionChange) return Promise.reject(new Error('Wait for the connection change to finish before continuing.'));
    const operation = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      const review = this.reviews.getState().reviews.find(review => review.id === id);
      if (review && this.pending.has(`project:${review.projectId}`)) throw new Error('Wait for project integration settings to finish before reviewing.');
      return fn();
    });
    this.pending.set(id, operation);
    const cleanup = () => { if (this.pending.get(id) === operation) this.pending.delete(id); };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  /** Track scans for shutdown/settings without placing them ahead of local saves. */
  private trackLocalRefresh<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.connectionChange) return Promise.reject(new Error('Wait for the connection change to finish before continuing.'));
    const operation = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      const review = this.reviews.getReview(id);
      if (this.pending.has(`project:${review.projectId}`)) throw new Error('Wait for project integration settings to finish before reviewing.');
      return fn();
    });
    const active = this.localRefreshes.get(id) ?? new Set<Promise<unknown>>();
    active.add(operation); this.localRefreshes.set(id, active);
    const cleanup = () => {
      active.delete(operation);
      if (!active.size && this.localRefreshes.get(id) === active) this.localRefreshes.delete(id);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  get busy(): boolean { return this.pending.size > 0 || this.localRefreshes.size > 0 || this.connectionChange !== null; }
  async idle(): Promise<void> {
    while (this.busy) await Promise.allSettled([...this.pending.values(), ...[...this.localRefreshes.values()].flatMap(active => [...active]), ...(this.connectionChange ? [this.connectionChange] : [])]);
  }
  private changeConnections<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new Error('Wait for the current integration operation before changing accounts.'));
    const operation = Promise.resolve().then(fn);
    this.connectionChange = operation;
    const cleanup = () => { if (this.connectionChange === operation) this.connectionChange = null; };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  getIntegrations(): IntegrationState { return { connections: this.connections.list(), projects: this.state.projects() }; }
  saveConnection(input: ConnectionInput) { return this.changeConnections(async () => {
    if (input.id) {
      const previous = this.connections.list().find(c => c.id === input.id);
      if (previous && (previous.kind !== input.kind || previous.email.toLowerCase() !== input.email.trim().toLowerCase())) throw new Error('Add a separate connection when changing accounts. Existing PR reviews stay with their original account.');
    }
    const result = await this.connections.save(input); this.clients.delete(result.id); return result;
  }); }
  testConnection(id: string) { return this.changeConnections(async () => { try { return await this.connections.test(id); } finally { this.clients.delete(id); } }); }
  disconnectConnection(id: string) { return this.changeConnections(async () => {
    await this.connections.disconnect(id); this.clients.delete(id); return this.getIntegrations();
  }); }
  configureProjectIntegration(projectId: string, input: ProjectIntegration): Promise<ProjectIntegration> {
    return this.serial(`project:${projectId}`, async () => {
      this.reviews.getProject(projectId);
      if (this.reviews.getState().reviews.some(review => review.projectId === projectId && (this.pending.has(review.id) || this.localRefreshes.has(review.id)))) throw new Error('Wait for the project’s current review operation before changing its integrations.');
      if (!input || typeof input !== 'object' || typeof input.updateSubmodulePointers !== 'boolean') throw new Error('Provide valid project integration settings.');
      for (const [key, kind] of [['jiraConnectionId', 'jira'], ['bitbucketConnectionId', 'bitbucket']] as const) {
        if (input[key] && !this.connections.list().some(c => c.id === input[key] && c.kind === kind)) throw new Error(`Choose an available ${kind} connection.`);
      }
      const repositories = validateRepositoryMappings(input.repositories);
      return this.state.setProject(projectId, { jiraConnectionId: input.jiraConnectionId || undefined, bitbucketConnectionId: input.bitbucketConnectionId || undefined,
        updateSubmodulePointers: input.updateSubmodulePointers, repositories });
    });
  }
  discoverRepositories(projectId: string) { return (this.dependencies.discover ?? discoverRepositories)(this.reviews.getProject(projectId).repoPath); }
  listPullRequests(projectId: string, filter: PullRequestFilter) { return this.serial(`inbox:${projectId}`, async () => {
    this.reviews.getProject(projectId);
    if (!['all', 'reviewer', 'author'].includes(filter)) throw new Error('Choose a PR filter.');
    const settings = this.state.project(projectId);
    if (!settings.bitbucketConnectionId) throw new Error('Connect Bitbucket in project integrations first.');
    const client = this.client(settings.bitbucketConnectionId);
    const accountId = this.connections.credentials(settings.bitbucketConnectionId).info.accountId;
    const result = [];
    for (const repository of settings.repositories) result.push(...await client.listPullRequests(repository));
    return result.filter(pr => filter === 'all' || (filter === 'author' ? pr.author.id === accountId : pr.reviewers.some(r => r.id === accountId) && !pr.participants.some(p => p.id === accountId && p.approved)));
  }); }
  openPullRequestReview(projectId: string, refs: PullRequestRef[]): Promise<Review> {
    return this.serial(`project:${projectId}`, async () => {
      this.reviews.getProject(projectId);
      const settings = this.state.project(projectId);
      if (!settings.bitbucketConnectionId) throw new Error('Choose a Bitbucket connection for this project.');
      if (!Array.isArray(refs) || !refs.length || refs.length > 100 || refs.some(ref => !ref || typeof ref !== 'object' || typeof ref.repositoryPath !== 'string')
        || new Set(refs.map(r => r.repositoryPath)).size !== refs.length) throw new Error('Select one PR per participating repository.');
      const client = this.client(settings.bitbucketConnectionId);
      const prs: PullRequest[] = [];
      for (const ref of refs) {
        const repo = settings.repositories.find(r => r.relativePath === ref.repositoryPath);
        if (!repo || !Number.isSafeInteger(ref.prId) || ref.prId < 1) throw new Error('Choose a PR from a mapped project repository.');
        const pr = await client.getPullRequest(repo, ref.prId);
        if (pr.id !== ref.prId || pr.repository.relativePath !== repo.relativePath
          || pr.repository.workspace.toLowerCase() !== repo.workspace.toLowerCase() || pr.repository.repoSlug.toLowerCase() !== repo.repoSlug.toLowerCase()
          || (repo.uuid && pr.repository.uuid && repo.uuid !== pr.repository.uuid)) throw new Error('Bitbucket returned a PR that does not match the selected repository and ID.');
        if (pr.unsupportedReason) throw new Error(pr.unsupportedReason);
        if (pr.state !== 'OPEN') throw new Error(`${repo.relativePath} #${pr.id} is no longer open.`);
        prs.push(pr);
      }
      if (prs.some(pr => pr.sourceBranch !== prs[0].sourceBranch || pr.targetBranch !== prs[0].targetBranch)) throw new Error('Grouped PRs must use matching source and target branch names.');
      const selectionKey = (value: typeof prs) => value.map(pr => `${pr.repository.workspace}/${pr.repository.repoSlug}#${pr.id}`).sort().join('|');
      for (const review of this.reviews.getState().reviews.filter(r => r.projectId === projectId && r.remote)) {
        const binding = this.state.review(review.id);
        if (binding?.connectionId === settings.bitbucketConnectionId && selectionKey(binding.pullRequests) === selectionKey(prs)) return review;
      }
      const first = prs[0];
      const review = await this.reviews.createReview({ projectId, name: `${first.sourceBranch} · ${prs.length} PR${prs.length === 1 ? '' : 's'}`.slice(0, 200), featureBranch: first.sourceBranch, baseBranch: first.targetBranch, includeWorkingTree: false }, true);
      try { await this.state.setReview(review.id, { connectionId: settings.bitbucketConnectionId, pullRequests: prs, publications: {} }); }
      catch (error) { await this.reviews.deleteReview(review.id); throw error; }
      return review;
    });
  }
  getRemoteReview(id: string): RemoteReviewState | null { this.reviews.getReview(id); return this.state.review(id); }
  /** Invoked only through ReviewService's serialized snapshot callback. */
  async buildSnapshot(review: Review): Promise<ReviewSnapshot> {
    if (this.connectionChange) throw new Error('Wait for the connection change to finish before refreshing.');
    const binding = this.state.review(review.id);
    if (!binding) throw new Error('This PR review has lost its integration metadata. Reconnect and reopen the PR; your local feedback is preserved.');
    const client = this.client(binding.connectionId);
    const result = await (this.dependencies.snapshot ?? buildRemoteSnapshot)(client, review.id, binding.pullRequests);
    await this.state.updateReview(review.id, r => { r.pullRequests = result.pullRequests; });
    this.snapshots.set(review.id, result.snapshot);
    return result.snapshot;
  }
  setCurrentTarget(projectId: string, target: string) {
    return this.trackLocalRefresh(currentReviewId(projectId), () => this.reviewService.setCurrentTarget(projectId, target));
  }
  async refreshReview(id: string) {
    if (!this.reviews.getReview(id).remote) return this.trackLocalRefresh(id, () => this.reviewService.refreshReview(id));
    return this.serial(id, async () => {
      const result = await this.reviewService.refreshReview(id);
      if (result.review.remote) {
        try { await this.publication.reconcile(id); result.review = this.reviews.getReview(id); }
        catch (error) { result.snapshot.warnings.push(`Feedback sync: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return result;
    });
  }
  addComment(id: string, input: NewComment, contextKey?: string) { return this.serial(id, async () => {
    const result = await this.reviewService.addComment(id, input, contextKey);
    if (result.remote) await this.publication.capture(id);
    return result;
  }); }
  updateComment(id: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string) { return this.serial(id, () => this.reviewService.updateComment(id, commentId, changes, contextKey)); }
  deleteComment(id: string, commentId: string, contextKey?: string) { return this.serial(id, async () => {
    const review = this.reviews.getReview(id);
    if (review.remote) {
      await this.publication.capture(id);
      await this.state.updateReview(id, r => { if (r.publications[commentId]) r.publications[commentId].backup = review.comments.find(c => c.id === commentId); });
    }
    return this.reviewService.deleteComment(id, commentId, contextKey);
  }); }
  setApprovals(id: string, files: { fileId: string; fingerprint: string }[], approved: boolean, contextKey?: string) { return this.serial(id, () => this.reviewService.setApprovals(id, files, approved, contextKey)); }
  copyFeedback(id: string, contextKey?: string) { return this.serial(id, () => this.reviewService.copyFeedback(id, contextKey)); }
  previewFeedback(id: string) { return this.serial(id, () => this.publication.preview(id)); }
  publishFeedback(id: string) { return this.serial(id, () => this.publication.publish(id)); }
  reanchorComment(id: string, commentId: string, input: ReanchorInput) { return this.serial(id, () => this.publication.reanchor(id, commentId, input)); }
  resolveCommentConflict(id: string, commentId: string, choice: 'local' | 'remote') { return this.serial(id, () => this.publication.resolveConflict(id, commentId, choice)); }
  resolveUnknownPublication(id: string, commentId: string, remoteId: number | null) { return this.serial(id, () => this.publication.resolveUnknown(id, commentId, remoteId)); }
  previewMerge(id: string, action: 'approve' | 'merge' = 'merge') { return this.serial(id, () => this.merger.preview(id, action)); }
  runPullRequestAction(id: string, action: 'approve' | 'merge') { return this.serial(id, () => this.merger.run(id, action)); }
  async setReviewTicket(id: string, key: string) {
    this.reviews.getReview(id);
    if (typeof key !== 'string' || (key.trim() && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(key.trim()))) throw new Error('Enter a Jira issue key such as APP-123.');
    await this.state.setTicket(id, key.trim().toUpperCase());
  }
  /** Browser navigation uses saved site metadata, so it remains available during a merge or after token expiry. */
  async getJiraTicketLink(id: string): Promise<{ key: string; url: string } | null> {
    const review = this.reviews.getReview(id);
    const project = this.state.project(review.projectId);
    const connection = project.jiraConnectionId ? this.connections.list().find(value => value.id === project.jiraConnectionId && value.kind === 'jira') : undefined;
    if (project.jiraConnectionId && !connection?.siteUrl) throw new Error('The project’s Jira account is unavailable. Choose its Jira connection in Project integrations.');
    const baseUrl = connection?.siteUrl || this.reviews.getSettings().jiraBaseUrl;
    if (!baseUrl) return null;
    let key = this.state.ticket(id);
    if (!key) {
      const branch = review.kind === 'current' ? (await (this.dependencies.inspect ?? inspectRepo)(review.repoPath)).currentBranch : review.featureBranch;
      key = extractJiraTicketKey(branch ?? '') ?? undefined;
    }
    return key ? { key: key.toUpperCase(), url: jiraTicketUrl(baseUrl, key) } : null;
  }
  getJiraIssue(id: string, override?: string) { return this.serial(id, async () => {
    const review = this.reviews.getReview(id);
    const settings = this.state.project(review.projectId);
    if (!settings.jiraConnectionId) throw new Error('Choose a Jira connection in project integrations.');
    let key = override || this.state.ticket(id);
    if (!key) {
      const branch = review.kind === 'current' ? (await (this.dependencies.inspect ?? inspectRepo)(review.repoPath)).currentBranch : review.featureBranch;
      key = extractJiraTicketKey(branch ?? '') ?? undefined;
    }
    if (!key || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(key)) throw new Error('Enter a Jira ticket key to show its details.');
    return this.connections.getIssue(settings.jiraConnectionId, key.toUpperCase());
  }); }
  validateLink(value: string): string {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Choose a valid HTTPS integration link.');
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Choose a valid HTTPS integration link.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Choose a valid HTTPS integration link without embedded credentials.');
    return url.href;
  }
  deleteReview(id: string) { return this.serial(id, async () => {
    const operation = this.state.review(id)?.operation;
    if (operation && operation.state !== 'complete' && operation.items.some(item => ['sending', 'merging', 'unknown', 'merged'].includes(item.merge) || item.pointerCommit)) throw new Error('Finish or reconcile this merge operation before removing its review.');
    const result = await this.reviewService.deleteReview(id); await this.state.removeReview(id); this.snapshots.delete(id); return result;
  }); }
  async deleteProject(id: string) {
    if (this.busy) throw new Error('Wait for current integration work before removing a project.');
    const reviewIds = this.reviews.getState().reviews.filter(r => r.projectId === id).map(r => r.id);
    if (reviewIds.some(reviewId => { const op = this.state.review(reviewId)?.operation; return op && op.state !== 'complete'; })) throw new Error('Complete the project’s pending PR operations before removing it.');
    const result = await this.reviewService.deleteProject(id); await this.state.removeProject(id, reviewIds); reviewIds.forEach(id => this.snapshots.delete(id)); return result;
  }
}
