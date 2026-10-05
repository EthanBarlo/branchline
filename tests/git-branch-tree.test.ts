import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateCount, branchTree, branchKey, sidebarBranches, type GitSidebarBranch } from '../src/features/git/branchTree';
import type { GitProjectBranch } from '../shared/git-workflow';

const branch = (name: string, path = '.'): GitSidebarBranch => ({
  key: branchKey(name),
  name,
  repositories: [
    { path, local: true, remotes: [], current: false, incoming: null, outgoing: null, diverged: false },
  ],
});
test('project branch tree nests slash-separated names without losing prefix branches', () => {
  const root = branchTree([branch('main'), branch('feature'), branch('feature/a'), branch('feature/deep/b')]);
  assert.deepEqual(
    root.branches.map((item) => item.name),
    ['feature', 'main'],
  );
  assert.equal(root.folders[0].name, 'feature');
  assert.equal(root.folders[0].branches[0].name, 'feature/a');
  assert.equal(root.folders[0].folders[0].branches[0].name, 'feature/deep/b');
});
test('branch search preserves folders and finds names or repository paths', () => {
  const branches = [branch('feature/deep/b', 'packages/core'), branch('main')];
  assert.equal(branchTree(branches, 'CORE').folders[0].folders[0].branches[0].name, 'feature/deep/b');
  assert.equal(branchTree(branches, '  MAIN  ').branches[0].name, 'main');
  assert.equal(branchTree(branches, 'missing').folders.length, 0);
});
test('aggregate counts distinguish unknown destinations from up-to-date repositories', () => {
  assert.equal(aggregateCount([0, 0]), '0');
  assert.equal(aggregateCount([1, 2, 3]), '6');
  assert.equal(aggregateCount([null, null]), '—');
  assert.equal(aggregateCount([2, null]), '2 + ?');
});

test('local and remote sections preserve project membership and use distinct selection keys', () => {
  const fixture: GitProjectBranch[] = [{ name: 'feature/demo', repositories: [
    { path: '.', local: true, remotes: ['origin', 'mirror'], current: true, incoming: 1, outgoing: 2, diverged: true,
      remoteStatus: { origin: { head: 'a', incoming: 1, outgoing: 2, diverged: true }, mirror: { head: 'b', incoming: 0, outgoing: 3, diverged: false } } },
    { path: 'packages/core', local: false, remotes: ['origin'], current: false, incoming: null, outgoing: null, diverged: false },
  ] }];
  const branches = sidebarBranches(fixture);
  assert.equal(branches.length, 3);
  assert.equal(new Set(branches.map(branch => branch.key)).size, 3);
  const local = branches.find(branch => !branch.remote)!;
  assert.deepEqual(local.repositories.map(repo => repo.path), ['.']);
  const origin = branches.find(branch => branch.remote === 'origin')!;
  assert.equal(origin.repositories.length, 2);
  assert.equal(branchTree(branches, 'origin/feature').folders[0].branches[0].remote, 'origin');
  assert.equal(origin.repositories.some(repo => repo.current || repo.local), false);
  assert.equal(origin.repositories[0].incoming, 1);
  assert.equal(origin.repositories[0].outgoing, 2);
  assert.equal(branches.find(branch => branch.remote === 'mirror')!.repositories[0].outgoing, 3);
});

test('favourites and checked-out branches move above folders without duplicates, retaining search and scoped folders', () => {
  const favourite = branch('ethan/topic');
  const current = branch('release/current'); current.repositories[0].current = true;
  const other = branch('ethan/another');
  const root = branchTree([current, favourite, other], '', 'Local', new Set([favourite.key]));
  assert.deepEqual(root.pinned.map(branch => branch.name), ['ethan/topic', 'release/current']);
  assert.equal(root.folders[0].path, 'Local/ethan');
  assert.deepEqual(root.folders[0].branches.map(branch => branch.name), ['ethan/another']);
  assert.equal(branchTree([favourite, other], 'topic', 'Local', new Set([favourite.key])).pinned.length, 1);
  const remote = branchTree([other], '', 'Remote/origin');
  assert.equal(remote.folders[0].path, 'Remote/origin/ethan');
});
