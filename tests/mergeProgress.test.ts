import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BranchReviewRepository, MergeOperation, MergeProgress, PullRequest } from '../shared/integrations';
import { repositoryMergeProgress } from "../src/features/integrations/mergeProgress";

type Input = Parameters<typeof repositoryMergeProgress>[0];

function fixture(): { row: BranchReviewRepository; pr: PullRequest; item: MergeProgress; operation: MergeOperation; action: 'merge' } {
  const pr: PullRequest = {
    id: 1, repository: { workspace: 'example', repoSlug: 'child', relativePath: 'child' },
    title: 'Branch changes', url: 'https://bitbucket.org/example/child/pull-requests/1',
    sourceBranch: 'feature/TEST-1', targetBranch: 'main', sourceHash: 'source', targetHash: 'target',
    author: { id: 'author', name: 'Author' }, reviewers: [], participants: [],
    state: 'OPEN', draft: false, mergeStrategies: ['merge_commit'],
  };
  const row: BranchReviewRepository = {
    repository: pr.repository, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch,
    status: 'pull-request', prId: pr.id, check: { state: 'ready' },
  };
  const item: MergeProgress = { prKey: 'child#1', approval: 'pending', merge: 'pending', sourceHash: pr.sourceHash, targetHash: pr.targetHash };
  const operation: MergeOperation = { action: 'merge', state: 'running', items: [item], updatedAt: '2026-09-23T00:00:00Z' };
  return { row, pr, item, operation, action: 'merge' };
}

function progress(overrides: Partial<Input> = {}) {
  return repositoryMergeProgress({ ...fixture(), ...overrides });
}

test('repository stages stay stable while their provider subchecks cycle', () => {
  const input = fixture();
  const stages: Array<[MergeProgress['phase'], string]> = [
    ['checking', 'Checking…'], ['approving', 'Approving…'], ['merging', 'Merging…'], ['cleanup', 'Deleting branch…'],
  ];
  for (const [phase, label] of stages) {
    input.item.phase = phase;
    if (phase === 'merging') input.item.approval = 'approved';
    if (phase === 'cleanup') input.item.merge = 'merged';
    for (const state of ['queued', 'checking', 'ready', 'queued', 'checking', 'ready'] as const) {
      input.row.check = { state };
      const displayed = repositoryMergeProgress({ ...input, checking: true });
      assert.equal(displayed.status.label, label);
      assert.equal(displayed.status.tone, 'active');
      assert.equal(displayed.finished, false);
    }
  }
});

test('preview subchecks do not repeatedly mark a repository checked or completed', () => {
  const { row } = fixture();
  for (const state of ['queued', 'checking', 'ready', 'queued', 'ready'] as const) {
    const displayed = progress({ row: { ...row, check: { state } }, item: undefined, operation: undefined, checking: true });
    assert.equal(displayed.status.label, 'Checking…');
    assert.equal(displayed.finished, false);
  }
  assert.equal(progress({ item: undefined, operation: undefined }).status.label, 'Ready');
  assert.equal(progress({ item: undefined, operation: undefined, running: true }).status.label, 'Checking…');
});

test('successful deletion remains done while unrelated repositories check or the group pauses', () => {
  const { row, item, operation } = fixture();
  for (const state of ['running', 'paused', 'complete'] as const) {
    const displayed = progress({
      row: { ...row, check: { state: 'checking' }, cleanup: { state: 'deleted' } },
      item: { ...item, merge: 'merged', phase: 'cleanup' }, operation: { ...operation, state }, checking: true,
    });
    assert.equal(displayed.status.label, 'Done');
    assert.equal(displayed.status.tone, 'complete');
    assert.equal(displayed.cleanup, 'deleted');
    assert.equal(displayed.finished, true);
  }
});

test('empty and missing branches finish only after cleanup receipts and retain their skipped explanation', () => {
  const { row } = fixture();
  for (const status of ['no-changes', 'missing-branch'] as const) {
    const branch = { ...row, status, prId: undefined };
    assert.equal(progress({ row: branch, pr: undefined, item: undefined }).finished, false);
    const displayed = progress({ row: { ...branch, cleanup: { state: status === 'no-changes' ? 'deleted' : 'skipped' } }, pr: undefined, item: undefined });
    assert.equal(displayed.status.label, 'Done');
    assert.equal(displayed.detail, status === 'no-changes' ? 'Skipped · no changes' : 'Skipped · branch missing');
    assert.equal(displayed.finished, true);
  }
});

test('a merge alone or retained or uncertain cleanup never counts as completed', () => {
  const { row, item } = fixture();
  const merged = { ...item, merge: 'merged' as const, phase: 'cleanup' as const };
  assert.equal(progress({ item: merged }).status.label, 'Deleting branch…');
  assert.equal(progress({ item: merged }).finished, false);
  for (const state of ['retained', 'unknown'] as const) {
    const displayed = progress({ row: { ...row, cleanup: { state } }, item: merged });
    assert.equal(displayed.status.label, 'Merged · cleanup paused');
    assert.equal(displayed.status.tone, 'warning');
    assert.equal(displayed.finished, false);
  }
});

test('merged and unchanged repositories wait for the group before branch cleanup starts', () => {
  const { row, item } = fixture();
  for (const state of ['queued', 'checking', 'ready'] as const) {
    const merged = progress({ row: { ...row, check: { state } }, item: { ...item, merge: 'merged' } });
    assert.equal(merged.status.label, 'Merged · waiting for other merges');
    assert.equal(merged.status.tone, 'waiting');
    assert.equal(merged.finished, false);
    const empty = progress({ row: { ...row, status: 'no-changes', prId: undefined, check: { state } }, pr: undefined, item: undefined });
    assert.equal(empty.status.label, 'Waiting for merges');
    assert.equal(empty.finished, false);
  }
  for (const state of ['checking', 'sending'] as const) {
    const cleanup = progress({ row: { ...row, cleanup: { state } }, item: { ...item, merge: 'merged' } });
    assert.equal(cleanup.status.label, 'Deleting branch…');
    assert.equal(cleanup.status.tone, 'active');
  }
});

test('legacy PR progress uses its own cleanup receipt when no persisted repository row exists', () => {
  const { row, item, pr } = fixture();
  const displayed = progress({ row: { ...row, check: undefined }, pr: { ...pr, state: 'MERGED' }, item: { ...item, merge: 'merged', cleanup: 'deleted', skipped: true } });
  assert.equal(displayed.status.label, 'Done');
  assert.equal(displayed.detail, 'Skipped · already merged');
  assert.equal(displayed.cleanup, 'deleted');
  assert.equal(displayed.finished, true);
});

test('a reconciled external merge supersedes an earlier approval failure', () => {
  const { item, row, operation } = fixture();
  const confirmed = { ...item, approval: 'failed' as const, merge: 'merged' as const, cleanup: 'deleted' as const };
  const displayed = progress({ row: { ...row, cleanup: { state: 'deleted' } }, item: confirmed, operation: { ...operation, state: 'complete' } });
  assert.equal(displayed.status.label, 'Done');
  assert.equal(displayed.finished, true);
  assert.equal(progress({ item: { ...confirmed, error: 'The merged source was not reviewed' } }).finished, false);
});

test('current failures and uncertain delivery stay visible while other workers remain running', () => {
  const { row, item, operation } = fixture();
  const cases: Array<{ input: Partial<Input>; label: string; error?: string }> = [
    { input: { item: { ...item, approval: 'failed', phase: 'approving', error: 'Approval refused' } }, label: 'Failed', error: 'Approval refused' },
    { input: { item: { ...item, merge: 'failed', phase: 'merging', error: 'Merge refused' } }, label: 'Failed', error: 'Merge refused' },
    { input: { item: { ...item, merge: 'unknown', phase: 'merging' } }, label: 'Awaiting confirmation' },
    { input: { row: { ...row, check: { state: 'failed', error: 'Branch changed' } }, item: { ...item, phase: 'merging' } }, label: 'Check failed', error: 'Branch changed' },
    { input: { row: { ...row, status: 'unavailable' } }, label: 'Unavailable' },
    { input: { item: { ...item, phase: 'merging', error: 'Permission denied' } }, label: 'Paused', error: 'Permission denied' },
    { input: { item: { ...item, merge: 'sending' }, operation: { ...operation, state: 'paused' } }, label: 'Awaiting confirmation' },
  ];
  for (const entry of cases) {
    const displayed = progress({ ...entry.input, running: true });
    assert.equal(displayed.status.label, entry.label);
    assert.equal(displayed.status.tone, 'warning');
    assert.equal(displayed.finished, false);
    assert.equal(displayed.error, entry.error);
  }
});

test('pointer updates and mandatory review remain distinct stages', () => {
  const { item, operation } = fixture();
  assert.equal(progress({ item: { ...item, phase: 'updating-pointers', pointerState: 'pushing' } }).status.label, 'Updating pointers…');
  for (const state of ['running', 'paused'] as const) {
    const displayed = progress({ item: { ...item, phase: 'updating-pointers', pointerState: 'review' }, operation: { ...operation, state }, checking: true });
    assert.equal(displayed.status.label, 'Needs review');
    assert.equal(displayed.status.tone, 'warning');
    assert.equal(displayed.finished, false);
  }
});

test('approve-only completes without cleanup and stale approvals do not skip resumed checking', () => {
  const { item, operation, row } = fixture();
  const approved = { ...item, approval: 'approved' as const };
  const displayed = progress({ action: 'approve', item: approved, operation: { ...operation, action: 'approve', state: 'complete' } });
  assert.equal(displayed.status.label, 'Approved');
  assert.equal(displayed.finished, true);
  assert.equal(displayed.cleanup, undefined);
  for (const action of ['merge', 'approve'] as const) {
    assert.equal(progress({ action, item: { ...approved, phase: 'checking' }, operation: { ...operation, action } }).status.label, 'Checking…');
  }
  const skipped = progress({ action: 'approve', row: { ...row, status: 'no-changes', prId: undefined }, pr: undefined, item: undefined, operation: { ...operation, action: 'approve', state: 'complete' } });
  assert.equal(skipped.status.label, 'Skipped · no changes');
  assert.equal(skipped.finished, true);
});

test('fresh retry phases replace old known-failure receipts after their errors are cleared', () => {
  const { item } = fixture();
  for (const previous of [{ ...item, approval: 'failed' as const }, { ...item, merge: 'failed' as const }]) {
    assert.equal(progress({ item: previous }).status.label, 'Failed');
    for (const [phase, label] of [['checking', 'Checking…'], ['approving', 'Approving…'], ['merging', 'Merging…']] as const) {
      const displayed = progress({ item: { ...previous, phase, error: undefined } });
      assert.equal(displayed.status.label, label);
      assert.equal(displayed.finished, false);
    }
  }
});

test('PR creation before operation initialization remains visible with explicit failure states', () => {
  const { row } = fixture();
  for (const [state, label] of [['sending', 'Creating PR…'], ['unknown', 'PR creation unconfirmed'], ['failed', 'PR creation failed']] as const) {
    const displayed = progress({
      row: { ...row, status: 'changes', prId: undefined, creation: { state, sourceHash: 'source', targetHash: 'target', marker: 'marker', startedAt: '2026-09-23T00:00:00Z' } },
      pr: undefined, item: undefined, operation: undefined, running: true,
    });
    assert.equal(displayed.status.label, label);
    assert.equal(displayed.status.tone, state === 'sending' ? 'active' : 'warning');
    assert.equal(displayed.finished, false);
  }
});
