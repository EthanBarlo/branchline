import { useEffect, useRef } from 'react';
import { useLocation, useParams, useRouter } from '@tanstack/react-router';
import type { Project, Review } from '../../../shared/types';
import { currentReviewId } from '../../../shared/types';
import type { SettingsSection } from '../settings/settingsSections';

type Selection = { projectId: string; reviewId: string; area?: 'git' };

export function useWorkspaceNavigation(projects: Project[], reviews: Review[], initializing: boolean) {
  const router = useRouter();
  const location = useLocation();
  const params = useParams({ strict: false });
  const showSettings = params.section !== undefined;
  const showGit = location.pathname.endsWith('/git');
  const previousWorkspace = useRef<Selection | null>(null);
  const booted = useRef(false);
  const routeProjectId = params.projectId;
  const routeReviewId = routeProjectId
    ? params.reviewId ||
      (showGit && previousWorkspace.current?.projectId === routeProjectId
        ? previousWorkspace.current.reviewId
        : currentReviewId(routeProjectId))
    : null;
  const active: Selection | null =
    routeProjectId && routeReviewId
      ? { projectId: routeProjectId, reviewId: routeReviewId, area: showGit ? 'git' : undefined }
      : null;
  const requested = showSettings ? location.state.workspace || previousWorkspace.current : active;
  const project =
    projects.find((item) => item.id === requested?.projectId) || (requested ? projects[0] : undefined);
  const selectedProjectId = project?.id || null;
  const selectedReview = reviews.find(
    (item) => item.id === requested?.reviewId && item.projectId === project?.id,
  );
  const selectedReviewId = project ? selectedReview?.id || currentReviewId(project.id) : null;
  const selected: Selection | null =
    project && selectedReviewId
      ? {
          projectId: project.id,
          reviewId: selectedReviewId,
          area: showGit || requested?.area === 'git' ? 'git' : undefined,
        }
      : null;
  if (active && selected) previousWorkspace.current = selected;

  const navigateReview = (projectId: string, reviewId: string, replace = false, ignoreBlocker = false) =>
    reviewId === currentReviewId(projectId)
      ? router.navigate({ to: '/projects/$projectId/current', params: { projectId }, replace, ignoreBlocker })
      : router.navigate({
          to: '/projects/$projectId/reviews/$reviewId',
          params: { projectId, reviewId },
          replace,
          ignoreBlocker,
        });

  useEffect(() => {
    if (initializing) return;
    const saved = projects.find((item) => item.id === localStorage.getItem('branchline.selectedProject'));
    const legacy = reviews.find((item) => item.id === localStorage.getItem('branchline.selectedReview'));
    const fallback = saved || projects.find((item) => item.id === legacy?.projectId) || projects[0];
    if (!booted.current) {
      booted.current = true;
      if (location.pathname === '/' && fallback) {
        void navigateReview(fallback.id, currentReviewId(fallback.id), true, true);
        return;
      }
    }
    if (routeProjectId && routeProjectId !== selectedProjectId) {
      if (fallback) void navigateReview(fallback.id, currentReviewId(fallback.id), true, true);
      else void router.navigate({ to: '/', replace: true, ignoreBlocker: true });
    } else if (project && routeReviewId && routeReviewId !== selectedReviewId) {
      void navigateReview(project.id, currentReviewId(project.id), true, true);
    }
  }, [initializing, projects, reviews, routeProjectId, routeReviewId, location.pathname]);

  useEffect(() => {
    if (selectedProjectId) localStorage.setItem('branchline.selectedProject', selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    const historyKey = (event: KeyboardEvent) => {
      const back = (event.altKey && event.key === 'ArrowLeft') || (event.metaKey && event.key === '[');
      const forward = (event.altKey && event.key === 'ArrowRight') || (event.metaKey && event.key === ']');
      if (!back && !forward) return;
      event.preventDefault();
      event.stopPropagation();
      if (back) router.history.back();
      else router.history.forward();
    };
    window.addEventListener('keydown', historyKey, true);
    return () => window.removeEventListener('keydown', historyKey, true);
  }, [router]);

  return {
    selectedProjectId,
    selectedReviewId,
    showSettings,
    showGit,
    workspaceArea: selected?.area === 'git' ? 'git' : 'reviews',
    openGit: () =>
      selectedProjectId &&
      router.navigate({ to: '/projects/$projectId/git', params: { projectId: selectedProjectId } }),
    openReviews: () =>
      selectedProjectId && selectedReviewId && navigateReview(selectedProjectId, selectedReviewId),
    showLegacyLinks: !!location.state.legacyJiraLinks,
    navigateReview,
    retireReview: (id: string | null) => {
      if (showSettings && params.section) {
        return router.navigate({
          to: '/settings/$section',
          params: { section: params.section },
          replace: true,
          ignoreBlocker: true,
          state: (previous) => ({
            ...previous,
            workspace: selectedProjectId && id ? { projectId: selectedProjectId, reviewId: id } : undefined,
          }),
        });
      }
      return selectedProjectId && id
        ? navigateReview(selectedProjectId, id, true, true)
        : router.navigate({ to: '/', replace: true, ignoreBlocker: true });
    },
    selectProject: (id: string | null) =>
      id
        ? showGit
          ? router.navigate({ to: '/projects/$projectId/git', params: { projectId: id } })
          : navigateReview(id, currentReviewId(id))
        : router.navigate({ to: '/' }),
    openSettings: (section: SettingsSection = 'appearance', legacy = false) =>
      router.navigate({
        to: '/settings/$section',
        params: { section },
        state: { workspace: selected || undefined, legacyJiraLinks: legacy },
      }),
    closeSettings: async () => {
      if (project && requested?.area === 'git')
        await router.navigate({ to: '/projects/$projectId/git', params: { projectId: project.id } });
      else if (project && selectedReviewId) await navigateReview(project.id, selectedReviewId);
      else await router.navigate({ to: '/' });
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.app-settings-button')?.focus());
    },
  };
}
