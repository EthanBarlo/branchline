import * as stylex from '@stylexjs/stylex';
import { ExternalLink, FolderGit2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { RemoteRepositoryLoad, RemoteReviewState } from '../../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { DialogFooter, DialogIntroduction } from '../../../ui/Dialog';
import { Spinner, spinStyle } from '../../../ui/Spinner';
import { IntegrationDialog } from '../IntegrationDialog';
import { IntegrationLink } from '../IntegrationLink';

import { branchStatus, loadStatus, repositoryRows } from '../RemoteRepositoryStatus';
export function BranchReviewRepositories({
  remote,
  loadingRepositories,
}: {
  remote: RemoteReviewState;
  loadingRepositories?: RemoteRepositoryLoad[];
}) {
  const [open, setOpen] = useState(false);
  const rows = repositoryRows(remote.pullRequests, remote.repositories);
  for (const load of loadingRepositories || [])
    if (!rows.some((row) => row.repository.relativePath === load.repository.relativePath))
      rows.push({ repository: load.repository, sourceBranch: '', targetBranch: '', status: 'no-changes' });
  const unavailable = rows.filter(
    (row) =>
      row.status === 'unavailable' &&
      (!loadingRepositories ||
        loadingRepositories.find((load) => load.repository.relativePath === row.repository.relativePath)
          ?.phase === 'failed'),
  ).length;
  const failedLoads = loadingRepositories?.filter((row) => row.phase === 'failed').length || 0;
  const errors = Math.max(unavailable, failedLoads);
  const loaded = loadingRepositories?.filter((row) => row.phase === 'ready' || row.phase === 'failed').length;
  const loading = !!loadingRepositories?.some((row) => row.phase !== 'ready' && row.phase !== 'failed');
  const statusLabel = loadingRepositories
    ? `${loaded} / ${loadingRepositories.length} loaded`
    : `${rows.length} repositories`;
  return (
    <>
      <Button
        variant="secondary"
        {...stylex.props(styles.contextButton)}
        type="button"
        aria-label={`Repositories: ${statusLabel}${errors ? `, ${errors} unavailable` : ''}`}
        aria-haspopup="dialog"
        title={`Repositories in this review · ${statusLabel}${errors ? ` · ${errors} unavailable` : ''}`}
        onClick={() => setOpen(true)}
      >
        {loading ? <Spinner size={12} aria-hidden="true" /> : <FolderGit2 size={13} aria-hidden="true" />}
        <span {...stylex.props(styles.repositoryContextLabel)}>Repositories</span>
        <span {...stylex.props(styles.contextCount)}>
          {loadingRepositories ? `${loaded}/${loadingRepositories.length}` : rows.length}
        </span>
        {errors > 0 && (
          <span {...stylex.props(styles.contextWarning)} aria-hidden="true">
            <TriangleAlert size={12} />
            {errors}
          </span>
        )}
      </Button>
      {open && (
        <IntegrationDialog title="Repositories in this review" onClose={() => setOpen(false)}>
          <div {...stylex.props(styles.body)}>
            <DialogIntroduction {...stylex.props(styles.introduction)} role="status">
              {statusLabel}
              {errors ? ` · ${errors} unavailable` : ''}. Files are ready to review as each repository loads.
            </DialogIntroduction>
            <div {...stylex.props(styles.branchRepos)}>
              <ul {...stylex.props(styles.branchReposList)} aria-label="Branch review repositories">
                {rows.map((row, index) => {
                  const pr = remote.pullRequests.find(
                    (pr) => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId,
                  );
                  const load = loadingRepositories?.find(
                    (load) => load.repository.relativePath === row.repository.relativePath,
                  );
                  const status = load && load.phase !== 'ready' ? loadStatus(load) : branchStatus(row, pr);
                  const Icon = status.icon;
                  return (
                    <li
                      key={row.repository.relativePath}
                      {...stylex.props(styles.branchRepoRow, index === 0 && styles.branchRepoFirst)}
                      aria-label={`${row.repository.repoSlug} branch review`}
                    >
                      <Icon
                        className={`${status.tone === 'active' ? 'spin ' : ''}${stylex.props(status.tone === 'active' && spinStyle).className}`}
                        size={13}
                        aria-hidden="true"
                      />
                      <div {...stylex.props(styles.branchRepoDetails)}>
                        <strong {...stylex.props(styles.branchRepoName)}>{row.repository.repoSlug}</strong>
                        <code {...stylex.props(styles.branchRepoPath)}>
                          {row.repository.relativePath === '.'
                            ? 'Parent repository'
                            : row.repository.relativePath}
                        </code>
                      </div>
                      <span
                        {...stylex.props(
                          styles.branchStatus,
                          status.tone === 'warning' && styles.branchWarning,
                          ['active', 'complete'].includes(status.tone) && styles.branchSuccess,
                        )}
                      >
                        {status.label}
                      </span>
                      {pr && (
                        <IntegrationLink url={pr.url} variant="branch">
                          Open PR #{pr.id}
                          <ExternalLink size={10} {...stylex.props(styles.linkIcon)} />
                        </IntegrationLink>
                      )}
                      {(load?.error || row.error || row.creation?.error) && (
                        <span {...stylex.props(styles.inlineError, styles.branchRepoError)}>
                          {load?.error || row.error || row.creation?.error}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
          <DialogFooter {...stylex.props(styles.modalChrome)}>
            <Button variant="primary" type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </IntegrationDialog>
      )}
    </>
  );
}

const styles = stylex.create({
  contextButton: {
    minHeight: 27,
    height: 27,
    paddingBlock: 0,
    paddingInline: 9,
    gap: spacing.sm,
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    flexShrink: '0',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: { default: 'none', ':focus-visible': 'solid' },
    outlineColor: colors.focus,
    outlineOffset: { default: 0, ':focus-visible': 3 },
  },
  repositoryContextLabel: { display: { default: 'inline', '@media (max-width: 1150px)': 'none' } },
  contextCount: {
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    color: colors.textSubtle,
    paddingLeft: spacing.xxs,
  },
  contextWarning: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: colors.warningText,
  },
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: '0',
    overflow: 'auto',
  },
  introduction: { maxWidth: '570px', marginBottom: '20px' },
  branchRepos: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  branchReposList: { listStyle: 'none', padding: '0', margin: '0' },
  branchRepoRow: {
    display: 'grid',
    gridTemplateColumns: '14px minmax(110px, 1fr) auto auto',
    alignItems: 'center',
    rowGap: '7px',
    columnGap: '10px',
    minHeight: '48px',
    paddingBlock: '10px',
    paddingInline: spacing.lg,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    color: colors.textQuiet,
    fontSize: typeScale.small,
  },
  branchRepoFirst: { borderTopWidth: 0 },
  branchRepoDetails: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '0' },
  branchRepoName: {
    color: colors.textTertiary,
    fontSize: typeScale.small,
    fontWeight: 500,
    overflowWrap: 'anywhere',
  },
  branchRepoPath: {
    color: colors.textFaint,
    fontSize: typeScale.caption,
    overflowWrap: 'anywhere',
  },
  branchStatus: { fontSize: typeScale.caption, textAlign: 'right' },
  branchWarning: { color: colors.warningText },
  branchSuccess: { color: colors.successText },
  linkIcon: { flexShrink: '0' },
  inlineError: { display: 'block', color: colors.dangerText, fontSize: typeScale.small },
  branchRepoError: { gridColumnEnd: '-1', gridColumnStart: '2' },
  modalChrome: { flexShrink: '0' },
});
