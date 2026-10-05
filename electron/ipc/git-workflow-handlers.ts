import type { GitWorkflowService } from '../git/workflow-service';
import type { JiraBrowser } from '../integrations/jira/jira-browser';
import type { ReviewWindow } from '../application/review-window';
import type { ReviewHandlerRegistrar } from './register-review-handlers';

export function registerGitWorkflowHandlers(
  handle: ReviewHandlerRegistrar,
  workflow: GitWorkflowService,
  jira: JiraBrowser,
  window: ReviewWindow,
): void {
  handle('git-cache', (id) => workflow.getCachedStatus(id));
  handle('git-history', (id, input) => workflow.getHistory(id, input));
  handle('git-project-history', (id, input) => workflow.getProjectHistory(id, input));
  handle('git-status', (id) => workflow.getStatus(id));
  handle('git-fetch', (id) => workflow.fetch(id));
  handle('git-preview', (id, input) => workflow.preview(id, input));
  handle('git-acknowledge', (id) => workflow.acknowledge(id));
  handle('git-run', (id, previewId) =>
    window.jiraChanges.run(async () => {
      if (workflow.needsJiraClose(id, previewId) && !(await jira.prepareClose()))
        throw new Error('Save your Jira edits before changing the checkout.');
      return workflow.run(id, previewId);
    }),
  );
}
