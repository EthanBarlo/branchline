import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { GitWorkflowProgress, GitWorkflowSnapshot } from '../../../shared/git-workflow';
import { errorMessage } from '../../lib/errorMessage';
import { mergeGitSnapshot } from './snapshotState';

const fetchInterval = 5 * 60 * 1000;

export interface GitReloadResult {
  snapshot?: GitWorkflowSnapshot;
  error?: string;
}

export function useGitWorkflow(projectId: string | null, active: boolean, onChanged: () => void) {
  const [snapshot, setSnapshot] = useState<GitWorkflowSnapshot>();
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<GitWorkflowProgress>();
  const [error, setError] = useState<string>();
  const currentProject = useRef(projectId);
  const changed = useRef(onChanged);
  const enabled = useRef(active);
  const inFlight = useRef(new Map<string, Promise<GitReloadResult>>());
  const queuedFetch = useRef(new Map<string, Promise<GitReloadResult>>());
  const fetchingProjects = useRef(new Set<string>());
  const lastAttempt = useRef(0);
  const latestVersion = useRef(new Map<string, number>());
  const applySnapshot = useCallback((result: GitWorkflowSnapshot) => {
    if (currentProject.current !== result.projectId) return;
    const version = result.version ?? 0;
    if ((latestVersion.current.get(result.projectId) ?? -1) > version) return;
    latestVersion.current.set(result.projectId, version);
    setSnapshot((previous) => mergeGitSnapshot(previous, result));
  }, []);
  currentProject.current = projectId;
  changed.current = onChanged;
  enabled.current = active;

  const reload = useCallback(
    async (fetch = false): Promise<GitReloadResult> => {
      if (!projectId) return {};
      const existing = inFlight.current.get(projectId);
      if (existing) {
        if (!fetch || fetchingProjects.current.has(projectId)) {
          return existing;
        }
        const queued = queuedFetch.current.get(projectId);
        if (queued) return queued;
        const request = existing.then(() => reload(true));
        queuedFetch.current.set(projectId, request);
        void request.finally(() => queuedFetch.current.delete(projectId));
        return request;
      }
      if (fetch) {
        fetchingProjects.current.add(projectId);
        if (currentProject.current === projectId) lastAttempt.current = Date.now();
      }
      const request = (async () => {
        try {
          const result = await (fetch
            ? window.reviewAPI.fetchGit(projectId)
            : window.reviewAPI.getGitStatus(projectId));
          if (currentProject.current === projectId) {
            applySnapshot(result);
            setError(undefined);
          }
          return { snapshot: result };
        } catch (reason) {
          if (currentProject.current === projectId) {
            setError(errorMessage(reason));
            setSnapshot((previous) => previous && { ...previous, loading: false, cached: true });
          }
          return { error: errorMessage(reason) };
        } finally {
          inFlight.current.delete(projectId);
          fetchingProjects.current.delete(projectId);
        }
      })();
      inFlight.current.set(projectId, request);
      return request;
    },
    [projectId, applySnapshot],
  );

  useEffect(() => {
    setSnapshot(undefined);
    setBusy(false);
    setFetching(false);
    setProgress(undefined);
    setError(undefined);
    lastAttempt.current = 0;
    if (projectId) latestVersion.current.delete(projectId);
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
        // Background work in another project does not lock this workspace.
        if (change.projectId === currentProject.current) {
          setBusy(change.busy);
          setFetching(change.busy && change.activity === 'fetch');
          setProgress(change.busy ? change.progress : undefined);
        }
        if (change.projectId === currentProject.current && !change.busy) {
          if (change.operation)
            setSnapshot((previous) => previous && { ...previous, operation: change.operation });
          if (change.activity !== 'preview') changed.current();
          // A fetch already returns its final snapshot. Avoid starting another scan
          // from its completion event while that request is still in flight.
          if (enabled.current && !inFlight.current.has(change.projectId)) void reload();
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
    fetching,
    progress,
    error,
    reload,
  };
}

export type GitWorkflow = ReturnType<typeof useGitWorkflow>;
