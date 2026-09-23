import { useEffect, useId, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { LoaderCircle, Ticket, TriangleAlert, X } from 'lucide-react';
import { JiraTicketSelect } from './JiraTicketSelect';
import { flushPendingComments } from './commentAutosave';

type Destination = 'close' | 'details';
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

/** The rectangle hosts isolated native views; no Jira markup enters this renderer. */
export function JiraBrowserDialog({ reviewId, ticket, currentBranch, onClose, onDetails, onTicketChanged }: {
  reviewId: string; ticket: string | null; currentBranch?: string | null; onClose: () => void; onDetails: () => void; onTicketChanged: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onDetails, onTicketChanged });
  callbacks.current = { onClose, onDetails, onTicketChanged };
  const lifecycle = useRef<{ close: (destination: Destination) => Promise<void>; focus: () => void; prepareChange: () => Promise<boolean> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [currentTicket, setCurrentTicket] = useState(ticket);
  const [ticketKey, setTicketKey] = useState(ticket || '');
  const [saving, setSaving] = useState(false);
  const [loadingTicket, setLoadingTicket] = useState(true);
  const ticketEdited = useRef(false);
  const [ticketError, setTicketError] = useState('');
  const changing = useRef(false);
  const checkingUnsavedEdits = useRef(false);
  const openedBranch = useRef(currentBranch);
  const lastBranch = useRef(currentBranch);
  const branchChanged = useRef(false);
  const closeForBranchChange = useRef(false);
  const ticketInputId = useId();

  function requestClose(destination: Destination) {
    if (!changing.current) void lifecycle.current?.close(destination);
  }

  async function changeTicket(value: string | null) {
    if (changing.current) return;
    if (branchChanged.current) { requestClose('close'); return; }
    const key = value === null ? null : value.trim().toUpperCase();
    if (key && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(key)) {
      setTicketError('Enter a Jira issue key such as APP-123.');
      return;
    }
    changing.current = true; setSaving(true); setTicketError('');
    let detached = false;
    try {
      checkingUnsavedEdits.current = true;
      const closed = await lifecycle.current?.prepareChange();
      checkingUnsavedEdits.current = false;
      if (!closed) return;
      detached = true;
      if (branchChanged.current) return;
      await window.reviewAPI.setReviewTicket(reviewId, key, openedBranch.current);
      ticketEdited.current = false;
      setCurrentTicket(key || null); setTicketKey(key || '');
      callbacks.current.onTicketChanged();
      const link = await window.reviewAPI.getJiraTicketLink(reviewId);
      setCurrentTicket(link?.key || null); setTicketKey(link?.key || '');
    } catch (reason) { setTicketError(message(reason)); }
    finally {
      checkingUnsavedEdits.current = false;
      changing.current = false; setSaving(false);
      if (detached) {
        if (branchChanged.current) callbacks.current.onClose();
        else setAttempt(value => value + 1);
      }
    }
  }

  useEffect(() => {
    let disposed = false;
    let finished = false;
    let suspended = false;
    let viewerId: string | null = null;
    let destination: Destination | null = null;
    let closingPromise: Promise<void> | null = null;
    let frame = 0;
    let previousBounds = '';
    const closedIds = new Set<string>();
    setReady(false); setClosing(false); setError(''); setLoadingTicket(true);
    const finish = (next: Destination) => {
      if (disposed || finished) return;
      finished = true;
      (next === 'details' ? callbacks.current.onDetails : callbacks.current.onClose)();
    };
    const bounds = () => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('The Jira viewer is not visible. Close it and try again.');
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const updateBounds = () => {
      if (!viewerId || disposed || destination || suspended) return;
      try {
        const next = bounds();
        const signature = JSON.stringify(next);
        if (signature === previousBounds) return;
        previousBounds = signature;
        void window.reviewAPI.resizeJiraBrowser(viewerId, next).catch(reason => {
          if (!disposed && !finished) setError(message(reason));
        });
      } catch (reason) { if (!disposed) setError(message(reason)); }
    };
    const scheduleBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateBounds);
    };
    const unsubscribe = window.reviewAPI.onJiraBrowserClosed(id => {
      closedIds.add(id);
      if (id === viewerId && !suspended) finish(destination || 'close');
    });
    const unsubscribeClear = window.reviewAPI.onJiraBrowserClearTicket(id => {
      if (id === viewerId && !disposed && !finished && !destination) void changeTicket(null);
    });
    const opening = (async () => {
      try {
        await flushPendingComments();
        if (disposed || destination) return null;
        const link = await window.reviewAPI.getJiraTicketLink(reviewId);
        if (disposed || destination) return null;
        // Expand the picker before measuring the rectangle for the native page.
        flushSync(() => {
          setCurrentTicket(link?.key || null);
          if (!ticketEdited.current) setTicketKey(link?.key || '');
        });
        if (!link) return null;
        const id = await window.reviewAPI.openJiraBrowser(reviewId, bounds());
        viewerId = id;
        if (disposed) { await window.reviewAPI.closeJiraBrowser(id); return null; }
        if (closedIds.has(id)) { finish(destination || 'close'); return null; }
        setReady(true);
        updateBounds();
        return id;
      } catch (reason) {
        if (!disposed && !finished) setError(message(reason));
        return null;
      } finally { if (!disposed) setLoadingTicket(false); }
    })();
    const close = (next: Destination): Promise<void> => {
      if (closingPromise) return closingPromise;
      destination = next;
      setClosing(true); setError('');
      closingPromise = (async () => {
        try {
          const id = await opening;
          if (!id || closedIds.has(id) || await window.reviewAPI.closeJiraBrowser(id)) finish(next);
        } catch (reason) {
          if (!disposed && !finished) setError(message(reason));
        } finally {
          closingPromise = null;
          destination = null;
          if (!disposed && !finished) { setClosing(false); scheduleBounds(); }
        }
      })();
      return closingPromise;
    };
    lifecycle.current = { close, prepareChange: async () => {
      // Changing the link closes the website while keeping its modal open.
      suspended = true;
      try {
        const id = await opening;
        const closed = !id || closedIds.has(id) || await window.reviewAPI.closeJiraBrowser(id);
        if (closed) setReady(false);
        else suspended = false;
        return closed;
      } catch (reason) { suspended = false; throw reason; }
    }, focus: () => {
      if (!viewerId || disposed || finished || destination || suspended) return;
      void window.reviewAPI.focusJiraBrowser(viewerId).catch(reason => {
        if (!disposed && !finished) setError(message(reason));
      });
    } };
    const observer = new ResizeObserver(scheduleBounds);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener('resize', scheduleBounds);
    window.visualViewport?.addEventListener('resize', scheduleBounds);
    return () => {
      disposed = true;
      lifecycle.current = null;
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleBounds);
      window.visualViewport?.removeEventListener('resize', scheduleBounds);
      unsubscribe();
      unsubscribeClear();
      if (viewerId && !closedIds.has(viewerId) && !closingPromise) void window.reviewAPI.closeJiraBrowser(viewerId).catch(() => {});
    };
  }, [reviewId, attempt]);

  useEffect(() => {
    const previous = lastBranch.current;
    lastBranch.current = currentBranch;
    if (previous !== currentBranch && previous !== undefined && currentBranch !== undefined) {
      branchChanged.current = true;
      closeForBranchChange.current = !checkingUnsavedEdits.current;
    }
    // A declined unsaved-edit prompt leaves this page open without prompting on every poll.
    if (closeForBranchChange.current && !saving) {
      closeForBranchChange.current = false;
      requestClose('close');
    }
  }, [currentBranch, saving]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const workspace = document.getElementById('root');
    const wasInert = workspace?.inert;
    if (workspace) workspace.inert = true;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); requestClose('close'); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])]
        .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      if (workspace) workspace.inert = wasInert || false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(<div className="modal-backdrop jira-browser-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) requestClose('close');
  }}>
    <div ref={dialog} className={`modal jira-browser-modal${currentTicket ? '' : ' jira-browser-picker'}`} role="dialog" aria-modal="true" aria-label={currentTicket ? `Jira ticket ${currentTicket}` : 'Choose a Jira ticket'} tabIndex={-1}>
      <div ref={surface} className="jira-browser-surface" role="group" aria-label="Jira page controls" tabIndex={ready && !closing && !saving ? 0 : -1} onFocus={event => {
        if (ready && event.target === event.currentTarget) lifecycle.current?.focus();
      }}>
        {currentTicket && !ready && <div className="jira-browser-placeholder" role={error ? 'alert' : 'status'}>
          {error ? <TriangleAlert size={20} /> : currentTicket || saving || loadingTicket ? <LoaderCircle size={20} className="spin" /> : <Ticket size={20} />}
          <span>{error || (saving ? 'Updating ticket…' : closing ? 'Closing Jira…' : loadingTicket ? 'Loading ticket…' : currentTicket ? `Opening ${currentTicket}…` : 'No ticket linked')}</span>
          {error && <div className="jira-browser-retry"><button type="button" className="button button-secondary" disabled={closing || saving} onClick={() => setAttempt(value => value + 1)}>Try again</button><button type="button" className="integration-link" disabled={closing || saving} onClick={() => void changeTicket(null)}>Clear ticket</button></div>}
        </div>}
      </div>
      {!currentTicket && <>
        <div className="modal-header">
          <div><span className="eyebrow">JIRA</span><h2>Choose a ticket</h2></div>
          <button type="button" className="icon-button" aria-label="Close ticket picker" disabled={closing || saving} onClick={() => requestClose('close')}><X size={17} /></button>
        </div>
        <div className="modal-body jira-picker-body">
          <p className="modal-introduction">Find a recent ticket or search by its key or title.</p>
          <form id={ticketInputId} className="jira-browser-ticket-form" onSubmit={event => { event.preventDefault(); void changeTicket(ticketKey); }}>
            <label htmlFor={`${ticketInputId}-key`}>Ticket</label>
            <JiraTicketSelect id={`${ticketInputId}-key`} reviewId={reviewId} value={ticketKey} disabled={closing || saving || loadingTicket} onChange={value => { ticketEdited.current = true; setTicketKey(value); setTicketError(''); }} onSelect={key => void changeTicket(key)} />
          </form>
          {error && <p className="jira-browser-error" role="alert"><TriangleAlert size={12} />{error}<button type="button" className="integration-link" disabled={closing || saving} onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
          {ticketError && <p className="jira-browser-error" role="alert"><TriangleAlert size={12} />{ticketError}</p>}
          {(saving || loadingTicket) && <p className="jira-picker-status" role="status"><LoaderCircle size={12} className="spin" />{saving ? 'Opening ticket…' : 'Loading ticket…'}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button button-secondary" disabled={closing || saving} onClick={() => requestClose('close')}>Cancel</button>
          <button type="submit" form={ticketInputId} className="button button-primary" disabled={closing || saving || loadingTicket || !ticketKey.trim()}>Use ticket</button>
        </div>
      </>}
      {currentTicket && <>
      <div className="jira-browser-footer">
        {branchChanged.current && <span className="jira-browser-error" role="status"><TriangleAlert size={12} />The checked-out branch changed. Close this ticket when you’ve finished editing.</span>}
        {ticketError && <span className="jira-browser-error" role="alert"><TriangleAlert size={12} />{ticketError}</span>}
        {ready && error && <span className="jira-browser-error" role="alert"><TriangleAlert size={12} />{error}</span>}
        {saving && <span className="jira-picker-status" role="status"><LoaderCircle size={12} className="spin" />Clearing ticket…</span>}
        <button type="button" className="integration-link jira-browser-details" disabled={closing || saving} onClick={() => requestClose('details')}><Ticket size={12} />Ticket details</button>
        <button type="button" className="button button-secondary" disabled={closing || saving} onClick={() => requestClose('close')}>{closing && <LoaderCircle size={12} className="spin" />}{closing ? 'Closing…' : 'Close'}</button>
      </div>
      </>}
    </div>
  </div>, document.body);
}
