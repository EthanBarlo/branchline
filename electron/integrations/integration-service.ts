import { JiraTicketService } from './jira/jira-ticket-service';
import { ClosedReviewService } from './bitbucket/closed-review-service';
import { validateIntegrationLink } from './integration-links';
import type { NewComment, Review, ReviewSnapshot, ReviewRefresh } from '../../shared/types';
import { currentReviewId, reviewContextKey } from '../../shared/types';
import type {
  BranchReviewRepository,
  ClosedReviewCheck,
  ClosedReviewCleanupResult,
  ConnectionInput,
  IntegrationState,
  ProjectIntegration,
  PullRequestFilter,
  PullRequestRef,
  ReanchorInput,
  RemoteReviewState,
  RemoteReviewLoadProgress,
  RemoteRepositoryLoad,
  RemoteSnapshotResult,
} from '../../shared/integrations';
import { isMergeComplete } from '../../shared/integrations';
import { BitbucketClient } from './bitbucket/bitbucket-client';
import { ConnectionManager, type ConnectionCredentials } from './connection-manager';
import { IntegrationStore } from './integration-store';
import { buildRemoteSnapshot, buildRemoteRepositorySnapshot } from './bitbucket/remote-snapshot';
import { mapConcurrent } from './concurrency';
import { discoverRepositories, validateRepositoryMappings } from './repository-mapping';
import { ReviewStore } from '../reviews/review-store';
import { ReviewService } from '../reviews/review-service';
import { PointerService } from '../git/pointer-service';
import { PublicationService } from './bitbucket/publication-service';
import { MergeService } from './bitbucket/merge-service';
import { BranchReviewService } from './bitbucket/branch-review-service';
import { inspectRepo } from '../git/repository';

export interface IntegrationDependencies {
  client?: (connectionId: string) => BitbucketClient;
  createClient?: (credentials: ConnectionCredentials) => BitbucketClient;
  snapshot?: typeof buildRemoteSnapshot;
  repositorySnapshot?: typeof buildRemoteRepositorySnapshot;
  discover?: typeof discoverRepositories;
  inspect?: typeof inspectRepo;
}

export class IntegrationService {
  private pending = new Map<string, Promise<unknown>>();
  private localRefreshes = new Map<string, Set<Promise<unknown>>>();
  private connectionChange: Promise<unknown> | null = null;
  private snapshots = new Map<string, ReviewSnapshot>();
  private clients = new Map<string, BitbucketClient>();
  private remoteRefreshes = new Map<string, Promise<ReviewRefresh>>();
  // Keep project ownership when the review write succeeds but metadata cleanup fails.
  private closedReviewRemovals = new Map<string, { projectId: string; check: ClosedReviewCheck }>();
  private failedLoads = new Map<string, string>();
  private loadProgress = new Map<string, RemoteReviewLoadProgress>();
  private loadListeners = new Set<(event: RemoteReviewLoadProgress) => void>();
  private loadSequence = 0;
  private publication: PublicationService;
  private merger: MergeService;
  private branches: BranchReviewService;
  private jira: JiraTicketService;
  private closedReviews: ClosedReviewService;
  private readonly client: (id: string) => BitbucketClient;
  constructor(
    private readonly reviews: ReviewStore,
    private readonly reviewService: ReviewService,
    private readonly state: IntegrationStore,
    private readonly connections: ConnectionManager,
    pointers: PointerService,
    private readonly dependencies: IntegrationDependencies = {},
  ) {
    this.client =
      dependencies.client ??
      ((id) => {
        const credentials = this.connections.credentials(id);
        if (credentials.info.kind !== 'bitbucket') throw new Error('Select a Bitbucket connection.');
        let client = this.clients.get(id);
        if (!client) {
          client = this.dependencies.createClient?.(credentials) ?? new BitbucketClient(credentials);
          this.clients.set(id, client);
        }
        return client;
      });
    this.jira = new JiraTicketService(
      reviews,
      state,
      connections,
      (id, operation) => this.trackLocalRefresh(id, operation),
      dependencies.inspect,
    );
    this.closedReviews = new ClosedReviewService(
      reviews,
      state,
      this.client,
      (id) => this.closedReviewRemovals.get(id)?.check.name,
    );
    this.branches = new BranchReviewService(reviews, state, this.client, (id) => this.snapshots.get(id));
    this.publication = new PublicationService(
      reviews,
      state,
      this.client,
      (id) => this.snapshots.get(id),
      (id) => this.connections.credentials(id).info.accountId,
      this.branches,
    );
    this.merger = new MergeService(
      reviews,
      state,
      connections,
      this.client,
      (id) => this.snapshots.get(id),
      pointers,
      {},
      this.branches,
    );
  }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.connectionChange)
      return Promise.reject(new Error('Wait for the connection change to finish before continuing.'));
    const operation = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const review = this.reviews.getState().reviews.find((review) => review.id === id);
        if (review && this.pending.has(`project:${review.projectId}`))
          throw new Error('Wait for project integration settings to finish before reviewing.');
        return fn();
      });
    this.pending.set(id, operation);
    const cleanup = () => {
      if (this.pending.get(id) === operation) this.pending.delete(id);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  /** Track scans for shutdown/settings without placing them ahead of local saves. */
  private trackLocalRefresh<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.connectionChange)
      return Promise.reject(new Error('Wait for the connection change to finish before continuing.'));
    const operation = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const review = this.reviews.getReview(id);
        if (this.pending.has(`project:${review.projectId}`))
          throw new Error('Wait for project integration settings to finish before reviewing.');
        return fn();
      });
    const active = this.localRefreshes.get(id) ?? new Set<Promise<unknown>>();
    active.add(operation);
    this.localRefreshes.set(id, active);
    const cleanup = () => {
      active.delete(operation);
      if (!active.size && this.localRefreshes.get(id) === active) this.localRefreshes.delete(id);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  get busy(): boolean {
    return this.pending.size > 0 || this.localRefreshes.size > 0 || this.connectionChange !== null;
  }
  async idle(): Promise<void> {
    while (this.busy)
      await Promise.allSettled([
        ...this.pending.values(),
        ...[...this.localRefreshes.values()].flatMap((active) => [...active]),
        ...(this.connectionChange ? [this.connectionChange] : []),
      ]);
  }
  private changeConnections<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy)
      return Promise.reject(
        new Error('Wait for the current integration operation before changing accounts.'),
      );
    const operation = Promise.resolve().then(fn);
    this.connectionChange = operation;
    const cleanup = () => {
      if (this.connectionChange === operation) this.connectionChange = null;
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  getIntegrations(): IntegrationState {
    return { connections: this.connections.list(), projects: this.state.projects() };
  }
  saveConnection(input: ConnectionInput) {
    return this.changeConnections(async () => {
      if (input.id) {
        const previous = this.connections.list().find((c) => c.id === input.id);
        if (
          previous &&
          (previous.kind !== input.kind || previous.email.toLowerCase() !== input.email.trim().toLowerCase())
        )
          throw new Error(
            'Add a separate connection when changing accounts. Existing PR reviews stay with their original account.',
          );
      }
      const result = await this.connections.save(input);
      this.clients.delete(result.id);
      return result;
    });
  }
  testConnection(id: string) {
    return this.changeConnections(async () => {
      try {
        return await this.connections.test(id);
      } finally {
        this.clients.delete(id);
      }
    });
  }
  disconnectConnection(id: string) {
    return this.changeConnections(async () => {
      await this.connections.disconnect(id);
      this.clients.delete(id);
      return this.getIntegrations();
    });
  }
  configureProjectIntegration(projectId: string, input: ProjectIntegration): Promise<ProjectIntegration> {
    return this.serial(`project:${projectId}`, async () => {
      this.reviews.getProject(projectId);
      if (
        this.reviews
          .getState()
          .reviews.some(
            (review) =>
              review.projectId === projectId &&
              (this.pending.has(review.id) || this.localRefreshes.has(review.id)),
          )
      )
        throw new Error('Wait for the project’s current review operation before changing its integrations.');
      if (!input || typeof input !== 'object' || typeof input.updateSubmodulePointers !== 'boolean')
        throw new Error('Provide valid project integration settings.');
      for (const [key, kind] of [
        ['jiraConnectionId', 'jira'],
        ['bitbucketConnectionId', 'bitbucket'],
      ] as const) {
        if (input[key] && !this.connections.list().some((c) => c.id === input[key] && c.kind === kind))
          throw new Error(`Choose an available ${kind} connection.`);
      }
      const repositories = validateRepositoryMappings(input.repositories);
      return this.state.setProject(projectId, {
        jiraConnectionId: input.jiraConnectionId || undefined,
        bitbucketConnectionId: input.bitbucketConnectionId || undefined,
        updateSubmodulePointers: input.updateSubmodulePointers,
        repositories,
      });
    });
  }
  discoverRepositories(projectId: string) {
    return (this.dependencies.discover ?? discoverRepositories)(this.reviews.getProject(projectId).repoPath);
  }
  listPullRequests(projectId: string, filter: PullRequestFilter) {
    return this.serial(`inbox:${projectId}`, async () => {
      this.reviews.getProject(projectId);
      if (!['all', 'reviewer', 'author'].includes(filter)) throw new Error('Choose a PR filter.');
      const settings = this.state.project(projectId);
      if (!settings.bitbucketConnectionId)
        throw new Error('Connect Bitbucket in project integrations first.');
      const client = this.client(settings.bitbucketConnectionId);
      const accountId = this.connections.credentials(settings.bitbucketConnectionId).info.accountId;
      const result = (
        await mapConcurrent(settings.repositories, 4, (repository) => client.listPullRequests(repository))
      ).flat();
      return result.filter(
        (pr) =>
          filter === 'all' ||
          (filter === 'author'
            ? pr.author.id === accountId
            : pr.reviewers.some((r) => r.id === accountId) &&
              !pr.participants.some((p) => p.id === accountId && p.approved)),
      );
    });
  }
  openPullRequestReview(projectId: string, refs: PullRequestRef[]): Promise<Review> {
    return this.serial(`project:${projectId}`, async () => {
      this.reviews.getProject(projectId);
      const settings = this.state.project(projectId);
      if (!settings.bitbucketConnectionId) throw new Error('Choose a Bitbucket connection for this project.');
      if (
        !Array.isArray(refs) ||
        !refs.length ||
        refs.length > 100 ||
        refs.some((ref) => !ref || typeof ref !== 'object' || typeof ref.repositoryPath !== 'string') ||
        new Set(refs.map((r) => r.repositoryPath)).size !== refs.length
      )
        throw new Error('Select one PR per participating repository.');
      const client = this.client(settings.bitbucketConnectionId);
      const selected = refs.map((ref) => {
        const repo = settings.repositories.find((r) => r.relativePath === ref.repositoryPath);
        if (!repo || !Number.isSafeInteger(ref.prId) || ref.prId < 1)
          throw new Error('Choose a PR from a mapped project repository.');
        return { ref, repo };
      });
      const prs = await mapConcurrent(selected, 4, async ({ ref, repo }) => {
        const pr = await client.getPullRequest(repo, ref.prId);
        if (
          pr.id !== ref.prId ||
          pr.repository.relativePath !== repo.relativePath ||
          pr.repository.workspace.toLowerCase() !== repo.workspace.toLowerCase() ||
          pr.repository.repoSlug.toLowerCase() !== repo.repoSlug.toLowerCase() ||
          (repo.uuid && pr.repository.uuid && repo.uuid !== pr.repository.uuid)
        )
          throw new Error('Bitbucket returned a PR that does not match the selected repository and ID.');
        if (pr.unsupportedReason) throw new Error(pr.unsupportedReason);
        if (pr.state !== 'OPEN') throw new Error(`${repo.relativePath} #${pr.id} is no longer open.`);
        return pr;
      });
      if (
        prs.some((pr) => pr.sourceBranch !== prs[0].sourceBranch || pr.targetBranch !== prs[0].targetBranch)
      )
        throw new Error('Grouped PRs must use matching source and target branch names.');
      for (const review of this.reviews
        .getState()
        .reviews.filter((r) => r.projectId === projectId && r.remote)) {
        const binding = this.state.review(review.id);
        if (
          binding?.connectionId === settings.bitbucketConnectionId &&
          review.featureBranch === prs[0].sourceBranch &&
          review.baseBranch === prs[0].targetBranch &&
          prs.every((pr) =>
            binding.pullRequests.some(
              (saved) => saved.id === pr.id && saved.repository.relativePath === pr.repository.relativePath,
            ),
          )
        ) {
          const savedMappings =
            binding.repositories?.map((row) => row.repository) ??
            binding.pullRequests.map((pr) => pr.repository);
          if (
            savedMappings.some(
              (saved) =>
                !settings.repositories.some(
                  (repo) =>
                    repo.relativePath === saved.relativePath &&
                    repo.workspace.toLowerCase() === saved.workspace.toLowerCase() &&
                    repo.repoSlug.toLowerCase() === saved.repoSlug.toLowerCase() &&
                    (!repo.uuid || !saved.uuid || repo.uuid === saved.uuid),
                ),
            )
          )
            continue;
          // An old receipt cannot authorize new commits pushed after a child merge.
          // Opening from the inbox starts a fresh review while keeping the old one.
          const completed = (binding.repositories ?? []).filter((row) => {
            const merged =
              binding.operation?.items.some(
                (item) =>
                  item.prKey === `${row.repository.relativePath}#${row.prId}` && item.merge === 'merged',
              ) ||
              binding.pullRequests.some(
                (pr) => pr.repository.relativePath === row.repository.relativePath && pr.state === 'MERGED',
              );
            return merged || row.cleanup?.state === 'deleted';
          });
          const hasNewWork = (
            await mapConcurrent(completed, 4, async (row) => {
              const source = await client.getBranch(row.repository, row.sourceBranch);
              return Boolean(source && source.hash !== row.sourceHash);
            })
          ).some(Boolean);
          if (!hasNewWork) return review;
        }
      }
      const first = prs[0];
      const review = await this.reviews.createReview(
        {
          projectId,
          name: `${first.sourceBranch} · branch review`.slice(0, 200),
          featureBranch: first.sourceBranch,
          baseBranch: first.targetBranch,
          includeWorkingTree: false,
        },
        true,
      );
      try {
        await this.state.setReview(review.id, {
          connectionId: settings.bitbucketConnectionId,
          pullRequests: prs,
          publications: {},
        });
      } catch (error) {
        await this.reviews.deleteReview(review.id);
        throw error;
      }
      return review;
    });
  }
  getRemoteReview(id: string): RemoteReviewState | null {
    this.reviews.getReview(id);
    return this.state.review(id);
  }
  onRemoteReviewLoadProgress(callback: (event: RemoteReviewLoadProgress) => void): () => void {
    this.loadListeners.add(callback);
    return () => this.loadListeners.delete(callback);
  }
  private emitLoad(
    id: string,
    repositories: RemoteRepositoryLoad[],
    complete: boolean,
    result?: ReviewRefresh,
    error?: string,
  ): void {
    const event: RemoteReviewLoadProgress = {
      reviewId: id,
      sequence: ++this.loadSequence,
      repositories: structuredClone(repositories),
      complete,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
    this.loadProgress.set(id, event);
    for (const callback of this.loadListeners) {
      try {
        callback(event);
      } catch {
        /* A closed renderer cannot fail a repository read. */
      }
    }
  }
  private requireLoaded(id: string): void {
    if (this.remoteRefreshes.has(id) || this.snapshots.get(id)?.loading)
      throw new Error(
        'Wait for all repositories to finish loading before publishing, approving or merging. You can keep reviewing the files already loaded.',
      );
    if (this.failedLoads.has(id))
      throw new Error(
        `Refresh this review before continuing. Its last load could not finish: ${this.failedLoads.get(id)}`,
      );
  }
  /** Remote reads run outside mutation queues. Each completed repository commits a short update. */
  async buildSnapshot(review: Review): Promise<ReviewSnapshot> {
    if (this.connectionChange) throw new Error('Wait for the connection change to finish before refreshing.');
    const binding = this.state.review(review.id);
    if (!binding)
      throw new Error(
        'This PR review has lost its integration metadata. Reconnect and reopen the PR; your local feedback is preserved.',
      );
    const client = this.client(binding.connectionId);
    const steps: RemoteRepositoryLoad[] = [];
    const pieces = new Map<string, RemoteSnapshotResult>();
    const previous = this.snapshots.get(review.id);
    let current: ReviewSnapshot;
    const compose = (loading: boolean): ReviewSnapshot => ({
      reviewId: review.id,
      loading,
      files: [
        ...(previous?.files.filter((file) => !pieces.has(file.repoRelativePath)) ?? []),
        ...[...pieces.values()].flatMap((piece) => piece.snapshot.files),
      ].sort((a, b) => a.id.localeCompare(b.id)),
      repos: steps.map(
        (step) =>
          pieces.get(step.repository.relativePath)?.snapshot.repos[0] ?? {
            ...(previous?.repos.find((repo) => repo.relativePath === step.repository.relativePath) ?? {
              relativePath: step.repository.relativePath,
              currentBranch: null,
              workingTreeIncluded: false,
            }),
            loading: true,
          },
      ),
      warnings: [...pieces.values()].flatMap((piece) => piece.snapshot.warnings),
      refreshedAt: new Date().toISOString(),
      fingerprint: JSON.stringify(
        [...pieces].map(([path, piece]) => [path, piece.snapshot.fingerprint]).sort(),
      ),
    });
    const commitSnapshot = async (snapshot: ReviewSnapshot) => {
      const result = await this.reviewService.acceptRemoteSnapshot(
        review.id,
        snapshot,
        reviewContextKey(review),
      );
      this.snapshots.set(review.id, snapshot);
      return result;
    };
    try {
      const discovered = await this.branches.discover(review.id, {
        onStart: async (repositories) => {
          steps.push(...repositories.map((repository) => ({ repository, phase: 'queued' as const })));
          await this.serial(review.id, async () => {
            await this.state.updateReview(review.id, (value) => {
              value.repositories = repositories.map((repository) => {
                const saved = value.repositories?.find(
                  (row) => row.repository.relativePath === repository.relativePath,
                );
                const pr = value.pullRequests.find(
                  (pr) => pr.repository.relativePath === repository.relativePath,
                );
                return (
                  saved ??
                  ({
                    repository: pr?.repository ?? repository,
                    sourceBranch: review.featureBranch,
                    targetBranch: review.baseBranch,
                    sourceHash: pr?.sourceHash,
                    targetHash: pr?.targetHash,
                    prId: pr?.id,
                    status: pr ? 'pull-request' : 'unavailable',
                  } as BranchReviewRepository)
                );
              });
            });
            current = compose(true);
            this.emitLoad(review.id, steps, false, await commitSnapshot(current));
          });
        },
        onChecking: async (repository) => {
          steps.find((step) => step.repository.relativePath === repository.relativePath)!.phase = 'checking';
          this.emitLoad(review.id, steps, false);
        },
        onRepository: this.dependencies.snapshot
          ? undefined
          : async (row, pr) => {
              const step = steps.find(
                (step) => step.repository.relativePath === row.repository.relativePath,
              )!;
              step.phase = 'files';
              this.emitLoad(review.id, steps, false);
              const piece = await (this.dependencies.repositorySnapshot ?? buildRemoteRepositorySnapshot)(
                client,
                review.id,
                row,
                pr,
              );
              await this.serial(review.id, async () => {
                pieces.set(row.repository.relativePath, piece);
                const captured = piece.repositories?.[0] ?? row;
                await this.state.updateReview(review.id, (value) => {
                  value.repositories![
                    value.repositories!.findIndex(
                      (saved) => saved.repository.relativePath === row.repository.relativePath,
                    )
                  ] = captured;
                  for (const updated of piece.pullRequests) {
                    const index = value.pullRequests.findIndex(
                      (saved) => saved.repository.relativePath === updated.repository.relativePath,
                    );
                    if (index < 0) value.pullRequests.push(updated);
                    else value.pullRequests[index] = updated;
                  }
                  BranchReviewService.linkDrafts(value);
                });
                step.phase = piece.snapshot.repos.some((repo) => repo.error) ? 'failed' : 'ready';
                step.error = piece.snapshot.repos.find((repo) => repo.error)?.error;
                current = compose(true);
                this.emitLoad(review.id, steps, false, await commitSnapshot(current));
              });
            },
      });
      if (this.dependencies.snapshot) {
        const result = await this.dependencies.snapshot(
          client,
          review.id,
          discovered.pullRequests,
          discovered.repositories,
        );
        await this.serial(review.id, async () => {
          await this.state.updateReview(review.id, (value) => {
            value.pullRequests = result.pullRequests;
            value.repositories = result.repositories ?? discovered.repositories;
            BranchReviewService.linkDrafts(value);
          });
        });
        return result.snapshot;
      }
      return compose(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      steps.forEach((step) => {
        if (!['ready', 'failed'].includes(step.phase)) {
          step.phase = 'failed';
          step.error = detail;
        }
      });
      current = compose(false);
      current.repos = current.repos.map((repo) => ({ ...repo, loading: false, error: repo.error ?? detail }));
      current.warnings.push(detail);
      try {
        await this.serial(review.id, async () =>
          this.emitLoad(review.id, steps, true, await commitSnapshot(current), detail),
        );
      } catch {
        // If saving failed too, display only the last accepted files. An
        // unaccepted repository must never become actionable through the cache.
        const accepted = this.snapshots.get(review.id);
        if (accepted) {
          const failed = {
            ...accepted,
            loading: false,
            repos: accepted.repos.map((repo) => ({ ...repo, loading: false, error: repo.error ?? detail })),
            warnings: [...accepted.warnings, detail],
          };
          this.snapshots.set(review.id, failed);
          try {
            this.emitLoad(
              review.id,
              steps,
              true,
              { review: this.reviews.getReview(review.id), snapshot: failed },
              detail,
            );
          } catch {
            /* The review was removed. */
          }
        }
      }
      throw error;
    }
  }
  setCurrentTarget(projectId: string, target: string) {
    const id = currentReviewId(projectId);
    return this.trackLocalRefresh(id, async () => {
      await this.jira.reconcileCurrentTicket(id);
      const result = await this.reviewService.setCurrentTarget(projectId, target);
      await this.jira.reconcileCurrentTicket(id);
      return result;
    });
  }
  async refreshReview(id: string) {
    if (!this.reviews.getReview(id).remote)
      return this.trackLocalRefresh(id, async () => {
        await this.jira.reconcileCurrentTicket(id);
        const result = await this.reviewService.refreshReview(id);
        await this.jira.reconcileCurrentTicket(id);
        return result;
      });
    const existing = this.remoteRefreshes.get(id);
    if (existing) {
      const progress = this.loadProgress.get(id),
        snapshot = this.snapshots.get(id);
      if (progress && snapshot)
        this.emitLoad(id, progress.repositories, false, { review: this.reviews.getReview(id), snapshot });
      return existing;
    }
    const operation = this.trackLocalRefresh(id, async () => {
      let result: ReviewRefresh;
      try {
        result = await this.reviewService.refreshReview(id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.failedLoads.set(id, detail);
        const accepted = this.snapshots.get(id),
          progress = this.loadProgress.get(id);
        if (accepted && !(progress?.complete && progress.error)) {
          const failed = {
            ...accepted,
            loading: false,
            repos: accepted.repos.map((repo) => ({ ...repo, loading: false, error: repo.error ?? detail })),
            warnings: [...new Set([...accepted.warnings, detail])],
          };
          this.snapshots.set(id, failed);
          this.emitLoad(
            id,
            progress?.repositories.map((row) =>
              ['queued', 'checking', 'files'].includes(row.phase)
                ? { ...row, phase: 'failed', error: detail }
                : row,
            ) ?? [],
            true,
            { review: this.reviews.getReview(id), snapshot: failed },
            detail,
          );
        }
        throw error;
      }
      this.snapshots.set(id, result.snapshot);
      this.failedLoads.delete(id);
      if (result.review.remote) {
        try {
          await this.publication.reconcile(id, (action) => this.serial(id, action));
          result.review = this.reviews.getReview(id);
        } catch (error) {
          result.snapshot.warnings.push(
            `Feedback sync: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const binding = this.state.review(id);
      if (
        binding?.pullRequests.length &&
        binding.pullRequests.every((pr) => ['MERGED', 'DECLINED', 'SUPERSEDED'].includes(pr.state))
      ) {
        result.closedReview = await this.serial(id, () => this.closedReviews.inspect(id, true));
      }
      const steps =
        this.loadProgress.get(id)?.repositories.map((step) => ({
          ...step,
          phase: result.snapshot.repos.some(
            (repo) => repo.relativePath === step.repository.relativePath && repo.error,
          )
            ? ('failed' as const)
            : ('ready' as const),
        })) ?? [];
      this.emitLoad(id, steps, true, result);
      return result;
    });
    this.remoteRefreshes.set(id, operation);
    const clear = () => {
      if (this.remoteRefreshes.get(id) === operation) this.remoteRefreshes.delete(id);
    };
    void operation.then(clear, clear);
    return operation;
  }
  addComment(id: string, input: NewComment, contextKey?: string) {
    return this.serial(id, async () => {
      const result = await this.reviewService.addComment(id, input, contextKey);
      if (result.remote) await this.publication.capture(id);
      return result;
    });
  }
  updateComment(
    id: string,
    commentId: string,
    changes: { body?: string; resolved?: boolean },
    contextKey?: string,
  ) {
    return this.serial(id, () => this.reviewService.updateComment(id, commentId, changes, contextKey));
  }
  deleteComment(id: string, commentId: string, contextKey?: string) {
    return this.serial(id, async () => {
      const review = this.reviews.getReview(id);
      if (review.remote) {
        await this.publication.capture(id);
        await this.state.updateReview(id, (r) => {
          if (r.publications[commentId])
            r.publications[commentId].backup = review.comments.find((c) => c.id === commentId);
        });
      }
      return this.reviewService.deleteComment(id, commentId, contextKey);
    });
  }
  setApprovals(
    id: string,
    files: { fileId: string; fingerprint: string }[],
    approved: boolean,
    contextKey?: string,
  ) {
    return this.serial(id, () => this.reviewService.setApprovals(id, files, approved, contextKey));
  }
  copyFeedback(id: string, contextKey?: string) {
    return this.serial(id, () => this.reviewService.copyFeedback(id, contextKey));
  }
  previewFeedback(id: string) {
    return this.serial(id, () => {
      this.requireLoaded(id);
      return this.publication.preview(id);
    });
  }
  publishFeedback(id: string) {
    return this.serial(id, () => {
      this.requireLoaded(id);
      return this.publication.publish(id);
    });
  }
  reanchorComment(id: string, commentId: string, input: ReanchorInput) {
    return this.serial(id, () => this.publication.reanchor(id, commentId, input));
  }
  resolveCommentConflict(id: string, commentId: string, choice: 'local' | 'remote') {
    return this.serial(id, () => this.publication.resolveConflict(id, commentId, choice));
  }
  resolveUnknownPublication(id: string, commentId: string, remoteId: number | null) {
    return this.serial(id, () => this.publication.resolveUnknown(id, commentId, remoteId));
  }
  previewMerge(id: string, action: 'approve' | 'merge' = 'merge') {
    return this.serial(id, () => {
      this.requireLoaded(id);
      return this.merger.preview(id, action);
    });
  }
  runPullRequestAction(id: string, action: 'approve' | 'merge') {
    return this.serial(id, () => {
      this.requireLoaded(id);
      return this.merger.run(id, action);
    });
  }
  completeMergedReview(id: string) {
    return this.serial(id, async () => {
      const review = this.reviews.getState().reviews.find((review) => review.id === id);
      // A lost IPC response may be retried after local deletion has succeeded.
      if (!review) {
        await this.state.removeReview(id);
        this.forgetReview(id);
        return this.reviews.getState();
      }
      if (!review.remote || !isMergeComplete(this.state.review(id)))
        throw new Error('Finish merging and confirm branch cleanup before removing this review.');
      return this.removeReview(id);
    });
  }
  private closedReviewBusyReason(id: string): string | undefined {
    const review = this.reviews.getState().reviews.find((review) => review.id === id);
    if (this.connectionChange) return 'Wait for the connection change to finish, then check again.';
    if (this.pending.has(id) || this.localRefreshes.has(id) || this.remoteRefreshes.has(id))
      return 'Wait for this review’s current operation to finish, then check again.';
    if (review && this.pending.has(`project:${review.projectId}`))
      return 'Wait for project integration settings to finish, then check again.';
  }
  async checkClosedReview(id: string): Promise<ClosedReviewCheck> {
    if (typeof id !== 'string' || !id || ['__proto__', 'prototype', 'constructor'].includes(id))
      throw new Error('Choose a saved review to check.');
    const reason = this.closedReviewBusyReason(id);
    if (reason) return { ...this.closedReviews.summary(id), status: 'blocked', reason };
    try {
      return await this.serial(id, () => this.closedReviews.inspect(id));
    } catch (error) {
      return {
        ...this.closedReviews.summary(id),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async removeClosedReviews(
    projectId: string,
    ids: string[],
    options: { automatic?: boolean } = {},
  ): Promise<ClosedReviewCleanupResult> {
    this.reviews.getProject(projectId);
    if (
      !options ||
      typeof options !== 'object' ||
      (options.automatic !== undefined && typeof options.automatic !== 'boolean')
    )
      throw new Error('Choose a valid review cleanup mode.');
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 1000 ||
      ids.some(
        (id) => typeof id !== 'string' || !id || ['__proto__', 'prototype', 'constructor'].includes(id),
      )
    )
      throw new Error('Choose saved reviews to remove.');
    const removedIds: string[] = [],
      retained: ClosedReviewCheck[] = [];
    await mapConcurrent([...new Set(ids)], 4, async (id) => {
      const review = this.reviews.getState().reviews.find((review) => review.id === id),
        receipt = this.closedReviewRemovals.get(id);
      if ((review && review.projectId !== projectId) || (receipt && receipt.projectId !== projectId)) {
        retained.push({
          ...this.closedReviews.summary(id),
          status: 'blocked',
          reason: 'This review belongs to another project. Check it from that project’s review list.',
        });
        return;
      }
      const reason = this.closedReviewBusyReason(id);
      if (reason) {
        retained.push({ ...this.closedReviews.summary(id), status: 'blocked', reason });
        return;
      }
      let checked = this.closedReviews.summary(id);
      try {
        await this.serial(id, async () => {
          const saved = this.reviews.getState().reviews.find((review) => review.id === id);
          if (!saved) {
            if (this.state.review(id) && !receipt) {
              retained.push({
                ...checked,
                status: 'blocked',
                reason:
                  'This review is no longer saved. Restart Branchline to finish cleaning its integration metadata.',
              });
              return;
            }
            await this.state.removeReview(id);
            this.forgetReview(id);
            this.closedReviewRemovals.delete(id);
            removedIds.push(id);
            return;
          }
          if (saved.projectId !== projectId) {
            retained.push({
              ...checked,
              status: 'blocked',
              reason: 'This review belongs to another project.',
            });
            return;
          }
          checked = await this.closedReviews.inspect(id, options.automatic === true);
          if (checked.status !== 'closed') {
            retained.push(checked);
            return;
          }
          this.closedReviewRemovals.set(id, { projectId, check: checked });
          try {
            await this.removeReview(id);
          } finally {
            if (!this.reviews.getState().reviews.some((review) => review.id === id)) this.forgetReview(id);
            else this.closedReviewRemovals.delete(id);
          }
          this.closedReviewRemovals.delete(id);
          removedIds.push(id);
        });
      } catch (error) {
        const deleted = !this.reviews.getState().reviews.some((review) => review.id === id);
        retained.push({
          ...checked,
          status: 'unavailable',
          reason: `${deleted ? 'The review was removed, but its local metadata still needs cleanup. Retry this removal or restart Branchline.' : 'The review could not be removed. Try again.'} ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    return { state: this.reviews.getState(), removedIds, retained };
  }
  /** Retire completed reviews from earlier versions and after interrupted UI completion. */
  async removeCompletedReviews(): Promise<void> {
    // Deletion commits the review store first. Finish metadata cleanup if the
    // process previously exited between those two durable writes.
    await this.state.removeOrphanedReviews(this.reviews.getState().reviews.map((review) => review.id));
    for (const review of this.reviews.getState().reviews) {
      if (review.remote && isMergeComplete(this.state.review(review.id)))
        await this.completeMergedReview(review.id);
    }
  }
  getJiraTicketSuggestions(id: string, query: string) {
    return this.jira.getJiraTicketSuggestions(id, query);
  }
  setReviewTicket(id: string, key: string | null, expectedBranch?: string | null) {
    return this.jira.setReviewTicket(id, key, expectedBranch);
  }
  getJiraTicketLink(id: string) {
    return this.jira.getJiraTicketLink(id);
  }
  getJiraBrowserTarget(id: string) {
    return this.jira.getJiraBrowserTarget(id);
  }
  getJiraIssue(id: string, override?: string) {
    return this.jira.getJiraIssue(id, override);
  }
  validateLink(value: string): string {
    return validateIntegrationLink(value);
  }
  deleteReview(id: string) {
    return this.serial(id, async () => {
      if (this.remoteRefreshes.has(id))
        throw new Error('Wait for the repositories to finish loading before removing this review.');
      const operation = this.state.review(id)?.operation;
      if (
        operation &&
        operation.state !== 'complete' &&
        operation.items.some(
          (item) => ['sending', 'merging', 'unknown', 'merged'].includes(item.merge) || item.pointerCommit,
        )
      )
        throw new Error('Finish or reconcile this merge operation before removing its review.');
      return this.removeReview(id);
    });
  }
  private async removeReview(id: string) {
    if (this.remoteRefreshes.has(id))
      throw new Error('Wait for the repositories to finish loading before removing this review.');
    const result = await this.reviewService.deleteReview(id);
    await this.state.removeReview(id);
    this.forgetReview(id);
    return result;
  }
  private forgetReview(id: string) {
    this.snapshots.delete(id);
    this.loadProgress.delete(id);
    this.failedLoads.delete(id);
    this.jira.forgetReview(id);
  }
  async deleteProject(id: string) {
    if (this.busy) throw new Error('Wait for current integration work before removing a project.');
    const reviewIds = this.reviews
      .getState()
      .reviews.filter((r) => r.projectId === id)
      .map((r) => r.id);
    if (
      reviewIds.some((reviewId) => {
        const op = this.state.review(reviewId)?.operation;
        return op && op.state !== 'complete';
      })
    )
      throw new Error('Complete the project’s pending PR operations before removing it.');
    const result = await this.reviewService.deleteProject(id);
    await this.state.removeProject(id, reviewIds);
    reviewIds.forEach((id) => this.forgetReview(id));
    return result;
  }
}
