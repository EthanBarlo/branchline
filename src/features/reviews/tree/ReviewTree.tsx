import { FileTree } from '@pierre/trees/react';
import * as stylex from '@stylexjs/stylex';
import { Check, CheckCheck, RotateCcw, Search, X } from 'lucide-react';
import { type CSSProperties } from 'react';
import { colors, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Spinner } from '../../../ui/Spinner';
import { selectedReviewFiles } from './reviewTreeSelection';

import { darkTreeTheme, lightTreeTheme } from './reviewTreeTheme';
import type { ReviewTreeProps } from './reviewTreeTypes';
import { TreeReviewMenu } from './TreeReviewMenu';
import { useReviewTreeModel } from './useReviewTreeModel';
export function ReviewTree(props: ReviewTreeProps) {
  const {
    model,
    visibleFiles,
    byPath,
    query,
    selectedFiles,
    selectedDirectory,
    busy,
    allReviewed,
    noneReviewed,
    error,
    setError,
    reviewFiles,
    onClickCapture,
  } = useReviewTreeModel(props);
  return (
    <div
      className={`review-file-tree review-file-tree-with-actions ${stylex.props(styles.fileTree).className}`}
      onClickCapture={onClickCapture}
    >
      {selectedFiles.length > 0 && (selectedFiles.length > 1 || selectedDirectory) && (
        <div
          className={`tree-selection-actions ${stylex.props(styles.selectionActions).className}`}
          role="group"
          aria-label="Selected file actions"
        >
          <span {...stylex.props(styles.selectionCount)} aria-live="polite">
            {selectedFiles.length} selected
          </span>
          <button
            {...stylex.props(styles.selectionButton)}
            type="button"
            aria-label="Mark selected files reviewed"
            title="Mark selected files reviewed"
            disabled={busy || allReviewed}
            onClick={() => void reviewFiles(selectedFiles, true)}
          >
            {busy ? <Spinner size={12} /> : <Check size={12} />}
            <span>Mark reviewed</span>
          </button>
          <button
            {...stylex.props(styles.selectionButton)}
            type="button"
            aria-label="Mark selected files unreviewed"
            title="Mark selected files unreviewed"
            disabled={busy || noneReviewed}
            onClick={() => void reviewFiles(selectedFiles, false)}
          >
            <RotateCcw size={12} />
          </button>
        </div>
      )}
      {error && (
        <div className={`tree-action-error ${stylex.props(styles.actionError).className}`} role="alert">
          <span {...stylex.props(styles.actionErrorText)}>{error}</span>
          <button
            {...stylex.props(styles.actionErrorDismiss)}
            type="button"
            aria-label="Dismiss file review error"
            onClick={() => setError('')}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {visibleFiles.length === 0 ? (
        <div className={`review-tree-empty ${stylex.props(styles.empty).className}`}>
          {props.loading && !query ? (
            <Spinner size={24} />
          ) : props.filter === 'unreviewed' && !query ? (
            <CheckCheck size={24} />
          ) : (
            <Search size={24} />
          )}
          <strong {...stylex.props(styles.emptyTitle)}>
            {props.loading && !query
              ? 'Loading files…'
              : props.filter === 'unreviewed' && !query
                ? 'All caught up'
                : 'No matching files'}
          </strong>
          <p {...stylex.props(styles.emptyDescription)}>
            {props.loading && !query
              ? 'More repositories are still being checked.'
              : props.filter === 'unreviewed' && !query
                ? Object.keys(props.historicalFiles || {}).length
                  ? 'No files need further review. Completed PR files remain under All files.'
                  : 'Every changed file has been reviewed.'
                : props.filter === 'commented' && !query
                  ? 'Files with open comments will appear here.'
                  : 'Try a different search or filter.'}
          </p>
        </div>
      ) : (
        <FileTree
          model={model}
          className={`review-tree-host ${stylex.props(styles.treeHost).className}`}
          style={
            {
              ...(props.theme === 'light' ? lightTreeTheme : darkTreeTheme),
              '--trees-font-family': 'var(--branchline-body-font)',
              '--trees-font-size': '12px',
            } as CSSProperties
          }
          aria-label="Changed files"
          renderContextMenu={(item, context) => {
            const paths = model.getSelectedPaths();
            const targetPaths = paths.includes(item.path) ? paths : [item.path];
            const targets = selectedReviewFiles(targetPaths, byPath).filter(
              (file) => !props.historicalFiles?.[file.id],
            );
            return (
              <TreeReviewMenu
                context={context}
                files={targets}
                includesDirectory={targetPaths.some((path) => path.endsWith('/'))}
                approvals={props.approvals}
                busy={busy}
                onReview={reviewFiles}
              />
            );
          }}
        />
      )}
    </div>
  );
}

const styles = stylex.create({
  fileTree: {
    display: 'flex',
    flexDirection: 'column',
    flex: '1',
    minHeight: 0,
    height: '100%',
    width: '100%',
    overflow: 'hidden',
  },
  treeHost: {
    display: 'block',
    flex: '1',
    minHeight: 0,
    width: '100%',
    height: 'auto',
  },
  empty: {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: 0,
    paddingBlock: '20px',
    paddingInline: spacing.xxl,
    boxSizing: 'border-box',
    textAlign: 'center',
    color: colors.textFaint,
  },
  emptyTitle: {
    marginTop: 14,
    fontSize: typeScale.body,
    fontWeight: 500,
    color: colors.textSecondary,
  },
  emptyDescription: {
    marginTop: '7px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    maxWidth: 190,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
    color: colors.textMuted,
  },
  selectionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minHeight: 31,
    paddingBlock: '3px',
    paddingInline: spacing.md,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.interactive,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.hover,
    backgroundColor: colors.surface,
    color: colors.textTertiary,
    fontSize: typeScale.small,
  },
  selectionCount: {
    marginRight: 'auto',
    whiteSpace: 'nowrap',
  },
  selectionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 23,
    paddingBlock: '3px',
    paddingInline: '5px',
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: {
      default: 'transparent',
      ':hover:not(:disabled)': colors.hover,
    },
    color: {
      default: colors.textDefault,
      ':hover:not(:disabled)': colors.textStrong,
    },
    font: 'inherit',
    whiteSpace: 'nowrap',
    opacity: { default: 1, ':disabled': 0.35 },
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': 1 },
  },
  actionError: {
    display: 'flex',
    gap: spacing.sm,
    paddingBlock: '7px',
    paddingInline: '9px',
    backgroundColor: colors.dangerSurface,
    color: colors.dangerText,
    fontSize: typeScale.small,
    lineHeight: 1.5,
  },
  actionErrorText: {
    flex: '1',
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  actionErrorDismiss: {
    alignSelf: 'flex-start',
    display: 'flex',
    borderWidth: 0,
    padding: spacing.xxs,
    backgroundColor: 'transparent',
    color: 'inherit',
  },
});
