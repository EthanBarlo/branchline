import * as stylex from '@stylexjs/stylex';
import type { RemoteRepositoryLoad } from '../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { spinStyle } from '../../ui/Spinner';

import { loadStatus } from './RemoteRepositoryStatus';
export function RemoteLoadRepositories({ repositories }: { repositories: RemoteRepositoryLoad[] }) {
  const finished = repositories.filter((row) => row.phase === 'ready' || row.phase === 'failed').length;
  return (
    <section
      {...stylex.props(styles.remoteLoadRepos)}
      aria-label="Repository loading progress"
      aria-live="polite"
    >
      <div {...stylex.props(styles.remoteLoadHeading)}>
        <strong {...stylex.props(styles.remoteLoadTitle)}>Repositories</strong>
        <span {...stylex.props(styles.remoteLoadCount)}>
          {finished} / {repositories.length} checked
        </span>
      </div>
      <ul {...stylex.props(styles.remoteLoadList)}>
        {repositories.map((row, index) => {
          const status = loadStatus(row);
          const Icon = status.icon;
          return (
            <li
              key={row.repository.relativePath}
              {...stylex.props(
                styles.remoteLoadRow,
                index > 0 && styles.remoteLoadFollowing,
                status.tone === 'warning' && styles.branchWarning,
                status.tone === 'complete' && styles.branchSuccess,
              )}
              aria-label={`${row.repository.repoSlug} loading progress`}
            >
              <Icon
                size={15}
                className={`${status.tone === 'active' ? 'spin ' : ''}${stylex.props(status.tone === 'active' && spinStyle, status.tone === 'active' && styles.reducedMotionSpinner).className}`}
                aria-hidden="true"
              />
              <div {...stylex.props(styles.remoteLoadDetails)}>
                <strong {...stylex.props(styles.remoteLoadName)}>{row.repository.repoSlug}</strong>
                <code {...stylex.props(styles.remoteLoadPath)}>
                  {row.repository.relativePath === '.' ? 'Parent repository' : row.repository.relativePath}
                </code>
              </div>
              <span {...stylex.props(styles.remoteLoadStatus)}>{status.label}</span>
              {row.error && <small {...stylex.props(styles.remoteLoadError)}>{row.error}</small>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const styles = stylex.create({
  remoteLoadRepos: {
    width: 'min(510px, calc(100% - 44px))',
    marginTop: spacing.xxl,
    marginRight: '0',
    marginBottom: '35px',
    marginLeft: '0',
    textAlign: 'left',
  },
  remoteLoadHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '11px',
    color: colors.textTertiary,
    fontSize: typeScale.compact,
  },
  remoteLoadTitle: { fontWeight: 500 },
  remoteLoadCount: {
    color: colors.textQuiet,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  remoteLoadList: {
    listStyle: 'none',
    margin: '0',
    padding: '0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  remoteLoadRow: {
    display: 'grid',
    gridTemplateColumns: '18px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '11px',
    paddingBlock: '13px',
    paddingInline: '15px',
    backgroundColor: colors.surface,
  },
  remoteLoadFollowing: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  branchWarning: { color: colors.warningText },
  branchSuccess: { color: colors.successText },
  reducedMotionSpinner: {
    animationName: { default: null, '@media (prefers-reduced-motion: reduce)': 'none' },
  },
  remoteLoadDetails: { minWidth: '0' },
  remoteLoadName: {
    display: 'block',
    color: colors.accent,
    fontSize: typeScale.compact,
    fontWeight: 500,
    overflowWrap: 'anywhere',
  },
  remoteLoadPath: {
    display: 'block',
    color: colors.textFaint,
    fontSize: typeScale.caption,
    marginTop: spacing.xs,
    overflowWrap: 'anywhere',
  },
  remoteLoadStatus: { fontSize: typeScale.small },
  remoteLoadError: {
    gridColumnEnd: '-1',
    gridColumnStart: '2',
    fontSize: typeScale.small,
    lineHeight: 1.6,
    color: colors.warningText,
    overflowWrap: 'anywhere',
  },
});
