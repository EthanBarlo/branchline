import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, Project, Review } from '../../../shared/types';
import type { IntegrationState } from '../../../shared/integrations';
import { readBootTheme } from '../../theme/theme';
import { errorMessage } from '../../lib/errorMessage';
import { useAppearance } from './useAppearance';
import { useAppLifecycle } from './useAppLifecycle';
import { useWorkspaceNavigation } from './useWorkspaceNavigation';

function useWorkspaceState() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [settings, setSettings] = useState<AppSettings>({ jiraBaseUrl: '', theme: readBootTheme() });
  const [integrations, setIntegrations] = useState<IntegrationState>({ connections: [], projects: {} });
  const [integrationRevision, setIntegrationRevision] = useState(0);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [closingReviewId, setClosingReview] = useState<string | null>(null);
  const closingReviewRef = useRef<string | null>(null);
  const setClosingReviewId = useCallback((id: string | null) => {
    closingReviewRef.current = id;
    setClosingReview(id);
  }, []);
  const resolvedTheme = useAppearance(settings.theme);
  const lifecycle = useAppLifecycle(setError);
  const navigation = useWorkspaceNavigation(projects, reviews, initializing);
  const mounted = useRef(false);
  const loadIntegrations = useCallback(() => {
    if (!window.reviewAPI?.getIntegrations) return;
    void window.reviewAPI
      .getIntegrations()
      .then((state) => {
        if (!mounted.current) return;
        setIntegrations(state);
        setIntegrationRevision((value) => value + 1);
      })
      .catch((reason) => {
        if (mounted.current) setError(errorMessage(reason));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (!window.reviewAPI) {
      setError('The desktop connection is unavailable. Open Branchline from the desktop application.');
      setInitializing(false);
      return;
    }
    loadIntegrations();
    void window.reviewAPI
      .getState()
      .then((state) => {
        if (!active) return;
        setProjects(state.projects);
        setReviews(state.reviews);
        setSettings(state.settings);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [loadIntegrations]);

  return {
    projects,
    setProjects,
    reviews,
    setReviews,
    settings,
    setSettings,
    integrations,
    loadIntegrations,
    integrationRevision,
    initializing,
    error,
    setError,
    showAddProject,
    setShowAddProject,
    closingReviewId,
    closingReviewRef,
    setClosingReviewId,
    resolvedTheme,
    lifecycle,
    navigation,
  };
}

const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceState> | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceState();
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('WorkspaceProvider is required.');
  return workspace;
}
