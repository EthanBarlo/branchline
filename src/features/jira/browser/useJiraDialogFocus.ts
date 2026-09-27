import { useEffect, useRef, type RefObject } from 'react';

export function useJiraDialogFocus(dialog: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const workspace = document.getElementById('root');
    const wasInert = workspace?.inert;
    if (workspace) workspace.inert = true;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const items = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) || []),
      ].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      if (workspace) workspace.inert = wasInert || false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
}
