import * as stylex from '@stylexjs/stylex';
import { ArrowRight, CircleCheck, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Review, ReviewFile } from '../../../shared/types';
import { colors, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { IconButton } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { ReviewTree } from './tree/ReviewTree';

export type FileFilter = 'all' | 'unreviewed' | 'commented';

const clampWidth = (width: number) => Math.max(180, Math.min(520, window.innerWidth - 500, width));

const styles = stylex.create({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.borderSubtle,
    backgroundColor: colors.panel,
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    height: 32,
    minHeight: 32,
    paddingBlock: 0,
    paddingInline: 10,
  },
  headingTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    margin: 0,
    color: colors.textSecondary,
    fontSize: typeScale.small,
    fontWeight: 550,
  },
  headingCount: {
    minWidth: 16,
    paddingBlock: 1,
    paddingInline: 3,
    borderRadius: radii.sm,
    backgroundColor: colors.interactive,
    color: colors.textSubtle,
    textAlign: 'center',
    fontSize: typeScale.caption,
    fontWeight: 400,
  },
  filter: { maxWidth: 104, minWidth: 0 },
  filterTrigger: { fontSize: typeScale.small },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    height: 28,
    minHeight: 28,
    marginTop: 0,
    marginRight: spacing.md,
    marginBottom: spacing.md,
    marginLeft: spacing.md,
    paddingBlock: 0,
    paddingInline: spacing.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.textQuiet,
    borderColor: { default: colors.hover, ':focus-within': colors.textMuted },
  },
  searchInput: {
    width: '100%',
    minWidth: 0,
    height: '100%',
    padding: 0,
    borderWidth: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    fontSize: typeScale.small,
    '::placeholder': { color: colors.textQuiet },
  },
  searchClear: { padding: 1 },
  tree: { flex: '1', minHeight: 0, overflow: 'hidden', paddingTop: 1 },
  progress: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    height: 30,
    minHeight: 30,
    paddingTop: 0,
    paddingRight: 10,
    paddingBottom: spacing.xxs,
    paddingLeft: 10,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    color: colors.textMuted,
    fontSize: typeScale.small,
  },
  progressLabel: { display: 'flex', alignItems: 'center', gap: spacing.sm },
  progressNext: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 3,
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.borderSubtle },
    color: { default: colors.textSubtle, ':hover': colors.textDefault },
    borderRadius: radii.sm,
  },
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.hover,
    overflow: 'hidden',
  },
  progressFill: {
    display: 'block',
    height: '100%',
    backgroundColor: colors.textSecondary,
    transition: 'width 250ms',
  },
  resizer: {
    width: 6,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 6,
    marginBlock: 0,
    marginInline: -3,
    position: 'relative',
    zIndex: 5,
    cursor: 'col-resize',
    touchAction: 'none',
    outline: 'none',
    '::after': {
      content: "''",
      position: 'absolute',
      left: 2,
      width: 2,
      top: 0,
      bottom: 0,
      backgroundColor: {
        default: 'transparent',
        ':hover': colors.textEmphasis,
        ':focus-visible': colors.textEmphasis,
      },
      transition: 'background-color 120ms',
    },
  },
});

interface FileSidebarProps {
  viewKey: string;
  theme: 'light' | 'dark';
  review: Review;
  files: ReviewFile[];
  selectedFileId: string | null;
  visibleFileId?: string | null;
  historicalFiles: Record<string, string>;
  reviewedVersions: Record<string, string>;
  pendingCount: number;
  approvedCount: number;
  additions: number;
  deletions: number;
  filter: FileFilter;
  query: string;
  loading: boolean;
  approvalBusy: boolean;
  onFilterChange: (value: FileFilter) => void;
  onQueryChange: (value: string) => void;
  onSelectFile: (id: string) => void;
  onReviewFiles: (files: ReviewFile[], approved: boolean) => Promise<void>;
  onOrderChange: (ids: string[]) => void;
  onNextUnreviewed: () => void;
  onResizingChange: (resizing: boolean) => void;
}

export function FileSidebar({
  viewKey,
  theme,
  review,
  files,
  selectedFileId,
  visibleFileId,
  historicalFiles,
  reviewedVersions,
  pendingCount,
  approvedCount,
  additions,
  deletions,
  filter,
  query,
  loading,
  approvalBusy,
  onFilterChange,
  onQueryChange,
  onSelectFile,
  onReviewFiles,
  onOrderChange,
  onNextUnreviewed,
  onResizingChange,
}: FileSidebarProps) {
  const [width, setWidth] = useState(() =>
    clampWidth(Number(localStorage.getItem('branchline.filePaneWidth')) || 260),
  );
  const resizeOrigin = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const progress = pendingCount ? Math.round((approvedCount / pendingCount) * 100) : 0;

  useEffect(() => {
    const resize = () => setWidth((previous) => clampWidth(previous));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function finishResize() {
    resizeOrigin.current = null;
    onResizingChange(false);
    localStorage.setItem('branchline.filePaneWidth', String(width));
  }

  return (
    <>
      <aside
        className={`files-sidebar ${stylex.props(styles.sidebar).className}`}
        id="review-files"
        aria-label="Changed files"
        style={{ width, minWidth: width }}
      >
        <div className={`files-heading ${stylex.props(styles.heading).className}`}>
          <h2 {...stylex.props(styles.headingTitle)}>
            Files{' '}
            <span {...stylex.props(styles.headingCount)}>
              {filter === 'unreviewed' ? pendingCount - approvedCount : files.length}
            </span>
          </h2>
          <Select
            className={`file-filter-select ${stylex.props(styles.filter).className}`}
            variant="quiet"
            searchable={false}
            triggerStyle={styles.filterTrigger}
            label="Filter changed files"
            value={filter}
            onChange={(value) => onFilterChange(value as FileFilter)}
            options={[
              { value: 'all', label: 'All files' },
              { value: 'unreviewed', label: 'Unreviewed' },
              { value: 'commented', label: 'Commented' },
            ]}
          />
        </div>
        <label className={`file-search ${stylex.props(styles.search).className}`}>
          <Search size={13} />
          <input
            {...stylex.props(styles.searchInput)}
            aria-label="Filter files by path"
            placeholder="Find a file…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <IconButton
              className={stylex.props(styles.searchClear).className}
              aria-label="Clear file search"
              onClick={() => onQueryChange('')}
            >
              <X size={12} />
            </IconButton>
          )}
        </label>
        <div className={`tree-container ${stylex.props(styles.tree).className}`}>
          <ReviewTree
            key={viewKey}
            theme={theme}
            files={files}
            selectedFileId={selectedFileId}
            visibleFileId={visibleFileId}
            approvals={review.approvals}
            historicalFiles={historicalFiles}
            reviewedVersions={reviewedVersions}
            comments={review.comments}
            onSelect={onSelectFile}
            onReviewFiles={onReviewFiles}
            reviewBusy={approvalBusy}
            loading={loading}
            onOrderChange={onOrderChange}
            filter={filter}
            query={query}
          />
        </div>
        <div
          className={`compact-progress ${stylex.props(styles.progress).className}`}
          title={`${approvedCount} of ${pendingCount} files reviewed · +${additions} −${deletions}`}
        >
          <span {...stylex.props(styles.progressLabel)}>
            <CircleCheck size={12} />
            {approvedCount} / {pendingCount} reviewed
          </span>
          <IconButton
            className={stylex.props(styles.progressNext).className}
            onClick={onNextUnreviewed}
            disabled={approvedCount === pendingCount}
            aria-label="Next unreviewed file"
            title="Next unreviewed file"
          >
            <ArrowRight size={13} />
          </IconButton>
          <div className={`progress-track ${stylex.props(styles.progressTrack).className}`}>
            <span {...stylex.props(styles.progressFill)} style={{ width: `${progress}%` }} />
          </div>
        </div>
      </aside>
      <div
        className={`file-pane-resizer ${stylex.props(styles.resizer).className}`}
        role="separator"
        aria-label="Resize file pane"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={Math.min(520, window.innerWidth - 500)}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="Drag to resize · Arrow keys to adjust · Double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeOrigin.current = { pointerId: event.pointerId, x: event.clientX, width };
          onResizingChange(true);
        }}
        onPointerMove={(event) => {
          const origin = resizeOrigin.current;
          if (origin?.pointerId === event.pointerId)
            setWidth(clampWidth(origin.width + event.clientX - origin.x));
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={() => {
          if (resizeOrigin.current) finishResize();
        }}
        onDoubleClick={() => {
          setWidth(260);
          localStorage.setItem('branchline.filePaneWidth', '260');
        }}
        onKeyDown={(event) => {
          const next =
            event.key === 'ArrowLeft'
              ? width - 10
              : event.key === 'ArrowRight'
                ? width + 10
                : event.key === 'Home'
                  ? 180
                  : event.key === 'End'
                    ? 520
                    : null;
          if (next === null) return;
          event.preventDefault();
          const adjusted = clampWidth(next);
          setWidth(adjusted);
          localStorage.setItem('branchline.filePaneWidth', String(adjusted));
        }}
      />
    </>
  );
}
