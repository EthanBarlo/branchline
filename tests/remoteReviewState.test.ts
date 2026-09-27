import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  FeedbackItem,
  FeedbackPreview,
  MergePreview,
  PullRequest,
  RemoteReviewState,
} from '../shared/integrations';
import { remoteReviewState } from '../src/features/integrations/remote-review/remoteReviewState';

type StateInput = Parameters<typeof remoteReviewState>[0];

function fixture(): StateInput & { remote: RemoteReviewState; merge: MergePreview } {
  const pr: PullRequest = {
    id: 1,
    repository: { workspace: 'example', repoSlug: 'app', relativePath: '.' },
    title: 'Branch changes',
    url: 'https://bitbucket.org/example/app/pull-requests/1',
    sourceBranch: 'feature/TEST-1',
    targetBranch: 'main',
    sourceHash: 'source',
    targetHash: 'target',
    author: { id: 'author', name: 'Author' },
    reviewers: [],
    participants: [],
    state: 'OPEN',
    draft: false,
    mergeStrategies: ['merge_commit'],
  };
  const remote: RemoteReviewState = {
    connectionId: 'connection',
    publications: {},
    pullRequests: [pr],
    repositories: [
      {
        repository: pr.repository,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        status: 'pull-request',
        prId: pr.id,
      },
    ],
    operation: {
      action: 'merge',
      state: 'paused',
      updatedAt: '2026-09-27T00:00:00Z',
      items: [
        {
          prKey: '.#1',
          approval: 'approved',
          merge: 'merged',
          sourceHash: pr.sourceHash,
          targetHash: pr.targetHash,
        },
      ],
    },
  };
  return {
    remote,
    merge: {
      pullRequests: remote.pullRequests,
      repositories: remote.repositories,
      blockers: [],
      warnings: [],
      updateSubmodulePointers: false,
    },
    feedback: null,
    dialog: 'merge',
    busy: false,
    loading: false,
  };
}

function feedback(states: FeedbackItem['state'][], blockers: string[] = []): FeedbackPreview {
  return {
    blockers,
    items: states.map((state, index) => ({
      commentId: `comment-${index}`,
      repositoryPath: '.',
      prId: 1,
      path: 'app.ts',
      side: 'additions',
      lineStart: 1,
      lineEnd: 1,
      body: 'Review feedback',
      action: 'create',
      state,
    })),
  };
}

test('publication cannot retry uncertain delivery or overwrite unresolved conflicts', () => {
  const input = fixture();
  for (const states of [
    [],
    ['unknown'],
    ['conflict'],
    ['unknown', 'conflict'],
  ] as FeedbackItem['state'][][]) {
    assert.equal(
      remoteReviewState({ ...input, dialog: 'publish', feedback: feedback(states) }).publishable,
      false,
    );
  }
  assert.equal(
    remoteReviewState({ ...input, dialog: 'publish', feedback: feedback(['unknown', 'draft']) }).publishable,
    true,
  );
  assert.equal(
    remoteReviewState({ ...input, dialog: 'publish', feedback: feedback(['draft'], ['Branch changed']) })
      .publishable,
    false,
  );
});

test('provider completion still offers resume until branch cleanup is confirmed', () => {
  const input = fixture();
  input.remote.operation!.state = 'complete';
  input.remote.pullRequests[0].state = 'MERGED';
  const pending = remoteReviewState(input);
  assert.equal(pending.readyToFinish, false);
  assert.equal(pending.resumeNeeded, true);
  assert.equal(pending.canMerge, true);

  input.remote.operation!.items[0].cleanup = 'deleted';
  input.remote.repositories![0].cleanup = { state: 'deleted' };
  const completed = remoteReviewState(input);
  assert.equal(completed.readyToFinish, true);
  assert.equal(completed.resumeNeeded, false);
  assert.equal(
    completed.canMerge,
    true,
    'Finishing local review removal remains available after remote completion.',
  );
});

test('blockers prevent resuming merges or approving the branch', () => {
  const input = fixture();
  input.merge.blockers = ['A repository is unavailable'];
  const view = remoteReviewState(input);
  assert.equal(view.canMerge, false);
  assert.equal(view.canApprove, false);
});

test('new repositories still require approval work after earlier PRs completed', () => {
  const input = fixture();
  input.dialog = 'approve';
  input.remote.operation!.action = 'approve';
  input.remote.operation!.state = 'complete';
  input.remote.pullRequests[0].state = 'MERGED';
  input.remote.repositories!.push({
    repository: { workspace: 'example', repoSlug: 'child', relativePath: 'child' },
    sourceBranch: 'feature/TEST-1',
    targetBranch: 'main',
    status: 'changes',
  });
  const view = remoteReviewState(input);
  assert.equal(view.completed, false);
  assert.equal(view.canApprove, true, 'Approving can create the missing PR.');
  assert.equal(view.canMerge, true);
});

test('empty and missing branches keep cleanup available until their receipts are saved', () => {
  for (const status of ['no-changes', 'missing-branch'] as const) {
    const input = fixture();
    input.remote.operation = undefined;
    input.merge.pullRequests = [];
    input.merge.repositories = [
      {
        repository: input.remote.pullRequests[0].repository,
        sourceBranch: 'feature/TEST-1',
        targetBranch: 'main',
        status,
      },
    ];
    assert.equal(remoteReviewState(input).canMerge, true);
    input.merge.repositories[0].cleanup = { state: status === 'no-changes' ? 'deleted' : 'skipped' };
    assert.equal(remoteReviewState(input).canMerge, false);
  }
});

test('approval does not become available before preview or for draft-only branches', () => {
  const input = fixture();
  assert.equal(remoteReviewState({ ...input, merge: null }).canApprove, false);
  assert.equal(remoteReviewState({ ...input, merge: null }).canMerge, false);
  input.merge.pullRequests[0].draft = true;
  assert.equal(remoteReviewState(input).canApprove, false);
});

test('live operation progress wins while running and preview revisions win while idle', () => {
  const input = fixture();
  input.merge.pullRequests = [{ ...input.remote.pullRequests[0], sourceHash: 'preview-source' }];
  input.merge.repositories = [{ ...input.remote.repositories![0], check: { state: 'ready' } }];
  assert.equal(remoteReviewState(input).progressPullRequests, input.merge.pullRequests);
  assert.equal(remoteReviewState(input).repositoryProgress, input.merge.repositories);
  assert.equal(remoteReviewState({ ...input, busy: true }).progressPullRequests, input.remote.pullRequests);
  assert.equal(remoteReviewState({ ...input, busy: true }).repositoryProgress, input.remote.repositories);
  assert.equal(remoteReviewState({ ...input, loading: true }).repositoryProgress, input.remote.repositories);
});

test('operation completion and progress only apply to their matching dialog', () => {
  const input = fixture();
  input.remote.operation!.action = 'approve';
  input.remote.operation!.state = 'complete';
  assert.equal(remoteReviewState({ ...input, dialog: 'approve' }).completed, true);
  assert.equal(remoteReviewState(input).completed, false);
  assert.equal(remoteReviewState(input).visibleOperation, undefined);
  assert.equal(remoteReviewState({ ...input, dialog: 'publish' }).visibleOperation, undefined);
});
