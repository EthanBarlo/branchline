import * as stylex from '@stylexjs/stylex';
import type { GitActionPreview, GitBranchChoice, GitRepositoryStatus } from '../../../shared/git-workflow';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog, DialogBody, DialogFooter } from '../../ui/Dialog';
import { FormError } from '../../ui/Field';
import { Select } from '../../ui/Select';

export function GitActionConfirmation({
  preview,
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
  publicationRepositories,
  publicationChoices,
  onPublicationRemote,
  forceDelete,
  onForceDelete,
  onCancel,
  onConfirm,
}: {
  preview: GitActionPreview;
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
  publicationRepositories: GitRepositoryStatus[];
  publicationChoices: Record<string, string>;
  onPublicationRemote: (path: string, remote: string) => void;
  forceDelete: boolean;
  onForceDelete: (force: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verb =
    preview.action === 'create' || preview.action === 'delete' ? `${preview.action} branch` : preview.action;
  const title = verb.charAt(0).toUpperCase() + verb.slice(1);
  const executing = pending && !checking;
  return (
    <Dialog title={`${title} preview`} onClose={onCancel} busy={executing} wide>
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
            const publication = publicationRepositories.find((repo) => repo.path === row.path);
            return (
              <div key={row.path} {...stylex.props(styles.previewRow)}>
                <div {...stylex.props(styles.previewHeading)}>
                  <span {...stylex.props(styles.code)}>
                    {row.path === '.' ? projectName : row.path}
                    {row.source &&
                      ` · ${row.source.remote ? `${row.source.remote}/` : ''}${row.source.branch}`}{' '}
                    {preview.action !== 'delete' && (
                      <>
                        {' '}
                        →{' '}
                        {row.destination
                          ? `${row.destination.remote ? `${row.destination.remote}/` : ''}${row.destination.branch}`
                          : 'Blocked'}
                      </>
                    )}
                  </span>
                  <span {...stylex.props(styles.note)}>
                    {row.noop
                      ? preview.action === 'delete'
                        ? 'Not present; skipped'
                        : 'Already up to date'
                      : row.createTracking
                        ? 'Set tracking branch'
                        : preview.action === 'create'
                          ? 'Create local branch'
                          : preview.action === 'delete'
                            ? row.source?.remote
                              ? 'Delete remote branch'
                              : 'Delete local branch'
                            : preview.action === 'rename'
                              ? 'Rename local branch'
                              : 'Update branch'}
                  </span>
                </div>
                {(row.destination?.url || row.source?.url) && (
                  <p {...stylex.props(styles.note, styles.url)}>{row.destination?.url || row.source?.url}</p>
                )}
                {preview.action === 'push' && publication && publication.remotes.length > 1 && (
                  <Select
                    label={`Publish remote for ${row.path}`}
                    value={publicationChoices[row.path]}
                    placeholder="Choose remote"
                    disabled={pending}
                    options={publication.remotes.map((remote) => ({ value: remote, label: remote }))}
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
          <p {...stylex.props(styles.note)}>
            Every repository must pass checks before starting. Completed steps remain if a later step fails.
          </p>
        </section>
      </DialogBody>
      <DialogFooter>
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
