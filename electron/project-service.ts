import { inspectRepo } from './git';
import type { NewProject, NewReview, RepoInspection } from '../shared/types';
import { ReviewStore } from './store';

export function defaultTarget(inspection: RepoInspection): string | null {
  return ['main', 'master', 'develop', 'origin/main', 'origin/master', 'origin/develop']
    .find(branch => inspection.branches.includes(branch))
    ?? inspection.branches.find(branch => branch !== inspection.currentBranch)
    ?? inspection.currentBranch
    ?? null;
}

export function validBranch(inspection: RepoInspection, value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`Choose an available ${label.toLowerCase()}.`);
  const branch = value.trim();
  const normalized = branch.replace(/^refs\/(heads|remotes)\//, '');
  const matches = inspection.branches.filter(ref => ref === normalized || ref === `origin/${normalized}`);
  if (!branch || !matches.length) throw new Error(`${label} “${branch}” is not available in this repository. Choose an available branch, or fetch it outside Branchline.`);
  // Persist the same branch names shown by the picker so aliases use the Git
  // engine's documented local-first / remote-tracking fallback consistently.
  return normalized;
}

/** Saved reviews explicitly name a branch; Current follows the checkout separately. */
export class ProjectService {
  constructor(private store: ReviewStore, private inspect = inspectRepo) {}

  async createProject(input: NewProject) {
    const inspection = await this.inspect(input.repoPath);
    return this.store.createProject({
      repoPath: inspection.rootPath,
      name: input.name?.trim() || inspection.name,
      defaultBaseBranch: null,
    });
  }

  async createReview(input: NewReview) {
    const project = input.projectId ? this.store.getProject(input.projectId) : undefined;
    const repoPath = project?.repoPath ?? input.repoPath;
    if (!repoPath) throw new Error('Choose a project before creating a review.');
    const inspection = await this.inspect(repoPath);
    const featureBranch = input.featureBranch?.trim();
    if (!featureBranch) throw new Error('Choose the feature branch for this saved review. Use Current to follow your checkout.');
    const target = input.baseBranch?.trim() || project?.defaultBaseBranch || defaultTarget(inspection);
    if (!target) throw new Error('Choose a target branch to review against.');
    return this.store.createReview({
      projectId: project?.id,
      repoPath: inspection.rootPath,
      name: input.name?.trim() || featureBranch,
      baseBranch: validBranch(inspection, target, 'Target branch'),
      featureBranch: validBranch(inspection, featureBranch, 'Feature branch'),
      includeWorkingTree: input.includeWorkingTree === true,
    });
  }
}
