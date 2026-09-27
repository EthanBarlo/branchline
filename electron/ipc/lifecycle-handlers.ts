import type { ReviewWindow } from '../application/review-window';
import type { UpdateService } from '../updates/update-service';
import type { ReviewHandlerRegistrar } from './register-review-handlers';

export function registerLifecycleHandlers(
  handle: ReviewHandlerRegistrar,
  window: ReviewWindow,
  updates: UpdateService,
): void {
  handle('update-state', () => updates.getState());
  handle('update-check', () => updates.check());
  handle('update-download', () => updates.download());
  handle('update-install', () => {
    window.lifecycle.assertCanInstall();
    return updates.install();
  });
  handle('close-listener', (ready) => window.setListenerReady(ready));
  handle('close-ready', (id, saved) => window.lifecycle.acknowledgeFlush(id, saved));
}
