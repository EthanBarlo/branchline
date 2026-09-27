import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import type { ResolvedTheme } from '../../theme';
import { DiffWorkspace } from './DiffWorkspace';
import { FeedbackPanel } from './FeedbackPanel';
import { FileSidebar } from './FileSidebar';
import type { ReviewActions } from './useReviewActions';
import type { ReviewData } from './useReviewData';
import type { ReviewView } from './useReviewView';
import type { useReviewViewPreferences } from './useReviewViewPreferences';

type ReviewWorkbenchProps = {
  view: ReviewView;
  actions: ReviewActions;
  data: ReviewData;
  preferences: ReturnType<typeof useReviewViewPreferences>;
  theme: ResolvedTheme;
  showFeedback: boolean;
  onCloseFeedback: () => void;
  onError: (message: string) => void;
  copyButton: ReactNode;
};

export function ReviewWorkbench({
  view,
  actions,
  data,
  preferences,
  theme,
  showFeedback,
  onCloseFeedback,
  onError,
  copyButton,
}: ReviewWorkbenchProps) {
  const {
    review,
    viewKey,
    remote,
    snapshot,
    remoteLoading,
    loadingRepositories,
    files,
    incompleteSnapshot,
    pointerChanges,
    historicalFiles,
    pendingReviewFiles,
    selectedFile,
    historicalFile,
    historicalState,
    fileComments,
    approvedCount,
    additions,
    deletions,
    approved,
    staleApproval,
  } = view;
  const {
    reanchorId,
    anchorRevision,
    approvalBusy,
    addComment,
    updateComment,
    removeComment,
    beginReanchor,
    reanchorSelection,
    reviewFiles,
    toggleApproval,
    selectFile,
    nextUnreviewed,
  } = actions;
  const {
    query,
    setQuery,
    filter,
    changeFilter,
    diffStyle,
    setDiffStyle,
    showFiles,
    toggleFiles,
    resizingFiles,
    setResizingFiles,
  } = preferences;
  const { knownApprovals, explorerOrder } = data;
  if (!review) return null;

  return (
    <div
      className={`review-workbench ${resizingFiles ? 'resizing-files' : ''} ${stylex.props(styles.workbench, resizingFiles && styles.resizing).className}`}
    >
      {showFiles && (
        <FileSidebar
          viewKey={viewKey}
          theme={theme}
          review={review}
          files={files}
          selectedFileId={selectedFile?.id ?? null}
          historicalFiles={historicalFiles}
          reviewedVersions={knownApprovals.current[viewKey] || {}}
          pendingCount={pendingReviewFiles.length}
          approvedCount={approvedCount}
          additions={additions}
          deletions={deletions}
          filter={filter}
          query={query}
          loading={remoteLoading}
          approvalBusy={approvalBusy}
          onFilterChange={changeFilter}
          onQueryChange={setQuery}
          onSelectFile={selectFile}
          onReviewFiles={reviewFiles}
          onOrderChange={(ids) => {
            explorerOrder.current[viewKey] = ids;
          }}
          onNextUnreviewed={nextUnreviewed}
          onResizingChange={setResizingFiles}
        />
      )}
      <DiffWorkspace
        selectedFile={selectedFile}
        snapshot={snapshot}
        remoteLoading={remoteLoading}
        loadingRepositories={loadingRepositories || undefined}
        approvedCount={approvedCount}
        pendingCount={pendingReviewFiles.length}
        pointerChangeCount={pointerChanges.length}
        incompleteSnapshot={incompleteSnapshot}
        showFiles={showFiles}
        onShowFiles={toggleFiles}
        historicalState={historicalFile ? historicalState : undefined}
        staleApproval={staleApproval}
        diffStyle={diffStyle}
        onDiffStyleChange={setDiffStyle}
        approved={approved}
        approvalBusy={approvalBusy}
        onToggleApproval={() => void toggleApproval()}
        viewerKey={`${viewKey}:${selectedFile?.id}:${anchorRevision}`}
        viewerProps={{
          theme: theme,
          draftScope: viewKey,
          file: selectedFile!,
          comments: fileComments,
          diffStyle,
          onAddComment: addComment,
          onUpdateComment: updateComment,
          onDeleteComment: removeComment,
          isRemote: !!review.remote,
          allowNewComments: !historicalFile,
          publications: remote?.publications,
          onBeginReanchor: beginReanchor,
          reanchorCommentId: reanchorId,
          onReanchorSelection: reanchorSelection,
        }}
      />
      {showFeedback && (
        <FeedbackPanel
          key={viewKey}
          review={review}
          files={files}
          onClose={onCloseFeedback}
          onSelect={selectFile}
          onUpdate={updateComment}
          onDelete={removeComment}
          onError={onError}
          copyButton={copyButton}
          remote={remote}
          onReanchor={beginReanchor}
        />
      )}
    </div>
  );
}

const styles = stylex.create({
  workbench: {
    position: 'relative',
    display: 'flex',
    flex: '1',
    minHeight: '0',
  },
  resizing: {},
});
