import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitWorkflowSnapshot } from '../shared/git-workflow';
import { mergeGitSnapshot } from '../src/features/git/snapshotState';

const snapshot: GitWorkflowSnapshot = {
  projectId: 'project', version: 2, loading: false, cached: false, pendingRepositories: [],
  repositories: [], branches: [{ name: 'main', repositories: [] }],
};

test('unchanged checks retain the displayed snapshot and tree references', () => {
  assert.equal(mergeGitSnapshot(snapshot, { ...structuredClone(snapshot), version: 3 }), snapshot);
});

test('refresh progress preserves the branch tree and repository references', () => {
  const refreshing = mergeGitSnapshot(snapshot, { ...structuredClone(snapshot), version: 3, loading: true });
  assert.notEqual(refreshing, snapshot);
  assert.equal(refreshing.branches, snapshot.branches);
  assert.equal(refreshing.repositories, snapshot.repositories);
  assert.equal(refreshing.loading, true);
});

test('external branch edits and project changes replace the relevant state', () => {
  const changed = mergeGitSnapshot(snapshot, { ...snapshot, branches: [{ name: 'feature', repositories: [] }] });
  assert.equal(changed.branches[0].name, 'feature');
  assert.equal(changed.repositories, snapshot.repositories);
  const other = { ...snapshot, projectId: 'other' };
  assert.equal(mergeGitSnapshot(snapshot, other), other);
});
