import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitCommit, GitTimelineEvent } from '../shared/git-workflow';
import { projectGraphHistory } from '../electron/git/project-history';
import { layoutProjectGraph, mergeIdentity, rowMembers, timelineRows } from '../src/features/git/timeline';

function commit(hash: string, seconds = 0, parents = ['a', 'b'], subject = "Merge branch 'v3.5' into staging"): GitCommit {
  return { hash, parents, author: 'Example', email: 'example@invalid.test', date: new Date(1700000000000 + seconds * 1000).toISOString(), committedAt: new Date(1700000000000 + seconds * 1000).toISOString(), subject, body: '', refs: [] };
}
function event(value: GitCommit, path = '.'): GitTimelineEvent {
  return { id: JSON.stringify([path, value.hash]), entries: [{ repositoryPath: path, commit: value, association: 'anchor' }] };
}

test('adjacent merges of the exact source and target collapse across days, authors and repositories', () => {
  const events = [event(commit('first', 100000)), event({ ...commit('second', 0), author: 'Other', email: 'other@invalid.test' }, 'core'), event(commit('third', -100000))];
  const rows = timelineRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group?.length, 3);
  assert.deepEqual(rowMembers(rows[0]).map((entry) => entry.commit.hash), ['first', 'second', 'third']);
});

test('different source, destination and intervening ordinary commits break a merge run', () => {
  const events = [event(commit('first')), event(commit('dev', 0, ['a', 'b'], "Merge branch 'v3.5' into dev")), event(commit('other', 0, ['a', 'b'], "Merge branch 'v3.4' into dev")), event(commit('regular', 0, ['a'], 'Work on the feature')), event(commit('last'))];
  assert.equal(timelineRows(events).length, 5);
  assert.ok(timelineRows(events).every((row) => !row.group));
});

test('unknown destinations, ordinary lookalike subjects and octopus merges stay independent', () => {
  for (const value of [commit('missing', 0, ['a', 'b'], "Merge branch 'v3.5'"), commit('ordinary', 0, ['a']), commit('octopus', 0, ['a', 'b', 'c']), commit('pr', 0, ['a', 'b'], 'Merged in feature (pull request #42)')]) {
    assert.equal(mergeIdentity(event(value).entries[0]), undefined);
    assert.equal(timelineRows([event(value), event({ ...value, hash: 'next' })]).length, 2);
  }
  assert.notEqual(mergeIdentity(event(commit('local')).entries[0]), mergeIdentity(event(commit('remote', 0, ['a', 'b'], "Merge remote-tracking branch 'v3.5' into staging")).entries[0]));
});

test('contracting merge rows retains every side-branch commit and connects all external parents', () => {
  const events = [event(commit('merge2', 0, ['merge1', 'side2'])), event(commit('merge1', 0, ['base', 'side1'])), event(commit('side2', 0, ['side1'], 'Second feature change')), event(commit('side1', 0, ['base'], 'First feature change')), event(commit('base', 0, [], 'Base'))];
  const rows = timelineRows(events);
  assert.deepEqual(rows.map((row) => row.entry.commit.hash), ['merge2', 'side2', 'side1', 'base']);
  const graph = layoutProjectGraph(rows);
  assert.equal(graph.rows[0].edges.length, 3, 'both feature parents and target history remain connected');
  assert.equal(graph.rows[0].continuations.length, 0);
  assert.equal(graph.rows.at(-1)!.edges.length, 0);
  assert.ok(graph.rows.every((row) => row.continuations.length === 0));
});

test('equal hashes across repositories are independent graph nodes', () => {
  const events = projectGraphHistory([{ repositoryPath: '.', commits: [commit('tip', 0, ['base'], 'Root work'), commit('base', 0, [], 'Root base')] }, { repositoryPath: 'core', commits: [commit('tip', 100, ['base'], 'Child work'), commit('base', 0, [], 'Child base')] }]);
  assert.equal(events.length, 4);
  assert.equal(new Set(events.map((value) => value.id)).size, 4);
  const graph = layoutProjectGraph(timelineRows(events));
  assert.equal(graph.lanes, 2);
  assert.equal(graph.rows.filter((row) => row.edges.length === 0).length, 1);
  assert.ok(graph.rows.every((row) => row.continuations.length === 0));
});

test('combined history retains every branch commit and per-repository order despite clock skew', () => {
  const events = projectGraphHistory([{ repositoryPath: '.', commits: [commit('newest', 0), commit('older', 0), commit('base', 200, [], 'Base')] }, { repositoryPath: 'core', commits: [commit('feature', 50, [], 'Feature commit')] }]);
  assert.deepEqual(events.filter((value) => value.entries[0].repositoryPath === '.').map((value) => value.entries[0].commit.hash), ['newest', 'older', 'base']);
  assert.equal(events.length, 4);
  assert.equal(events[0].entries[0].commit.hash, 'feature');
});
