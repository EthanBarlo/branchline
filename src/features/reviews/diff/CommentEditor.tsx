import * as stylex from '@stylexjs/stylex';
import { Check, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { CommentPublication } from '../../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { PublicationStatus } from '../../integrations/PublicationStatus';
import { CommentAutosave } from './commentAutosave';
import { type CommentPlacement } from './commentPlacement';

import { CommentContext } from './CommentContext';
import { lineLabel } from './commentLineLabel';
export function CommentEditor({
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
        <CommentContext
          label="Earlier version"
          reference={`${session.anchor.path} · ${lineLabel(session.anchor)}`}
        >
          {session.anchor.context || undefined}
        </CommentContext>
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

const styles = stylex.create({
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
