import type { GitCommit } from '../../../shared/git-workflow';

interface Lane {
  hash: string;
  color: number;
}
export interface GraphEdge {
  from: number;
  to: number;
  color: number;
}
export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** Incoming half-edges terminate at this row's centre. */
  incoming: { lane: number; color: number }[];
  continuations: { hash: string; lane: number; color: number; incoming?: boolean }[];
}

export const maxGraphLanes = 10;

/** Follow parent hashes, rather than dates or branch names, through merges and forks. */
export function layoutCommitGraph(commits: Pick<GitCommit, 'hash' | 'parents'>[]): {
  rows: GraphRow[];
  lanes: number;
} {
  const loaded = new Set(commits.map((commit) => commit.hash));
  let active: Lane[] = [];
  let nextColor = 0;
  let lanes = 1;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    let incoming = active.map((entry, lane) => ({ lane, color: entry.color }));
    const continuations: GraphRow['continuations'] = [];
    let lane = active.findIndex((entry) => entry.hash === commit.hash);
    if (lane < 0) {
      if (active.length >= maxGraphLanes) {
        const removed = active.pop()!;
        continuations.push({ ...removed, lane: maxGraphLanes - 1, incoming: true });
        incoming = incoming.filter((entry) => entry.lane !== maxGraphLanes - 1);
      }
      lane = active.length;
      active.push({ hash: commit.hash, color: nextColor++ });
    }
    const color = active[lane].color;
    const before = [...active];
    const after = active.filter((_, index) => index !== lane);
    const parents = [...new Set(commit.parents)];
    for (const [index, hash] of parents.entries()) {
      if (after.some((entry) => entry.hash === hash)) continue;
      if (!loaded.has(hash) || after.length >= maxGraphLanes) {
        continuations.push({ hash, lane, color });
        continue;
      }
      if (index === 0) after.splice(Math.min(lane, after.length), 0, { hash, color });
      else after.push({ hash, color: nextColor++ });
    }
    const edges: GraphEdge[] = [];
    for (const [from, entry] of before.entries()) {
      if (from === lane) continue;
      const to = after.findIndex((target) => target.hash === entry.hash);
      edges.push({ from, to, color: entry.color });
    }
    for (const [index, parent] of parents.entries()) {
      const to = after.findIndex((entry) => entry.hash === parent);
      if (to < 0) continue;
      edges.push({ from: lane, to, color: index === 0 ? color : after[to].color });
    }
    lanes = Math.max(lanes, before.length, after.length);
    rows.push({ lane, color, edges, incoming, continuations });
    active = after;
  }
  return { rows, lanes };
}
