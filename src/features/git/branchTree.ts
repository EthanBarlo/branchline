import type { GitProjectBranch } from '../../../shared/git-workflow';

export interface GitSidebarBranch extends GitProjectBranch {
  key: string;
  remote?: string;
}

export const branchKey = (name: string, remote?: string): string => JSON.stringify([remote ?? null, name]);

/** Separate local refs and each remote while keeping one row per logical branch in each section. */
export function sidebarBranches(branches: GitProjectBranch[]): GitSidebarBranch[] {
  return branches.flatMap((branch) => {
    const result: GitSidebarBranch[] = [];
    const local = branch.repositories.filter((repo) => repo.local);
    if (local.length) result.push({ name: branch.name, key: branchKey(branch.name), repositories: local });
    const remotes = [...new Set(branch.repositories.flatMap((repo) => repo.remotes))].sort();
    for (const remote of remotes)
      result.push({
        name: branch.name,
        key: branchKey(branch.name, remote),
        remote,
        repositories: branch.repositories
          .filter((repo) => repo.remotes.includes(remote))
          .map((repo) => {
            const state = repo.remoteStatus?.[remote];
            return {
              ...repo,
              local: false,
              current: false,
              remotes: [remote],
              incoming: state?.incoming ?? null,
              outgoing: state?.outgoing ?? null,
              diverged: state?.diverged ?? false,
              upstream: { remote, branch: branch.name, commit: state?.head ?? null },
              pushTarget: undefined,
            };
          }),
      });
    return result;
  });
}

export interface BranchFolder {
  path: string;
  name: string;
  folders: BranchFolder[];
  branches: GitSidebarBranch[];
  pinned: GitSidebarBranch[];
}

export function branchTree(
  branches: GitSidebarBranch[],
  query = '',
  prefix = '',
  favourites: ReadonlySet<string> = new Set(),
): BranchFolder {
  const root: BranchFolder = { path: prefix, name: '', folders: [], branches: [], pinned: [] };
  const search = query.trim().toLocaleLowerCase();
  for (const branch of branches) {
    if (
      search &&
      !`${branch.remote ? `${branch.remote}/` : ''}${branch.name} ${branch.repositories.map((repo) => repo.path).join(' ')}`
        .toLocaleLowerCase()
        .includes(search)
    )
      continue;
    if (favourites.has(branch.key) || branch.repositories.some((repo) => repo.current)) {
      root.pinned.push(branch);
      continue;
    }
    const parts = branch.name.split('/');
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let next = folder.folders.find((item) => item.path === path);
      if (!next) {
        next = { path, name, folders: [], branches: [], pinned: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.branches.push(branch);
  }
  const sort = (folder: BranchFolder) => {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.branches.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sort);
  };
  root.pinned.sort(
    (a, b) => Number(favourites.has(b.key)) - Number(favourites.has(a.key)) || a.name.localeCompare(b.name),
  );
  sort(root);
  return root;
}

/** Unknown or unpublished destinations remain visible instead of becoming zero. */
export function aggregateCount(values: (number | null)[]): string {
  const known = values.filter((value): value is number => value !== null);
  if (!known.length) return '—';
  const total = known.reduce((sum, value) => sum + value, 0);
  return `${total}${known.length < values.length ? ' + ?' : ''}`;
}
