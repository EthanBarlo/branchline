import type {
  DiffFileInput,
  FileContents,
  FileDiffMetadata,
  FileDiffOptions,
  SelectedLineRange,
} from '@pierre/diffs';
import { DEFAULT_VIRTUAL_FILE_METRICS } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import * as stylex from '@stylexjs/stylex';
import { FileCode2, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentPublication } from '../../../../shared/integrations';
import { colors, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { captureCommentContext } from './commentPlacement';

import { parseReviewDiff } from './diffParser';
import { Spinner } from '../../../ui/Spinner';
import { CommentEditor } from './CommentEditor';
import { useCommentSessions, type CommentSessionOptions } from './useCommentSessions';
import { useDiffAnnotations, type Annotation } from './useDiffAnnotations';
interface DiffViewerProps extends CommentSessionOptions {
  embedded?: boolean;
  active?: boolean;
  estimatedHeight?: number;
  theme: 'light' | 'dark';
  diffStyle: 'split' | 'unified';
  isRemote?: boolean;
  publications?: Record<string, CommentPublication>;
  onBeginReanchor?: (id: string) => void;
}

const diffThemeBaseCSS =
  '--diffs-font-family: var(--branchline-code-font); --diffs-font-size: 12px; --diffs-line-height: 23px; --diffs-bg: var(--branchline-canvas); --diffs-fg: var(--branchline-text-default); --diffs-selection-number-fg: var(--branchline-text);';
const diffMetrics = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: 23 };
const diffThemeCSS = {
  dark: `:host { ${diffThemeBaseCSS} --diffs-bg-addition-override: #213b2a; --diffs-bg-deletion-override: #3d2827; --diffs-modified-color-override: #b8b8b8; --diffs-selection-base: #b8b8b8; --diffs-bg-selection-override: #929292; --diffs-bg-selection-number-override: #777777; --diffs-bg-hover-override: #b8b8b8; }`,
  light: `:host { ${diffThemeBaseCSS} --diffs-bg-addition-override: #e6ffec; --diffs-bg-deletion-override: #ffebe9; --diffs-modified-color-override: #626262; --diffs-selection-base: #0969da; --diffs-bg-selection-override: #d8e8ff; --diffs-bg-selection-number-override: #bcd6ff; --diffs-bg-hover-override: var(--branchline-raised); }`,
};
export function DiffViewer({
  embedded = false,
  active = true,
  estimatedHeight = 115,
  theme,
  file,
  comments,
  diffStyle,
  draftScope,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  isRemote,
  allowNewComments = true,
  publications,
  onBeginReanchor,
  reanchorCommentId,
  onReanchorSelection,
}: DiffViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const { allSessions, error, setError, selectedLines, beginComment } = useCommentSessions({
    file,
    comments,
    draftScope,
    onAddComment,
    onUpdateComment,
    onDeleteComment,
    allowNewComments,
    reanchorCommentId,
    onReanchorSelection,
  });
  const hasTextDiff =
    !file.unavailable &&
    !file.binary &&
    !file.tooLarge &&
    (file.oldContent ?? '') !== (file.newContent ?? '');
  const files = useMemo<DiffFileInput | null>(() => {
    const oldFile: FileContents | null =
      file.oldContent === null
        ? null
        : {
            name: file.oldPath ?? file.path,
            contents: file.oldContent,
            cacheKey: `${file.id}:${file.fingerprint}:old`,
          };
    const newFile: FileContents | null =
      file.newContent === null
        ? null
        : { name: file.path, contents: file.newContent, cacheKey: `${file.id}:${file.fingerprint}:new` };
    if (newFile === null) return oldFile === null ? null : { oldFile, newFile: null };
    return { oldFile, newFile };
  }, [file.id, file.path, file.oldPath, file.oldContent, file.newContent, file.fingerprint]);

  const parseKey = `${file.id}:${file.fingerprint}`;
  const [parsed, setParsed] = useState<{ key: string; diff?: FileDiffMetadata; error?: string }>();
  useEffect(() => {
    if (!hasTextDiff || !files) return;
    let live = true;
    void parseReviewDiff(parseKey, files).then(
      (diff) => {
        if (live) setParsed({ key: parseKey, diff });
      },
      (error) => {
        if (live) setParsed({ key: parseKey, error: error.message });
      },
    );
    return () => {
      live = false;
    };
  }, [parseKey, files, hasTextDiff]);
  const parsedDiff = parsed?.key === parseKey ? parsed.diff : undefined;
  const { annotations, collapsedComments, collapsedCommentIds, topComments, trackVisibleComments } =
    useDiffAnnotations(file, allSessions, parsedDiff);

  const startComment = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !allowNewComments) return;
      const side = range.side ?? 'additions';
      if (range.endSide && range.endSide !== side) {
        setError('Select lines from one version of the file to add a comment.');
        return;
      }
      const lineStart = Math.min(range.start, range.end);
      const lineEnd = Math.max(range.start, range.end);
      const content = side === 'deletions' ? file.oldContent : file.newContent;
      if (content === null || lineStart < 1) return;
      void beginComment({
        side,
        lineStart,
        lineEnd,
        ...captureCommentContext(content, lineStart, lineEnd),
        fingerprint: file.fingerprint,
        path: side === 'deletions' ? (file.oldPath ?? file.path) : file.path,
      });
    },
    [
      file.oldContent,
      file.newContent,
      file.fingerprint,
      file.path,
      file.oldPath,
      reanchorCommentId,
      onReanchorSelection,
      allowNewComments,
    ],
  );
  const options = useMemo<FileDiffOptions<Annotation, undefined>>(
    () => ({
      theme: theme === 'light' ? 'pierre-light' : 'pierre-dark',
      themeType: theme,
      diffStyle,
      diffIndicators: 'classic',
      disableFileHeader: true,
      hunkSeparators: 'line-info-basic',
      enableLineSelection: allowNewComments,
      expandUnchanged: false,
      onPostRender: trackVisibleComments,
      enableGutterUtility: allowNewComments,
      lineHoverHighlight: 'both',
      onLineSelected: startComment,
      onGutterUtilityClick: startComment,
      overflow: 'scroll',
      unsafeCSS: diffThemeCSS[theme],
    }),
    [theme, diffStyle, startComment, trackVisibleComments, allowNewComments],
  );

  return (
    <div
      className={`review-file-diff ${!embedded ? 'review-diff-viewer' : ''} ${stylex.props(styles.viewer, embedded && styles.embedded).className}`}
      ref={scroller}
    >
      {error && (
        <div
          className={`review-component-error review-diff-error ${stylex.props(styles.componentError, styles.diffError).className}`}
          role="alert"
        >
          {error}
          <button
            {...stylex.props(styles.diffErrorDismiss)}
            type="button"
            aria-label="Dismiss error"
            onClick={() => setError('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {topComments.length > 0 && (
        <div
          className={`review-top-comments ${stylex.props(styles.topComments).className}`}
          aria-label="File comments"
        >
          {topComments.map((session) => (
            <CommentEditor
              key={session.id}
              session={session}
              outdated={session.anchor.fingerprint !== file.fingerprint}
              isRemote={isRemote}
              publication={publications?.[session.id]}
              onBeginReanchor={onBeginReanchor}
              inTopComments
            />
          ))}
        </div>
      )}
      {collapsedComments.length > 0 && (
        <section
          className={`review-top-comments review-collapsed-comments ${stylex.props(styles.topComments).className}`}
          aria-label="Comments on collapsed lines"
        >
          <h3 {...stylex.props(styles.collapsedTitle)}>Comments on collapsed lines</h3>
          {collapsedComments.map(({ metadata }, index) => {
            const { session, placement } = metadata;
            const content = placement.side === 'deletions' ? file.oldContent : file.newContent;
            const lines = (content ?? '')
              .split('\n')
              .slice(placement.lineStart - 1, Math.min(placement.lineEnd, placement.lineStart + 7));
            return (
              <div key={session.id} {...stylex.props(index > 0 && styles.laterCollapsedComment)}>
                <CommentEditor
                  {...metadata}
                  isRemote={isRemote}
                  publication={publications?.[session.id]}
                  onBeginReanchor={onBeginReanchor}
                  inTopComments
                  lineContext={`${lines.join('\n')}${placement.lineEnd - placement.lineStart >= 8 ? '\n…' : ''}`}
                />
              </div>
            );
          })}
        </section>
      )}
      {hasTextDiff && files ? (
        <>
          <div
            className={`review-diff-columns ${diffStyle === 'unified' ? 'is-unified' : ''} ${stylex.props(styles.columns, diffStyle === 'unified' && styles.unifiedColumns).className}`}
          >
            <span {...stylex.props(styles.column)}>Original</span>
            <span
              {...stylex.props(
                styles.column,
                styles.secondColumn,
                diffStyle === 'unified' && styles.unifiedSecondColumn,
              )}
            >
              Feature branch{file.source === 'working-tree' ? ' + local changes' : ''}
            </span>
          </div>
          {parsedDiff ? (
            <FileDiff<Annotation>
              fileDiff={parsedDiff}
              metrics={diffMetrics}
              options={options}
              lineAnnotations={annotations}
              selectedLines={selectedLines}
              renderAnnotation={(annotation) =>
                collapsedCommentIds.has(annotation.metadata.session.id) ? null : (
                  <CommentEditor
                    key={annotation.metadata.session.id}
                    {...annotation.metadata}
                    isRemote={isRemote}
                    publication={publications?.[annotation.metadata.session.id]}
                    onBeginReanchor={onBeginReanchor}
                  />
                )
              }
              className={`${active ? 'review-code-diff' : 'review-stack-code-diff'} ${stylex.props(styles.codeDiff).className}`}
            />
          ) : (
            <div {...stylex.props(styles.parsing)} style={{ minHeight: estimatedHeight }} role="status">
              {parsed?.key === parseKey && parsed.error ? (
                parsed.error
              ) : (
                <>
                  <Spinner size={16} /> Loading diff…
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className={`review-file-notice ${stylex.props(styles.fileNotice).className}`}>
          <FileCode2 size={30} strokeWidth={1.25} />
          <h3 {...stylex.props(styles.noticeTitle)}>
            {file.unavailable
              ? 'This file could not be loaded'
              : file.tooLarge
                ? 'This file is too large to preview'
                : file.binary
                  ? 'Binary file changed'
                  : file.status === 'R'
                    ? 'File renamed'
                    : file.oldMode !== file.newMode
                      ? 'File permissions changed'
                      : file.status === 'A'
                        ? 'Empty file added'
                        : file.status === 'D'
                          ? 'Empty file deleted'
                          : 'No text changes'}
          </h3>
          <p {...stylex.props(styles.noticeDescription)}>
            {file.unavailable
              ? file.unavailable
              : file.tooLarge
                ? 'You can still review the file in your editor and leave a file comment here.'
                : file.binary
                  ? 'Review this file in its native application, then mark it reviewed or leave a file comment.'
                  : file.status === 'R'
                    ? `${file.oldPath ?? file.path} → ${file.path}`
                    : file.oldMode && file.newMode && file.oldMode !== file.newMode
                      ? `${file.oldMode} → ${file.newMode}`
                      : 'There are no changed lines to display.'}
          </p>
          <button
            className={`review-text-button ${stylex.props(styles.textButton).className}`}
            type="button"
            disabled={!allowNewComments || !!file.unavailable}
            onClick={() =>
              void beginComment({
                side: file.status === 'D' ? 'deletions' : 'additions',
                lineStart: 0,
                lineEnd: 0,
                context: '',
                fingerprint: file.fingerprint,
                path: file.status === 'D' ? (file.oldPath ?? file.path) : file.path,
              })
            }
          >
            <MessageSquare size={14} />
            Add file comment
          </button>
        </div>
      )}
    </div>
  );
}
const styles = stylex.create({
  parsing: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 115,
    color: colors.textMuted,
    fontSize: typeScale.small,
  },
  embedded: { height: 'auto', overflow: 'visible', flex: 'none' },
  viewer: {
    height: '100%',
    flex: '1',
    minHeight: 0,
    minWidth: 0,
    overflow: 'auto',
    backgroundColor: colors.canvas,
    scrollbarGutter: 'stable',
  },
  columns: {
    position: 'sticky',
    top: 0,
    zIndex: 3,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    backgroundColor: colors.panel,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    color: colors.textMuted,
    fontSize: typeScale.small,
    lineHeight: '12px',
    fontWeight: 500,
    letterSpacing: '.03em',
  },
  unifiedColumns: {
    display: 'flex',
    justifyContent: 'space-between',
  },
  column: {
    paddingBlock: '5px',
    paddingInline: '14px',
  },
  secondColumn: {
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
  },
  unifiedSecondColumn: { borderLeftWidth: 0 },
  codeDiff: {
    display: 'block',
    minWidth: 0,
  },
  componentError: {
    marginTop: '5px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.dangerText,
    fontSize: typeScale.small,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  diffError: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingBlock: '9px',
    paddingInline: '14px',
    margin: 0,
    backgroundColor: colors.dangerSurface,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.dangerBorder,
  },
  diffErrorDismiss: {
    display: 'inline-flex',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  fileNotice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '60px',
    paddingRight: '28px',
    paddingBottom: '36px',
    paddingLeft: '28px',
    textAlign: 'center',
    color: colors.textQuiet,
  },
  noticeTitle: {
    marginTop: '15px',
    marginRight: '0',
    marginBottom: '8px',
    marginLeft: '0',
    color: colors.textDefault,
    fontSize: 16,
    fontWeight: 500,
  },
  noticeDescription: {
    maxWidth: 410,
    marginTop: '0',
    marginRight: '0',
    marginBottom: '18px',
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.body,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
  },
  textButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingBlock: spacing.sm,
    paddingInline: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.highlight,
    borderRadius: radii.md,
    backgroundColor: { default: colors.raised, ':hover': colors.hover },
    color: colors.textDefault,
    fontFamily: 'inherit',
    fontSize: typeScale.compact,
    lineHeight: 1.4,
    cursor: 'pointer',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': 2 },
  },
  topComments: {
    paddingBlock: spacing.sm,
    paddingInline: spacing.lg,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.interactive,
  },
  collapsedTitle: {
    marginTop: '5px',
    marginRight: '0',
    marginBottom: '9px',
    marginLeft: '0',
    color: colors.textSubtle,
    fontSize: typeScale.compact,
    fontWeight: 500,
  },
  laterCollapsedComment: { marginTop: 12 },
});
