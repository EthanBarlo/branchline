import type { Project } from '../../../../shared/types';
import { ClosedReviewCleanup } from '../../integrations/ClosedReviewCleanup';
import { ProjectIntegrationDialog } from '../../integrations/ProjectIntegrationDialog';
import { PullRequestsDialog } from '../../integrations/PullRequestsDialog';
import { AddProjectDialog } from '../../projects/AddProjectDialog';
import { ProjectSettingsDialog } from '../../projects/ProjectSettingsDialog';
import { ConfirmDeletionDialog } from '../../workspace/ConfirmDeletionDialog';
import { HelpDialog } from '../../workspace/HelpDialog';
import { NewReviewDialog } from '../NewReviewDialog';

import type { useWorkspace } from '../../workspace/WorkspaceProvider';

import type { ClosedReviewCleanupResult } from '../../../../shared/integrations';
import type { ReviewDialogsState } from './useReviewDialogs';
export function ReviewDialogs({
  workspace,
  dialogs,
  project,
  onClosedReviewsRemoved: closedReviewsRemoved,
}: {
  workspace: ReturnType<typeof useWorkspace>;
  dialogs: ReviewDialogsState;
  project?: Project;
  onClosedReviewsRemoved: (result: ClosedReviewCleanupResult) => void;
}) {
  const { showAddProject, setShowAddProject, reviews, loadIntegrations, setProjects, navigation, lifecycle } =
    workspace;
  const { openSettings } = navigation;
  const { showUpdates } = lifecycle;
  const {
    showNewReview,
    initialFeatureBranch,
    setShowNewReview,
    integrationProject,
    setIntegrationProject,
    showPullRequests,
    setShowPullRequests,
    cleanupProject,
    setCleanupProject,
    settingsProject,
    setSettingsProject,
    deleteProject,
    setDeleteProject,
    showHelp,
    setShowHelp,
    deleteReview,
    setDeleteReview,
    removing,
    projectCreated,
    remoteOpened,
    confirmDelete,
    confirmDeleteProject,
    newReviewCreated,
  } = dialogs;
  return (
    <div hidden={showUpdates}>
      {showAddProject && (
        <AddProjectDialog onClose={() => setShowAddProject(false)} onCreated={projectCreated} />
      )}
      {integrationProject && (
        <ProjectIntegrationDialog
          key={integrationProject.id}
          project={integrationProject}
          onClose={() => setIntegrationProject(null)}
          onSaved={loadIntegrations}
          onAccounts={() => {
            setIntegrationProject(null);
            void openSettings('bitbucket');
          }}
        />
      )}
      {cleanupProject && (
        <ClosedReviewCleanup
          key={cleanupProject.id}
          project={cleanupProject}
          reviews={reviews.filter((item) => item.projectId === cleanupProject.id && item.remote)}
          onClose={() => {
            setCleanupProject(null);
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>('[aria-label="Workspace menu"]')?.focus(),
            );
          }}
          onRemoved={closedReviewsRemoved}
        />
      )}
      {showPullRequests && project && (
        <PullRequestsDialog
          key={project.id}
          project={project}
          onClose={() => setShowPullRequests(false)}
          onOpened={remoteOpened}
          onSettings={() => {
            setShowPullRequests(false);
            setIntegrationProject(project);
          }}
        />
      )}
      {showNewReview && project && (
        <NewReviewDialog
          key={project.id}
          project={project}
          onClose={() => setShowNewReview(false)}
          onCreated={newReviewCreated}
          initialFeatureBranch={initialFeatureBranch}
        />
      )}
      {settingsProject && (
        <ProjectSettingsDialog
          project={settingsProject}
          currentTarget={
            reviews.find((item) => item.projectId === settingsProject.id && item.kind === 'current')
              ?.baseBranch || ''
          }
          onClose={() => setSettingsProject(null)}
          onUpdated={(updated) => {
            setProjects((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
            setSettingsProject(null);
          }}
          onRemove={() => {
            setDeleteProject(settingsProject);
            setSettingsProject(null);
          }}
        />
      )}
      {deleteProject && (
        <ConfirmDeletionDialog
          target={{
            project: deleteProject,
            reviewCount: reviews.filter(
              (item) => item.projectId === deleteProject.id && item.kind === 'saved',
            ).length,
          }}
          removing={removing}
          onClose={() => setDeleteProject(null)}
          onConfirm={() => void confirmDeleteProject()}
        />
      )}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {deleteReview && (
        <ConfirmDeletionDialog
          target={{ review: deleteReview }}
          removing={removing}
          onClose={() => setDeleteReview(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
