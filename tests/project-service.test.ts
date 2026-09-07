import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../electron/project-service';
import { ReviewStore } from '../electron/store';
import type { RepoInspection } from '../shared/types';

test('a project starts without a target and saved reviews explicitly pin a branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-project-service-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    let currentBranch = 'feature/one';
    const inspect = async (): Promise<RepoInspection> => ({
      rootPath: '/canonical/repository', name: 'Repository',
      branches: ['main', 'release', 'feature/one', 'feature/two'], currentBranch,
    });
    const service = new ProjectService(store, inspect);
    const project = await service.createProject({ repoPath: '/a/path/to/repository' });
    assert.equal(project.repoPath, '/canonical/repository');
    assert.equal(project.defaultBaseBranch, null);
    const first = await service.createReview({ projectId: project.id, baseBranch: 'release', featureBranch: 'feature/one' });
    assert.equal(first.featureBranch, 'feature/one');
    assert.equal(first.name, 'feature/one');
    assert.equal(first.includeWorkingTree, false);
    currentBranch = 'feature/two';
    const second = await service.createReview({ projectId: project.id, featureBranch: 'feature/two' });
    assert.equal(second.repoPath, project.repoPath);
    assert.equal(second.baseBranch, 'release');
    assert.equal(second.featureBranch, 'feature/two');
    assert.equal(store.getReview(first.id).featureBranch, 'feature/one', 'Saved reviews must not follow a later checkout.');
    const reopened = new ReviewStore(join(dir, 'reviews.json'));
    await reopened.load();
    assert.equal(reopened.getProject(project.id).defaultBaseBranch, 'release');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved reviews support a detached checkout and failed creation leaves project defaults intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-project-service-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const service = new ProjectService(store, async () => ({
      rootPath: '/repository', name: 'Repository', branches: ['main', 'feature/one'], currentBranch: null,
    }));
    const project = await service.createProject({ repoPath: '/repository' });
    await assert.rejects(() => service.createReview({ projectId: project.id }), /Choose the feature branch/);
    await assert.rejects(() => service.createReview({ projectId: project.id, featureBranch: 'feature/one', baseBranch: 'missing' }), /not available/);
    assert.equal(store.getState().reviews.filter(review => review.kind === 'saved').length, 0);
    assert.equal(store.getProject(project.id).defaultBaseBranch, null);
    const explicit = await service.createReview({ projectId: project.id, featureBranch: 'feature/one', includeWorkingTree: false });
    assert.equal(explicit.featureBranch, 'feature/one');
    assert.equal(explicit.includeWorkingTree, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a branch suffix does not accidentally validate a missing target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-project-service-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const service = new ProjectService(store, async () => ({
      rootPath: '/repository', name: 'Repository', branches: ['feature/main', 'feature/one'], currentBranch: 'feature/one',
    }));
    const project = await service.createProject({ repoPath: '/repository' });
    await assert.rejects(() => service.createReview({ projectId: project.id, featureBranch: 'feature/one', baseBranch: 'main' }), /not available/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
