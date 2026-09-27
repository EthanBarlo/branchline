import type { SelectedLineRange } from '@pierre/diffs';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewComment, ReviewFile } from '../../../../shared/types';
import {
  CommentAutosave,
  loadCommentBackups,
  type CommentAnchor,
  type CommentBackup,
} from './commentAutosave';

export interface CommentSessionOptions {
  file: ReviewFile;
  comments: ReviewComment[];
  draftScope: string;
  onAddComment: (selection: CommentAnchor, body: string, commentId: string) => Promise<void>;
  onUpdateComment: (id: string, changes: { body?: string; resolved?: boolean }) => Promise<void>;
  onDeleteComment: (id: string) => Promise<void>;
  allowNewComments?: boolean;
  reanchorCommentId?: string | null;
  onReanchorSelection?: (anchor: CommentAnchor) => Promise<void>;
}
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

export function useCommentSessions({
  file,
  comments,
  draftScope,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  allowNewComments = true,
  reanchorCommentId,
  onReanchorSelection,
}: CommentSessionOptions) {
  const alive = useRef(true);
  const selectionVersion = useRef(0);
  const [error, setError] = useState('');
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
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

  return { allSessions, error, setError, selectedLines, beginComment };
}
