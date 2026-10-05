import type { GitTimelineEntry, GitTimelineEvent } from '../../../shared/git-workflow';
import { layoutCommitGraph } from './commitGraph';

export const timelineEntryKey = (entry: GitTimelineEntry) =>
  JSON.stringify([entry.repositoryPath, entry.commit.hash]);
export interface TimelineRow {
  id: string;
  kind: 'event' | 'group';
  event: GitTimelineEvent;
  entry: GitTimelineEntry;
  group?: GitTimelineEvent[];
}

/** Only explicit, single-source merge messages establish a source and destination. */
export function mergeIdentity(entry: GitTimelineEntry): string | undefined {
  if (entry.commit.parents.length !== 2) return;
  const match = /^Merge (branch|remote-tracking branch) '([^']+)' into (.+)$/.exec(
    entry.commit.subject.trim(),
  );
  if (!match) return;
  return JSON.stringify([match[1], match[2], match[3]]);
}
export const rowMembers = (row: TimelineRow) =>
  row.group?.flatMap((event) => event.entries) ?? row.event.entries;

export function timelineRows(events: GitTimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (let index = 0; index < events.length;) {
    const event = events[index];
    const identity = mergeIdentity(event.entries[0]);
    let end = index + 1;
    if (identity) while (end < events.length && mergeIdentity(events[end].entries[0]) === identity) end++;
    const group = end - index > 1 ? events.slice(index, end) : undefined;
    rows.push({
      id: group ? `merges:${event.id}` : event.id,
      kind: group ? 'group' : 'event',
      event,
      entry: event.entries[0],
      group,
    });
    index = end;
  }
  return rows;
}

/** Contract only the redundant merge nodes, keeping every external parent edge. */
export function layoutProjectGraph(rows: TimelineRow[]) {
  const owners = new Map<string, string>();
  for (const row of rows) for (const entry of rowMembers(row)) owners.set(timelineEntryKey(entry), row.id);
  return layoutCommitGraph(
    rows.map((row) => ({
      hash: row.id,
      parents: [
        ...new Set(
          rowMembers(row).flatMap((entry) =>
            entry.commit.parents.map((hash) => {
              const key = timelineEntryKey({ ...entry, commit: { ...entry.commit, hash } });
              return owners.get(key) ?? key;
            }),
          ),
        ),
      ].filter((parent) => parent !== row.id),
    })),
  );
}

export function timelineSearch(event: GitTimelineEvent): string {
  return event.entries
    .map(({ repositoryPath, commit }) =>
      [
        repositoryPath,
        commit.hash,
        commit.subject,
        commit.body,
        commit.author,
        commit.email,
        ...commit.refs.map((ref) => ref.name),
      ].join(' '),
    )
    .join(' ')
    .toLowerCase();
}
