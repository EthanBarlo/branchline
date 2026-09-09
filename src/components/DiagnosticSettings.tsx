import { useEffect, useState } from 'react';
import { FolderOpen, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { IntegrationDiagnosticsInfo } from '../../shared/integrations';

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

export function DiagnosticSettings({ visible }: { visible: boolean }) {
  const [info, setInfo] = useState<IntegrationDiagnosticsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true); setError('');
    void window.reviewAPI.getIntegrationDiagnostics().then(value => {
      if (!cancelled) setInfo(value);
    }).catch(reason => {
      if (!cancelled) setError(message(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible]);

  async function openLog() {
    if (opening) return;
    setOpening(true); setError('');
    try { await window.reviewAPI.openIntegrationLog(); }
    catch (reason) { setError(message(reason)); }
    finally { setOpening(false); }
  }

  return <>
    <header className="settings-page-heading"><span className="settings-kicker">TROUBLESHOOTING</span><h2>Diagnostics</h2><p>Find the details behind Jira and Bitbucket connection or review errors.</p></header>
    <div className="settings-diagnostics-card">
      <h3>Integration log</h3>
      <p>Branchline automatically records request statuses, timing and response validation details on this device. Tokens, authorization headers and response bodies are excluded.</p>
      <p>Retry the action that failed, then open the log to inspect the latest entries.</p>
      {loading && <p className="settings-diagnostics-loading" role="status"><LoaderCircle className="spin" size={13} />Checking the log…</p>}
      {!loading && info?.path && <div className="settings-diagnostics-path"><span>Log file</span><code>{info.path}</code></div>}
      {!loading && info && !info.available && <p role="status">The log is not available yet. Retry the connection or pull request, then reopen this tab.</p>}
      {error && <div className="form-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div>}
      <div className="settings-diagnostics-actions"><button className="button" type="button" disabled={loading || opening || !info?.available} onClick={() => void openLog()}>{opening ? <LoaderCircle className="spin" size={13} /> : <FolderOpen size={13} />}Open integration log</button></div>
    </div>
  </>;
}
