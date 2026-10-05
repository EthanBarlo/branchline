import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { GitWorkflowSnapshot } from '../../../shared/git-workflow';
import { errorMessage } from '../../lib/errorMessage';

const fetchInterval = 5 * 60 * 1000;

export function useGitWorkflow(projectId: string | null, active: boolean, onChanged: () => void) {
  const [snapshot, setSnapshot] = useState<GitWorkflowSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const currentProject = useRef(projectId);
  const changed = useRef(onChanged);
  const enabled = useRef(active);
  const inFlight = useRef(new Map<string, Promise<void>>());
  const queuedFetch = useRef(new Map<string, Promise<void>>());
  const queuedRead = useRef(new Set<string>());
  const lastAttempt = useRef(0);
  const applySnapshot = useCallback((result: GitWorkflowSnapshot) => {
    if (currentProject.current !== result.projectId) return;
    setSnapshot((previous) =>
      previous?.projectId === result.projectId && (previous.version ?? -1) > (result.version ?? 0)
        ? previous
        : result,
    );
  }, []);
  currentProject.current = projectId;
  changed.current = onChanged;
  enabled.current = active;

  const reload = useCallback(
    async (fetch = false): Promise<void> => {
      if (!projectId) return;
      const existing = inFlight.current.get(projectId);
      if (existing) {
        if (!fetch) {
          queuedRead.current.add(projectId);
          return existing;
        }
        const queued = queuedFetch.current.get(projectId);
        if (queued) return queued;
        const request = existing.then(() => reload(true));
        queuedFetch.current.set(projectId, request);
        void request.finally(() => queuedFetch.current.delete(projectId));
        return request;
      }
      if (fetch) lastAttempt.current = Date.now();
      const request = (async () => {
        try {
          const result = await (fetch
            ? window.reviewAPI.fetchGit(projectId)
            : window.reviewAPI.getGitStatus(projectId));
          if (currentProject.current === projectId) {
            applySnapshot(result);
            setError(undefined);
          }
        } catch (reason) {
          if (currentProject.current === projectId) {
            setError(errorMessage(reason));
            setSnapshot((previous) => previous && { ...previous, loading: false, cached: true });
          }
        } finally {
          inFlight.current.delete(projectId);
          if (
            queuedRead.current.delete(projectId) &&
            !queuedFetch.current.has(projectId) &&
            currentProject.current === projectId &&
            enabled.current
          )
            void reload();
        }
      })();
      inFlight.current.set(projectId, request);
      return request;
    },
    [projectId, applySnapshot],
  );

  useEffect(() => {
    setSnapshot(undefined);
    setError(undefined);
    lastAttempt.current = 0;
    if (projectId)
      void window.reviewAPI
        .getCachedGitStatus(projectId)
        .then((result) => {
          if (result) applySnapshot(result);
        })
        .catch(() => {});
  }, [projectId, applySnapshot]);

  useEffect(
    () =>
      window.reviewAPI.onGitWorkflowChanged((change) => {
        if (change.snapshot) {
          applySnapshot(change.snapshot);
          return;
        }
        // All local scans share the desktop Git queue, including overlapping projects.
        setBusy(change.busy);
        if (change.projectId === currentProject.current && !change.busy) {
          if (change.operation)
            setSnapshot((previous) => previous && { ...previous, operation: change.operation });
          changed.current();
          if (enabled.current) void reload();
        } else if (change.projectId === currentProject.current && change.operation) {
          setSnapshot((previous) => previous && { ...previous, operation: change.operation });
        }
      }),
    [reload, applySnapshot],
  );

  useEffect(() => {
    if (!projectId || !active) return;
    const check = () => {
      if (!document.hidden) void reload(Date.now() - lastAttempt.current >= fetchInterval);
    };
    check();
    const local = setInterval(() => {
      if (!document.hidden) void reload();
    }, 4000);
    const remote = setInterval(check, fetchInterval);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(local);
      clearInterval(remote);
      window.removeEventListener('focus', check);
    };
  }, [active, projectId, reload]);

  const updateSnapshot = useCallback(
    (update: SetStateAction<GitWorkflowSnapshot | undefined>) => {
      // A user can switch projects while an action finishes. Its results stay with its project.
      if (currentProject.current !== projectId) return;
      if (typeof update === 'function' || !update) setSnapshot(update);
      else applySnapshot(update);
    },
    [projectId, applySnapshot],
  );
  return {
    snapshot: snapshot?.projectId === projectId ? snapshot : undefined,
    setSnapshot: updateSnapshot,
    busy,
    error,
    reload,
  };
}

export type GitWorkflow = ReturnType<typeof useGitWorkflow>;
