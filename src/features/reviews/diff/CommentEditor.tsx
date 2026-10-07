import * as stylex from '@stylexjs/stylex';
import { Check, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CommentPublication } from '../../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { PublicationStatus } from '../../integrations/PublicationStatus';
import {
  CommentActionButton,
  CommentActions,
  commentCardProps,
  EarlierVersionBadge,
} from '../comments/CommentChrome';
import { ResolvedComment } from '../comments/ResolvedComment';
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
  lineContext,
}: {
  session: CommentAutosave;
  outdated?: boolean;
  placement?: CommentPlacement;
  isRemote?: boolean;
  publication?: CommentPublication;
  onBeginReanchor?: (id: string) => void;
  inTopComments?: boolean;
  /** Current code for comments shown away from their line. */
  lineContext?: string;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const container = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [showEarlier, setShowEarlier] = useState(false);
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
  const label = lineLabel(placement ?? session.anchor);
  const location = label.charAt(0).toUpperCase() + label.slice(1);
  const earlier = outdated && (
    <CommentContext reference={`${session.anchor.path} · ${lineLabel(session.anchor)}`}>
      {session.anchor.context || undefined}
    </CommentContext>
  );
  const publicationStatus = isRemote && (
    <PublicationStatus publication={publication} comment={{ body: state.body, resolved: state.resolved }} />
  );
  const dataAttributes = {
    'data-comment-id': session.id,
    'data-comment-side': placement?.side,
    'data-comment-line': placement?.lineEnd,
    'aria-label': `Comment, ${lineLabel(session.anchor)}`,
  };

  if (state.resolved && !state.editing) {
    return (
      <ResolvedComment
        {...dataAttributes}
        className="review-comment compact-comment is-resolved"
        variant={inTopComments ? 'block' : 'inline'}
        location={outdated ? `${location} · earlier version` : location}
        body={state.body}
        context={
          (lineContext || outdated) && (
            <>
              {lineContext && <CommentContext>{lineContext}</CommentContext>}
              {earlier}
            </>
          )
        }
        status={
          state.error ? (
            <span role="alert" {...stylex.props(styles.saveError)}>
              {state.error}
            </span>
          ) : (
            publicationStatus || undefined
          )
        }
        busy={state.busy}
        onReopen={() => void session.resolve().catch(() => {})}
        onDelete={() => void session.delete().catch(() => {})}
      />
    );
  }

  const saveStatus = state.error
    ? 'Not saved'
    : state.saving || session.hasUnsavedText()
      ? 'Saving…'
      : state.persisted
        ? 'Saved'
        : '';
  const canReanchor =
    isRemote &&
    outdated &&
    !publication?.remoteId &&
    publication?.state !== 'unknown' &&
    publication?.state !== 'sending';
  const meta: ReactNode[] = [];
  if (publicationStatus) meta.push(publicationStatus);
  if (canReanchor)
    meta.push(
      <button
        type="button"
        {...stylex.props(styles.publicationButton)}
        disabled={state.busy}
        onClick={() => onBeginReanchor?.(session.id)}
      >
        Choose current lines…
      </button>,
    );

  return (
    <article
      ref={container}
      {...dataAttributes}
      {...commentCardProps}
      className={`review-comment compact-comment ${state.editing ? 'is-editing' : ''} ${stylex.props(stylex.defaultMarker(), styles.comment, inTopComments && styles.topComment, outdated && styles.outdatedComment, state.editing && styles.editingComment).className}`}
    >
      <header {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.location)}>{location}</span>
        {outdated && (
          <EarlierVersionBadge expanded={showEarlier} onToggle={() => setShowEarlier((value) => !value)} />
        )}
        <CommentActions visible={state.editing}>
          <CommentActionButton
            aria-label="Resolve comment"
            title="Resolve"
            disabled={state.busy || (!state.persisted && !state.body.trim())}
            onClick={() => void session.resolve().catch(() => {})}
          >
            <Check size={13} />
          </CommentActionButton>
          <CommentActionButton
            aria-label="Delete comment"
            title="Delete"
            disabled={state.busy}
            onClick={() => void session.delete().catch(() => {})}
          >
            <Trash2 size={12} />
          </CommentActionButton>
        </CommentActions>
      </header>
      {lineContext && <CommentContext>{lineContext}</CommentContext>}
      {showEarlier && earlier}
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
          className={`review-comment-body ${stylex.props(styles.commentBody).className}`}
          type="button"
          aria-label="Edit comment"
          onClick={() => session.edit()}
        >
          {state.body}
        </button>
      )}
      <footer className={`comment-meta ${stylex.props(styles.meta).className}`}>
        <span
          className={`comment-save-status ${state.error ? 'has-error' : ''} ${stylex.props(styles.saveStatus, Boolean(state.error) && styles.saveError).className}`}
          role="status"
        >
          {saveStatus}
        </span>
        {meta.map((item, index) => (
          <span key={index} {...stylex.props(styles.metaItem)}>
            {(saveStatus || index > 0) && (
              <span aria-hidden {...stylex.props(styles.metaSeparator)}>
                ·
              </span>
            )}
            {item}
          </span>
        ))}
      </footer>
      {state.error && (
        <p className={`review-component-error ${stylex.props(styles.componentError).className}`} role="alert">
          {state.error}
        </p>
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
    paddingTop: '5px',
    paddingRight: '8px',
    paddingBottom: '5px',
    paddingLeft: '11px',
    borderWidth: '1px',
    borderLeftWidth: '2px',
    borderStyle: 'solid',
    borderColor: colors.interactive,
    borderLeftColor: colors.textFaint,
    borderRadius: 5,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontFamily: fonts.body,
    fontSize: typeScale.body,
    lineHeight: 1.65,
    textAlign: 'left',
    letterSpacing: 'normal',
    transition: 'border-color 120ms, background-color 120ms',
  },
  topComment: {
    marginBlock: '6px',
    marginInline: '0',
  },
  outdatedComment: {
    borderLeftColor: colors.warningBorder,
  },
  editingComment: {
    borderColor: colors.hover,
    borderLeftColor: colors.textMuted,
    backgroundColor: colors.raised,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 22,
  },
  location: {
    color: colors.textQuiet,
    fontSize: typeScale.caption,
    whiteSpace: 'nowrap',
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
  commentInput: {
    boxSizing: 'border-box',
    display: 'block',
    width: '100%',
    minWidth: 0,
    minHeight: 32,
    maxHeight: 220,
    marginTop: 2,
    marginInline: 0,
    marginBottom: 0,
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
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: 2,
    color: colors.textFaint,
    fontSize: typeScale.caption,
    lineHeight: '16px',
  },
  metaItem: { display: 'inline-flex', alignItems: 'center' },
  metaSeparator: { paddingInline: 6, color: colors.textFaint },
  saveStatus: {
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
    color: { default: colors.textTertiary, ':hover:not(:disabled)': colors.textDefault },
    fontFamily: fonts.body,
    fontSize: typeScale.caption,
    textDecorationLine: { default: 'none', ':hover': 'underline' },
    cursor: 'pointer',
  },
});
