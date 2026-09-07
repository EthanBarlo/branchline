import type { EventEmitter } from 'node:events';

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
