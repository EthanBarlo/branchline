import { useEffect, useState } from 'react';
import type { Project, Review } from '../../../../shared/types';
import { currentReviewId } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../diff/commentAutosave';

import type { useWorkspace } from '../../workspace/WorkspaceProvider';

import type { ReviewData } from '../session/useReviewData';
type ReviewDialogsOptions = {
  workspace: ReturnType<typeof useWorkspace>;
  data: ReviewData;
  selectReview: (id: string | null) => Promise<void>;
};
export function useReviewDialogs({ workspace, data, selectReview }: ReviewDialogsOptions) {
  const { setProjects, setReviews, reviews, setShowAddProject, setError, navigation } = workspace;
  const { selectedProjectId, selectedReviewId, selectProject } = navigation;
  const { registerReview, registerReviews, markReviewsDeleted, getSelection } = data;
  const [showNewReview, setShowNewReview] = useState(false);
  const [initialFeatureBranch, setInitialFeatureBranch] = useState('');
  const [integrationProject, setIntegrationProject] = useState<Project | null>(null);
  const [showPullRequests, setShowPullRequests] = useState(false);
  const [cleanupProject, setCleanupProject] = useState<Project | null>(null);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [deleteReview, setDeleteReview] = useState<Review | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    setShowNewReview(false);
    setShowPullRequests(false);
  }, [selectedProjectId, selectedReviewId]);
  async function projectCreated(created: Project) {
    const state = await window.reviewAPI.getState();
    setProjects(state.projects);
    registerReviews(state.reviews);
    await selectProject(created.id);
    setShowAddProject(false);
  }

  function remoteOpened(created: Review) {
    registerReview(created);
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
      markReviewsDeleted([id]);
      setProjects(state.projects);
      setReviews(state.reviews);
      const selection = getSelection();
      if (selection.reviewId === id) {
        const next = selection.projectId ? currentReviewId(selection.projectId) : null;
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
      await data.waitForRefreshes();
      const state = await window.reviewAPI.deleteProject(id);
      markReviewsDeleted(reviews.filter((item) => item.projectId === id).map((item) => item.id));
      setProjects(state.projects);
      setReviews(state.reviews);
      localStorage.removeItem(`branchline.selectedReview.${id}`);
      if (getSelection().projectId === id) void selectProject(state.projects[0]?.id || null);
      setDeleteProject(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
    }
  }

  function newReviewCreated(created: Review) {
    registerReview(created);
    setProjects((previous) =>
      previous.map((item) =>
        item.id === created.projectId ? { ...item, defaultBaseBranch: created.baseBranch } : item,
      ),
    );
    void selectReview(created.id);
    setShowNewReview(false);
  }

  return {
    showNewReview,
    initialFeatureBranch,
    setInitialFeatureBranch,
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
  };
}

export type ReviewDialogsState = ReturnType<typeof useReviewDialogs>;
