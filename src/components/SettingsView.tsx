import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowDownToLine, Check, ChevronDown, FileText, GitPullRequest, LoaderCircle, Ticket, TriangleAlert } from 'lucide-react';
import type { AppSettings } from '../../shared/types';
import type { UpdateState } from '../../shared/updates';
import { jiraTicketUrl, normalizeJiraBaseUrl } from '../../shared/jira';
import { ConnectionSettings } from './ConnectionSettings';
import { DiagnosticSettings } from './DiagnosticSettings';
import { UpdateDetails } from './UpdateControls';
import './settings.css';

export type SettingsSection = 'jira' | 'bitbucket' | 'updates' | 'diagnostics';
const sections = [
  { id: 'jira', label: 'Jira', icon: Ticket },
  { id: 'bitbucket', label: 'Bitbucket', icon: GitPullRequest },
  { id: 'updates', label: 'Updates', icon: ArrowDownToLine },
  { id: 'diagnostics', label: 'Diagnostics', icon: FileText },
] as const;
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

export function SettingsView({ initialSection = 'jira', showLegacyLinks = false, settings, ticket, onSaved, onConnectionsChanged, onClose, updateState, updateBridgeError, onUpdateAction }: {
  initialSection?: SettingsSection; showLegacyLinks?: boolean;
  settings: AppSettings; ticket: string | null; onSaved: (settings: AppSettings) => void;
  onConnectionsChanged: () => void; onClose: () => void;
  updateState: UpdateState | null; updateBridgeError: string | null;
  onUpdateAction: (action: 'check' | 'download' | 'install') => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [busy, setBusy] = useState({ jira: false, bitbucket: false, links: false });
  const scroll = useRef<HTMLDivElement>(null);
  const jiraBusy = useCallback((value: boolean) => setBusy(previous => ({ ...previous, jira: value })), []);
  const bitbucketBusy = useCallback((value: boolean) => setBusy(previous => ({ ...previous, bitbucket: value })), []);
  const linksBusy = useCallback((value: boolean) => setBusy(previous => ({ ...previous, links: value })), []);
  const saving = Object.values(busy).some(Boolean);
  useEffect(() => { document.getElementById(`settings-tab-${initialSection}`)?.focus(); }, [initialSection]);
  function select(next: SettingsSection) { setSection(next); scroll.current?.scrollTo({ top: 0 }); }

  return <section className="settings-view" role="region" aria-label="Settings">
    <aside className="settings-sidebar">
      <button className="settings-back" type="button" disabled={saving} onClick={onClose}><ArrowLeft size={15} />Back to review</button>
      <div className="settings-sidebar-heading"><h1>Settings</h1><p>Accounts, updates and diagnostics.</p></div>
      <div className="settings-navigation" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
        {sections.map(({ id, label, icon: Icon }, index) => <button key={id} id={`settings-tab-${id}`} role="tab" type="button" disabled={saving} aria-controls={`settings-panel-${id}`} aria-selected={section === id} tabIndex={section === id ? 0 : -1} onClick={() => select(id)} onKeyDown={event => {
          const next = event.key === 'ArrowDown' ? (index + 1) % sections.length : event.key === 'ArrowUp' ? (index - 1 + sections.length) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); select(sections[next].id); document.getElementById(`settings-tab-${sections[next].id}`)?.focus();
        }}><Icon size={16} /><span>{label}</span></button>)}
      </div>
      <div className="settings-sidebar-footnote">Your accounts, on this device.<span>Choose which accounts each project uses in Project integrations.</span></div>
    </aside>
    <div className="settings-scroll" ref={scroll}>
      <div className="settings-content">
        <div id="settings-panel-jira" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-jira" hidden={section !== 'jira'}>
          <ConnectionSettings kind="jira" onChanged={onConnectionsChanged} onBusyChange={jiraBusy} />
          <JiraLinkSettings settings={settings} ticket={ticket} initiallyOpen={showLegacyLinks || !!settings.jiraBaseUrl} onSaved={onSaved} onBusyChange={linksBusy} />
        </div>
        <div id="settings-panel-bitbucket" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-bitbucket" hidden={section !== 'bitbucket'}>
          <ConnectionSettings kind="bitbucket" onChanged={onConnectionsChanged} onBusyChange={bitbucketBusy} />
        </div>
        <div id="settings-panel-updates" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-updates" hidden={section !== 'updates'}>
          <header className="settings-page-heading"><span className="settings-kicker">APPLICATION</span><h2>Updates</h2><p>Keep Branchline current. Choose when to download and restart.</p></header>
          <div className="settings-update-card"><UpdateDetails state={updateState} bridgeError={updateBridgeError} onAction={onUpdateAction} onClose={onClose} /></div>
        </div>
        <div id="settings-panel-diagnostics" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-diagnostics" hidden={section !== 'diagnostics'}>
          <DiagnosticSettings visible={section === 'diagnostics'} />
        </div>
      </div>
    </div>
  </section>;
}

function JiraLinkSettings({ settings, ticket, initiallyOpen, onSaved, onBusyChange }: {
  settings: AppSettings; ticket: string | null; initiallyOpen: boolean;
  onSaved: (settings: AppSettings) => void; onBusyChange: (value: boolean) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.jiraBaseUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  let preview = '';
  try { if (baseUrl.trim()) preview = jiraTicketUrl(normalizeJiraBaseUrl(baseUrl), ticket || 'APP-123'); } catch { /* Validate the completed URL on save. */ }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); onBusyChange(true); setError(''); setSaved(false);
    try {
      const updated = await window.reviewAPI.updateSettings({ jiraBaseUrl: normalizeJiraBaseUrl(baseUrl) });
      setBaseUrl(updated.jiraBaseUrl); onSaved(updated); setSaved(true);
    } catch (reason) { setError(message(reason)); }
    finally { inFlight.current = false; setSaving(false); onBusyChange(false); }
  }
  return <details className="settings-browser-links" open={initiallyOpen || undefined}>
    <summary><span>Browser links only<small>For Jira Server, Data Center, or opening tickets without an API token.</small></span><ChevronDown size={15} /></summary>
    <form onSubmit={event => void save(event)} noValidate>
      <p>This optional URL opens branch ticket keys in your browser. A connected Jira Cloud account above also shows ticket details inside Branchline.</p>
      <label htmlFor="jira-base-url">Jira base URL</label>
      <input className="text-input" id="jira-base-url" type="url" placeholder="https://jira.example.com/jira" autoComplete="off" spellCheck={false} value={baseUrl} aria-describedby="jira-url-hint" aria-invalid={error ? true : undefined} disabled={saving} onChange={event => { setBaseUrl(event.target.value); setError(''); setSaved(false); }} />
      <p id="jira-url-hint">Include any site path, such as <code>/jira</code>. Leave blank to clear it. Applies to all projects without a connected Jira account.</p>
      {preview && <div className="settings-link-preview"><span>{ticket ? `Detected ${ticket}` : 'Example ticket link'}</span><code>{preview}</code></div>}
      {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      <div className="settings-save-row">{saved && <span role="status"><Check size={13} />Link settings saved</span>}<button className="button button-primary" type="submit" disabled={saving || baseUrl === settings.jiraBaseUrl}>{saving && <LoaderCircle className="spin" size={13} />}Save link settings</button></div>
    </form>
  </details>;
}
