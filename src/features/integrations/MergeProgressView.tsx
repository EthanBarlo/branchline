import * as stylex from '@stylexjs/stylex';
import {
  Check,
  Circle,
  CirclePause,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  SkipForward,
  TriangleAlert,
} from 'lucide-react';
import type { BranchReviewRepository, MergeOperation, PullRequest } from '../../../shared/integrations';
import { pullRequestKey } from '../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { spinStyle } from '../../ui/Spinner';
import { IntegrationLink, Problem } from './IntegrationPrimitives';
import { repositoryMergeProgress } from './mergeProgress';

import { CleanupStatus, repositoryRows } from './RemoteRepositoryStatus';
export function MergeProgressView({
  pullRequests,
  repositories,
  operation,
  action = operation?.action || 'merge',
  checking = false,
  running = false,
}: {
  pullRequests: PullRequest[];
  repositories?: BranchReviewRepository[];
  operation?: MergeOperation;
  action?: 'approve' | 'merge';
  checking?: boolean;
  running?: boolean;
}) {
  const rows = repositoryRows(pullRequests, repositories).map((row) => {
    const pr = pullRequests.find(
      (pr) => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId,
    );
    const item = pr && operation?.items.find((progress) => progress.prKey === pullRequestKey(pr));
    return {
      row,
      pr,
      item,
      ...repositoryMergeProgress({ row, pr, item, operation, action, checking, running }),
    };
  });
  const finished = rows.filter((row) => row.finished).length;
  const allMerged =
    action === 'merge' &&
    !!operation?.items.length &&
    operation.items.every((item) => item.merge === 'merged');
  const title =
    operation?.state === 'paused'
      ? 'Operation paused'
      : operation?.state === 'complete'
        ? action === 'merge'
          ? finished === rows.length
            ? 'Repositories complete'
            : 'Branch cleanup needs attention'
          : 'Repositories approved'
        : running || operation?.state === 'running'
          ? action === 'merge'
            ? allMerged
              ? 'Deleting branches'
              : 'Merging repositories'
            : 'Approving repositories'
          : checking
            ? 'Checking repositories…'
            : 'Repositories';
  const icons = {
    spinner: LoaderCircle,
    check: Check,
    skip: SkipForward,
    warning: TriangleAlert,
    pause: CirclePause,
    circle: Circle,
    pr: GitPullRequest,
  };
  return (
    <section
      {...stylex.props(styles.mergeProgress)}
      aria-label="Pull request operation progress"
      aria-live="polite"
    >
      <div {...stylex.props(styles.sectionHeading, styles.mergeHeading)}>
        <h3 {...stylex.props(styles.sectionTitle)}>{title}</h3>
        <span {...stylex.props(styles.mergeCount)} title="Completed repository workflows">
          {finished} / {rows.length}
        </span>
      </div>
      <ul {...stylex.props(styles.mergeList)} aria-label="Repositories">
        {rows.map(({ row, pr, item, status, cleanup, detail, error }, index) => {
          const Icon = icons[status.icon];
          return (
            <li
              {...stylex.props(
                styles.mergeRow,
                index === rows.length - 1 && styles.mergeLastRow,
                status.tone === 'active' && styles.mergeRowActive,
              )}
              key={row.repository.relativePath}
              aria-label={
                pr
                  ? `${pr.repository.repoSlug} pull request ${pr.id}`
                  : `${row.repository.repoSlug} branch cleanup`
              }
            >
              <span
                className={`merge-repository-icon ${
                  stylex.props(
                    styles.mergeIcon,
                    status.tone === 'active' && styles.mergeIconActive,
                    status.tone === 'complete' && styles.mergeIconComplete,
                    status.tone === 'warning' && styles.mergeIconWarning,
                  ).className
                }`}
                aria-hidden="true"
              >
                <Icon
                  className={`${status.tone === 'active' ? 'spin ' : ''}${stylex.props(status.tone === 'active' && spinStyle, status.tone === 'active' && styles.reducedMotionSpinner).className}`}
                  size={16}
                />
              </span>
              <div {...stylex.props(styles.mergeDetails)}>
                <div {...stylex.props(styles.mergeName)}>
                  <strong {...stylex.props(styles.mergeNameStrong)}>{row.repository.repoSlug}</strong>
                  {pr && (
                    <IntegrationLink url={pr.url} variant="merge">
                      #{pr.id}
                      <ExternalLink size={10} {...stylex.props(styles.linkIcon)} />
                    </IntegrationLink>
                  )}
                </div>
                <span {...stylex.props(styles.mergePath)}>
                  {row.repository.relativePath === '.' ? 'Parent repository' : row.repository.relativePath}
                </span>
                <code {...stylex.props(styles.mergeBranches)}>
                  {row.sourceBranch}
                  <span {...stylex.props(styles.mergeBranchArrow)}> → </span>
                  {row.targetBranch}
                </code>
              </div>
              <div {...stylex.props(styles.mergeResult)}>
                <span
                  {...stylex.props(
                    styles.mergeStatus,
                    status.tone === 'active' && styles.mergeStatusActive,
                    status.tone === 'complete' && styles.mergeStatusComplete,
                    status.tone === 'warning' && styles.mergeStatusWarning,
                  )}
                >
                  {status.label}
                </span>
                {detail && <span {...stylex.props(styles.mergePath)}>{detail}</span>}
                <CleanupStatus state={cleanup} />
              </div>
              {item?.pointerState === 'review' && (
                <span {...stylex.props(styles.mergeInlineError, styles.pointerProgress)}>
                  Pointer changes are ready. Return to the diff, review them, then resume.
                </span>
              )}
              {error && <span {...stylex.props(styles.inlineError, styles.mergeInlineError)}>{error}</span>}
            </li>
          );
        })}
      </ul>
      {operation?.error && <Problem>{operation.error}</Problem>}
    </section>
  );
}

const styles = stylex.create({
  mergeProgress: { marginTop: '20px' },
  sectionHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  mergeHeading: { marginBottom: '11px' },
  sectionTitle: { margin: '0', fontSize: typeScale.body, fontWeight: 550 },
  mergeCount: {
    color: colors.successText,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  mergeList: {
    listStyle: 'none',
    padding: '0',
    margin: '0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
  mergeRow: {
    display: 'grid',
    gridTemplateColumns: '30px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '11px',
    rowGap: '9px',
    paddingBlock: '15px',
    paddingInline: '14px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    color: colors.textSubtle,
    transition: {
      default: 'background .18s ease',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  mergeLastRow: { borderBottomWidth: 0 },
  mergeRowActive: { backgroundColor: colors.successSurface },
  mergeIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '50%',
    color: colors.textFaint,
  },
  mergeIconActive: {
    color: colors.successText,
    borderColor: colors.successBorder,
    backgroundColor: colors.successRaised,
  },
  mergeIconComplete: {
    color: colors.successText,
    borderColor: colors.successBorder,
    backgroundColor: colors.successSurface,
  },
  mergeIconWarning: {
    color: colors.warningText,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSurface,
  },
  reducedMotionSpinner: {
    animationName: { default: null, '@media (prefers-reduced-motion: reduce)': 'none' },
  },
  mergeDetails: { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '0' },
  mergeName: { display: 'flex', alignItems: 'center', gap: spacing.md, minWidth: '0' },
  mergeNameStrong: {
    color: colors.accent,
    fontSize: typeScale.body,
    fontWeight: 550,
    overflowWrap: 'anywhere',
  },
  linkIcon: { flexShrink: '0' },
  mergePath: {
    color: colors.textQuiet,
    fontSize: typeScale.caption,
    overflowWrap: 'anywhere',
  },
  mergeBranches: {
    color: colors.textSubtle,
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  mergeBranchArrow: { color: colors.textFaint },
  mergeResult: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '7px',
    maxWidth: '175px',
    textAlign: 'right',
  },
  mergeStatus: { color: colors.textQuiet, fontSize: typeScale.small, lineHeight: 1.5 },
  mergeStatusActive: { color: colors.successText },
  mergeStatusComplete: { color: colors.successText },
  mergeStatusWarning: { color: colors.warningText },
  mergeInlineError: {
    gridColumnEnd: '-1',
    gridColumnStart: '2',
    fontSize: typeScale.small,
    lineHeight: 1.7,
  },
  pointerProgress: { color: colors.warningText },
  inlineError: { display: 'block', color: colors.dangerText, fontSize: typeScale.small },
});
