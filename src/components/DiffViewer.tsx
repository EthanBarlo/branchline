import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import type { DiffFileInput, DiffLineAnnotation, FileContents, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import { Check, FileCode2, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import type { ReviewComment, ReviewFile } from '../../shared/types';
import { CommentAutosave, loadCommentBackups, type CommentAnchor, type CommentBackup } from './commentAutosave';
import { captureCommentContext, placeComments, type CommentPlacement, type PlacementSnapshot } from './commentPlacement';
import './review-components.css';

interface DiffViewerProps {
  file: ReviewFile;
  comments: ReviewComment[];
  diffStyle: 'split' | 'unified';
  draftScope: string;
  onAddComment: (selection: CommentAnchor, body: string, commentId: string) => Promise<void>;
  onUpdateComment: (id: string, changes: { body?: string; resolved?: boolean }) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
}

type Annotation = { session: CommentAutosave; placement: CommentPlacement; outdated: boolean };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const anchorFromComment = (comment: ReviewComment): CommentAnchor => ({ side: comment.side, lineStart: comment.lineStart, lineEnd: comment.lineEnd, context: comment.context, contextBefore: comment.contextBefore, contextAfter: comment.contextAfter, fingerprint: comment.fingerprint, path: comment.path });
function lineLabel(anchor: CommentAnchor) {
  if (anchor.lineStart === 0) return 'file comment';
  return `line ${anchor.lineStart}${anchor.lineEnd === anchor.lineStart ? '' : `–${anchor.lineEnd}`}${anchor.side === 'deletions' ? ', original version' : ''}`;
}

function CommentEditor({ session, outdated, placement }: { session: CommentAutosave; outdated?: boolean; placement?: CommentPlacement }) {
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
  return <article ref={container} data-comment-id={session.id} data-comment-side={placement?.side} data-comment-line={placement?.lineEnd} className={`review-comment compact-comment ${state.editing ? 'is-editing' : ''} ${state.resolved ? 'is-resolved' : ''}`} aria-label={`Comment, ${lineLabel(session.anchor)}`}>
    {outdated && <details className="review-comment-context"><summary>Earlier version</summary><div className="review-comment-original-reference">{session.anchor.path} · {lineLabel(session.anchor)}</div>{session.anchor.context && <pre>{session.anchor.context}</pre>}</details>}
    {state.editing ? <textarea ref={textarea} aria-label="Comment text" placeholder="Leave feedback…" rows={1} value={state.body} disabled={state.busy} onChange={event => session.change(event.target.value)} onKeyDown={event => {
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); void session.closeEditor().catch(() => {}); }
    }} /> : <button type="button" className="review-comment-body" aria-label="Edit comment" onClick={() => session.edit()}>{state.body}</button>}
    <div className="compact-comment-actions"><span className={`comment-save-status ${state.error ? 'has-error' : ''}`} role="status">{state.error ? 'Not saved' : state.saving || session.hasUnsavedText() ? 'Saving…' : state.persisted ? 'Saved' : ''}</span><button type="button" aria-label="Delete comment" disabled={state.busy} onClick={() => void session.delete().catch(() => {})}><Trash2 size={12} />Delete</button><button type="button" aria-label={state.resolved ? 'Reopen comment' : 'Resolve comment'} disabled={state.busy || (!state.persisted && !state.body.trim())} onClick={() => void session.resolve().catch(() => {})}>{state.resolved ? <RotateCcw size={12} /> : <Check size={12} />}{state.resolved ? 'Reopen' : 'Resolve'}</button></div>
    {state.error && <p className="review-component-error" role="alert">{state.error}</p>}
  </article>;
}

export function DiffViewer({ file, comments, diffStyle, draftScope, onAddComment, onUpdateComment, onDeleteComment }: DiffViewerProps) {
  const alive = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const selectionVersion = useRef(0);
  const [error, setError] = useState('');
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const placementSnapshot = useRef<PlacementSnapshot | undefined>(undefined);
  function makeSession(id: string, anchor: CommentAnchor, comment?: ReviewComment, backup?: CommentBackup) {
    return new CommentAutosave({ id, scope: draftScope, fileId: file.id, anchor, comment, backup, callbacks: {
      add: onAddComment, update: onUpdateComment, delete: onDeleteComment,
      removed: removedId => {
        if (!alive.current) return;
        setSessions(previous => {
          if (!previous.has(removedId)) return previous;
          const next = new Map(previous);
          next.delete(removedId);
          sessionsRef.current = next;
          return next;
        });
      },
    } });
  }
  const [sessions, setSessions] = useState<Map<string, CommentAutosave>>(() => {
    const backups = new Map(loadCommentBackups(draftScope, file.id).map(backup => [backup.id, backup]));
    const initial = new Map<string, CommentAutosave>();
    for (const comment of comments) {
      const backup = backups.get(comment.id);
      initial.set(comment.id, makeSession(comment.id, backup?.anchor || anchorFromComment(comment), comment, backup));
      backups.delete(comment.id);
    }
    for (const backup of backups.values()) initial.set(backup.id, makeSession(backup.id, backup.anchor, undefined, backup));
    return initial;
  });
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const previousCommentIds = useRef(new Set(comments.map(comment => comment.id)));

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; selectionVersion.current++; };
  }, []);
  useEffect(() => {
    const next = new Map(sessionsRef.current);
    const ids = new Set(comments.map(comment => comment.id));
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

  const allSessions = useMemo(() => [...sessions.values()].filter(session => !session.getSnapshot().removed), [sessions]);
  const placements = useMemo(() => {
    const next = placeComments(allSessions, file, placementSnapshot.current);
    placementSnapshot.current = next;
    return next.positions;
  }, [allSessions, file]);
  const hasTextDiff = !file.binary && !file.tooLarge && (file.oldContent ?? '') !== (file.newContent ?? '');
  const annotations = useMemo<DiffLineAnnotation<Annotation>[]>(() => hasTextDiff ? allSessions.flatMap(session => {
    const placement = placements.get(session.id);
    return placement ? [{ lineNumber: placement.lineEnd, side: placement.side, metadata: { session, placement, outdated: session.anchor.fingerprint !== file.fingerprint } }] : [];
  }) : [], [allSessions, placements, file.fingerprint, hasTextDiff]);
  const topComments = allSessions.filter(session => !hasTextDiff || !placements.get(session.id));
  const files = useMemo<DiffFileInput | null>(() => {
    const oldFile: FileContents | null = file.oldContent === null ? null : { name: file.oldPath ?? file.path, contents: file.oldContent, cacheKey: `${file.id}:${file.fingerprint}:old` };
    const newFile: FileContents | null = file.newContent === null ? null : { name: file.path, contents: file.newContent, cacheKey: `${file.id}:${file.fingerprint}:new` };
    if (newFile === null) return oldFile === null ? null : { oldFile, newFile: null };
    return { oldFile, newFile };
  }, [file.id, file.path, file.oldPath, file.oldContent, file.newContent, file.fingerprint]);

  async function beginComment(anchor: CommentAnchor) {
    const version = ++selectionVersion.current;
    const existing = [...sessionsRef.current.values()].find(session => session.getSnapshot().editing && session.anchor.fingerprint === anchor.fingerprint && session.anchor.side === anchor.side && session.anchor.lineStart === anchor.lineStart && session.anchor.lineEnd === anchor.lineEnd);
    if (existing) { existing.edit(); return; }
    try {
      await Promise.all([...sessionsRef.current.values()].map(session => session.closeEditor()));
      if (!alive.current || version !== selectionVersion.current) return;
      const id = crypto.randomUUID();
      const session = makeSession(id, anchor);
      const next = new Map(sessionsRef.current);
      next.set(id, session);
      sessionsRef.current = next;
      setSessions(next);
      setSelectedLines(anchor.lineStart ? { start: anchor.lineStart, end: anchor.lineEnd, side: anchor.side } : null);
      setError('');
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
  }

  const startComment = useCallback((range: SelectedLineRange | null) => {
    if (!range) return;
    const side = range.side ?? 'additions';
    if (range.endSide && range.endSide !== side) { setError('Select lines from one version of the file to add a comment.'); return; }
    const lineStart = Math.min(range.start, range.end);
    const lineEnd = Math.max(range.start, range.end);
    const content = side === 'deletions' ? file.oldContent : file.newContent;
    if (content === null || lineStart < 1) return;
    void beginComment({ side, lineStart, lineEnd, ...captureCommentContext(content, lineStart, lineEnd), fingerprint: file.fingerprint, path: side === 'deletions' ? file.oldPath ?? file.path : file.path });
  }, [file.oldContent, file.newContent, file.fingerprint, file.path, file.oldPath]);
  const options = useMemo<FileDiffOptions<Annotation, undefined>>(() => ({
    theme: 'pierre-dark', themeType: 'dark', diffStyle,
    diffIndicators: 'classic', disableFileHeader: true,
    hunkSeparators: 'line-info-basic', enableLineSelection: true,
    // Comments can land on unchanged lines after a refresh. Keep their code
    // visible instead of hiding the annotation inside collapsed context.
    expandUnchanged: annotations.length > 0,
    enableGutterUtility: true, lineHoverHighlight: 'both',
    onLineSelected: startComment, onGutterUtilityClick: startComment, overflow: 'scroll',
    unsafeCSS: ':host { --diffs-font-family: Menlo, Consolas, monospace; --diffs-font-size: 12px; --diffs-line-height: 23px; --diffs-bg: #181818; --diffs-fg: #dcdcdc; --diffs-bg-addition-override: #213b2a; --diffs-bg-deletion-override: #3d2827; --diffs-modified-color-override: #b8b8b8; --diffs-selection-base: #b8b8b8; --diffs-selection-number-fg: #eeeeee; --diffs-bg-selection-override: #929292; --diffs-bg-selection-number-override: #777777; --diffs-bg-hover-override: #b8b8b8; }',
  }), [diffStyle, startComment, annotations.length]);

  return <div className="review-diff-viewer" ref={scroller}>
    {error && <div className="review-component-error review-diff-error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
    {topComments.length > 0 && <div className="review-top-comments" aria-label="File comments">{topComments.map(session => <CommentEditor key={session.id} session={session} outdated={session.anchor.fingerprint !== file.fingerprint} />)}</div>}
    {hasTextDiff && files ? <>
      <div className={`review-diff-columns ${diffStyle === 'unified' ? 'is-unified' : ''}`}><span>Original</span><span>Feature branch{file.source === 'working-tree' ? ' + local changes' : ''}</span></div>
      <MultiFileDiff<Annotation> {...files} options={options} lineAnnotations={annotations} selectedLines={selectedLines} renderAnnotation={annotation => <CommentEditor key={annotation.metadata.session.id} {...annotation.metadata} />} className="review-code-diff" />
    </> : <div className="review-file-notice">
      <FileCode2 size={30} strokeWidth={1.25} />
      <h3>{file.tooLarge ? 'This file is too large to preview' : file.binary ? 'Binary file changed' : file.status === 'R' ? 'File renamed' : file.oldMode !== file.newMode ? 'File permissions changed' : file.status === 'A' ? 'Empty file added' : file.status === 'D' ? 'Empty file deleted' : 'No text changes'}</h3>
      <p>{file.tooLarge ? 'You can still review the file in your editor and leave a file comment here.' : file.binary ? 'Review this file in its native application, then mark it reviewed or leave a file comment.' : file.status === 'R' ? `${file.oldPath ?? file.path} → ${file.path}` : file.oldMode && file.newMode && file.oldMode !== file.newMode ? `${file.oldMode} → ${file.newMode}` : 'There are no changed lines to display.'}</p>
      <button type="button" className="review-text-button" onClick={() => void beginComment({ side: file.status === 'D' ? 'deletions' : 'additions', lineStart: 0, lineEnd: 0, context: '', fingerprint: file.fingerprint, path: file.status === 'D' ? file.oldPath ?? file.path : file.path })}><MessageSquare size={14} />Add file comment</button>
    </div>}
  </div>;
}
