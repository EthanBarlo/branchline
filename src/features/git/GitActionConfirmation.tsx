import * as stylex from '@stylexjs/stylex';
import type {
  GitAction,
  GitActionPreview,
  GitActionRow,
  GitBranchChoice,
  GitRepositoryStatus,
} from '../../../shared/git-workflow';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog, DialogBody, DialogFooter } from '../../ui/Dialog';
import { FormError } from '../../ui/Field';
import { Select } from '../../ui/Select';

/** `confirm` asks before running; `incoming` and `details` only explain why an action cannot run. */
export type GitPreviewMode = 'confirm' | 'incoming' | 'details';

/** A push row that would create a branch the remote does not have yet. */
export function createsRemoteBranch(row: GitActionRow): boolean {
  return !row.noop && !row.skipped && row.destination?.commit === null;
}

function rowStatus(action: GitAction, row: GitActionRow, mode: GitPreviewMode): string {
  if (row.skipped) return 'Skipped';
  if (row.incoming)
    return row.outgoing
      ? `Diverged · ${row.outgoing} local, ${row.incoming} remote`
      : `${row.incoming} incoming`;
  if (row.blockers.length && mode !== 'confirm') return 'Blocked';
  if (row.noop)
    return action === 'delete' || (action === 'push' && !row.source?.commit)
      ? 'Not present; skipped'
      : 'Already up to date';
  if (action === 'push' && createsRemoteBranch(row)) return 'New remote branch';
  if (row.createTracking) return 'Set tracking branch';
  if (action === 'create') return 'Create local branch';
  if (action === 'delete') return row.source?.remote ? 'Delete remote branch' : 'Delete local branch';
  if (action === 'rename') return 'Rename local branch';
  return 'Update branch';
}

export function GitActionConfirmation({
  preview,
  mode = 'confirm',
  projectName,
  pending,
  checking,
  error,
  deletionBranch,
  deleteRemote,
  deletionRepositories,
  deletionRemotes,
  onDeleteRemote,
  onDeletionRemote,
  publicationChoices,
  onPublicationRemote,
  pushSkips,
  onPushSkip,
  forceDelete,
  onForceDelete,
  onCancel,
  onConfirm,
}: {
  preview: GitActionPreview;
  mode?: GitPreviewMode;
  projectName: string;
  pending: boolean;
  checking: boolean;
  error?: string;
  deletionBranch?: GitBranchChoice;
  deleteRemote: boolean;
  deletionRepositories: GitRepositoryStatus[];
  deletionRemotes: Record<string, string>;
  onDeleteRemote: (value: boolean) => void;
  onDeletionRemote: (path: string, remote: string) => void;
  publicationChoices: Record<string, string>;
  onPublicationRemote: (path: string, remote: string) => void;
  /** Repositories left out of a push. */
  pushSkips: string[];
  onPushSkip: (path: string, skip: boolean) => void;
  forceDelete: boolean;
  onForceDelete: (force: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verb =
    preview.action === 'create' || preview.action === 'delete' ? `${preview.action} branch` : preview.action;
  const title = verb.charAt(0).toUpperCase() + verb.slice(1);
  const executing = pending && !checking;
  const diverged = preview.rows.some((row) => row.incoming && row.outgoing);
  const choosingPush = preview.action === 'push' && mode === 'confirm';
  // Repositories without the pushed branch have nothing to choose.
  const absent = (row: GitActionRow) =>
    preview.action === 'push' && row.noop && !row.skipped && !row.source?.commit;
  const choosable = choosingPush && preview.rows.filter((row) => !absent(row)).length > 1;
  return (
    <Dialog
      title={
        mode === 'incoming'
          ? 'Push needs a pull'
          : mode === 'details'
            ? `${title} blocked`
            : `${title} preview`
      }
      onClose={onCancel}
      busy={executing}
      wide
    >
      <DialogBody>
        <section aria-label="Git action preview" aria-busy={checking}>
          {deletionBranch && (
            <p {...stylex.props(styles.code)}>
              {deletionBranch.remote ? `${deletionBranch.remote}/` : ''}
              {deletionBranch.name}
            </p>
          )}
          {checking && (
            <p role="status" {...stylex.props(styles.note)}>
              Checking repositories…
            </p>
          )}
          {error && <FormError>{error}</FormError>}
          {mode === 'incoming' && (
            <p {...stylex.props(styles.note)}>
              {diverged
                ? 'Local and remote history have diverged. Merge or rebase manually, then push again.'
                : 'The remote has commits you do not have yet. Pull them first, then push again.'}
            </p>
          )}
          {preview.action === 'delete' &&
            deletionBranch &&
            !deletionBranch.remote &&
            (deleteRemote ||
              Object.values(preview.remoteDeletionCandidates ?? {}).some((targets) => targets.length)) && (
              <label {...stylex.props(styles.forceChoice)}>
                <input
                  type="checkbox"
                  checked={deleteRemote}
                  disabled={executing}
                  onChange={(event) => onDeleteRemote(event.target.checked)}
                />
                Also delete remote branch
              </label>
            )}
          {preview.rows.map((row) => {
            const label = row.path === '.' ? projectName : row.path;
            const selectable = choosable && !absent(row);
            return (
              <div key={row.path} {...stylex.props(styles.previewRow)}>
                <div {...stylex.props(styles.previewHeading)}>
                  <label {...stylex.props(styles.repository)}>
                    {selectable && (
                      <input
                        type="checkbox"
                        aria-label={`Push ${label}`}
                        checked={!pushSkips.includes(row.path)}
                        disabled={executing}
                        onChange={(event) => onPushSkip(row.path, !event.target.checked)}
                      />
                    )}
                    <span {...stylex.props(styles.code)}>
                      {label}
                      {row.source &&
                        ` · ${row.source.remote ? `${row.source.remote}/` : ''}${row.source.branch}`}{' '}
                      {preview.action !== 'delete' && !row.skipped && !absent(row) && (
                        <>
                          {' '}
                          →{' '}
                          {row.destination
                            ? `${row.destination.remote ? `${row.destination.remote}/` : ''}${row.destination.branch}`
                            : 'Blocked'}
                        </>
                      )}
                    </span>
                  </label>
                  <span {...stylex.props(styles.note)}>{rowStatus(preview.action, row, mode)}</span>
                </div>
                {!row.skipped && (row.destination?.url || row.source?.url) && (
                  <p {...stylex.props(styles.note, styles.url)}>{row.destination?.url || row.source?.url}</p>
                )}
                {choosingPush && !row.skipped && (row.remoteChoices?.length ?? 0) > 1 && (
                  <Select
                    label={`Publish remote for ${row.path}`}
                    value={publicationChoices[row.path]}
                    placeholder="Choose remote"
                    disabled={pending}
                    options={row.remoteChoices!.map((remote) => ({ value: remote, label: remote }))}
                    onChange={(remote) => onPublicationRemote(row.path, remote)}
                  />
                )}
                {row.remoteDeletion && (
                  <p {...stylex.props(styles.code)}>
                    {row.remoteDeletion.remote}/{row.remoteDeletion.branch}
                    {' · '}
                    {row.remoteDeletion.commit ? 'Delete remote branch' : 'Not present; skipped'}
                  </p>
                )}
                {row.remoteDeletion?.url && (
                  <p {...stylex.props(styles.note, styles.url)}>{row.remoteDeletion.url}</p>
                )}
                {preview.action === 'delete' &&
                  !deletionBranch?.remote &&
                  deleteRemote &&
                  (deletionRepositories.find((repo) => repo.path === row.path)?.remotes.length ?? 0) > 1 && (
                    <Select
                      label={`Delete remote for ${row.path}`}
                      value={deletionRemotes[row.path] || row.remoteDeletion?.remote || ''}
                      placeholder="Choose remote"
                      disabled={executing}
                      options={(
                        deletionRepositories.find((repo) => repo.path === row.path)?.remotes ?? []
                      ).map((remote) => ({ value: remote, label: remote }))}
                      onChange={(remote) => onDeletionRemote(row.path, remote)}
                    />
                  )}
                {row.blockers.map((blocker) => (
                  <p key={blocker} {...stylex.props(styles.warning, styles.note)}>
                    {blocker}
                  </p>
                ))}
                {row.warnings.map((warning) => (
                  <p key={warning} {...stylex.props(styles.note)}>
                    {warning}
                  </p>
                ))}
              </div>
            );
          })}
          {preview.action === 'delete' && (
            <>
              <p {...stylex.props(styles.note)}>
                {deletionBranch?.remote
                  ? 'Deletes the branch on the selected remote in every repository where it exists. Local branches stay unchanged.'
                  : deleteRemote
                    ? 'Deletes the local branch and its remote counterpart in every repository. Check the targets above before confirming.'
                    : 'Deletes the local branch in every repository where it exists. Remote branches stay unchanged.'}
              </p>
              {preview.rows.some((row) => row.unmergedCommits) && (
                <label {...stylex.props(styles.forceChoice)}>
                  <input
                    type="checkbox"
                    checked={forceDelete}
                    disabled={executing}
                    onChange={(event) => onForceDelete(event.target.checked)}
                  />
                  Delete even if unmerged
                </label>
              )}
            </>
          )}
          {preview.action === 'delete' && (
            <p {...stylex.props(styles.note)}>
              Every repository must pass checks before starting. Completed steps remain if a later step fails.
            </p>
          )}
          {choosingPush && preview.rows.some(createsRemoteBranch) && (
            <p {...stylex.props(styles.note)}>
              New remote branches are created and tracked by their local branches.
            </p>
          )}
        </section>
      </DialogBody>
      <DialogFooter>
        {mode === 'confirm' ? (
          <>
            <Button disabled={executing} onClick={onCancel}>
              Cancel preview
            </Button>
            <Button
              variant={preview.action === 'delete' ? 'danger' : 'primary'}
              disabled={
                pending ||
                checking ||
                !preview.id ||
                !preview.ready ||
                preview.rows.every((row) => row.noop && !row.createTracking)
              }
              onClick={onConfirm}
            >
              Confirm {verb}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onCancel}>
            Close
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
const styles = stylex.create({
  forceChoice: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    color: colors.textDefault,
    fontSize: typeScale.small,
    marginBlock: spacing.md,
  },
  previewRow: {
    paddingBlock: spacing.md,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  previewHeading: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: spacing.md,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  repository: { display: 'flex', alignItems: 'center', gap: spacing.md, minWidth: 0 },
  code: {
    color: colors.textSecondary,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    overflowWrap: 'anywhere',
    lineHeight: 1.7,
  },
  note: { color: colors.textMuted, fontSize: typeScale.small, lineHeight: 1.7, marginBlock: spacing.sm },
  warning: { color: colors.warningStrong },
  url: { overflowWrap: 'anywhere' },
});
