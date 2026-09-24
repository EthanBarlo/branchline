import { ipcRenderer } from 'electron';

interface JiraBrowserState {
  theme: 'light' | 'dark';
  key: string;
  accountLabel: string;
  site: string;
  currentOrigin: string;
  loading: boolean;
  canGoBack: boolean;
  error: string;
  message: string;
}

window.addEventListener('DOMContentLoaded', () => {
  const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
  const header = document.querySelector('header')!;
  const options = document.querySelector<HTMLButtonElement>('[data-action="menu"]')!;
  let lastHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(header.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    void ipcRenderer.invoke('jira-browser:resize', height).catch(() => {});
  }).observe(header);
  ipcRenderer.on('jira-browser:state', (_event, state: JiraBrowserState) => {
    document.documentElement.dataset.theme = state.theme;
    const connection = `Connection: ${state.accountLabel} · ${state.site}`;
    const status = state.error || state.message;
    text('ticket', state.key);
    document.getElementById('ticket')!.title = state.key;
    document.querySelector<HTMLButtonElement>('[data-action="clear-ticket"]')!.title = `Clear ${state.key}`;
    text('connection', connection);
    options.title = connection;
    text('origin', state.currentOrigin || 'Opening Jira…');
    document.getElementById('origin')!.title = state.currentOrigin || 'Opening Jira…';
    text('status', status);
    (document.querySelector('.status-row') as HTMLElement).hidden = !status;
    document.getElementById('status')!.setAttribute('data-error', String(!!state.error));
    document.getElementById('loading')!.hidden = !state.loading;
    (document.querySelector('[data-action="back"]') as HTMLButtonElement).disabled = !state.canGoBack;
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    button.addEventListener('click', () => {
      void ipcRenderer.invoke('jira-browser:action', button.dataset.action).catch(() => {
        // Main owns the error text and sends it through the state channel.
      });
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') void ipcRenderer.invoke('jira-browser:action', 'close').catch(() => {});
    if (event.key !== 'Tab') return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
      event.preventDefault();
      void ipcRenderer.invoke('jira-browser:action', 'focus-page').catch(() => {});
    } else if (event.shiftKey && document.activeElement === buttons[0]) {
      event.preventDefault();
      void ipcRenderer.invoke('jira-browser:action', 'focus-host').catch(() => {});
    }
  });
  void ipcRenderer.invoke('jira-browser:action', 'state').catch(() => {});
});
