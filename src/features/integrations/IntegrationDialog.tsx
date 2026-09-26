import type { ReactNode } from 'react';
import { Dialog } from '../../ui/Dialog';

export function IntegrationDialog({
  title,
  onClose,
  children,
  busy = false,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  wide?: boolean;
}) {
  return (
    <Dialog title={title} onClose={onClose} busy={busy} wide={wide} variant="integration">
      {children}
    </Dialog>
  );
}
