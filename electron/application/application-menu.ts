import { Menu } from 'electron';
import type { ReviewWindow } from './review-window';

export function installApplicationMenu(window: ReviewWindow): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Branchline',
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', click: () => window.showUpdates() },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => window.reload() },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

export function setReloadEnabled(enabled: boolean): void {
  const reload = Menu.getApplicationMenu()?.getMenuItemById('reload');
  if (reload) reload.enabled = enabled;
}
