import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConnectionInfo, ConnectionInput, ConnectionKind } from '../../../../shared/integrations';
import { errorMessage } from '../../../lib/errorMessage';
import { connectionProviders } from './connectionProviders';

export type ConnectionOperation = '' | 'save' | `test:${string}` | `disconnect:${string}`;

export interface ConnectionSettingsProps {
  kind: ConnectionKind;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
}
const newConnection = (kind: ConnectionKind): ConnectionInput => ({
  kind,
  email: '',
  token: '',
  ...(kind === 'jira' ? { siteUrl: '' } : {}),
});

export function useConnections({ kind, onChanged, onBusyChange }: ConnectionSettingsProps) {
  const provider = connectionProviders[kind];
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [editor, setEditor] = useState<ConnectionInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState<ConnectionOperation>('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const lock = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const editorHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void window.reviewAPI
      .getIntegrations()
      .then((state) => {
        if (!live) return;
        const accounts = state.connections.filter((connection) => connection.kind === kind);
        setConnections(accounts);
        if (!accounts.length) setEditor((previous) => previous || newConnection(kind));
      })
      .catch((reason) => {
        if (live) setError(errorMessage(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [kind, loadAttempt]);

  useEffect(
    () => () => {
      busyCallback.current?.(false);
    },
    [],
  );

  function updateAccount(connection: ConnectionInfo) {
    setConnections((previous) =>
      previous.some((item) => item.id === connection.id)
        ? previous.map((item) => (item.id === connection.id ? connection : item))
        : [...previous, connection],
    );
  }

  async function action(key: Exclude<ConnectionOperation, ''>, run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    busyCallback.current?.(true);
    setError('');
    setStatus('');
    try {
      await run();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      lock.current = false;
      setBusy('');
      busyCallback.current?.(false);
    }
  }

  function edit(connection?: ConnectionInfo) {
    setEditor(
      connection
        ? {
            id: connection.id,
            kind,
            label: connection.label,
            email: connection.email,
            token: '',
            siteUrl: connection.siteUrl,
          }
        : newConnection(kind),
    );
    setError('');
    setStatus('');
    setCopyStatus('');
    requestAnimationFrame(() => editorHeading.current?.focus());
  }

  function cancel() {
    setEditor(null);
    setError('');
    setCopyStatus('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !canSave) return;
    const input = {
      ...editor,
      email: editor.email.trim(),
      token: editor.token.trim(),
      siteUrl: editor.siteUrl?.trim(),
    };
    void action('save', async () => {
      const saved = await window.reviewAPI.saveConnection(input);
      updateAccount(saved);
      setEditor(null);
      setStatus(
        `${provider.name} account verified and saved. Choose it in your project integrations.${saved.storage === 'session' ? ' Secure storage is unavailable, so this token is kept for this session only.' : ''}`,
      );
    });
  }

  const selectedAccount = editor?.id
    ? connections.find((connection) => connection.id === editor.id)
    : undefined;
  const canSave =
    !!editor?.email.trim() &&
    !!editor?.token.trim() &&
    (kind !== 'jira' || !!editor.siteUrl?.trim()) &&
    !busy;

  function test(connection: ConnectionInfo) {
    void action(`test:${connection.id}`, async () => {
      updateAccount(await window.reviewAPI.testConnection(connection.id));
      setStatus(`${connection.label || connection.displayName}: connection verified.`);
    });
  }

  function disconnect(connection: ConnectionInfo) {
    void action(`disconnect:${connection.id}`, async () => {
      const state = await window.reviewAPI.disconnectConnection(connection.id);
      setConnections(state.connections.filter((item) => item.kind === kind));
      if (editor?.id === connection.id) setEditor(null);
      setStatus(`${connection.label || connection.displayName} disconnected. The saved token was removed.`);
    });
  }

  function copyScopes() {
    setCopyStatus('');
    void window.reviewAPI
      .copyConnectionScopes(kind)
      .then(() => setCopyStatus('Scopes copied.'))
      .catch(() => setCopyStatus('Could not copy. Select the scope names below to copy them manually.'));
  }

  return {
    connections,
    editor,
    loading,
    busy,
    error,
    status,
    copyStatus,
    editorHeading,
    selectedAccount,
    canSave,
    edit,
    cancel,
    save,
    test,
    disconnect,
    copyScopes,
    setEditor,
    retry: () => setLoadAttempt((value) => value + 1),
  };
}
