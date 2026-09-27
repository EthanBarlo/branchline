import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JiraTicketService } from '../electron/integrations/jira/jira-ticket-service';
import { IntegrationStore } from '../electron/integrations/integration-store';
import type { ConnectionManager } from '../electron/integrations/connection-manager';
import { ReviewStore } from '../electron/reviews/review-store';
import { currentReviewId, type RepoInspection } from '../shared/types';

async function fixture(t: TestContext, inspect: (path: string) => Promise<RepoInspection>) {
  const dir = await mkdtemp(join(tmpdir(), 'branchline-jira-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ReviewStore(join(dir, 'reviews.json'));
  const state = new IntegrationStore(join(dir, 'integrations.json'));
  await state.load();
  const project = await store.createProject({ repoPath: '/offline/repository' });
  const connections = { list: () => [] } as unknown as ConnectionManager;
  const service = new JiraTicketService(store, state, connections, (_id, operation) => operation(), inspect);
  return { store, project, service };
}

test('live Jira links use the fresh Current checkout and saved review branch independently', async t => {
  let branch: string | null = 'feature/app-123-description';
  let inspections = 0;
  const { store, project, service } = await fixture(t, async repoPath => {
    assert.equal(repoPath, '/offline/repository');
    inspections++;
    return { rootPath: repoPath, name: 'Repository', branches: [], currentBranch: branch };
  });
  const current = await store.switchCurrentContext(project.id, 'feature/OLD-1', 'main');
  const saved = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'feature/saved-456-description' });
  await store.updateSettings({ jiraBaseUrl: 'https://jira.example.invalid/team/jira/' });
  assert.equal((await service.getJiraTicketLink(current.id))?.url, 'https://jira.example.invalid/team/jira/browse/APP-123');
  assert.equal(store.getReview(current.id).featureBranch, 'feature/OLD-1', 'link lookup must not mutate review contexts');
  branch = 'feature/NEW-789';
  assert.equal((await service.getJiraTicketLink(current.id))?.url, 'https://jira.example.invalid/team/jira/browse/NEW-789');
  branch = null;
  assert.equal((await service.getJiraTicketLink(saved.id))?.url, 'https://jira.example.invalid/team/jira/browse/SAVED-456');
  assert.equal(inspections, 2, 'saved reviews must not depend on the current checkout');
  assert.equal(await service.getJiraTicketLink(current.id), null);
});

test('missing configuration and missing keys yield no link; unavailable repositories and unknown reviews fail', async t => {
  const { store, project, service } = await fixture(t, async () => { throw new Error('Repository is unavailable.'); });
  const ticketReview = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'APP-123' });
  const noTicket = await store.createReview({ projectId: project.id, baseBranch: 'main', featureBranch: 'feature/ordinary-branch' });
  assert.equal(await service.getJiraTicketLink(ticketReview.id), null);
  await store.updateSettings({ jiraBaseUrl: 'https://jira.example.invalid' });
  assert.equal(await service.getJiraTicketLink(noTicket.id), null);
  await assert.rejects(() => service.getJiraTicketLink(currentReviewId(project.id)), /Repository is unavailable/);
  await assert.rejects(() => service.getJiraTicketLink('https://untrusted.example.invalid'), /review no longer exists/);
});
