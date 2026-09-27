import { clipboard, shell } from 'electron';
import { stat } from 'node:fs/promises';
import { connectionScopes } from '../../shared/connection-scopes';
import {
  flushIntegrationDiagnostics,
  getIntegrationDiagnosticsPath,
} from '../integrations/integration-diagnostics';
import type { IntegrationService } from '../integrations/integration-service';
import type { JiraBrowser } from '../integrations/jira/jira-browser';
import type { ReviewWindow } from '../application/review-window';
import type { ReviewHandlerRegistrar } from './register-review-handlers';

export function registerIntegrationHandlers(
  handle: ReviewHandlerRegistrar,
  integrations: IntegrationService,
  jira: JiraBrowser,
  window: ReviewWindow,
): void {
  handle('jira-open', async (id) => {
    const link = await integrations.getJiraTicketLink(id);
    if (!link)
      throw new Error('Choose a Jira ticket and configure its Jira connection or browser link in Settings.');
    return shell.openExternal(link.url);
  });
  handle('integrations-state', () => integrations.getIntegrations());
  handle('integration-diagnostics', async () => {
    await flushIntegrationDiagnostics();
    const path = getIntegrationDiagnosticsPath() ?? '';
    const available =
      !!path &&
      (await stat(path).then(
        (file) => file.isFile(),
        () => false,
      ));
    return { path, available };
  });
  handle('integration-log-open', async () => {
    await flushIntegrationDiagnostics();
    const path = getIntegrationDiagnosticsPath();
    if (
      !path ||
      !(await stat(path).then(
        (file) => file.isFile(),
        () => false,
      ))
    ) {
      throw new Error(
        'The integration log is not available yet. Retry the connection or pull request, then open Diagnostics again.',
      );
    }
    shell.showItemInFolder(path);
  });
  handle('connection-copy-scopes', (kind) => {
    if (kind !== 'jira' && kind !== 'bitbucket')
      throw new Error('Choose Jira or Bitbucket permissions to copy.');
    clipboard.writeText(connectionScopes[kind].map(([scope]) => scope).join('\n'));
  });
  handle('connection-save', (input) =>
    window.jiraChanges.run(async () => {
      if (
        input.id &&
        integrations
          .getIntegrations()
          .connections.some((connection) => connection.id === input.id && connection.kind === 'jira')
      )
        await jira.clearConnection(input.id);
      return integrations.saveConnection(input);
    }),
  );
  handle('connection-test', (id) => integrations.testConnection(id));
  handle('connection-disconnect', (id) =>
    window.jiraChanges.run(async () => {
      if (
        integrations
          .getIntegrations()
          .connections.some((connection) => connection.id === id && connection.kind === 'jira')
      )
        await jira.clearConnection(id);
      return integrations.disconnectConnection(id);
    }),
  );
  handle('jira-browser-open', (id, bounds) =>
    window.jiraChanges.run(async () => {
      const target = await integrations.getJiraBrowserTarget(id);
      const host = window.current;
      if (!host || host.isDestroyed()) throw new Error('The review window has closed.');
      return jira.open(target, host, bounds);
    }),
  );
  handle('jira-browser-resize', (id, bounds) => jira.resizeEmbedded(id, bounds));
  handle('jira-browser-focus', (id) => jira.focusEmbedded(id));
  handle('jira-browser-close', (id) => window.jiraChanges.run(() => jira.closeEmbedded(id)));
  handle('integrations-project', (id, input) => integrations.configureProjectIntegration(id, input));
  handle('integrations-discover', (id) => integrations.discoverRepositories(id));
  handle('pullrequests-list', (id, filter) => integrations.listPullRequests(id, filter));
  handle('pullrequests-open', (id, refs) => integrations.openPullRequestReview(id, refs));
  handle('pullrequests-state', (id) => integrations.getRemoteReview(id));
  handle('jira-issue', (id, key) => integrations.getJiraIssue(id, key));
  handle('jira-ticket-suggestions', (id, query) => integrations.getJiraTicketSuggestions(id, query));
  handle('jira-ticket-link', (id) => integrations.getJiraTicketLink(id));
  handle('jira-ticket', (id, key, expectedBranch) => integrations.setReviewTicket(id, key, expectedBranch));
  handle('feedback-preview', (id) => integrations.previewFeedback(id));
  handle('feedback-publish', (id) => integrations.publishFeedback(id));
  handle('feedback-reanchor', (id, commentId, input) => integrations.reanchorComment(id, commentId, input));
  handle('feedback-conflict', (id, commentId, choice) =>
    integrations.resolveCommentConflict(id, commentId, choice),
  );
  handle('feedback-unknown', (id, commentId, remoteId) =>
    integrations.resolveUnknownPublication(id, commentId, remoteId),
  );
  handle('merge-preview', (id, action) => integrations.previewMerge(id, action));
  handle('pullrequests-action', (id, action) => integrations.runPullRequestAction(id, action));
  handle('pullrequests-complete', (id) => integrations.completeMergedReview(id));
  handle('closed-review-check', (id) => integrations.checkClosedReview(id));
  handle('closed-reviews-remove', (projectId, ids, options) =>
    integrations.removeClosedReviews(projectId, ids, options),
  );
  handle('integration-open', (url) => shell.openExternal(integrations.validateLink(url)));
}
