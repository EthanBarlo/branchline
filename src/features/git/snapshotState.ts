import type { GitWorkflowSnapshot } from '../../../shared/git-workflow';

/** Preserve branch/tree references when a check only changes refresh metadata. */
export function mergeGitSnapshot(
  previous: GitWorkflowSnapshot | undefined,
  result: GitWorkflowSnapshot,
): GitWorkflowSnapshot {
  if (previous?.projectId !== result.projectId) return result;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const repositories = same(previous.repositories, result.repositories)
    ? previous.repositories
    : result.repositories;
  const branches = same(previous.branches, result.branches) ? previous.branches : result.branches;
  const operation = same(previous.operation, result.operation) ? previous.operation : result.operation;
  if (
    repositories === previous.repositories &&
    branches === previous.branches &&
    operation === previous.operation &&
    !!previous.cached === !!result.cached &&
    !!previous.loading === !!result.loading &&
    same(previous.pendingRepositories ?? [], result.pendingRepositories ?? [])
  )
    return previous;
  return { ...result, repositories, branches, operation };
}
