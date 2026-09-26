import type {
  DiffFileInput,
  DiffLineAnnotation,
  FileContents,
  FileDiffOptions,
  SelectedLineRange,
} from '@pierre/diffs';
import { MultiFileDiff } from '@pierre/diffs/react';
import * as stylex from '@stylexjs/stylex';
import { Check, FileCode2, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CommentPublication } from '../../../shared/integrations';
import type { ReviewComment, ReviewFile } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { PublicationStatus } from '../integrations/PublicationStatus';
import {
  CommentAutosave,
  loadCommentBackups,
  type CommentAnchor,
  type CommentBackup,
} from './commentAutosave';
import {
  captureCommentContext,
  placeComments,
  type CommentPlacement,
  type PlacementSnapshot,
} from './commentPlacement';

interface DiffViewerProps {
  theme: 'light' | 'dark';
  file: ReviewFile;
  comments: ReviewComment[];
  diffStyle: 'split' | 'unified';
  draftScope: string;
  onAddComment: (selection: CommentAnchor, body: string, commentId: string) => Promise<void>;
  onUpdateComment: (id: string, changes: { body?: string; resolved?: boolean }) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
  isRemote?: boolean;
  allowNewComments?: boolean;
  publications?: Record<string, CommentPublication>;
  onBeginReanchor?: (id: string) => void;
  reanchorCommentId?: string | null;
  onReanchorSelection?: (anchor: CommentAnchor) => Promise<void>;
}

type Annotation = { session: CommentAutosave; placement: CommentPlacement; outdated: boolean };
const diffThemeBaseCSS =
  '--diffs-font-family: var(--branchline-code-font); --diffs-font-size: 12px; --diffs-line-height: 23px; --diffs-bg: var(--branchline-canvas); --diffs-fg: var(--branchline-text-default); --diffs-selection-number-fg: var(--branchline-text);';
const diffThemeCSS = {
  dark: `:host { ${diffThemeBaseCSS} --diffs-bg-addition-override: #213b2a; --diffs-bg-deletion-override: #3d2827; --diffs-modified-color-override: #b8b8b8; --diffs-selection-base: #b8b8b8; --diffs-bg-selection-override: #929292; --diffs-bg-selection-number-override: #777777; --diffs-bg-hover-override: #b8b8b8; }`,
  light: `:host { ${diffThemeBaseCSS} --diffs-bg-addition-override: #e6ffec; --diffs-bg-deletion-override: #ffebe9; --diffs-modified-color-override: #626262; --diffs-selection-base: #0969da; --diffs-bg-selection-override: #d8e8ff; --diffs-bg-selection-number-override: #bcd6ff; --diffs-bg-hover-override: var(--branchline-raised); }`,
};
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const anchorFromComment = (comment: ReviewComment): CommentAnchor => ({
  side: comment.side,
  lineStart: comment.lineStart,
  lineEnd: comment.lineEnd,
  context: comment.context,
  contextBefore: comment.contextBefore,
  contextAfter: comment.contextAfter,
  fingerprint: comment.fingerprint,
  path: comment.path,
});

const styles = stylex.create({
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
  comment: {
    boxSizing: 'border-box',
    marginTop: '6px',
    marginRight: '14px',
    marginBottom: '8px',
    marginLeft: '12px',
    minWidth: 0,
    maxWidth: 860,
    paddingTop: '7px',
    paddingRight: '9px',
    paddingBottom: '5px',
    paddingLeft: '9px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.hover,
    borderRadius: 5,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 1.65,
    textAlign: 'left',
    letterSpacing: 'normal',
  },
  topComment: {
    marginBlock: '6px',
    marginInline: '0',
  },
  editingComment: {
    borderColor: colors.textFaint,
    backgroundColor: colors.raised,
  },
  resolvedComment: {
    borderColor: colors.interactive,
    backgroundColor: colors.panel,
  },
  commentBody: {
    display: 'block',
    width: '100%',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 2,
    backgroundColor: 'transparent',
    color: colors.textDefault,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 1.65,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    cursor: 'text',
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': 2 },
  },
  resolvedCommentBody: { color: colors.textMuted },
  commentInput: {
    boxSizing: 'border-box',
    display: 'block',
    width: '100%',
    minWidth: 0,
    minHeight: 32,
    maxHeight: 220,
    margin: 0,
    paddingBlock: '5px',
    paddingInline: '7px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.highlight, ':focus': colors.textMuted },
    borderRadius: radii.sm,
    backgroundColor: colors.panel,
    color: colors.textPrimary,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: '20px',
    resize: 'none',
    overflowY: 'auto',
    outline: 'none',
    '::placeholder': { color: colors.textQuiet },
  },
  commentActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    minHeight: 23,
    paddingTop: 3,
  },
  commentActionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.xs,
    paddingBlock: '2px',
    paddingInline: '3px',
    borderWidth: 0,
    borderRadius: radii.sm,
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
    color: { default: colors.textSubtle, ':hover:not(:disabled)': colors.textDefault },
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    lineHeight: '14px',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.4 },
    outline: { default: 'none', ':focus-visible': `2px solid ${colors.focus}` },
    outlineOffset: { default: 0, ':focus-visible': 2 },
  },
  saveStatus: {
    marginRight: 'auto',
    color: colors.textFaint,
    fontSize: typeScale.caption,
  },
  saveError: { color: colors.dangerText },
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
  commentContext: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '4px',
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.caption,
  },
  commentContextSummary: { cursor: 'pointer' },
  originalReference: {
    marginTop: 6,
    color: colors.textMuted,
    overflowWrap: 'anywhere',
  },
  commentContextCode: {
    maxHeight: 180,
    overflow: 'auto',
    marginTop: '6px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    padding: 7,
    borderRadius: radii.sm,
    backgroundColor: colors.panel,
    color: colors.textEmphasis,
    fontFamily: fonts.code,
    fontSize: typeScale.compact,
    lineHeight: 1.6,
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
  publicationButton: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: 0,
    color: colors.textTertiary,
    fontSize: typeScale.caption,
  },
  'comment-publication-row': {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    marginTop: 3,
    marginRight: 0,
    marginBottom: 5,
    marginLeft: 0,
  },
});
function lineLabel(anchor: Pick<CommentAnchor, 'side' | 'lineStart' | 'lineEnd'>) {
  if (anchor.lineStart === 0) return 'file comment';
  return `line ${anchor.lineStart}${anchor.lineEnd === anchor.lineStart ? '' : `–${anchor.lineEnd}`}${anchor.side === 'deletions' ? ', original version' : ''}`;
}

function CommentEditor({
  session,
  outdated,
  placement,
  isRemote,
  publication,
  onBeginReanchor,
  inTopComments = false,
}: {
  session: CommentAutosave;
  outdated?: boolean;
  placement?: CommentPlacement;
  isRemote?: boolean;
  publication?: CommentPublication;
  onBeginReanchor?: (id: string) => void;
  inTopComments?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const container = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => session.mount(), [session]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input || !state.editing) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(220, Math.max(32, input.scrollHeight))}px`;
  }, [state.body, state.editing]);
  useLayoutEffect(() => {
    if (state.editing) textarea.current?.focus({ preventScroll: true });
  }, [state.editing, state.editVersion]);
  useEffect(() => {
    if (!state.editing) return;
    const clickAway = (event: PointerEvent) => {
      if (container.current && event.composedPath().includes(container.current)) return;
      void session.closeEditor().catch(() => {});
    };
    document.addEventListener('pointerdown', clickAway, true);
    return () => document.removeEventListener('pointerdown', clickAway, true);
  }, [state.editing, session]);

  if (state.removed) return null;
  return (
    <article
      ref={container}
      data-comment-id={session.id}
      data-comment-side={placement?.side}
      data-comment-line={placement?.lineEnd}
      className={`review-comment compact-comment ${state.editing ? 'is-editing' : ''} ${state.resolved ? 'is-resolved' : ''} ${stylex.props(styles.comment, inTopComments && styles.topComment, state.editing && styles.editingComment, state.resolved && styles.resolvedComment).className}`}
      aria-label={`Comment, ${lineLabel(session.anchor)}`}
    >
      {outdated && (
        <details className={`review-comment-context ${stylex.props(styles.commentContext).className}`}>
          <summary {...stylex.props(styles.commentContextSummary)}>Earlier version</summary>
          <div
            className={`review-comment-original-reference ${stylex.props(styles.originalReference).className}`}
          >
            {session.anchor.path} · {lineLabel(session.anchor)}
          </div>
          {session.anchor.context && (
            <pre {...stylex.props(styles.commentContextCode)}>{session.anchor.context}</pre>
          )}
        </details>
      )}
      {state.editing ? (
        <textarea
          ref={textarea}
          {...stylex.props(styles.commentInput)}
          aria-label="Comment text"
          placeholder="Leave feedback…"
          rows={1}
          value={state.body}
          disabled={state.busy}
          onChange={(event) => session.change(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) {
              event.preventDefault();
              event.stopPropagation();
              void session.closeEditor().catch(() => {});
            }
          }}
        />
      ) : (
        <button
          className={`review-comment-body ${stylex.props(styles.commentBody, state.resolved && styles.resolvedCommentBody).className}`}
          type="button"
          aria-label="Edit comment"
          onClick={() => session.edit()}
        >
          {state.body}
        </button>
      )}
      <div className={`compact-comment-actions ${stylex.props(styles.commentActions).className}`}>
        <span
          className={`comment-save-status ${state.error ? 'has-error' : ''} ${stylex.props(styles.saveStatus, Boolean(state.error) && styles.saveError).className}`}
          role="status"
        >
          {state.error
            ? 'Not saved'
            : state.saving || session.hasUnsavedText()
              ? 'Saving…'
              : state.persisted
                ? 'Saved'
                : ''}
        </span>
        <button
          {...stylex.props(styles.commentActionButton)}
          type="button"
          aria-label="Delete comment"
          disabled={state.busy}
          onClick={() => void session.delete().catch(() => {})}
        >
          <Trash2 size={12} />
          Delete
        </button>
        <button
          {...stylex.props(styles.commentActionButton)}
          type="button"
          aria-label={state.resolved ? 'Reopen comment' : 'Resolve comment'}
          disabled={state.busy || (!state.persisted && !state.body.trim())}
          onClick={() => void session.resolve().catch(() => {})}
        >
          {state.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
          {state.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      {state.error && (
        <p className={`review-component-error ${stylex.props(styles.componentError).className}`} role="alert">
          {state.error}
        </p>
      )}
      {isRemote && (
        <div
          className={`comment-publication-row ${stylex.props(styles['comment-publication-row']).className}`}
        >
          <PublicationStatus
            publication={publication}
            comment={{ body: state.body, resolved: state.resolved }}
          />
          {outdated &&
            !publication?.remoteId &&
            publication?.state !== 'unknown' &&
            publication?.state !== 'sending' && (
              <button
                type="button"
                {...stylex.props(styles.publicationButton)}
                disabled={state.busy}
                onClick={() => onBeginReanchor?.(session.id)}
              >
                Choose current lines…
              </button>
            )}
        </div>
      )}
    </article>
  );
}

export function DiffViewer({
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
  const alive = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const selectionVersion = useRef(0);
  const [error, setError] = useState('');
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const placementSnapshot = useRef<PlacementSnapshot | undefined>(undefined);
  function makeSession(id: string, anchor: CommentAnchor, comment?: ReviewComment, backup?: CommentBackup) {
    return new CommentAutosave({
      id,
      scope: draftScope,
      fileId: file.id,
      anchor,
      comment,
      backup,
      callbacks: {
        add: onAddComment,
        update: onUpdateComment,
        delete: onDeleteComment,
        removed: (removedId) => {
          if (!alive.current) return;
          setSessions((previous) => {
            if (!previous.has(removedId)) return previous;
            const next = new Map(previous);
            next.delete(removedId);
            sessionsRef.current = next;
            return next;
          });
        },
      },
    });
  }
  const [sessions, setSessions] = useState<Map<string, CommentAutosave>>(() => {
    const backups = new Map(loadCommentBackups(draftScope, file.id).map((backup) => [backup.id, backup]));
    const initial = new Map<string, CommentAutosave>();
    for (const comment of comments) {
      const backup = backups.get(comment.id);
      initial.set(
        comment.id,
        makeSession(comment.id, backup?.anchor || anchorFromComment(comment), comment, backup),
      );
      backups.delete(comment.id);
    }
    for (const backup of backups.values())
      initial.set(backup.id, makeSession(backup.id, backup.anchor, undefined, backup));
    return initial;
  });
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const previousCommentIds = useRef(new Set(comments.map((comment) => comment.id)));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      selectionVersion.current++;
    };
  }, []);
  useEffect(() => {
    const next = new Map(sessionsRef.current);
    const ids = new Set(comments.map((comment) => comment.id));
    for (const comment of comments) {
      const existing = next.get(comment.id);
      if (existing) existing.sync(comment);
      else next.set(comment.id, makeSession(comment.id, anchorFromComment(comment), comment));
    }
    for (const id of previousCommentIds.current) {
      if (ids.has(id)) continue;
      const session = next.get(id);
      session?.externallyRemoved();
      if (session?.getSnapshot().removed) next.delete(id);
    }
    previousCommentIds.current = ids;
    sessionsRef.current = next;
    setSessions(next);
  }, [comments]);

  const allSessions = useMemo(
    () => [...sessions.values()].filter((session) => !session.getSnapshot().removed),
    [sessions],
  );
  const placements = useMemo(() => {
    const next = placeComments(allSessions, file, placementSnapshot.current);
    placementSnapshot.current = next;
    return next.positions;
  }, [allSessions, file]);
  const hasTextDiff =
    !file.unavailable &&
    !file.binary &&
    !file.tooLarge &&
    (file.oldContent ?? '') !== (file.newContent ?? '');
  const annotations = useMemo<DiffLineAnnotation<Annotation>[]>(
    () =>
      hasTextDiff
        ? allSessions.flatMap((session) => {
            const placement = placements.get(session.id);
            return placement
              ? [
                  {
                    lineNumber: placement.lineEnd,
                    side: placement.side,
                    metadata: {
                      session,
                      placement,
                      outdated: session.anchor.fingerprint !== file.fingerprint,
                    },
                  },
                ]
              : [];
          })
        : [],
    [allSessions, placements, file.fingerprint, hasTextDiff],
  );
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<string>>(() => new Set());
  const trackVisibleComments = useCallback<
    NonNullable<FileDiffOptions<Annotation, undefined>['onPostRender']>
  >((node, instance, phase) => {
    if (phase === 'unmount' || !node.shadowRoot) return;
    // Use the renderer's actual slots so old-side comments and manually expanded
    // context stay accurate without changing either the diff or saved anchors.
    const slots = new Set(
      [...node.shadowRoot.querySelectorAll('slot[name]')].map((slot) => slot.getAttribute('name')),
    );
    const hidden = new Set(
      annotationsRef.current
        .filter((annotation) => !slots.has(instance.getAnnotationSlotName(annotation)))
        .map((annotation) => annotation.metadata.session.id),
    );
    setCollapsedCommentIds((previous) =>
      previous.size === hidden.size && [...hidden].every((id) => previous.has(id)) ? previous : hidden,
    );
  }, []);
  const collapsedComments = annotations.filter((annotation) =>
    collapsedCommentIds.has(annotation.metadata.session.id),
  );
  const topComments = allSessions.filter((session) => !hasTextDiff || !placements.get(session.id));
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

  async function beginComment(anchor: CommentAnchor) {
    if (!allowNewComments) return;
    if (file.unavailable) {
      setError('This file could not be loaded. Refresh it before commenting.');
      return;
    }
    const version = ++selectionVersion.current;
    if (reanchorCommentId && onReanchorSelection) {
      try {
        await onReanchorSelection(anchor);
      } catch (cause) {
        if (alive.current) setError(errorMessage(cause));
      }
      return;
    }
    const existing = [...sessionsRef.current.values()].find(
      (session) =>
        session.getSnapshot().editing &&
        session.anchor.fingerprint === anchor.fingerprint &&
        session.anchor.side === anchor.side &&
        session.anchor.lineStart === anchor.lineStart &&
        session.anchor.lineEnd === anchor.lineEnd,
    );
    if (existing) {
      existing.edit();
      return;
    }
    try {
      await Promise.all([...sessionsRef.current.values()].map((session) => session.closeEditor()));
      if (!alive.current || version !== selectionVersion.current) return;
      const id = crypto.randomUUID();
      const session = makeSession(id, anchor);
      const next = new Map(sessionsRef.current);
      next.set(id, session);
      sessionsRef.current = next;
      setSessions(next);
      setSelectedLines(
        anchor.lineStart ? { start: anchor.lineStart, end: anchor.lineEnd, side: anchor.side } : null,
      );
      setError('');
    } catch (cause) {
      if (alive.current) setError(errorMessage(cause));
    }
  }

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
    <div className={`review-diff-viewer ${stylex.props(styles.viewer).className}`} ref={scroller}>
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
                <details
                  className={`review-comment-context ${stylex.props(styles.commentContext).className}`}
                >
                  <summary {...stylex.props(styles.commentContextSummary)}>{lineLabel(placement)}</summary>
                  <pre {...stylex.props(styles.commentContextCode)}>
                    {lines.join('\n')}
                    {placement.lineEnd - placement.lineStart >= 8 ? '\n…' : ''}
                  </pre>
                </details>
                <CommentEditor
                  {...metadata}
                  isRemote={isRemote}
                  publication={publications?.[session.id]}
                  onBeginReanchor={onBeginReanchor}
                  inTopComments
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
          <MultiFileDiff<Annotation>
            {...files}
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
            className={`review-code-diff ${stylex.props(styles.codeDiff).className}`}
          />
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
