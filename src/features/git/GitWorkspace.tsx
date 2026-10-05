import * as stylex from '@stylexjs/stylex';
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  GitCompareArrows,
  Pencil,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type {
  GitAction,
  GitActionPreview,
  GitBranchRepository,
  GitRepositoryStatus,
} from '../../../shared/git-workflow';
import type { Project } from '../../../shared/types';
import { errorMessage } from '../../lib/errorMessage';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { FormError } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { flushPendingComments } from '../reviews/diff/commentAutosave';
import type { GitBranchMenuAction } from './GitBranchMenu';
import { GitBranchNameDialog } from './GitBranchNameDialog';
import { GitActionConfirmation } from './GitActionConfirmation';
import { BranchCounts, GitBranchSidebar } from './GitBranchSidebar';
import { branchKey, sidebarBranches, type GitSidebarBranch } from './branchTree';
import { useGitBranchFavourites } from './useGitBranchFavourites';
import type { GitWorkflow } from './useGitWorkflow';

function status(branch?: GitBranchRepository): string {
  if (!branch) return 'Branch missing';
  if (branch.error) return branch.error;
  if (!branch.local) return 'Remote only';
  if (branch.diverged) return 'Diverged · handle manually';
  if (!branch.upstream && !branch.pushTarget) return 'Not published';
  if (branch.incoming) return 'Incoming';
  if (branch.outgoing) return 'Outgoing';
  if (branch.incoming === null || branch.outgoing === null) return 'Destination unavailable';
  return 'Up to date';
}
function checkoutSummary(repositories: GitRepositoryStatus[]): string {
  const names = new Set(repositories.map((repo) => repo.branch));
  if (names.size > 1) return 'Mixed checkouts';
  return repositories[0]?.branch || 'Detached HEAD';
}

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
  const [selectedName, setSelectedName] = useState(
    () => sessionStorage.getItem(`branchline.git.branch.${project.id}`) || '',
  );
  const [checkoutRemote, setCheckoutRemote] = useState('');
  const [publishRemotes, setPublishRemotes] = useState<Record<string, string>>({});
  const [nameAction, setNameAction] = useState<{
    branch: GitSidebarBranch;
    action: 'create' | 'rename';
  }>();
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
    return `${root.remotes.includes(checkoutRemote) ? checkoutRemote : root.remotes[0]}/${branch.name}`;
  }
  const rootBranch = selectedBranch?.repositories.find((repo) => repo.path === '.');
  const reviewRef = reviewRefFor();
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
  const remotes = [...new Set(selectedBranch?.repositories.flatMap((repo) => repo.remotes) ?? [])].sort();
  const partial = selectedBranch && selectedBranch.repositories.length < repositoryCount;
  const checkedOut =
    !!selectedBranch && !partial && selectedBranch.repositories.every((repo) => repo.current);

  async function prepare(action: GitAction, branch = selectedBranch) {
    const version = selectionVersion.current;
    setPending(true);
    setActionError(undefined);
    try {
      const prepared = await window.reviewAPI.previewGitAction(project.id, {
        action,
        branch: branch
          ? {
              name: branch.name,
              kind: branch.remote ? 'remote' : 'local',
              ...(branch.remote || checkoutRemote ? { remote: branch.remote || checkoutRemote } : {}),
            }
          : undefined,
        publishRemotes: publicationChoices,
      });
      if (version === selectionVersion.current) setPreview(prepared);
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setPending(false);
    }
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
        action !== 'checkout' &&
        (branch.repositories.length !== repositories.length ||
          !branch.repositories.every((repo) => repo.current))
      )
        return;
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
          setCheckoutRemote('');
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
    <section aria-label={`Git · ${project.name}`} {...stylex.props(styles.workspace)}>
      <header {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.checkout)}>
          <GitBranch size={14} />
          <strong>{snapshot ? checkoutSummary(repositories) : 'Reading checkout…'}</strong>
          {!!repositories.length && <span {...stylex.props(styles.muted)}>checked out</span>}
        </div>
        <BranchCounts repositories={repositories} />
        <div {...stylex.props(styles.toolbarActions)}>
          <span {...stylex.props(styles.activity)} aria-live="polite">
            {disabled && (
              <>
                <Spinner size={12} />
                <span>{fetching ? 'Fetching…' : 'Working…'}</span>
              </>
            )}
          </span>
          <Button
            disabled={disabled}
            onClick={async () => {
              setPending(true);
              try {
                await reload(true);
              } finally {
                setPending(false);
              }
            }}
          >
            <RefreshCw size={13} /> Fetch
          </Button>
          <Button
            disabled={disabled || !repositories.length}
            onClick={() => void prepare('pull')}
            title="Fast-forward the checked-out branch across every repository"
          >
            <ArrowDown size={13} /> Pull project
          </Button>
          <Button
            disabled={disabled || !repositories.length}
            onClick={() => void prepare('push')}
            title="Push the checked-out branch across every repository"
          >
            <ArrowUp size={13} /> Push project
          </Button>
        </div>
      </header>
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
            setCheckoutRemote('');
            setPreview(undefined);
            setActionError(undefined);
          }}
        />
        <div {...stylex.props(styles.main)}>
          {(actionError || error) && <FormError>{actionError || error}</FormError>}
          {selectedBranch ? (
            <>
              <div {...stylex.props(styles.branchHeader)}>
                <div {...stylex.props(styles.branchHeading)}>
                  <div {...stylex.props(styles.branchLabel)}>
                    <span {...stylex.props(styles.eyebrow)}>
                      {selectedBranch.remote ? 'Remote branch' : 'Local branch'}
                    </span>
                    {checkedOut && (
                      <span {...stylex.props(styles.checkoutBadge)}>
                        <Check size={11} /> Checked out
                      </span>
                    )}
                  </div>
                  <h1
                    title={`${selectedBranch.remote ? `${selectedBranch.remote}/` : ''}${selectedBranch.name}`}
                    {...stylex.props(styles.title)}
                  >
                    <GitBranch size={20} />
                    {selectedBranch.remote ? `${selectedBranch.remote}/` : ''}
                    {selectedBranch.name}
                  </h1>
                  <p {...stylex.props(styles.note)}>
                    {partial
                      ? `${selectedBranch.repositories.length} of ${repositoryCount} repositories`
                      : `All ${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}`}{' '}
                    · <span>{checkedOut ? 'Checked out' : 'Available to inspect'}</span>
                  </p>
                </div>
                <div {...stylex.props(styles.branchActions)}>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      selectedBranch && setNameAction({ branch: selectedBranch, action: 'create' })
                    }
                  >
                    <Plus size={13} /> New branch
                  </Button>
                  {!selectedBranch.remote && (
                    <Button
                      disabled={disabled}
                      onClick={() =>
                        selectedBranch && setNameAction({ branch: selectedBranch, action: 'rename' })
                      }
                    >
                      <Pencil size={13} /> Rename
                    </Button>
                  )}
                  <Button
                    disabled={pending || (busy && !fetching) || !reviewRef}
                    title={
                      !rootBranch
                        ? 'Branch review requires this branch in the root repository'
                        : 'Open a review without changing checkout'
                    }
                    onClick={() => reviewRef && onReview(reviewRef)}
                  >
                    <GitCompareArrows size={13} /> Review
                  </Button>
                  <Button
                    variant="primary"
                    disabled={disabled || checkedOut}
                    onClick={() => void prepare('checkout')}
                  >
                    Check out
                  </Button>
                </div>
              </div>
              {partial && (
                <p {...stylex.props(styles.warningNote)}>
                  This branch is missing from some repositories. Project checkout needs it in every
                  repository.
                </p>
              )}
              {remotes.length > 1 && (
                <div {...stylex.props(styles.remoteChoice)}>
                  <span {...stylex.props(styles.note)}>Tracking source</span>
                  <Select
                    label="Checkout remote"
                    value={checkoutRemote}
                    options={[
                      { value: '', label: 'Resolve per repository' },
                      ...remotes.map((remote) => ({ value: remote, label: remote })),
                    ]}
                    disabled={disabled}
                    onChange={setCheckoutRemote}
                  />
                </div>
              )}
              <div {...stylex.props(styles.sectionHeading)}>
                <strong>Repositories</strong>
                <BranchCounts repositories={selectedBranch.repositories} />
              </div>
              <div
                role="table"
                aria-label="Selected branch repositories"
                {...stylex.props(styles.repositoryList)}
              >
                {repositories.map((repository) => {
                  const branch = selectedBranch.repositories.find((repo) => repo.path === repository.path);
                  const problem = repository.error || (!branch ? 'Branch missing' : branch.error);
                  return (
                    <div key={repository.path} role="row" {...stylex.props(styles.repository)}>
                      <div role="cell" {...stylex.props(styles.repositoryTop)}>
                        <div {...stylex.props(styles.repositoryHeading)}>
                          <strong {...stylex.props(styles.repoName)}>
                            {repository.path === '.' ? project.name : repository.path}
                          </strong>
                          <span {...stylex.props(styles.repoKind)}>
                            {repository.path === '.' ? 'Root repository' : 'Submodule'}
                          </span>
                        </div>
                        <span
                          {...stylex.props(
                            styles.statusBadge,
                            !(problem || branch?.diverged) &&
                              status(branch) === 'Up to date' &&
                              styles.statusClean,
                            !!(problem || branch?.diverged || branch?.incoming) && styles.statusWarning,
                          )}
                        >
                          {problem || status(branch)}
                        </span>
                        <BranchCounts
                          repositories={
                            branch ? [branch] : [{ incoming: null, outgoing: null, diverged: false }]
                          }
                        />
                      </div>
                      <div role="cell" {...stylex.props(styles.details)}>
                        <span {...stylex.props(styles.branchType)}>
                          {branch?.local
                            ? 'Local branch'
                            : branch
                              ? `Remote: ${branch.remotes.join(', ')}`
                              : 'Unavailable'}
                        </span>
                        {branch?.current && <span {...stylex.props(styles.current)}>Checked out</span>}
                        {branch?.upstream && (
                          <span title={branch.upstream.url}>
                            Pull ↓ {branch.upstream.remote}/{branch.upstream.branch}
                          </span>
                        )}
                        {branch?.pushTarget && (
                          <span title={branch.pushTarget.url}>
                            Push ↑ {branch.pushTarget.remote}/{branch.pushTarget.branch}
                          </span>
                        )}
                      </div>
                      <div role="cell" {...stylex.props(styles.details)}>
                        <span>Working checkout: {repository.branch || 'Detached HEAD'}</span>
                        <span>
                          {repository.changes
                            ? `${repository.changes} local change${repository.changes === 1 ? '' : 's'}`
                            : 'Files and index clean'}
                        </span>
                        <span>
                          {repository.lastFetched
                            ? `Fetched ${new Date(repository.lastFetched).toLocaleTimeString()}`
                            : 'Not fetched yet'}
                        </span>
                      </div>
                      {repository.pointerChanges.length > 0 && (
                        <p {...stylex.props(styles.warningNote)}>
                          Pointer differences: {repository.pointerChanges.join(', ')}. Commit pointers
                          manually when needed.
                        </p>
                      )}
                      {repository.fetchError && (
                        <p {...stylex.props(styles.warningNote)}>
                          Remote information is stale. Fetch failed: {repository.fetchError}
                        </p>
                      )}
                      {!repository.upstream &&
                        !repository.pushTarget &&
                        repository.branch &&
                        !repository.error && (
                          <div {...stylex.props(styles.remoteChoice)}>
                            <span {...stylex.props(styles.note)}>Publish {repository.branch} to</span>
                            <Select
                              label={`Publish remote for ${repository.path}`}
                              value={publicationChoices[repository.path]}
                              placeholder="Choose remote"
                              disabled={disabled}
                              options={repository.remotes.map((remote) => ({ value: remote, label: remote }))}
                              onChange={(remote) =>
                                setPublishRemotes((previous) => ({ ...previous, [repository.path]: remote }))
                              }
                            />
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
              {!rootBranch && (
                <p {...stylex.props(styles.note)}>
                  Review is unavailable because this branch does not exist in the root repository.
                </p>
              )}
            </>
          ) : (
            <p {...stylex.props(styles.note)}>
              {snapshot
                ? 'No branches available. Check the repository status below.'
                : 'Reading project branches…'}
            </p>
          )}
          {!selectedBranch &&
            repositories.map((repo) => (
              <p key={repo.path} {...stylex.props(styles.warningNote)}>
                {repo.path === '.' ? project.name : repo.path}: {repo.error || 'No branch available'}
              </p>
            ))}
          {snapshot?.operation && (
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
          <p {...stylex.props(styles.footnote)}>
            Pull and push act on the checked-out branch across the project. Pull only fast-forwards; diverged
            histories need manual handling.
          </p>
        </div>
      </div>
      {nameAction && (
        <GitBranchNameDialog
          projectId={project.id}
          branch={nameAction.branch}
          action={nameAction.action}
          initialRemote={nameAction.branch.remote || checkoutRemote}
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
          onCancel={() => setPreview(undefined)}
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
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    minHeight: 50,
    paddingInline: 16,
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.panel,
  },
  checkout: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: typeScale.small,
  },
  muted: { color: colors.textQuiet },
  activity: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    minWidth: 80,
    color: colors.textQuiet,
    fontSize: typeScale.micro,
  },
  toolbarActions: { display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' },
  body: { display: 'flex', flex: '1', minHeight: 0 },
  main: {
    flex: '1',
    minWidth: 0,
    overflowY: 'auto',
    padding: { default: 28, '@media (max-width: 1050px)': 18 },
  },
  branchHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 20,
    alignItems: 'center',
    marginBottom: 24,
    padding: 20,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    backgroundColor: colors.panel,
    flexWrap: 'wrap',
  },
  branchLabel: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  checkoutBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: typeScale.micro,
    color: colors.successText,
  },
  branchHeading: { minWidth: 0 },
  eyebrow: {
    fontSize: typeScale.micro,
    color: colors.textQuiet,
    letterSpacing: '0.08em',
    marginTop: 0,
    marginBottom: 0,
    textTransform: 'uppercase',
  },
  title: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    fontSize: 22,
    fontFamily: fonts.code,
    letterSpacing: '-0.04em',
    lineHeight: 1.4,
    fontWeight: 550,
    color: colors.textPrimary,
    margin: 0,
    overflowWrap: 'anywhere',
  },
  branchActions: { display: 'flex', gap: 6, flexWrap: 'wrap', flexShrink: 0 },
  sectionHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: colors.textSecondary,
    fontSize: typeScale.compact,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    marginBottom: 12,
  },
  repositoryList: { display: 'flex', flexDirection: 'column', gap: 10 },
  repositoryHeading: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1', minWidth: 0 },
  statusBadge: {
    fontSize: typeScale.micro,
    paddingInline: 8,
    paddingBlock: 4,
    borderRadius: 4,
    backgroundColor: colors.inset,
    color: colors.textMuted,
    maxWidth: '45%',
    overflowWrap: 'anywhere',
  },
  statusClean: { backgroundColor: colors.successSurface, color: colors.successText },
  statusWarning: { backgroundColor: colors.warningSurface, color: colors.warningStrong },
  branchType: { color: colors.textSecondary },
  repository: {
    padding: 16,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: 7,
    backgroundColor: colors.canvas,
  },
  repositoryTop: { display: 'flex', gap: 18, alignItems: 'center', justifyContent: 'space-between' },
  repoName: {
    color: colors.textDefault,
    fontSize: typeScale.compact,
    fontWeight: 550,
    overflowWrap: 'anywhere',
  },
  repoKind: { color: colors.textQuiet, fontSize: typeScale.micro },
  details: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: 18,
    rowGap: 5,
    color: colors.textMuted,
    fontSize: typeScale.small,
    marginTop: 8,
    overflowWrap: 'anywhere',
  },
  current: { color: colors.successText },
  note: { color: colors.textMuted, fontSize: typeScale.small, lineHeight: 1.7, marginBlock: spacing.sm },
  warning: { color: colors.warningStrong },
  warningNote: { color: colors.warningStrong, fontSize: typeScale.small, lineHeight: 1.7, marginBlock: 8 },
  remoteChoice: { display: 'flex', alignItems: 'center', gap: 8, marginBlock: 10 },
  results: { backgroundColor: colors.panel, borderRadius: 6, padding: 16, marginTop: 24 },
  footnote: {
    color: colors.textQuiet,
    fontSize: typeScale.micro,
    lineHeight: 1.7,
    marginTop: 24,
    maxWidth: 620,
  },
});
