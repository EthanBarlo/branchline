import { useEffect, useMemo, useState } from 'react';
import { extractJiraTicketKey } from '../../../../shared/jira';
import { errorMessage } from '../../../lib/errorMessage';
import type { useWorkspace } from '../../workspace/WorkspaceProvider';
import { isApproved, nextPendingFile, reviewViewKey } from './reviewSession';
import type { ReviewData } from './useReviewData';
import type { useReviewViewPreferences } from './useReviewViewPreferences';

type ReviewViewOptions = {
  workspace: ReturnType<typeof useWorkspace>;
  data: ReviewData;
  preferences: ReturnType<typeof useReviewViewPreferences>;
};

export function useReviewView({ workspace, data, preferences }: ReviewViewOptions) {
  const { projects, reviews, integrations, integrationRevision, settings, setError } = workspace;
  const { selectedProjectId, selectedReviewId, openSettings } = workspace.navigation;
  const {
    remoteStates,
    reviewMetadata,
    isReviewRemoved,
    snapshots,
    remoteLoads,
    refreshing,
    selectedFiles,
    getReviewedVersions,
    selectFile,
  } = data;
  const { filter } = preferences;
  const [jiraLinks, setJiraLinks] = useState<Record<string, { key: string; url: string } | null>>({});
  const [jiraLinkRevision, setJiraLinkRevision] = useState(0);
  const [openingJira, setOpeningJira] = useState(false);

  const project = projects.find((item) => item.id === selectedProjectId);
  const projectReviews = reviews.filter((item) => item.projectId === selectedProjectId);
  const savedReviews = projectReviews.filter((item) => item.kind !== 'current');
  const review = projectReviews.find((item) => item.id === selectedReviewId);
  const remote = review ? remoteStates[review.id] || null : null;
  const projectIntegration = project ? integrations.projects[project.id] : undefined;
  const viewKey = review ? reviewViewKey(review) : '';
  const isCurrent = review?.kind === 'current';
  const metadata = review ? reviewMetadata[review.id] : undefined;
  const featureBranch =
    isCurrent && metadata?.inspection ? metadata.inspection.currentBranch || '' : review?.featureBranch || '';
  const jiraTicket = extractJiraTicketKey(featureBranch);
  useEffect(() => {
    if (
      !review ||
      (!review.remote && !projectIntegration?.jiraConnectionId) ||
      !window.reviewAPI.getJiraTicketLink
    )
      return;
    let live = true;
    const id = review.id;
    void window.reviewAPI
      .getJiraTicketLink(id)
      .then((link) => {
        if (live && !isReviewRemoved(id)) setJiraLinks((previous) => ({ ...previous, [id]: link }));
      })
      .catch(() => {
        if (live && !isReviewRemoved(id)) setJiraLinks((previous) => ({ ...previous, [id]: null }));
      });
    return () => {
      live = false;
    };
  }, [
    review?.id,
    review?.remote,
    featureBranch,
    projectIntegration?.jiraConnectionId,
    integrationRevision,
    jiraLinkRevision,
    settings.jiraBaseUrl,
  ]);
  const currentDetached = Boolean(isCurrent && metadata?.inspection && !metadata.inspection.currentBranch);
  const currentNeedsTarget = Boolean(isCurrent && (metadata?.requiresTarget || !review.baseBranch));
  const snapshot = review ? snapshots[viewKey] : undefined;
  const remoteLoad = review ? remoteLoads[review.id] : undefined;
  const remoteLoading = Boolean(
    review?.remote && (refreshing || snapshot?.loading || (remoteLoad && !remoteLoad.complete)),
  );
  const loadingRepositories =
    remoteLoad?.repositories ||
    (review?.remote
      ? projectIntegration?.repositories.map((repository) => ({ repository, phase: 'queued' as const }))
      : undefined);
  const files = snapshot?.files || [];
  const incompleteSnapshot = Boolean(
    snapshot?.repos.some((repo) => repo.error) || files.some((file) => file.unavailable),
  );
  const pointerChanges =
    snapshot?.repos.flatMap((repo) =>
      (repo.pointers || []).map((pointer) => ({ ...pointer, repositoryPath: repo.relativePath })),
    ) || [];
  const historicalFiles = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        files.flatMap((file) => {
          const state = remote?.pullRequests.find(
            (pr) => pr.repository.relativePath === file.repoRelativePath,
          )?.state;
          const label =
            state === 'MERGED'
              ? 'Merged'
              : state === 'DECLINED'
                ? 'Declined'
                : state === 'SUPERSEDED'
                  ? 'Closed'
                  : undefined;
          return label ? [[file.id, label]] : [];
        }),
      ),
    [files, remote],
  );
  const pendingReviewFiles = useMemo(
    () => files.filter((file) => !historicalFiles[file.id]),
    [files, historicalFiles],
  );
  const selectedFile = files.find((file) => file.id === selectedFiles[viewKey]);
  const historicalFile = Boolean(selectedFile && historicalFiles[selectedFile.id]);
  const historicalState = selectedFile ? historicalFiles[selectedFile.id]?.toLowerCase() : undefined;
  const fileComments = useMemo(
    () => review?.comments.filter((comment) => comment.fileId === selectedFile?.id) || [],
    [review?.comments, selectedFile?.id],
  );
  const unresolvedComments = review?.comments.filter((comment) => !comment.resolved) || [];
  const approvedCount = review ? pendingReviewFiles.filter((file) => isApproved(review, file)).length : 0;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const approved = Boolean(review && selectedFile && isApproved(review, selectedFile));
  const priorApproval = review && selectedFile ? getReviewedVersions(viewKey)[selectedFile.id] : undefined;
  const staleApproval = Boolean(priorApproval && selectedFile && !approved);

  useEffect(() => {
    if (!review || filter !== 'unreviewed' || !selectedFile || !historicalFiles[selectedFile.id]) return;
    const nextId = nextPendingFile(pendingReviewFiles, review)?.id || '';
    selectFile(review, nextId);
  }, [review, filter, selectedFile, historicalFiles, pendingReviewFiles, viewKey]);

  async function openJira() {
    if (!review || openingJira) return;
    if (!settings.jiraBaseUrl) {
      void openSettings('jira', true);
      return;
    }
    setOpeningJira(true);
    try {
      await window.reviewAPI.openJiraTicket(review.id);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setOpeningJira(false);
    }
  }

  return {
    project,
    projectReviews,
    savedReviews,
    review,
    remote,
    projectIntegration,
    viewKey,
    isCurrent,
    metadata,
    featureBranch,
    jiraTicket,
    currentDetached,
    currentNeedsTarget,
    snapshot,
    remoteLoad,
    remoteLoading,
    loadingRepositories,
    files,
    incompleteSnapshot,
    pointerChanges,
    historicalFiles,
    pendingReviewFiles,
    selectedFile,
    historicalFile,
    historicalState,
    fileComments,
    unresolvedComments,
    approvedCount,
    additions,
    deletions,
    approved,
    priorApproval,
    staleApproval,
    jiraLinks,
    setJiraLinks,
    jiraLinkRevision,
    setJiraLinkRevision,
    openingJira,
    openJira,
  };
}

export type ReviewView = ReturnType<typeof useReviewView>;
