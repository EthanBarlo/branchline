import * as stylex from '@stylexjs/stylex';
import { useRef } from 'react';
import type { Project } from '../../../shared/types';
import { Navigate, Outlet, useBlocker } from '@tanstack/react-router';
import { flushPendingComments } from '../reviews/diff/commentAutosave';
import { ErrorBanner } from '../reviews/ErrorBanner';
import { UpdateDetails } from '../settings/UpdateControls';
import { Dialog } from '../../ui/Dialog';
import { AppToaster } from '../../ui/AppToaster';
import { errorMessage } from '../../lib/errorMessage';
import { AppChrome } from './AppChrome';
import { WorkspaceLock } from './WorkspaceLock';
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider';

export function AppShell() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}

function Shell() {
  const {
    projects,
    setProjects,
    setDeleteProject,
    initializing,
    error,
    setError,
    setShowAddProject,
    navigation,
    lifecycle,
    closingReviewId,
    closingReviewRef,
    resolvedTheme,
  } = useWorkspace();
  const {
    updateState,
    updatePreparing,
    closePreparing,
    showUpdates,
    setShowUpdates,
    updateBridgeError,
    updateAction,
  } = lifecycle;
  const navigationAttempt = useRef(0);
  const navigationLocked = () =>
    lifecycle.updateBusyRef.current || lifecycle.closeBusyRef.current || !!closingReviewRef.current;
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async () => {
      const attempt = ++navigationAttempt.current;
      if (navigationLocked()) return true;
      try {
        await flushPendingComments();
        return attempt !== navigationAttempt.current || navigationLocked();
      } catch (reason) {
        setError(errorMessage(reason));
        return true;
      }
    },
  });

  async function renameProject(id: string, name: string) {
    const previous = projects.find((project) => project.id === id)?.name;
    const rename = (value: Project | string) =>
      setProjects((list) =>
        list.map((project) =>
          project.id !== id ? project : typeof value === 'string' ? { ...project, name: value } : value,
        ),
      );
    rename(name);
    try {
      rename(await window.reviewAPI.updateProject(id, { name }));
    } catch (reason) {
      if (previous !== undefined) rename(previous);
      setError(errorMessage(reason));
    }
  }

  async function reorderProjects(ids: string[]) {
    const previous = projects.map((project) => project.id);
    const sortBy = (order: string[]) =>
      setProjects((list) => [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
    sortBy(ids);
    try {
      await window.reviewAPI.reorderProjects(ids);
    } catch (reason) {
      sortBy(previous);
      setError(errorMessage(reason));
    }
  }

  return (
    <>
      <div
        className={`app-shell compact-workspace ${stylex.props(styles.shell).className}`}
        inert={updatePreparing || closePreparing || !!closingReviewId}
      >
        <AppChrome
          projects={projects}
          selectedProjectId={navigation.selectedProjectId}
          showSettings={navigation.showSettings}
          initializing={initializing}
          updateState={updateState}
          onSelectProject={(id) => void navigation.selectProject(id)}
          onAddProject={() => setShowAddProject(true)}
          onRenameProject={(id, name) => void renameProject(id, name)}
          onReorderProjects={(ids) => void reorderProjects(ids)}
          onRemoveProject={setDeleteProject}
          onShowUpdates={() => setShowUpdates(true)}
          onOpenSettings={() => void navigation.openSettings()}
        />
        {error && navigation.showSettings && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        <Outlet />
        {showUpdates && (
          <Dialog title="Updates" onClose={() => setShowUpdates(false)} small>
            <UpdateDetails
              state={updateState}
              bridgeError={updateBridgeError}
              onAction={(action) => void updateAction(action)}
              onClose={() => setShowUpdates(false)}
            />
          </Dialog>
        )}
      </div>
      <AppToaster theme={resolvedTheme} />
      <WorkspaceLock
        closingReview={!!closingReviewId}
        updatePreparing={updatePreparing}
        closePreparing={closePreparing}
        phase={updateState?.phase}
      />
    </>
  );
}

export function UnknownRoute() {
  return <Navigate to="/" replace />;
}

const styles = stylex.create({ shell: { height: '100dvh', display: 'flex', flexDirection: 'column' } });
