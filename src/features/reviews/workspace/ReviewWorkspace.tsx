import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/errorMessage';
import { JiraIssuePanel } from '../../integrations/JiraIssuePanel';
import { MergeCompletion } from '../../integrations/MergeCompletion';
import { RemoteReviewControls } from '../../integrations/remote-review/RemoteReviewControls';
import { OpeningWorkspace } from '../../workspace/OpeningWorkspace';
import { Welcome } from '../../workspace/Welcome';
import { WorkspaceMenu } from '../../workspace/WorkspaceMenu';
import { ClosedReviewNotice } from '../ClosedReviewNotice';
import { CopyFeedbackButton } from '../CopyFeedbackButton';
import { CurrentSetup } from '../CurrentSetup';
import { flushPendingComments } from '../diff/commentAutosave';
import { ErrorBanner } from '../ErrorBanner';
import { PointerChanges } from '../PointerChanges';
import { ReanchorBanner } from '../ReanchorBanner';
import { RepositoryDetailsDialog } from '../RepositoryDetailsDialog';
import { RepositoryWarnings } from '../RepositoryWarnings';
import { ReviewToolbar } from '../ReviewToolbar';
import { useReviewViewPreferences } from '../session/useReviewViewPreferences';

import { useWorkspace } from '../../workspace/WorkspaceProvider';
import { useReviewActions } from '../session/useReviewActions';
import { useReviewData } from '../session/useReviewData';
import { useReviewRetirement } from '../session/useReviewRetirement';
import { useReviewView } from '../session/useReviewView';
import { ReviewDialogs } from './ReviewDialogs';
import { ReviewWorkbench } from './ReviewWorkbench';
import { useReviewDialogs } from './useReviewDialogs';
import { GitWorkspace } from '../../git/GitWorkspace';
import { ProjectAreaNavigation } from '../../workspace/ProjectAreaNavigation';
import { useGitWorkflow } from '../../git/useGitWorkflow';

export function ReviewWorkspace() {
  const workspace = useWorkspace();
  const {
    setProjects,
    reviews,
    setReviews,
    settings,
    setSettings,
    integrationRevision,
    initializing,
    error,
    setError,
    setShowAddProject,
    resolvedTheme,
    lifecycle,
    navigation,
  } = workspace;
  const { selectedProjectId, selectedReviewId, showSettings, showGit } = navigation;
  const { updateBusyRef } = lifecycle;
  const preferences = useReviewViewPreferences();
  const { showFiles, toggleFiles } = preferences;
  const [showFeedback, setShowFeedback] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [showRepoDetails, setShowRepoDetails] = useState(false);
  const gitChanged = useRef<() => void>(() => {});
  const git = useGitWorkflow(
    selectedProjectId,
    !showSettings &&
      !initializing &&
      !updateBusyRef.current &&
      (showGit || !reviews.find((item) => item.id === selectedReviewId)?.remote),
    () => gitChanged.current(),
  );
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
    paused: showSettings || showGit || initializing || git.busy || reviewDialogOpen,
    updateBusyRef,
    onContextChange: resetView,
    onTargetChanged: (projectId, baseBranch) => {
      setProjects((previous) =>
        previous.map((project) =>
          project.id === projectId ? { ...project, defaultBaseBranch: baseBranch } : project,
        ),
      );
    },
    setError,
  });
  const { isReviewRemoved, refreshing, refresh, updateRemoteState } = data;
  gitChanged.current = () => {
    if (reviewDialogOpen) return;
    for (const item of reviews)
      if (!item.remote && item.projectId === selectedProjectId) void refresh(item.id, true);
  };
  const sessionInitialized = useRef(false);
  useEffect(() => {
    if (initializing || sessionInitialized.current) return;
    sessionInitialized.current = true;
    data.initializeReviews(reviews);
  }, [initializing, reviews, data.initializeReviews]);
  useEffect(() => {
    resetView();
    setError(null);
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
    if (!id || !selectedProjectId || isReviewRemoved(id)) return;
    void navigation.retireReview(id);
  }
  async function selectReview(id: string | null) {
    if (!id || !selectedProjectId || isReviewRemoved(id)) return;
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
  const dialogs = useReviewDialogs({ workspace, data, selectReview });
  const modalOpen = !!(dialogs.settingsProject || dialogs.deleteProject || dialogs.deleteReview);
  useEffect(() => setReviewDialogOpen(modalOpen), [modalOpen]);
  const {
    setShowNewReview,
    setInitialFeatureBranch,
    setShowPullRequests,
    setCleanupProject,
    setSettingsProject,
    setIntegrationProject,
    setShowHelp,
    setDeleteReview,
  } = dialogs;
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
          {project && (
            <ProjectAreaNavigation
              area={showGit ? 'git' : 'reviews'}
              onGit={() => void navigation.openGit()}
              onReviews={() => void navigation.openReviews()}
            />
          )}
          {showGit && project && (
            <GitWorkspace
              key={project.id}
              project={project}
              workflow={git}
              onReview={(branch) => {
                setInitialFeatureBranch(branch);
                setShowNewReview(true);
              }}
            />
          )}
          <div hidden={showGit} {...stylex.props(styles.reviewArea, showGit && styles.hidden)}>
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
                  onNewReview={() => {
                    setInitialFeatureBranch('');
                    setShowNewReview(true);
                  }}
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
                          updateRemoteState(review.id, state);
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
                    reviewedVersions={data.getReviewedVersions(view.viewKey)}
                    onOrderChange={(ids) => data.recordExplorerOrder(view.viewKey, ids)}
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
          </div>
        </main>
      </div>
      <ReviewDialogs
        workspace={workspace}
        dialogs={dialogs}
        project={project}
        onClosedReviewsRemoved={closedReviewsRemoved}
      />
    </>
  );
}

const styles = stylex.create({
  body: {
    display: 'flex',
    flex: '1',
    minHeight: '0',
  },
  hidden: { display: 'none' },
  reviewArea: {
    display: 'flex',
    flex: '1',
    minHeight: 0,
    flexDirection: 'column',
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
