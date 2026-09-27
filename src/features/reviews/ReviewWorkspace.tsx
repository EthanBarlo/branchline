import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import type { Project, Review } from '../../../shared/types';
import { currentReviewId, reviewContextKey } from '../../../shared/types';
import { errorMessage } from '../../ui/errorMessage';
import { ClosedReviewCleanup } from '../integrations/ClosedReviewCleanup';
import {
  JiraIssuePanel,
  ProjectIntegrationDialog,
  PullRequestsDialog,
  RemoteReviewControls,
} from '../integrations/index';
import { MergeCompletion } from '../integrations/MergeCompletion';
import { AddProjectDialog } from '../projects/AddProjectDialog';
import { ProjectSettingsDialog } from '../projects/ProjectSettingsDialog';
import { ClosedReviewNotice } from '../reviews/ClosedReviewNotice';
import { flushPendingComments } from '../reviews/commentAutosave';
import { CopyFeedbackButton } from '../reviews/CopyFeedbackButton';
import { CurrentSetup } from '../reviews/CurrentSetup';
import { ErrorBanner } from '../reviews/ErrorBanner';
import { NewReviewDialog } from '../reviews/NewReviewDialog';
import { PointerChanges } from '../reviews/PointerChanges';
import { ReanchorBanner } from '../reviews/ReanchorBanner';
import { RepositoryDetailsDialog } from '../reviews/RepositoryDetailsDialog';
import { RepositoryWarnings } from '../reviews/RepositoryWarnings';
import { ReviewToolbar } from '../reviews/ReviewToolbar';
import { useReviewViewPreferences } from '../reviews/useReviewViewPreferences';
import { ConfirmDeletionDialog } from '../workspace/ConfirmDeletionDialog';
import { HelpDialog } from '../workspace/HelpDialog';
import { OpeningWorkspace } from '../workspace/OpeningWorkspace';
import { Welcome } from '../workspace/Welcome';
import { WorkspaceMenu } from '../workspace/WorkspaceMenu';

import { useWorkspace } from '../workspace/WorkspaceProvider';
import { mergeReview } from './reviewSession';
import { ReviewWorkbench } from './ReviewWorkbench';
import { useReviewActions } from './useReviewActions';
import { useReviewData } from './useReviewData';
import { useReviewRetirement } from './useReviewRetirement';
import { useReviewView } from './useReviewView';

export function ReviewWorkspace() {
  const workspace = useWorkspace();
  const {
    setProjects,
    reviews,
    setReviews,
    settings,
    setSettings,
    loadIntegrations,
    integrationRevision,
    initializing,
    error,
    setError,
    showAddProject,
    setShowAddProject,
    resolvedTheme,
    lifecycle,
    navigation,
  } = workspace;
  const { selectedProjectId, selectedReviewId, showSettings, openSettings } = navigation;
  const { showUpdates, updateBusyRef } = lifecycle;
  const preferences = useReviewViewPreferences();
  const { showFiles, toggleFiles } = preferences;
  const [showNewReview, setShowNewReview] = useState(false);
  const [integrationProject, setIntegrationProject] = useState<Project | null>(null);
  const [showPullRequests, setShowPullRequests] = useState(false);
  const [cleanupProject, setCleanupProject] = useState<Project | null>(null);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showRepoDetails, setShowRepoDetails] = useState(false);
  const [deleteReview, setDeleteReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState(false);
  const resetActions = useRef<() => void>(() => {});
  const resetView = () => {
    resetActions.current();
    setShowRepoDetails(false);
    setShowFeedback(false);
  };
  const data = useReviewData({
    reviews,
    setReviews,
    selectedReviewId,
    selectedProjectId,
    paused: showSettings || initializing,
    updateBusyRef,
    onContextChange: resetView,
    setError,
  });
  const {
    contexts,
    deletedReviewIds,
    selectedIdRef,
    selectedProjectRef,
    refreshing,
    refresh,
    setRemoteStates,
  } = data;
  const sessionInitialized = useRef(false);
  useEffect(() => {
    if (initializing || sessionInitialized.current) return;
    sessionInitialized.current = true;
    data.initializeReviews(reviews);
  }, [initializing, reviews, data.initializeReviews]);
  useEffect(() => {
    resetView();
    setError(null);
    setShowNewReview(false);
    setShowPullRequests(false);
  }, [selectedProjectId, selectedReviewId]);
  const view = useReviewView({ workspace, data, preferences });
  const {
    project,
    projectReviews,
    savedReviews,
    review,
    remote,
    projectIntegration,
    isCurrent,
    metadata,
    featureBranch,
    jiraTicket,
    currentDetached,
    currentNeedsTarget,
    snapshot,
    remoteLoading,
    loadingRepositories,
    files,
    pointerChanges,
    historicalFiles,
    selectedFile,
    unresolvedComments,
    jiraLinks,
    setJiraLinks,
    setJiraLinkRevision,
    openingJira,
    openJira,
  } = view;
  const actions = useReviewActions({
    data,
    review,
    project,
    files,
    selectedFile,
    historicalFiles,
    setProjects,
    setError,
    viewPreferences: preferences,
  });
  resetActions.current = actions.resetView;
  const {
    changingTarget,
    reanchorId,
    setReanchorId,
    copyState,
    changeCurrentTarget,
    beginReanchor,
    remoteChanged,
    copyFeedback,
  } = actions;

  function activateReview(id: string | null) {
    if (!id || !selectedProjectId || deletedReviewIds.current.has(id)) return;
    void navigation.retireReview(id);
  }
  async function selectReview(id: string | null) {
    if (!id || !selectedProjectId || deletedReviewIds.current.has(id)) return;
    if (id === selectedReviewId) {
      try {
        await flushPendingComments();
        resetView();
        if (review?.remote) await refresh(id, true);
      } catch (reason) {
        setError(errorMessage(reason));
      }
    } else await navigation.navigateReview(selectedProjectId, id);
  }
  const selectProject = navigation.selectProject;
  const {
    closingReviewId,
    closedReviewNotice,
    setClosedReviewNotice,
    mergeCompletion,
    setMergeCompletion,
    mergeFinished,
    closedReviewsRemoved,
  } = useReviewRetirement({
    data,
    closingReviewId: workspace.closingReviewId,
    setClosingReviewId: workspace.setClosingReviewId,
    setProjects,
    setReviews,
    setSettings,
    jiraLinks,
    setJiraLinks,
    activateReview,
  });

  async function projectCreated(created: Project) {
    const state = await window.reviewAPI.getState();
    setProjects(state.projects);
    setReviews(state.reviews);
    for (const item of state.reviews) contexts.current[item.id] = reviewContextKey(item);
    await selectProject(created.id);
    setShowAddProject(false);
  }

  function remoteOpened(created: Review) {
    contexts.current[created.id] = reviewContextKey(created);
    setReviews((previous) => mergeReview(previous, created));
    void selectReview(created.id);
    setShowPullRequests(false);
  }

  async function confirmDelete() {
    if (!deleteReview || removing) return;
    setRemoving(true);
    const id = deleteReview.id;
    try {
      await flushPendingComments();
      const state = await window.reviewAPI.deleteReview(id);
      deletedReviewIds.current.add(id);
      setProjects(state.projects);
      setReviews(state.reviews);
      if (selectedIdRef.current === id) {
        const next = selectedProjectRef.current ? currentReviewId(selectedProjectRef.current) : null;
        selectReview(next);
      }
      setDeleteReview(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
    }
  }

  async function confirmDeleteProject() {
    if (!deleteProject || removing) return;
    setRemoving(true);
    const id = deleteProject.id;
    try {
      await flushPendingComments();
      const state = await window.reviewAPI.deleteProject(id);
      for (const item of reviews) if (item.projectId === id) deletedReviewIds.current.add(item.id);
      setProjects(state.projects);
      setReviews(state.reviews);
      localStorage.removeItem(`branchline.selectedReview.${id}`);
      if (selectedProjectRef.current === id) void selectProject(state.projects[0]?.id || null);
      setDeleteProject(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
    }
  }

  const copyButton = (inToolbar = false) => (
    <CopyFeedbackButton
      state={copyState}
      count={unresolvedComments.length}
      inToolbar={inToolbar}
      onCopy={() => void copyFeedback()}
    />
  );

  return (
    <>
      <div
        className={`application-body ${stylex.props(styles.body).className}`}
        hidden={showSettings}
        inert={!!closingReviewId}
        id="project-workspace"
        role={project ? 'tabpanel' : undefined}
        aria-labelledby={project && !showSettings ? `project-tab-${project.id}` : undefined}
      >
        <main className={`main-workspace ${stylex.props(styles.main).className}`}>
          {closedReviewNotice?.projectId === selectedProjectId &&
            (!closedReviewNotice.reviewId || closedReviewNotice.reviewId === selectedReviewId) && (
              <ClosedReviewNotice
                message={closedReviewNotice.message}
                warning={closedReviewNotice.warning}
                onDismiss={() => setClosedReviewNotice(null)}
              />
            )}
          {error && (
            <ErrorBanner
              message={error}
              retry={review ? () => void refresh(review.id, true) : undefined}
              onDismiss={() => setError(null)}
            />
          )}
          {mergeCompletion?.projectId === selectedProjectId && (
            <MergeCompletion
              reviewId={mergeCompletion.reviewId}
              remote={mergeCompletion.remote}
              jiraLink={mergeCompletion.jiraLink}
              onDismiss={() => setMergeCompletion(null)}
            />
          )}
          {initializing ? (
            <OpeningWorkspace />
          ) : !review ? (
            project ? (
              <OpeningWorkspace projectName={project.name} />
            ) : (
              <Welcome onCreate={() => setShowAddProject(true)} />
            )
          ) : (
            <>
              <ReviewToolbar
                review={review}
                savedReviews={savedReviews}
                isCurrent={isCurrent}
                showFiles={showFiles}
                onToggleFiles={toggleFiles}
                onSelectReview={(id) => void selectReview(id)}
                onNewReview={() => setShowNewReview(true)}
                onBrowsePullRequests={() =>
                  projectIntegration?.bitbucketConnectionId
                    ? setShowPullRequests(true)
                    : project && setIntegrationProject(project)
                }
                inspection={metadata?.inspection}
                changingTarget={changingTarget}
                onChangeTarget={(target) => void changeCurrentTarget(target)}
                featureBranch={featureBranch}
                jiraTicket={jiraTicket}
                jiraBaseUrl={settings.jiraBaseUrl}
                jiraConnected={!!projectIntegration?.jiraConnectionId}
                openingJira={openingJira}
                onOpenJira={() => void openJira()}
                refreshing={refreshing}
                refreshError={!!error}
                snapshot={snapshot}
                onRefresh={() => void refresh(review.id, true)}
                showFeedback={showFeedback}
                feedbackCount={unresolvedComments.length}
                onToggleFeedback={() => setShowFeedback(!showFeedback)}
                remoteControls={
                  review.remote && (
                    <RemoteReviewControls
                      key={`remote:${review.id}`}
                      review={review}
                      remote={remote}
                      loadingRepositories={remoteLoading ? loadingRepositories : undefined}
                      reviewLoading={remoteLoading}
                      onRemote={(state) => {
                        if (!deletedReviewIds.current.has(review.id))
                          setRemoteStates((previous) => ({ ...previous, [review.id]: state }));
                      }}
                      onChanged={remoteChanged}
                      onReanchor={beginReanchor}
                      onMergeComplete={(state) => mergeFinished(review, state)}
                      jiraLink={jiraLinks[review.id] || null}
                    />
                  )
                }
                jiraPanel={
                  projectIntegration?.jiraConnectionId && (
                    <JiraIssuePanel
                      key={`jira:${review.id}`}
                      review={review}
                      ticket={
                        jiraLinks[review.id] === undefined ? jiraTicket : jiraLinks[review.id]?.key || null
                      }
                      currentBranch={isCurrent ? featureBranch || null : undefined}
                      ticketView={settings.jiraTicketView}
                      refreshKey={String(integrationRevision)}
                      onTicketChanged={() => setJiraLinkRevision((value) => value + 1)}
                    />
                  )
                }
                copyButton={!review.remote && copyButton(true)}
                workspaceMenu={
                  <WorkspaceMenu
                    key={`${project?.id}:${review.id}`}
                    onCleanupClosed={
                      projectReviews.some((item) => item.remote)
                        ? () => project && setCleanupProject(project)
                        : undefined
                    }
                    onSettings={() => project && setSettingsProject(project)}
                    onRepositories={() => setShowRepoDetails(!showRepoDetails)}
                    onIntegrations={() => project && setIntegrationProject(project)}
                    onHelp={() => setShowHelp(true)}
                    onDelete={isCurrent ? undefined : () => setDeleteReview(review)}
                  />
                }
              />
              <PointerChanges pointers={pointerChanges} fileCount={files.length} />
              {reanchorId && <ReanchorBanner onCancel={() => setReanchorId(null)} />}
              {showRepoDetails && (
                <RepositoryDetailsDialog
                  snapshot={snapshot}
                  repoPath={review.repoPath}
                  needsTarget={currentNeedsTarget}
                  onClose={() => setShowRepoDetails(false)}
                />
              )}
              <RepositoryWarnings warnings={snapshot?.warnings || []} />
              {isCurrent && (currentNeedsTarget || currentDetached) ? (
                <CurrentSetup detached={currentDetached} onReviewBranch={() => setShowNewReview(true)} />
              ) : (
                <ReviewWorkbench
                  view={view}
                  actions={actions}
                  data={data}
                  preferences={preferences}
                  theme={resolvedTheme}
                  showFeedback={showFeedback}
                  onCloseFeedback={() => setShowFeedback(false)}
                  onError={setError}
                  copyButton={copyButton()}
                />
              )}
            </>
          )}
        </main>
      </div>
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
            onCreated={(created) => {
              contexts.current[created.id] = reviewContextKey(created);
              setReviews((previous) => mergeReview(previous, created));
              setProjects((previous) =>
                previous.map((item) =>
                  item.id === created.projectId ? { ...item, defaultBaseBranch: created.baseBranch } : item,
                ),
              );
              void selectReview(created.id);
              setShowNewReview(false);
            }}
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
    </>
  );
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flex: '1',
    minHeight: '0',
  },
  main: {
    minWidth: '0',
    flex: '1',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  },
});
