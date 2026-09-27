import type { EventEmitter } from 'node:events';

export interface NativeMacUpdater extends EventEmitter {
  checkForUpdates(): void;
  quitAndInstall(): void;
}

/** Native authorization happens during staging, before quitting. Squirrel caches
 * a failed helper launch, so a retry needs a fresh native updater/feed. The
 * electron-updater cached-download path recreates its authenticated local feed.
 */
export function createMacUpdateInstaller(native: NativeMacUpdater, refreshNativeFeed: () => Promise<unknown>): () => Promise<void> {
  let attempted = false;
  let active: Promise<void> | undefined;
  // A native error can arrive before electron-updater's cached feed refresh
  // settles. Drain that work before another attempt can replace the feed.
  let preparation = Promise.resolve();
  return () => {
    if (active) return active;
    let failed = false;
    let quitting = false;
    let rejectAttempt!: (error: unknown) => void;
    const result = new Promise<void>((_resolve, reject) => { rejectAttempt = reject; });
    const cleanup = () => {
      native.removeListener('error', onError);
      native.removeListener('update-downloaded', onDownloaded);
      native.removeListener('update-not-available', onUnavailable);
    };
    const onError = (error: unknown) => {
      if (failed) return;
      failed = true;
      cleanup();
      rejectAttempt(error instanceof Error ? error : new Error(String(error)));
    };
    const onUnavailable = () => onError(new Error('The prepared update is no longer available. Download it again and retry.'));
    const onDownloaded = () => {
      if (failed || quitting) return;
      quitting = true;
      native.removeListener('update-not-available', onUnavailable);
      try { native.quitAndInstall(); }
      catch (error) { onError(error); }
      // Readiness is not completion: native relaunch can still fail while
      // rewriting its install request. Keep observing errors until the process
      // exits, rather than resolving and leaving the install gate stuck closed.
    };
    active = result;
    void result.catch(() => { if (active === result) active = undefined; });
    preparation = preparation.then(async () => {
      native.once('error', onError);
      try {
        const refresh = attempted;
        attempted = true;
        if (refresh) await refreshNativeFeed();
        if (failed) return;
        // Use the public native API so MacUpdater's cached ready flag cannot
        // skip authorization for a newly created feed. Arm readiness only once
        // this attempt's feed is ready, ignoring events from an old refresh.
        native.once('update-downloaded', onDownloaded);
        native.once('update-not-available', onUnavailable);
        native.checkForUpdates();
      } catch (error) { onError(error); }
    }).catch(onError);
    return result;
  };
}

/** electron-updater 6.8.9 leaves its native completion listener installed on error.
 * Remove only listeners introduced by this attempt, never its permanent listener.
 * Resolve only after native staging completes; do not time out native staging.
 */
export function installMacUpdate(native: EventEmitter, quitAndInstall: () => void): Promise<void> {
  const existing = new Set(native.listeners('update-downloaded'));
  let added: Function[] = [];
  let invoking = true;
  let failed = false;
  let completed = false;
  return new Promise<void>((resolve, reject) => {
    const removeAttempt = () => {
      for (const listener of added) native.removeListener('update-downloaded', listener as (...args: any[]) => void);
    };
    const cleanup = () => {
      native.removeListener('error', onError);
      native.removeListener('update-downloaded', onDownloaded);
    };
    const onError = (error: Error) => {
      failed = true;
      if (!invoking) removeAttempt();
      cleanup();
      reject(error);
    };
    const onDownloaded = () => { completed = true; if (!invoking) removeAttempt(); cleanup(); resolve(); };
    native.once('error', onError);
    native.once('update-downloaded', onDownloaded);
    try { quitAndInstall(); }
    catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
    finally {
      invoking = false;
      added = native.listeners('update-downloaded').filter(listener => !existing.has(listener) && listener !== onDownloaded);
      if (failed || completed) removeAttempt();
      // An already staged update calls native quitAndInstall synchronously.
      if (!failed && added.length === 0) { cleanup(); resolve(); }
    }
  });
}
