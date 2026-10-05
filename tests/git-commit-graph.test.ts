import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutCommitGraph, maxGraphLanes } from '../src/features/git/commitGraph';

test('merge parents retain separate lanes until the common ancestor', () => {
  const { rows, lanes } = layoutCommitGraph([
    { hash: 'merge', parents: ['left', 'right'] },
    { hash: 'left', parents: ['base'] },
    { hash: 'right', parents: ['base'] },
    { hash: 'base', parents: [] },
  ]);
  assert.equal(lanes, 2);
  assert.deepEqual(rows.map((row) => row.lane), [0, 0, 1, 0]);
  assert.deepEqual(rows[0].edges.map(({ from, to }) => [from, to]), [[0, 0], [0, 1]]);
  assert.deepEqual(rows[2].edges.map(({ from, to }) => [from, to]), [[0, 0], [1, 0]]);
  assert.equal(rows[0].color, rows[1].color);
  assert.notEqual(rows[0].color, rows[2].color);
  assert.equal(rows[3].edges.length, 0);
});

test('octopus merges and lane collapse preserve passing branches', () => {
  const graph = layoutCommitGraph([
    { hash: 'merge', parents: ['a', 'b', 'c'] },
    { hash: 'b', parents: [] },
    { hash: 'a', parents: ['root'] },
    { hash: 'c', parents: ['root'] },
    { hash: 'root', parents: [] },
  ]);
  assert.equal(graph.lanes, 3);
  assert.equal(graph.rows[0].edges.length, 3);
  assert.deepEqual(graph.rows[1].edges.map(({ from, to }) => [from, to]), [[0, 0], [2, 1]]);
  assert.deepEqual(graph.rows.map((row) => row.lane), [0, 1, 0, 1, 0]);
  for (const row of graph.rows) assert.ok(row.edges.every((edge) => edge.from >= 0 && edge.to >= 0));
});

test('disconnected histories, truncated parents and empty logs are supported', () => {
  const graph = layoutCommitGraph([
    { hash: 'first', parents: ['unloaded'] },
    { hash: 'second', parents: [] },
  ]);
  assert.equal(graph.lanes, 1);
  assert.deepEqual(graph.rows[1].incoming, []);
  assert.deepEqual(graph.rows[1].edges, []);
  assert.equal(graph.rows[0].continuations[0].hash, 'unloaded');
  assert.deepEqual(layoutCommitGraph([]), { rows: [], lanes: 1 });
});


test('unloaded parents do not accumulate lanes and loaded ancestry stays bounded', () => {
  const truncated = layoutCommitGraph(Array.from({ length: 80 }, (_, index) => ({ hash: `merge${index}`, parents: [`merge${index + 1}`, `unloaded${index}`] })));
  assert.equal(truncated.lanes, 1);
  assert.ok(truncated.rows.every((row) => row.continuations.length));
  const commits = [
    ...Array.from({ length: 30 }, (_, index) => ({ hash: `tip${index}`, parents: [`parent${index}`] })),
    ...Array.from({ length: 30 }, (_, index) => ({ hash: `parent${index}`, parents: [] })),
  ];
  const bounded = layoutCommitGraph(commits);
  assert.equal(bounded.lanes, maxGraphLanes);
  assert.ok(bounded.rows.some((row) => row.continuations.some((entry) => entry.incoming)));
  assert.ok(bounded.rows.every((row) => row.lane < maxGraphLanes && row.edges.every((edge) => edge.to < maxGraphLanes && edge.from < maxGraphLanes)));
});
