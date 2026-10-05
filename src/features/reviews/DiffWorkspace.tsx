import * as stylex from '@stylexjs/stylex';
import { CheckCheck, Circle, CircleCheck, FileCode2, RefreshCw } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { RemoteRepositoryLoad } from '../../../shared/integrations';
import type { ReviewFile, ReviewSnapshot } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { RemoteLoadRepositories } from '../integrations/RemoteLoadRepositories';
import { DiffViewer } from './diff/DiffViewer';
import { DiffStack } from './diff/DiffStack';
import { fileLocation } from './fileLocation';

interface DiffWorkspaceProps {
  stackProps: Omit<ComponentProps<typeof DiffStack>, 'selectedFileId' | 'viewerProps'>;
  selectedFile?: ReviewFile;
  snapshot?: ReviewSnapshot;
  remoteLoading: boolean;
  loadingRepositories?: RemoteRepositoryLoad[];
  approvedCount: number;
  pendingCount: number;
  pointerChangeCount: number;
  incompleteSnapshot: boolean;
  showFiles: boolean;
  onShowFiles: () => void;
  historicalState?: string;
  staleApproval: boolean;
  diffStyle: 'split' | 'unified';
  onDiffStyleChange: (style: 'split' | 'unified') => void;
  approved: boolean;
  approvalBusy: boolean;
  onToggleApproval: () => void;
  viewerProps: ComponentProps<typeof DiffViewer>;
}

export function DiffWorkspace({
  stackProps,
  selectedFile,
  snapshot,
  remoteLoading,
  loadingRepositories,
  approvedCount,
  pendingCount,
  pointerChangeCount,
  incompleteSnapshot,
  showFiles,
  onShowFiles,
  historicalState,
  staleApproval,
  diffStyle,
  onDiffStyleChange,
  approved,
  approvalBusy,
  onToggleApproval,
  viewerProps,
}: DiffWorkspaceProps) {
  const showFilesButton =
    !showFiles && snapshot?.files.length ? <Button onClick={onShowFiles}>Show files</Button> : null;
  return (
    <section
      className={`diff-workspace ${stylex.props(styles['diff-workspace']).className}`}
      aria-label="File diff"
    >
      {remoteLoading && !selectedFile ? (
        <div
          className={`central-empty remote-loading-state ${stylex.props(styles['central-empty'], styles['remote-loading-state']).className}`}
        >
          <h2 {...stylex.props(styles.centralTitle, styles.remoteLoadingTitle)}>
            {snapshot?.files.length && approvedCount === pendingCount
              ? 'Loaded files reviewed.'
              : 'Loading your repositories'}
          </h2>
          <p {...stylex.props(styles.centralDescription)}>
            {snapshot?.files.length && approvedCount === pendingCount
              ? 'The remaining changes will appear as each repository finishes.'
              : 'Start reviewing as soon as the first files arrive.'}
          </p>
          <RemoteLoadRepositories repositories={loadingRepositories || []} />
          {showFilesButton}
        </div>
      ) : !snapshot ? (
        <div className={`central-empty ${stylex.props(styles['central-empty']).className}`}>
          <Spinner size={26} />
          <h2 {...stylex.props(styles.centralTitle)}>Gathering your changes</h2>
          <p {...stylex.props(styles.centralDescription)}>Comparing branches across your repositories.</p>
        </div>
      ) : !selectedFile ? (
        <div className={`central-empty clean-state ${stylex.props(styles['central-empty']).className}`}>
          <div className={`empty-icon ${stylex.props(styles['empty-icon']).className}`}>
            <CheckCheck size={28} />
          </div>
          <h2 {...stylex.props(styles.centralTitle)}>
            {incompleteSnapshot
              ? 'This review is incomplete.'
              : approvedCount < pendingCount
                ? 'Choose a file to review'
                : pointerChangeCount
                  ? 'Review the submodule pointers above.'
                  : 'You’re all caught up.'}
          </h2>
          <p {...stylex.props(styles.centralDescription)}>
            {incompleteSnapshot
              ? 'Some repository changes could not be loaded. Check the notices and refresh to retry.'
              : approvedCount < pendingCount
                ? 'Select a changed file from the file tree.'
                : pointerChangeCount
                  ? 'This comparison changes repository pointers without changing regular files.'
                  : 'New changes will appear here automatically.'}
          </p>
          {showFilesButton}
        </div>
      ) : (
        <>
          <div className={`diff-toolbar ${stylex.props(styles['diff-toolbar']).className}`}>
            <div
              className={`diff-file-name ${stylex.props(styles['diff-file-name']).className}`}
              title={`${fileLocation(selectedFile)} · ${selectedFile.source === 'working-tree' ? 'Working tree' : 'Committed'} · +${selectedFile.additions} −${selectedFile.deletions}`}
            >
              <FileCode2 size={14} {...stylex.props(styles.diffFileIcon)} />
              <span title={fileLocation(selectedFile)} {...stylex.props(styles.diffFilePath)}>
                {fileLocation(selectedFile)}
              </span>
              <span
                className={`file-status file-status-${selectedFile.status.toLowerCase()} ${stylex.props(styles['file-status'], selectedFile.status === 'A' && styles['file-status-a'], selectedFile.status === 'D' && styles['file-status-d']).className}`}
              >
                {
                  { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', T: 'Type changed' }[
                    selectedFile.status
                  ]
                }
              </span>
            </div>
            <div className={`diff-toolbar-actions ${stylex.props(styles['diff-toolbar-actions']).className}`}>
              <div
                className={`diff-style-switch ${stylex.props(styles['diff-style-switch']).className}`}
                role="group"
                aria-label="Diff layout"
              >
                <button
                  className={`${diffStyle === 'split' ? 'active' : ''} ${stylex.props(styles.diffStyleButton, diffStyle === 'split' && styles.selectedDiffStyle).className}`}
                  aria-pressed={diffStyle === 'split'}
                  onClick={() => onDiffStyleChange('split')}
                >
                  Split
                </button>
                <button
                  className={`${diffStyle === 'unified' ? 'active' : ''} ${stylex.props(styles.diffStyleButton, diffStyle === 'unified' && styles.selectedDiffStyle).className}`}
                  aria-pressed={diffStyle === 'unified'}
                  onClick={() => onDiffStyleChange('unified')}
                >
                  Unified
                </button>
              </div>
              <span className={`toolbar-separator ${stylex.props(styles['toolbar-separator']).className}`} />
              <button
                className={`reviewed-button ${approved ? 'approved' : ''} ${stylex.props(styles['reviewed-button'], approved && styles['reviewed-button.approved']).className}`}
                disabled={approvalBusy || !!historicalState || !!selectedFile.unavailable}
                onClick={onToggleApproval}
                aria-pressed={approved}
                title={
                  approved ? 'Mark this file as unreviewed' : 'Mark this version of the file as reviewed'
                }
              >
                {approvalBusy ? (
                  <Spinner size={14} />
                ) : approved ? (
                  <CircleCheck size={15} />
                ) : (
                  <Circle size={15} />
                )}
                <span>{approved ? 'Reviewed' : 'Mark reviewed'}</span>
              </button>
            </div>
          </div>
          {historicalState && (
            <div
              className={`closed-review-notice historical-diff-note ${stylex.props(styles['closed-review-notice'], styles['historical-diff-note']).className}`}
              role="status"
            >
              <CircleCheck size={13} {...stylex.props(styles.closedReviewIcon)} />
              <span {...stylex.props(styles.closedReviewText)}>
                This PR was {historicalState}. These are its historical changes; no further review is needed
                for this repository.
              </span>
            </div>
          )}
          {!historicalState && staleApproval && (
            <div className={`changed-since-review ${stylex.props(styles['changed-since-review']).className}`}>
              <RefreshCw size={13} />
              This file changed since you reviewed it. Take another look.
            </div>
          )}
          <div className={`diff-content ${stylex.props(styles['diff-content']).className}`}>
            <DiffStack
              key={viewerProps.draftScope}
              {...stackProps}
              selectedFileId={selectedFile.id}
              viewerProps={viewerProps}
            />
          </div>
        </>
      )}
    </section>
  );
}

const styles = stylex.create({
  'diff-workspace': {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    minWidth: '0',
    minHeight: '0',
    backgroundColor: colors.canvas,
  },
  'central-empty': {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '9px',
    padding: '30px',
    textAlign: 'center',
    color: colors.textMuted,
  },
  'remote-loading-state': {
    justifyContent: 'flex-start',
    paddingTop: 'clamp(25px, 7vh, 80px)',
    overflow: 'auto',
  },
  'empty-icon': {
    display: 'grid',
    placeItems: 'center',
    width: '55px',
    height: '55px',
    marginBottom: spacing.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: '14px',
    backgroundColor: colors.interactive,
    color: colors.textSecondary,
  },
  'diff-toolbar': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '9px',
    minHeight: '34px',
    height: '34px',
    paddingBlock: '0',
    paddingInline: spacing.lg,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.panel,
  },
  'diff-file-name': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    minWidth: '0',
    color: colors.textSecondary,
  },
  'file-status': {
    paddingBlock: '1px',
    paddingInline: spacing.xs,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: radii.sm,
    color: colors.textMuted,
    fontSize: typeScale.micro,
    whiteSpace: 'nowrap',
    display: { default: null, '@media (max-width: 1050px)': 'none' },
  },
  'file-status-a': {
    borderColor: colors.successBorder,
    color: colors.successStrong,
  },
  'file-status-d': {
    borderColor: colors.dangerButton,
    color: colors.diffRemoved,
  },
  'diff-toolbar-actions': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    flexShrink: '0',
  },
  'diff-style-switch': {
    display: 'flex',
    alignItems: 'center',
    padding: '1px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hover,
    borderRadius: radii.md,
    backgroundColor: colors.panel,
  },
  'toolbar-separator': {
    width: '1px',
    height: '16px',
    backgroundColor: colors.hover,
    flexShrink: '0',
    marginBlock: '0',
    marginInline: '3px',
  },
  'reviewed-button': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBlock: spacing.xs,
    paddingInline: '0',
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: { default: colors.textSubtle, ':hover': colors.textDefault },
    fontSize: typeScale.small,
    opacity: { default: null, ':disabled': '.5' },
  },
  'reviewed-button.approved': {
    color: colors.textDefault,
  },
  'closed-review-notice': {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    paddingBlock: '7px',
    paddingInline: '13px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.successRaised,
    backgroundColor: colors.successSurface,
    color: colors.successText,
    fontSize: typeScale.compact,
  },
  'historical-diff-note': {
    fontSize: typeScale.small,
  },
  'changed-since-review': {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    paddingBlock: '7px',
    paddingInline: '13px',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.warningRaised,
    backgroundColor: colors.warningSurface,
    color: colors.warningStrong,
    fontSize: typeScale.small,
  },
  'diff-content': {
    flex: '1',
    minHeight: '0',
    overflow: 'hidden',
  },
  centralTitle: {
    marginTop: '7px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textDefault,
    fontSize: 19,
    fontWeight: 500,
    letterSpacing: '-.35px',
  },
  remoteLoadingTitle: { marginTop: 0 },
  centralDescription: {
    maxWidth: 320,
    margin: 0,
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
  },
  diffFileIcon: { color: colors.textMuted, flexShrink: 0 },
  diffFilePath: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: fonts.code,
    fontSize: typeScale.compact,
  },
  diffStyleButton: {
    paddingBlock: '3px',
    paddingInline: '7px',
    borderWidth: 0,
    borderRadius: 2,
    backgroundColor: 'transparent',
    color: colors.textQuiet,
    fontSize: typeScale.caption,
  },
  selectedDiffStyle: { backgroundColor: colors.hover, color: colors.textDefault },
  closedReviewIcon: { flexShrink: 0 },
  closedReviewText: { flex: '1', overflowWrap: 'anywhere' },
});
