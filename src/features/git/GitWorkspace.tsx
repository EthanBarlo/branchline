import * as stylex from '@stylexjs/stylex';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GitAction, GitActionInput, GitActionPreview } from '../../../shared/git-workflow';
import type { Project } from '../../../shared/types';
import { errorMessage } from '../../lib/errorMessage';
import { colors, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { FormError } from '../../ui/Field';
import { flushPendingComments } from '../reviews/diff/commentAutosave';
import type { GitBranchMenuAction } from './GitBranchMenu';
import { GitBranchNameDialog } from './GitBranchNameDialog';
import { GitActionConfirmation } from './GitActionConfirmation';
import { GitBranchSidebar } from './GitBranchSidebar';
import { branchKey, sidebarBranches, type GitSidebarBranch } from './branchTree';
import { useGitBranchFavourites } from './useGitBranchFavourites';
import type { GitWorkflow } from './useGitWorkflow';
import { GitCommitGraph } from './GitCommitGraph';

export function GitWorkspace({
  project,
  workflow,
  onReview,
}: {
  project: Project;
  workflow: GitWorkflow;
  onReview: (branch: string) => void;
}) {
  const { snapshot, busy, fetching, error, reload, setSnapshot } = workflow;
  const { favourites, toggleFavourite } = useGitBranchFavourites(project.id);
  const selectionVersion = useRef(0);
  const preparationVersion = useRef(0);
  const [selectedName, setSelectedName] = useState(
    () => sessionStorage.getItem(`branchline.git.branch.${project.id}`) || '',
  );
  const [publishRemotes, setPublishRemotes] = useState<Record<string, string>>({});
  const [nameAction, setNameAction] = useState<{
    branch: GitSidebarBranch;
    action: 'create' | 'rename';
  }>();
  const [deletion, setDeletion] = useState<{
    branch: GitSidebarBranch;
    force: boolean;
    deleteRemote: boolean;
    remotes: Record<string, string>;
  }>();
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<GitActionPreview>();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const branches = useMemo(() => sidebarBranches(snapshot?.branches ?? []), [snapshot?.branches]);
  const repositories = snapshot?.repositories ?? [];
  const selectedBranch =
    branches.find((branch) => branch.key === selectedName) ??
    branches.find((branch) => branch.name === selectedName && !branch.remote) ??
    branches.find(
      (branch) => !branch.remote && branch.repositories.some((repo) => repo.path === '.' && repo.current),
    ) ??
    branches[0];
  function reviewRefFor(branch = selectedBranch) {
    const root = branch?.repositories.find((repo) => repo.path === '.');
    if (!root || !branch) return undefined;
    if (branch.remote) return `${branch.remote}/${branch.name}`;
    if (root.local) return branch.name;
    return root.remotes[0] ? `${root.remotes[0]}/${branch.name}` : undefined;
  }
  const disabled = busy || pending;
  const repositoryCount = new Set([
    ...repositories.map((repo) => repo.path),
    ...(snapshot?.pendingRepositories ?? []),
  ]).size;
  const publicationChoices = Object.fromEntries(
    repositories.map((repo) => [
      repo.path,
      publishRemotes[repo.path] || (repo.remotes.length === 1 ? repo.remotes[0] : ''),
    ]),
  );
  async function prepare(
    action: GitAction,
    branch = selectedBranch,
    remoteChoices = publicationChoices,
    deletionOptions: Pick<GitActionInput, 'force' | 'deleteRemote' | 'deleteRemotes'> = {},
  ) {
    const version = selectionVersion.current;
    const request = ++preparationVersion.current;
    setPending(true);
    setChecking(true);
    setActionError(undefined);
    try {
      const prepared = await window.reviewAPI.previewGitAction(project.id, {
        action,
        branch: branch
          ? {
              name: branch.name,
              kind: branch.remote ? 'remote' : 'local',
              ...(branch.remote ? { remote: branch.remote } : {}),
            }
          : undefined,
        publishRemotes: remoteChoices,
        ...(action === 'delete' ? deletionOptions : {}),
      });
      if (version === selectionVersion.current && request === preparationVersion.current)
        setPreview(prepared);
    } catch (reason) {
      if (request === preparationVersion.current) setActionError(errorMessage(reason));
    } finally {
      if (request === preparationVersion.current) {
        setPending(false);
        setChecking(false);
      }
    }
  }
  function cancelPreview() {
    preparationVersion.current++;
    setChecking(false);
    setPending(false);
    setPreview(undefined);
    setDeletion(undefined);
  }
  function recheckDeletion(changes: Partial<NonNullable<typeof deletion>>) {
    if (!deletion || !preview) return;
    const next = { ...deletion, ...changes };
    setDeletion(next);
    setPreview({ ...preview, ready: false });
    void prepare('delete', next.branch, publicationChoices, {
      force: next.force,
      deleteRemote: next.deleteRemote,
      deleteRemotes: next.remotes,
    });
  }
  function branchAction(name: string, action: GitBranchMenuAction) {
    if (action === 'favourite') {
      toggleFavourite(name);
      return;
    }
    if (disabled) return;
    const branch = branches.find((item) => item.key === name);
    if (!branch) return;
    if (action === 'create' || action === 'rename') {
      setActionError(undefined);
      setNameAction({ branch, action });
    } else if (action === 'review') {
      const ref = reviewRefFor(branch);
      if (ref) onReview(ref);
    } else if (action === 'fetch') {
      setPending(true);
      void reload(true).finally(() => setPending(false));
    } else {
      if (
        (action === 'pull' || action === 'push') &&
        (branch.repositories.length !== repositories.length ||
          !branch.repositories.every((repo) => repo.current))
      )
        return;
      if (action === 'delete') {
        setDeletion({ branch, force: false, deleteRemote: false, remotes: {} });
        setPreview({ id: '', projectId: project.id, action: 'delete', rows: [], ready: false });
      }
      void prepare(action, branch);
    }
  }
  async function execute() {
    if (!preview) return;
    const version = selectionVersion.current;
    setPending(true);
    setActionError(undefined);
    try {
      await flushPendingComments();
      const operation = await window.reviewAPI.runGitAction(project.id, preview.id);
      setSnapshot((previous) => previous && { ...previous, operation });
      setPreview(undefined);
      if (operation.state === 'completed') {
        const titles: Record<GitAction, string> = {
          create: 'Branch created',
          rename: 'Branch renamed',
          delete: 'Branch deleted',
          checkout: 'Branch checked out',
          pull: 'Pull completed',
          push: 'Push completed',
        };
        const count = operation.rows.filter((row) => !row.noop).length;
        toast.success(titles[operation.action], {
          id: operation.id,
          description: `${project.name} · ${count} ${count === 1 ? 'repository' : 'repositories'}`,
        });
      }
      if (
        operation.state === 'completed' &&
        (operation.action === 'create' || operation.action === 'rename') &&
        version === selectionVersion.current
      ) {
        const name = operation.rows[0]?.destination?.branch;
        if (name) {
          const key = branchKey(name);
          setSelectedName(key);
          sessionStorage.setItem(`branchline.git.branch.${project.id}`, key);
          if (operation.action === 'rename') {
            const previous = branchKey(operation.rows[0].source!.branch);
            if (favourites.has(previous)) {
              toggleFavourite(previous);
              if (!favourites.has(key)) toggleFavourite(key);
            }
          }
        }
      }
      await reload();
    } catch (reason) {
      setActionError(errorMessage(reason));
      setPreview(undefined);
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label={`Git · ${project.name}`} aria-busy={disabled} {...stylex.props(styles.workspace)}>
      <div {...stylex.props(styles.body)}>
        <GitBranchSidebar
          projectId={project.id}
          branches={branches}
          repositoryCount={repositoryCount}
          projectName={project.name}
          busy={disabled}
          favourites={favourites}
          onToggleFavourite={toggleFavourite}
          cached={!!snapshot?.cached}
          refreshing={fetching || !!snapshot?.loading}
          onAction={branchAction}
          selected={selectedBranch?.key}
          loading={!snapshot && !error}
          onSelect={(name) => {
            selectionVersion.current++;
            setSelectedName(name);
            sessionStorage.setItem(`branchline.git.branch.${project.id}`, name);
            setPreview(undefined);
            setActionError(undefined);
          }}
        />
        <div {...stylex.props(styles.main)}>
          {(actionError || error) && <FormError>{actionError || error}</FormError>}
          <GitCommitGraph
            projectId={project.id}
            projectName={project.name}
            snapshot={snapshot}
            branch={selectedBranch}
          />
          {!selectedBranch && (
            <p {...stylex.props(styles.note)}>
              {snapshot ? 'No branches available.' : 'Reading project branches…'}
            </p>
          )}
          {!selectedBranch &&
            repositories.map((repo) => (
              <p key={repo.path} {...stylex.props(styles.warningNote)}>
                {repo.path === '.' ? project.name : repo.path}: {repo.error || 'No branch available'}
              </p>
            ))}
          {snapshot?.operation && snapshot.operation.state !== 'completed' && (
            <section aria-label="Git operation results" aria-live="polite" {...stylex.props(styles.results)}>
              <strong {...stylex.props(styles.repoName)}>
                Last {snapshot.operation.action === 'create' ? 'create branch' : snapshot.operation.action} ·{' '}
                {snapshot.operation.state}
              </strong>
              {snapshot.operation.rows.map((row) => (
                <p key={row.path} {...stylex.props(styles.note)}>
                  {row.path === '.' ? project.name : row.path}: {row.state}
                  {row.message ? ` · ${row.message}` : ''}
                </p>
              ))}
              {snapshot.operation.rows.some((row) => row.state === 'unknown') && (
                <Button
                  disabled={disabled}
                  onClick={() => {
                    setPending(true);
                    void window.reviewAPI
                      .acknowledgeGitOperation(project.id)
                      .then(setSnapshot)
                      .catch((reason) => setActionError(errorMessage(reason)))
                      .finally(() => setPending(false));
                  }}
                >
                  I checked the uncertain results manually
                </Button>
              )}
            </section>
          )}
        </div>
      </div>
      {nameAction && (
        <GitBranchNameDialog
          projectId={project.id}
          branch={nameAction.branch}
          action={nameAction.action}
          initialRemote={nameAction.branch.remote || ''}
          onClose={() => setNameAction(undefined)}
          onPrepared={(prepared) => {
            setNameAction(undefined);
            setPreview(prepared);
          }}
        />
      )}
      {preview && (
        <GitActionConfirmation
          preview={preview}
          projectName={project.name}
          pending={disabled}
          checking={checking}
          error={actionError}
          deletionBranch={preview.action === 'delete' ? deletion?.branch : undefined}
          deleteRemote={deletion?.deleteRemote ?? false}
          deletionRepositories={repositories}
          deletionRemotes={deletion?.remotes ?? {}}
          onDeleteRemote={(deleteRemote) => recheckDeletion({ deleteRemote })}
          onDeletionRemote={(path, remote) =>
            recheckDeletion({ remotes: { ...deletion?.remotes, [path]: remote } })
          }
          publicationRepositories={repositories.filter(
            (repo) => !repo.upstream && !repo.pushTarget && repo.branch && !repo.error,
          )}
          publicationChoices={publicationChoices}
          onPublicationRemote={(path, remote) => {
            const choices = { ...publicationChoices, [path]: remote };
            setPublishRemotes(choices);
            void prepare('push', selectedBranch, choices);
          }}
          forceDelete={deletion?.force ?? false}
          onForceDelete={(force) => recheckDeletion({ force })}
          onCancel={cancelPreview}
          onConfirm={() => void execute()}
        />
      )}
    </section>
  );
}
const styles = stylex.create({
  workspace: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1',
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.canvas,
  },
  body: { display: 'flex', flex: '1', minHeight: 0 },
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  repoName: {
    color: colors.textDefault,
    fontSize: typeScale.compact,
    fontWeight: 550,
    overflowWrap: 'anywhere',
  },
  note: { color: colors.textMuted, fontSize: typeScale.small, lineHeight: 1.7, marginBlock: spacing.sm },
  warningNote: { color: colors.warningStrong, fontSize: typeScale.small, lineHeight: 1.7, marginBlock: 8 },
  results: {
    backgroundColor: colors.panel,
    padding: 12,
    flexShrink: 0,
    maxHeight: 120,
    overflowY: 'auto',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
});
