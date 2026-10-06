import { Virtualizer } from '@pierre/diffs/react';
import * as stylex from '@stylexjs/stylex';
import { ChevronDown, ChevronRight, Circle, CircleCheck, FileCode2 } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { Review, ReviewFile } from '../../../../shared/types';
import { colors, fonts, spacing, typeScale } from '../../../theme/tokens.stylex';
import { errorMessage } from '../../../lib/errorMessage';
import { fileLocation } from '../fileLocation';
import type { ReviewActions } from '../session/useReviewActions';
import { isApproved } from '../session/reviewSession';
import { orderReviewFiles } from '../tree/reviewFileOrder';
import { flushPendingComments } from './commentAutosave';
import { DiffViewer } from './DiffViewer';
import { useVisibleDiffFile } from './useVisibleDiffFile';

interface DiffStackProps {
  files: ReviewFile[];
  review: Review;
  selectedFileId: string;
  historicalFiles: Record<string, string>;
  viewerProps: ComponentProps<typeof DiffViewer>;
  actions: Pick<ReviewActions, 'addCommentForFile' | 'reviewFiles' | 'selectFile'>;
  approvalBusy: boolean;
  anchorRevision: number;
  navigationRevision: number;
  onVisibleFileChange: (fileId: string) => void;
  onError: (message: string) => void;
}

export function DiffStack(props: DiffStackProps) {
  const ordered = useMemo(() => orderReviewFiles(props.files), [props.files]);
  const root = useRef<HTMLDivElement>(null);
  const fileIds = useMemo(() => ordered.map((file) => file.id), [ordered]);
  useVisibleDiffFile(root, fileIds, props.onVisibleFileChange);
  const comments = useMemo(() => {
    const grouped = new Map<string, Review['comments']>();
    for (const comment of props.review.comments) {
      const list = grouped.get(comment.fileId) ?? [];
      list.push(comment);
      grouped.set(comment.fileId, list);
    }
    return grouped;
  }, [props.review.comments]);
  return (
    <div ref={root} {...stylex.props(styles.root)}>
      <Virtualizer
        className={`review-diff-viewer review-diff-stack ${stylex.props(styles.scroller).className}`}
      >
        {ordered.map((file) => (
          <DiffAccordion
            key={file.id}
            {...props}
            file={file}
            comments={comments.get(file.id) ?? emptyComments}
          />
        ))}
      </Virtualizer>
    </div>
  );
}
const emptyComments: Review['comments'] = [];

const DiffAccordion = memo(function DiffAccordion({
  file,
  comments,
  ...props
}: DiffStackProps & {
  file: ReviewFile;
  comments: Review['comments'];
}) {
  const id = useId();
  const selected = file.id === props.selectedFileId;
  const [expanded, setExpanded] = useState(true);
  const [loaded, setLoaded] = useState(selected);
  const container = useRef<HTMLElement>(null);
  const approved = isApproved(props.review, file);
  const historical = props.historicalFiles[file.id];
  const estimatedHeight = Math.min(300, Math.max(5, file.additions + file.deletions + 6)) * 23;
  useEffect(() => {
    if (selected) {
      setExpanded(true);
      setLoaded(true);
    }
  }, [selected, props.navigationRevision]);
  useEffect(() => {
    if (!selected || !expanded || !loaded) return;
    // Give the worker result and virtualizer a frame to install the body before
    // scrolling. Reopening the last file then reveals its code, too.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        container.current?.scrollIntoView({ block: 'start' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, expanded, loaded, props.navigationRevision]);
  useEffect(() => {
    if (loaded || !expanded || !container.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLoaded(true);
          observer.disconnect();
        }
      },
      { root: container.current.closest('.review-diff-stack'), rootMargin: '600px' },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [loaded, expanded]);
  async function toggle() {
    try {
      // A collapsed editor must finish saving before its DOM disappears.
      if (expanded) await flushPendingComments();
      setExpanded(!expanded);
    } catch (error) {
      props.onError(errorMessage(error));
    }
  }
  return (
    <section
      ref={container}
      className={`review-diff-accordion ${stylex.props(styles.file).className}`}
      data-active-diff={selected || undefined}
      data-file-id={file.id}
    >
      <div
        className={`review-file-header ${stylex.props(styles.header, selected && styles.selectedHeader).className}`}
        data-file-id={file.id}
      >
        <button
          type="button"
          className={`review-file-toggle ${stylex.props(styles.toggle).className}`}
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${fileLocation(file)}`}
          onClick={() => void toggle()}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          type="button"
          onClick={() => void props.actions.selectFile(file.id)}
          title={fileLocation(file)}
          {...stylex.props(styles.name)}
        >
          <FileCode2 size={14} />
          <span {...stylex.props(styles.path)}>{fileLocation(file)}</span>
        </button>
        <span {...stylex.props(styles.status)}>{historical || file.status}</span>
        <span {...stylex.props(styles.added)}>+{file.additions}</span>
        <span {...stylex.props(styles.deleted)}>−{file.deletions}</span>
        <button
          type="button"
          aria-label={`Mark ${fileLocation(file)} ${approved ? 'unreviewed' : 'reviewed'}`}
          aria-pressed={approved}
          disabled={props.approvalBusy || !!historical || !!file.unavailable}
          onClick={() => void props.actions.reviewFiles([file], !approved).catch(() => {})}
          {...stylex.props(styles.approval, approved && styles.approved)}
        >
          {approved ? <CircleCheck size={15} /> : <Circle size={15} />}
          {approved ? 'Reviewed' : 'Mark reviewed'}
        </button>
      </div>
      {expanded && (
        <div id={id}>
          {loaded ? (
            <DiffViewer
              key={`${props.viewerProps.draftScope}:${file.id}:${selected ? props.anchorRevision : 0}`}
              {...props.viewerProps}
              embedded
              active={selected}
              estimatedHeight={estimatedHeight}
              file={file}
              comments={comments}
              allowNewComments={!historical}
              reanchorCommentId={selected ? props.viewerProps.reanchorCommentId : null}
              onAddComment={(selection, body, commentId) =>
                props.actions.addCommentForFile(file, selection, body, commentId)
              }
            />
          ) : (
            <div
              {...stylex.props(styles.placeholder)}
              style={{ height: estimatedHeight }}
              aria-label={`Loading ${fileLocation(file)}`}
            />
          )}
        </div>
      )}
    </section>
  );
});

const styles = stylex.create({
  root: { height: '100%', minHeight: 0 },
  scroller: {
    height: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarGutter: 'stable',
    overflowAnchor: 'none',
  },
  file: {
    minWidth: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 4,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 38,
    paddingInline: spacing.md,
    backgroundColor: colors.panel,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
  },
  selectedHeader: { backgroundColor: colors.interactive },
  toggle: {
    display: 'inline-flex',
    padding: spacing.xs,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.textMuted,
    cursor: 'pointer',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
  },
  name: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    flex: '1',
    minWidth: 0,
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    color: colors.textSecondary,
    textAlign: 'left',
    cursor: 'pointer',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
  },
  path: {
    fontFamily: fonts.code,
    fontSize: typeScale.compact,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  status: { color: colors.textMuted, fontSize: typeScale.small },
  added: { color: colors.successStrong, fontSize: typeScale.small },
  deleted: { color: colors.diffRemoved, fontSize: typeScale.small },
  approval: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 0,
    padding: spacing.xs,
    backgroundColor: 'transparent',
    color: colors.textMuted,
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    opacity: { default: 1, ':disabled': 0.5 },
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
  },
  approved: { color: colors.successStrong },
  placeholder: { backgroundColor: colors.canvas },
});
