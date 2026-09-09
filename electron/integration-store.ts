import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectIntegration, RemoteReviewChanged, RemoteReviewState } from '../shared/integrations';
import { pullRequestKey } from '../shared/integrations';
import { validRelativePath, validateRepositoryMappings } from './repository-mapping';

interface StoredIntegrations { version: 1; projects: Record<string, ProjectIntegration>; reviews: Record<string, RemoteReviewState>; tickets: Record<string, string>; }
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const identifier = (id: string) => { if (typeof id !== 'string' || !id || ['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('Invalid integration identifier.'); };
const string = (value: unknown): value is string => typeof value === 'string';
const hash = (value: unknown) => string(value) && /^[a-f0-9]{40,64}$/i.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const optional = (value: unknown, check: (value: any) => boolean) => value === undefined || check(value);
const oneOf = (value: unknown, choices: string[]) => string(value) && choices.includes(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(string);
const date = (value: unknown) => string(value) && Number.isFinite(Date.parse(value));
const ticket = (value: unknown) => string(value) && /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(value);
const range = (value: Record<string, any>) => Number.isSafeInteger(value.lineStart) && Number.isSafeInteger(value.lineEnd)
  && (value.lineStart === 0 && value.lineEnd === 0 || value.lineStart > 0 && value.lineEnd >= value.lineStart);
const published = (value: unknown) => record(value) && string(value.body) && typeof value.resolved === 'boolean' && typeof value.deleted === 'boolean';
const person = (value: unknown) => record(value) && string(value.id) && string(value.name);
const safeUrl = (value: unknown) => { if (!string(value) || /[\u0000-\u001f\u007f]/.test(value)) return false; try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };

function validateState(value: unknown): asserts value is StoredIntegrations {
  const require = (condition: unknown) => { if (!condition) throw new Error('The saved integration file is invalid. It has been left untouched.'); };
  require(record(value));
  const data = value as Record<string, any>;
  require(data.version === 1 && record(data.projects) && record(data.reviews) && record(data.tickets));
  for (const id of [...Object.keys(data.projects), ...Object.keys(data.reviews), ...Object.keys(data.tickets)]) identifier(id);
  for (const project of Object.values(data.projects) as any[]) {
    require(record(project) && typeof project.updateSubmodulePointers === 'boolean'
      && optional(project.jiraConnectionId, string) && optional(project.bitbucketConnectionId, string));
    validateRepositoryMappings(project.repositories);
    for (const id of [project.jiraConnectionId, project.bitbucketConnectionId]) if (id !== undefined) identifier(id);
  }
  for (const review of Object.values(data.reviews) as any[]) {
    require(record(review) && string(review.connectionId) && Array.isArray(review.pullRequests) && review.pullRequests.length > 0
      && review.pullRequests.length <= 100 && record(review.publications) && optional(review.ticketKey, ticket));
    identifier(review.connectionId);
    validateRepositoryMappings(review.pullRequests.map((pr: any) => pr?.repository));
    for (const pr of review.pullRequests) {
      require(record(pr) && positive(pr.id) && string(pr.title) && safeUrl(pr.url) && string(pr.sourceBranch) && !!pr.sourceBranch
        && string(pr.targetBranch) && !!pr.targetBranch && hash(pr.sourceHash) && hash(pr.targetHash) && person(pr.author)
        && Array.isArray(pr.reviewers) && pr.reviewers.every(person) && Array.isArray(pr.participants)
        && pr.participants.every((p: unknown) => record(p) && string(p.id) && typeof p.approved === 'boolean')
        && string(pr.state) && typeof pr.draft === 'boolean' && strings(pr.mergeStrategies) && optional(pr.mergeCommit, hash) && optional(pr.mergeBaseHash, hash)
        && optional(pr.sourceRepositoryUuid, string) && optional(pr.destinationRepositoryUuid, string)
        && optional(pr.taskCount, n => Number.isSafeInteger(n) && n >= 0) && optional(pr.unsupportedReason, string)
        && optional(pr.checks, checks => Array.isArray(checks) && checks.every(c => record(c) && string(c.name) && string(c.state) && optional(c.url, safeUrl))));
    }
    const prKeys = new Set(review.pullRequests.map(pullRequestKey));
    for (const [id, publication] of Object.entries(review.publications) as [string, any][]) {
      identifier(id);
      require(record(publication) && publication.commentId === id && record(publication.anchor));
      const anchor = publication.anchor;
      require(prKeys.has(anchor.prKey) && hash(anchor.sourceHash) && hash(anchor.targetHash) && validRelativePath(anchor.path, false)
        && oneOf(anchor.side, ['additions', 'deletions']) && range(anchor) && string(anchor.fingerprint) && !!anchor.fingerprint);
      require(oneOf(publication.state, ['draft', 'sending', 'synced', 'failed', 'unknown', 'conflict'])
        && optional(publication.action, v => oneOf(v, ['create', 'update', 'delete', 'resolve', 'reopen']))
        && optional(publication.remoteId, positive) && optional(publication.authorId, string) && optional(publication.url, safeUrl)
        && optional(publication.acknowledged, published) && optional(publication.intended, published) && optional(publication.remote, published)
        && optional(publication.error, string) && optional(publication.startedAt, date)
        && optional(publication.baselineIds, ids => Array.isArray(ids) && ids.every(positive)));
      const backup = publication.backup;
      require(optional(backup, b => record(b) && b.id === id && string(b.fileId) && validRelativePath(b.repoRelativePath)
        && validRelativePath(b.path, false) && oneOf(b.side, ['additions', 'deletions']) && range(b)
        && string(b.body) && string(b.fingerprint) && string(b.context) && optional(b.contextBefore, string)
        && optional(b.contextAfter, string) && date(b.createdAt) && typeof b.resolved === 'boolean'));
    }
    if (review.operation !== undefined) {
      const op = review.operation;
      require(record(op) && oneOf(op.action, ['approve', 'merge']) && oneOf(op.state, ['running', 'paused', 'complete'])
        && date(op.updatedAt) && optional(op.error, string) && Array.isArray(op.items) && op.items.length <= review.pullRequests.length);
      const seen = new Set<string>();
      for (const item of op.items) {
        require(record(item) && prKeys.has(item.prKey) && !seen.has(item.prKey) && hash(item.sourceHash) && hash(item.targetHash)
          && oneOf(item.approval, ['pending', 'approved', 'failed']) && oneOf(item.merge, ['pending', 'sending', 'merging', 'merged', 'failed', 'unknown'])
          && optional(item.mergeCommit, hash) && optional(item.taskId, v => string(v) && /^[a-zA-Z0-9_{}-]+$/.test(v))
          && optional(item.cleanup, v => oneOf(v, ['deleted', 'retained', 'unknown'])) && optional(item.error, string)
          && optional(item.phase, v => oneOf(v, ['checking', 'approving', 'merging', 'cleanup', 'updating-pointers']))
          && optional(item.skipped, v => typeof v === 'boolean') && (item.skipped !== true || item.merge === 'merged')
          && optional(item.pointerCommit, hash) && optional(item.pointerBase, hash)
          && optional(item.pointerState, v => oneOf(v, ['prepared', 'pushing', 'review', 'ready']))
          && optional(item.pointerChildren, children => record(children) && Object.entries(children).every(([p, h]) => validRelativePath(p, false) && hash(h))));
        seen.add(item.prKey);
      }
    }
  }
  require(Object.values(data.tickets).every(ticket));
}

/** Credentials live in a separate encrypted store. Writes become visible only after rename. */
export class IntegrationStore {
  private state: StoredIntegrations = { version: 1, projects: {}, reviews: {}, tickets: {} };
  private pending: Promise<unknown> = Promise.resolve();
  private loadError: Error | null = null;
  private readonly reviewListeners = new Set<(event: RemoteReviewChanged) => void>();
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.loadError = new Error('The saved integration file could not be read. It has been left untouched.');
      throw this.loadError;
    }
    try { validateState(parsed); }
    catch { this.loadError = new Error('The saved integration file is invalid. It has been left untouched.'); throw this.loadError; }
    this.state = parsed;
    this.loadError = null;
    // A process can disappear after the server accepted a request. Never blindly repeat it.
    for (const review of Object.values(this.state.reviews)) {
      for (const publication of Object.values(review.publications)) {
        if (publication.state === 'sending') { publication.state = 'unknown'; publication.error = 'Delivery is unknown after restart. Reconcile before retrying.'; }
      }
      if (review.operation?.state === 'running') {
        review.operation.state = 'paused';
        review.operation.error = 'The previous operation was interrupted. Resume to reconcile its remote results.';
        for (const item of review.operation.items) {
          if (item.merge === 'sending') item.merge = 'unknown';
          delete item.phase;
        }
      }
    }
  }
  projects(): Record<string, ProjectIntegration> { return structuredClone(this.state.projects); }
  project(id: string): ProjectIntegration { identifier(id); return structuredClone(this.state.projects[id] ?? { repositories: [], updateSubmodulePointers: false }); }
  review(id: string): RemoteReviewState | null { identifier(id); return structuredClone(this.state.reviews[id] ?? null); }
  ticket(id: string): string | undefined { identifier(id); return this.state.tickets[id]; }
  onReviewChanged(callback: (event: RemoteReviewChanged) => void): () => void {
    this.reviewListeners.add(callback);
    return () => { this.reviewListeners.delete(callback); };
  }
  private write<T>(fn: (next: StoredIntegrations) => T, changedReviewId?: string): Promise<T> {
    const operation = this.pending.then(async () => {
      if (this.loadError) throw this.loadError;
      const next = structuredClone(this.state);
      const value = fn(next);
      validateState(next);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.state = next;
      if (changedReviewId && next.reviews[changedReviewId]) {
        for (const callback of this.reviewListeners) {
          // A disappearing renderer must not turn an acknowledged write into a
          // failed operation. Each subscriber receives an independent snapshot.
          try { callback({ reviewId: changedReviewId, state: structuredClone(next.reviews[changedReviewId]) }); } catch { /* The committed state remains authoritative. */ }
        }
      }
      return structuredClone(value);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  setProject(id: string, value: ProjectIntegration): Promise<ProjectIntegration> { identifier(id); return this.write(next => next.projects[id] = structuredClone(value)); }
  setReview(id: string, value: RemoteReviewState): Promise<RemoteReviewState> { identifier(id); return this.write(next => next.reviews[id] = structuredClone(value), id); }
  updateReview(id: string, fn: (value: RemoteReviewState) => void): Promise<RemoteReviewState> {
    identifier(id); return this.write(next => { const review = next.reviews[id]; if (!review) throw new Error('This remote review is unavailable.'); fn(review); return review; }, id);
  }
  setTicket(id: string, key: string): Promise<void> { identifier(id); return this.write(next => { if (key) next.tickets[id] = key; else delete next.tickets[id]; }); }
  removeReview(id: string): Promise<void> { identifier(id); return this.write(next => { delete next.reviews[id]; delete next.tickets[id]; }); }
  removeProject(id: string, reviewIds: string[]): Promise<void> { identifier(id); reviewIds.forEach(identifier); return this.write(next => { delete next.projects[id]; for (const reviewId of reviewIds) { delete next.reviews[reviewId]; delete next.tickets[reviewId]; } }); }
}
