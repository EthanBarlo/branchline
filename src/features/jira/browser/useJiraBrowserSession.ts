import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { errorMessage } from '../../../lib/errorMessage';
import { flushPendingComments } from '../../reviews/diff/commentAutosave';

export type JiraBrowserDestination = 'close' | 'details';

type JiraBrowserSessionOptions = {
  reviewId: string;
  ticket: string | null;
  currentBranch?: string | null;
  onClose: () => void;
  onDetails: () => void;
  onTicketChanged: () => void;
};

export function useJiraBrowserSession({
  reviewId,
  ticket,
  currentBranch,
  onClose,
  onDetails,
  onTicketChanged,
}: JiraBrowserSessionOptions) {
  const surface = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onDetails, onTicketChanged });
  callbacks.current = { onClose, onDetails, onTicketChanged };
  const lifecycle = useRef<{
    close: (destination: JiraBrowserDestination) => Promise<void>;
    focus: () => void;
    prepareChange: () => Promise<boolean>;
  } | null>(null);
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

  function requestClose(destination: JiraBrowserDestination) {
    if (!changing.current) void lifecycle.current?.close(destination);
  }

  async function changeTicket(value: string | null) {
    if (changing.current) return;
    if (branchChanged.current) {
      requestClose('close');
      return;
    }
    const key = value === null ? null : value.trim().toUpperCase();
    if (key && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(key)) {
      setTicketError('Enter a Jira issue key such as APP-123.');
      return;
    }
    changing.current = true;
    setSaving(true);
    setTicketError('');
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
      setCurrentTicket(key || null);
      setTicketKey(key || '');
      callbacks.current.onTicketChanged();
      const link = await window.reviewAPI.getJiraTicketLink(reviewId);
      setCurrentTicket(link?.key || null);
      setTicketKey(link?.key || '');
    } catch (reason) {
      setTicketError(errorMessage(reason));
    } finally {
      checkingUnsavedEdits.current = false;
      changing.current = false;
      setSaving(false);
      if (detached) {
        if (branchChanged.current) callbacks.current.onClose();
        else setAttempt((value) => value + 1);
      }
    }
  }

  useEffect(() => {
    let disposed = false;
    let finished = false;
    let suspended = false;
    let viewerId: string | null = null;
    let destination: JiraBrowserDestination | null = null;
    let closingPromise: Promise<void> | null = null;
    let frame = 0;
    let previousBounds = '';
    const closedIds = new Set<string>();
    setReady(false);
    setClosing(false);
    setError('');
    setLoadingTicket(true);
    const finish = (next: JiraBrowserDestination) => {
      if (disposed || finished) return;
      finished = true;
      (next === 'details' ? callbacks.current.onDetails : callbacks.current.onClose)();
    };
    const bounds = () => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0)
        throw new Error('The Jira viewer is not visible. Close it and try again.');
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const updateBounds = () => {
      if (!viewerId || disposed || destination || suspended) return;
      try {
        const next = bounds();
        const signature = JSON.stringify(next);
        if (signature === previousBounds) return;
        previousBounds = signature;
        void window.reviewAPI.resizeJiraBrowser(viewerId, next).catch((reason) => {
          if (!disposed && !finished) setError(errorMessage(reason));
        });
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      }
    };
    const scheduleBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateBounds);
    };
    const unsubscribe = window.reviewAPI.onJiraBrowserClosed((id) => {
      closedIds.add(id);
      if (id === viewerId && !suspended) finish(destination || 'close');
    });
    const unsubscribeClear = window.reviewAPI.onJiraBrowserClearTicket((id) => {
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
        if (disposed) {
          await window.reviewAPI.closeJiraBrowser(id);
          return null;
        }
        if (closedIds.has(id)) {
          finish(destination || 'close');
          return null;
        }
        setReady(true);
        updateBounds();
        return id;
      } catch (reason) {
        if (!disposed && !finished) setError(errorMessage(reason));
        return null;
      } finally {
        if (!disposed) setLoadingTicket(false);
      }
    })();
    const close = (next: JiraBrowserDestination): Promise<void> => {
      if (closingPromise) return closingPromise;
      destination = next;
      setClosing(true);
      setError('');
      closingPromise = (async () => {
        try {
          const id = await opening;
          if (!id || closedIds.has(id) || (await window.reviewAPI.closeJiraBrowser(id))) finish(next);
        } catch (reason) {
          if (!disposed && !finished) setError(errorMessage(reason));
        } finally {
          closingPromise = null;
          destination = null;
          if (!disposed && !finished) {
            setClosing(false);
            scheduleBounds();
          }
        }
      })();
      return closingPromise;
    };
    lifecycle.current = {
      close,
      prepareChange: async () => {
        // Changing the link closes the website while keeping its modal open.
        suspended = true;
        try {
          const id = await opening;
          const closed = !id || closedIds.has(id) || (await window.reviewAPI.closeJiraBrowser(id));
          if (closed) setReady(false);
          else suspended = false;
          return closed;
        } catch (reason) {
          suspended = false;
          throw reason;
        }
      },
      focus: () => {
        if (!viewerId || disposed || finished || destination || suspended) return;
        void window.reviewAPI.focusJiraBrowser(viewerId).catch((reason) => {
          if (!disposed && !finished) setError(errorMessage(reason));
        });
      },
    };
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
      if (viewerId && !closedIds.has(viewerId) && !closingPromise)
        void window.reviewAPI.closeJiraBrowser(viewerId).catch(() => {});
    };
  }, [reviewId, attempt]);

  useLayoutEffect(() => {
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

  return {
    surface,
    ready,
    closing,
    error,
    currentTicket,
    ticketKey,
    saving,
    loadingTicket,
    ticketError,
    branchChanged: branchChanged.current,
    requestClose,
    changeTicket,
    retry: () => setAttempt((value) => value + 1),
    focus: () => lifecycle.current?.focus(),
    editTicketKey: (value: string) => {
      ticketEdited.current = true;
      setTicketKey(value);
      setTicketError('');
    },
  };
}
