import * as stylex from '@stylexjs/stylex';
import type { GitActionPreview, GitRepositoryStatus } from '../../../shared/git-workflow';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Dialog, DialogBody, DialogFooter } from '../../ui/Dialog';
import { Select } from '../../ui/Select';

export function GitActionConfirmation({
  preview,
  projectName,
  pending,
  publicationRepositories,
  publicationChoices,
  onPublicationRemote,
  onCancel,
  onConfirm,
}: {
  preview: GitActionPreview;
  projectName: string;
  pending: boolean;
  publicationRepositories: GitRepositoryStatus[];
  publicationChoices: Record<string, string>;
  onPublicationRemote: (path: string, remote: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verb = preview.action === 'create' ? 'create branch' : preview.action;
  const title = verb.charAt(0).toUpperCase() + verb.slice(1);
  return (
    <Dialog title={`${title} preview`} onClose={onCancel} busy={pending} wide>
      <DialogBody>
        <section aria-label="Git action preview">
          {preview.rows.map((row) => {
            const publication = publicationRepositories.find((repo) => repo.path === row.path);
            return (
              <div key={row.path} {...stylex.props(styles.previewRow)}>
                <div {...stylex.props(styles.previewHeading)}>
                  <span {...stylex.props(styles.code)}>
                    {row.path === '.' ? projectName : row.path}
                    {row.source &&
                      ` · ${row.source.remote ? `${row.source.remote}/` : ''}${row.source.branch}`}{' '}
                    →{' '}
                    {row.destination
                      ? `${row.destination.remote ? `${row.destination.remote}/` : ''}${row.destination.branch}`
                      : 'Blocked'}
                  </span>
                  <span {...stylex.props(styles.note)}>
                    {row.noop
                      ? 'Already up to date'
                      : row.createTracking
                        ? 'Set tracking branch'
                        : preview.action === 'create'
                          ? 'Create local branch'
                          : preview.action === 'rename'
                            ? 'Rename local branch'
                            : 'Update branch'}
                  </span>
                </div>
                {row.destination?.url && (
                  <p {...stylex.props(styles.note, styles.url)}>{row.destination.url}</p>
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
          <p {...stylex.props(styles.note)}>
            Every repository must pass checks before starting. Completed steps remain if a later step fails.
          </p>
        </section>
      </DialogBody>
      <DialogFooter>
        <Button disabled={pending} onClick={onCancel}>
          Cancel preview
        </Button>
        <Button
          variant="primary"
          disabled={pending || !preview.ready || preview.rows.every((row) => row.noop && !row.createTracking)}
          onClick={onConfirm}
        >
          Confirm {verb}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
const styles = stylex.create({
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
