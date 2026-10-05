import type { GitCommit, GitTimelineEvent } from '../../shared/git-workflow';

export const commitKey = (path: string, hash: string) => JSON.stringify([path, hash]);
const depth = (path: string) => (path === '.' ? 0 : path.split('/').length);
const timestamp = (commit: GitCommit) => Date.parse(commit.committedAt ?? commit.date);

/** Interleave real repository histories without equating commits or inventing ancestry. */
export function projectGraphHistory(
  histories: { repositoryPath: string; commits: GitCommit[] }[],
): GitTimelineEvent[] {
  const streams = [...histories].sort(
    (a, b) =>
      depth(a.repositoryPath) - depth(b.repositoryPath) || a.repositoryPath.localeCompare(b.repositoryPath),
  );
  const offsets = streams.map(() => 0);
  const events: GitTimelineEvent[] = [];
  while (true) {
    let selected = -1;
    for (let index = 0; index < streams.length; index++) {
      const commit = streams[index].commits[offsets[index]];
      if (!commit) continue;
      if (selected < 0 || timestamp(commit) > timestamp(streams[selected].commits[offsets[selected]]))
        selected = index;
    }
    if (selected < 0) break;
    const repositoryPath = streams[selected].repositoryPath;
    const commit = streams[selected].commits[offsets[selected]++];
    events.push({
      id: commitKey(repositoryPath, commit.hash),
      entries: [{ repositoryPath, commit, association: 'anchor' }],
    });
  }
  return events;
}
