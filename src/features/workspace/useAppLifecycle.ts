import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { UpdateAction, UpdateState } from '../../../shared/updates';
import { updatesBusy } from '../../../shared/updates';
import { errorMessage } from '../../lib/errorMessage';
import { flushPendingComments } from '../reviews/diff/commentAutosave';

export function useAppLifecycle(onError: (message: string) => void) {
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updatePreparing, setUpdatePreparing] = useState(false);
  const [closePreparing, setClosePreparing] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [updateBridgeError, setUpdateBridgeError] = useState<string | null>(null);
  const updateBusyRef = useRef(false);
  const updateRevision = useRef(-1);
  const closeBusyRef = useRef(false);

  useEffect(() => {
    if (!window.reviewAPI) return;
    let active = true;
    const receive = (state: UpdateState) => {
      if (!active || state.revision < updateRevision.current) return;
      updateRevision.current = state.revision;
      updateBusyRef.current = updatesBusy(state);
      flushSync(() => {
        setUpdateState(state);
        setUpdatePreparing(updatesBusy(state));
      });
    };
    const unsubscribe = window.reviewAPI.onUpdateStateChanged(receive);
    const unshow = window.reviewAPI.onUpdateDialogRequested(() => setShowUpdates(true));
    void window.reviewAPI
      .getUpdateState()
      .then(receive)
      .catch((reason) => {
        if (active) setUpdateBridgeError(errorMessage(reason));
      });
    return () => {
      active = false;
      unsubscribe();
      unshow();
    };
  }, []);

  useEffect(() => {
    return window.reviewAPI?.onBeforeClose(async (reason) => {
      if (reason === 'install') {
        updateBusyRef.current = true;
        flushSync(() => setUpdatePreparing(true));
      } else {
        closeBusyRef.current = true;
        flushSync(() => setClosePreparing(true));
      }
      try {
        await flushPendingComments();
      } catch (error) {
        if (reason === 'close') {
          closeBusyRef.current = false;
          setClosePreparing(false);
        }
        onError(errorMessage(error));
        throw error;
      }
    });
  }, [onError]);

  useEffect(
    () =>
      window.reviewAPI?.onCloseCancelled?.((reason) => {
        closeBusyRef.current = false;
        setClosePreparing(false);
        if (reason) onError(reason);
      }),
    [onError],
  );

  const updateAction = useCallback(async (action: UpdateAction) => {
    setUpdateBridgeError(null);
    try {
      await (action === 'check'
        ? window.reviewAPI.checkForUpdates()
        : action === 'download'
          ? window.reviewAPI.downloadUpdate()
          : window.reviewAPI.installUpdate());
    } catch (reason) {
      setUpdateBridgeError(errorMessage(reason));
    }
  }, []);

  return {
    updateState,
    updatePreparing,
    closePreparing,
    showUpdates,
    setShowUpdates,
    updateBridgeError,
    updateBusyRef,
    closeBusyRef,
    updateAction,
  };
}
