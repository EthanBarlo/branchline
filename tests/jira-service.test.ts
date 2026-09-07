import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JiraService } from '../electron/jira-service';
import { ReviewStore } from '../electron/store';
import { currentReviewId } from '../shared/types';

test('Jira links use the fresh Current checkout and the saved review branch independently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-jira-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const project = await store.createProject({ repoPath: '/offline/repository' });
    const current = await store.switchCurrentContext(project.id, 'feature/OLD-1', 'main');
    const saved = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'feature/saved-456-description' });
    await store.updateSettings({ jiraBaseUrl: 'https://jira.example.invalid/team/jira/' });
    let branch: string | null = 'feature/app-123-description';
    let inspections = 0;
    const opened: string[] = [];
    const service = new JiraService(store, async url => { opened.push(url); }, async repoPath => {
      assert.equal(repoPath, project.repoPath);
      inspections++;
      return { rootPath: repoPath, name: 'Repository', branches: [], currentBranch: branch };
    });
    await service.openJiraTicket(current.id);
    assert.equal(opened.at(-1), 'https://jira.example.invalid/team/jira/browse/APP-123');
    assert.equal(store.getReview(current.id).featureBranch, 'feature/OLD-1', 'opening a link must not mutate review contexts');
    branch = 'feature/NEW-789';
    await service.openJiraTicket(current.id);
    assert.equal(opened.at(-1), 'https://jira.example.invalid/team/jira/browse/NEW-789');
    branch = null;
    await service.openJiraTicket(saved.id);
    assert.equal(opened.at(-1), 'https://jira.example.invalid/team/jira/browse/SAVED-456');
    assert.equal(inspections, 2, 'saved reviews must not depend on the current checkout');
    await assert.rejects(() => service.openJiraTicket(current.id), /detached/);
    assert.equal(opened.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing Jira configuration, missing keys, unavailable repositories and invalid review IDs never open a URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-jira-'));
  try {
    const store = new ReviewStore(join(dir, 'reviews.json'));
    const project = await store.createProject({ repoPath: '/offline/repository' });
    const ticketReview = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'APP-123' });
    const noTicket = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'feature/ordinary-branch' });
    const opened: string[] = [];
    const service = new JiraService(store, async url => { opened.push(url); }, async () => { throw new Error('Repository is unavailable.'); });
    await assert.rejects(() => service.openJiraTicket(ticketReview.id), /Jira base URL in Settings/);
    await store.updateSettings({ jiraBaseUrl: 'https://jira.example.invalid' });
    await assert.rejects(() => service.openJiraTicket(noTicket.id), /does not contain a Jira ticket key/);
    await assert.rejects(() => service.openJiraTicket(currentReviewId(project.id)), /Repository is unavailable/);
    await assert.rejects(() => service.openJiraTicket('https://untrusted.example.invalid'), /review no longer exists/);
    assert.deepEqual(opened, []);
    const failedBrowser = new JiraService(store, async () => { throw new Error('Browser could not open.'); });
    await assert.rejects(() => failedBrowser.openJiraTicket(ticketReview.id), /Browser could not open/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
