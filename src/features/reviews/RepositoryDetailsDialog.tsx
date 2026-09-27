import * as stylex from '@stylexjs/stylex';
import { GitFork } from 'lucide-react';
import type { ReviewSnapshot } from '../../../shared/types';
import { colors, fonts, spacing, typeScale } from '../../theme/tokens.stylex';
import { Dialog, DialogBody } from '../../ui/Dialog';
import { repositoryName } from '../projects/repositoryName';

export function RepositoryDetailsDialog({
  snapshot,
  repoPath,
  needsTarget,
  onClose,
}: {
  snapshot?: ReviewSnapshot;
  repoPath: string;
  needsTarget: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog title="Repositories in this review" onClose={onClose}>
      <DialogBody>
        <p className={`integration-note ${stylex.props(styles['integration-note']).className}`}>
          Each comparison starts at its own merge base.
        </p>
        {snapshot?.repos.length ? (
          snapshot.repos.map((repo) => (
            <div
              className={`repository-detail ${stylex.props(styles['repository-detail']).className}`}
              key={repo.relativePath}
            >
              <GitFork size={14} />
              <span
                className={`repository-detail-name ${stylex.props(styles['repository-detail-name']).className}`}
              >
                {repo.relativePath === '.' || !repo.relativePath
                  ? repositoryName(repoPath)
                  : repo.relativePath}
              </span>
              {repo.error ? (
                <span
                  className={`repository-detail-error ${stylex.props(styles['repository-detail-error']).className}`}
                >
                  {repo.error}
                </span>
              ) : (
                <span>{repo.workingTreeIncluded ? 'Branch + working tree' : 'Branch commits'}</span>
              )}
            </div>
          ))
        ) : (
          <p>{needsTarget ? 'Choose a target to compare repositories.' : 'Discovering repositories…'}</p>
        )}
      </DialogBody>
    </Dialog>
  );
}

const styles = stylex.create({
  'integration-note': {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: 10,
    marginInline: 0,
  },
  'repository-detail': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingBlock: '5px',
    paddingInline: '0',
    color: colors.textSubtle,
    fontSize: typeScale.small,
  },
  'repository-detail-name': {
    minWidth: '150px',
    fontFamily: fonts.code,
    color: colors.textSecondary,
  },
  'repository-detail-error': {
    color: colors.warningStrong,
  },
});
