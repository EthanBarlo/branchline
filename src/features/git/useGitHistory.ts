import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitProjectHistory, GitWorkflowSnapshot } from '../../../shared/git-workflow';
import { errorMessage } from '../../lib/errorMessage';
import type { GitSidebarBranch } from './branchTree';

export function useGitHistory(
  projectId: string,
  branch: GitSidebarBranch | undefined,
  snapshot?: GitWorkflowSnapshot,
) {
  const [projectHistory, setProjectHistory] = useState<GitProjectHistory>();
  const [limit, setLimit] = useState(250);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [loadedScope, setLoadedScope] = useState<string>();
  const [loadedLimit, setLoadedLimit] = useState(0);
  const pendingLimit = useRef(0);
  const scope = JSON.stringify([projectId, branch?.key]);
  const ready = !!snapshot?.repositories.length;
  const version = snapshot?.version;

  useEffect(() => {
    setLimit(250);
    setProjectHistory(undefined);
    setLoadedScope(undefined);
    setLoadedLimit(0);
    pendingLimit.current = 0;
  }, [scope]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setReload((value) => value + 1);
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    // Coalesce the partial snapshots published during multi-repository discovery.
    const timer = setTimeout(() => {
      const input = {
        limit,
        ...(branch ? { branch: { name: branch.name, remote: branch.remote } } : {}),
      };
      void window.reviewAPI
        .getGitProjectHistory(projectId, input)
        .then((result) => {
          if (cancelled) return;
          setProjectHistory((previous) =>
            JSON.stringify(previous) === JSON.stringify(result) ? previous : result,
          );
          setLoadedScope(scope);
          setLoadedLimit(limit);
          pendingLimit.current = 0;
          setLoading(false);
        })
        .catch((reason) => {
          if (!cancelled) {
            pendingLimit.current = 0;
            setError(errorMessage(reason));
            setLoading(false);
          }
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scope, projectId, branch?.name, branch?.remote, limit, ready, version, reload]);

  const loadOlder = useCallback(() => {
    if (
      !ready ||
      loadedScope !== scope ||
      loading ||
      error ||
      !projectHistory?.hasMore ||
      loadedLimit !== limit ||
      pendingLimit.current
    )
      return;
    pendingLimit.current = limit + 250;
    setLimit(pendingLimit.current);
  }, [ready, loadedScope, scope, loading, error, projectHistory?.hasMore, loadedLimit, limit]);

  return {
    projectHistory: loadedScope === scope ? projectHistory : undefined,
    limit,
    loading,
    error,
    scope,
    loadedScope,
    ready,
    loadOlder,
    retry: () => setReload((value) => value + 1),
  };
}
