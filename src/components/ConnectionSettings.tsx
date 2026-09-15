import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, KeyRound, LoaderCircle, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ConnectionInfo, ConnectionInput, ConnectionKind } from '../../shared/integrations';
import { connectionScopes } from '../../shared/connection-scopes';
import './connection-settings.css';

const TOKEN_SETTINGS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const providers = {
  jira: {
    name: 'Jira',
    description: 'Keep the ticket title and description beside your review.',
    scopes: connectionScopes.jira,
    docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
  },
  bitbucket: {
    name: 'Bitbucket',
    description: 'Review branches across repositories, create missing PRs, publish feedback and merge.',
    scopes: connectionScopes.bitbucket,
    docs: 'https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/',
  },
} as const;

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(reason);
const newConnection = (kind: ConnectionKind): ConnectionInput => ({ kind, email: '', token: '', ...(kind === 'jira' ? { siteUrl: '' } : {}) });

function SetupLink({ url, children, prominent = false }: { url: string; children: ReactNode; prominent?: boolean }) {
  const [error, setError] = useState('');
  return <span className="connection-setup-link-wrap">
    <button type="button" role="link" className={prominent ? 'button button-secondary' : 'connection-text-button'} onClick={() => {
      setError('');
      void window.reviewAPI.openIntegrationLink(url).catch(reason => setError(errorMessage(reason)));
    }}>{children}<ExternalLink size={12} aria-hidden="true" /></button>
    {error && <span className="connection-link-error" role="alert">{error}</span>}
  </span>;
}

export function ConnectionSettings({ kind, onChanged, onBusyChange }: {
  kind: ConnectionKind;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const provider = providers[kind];
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [editor, setEditor] = useState<ConnectionInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const lock = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const editorHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void window.reviewAPI.getIntegrations().then(state => {
      if (!live) return;
      const accounts = state.connections.filter(connection => connection.kind === kind);
      setConnections(accounts);
      if (!accounts.length) setEditor(previous => previous || newConnection(kind));
    }).catch(reason => { if (live) setError(errorMessage(reason)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind, loadAttempt]);

  useEffect(() => () => { busyCallback.current?.(false); }, []);

  function updateAccount(connection: ConnectionInfo) {
    setConnections(previous => previous.some(item => item.id === connection.id)
      ? previous.map(item => item.id === connection.id ? connection : item)
      : [...previous, connection]);
  }

  async function action(key: string, run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(key); busyCallback.current?.(true); setError(''); setStatus('');
    try { await run(); onChanged(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { lock.current = false; setBusy(''); busyCallback.current?.(false); }
  }

  function edit(connection?: ConnectionInfo) {
    setEditor(connection
      ? { id: connection.id, kind, label: connection.label, email: connection.email, token: '', siteUrl: connection.siteUrl }
      : newConnection(kind));
    setError(''); setStatus(''); setCopyStatus('');
    requestAnimationFrame(() => editorHeading.current?.focus());
  }

  function cancel() {
    setEditor(null); setError(''); setCopyStatus('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !canSave) return;
    const input = { ...editor, email: editor.email.trim(), token: editor.token.trim(), siteUrl: editor.siteUrl?.trim() };
    void action('save', async () => {
      const saved = await window.reviewAPI.saveConnection(input);
      updateAccount(saved); setEditor(null);
      setStatus(`${provider.name} account verified and saved. Choose it in your project integrations.${saved.storage === 'session' ? ' Secure storage is unavailable, so this token is kept for this session only.' : ''}`);
    });
  }

  const selectedAccount = editor?.id ? connections.find(connection => connection.id === editor.id) : undefined;
  const canSave = !!editor?.email.trim() && !!editor?.token.trim() && (kind !== 'jira' || !!editor.siteUrl?.trim()) && !busy;

  return <section className="provider-settings" aria-label={`${provider.name} connections`}>
    <header className="provider-settings-heading"><span className="eyebrow">CONNECTIONS</span><h2>{provider.name}</h2><p>{provider.description}</p></header>
    <p className="connection-account-note">Jira and Bitbucket connect independently. Use the account for each service, even when their emails are different.</p>

    {loading && <p className="connection-notice" role="status"><LoaderCircle size={14} className="spin" />Loading accounts…</p>}
    {!!connections.length && <div className="provider-account-list">
      <div className="provider-section-title"><h3>Your accounts</h3><span>{connections.length} {connections.length === 1 ? 'account' : 'accounts'}</span></div>
      {connections.map(connection => <article className="provider-account" key={connection.id} aria-label={`${connection.label || connection.displayName} account`}>
        <div className="provider-account-top"><div className="provider-account-identity"><strong>{connection.label || connection.displayName}</strong><span>{connection.displayName} · {connection.email}</span>{connection.siteUrl && <span>{connection.siteUrl}</span>}</div>
          <span className={`provider-account-state${connection.connected ? '' : ' is-disconnected'}`}><span />{connection.connected ? 'Connected' : 'Disconnected'}</span></div>
        <div className="provider-account-bottom"><small>{!connection.connected ? 'Reconnect to continue using this account.' : connection.storage === 'session' ? 'Session only · reconnect after restarting' : 'Stored securely on this device'}</small>
          <div className="provider-account-actions">
            <button type="button" className="connection-text-button" disabled={!!busy || !connection.connected} onClick={() => void action(`test:${connection.id}`, async () => {
              updateAccount(await window.reviewAPI.testConnection(connection.id)); setStatus(`${connection.label || connection.displayName}: connection verified.`);
            })}>{busy === `test:${connection.id}` ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}Test</button>
            <button type="button" className="connection-text-button" disabled={!!busy} onClick={() => edit(connection)}>{connection.connected ? 'Replace token' : 'Reconnect'}</button>
            <button type="button" className="connection-text-button" disabled={!!busy || !connection.connected} aria-label={`Disconnect ${connection.label || connection.displayName}`} onClick={() => void action(`disconnect:${connection.id}`, async () => {
              const state = await window.reviewAPI.disconnectConnection(connection.id);
              setConnections(state.connections.filter(item => item.kind === kind));
              if (editor?.id === connection.id) setEditor(null);
              setStatus(`${connection.label || connection.displayName} disconnected. The saved token was removed.`);
            })}>{busy === `disconnect:${connection.id}` && <LoaderCircle className="spin" size={12} />}Disconnect</button>
          </div>
        </div>
      </article>)}
    </div>}

    {!loading && !editor && <button type="button" className="button button-secondary connection-add-account" disabled={!!busy} onClick={() => edit()}><Plus size={13} />{connections.length ? `Add another ${provider.name} account` : `Connect ${provider.name}`}</button>}

    {editor && <form className="provider-setup" onSubmit={save}>
      <h3 ref={editorHeading} tabIndex={-1}>{editor.id ? selectedAccount?.connected ? 'Replace your API token' : `Reconnect ${provider.name}` : `Connect ${provider.name}`}</h3>
      <ol className="connection-setup-steps">
        <li><span className="connection-step-number" aria-hidden="true">1</span><div className="connection-step-content"><h4>{kind === 'jira' ? 'Enter your Jira site and account' : 'Enter your Bitbucket account'}</h4>
          {kind === 'jira' && <label className="connection-field">Jira site URL<input className="text-input" aria-label="Jira site URL" type="url" placeholder="https://your-team.atlassian.net" autoComplete="off" spellCheck={false} required disabled={!!busy} readOnly={!!editor.id} value={editor.siteUrl || ''} onChange={event => setEditor({ ...editor, siteUrl: event.target.value })} /><small>Use your Jira Cloud site address, including https://.</small></label>}
          <div className="connection-account-fields"><label className="connection-field">Account email<input className="text-input" aria-label="Account email" type="email" placeholder="you@company.com" autoComplete="off" spellCheck={false} required disabled={!!busy} readOnly={!!editor.id} value={editor.email} onChange={event => setEditor({ ...editor, email: event.target.value })} /></label>
            <label className="connection-field">Account label <span className="connection-optional">Optional</span><input className="text-input" aria-label="Account label (optional)" placeholder={`e.g. Work ${provider.name}`} maxLength={200} disabled={!!busy} value={editor.label || ''} onChange={event => setEditor({ ...editor, label: event.target.value })} /></label></div>
          <p>{editor.id ? 'Use a new token for this same account. Add another account to connect a different identity or Jira site.' : 'Use the email you sign in to Atlassian with. Each project can choose which account to use.'}</p>
        </div></li>
        <li><span className="connection-step-number" aria-hidden="true">2</span><div className="connection-step-content"><h4>Create a scoped API token</h4>
          <p>Open Atlassian’s token settings and sign in with the email above. Choose <strong>Create API token with scopes</strong>, give it a name and expiry, then select <strong>{provider.name}</strong>.</p>
          <SetupLink url={TOKEN_SETTINGS_URL} prominent>Create {provider.name} API token</SetupLink>
          <div className="connection-scope-heading"><span>Required permissions{kind === 'jira' ? ' · Classic scopes' : ''}</span><button type="button" className="connection-text-button" onClick={() => {
            setCopyStatus('');
            void window.reviewAPI.copyConnectionScopes(kind).then(() => setCopyStatus('Scopes copied.')).catch(() => setCopyStatus('Could not copy. Select the scope names below to copy them manually.'));
          }}><Copy size={12} />Copy required scopes</button></div>
          <dl className="connection-scopes">{provider.scopes.map(([scope, description]) => <div key={scope}><dt><code>{scope}</code></dt><dd>{description}</dd></div>)}</dl>
          {kind === 'bitbucket' && <div className="connection-optional-scope"><span className="connection-optional">Repository write access</span><p>Repositories · Write lets Branchline delete matching empty branches after merging and optionally update submodule pointers. If your existing token only has repository read access, replace it with a token containing all the scopes above.</p></div>}
          {copyStatus && <p className="connection-copy-status" role="status">{copyStatus}</p>}
          <p className="connection-help">{kind === 'jira' ? 'Choose these classic scopes within the scoped-token flow. Jira access stays limited to the issues your account can view.' : 'These permissions enable branch reviews, PR creation, inline feedback, approval, merging and branch cleanup. Repository permissions and merge checks still apply.'} <SetupLink url={provider.docs}>Token setup guide</SetupLink></p>
        </div></li>
        <li><span className="connection-step-number" aria-hidden="true">3</span><div className="connection-step-content"><h4>Paste your token and connect</h4><p>Copy the token when Atlassian displays it, then paste it here.</p>
          <label className="connection-field">API token<input className="text-input connection-token-input" aria-label="API token" type="password" placeholder="Paste your API token" autoComplete="new-password" spellCheck={false} required disabled={!!busy} value={editor.token} onChange={event => setEditor({ ...editor, token: event.target.value })} /></label>
          <p className="connection-storage-note"><ShieldCheck size={14} /><span>Branchline verifies the account before saving. Tokens are encrypted on this device, or kept only for this session if secure storage is unavailable.</span></p>
          <div className="connection-setup-actions"><button type="button" className="connection-text-button" disabled={!!busy} onClick={cancel}>Cancel connection</button><button type="submit" className="button button-primary" disabled={!canSave}>{busy === 'save' ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />}Verify and save account</button></div>
        </div></li>
      </ol>
    </form>}

    {error && <div className="connection-problem" role="alert"><TriangleAlert size={15} /><div><span>{error}</span>{!loading && !editor && !connections.length && <button type="button" className="connection-text-button" onClick={() => setLoadAttempt(value => value + 1)}>Retry loading accounts</button>}</div></div>}
    {status && <p className="connection-notice is-success" role="status"><Check size={14} /><span>{status}</span></p>}
  </section>;
}
