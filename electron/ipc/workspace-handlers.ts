import { clipboard, dialog, nativeTheme } from 'electron';
import { inspectRepo } from '../git/repository';
import type { ReviewStore } from '../reviews/review-store';
import type { ProjectService } from '../projects/project-service';
import type { IntegrationService } from '../integrations/integration-service';
import type { ReviewWindow } from '../application/review-window';
import type { ReviewHandlerRegistrar } from './register-review-handlers';

interface WorkspaceHandlers {
  store: ReviewStore;
  projects: ProjectService;
  integrations: IntegrationService;
  window: ReviewWindow;
}

export function registerWorkspaceHandlers(
  handle: ReviewHandlerRegistrar,
  { store, projects, integrations, window }: WorkspaceHandlers,
): void {
  handle('state', () => store.getState());
  handle('settings-update', async (changes) => {
    const settings = await store.updateSettings(changes);
    nativeTheme.themeSource = settings.theme;
    window.updateTheme();
    return settings;
  });
  handle('choose-repo', async () => {
    const result = await dialog.showOpenDialog(window.current!, {
      title: 'Choose a repository',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('inspect', (path) => {
    if (typeof path !== 'string' || !path || path.includes('\0'))
      throw new Error('Choose a valid repository path.');
    return inspectRepo(path);
  });
  handle('project-create', (input) => projects.createProject(input));
  handle('project-update', (id, changes) => store.updateProject(id, changes));
  handle('project-delete', (id) => integrations.deleteProject(id));
  handle('create', (input) => projects.createReview(input));
  handle('delete', (id) => integrations.deleteReview(id));
  handle('refresh', (id) => integrations.refreshReview(id));
  handle('current-target', (projectId, target) => integrations.setCurrentTarget(projectId, target));
  handle('approve', (id, fileId, fingerprint, approved, contextKey) =>
    integrations.setApprovals(id, [{ fileId, fingerprint }], approved, contextKey),
  );
  handle('approve-many', (id, files, approved, contextKey) =>
    integrations.setApprovals(id, files, approved, contextKey),
  );
  handle('comment-add', (id, input, contextKey) => integrations.addComment(id, input, contextKey));
  handle('comment-update', (id, commentId, changes, contextKey) =>
    integrations.updateComment(id, commentId, changes, contextKey),
  );
  handle('comment-delete', (id, commentId, contextKey) =>
    integrations.deleteComment(id, commentId, contextKey),
  );
  handle('copy', async (id, contextKey) => {
    const output = await integrations.copyFeedback(id, contextKey);
    clipboard.writeText(output);
    return output;
  });
}
