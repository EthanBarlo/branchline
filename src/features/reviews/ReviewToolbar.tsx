import * as stylex from '@stylexjs/stylex';
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { RepoInspection, Review, ReviewSnapshot } from '../../../shared/types';
import { currentReviewId } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { IconButton } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';

interface ReviewToolbarProps {
  review: Review;
  savedReviews: Review[];
  isCurrent: boolean;
  showFiles: boolean;
  onToggleFiles: () => void;
  onSelectReview: (id: string) => void;
  onNewReview: () => void;
  onBrowsePullRequests: () => void;
  inspection?: RepoInspection;
  changingTarget: boolean;
  onChangeTarget: (target: string) => void;
  featureBranch?: string;
  jiraTicket?: string | null;
  jiraBaseUrl?: string;
  jiraConnected: boolean;
  openingJira: boolean;
  onOpenJira: () => void;
  refreshing: boolean;
  refreshError: boolean;
  snapshot?: ReviewSnapshot;
  onRefresh: () => void;
  showFeedback: boolean;
  feedbackCount: number;
  onToggleFeedback: () => void;
  remoteControls?: ReactNode;
  jiraPanel?: ReactNode;
  copyButton?: ReactNode;
  workspaceMenu: ReactNode;
}

export function ReviewToolbar({
  review,
  savedReviews,
  isCurrent,
  showFiles,
  onToggleFiles,
  onSelectReview,
  onNewReview,
  onBrowsePullRequests,
  inspection,
  changingTarget,
  onChangeTarget,
  featureBranch,
  jiraTicket,
  jiraBaseUrl,
  jiraConnected,
  openingJira,
  onOpenJira,
  refreshing,
  refreshError,
  snapshot,
  onRefresh,
  showFeedback,
  feedbackCount,
  onToggleFeedback,
  remoteControls,
  jiraPanel,
  copyButton,
  workspaceMenu,
}: ReviewToolbarProps) {
  return (
    <header
      className={`review-toolbar ${review.remote ? 'remote-toolbar' : ''} ${stylex.props(styles['review-toolbar']).className}`}
      aria-label="Review controls"
    >
      <IconButton
        className={`files-toggle ${stylex.props(styles.toolbarIcon).className}`}
        aria-label={showFiles ? 'Hide files' : 'Show files'}
        aria-expanded={showFiles}
        aria-controls="review-files"
        title={showFiles ? 'Hide file tree' : 'Show file tree'}
        onClick={onToggleFiles}
      >
        {showFiles ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
      </IconButton>
      <Select
        className={`review-picker ${stylex.props(styles['review-picker'], review.remote && styles.remoteReviewPicker).className}`}
        variant="quiet"
        triggerStyle={styles.reviewPickerTrigger}
        label="Select review"
        title={isCurrent ? 'Current follows your checked-out branch' : review.name}
        value={review.id}
        searchPlaceholder="Find a review…"
        options={[
          {
            value: currentReviewId(review.projectId),
            label: 'Current',
            description: 'Follows your checkout',
          },
          ...savedReviews.map((item) => ({
            value: item.id,
            label: item.name,
            description: `${item.baseBranch} ← ${item.featureBranch}`,
            group: item.remote ? 'Bitbucket reviews' : 'Saved reviews',
          })),
        ]}
        onChange={onSelectReview}
      />
      <IconButton
        className={`new-branch-review ${stylex.props(styles.toolbarIcon).className}`}
        aria-label="Review another branch"
        title="Review another branch"
        onClick={onNewReview}
      >
        <Plus size={14} />
      </IconButton>
      <IconButton
        className={stylex.props(styles.toolbarIcon).className}
        aria-label="Browse Bitbucket pull requests"
        title="Bitbucket pull requests"
        onClick={onBrowsePullRequests}
      >
        <GitPullRequest size={14} />
      </IconButton>
      <span className={`toolbar-separator ${stylex.props(styles['toolbar-separator']).className}`} />
      <div
        className={`branch-comparison ${stylex.props(styles['branch-comparison'], review.remote && styles.remoteBranchComparison).className}`}
      >
        {isCurrent ? (
          <Select
            id="current-target-branch"
            className={`current-target-control ${!review.baseBranch ? 'needs-target' : ''} ${stylex.props(styles['current-target-control']).className}`}
            label="Current target branch"
            triggerStyle={review.baseBranch ? styles.codeTrigger : styles.currentTargetNeedsTrigger}
            title={review.baseBranch ? `Target: ${review.baseBranch}` : 'Choose the target branch'}
            value={review.baseBranch}
            placeholder="Select target branch"
            searchPlaceholder="Find a branch…"
            icon={<GitBranch size={12} />}
            disabled={!inspection || changingTarget}
            loading={changingTarget}
            options={(inspection?.branches || []).map((branch) => ({ value: branch, label: branch }))}
            onChange={onChangeTarget}
          />
        ) : (
          <span
            className={`branch-chip ${stylex.props(styles['branch-chip'], review.remote && styles.remoteBranchChip).className}`}
            title={`Target: ${review.baseBranch}`}
          >
            <GitBranch size={12} {...stylex.props(styles.branchChipIcon)} />
            {review.baseBranch}
          </span>
        )}
        <ArrowLeft size={13} className={stylex.props(styles['compare-arrow']).className} />
        <span
          className={`branch-chip feature-branch ${stylex.props(styles['branch-chip'], styles['feature-branch'], review.remote && styles.remoteBranchChip).className}`}
          title={`${isCurrent ? 'Checked out' : 'Feature branch'}: ${featureBranch || 'Detached HEAD'}`}
        >
          <GitBranch size={12} {...stylex.props(styles.branchChipIcon)} />
          {featureBranch || (inspection ? 'Detached HEAD' : 'Reading checkout…')}
        </span>
      </div>
      {jiraTicket && !jiraConnected && (
        <button
          className={`jira-ticket-button ${stylex.props(styles['jira-ticket-button']).className}`}
          aria-label={`Open ${jiraTicket} in Jira`}
          title={
            jiraBaseUrl ? `Open ${jiraTicket} in Jira · ${jiraBaseUrl}` : `Set up Jira to open ${jiraTicket}`
          }
          disabled={openingJira}
          onClick={onOpenJira}
        >
          <span {...stylex.props(styles.jiraTicketText)}>{jiraTicket}</span>
          {openingJira ? (
            <Spinner size={12} />
          ) : (
            <ExternalLink size={12} {...stylex.props(styles.jiraTicketIcon)} />
          )}
        </button>
      )}
      <span
        className={`working-tree-label ${stylex.props(styles['working-tree-label'], review.remote && styles.remoteWorkingTreeLabel).className}`}
        title={
          review.includeWorkingTree
            ? 'Includes eligible uncommitted changes and new files'
            : 'Reviewing committed changes only'
        }
      >
        {review.includeWorkingTree ? 'Local edits' : 'Commits only'}
      </span>
      <div className={`toolbar-actions ${stylex.props(styles['toolbar-actions']).className}`}>
        {remoteControls}
        {jiraPanel}
        <IconButton
          className={`refresh-button ${refreshError ? 'refresh-error' : ''} ${stylex.props(styles.toolbarIcon, styles['refresh-button'], refreshError && styles['refresh-button.refresh-error']).className}`}
          disabled={refreshing}
          onClick={onRefresh}
          aria-label="Refresh review"
          title={`${refreshError ? 'Refresh failed. Click to retry.' : review.remote ? 'Refresh the cached PR diff. Also refreshes when reopened or preparing feedback for publication.' : 'Automatically checks for changes every 4 seconds.'}${snapshot ? ` Last checked ${new Date(snapshot.refreshedAt).toLocaleTimeString()}.` : ''}`}
        >
          {refreshing ? <Spinner size={14} /> : <RefreshCw size={14} />}
        </IconButton>
        <button
          className={`button button-feedback ${showFeedback ? 'active' : ''} ${stylex.props(styles.button, styles['button-feedback'], showFeedback && styles['button-feedback.active'], styles.toolbarButton, styles.toolbarFeedbackButton).className}`}
          aria-label={`Feedback${feedbackCount ? ` (${feedbackCount})` : ''}`}
          aria-pressed={showFeedback}
          onClick={onToggleFeedback}
          title="Show review feedback"
        >
          <MessageSquare size={15} />
          {feedbackCount > 0 && (
            <span className={`soft-count ${stylex.props(styles['soft-count']).className}`}>
              {feedbackCount}
            </span>
          )}
        </button>
        {copyButton}
        {workspaceMenu}
      </div>
    </header>
  );
}

const styles = stylex.create({
  'review-toolbar': {
    display: 'flex',
    alignItems: 'center',
    gap: { default: '7px', '@media (max-width: 1050px)': '5px' },
    height: '40px',
    minHeight: '40px',
    paddingBlock: '0',
    paddingInline: { default: '11px', '@media (max-width: 1050px)': '8px' },
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.panel,
    position: 'relative',
    zIndex: 12,
  },
  'review-picker': {
    minWidth: '79px',
    maxWidth: {
      default: '175px',
      '@media (max-width: 1250px)': '150px',
      '@media (max-width: 1050px)': '125px',
      '@media (max-width: 860px)': '105px',
    },
  },
  'toolbar-separator': {
    width: '1px',
    height: '16px',
    backgroundColor: colors.hover,
    flexShrink: '0',
    marginBlock: '0',
    marginInline: '3px',
  },
  'branch-comparison': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    minWidth: '0',
  },
  'current-target-control': {
    minWidth: '92px',
    maxWidth: {
      default: '216px',
      '@media (max-width: 1050px)': '182px',
      '@media (max-width: 860px)': '157px',
    },
  },
  'branch-chip': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: {
      default: '240px',
      '@media (max-width: 1250px)': '200px',
      '@media (max-width: 1050px)': '180px',
      '@media (max-width: 860px)': '140px',
    },
    minWidth: '0',
    paddingBlock: spacing.xs,
    paddingInline: spacing.sm,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radii.md,
    backgroundColor: 'transparent',
    color: colors.textSubtle,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  'feature-branch': {
    color: colors.textSecondary,
  },
  'compare-arrow': {
    color: colors.textFaint,
    flexShrink: '0',
  },
  'jira-ticket-button': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: '0',
    maxWidth: '145px',
    height: '25px',
    paddingBlock: '0',
    paddingInline: '7px',
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.interactive },
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.border, ':hover:not(:disabled)': colors.textFaint },
    borderRadius: radii.md,
    color: { default: colors.textSecondary, ':hover:not(:disabled)': colors.textPrimary },
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    fontWeight: 400,
    opacity: { default: null, ':disabled': '.5' },
  },
  'working-tree-label': {
    display: { default: 'inline-flex', '@media (max-width: 1050px)': 'none' },
    alignItems: 'center',
    gap: '5px',
    marginLeft: spacing.xxs,
    color: colors.textQuiet,
    fontSize: typeScale.caption,
    whiteSpace: 'nowrap',
  },
  'toolbar-actions': {
    display: 'flex',
    alignItems: 'center',
    gap: { default: '6px', '@media (max-width: 860px)': '3px' },
    marginLeft: 'auto',
    flexShrink: '0',
  },
  'refresh-button': {
    position: 'relative',
  },
  'refresh-button.refresh-error': {
    color: colors.warningStrong,
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '7px',
    minHeight: '33px',
    paddingBlock: '0',
    paddingInline: spacing.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '5px',
    fontSize: typeScale.compact,
    fontWeight: 550,
    whiteSpace: 'nowrap',
    transition: 'background-color 140ms, color 140ms, opacity 140ms, border-color 140ms',
    opacity: { default: null, ':disabled': '.4' },
  },
  'button-feedback': {
    borderColor: 'transparent',
    color: { default: colors.textSubtle, ':hover': colors.textDefault },
    backgroundColor: { default: 'transparent', ':hover': colors.interactive },
  },
  'button-feedback.active': {
    backgroundColor: colors.interactive,
    color: colors.textDefault,
  },
  'soft-count': {
    paddingBlock: '0',
    paddingInline: spacing.xs,
    borderRadius: radii.sm,
    backgroundColor: colors.hover,
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: '15px',
  },
  toolbarIcon: { width: 27, height: 27, flexShrink: 0 },
  remoteBranchComparison: { minWidth: 0, flex: '1', overflow: 'hidden' },
  remoteBranchChip: { minWidth: 0, maxWidth: { default: 170, '@media (max-width: 1050px)': 105 } },
  remoteReviewPicker: { maxWidth: { default: 145, '@media (max-width: 1050px)': 112 }, flexShrink: 1 },
  remoteWorkingTreeLabel: { display: 'none' },
  reviewPickerTrigger: { fontWeight: 550 },
  codeTrigger: { fontFamily: fonts.code },
  currentTargetNeedsTrigger: {
    fontFamily: fonts.code,
    borderColor: colors.textFaint,
    backgroundColor: colors.borderSubtle,
    color: colors.textDefault,
  },
  branchChipIcon: { flexShrink: 0, color: colors.textMuted },
  jiraTicketText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  jiraTicketIcon: { flexShrink: 0, color: colors.textMuted },
  toolbarButton: {
    minHeight: 27,
    height: 27,
    borderRadius: radii.md,
    paddingBlock: '0',
    paddingInline: { default: '9px', '@media (max-width: 860px)': '7px' },
    gap: spacing.sm,
    fontSize: typeScale.small,
  },
  toolbarFeedbackButton: {
    paddingBlock: '0',
    paddingInline: spacing.sm,
  },
});
