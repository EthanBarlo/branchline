import * as stylex from '@stylexjs/stylex';
import { useRef } from 'react';
import { Navigate, Outlet, useBlocker } from '@tanstack/react-router';
import { flushPendingComments } from '../reviews/commentAutosave';
import { ErrorBanner } from '../reviews/ErrorBanner';
import { UpdateDetails } from '../settings/UpdateControls';
import { Dialog } from '../../ui/Dialog';
import { errorMessage } from '../../ui/errorMessage';
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
    initializing,
    error,
    setError,
    setShowAddProject,
    navigation,
    lifecycle,
    closingReviewId,
    closingReviewRef,
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
