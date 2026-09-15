import { createHash } from 'node:crypto';
import type { BranchReviewRepository, PullRequest, RemoteReviewState, RepositoryMapping } from '../shared/integrations';
import { branchReviewKey, pullRequestKey } from '../shared/integrations';
import type { ReviewSnapshot } from '../shared/types';
import type { BitbucketClient } from './bitbucket-client';
import { IntegrationStore } from './integration-store';
import { ReviewStore } from './store';
import { mapConcurrent } from './concurrency';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameRepository = (a: RepositoryMapping, b: RepositoryMapping) => a.relativePath === b.relativePath
  && a.workspace.toLowerCase() === b.workspace.toLowerCase() && a.repoSlug.toLowerCase() === b.repoSlug.toLowerCase()
  && (!a.uuid || !b.uuid || a.uuid === b.uuid);
const rejected = (error: unknown) => { const status = (error as { status?: number })?.status; return !!status && status >= 400 && status < 500 && status !== 408; };

export interface BranchDiscoveryOptions {
  onStart?: (repositories: RepositoryMapping[]) => Promise<void>;
  onChecking?: (repository: RepositoryMapping) => Promise<void>;
  onRepository?: (row: BranchReviewRepository, pr?: PullRequest) => Promise<void>;
}

/** Branch scope and PR existence are separate. Only ensurePullRequests can create PRs. */
export class BranchReviewService {
  constructor(private readonly reviews: ReviewStore, private readonly state: IntegrationStore,
    private readonly client: (id: string) => BitbucketClient,
    private readonly snapshot: (id: string) => ReviewSnapshot | undefined) {}

  private binding(id: string): RemoteReviewState {
    const binding = this.state.review(id);
    if (!binding) throw new Error('Open a remote branch review first.');
    return binding;
  }

  private mappings(id: string, binding: RemoteReviewState): RepositoryMapping[] {
    const configured = this.state.project(this.reviews.getReview(id).projectId).repositories;
    // Preserve an old mapping as an explicit blocker if project settings remove it.
    const previous = binding.repositories?.map(row => row.repository) ?? binding.pullRequests.map(pr => pr.repository);
    return [...configured, ...previous.filter(repo => !configured.some(value => value.relativePath === repo.relativePath))];
  }

  private async inspect(client: BitbucketClient, initial: BranchReviewRepository, linked?: PullRequest): Promise<{ row: BranchReviewRepository; pr?: PullRequest }> {
    const row: BranchReviewRepository = { ...initial, error: undefined };
    const { repository, sourceBranch, targetBranch } = row;
    if (sourceBranch === targetBranch) throw new Error('The source and target branches must be different.');
    await client.getRepository(repository); // A repository/permission 404 must never look like an absent branch.
    const pr = linked ? await client.getPullRequest(repository, linked.id) : undefined;
    if (pr && (!sameRepository(repository, pr.repository) || pr.sourceBranch !== sourceBranch || pr.targetBranch !== targetBranch || pr.unsupportedReason)) {
      throw new Error('The linked PR no longer matches this repository and branch comparison.');
    }
    if (pr?.state === 'MERGED') {
      // Completed PRs retain their historical diff even after source-branch deletion.
      const targetHash = row.targetHash ?? linked!.targetHash;
      const captured = { ...pr, sourceHash: pr.sourceHash, targetHash,
        mergeBaseHash: pr.sourceHash === (row.sourceHash ?? linked!.sourceHash) ? row.mergeBaseHash ?? linked!.mergeBaseHash : await client.mergeBase(repository, pr.sourceHash, targetHash) };
      return { row: { ...row, status: 'pull-request', prId: pr.id, sourceHash: captured.sourceHash, targetHash: captured.targetHash, mergeBaseHash: captured.mergeBaseHash }, pr: captured };
    }
    if (pr && pr.state !== 'OPEN') throw new Error(`PR #${pr.id} is ${pr.state.toLowerCase()}. Resolve it in Bitbucket before continuing.`);
    const candidates = await client.findPullRequests(repository, sourceBranch);
    if (candidates.some(value => value.unsupportedReason || value.targetBranch !== targetBranch)) throw new Error('An open PR for this source branch has a different target or source repository. Resolve that PR in Bitbucket before continuing.');
    if (candidates.length > 1 || pr && candidates.some(value => value.id !== pr.id)) throw new Error('Multiple open PRs use this branch. Resolve the duplicate PRs in Bitbucket before continuing.');
    const found = pr ?? candidates[0];
    const [source, target] = await Promise.all([client.getBranch(repository, sourceBranch), client.getBranch(repository, targetBranch)]);
    if (!target) throw new Error(`Target branch “${targetBranch}” is missing. Configure or restore it before continuing.`);
    if (!source) {
      if (found) throw new Error('The source branch for an open PR is missing. Restore it or resolve the PR in Bitbucket.');
      return { row: { ...row, status: 'missing-branch', sourceHash: undefined, mergeBaseHash: undefined, targetHash: target.hash, prId: undefined } };
    }
    const mergeBaseHash = await client.mergeBase(repository, source.hash, target.hash);
    if (found && (found.sourceHash !== source.hash || found.targetHash !== target.hash)) throw new Error('The branch changed while checking its PR. Refresh to load a consistent revision.');
    return { row: { ...row, sourceHash: source.hash, targetHash: target.hash, mergeBaseHash,
      status: found ? 'pull-request' : mergeBaseHash === source.hash ? 'no-changes' : 'changes', prId: found?.id,
      ...(found ? { creation: undefined } : {}) }, pr: found };
  }

  /** Refreshes all configured repositories; failures remain visible and cannot remove scope. */
  async discover(id: string, options: BranchDiscoveryOptions = {}): Promise<{ repositories: BranchReviewRepository[]; pullRequests: PullRequest[] }> {
    const binding = this.binding(id);
    const review = this.reviews.getReview(id);
    const settings = this.state.project(review.projectId);
    const client = this.client(binding.connectionId);
    const mappings = this.mappings(id, binding);
    await options.onStart?.(mappings);
    const results = await mapConcurrent(mappings, 4, async repository => {
      const previous = binding.repositories?.find(row => row.repository.relativePath === repository.relativePath);
      const linked = binding.pullRequests.find(pr => pr.repository.relativePath === repository.relativePath);
      const initial: BranchReviewRepository = { prId: linked?.id, sourceHash: linked?.sourceHash, targetHash: linked?.targetHash, mergeBaseHash: linked?.mergeBaseHash,
        ...previous, repository, sourceBranch: review.featureBranch, targetBranch: review.baseBranch, status: 'unavailable' };
      await options.onChecking?.(repository);
      let result: { row: BranchReviewRepository; pr?: PullRequest };
      try {
        if (!settings.repositories.some(repo => sameRepository(repo, repository)) || previous && !sameRepository(previous.repository, repository)
          || linked && !sameRepository(linked.repository, repository)) throw new Error('The repository mapping changed. Restore this review’s mapping or start a new review.');
        result = await this.inspect(client, initial, linked);
      } catch (error) { result = { row: { ...initial, repository: previous?.repository ?? linked?.repository ?? repository, status: 'unavailable', error: message(error) }, pr: linked }; }
      // The hook can load and publish this diff while other repositories are still inspected.
      // Await it so the entire discovery/content pipeline stays bounded to four repositories.
      await options.onRepository?.(result.row, result.pr);
      return result;
    });
    return { repositories: results.map(result => result.row), pullRequests: results.flatMap(result => result.pr ? [result.pr] : []) };
  }

  /** Link drafts to a real PR without changing their captured paths, ranges or revisions. */
  static linkDrafts(binding: RemoteReviewState): void {
    for (const row of binding.repositories ?? []) {
      if (!row.prId) continue;
      for (const publication of Object.values(binding.publications)) {
        if (!publication.remoteId && publication.anchor.prKey === branchReviewKey(row.repository.relativePath)) {
          publication.anchor.prKey = `${row.repository.relativePath}#${row.prId}`;
        }
      }
    }
  }

  /** Checks live scope without overwriting the revisions that the user actually reviewed. */
  async preflight(id: string, options: { repositoryPaths?: string[] } = {}): Promise<string[]> {
    const binding = this.binding(id);
    const rows = binding.repositories;
    if (!rows) return ['Refresh this review to include every project repository before continuing.'];
    const settings = this.state.project(this.reviews.getReview(id).projectId);
    if (this.mappings(id, binding).length !== rows.length || settings.repositories.some(repo => !rows.some(row => sameRepository(row.repository, repo)))) {
      return ['The project’s repository mappings changed. Refresh and review the full branch before continuing.'];
    }
    const snapshot = this.snapshot(id);
    const blockers: string[] = [];
    if (snapshot?.loading) return ['Wait for all repositories to finish loading before continuing.'];
    if (!snapshot || snapshot.repos.some(repo => repo.error) || snapshot.files.some(file => file.unavailable)
      || rows.some(row => !snapshot.repos.some(repo => repo.relativePath === row.repository.relativePath))) blockers.push('Refresh and review the complete branch diff before continuing.');
    const selected = options.repositoryPaths ? rows.filter(row => options.repositoryPaths!.includes(row.repository.relativePath)) : rows;
    if (options.repositoryPaths?.some(path => !rows.some(row => row.repository.relativePath === path))) return [...blockers, 'Choose a repository from the captured branch review.'];
    await this.state.updateReview(id, value => {
      for (const row of value.repositories ?? []) if (selected.some(selectedRow => selectedRow.repository.relativePath === row.repository.relativePath)) row.check = { state: 'queued' };
    });
    const client = this.client(binding.connectionId);
    const results = await mapConcurrent(selected, 4, async row => {
      const path = row.repository.relativePath;
      await this.state.updateReview(id, value => { value.repositories!.find(saved => saved.repository.relativePath === path)!.check = { state: 'checking' }; });
      let errorMessage: string | undefined;
      try {
        if (row.status === 'unavailable' || !settings.repositories.some(repo => sameRepository(row.repository, repo))) throw new Error(row.error ?? 'The repository mapping is unavailable.');
        if (row.cleanup?.state === 'deleted' && !row.prId) {
          await client.getRepository(row.repository);
          if (!await client.getBranch(row.repository, row.sourceBranch)) return;
          throw new Error('The source branch was recreated after cleanup. Start a new review for its changes; the completed deletion will not be repeated.');
        }
        const linked = binding.pullRequests.find(pr => pr.repository.relativePath === path);
        const result = await this.inspect(client, row, linked);
        if (['sending', 'unknown'].includes(row.creation?.state ?? '') && !result.pr) {
          throw new Error('PR creation is still unconfirmed. Check its result in Bitbucket before continuing, even if the source branch is now missing.');
        }
        // A confirmed merge changes the target. Merge reconciliation handles these PRs.
        if (result.pr?.state === 'MERGED') {
          if (result.pr.sourceHash !== row.sourceHash) throw new Error('The merged source differs from the reviewed revision. Refresh and review the actual merged changes before resuming.');
          const source = await client.getBranch(row.repository, row.sourceBranch);
          if (source && source.hash !== row.sourceHash) throw new Error('The source branch changed after its PR was merged. Reopen the branch from Pull requests to review that new work. The completed PR will not merge or delete it.');
          return;
        }
        const actual = result.row;
        if (actual.sourceHash !== row.sourceHash || actual.targetHash !== row.targetHash || actual.mergeBaseHash !== row.mergeBaseHash
          || (actual.status === 'missing-branch') !== (row.status === 'missing-branch')) {
          throw new Error('The branch changed since it was loaded. Refresh and review its latest changes before continuing.');
        }
        if (row.prId && actual.prId !== row.prId) throw new Error('The linked PR changed. Refresh the review before continuing.');
      } catch (error) { errorMessage = message(error); }
      finally {
        await this.state.updateReview(id, value => { value.repositories!.find(saved => saved.repository.relativePath === path)!.check = errorMessage ? { state: 'failed', error: errorMessage } : { state: 'ready' }; });
      }
      return errorMessage ? `${path}: ${errorMessage}` : undefined;
    });
    return [...new Set([...blockers, ...results.filter((result): result is string => !!result)])];
  }

  private async link(id: string, row: BranchReviewRepository, pr: PullRequest): Promise<void> {
    if (!sameRepository(row.repository, pr.repository) || pr.sourceBranch !== row.sourceBranch || pr.targetBranch !== row.targetBranch || pr.unsupportedReason || pr.state !== 'OPEN') {
      throw new Error('Bitbucket returned a PR that does not match the reviewed branch. Check Bitbucket before continuing.');
    }
    await this.state.updateReview(id, binding => {
      const existing = binding.pullRequests.find(value => value.repository.relativePath === row.repository.relativePath);
      if (existing && existing.id !== pr.id) throw new Error('This repository is already linked to another PR.');
      if (!existing) binding.pullRequests.push(pr);
      const saved = binding.repositories!.find(value => value.repository.relativePath === row.repository.relativePath)!;
      saved.prId = pr.id; saved.status = 'pull-request'; saved.creation = undefined;
      BranchReviewService.linkDrafts(binding);
    });
    if (pr.sourceHash !== row.sourceHash || pr.targetHash !== row.targetHash) throw new Error('The branch changed while its PR was created. Refresh and review the changes before continuing.');
  }

  async ensurePullRequests(id: string, repositoryPaths: string[]): Promise<void> {
    if (!repositoryPaths.length) return;
    const blockers = await this.preflight(id);
    if (blockers.length) throw new Error(blockers.join('\n'));
    const client = this.client(this.binding(id).connectionId);
    await mapConcurrent([...new Set(repositoryPaths)], 4, async repositoryPath => {
      const binding = this.binding(id);
      const row = binding.repositories?.find(value => value.repository.relativePath === repositoryPath);
      if (!row) throw new Error('Choose a repository from the captured branch review.');
      if (row.prId) return;
      if (row.status !== 'changes' || !row.sourceHash || !row.targetHash) throw new Error(`${repositoryPath}: there are no reviewed branch changes to publish as a PR.`);
      // Read before every attempt, including retries after a process restart.
      const candidates = await client.findPullRequests(row.repository, row.sourceBranch);
      if (candidates.some(pr => pr.targetBranch !== row.targetBranch || pr.unsupportedReason) || candidates.length > 1) throw new Error(`${repositoryPath}: conflicting PRs already exist. Resolve them in Bitbucket.`);
      if (candidates[0]) { await this.link(id, row, candidates[0]); return; }
      if (row.creation?.state === 'unknown' || row.creation?.state === 'sending') {
        // Also inspect closed PRs: an uncertain creation may have been merged or declined.
        const closed = await client.findPullRequests(row.repository, row.sourceBranch, ['MERGED', 'DECLINED', 'SUPERSEDED']);
        const reason = closed.some(pr => pr.targetBranch === row.targetBranch && pr.sourceHash === row.creation!.sourceHash)
          ? 'A matching PR has already been closed. Check its result in Bitbucket; another PR will not be created automatically.'
          : 'PR creation is still unconfirmed. Check Bitbucket and refresh; another PR will not be created automatically.';
        throw new Error(`${repositoryPath}: ${reason}`);
      }
      // Check again after listing: provider APIs do not accept an expected-commit condition.
      const current = await this.inspect(client, row);
      if (current.pr) { await this.link(id, row, current.pr); return; }
      if (current.row.sourceHash !== row.sourceHash || current.row.targetHash !== row.targetHash) throw new Error(`${repositoryPath}: the branch changed. Refresh and review it before creating its PR.`);
      const marker = createHash('sha256').update(`${id}:${repositoryPath}:${row.sourceHash}:${row.targetHash}`).digest('hex').slice(0, 24);
      const creation: NonNullable<BranchReviewRepository['creation']> = { state: 'sending', sourceHash: row.sourceHash, targetHash: row.targetHash, startedAt: new Date().toISOString(), marker };
      await this.state.updateReview(id, value => { value.repositories!.find(entry => entry.repository.relativePath === repositoryPath)!.creation = creation; });
      try {
        const first = binding.pullRequests[0];
        const pr = await client.createPullRequest(row.repository, { sourceBranch: row.sourceBranch, targetBranch: row.targetBranch,
          title: first.title.slice(0, 255), description: `Changes for ${row.sourceBranch}, reviewed with ${first.url}.\n\nCreated by Branchline (review ${marker}).` });
        await this.link(id, row, pr);
      } catch (error) {
        // A successful link is durable even if the post-create revision check failed.
        if (!this.binding(id).repositories!.find(entry => entry.repository.relativePath === repositoryPath)!.prId) {
          await this.state.updateReview(id, value => { const saved = value.repositories!.find(entry => entry.repository.relativePath === repositoryPath)!;
            saved.creation = { ...creation, state: rejected(error) ? 'failed' : 'unknown', error: message(error) }; });
        }
        throw error;
      }
    });
  }
}
