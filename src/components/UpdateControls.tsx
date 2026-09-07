import { ArrowDownToLine, Check, LoaderCircle, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react';
import './updates.css';
import type { UpdateState } from '../../shared/updates';

export function UpdateButton({ state, onClick }: { state: UpdateState | null; onClick: () => void }) {
  const busy = state?.phase === 'checking' || state?.phase === 'downloading';
  const ready = state?.phase === 'downloaded';
  const available = state?.phase === 'available';
  const label = ready ? 'Restart to update' : available ? 'Update available' : state?.phase === 'downloading' ? `Downloading ${Math.round(state.progress || 0)}%` : 'Updates';
  return <button className={`update-button ${ready || available ? 'update-button-ready' : ''}`} onClick={onClick} aria-label={label} title="Branchline updates">
    {busy ? <LoaderCircle className="spin" size={12} /> : ready ? <RotateCw size={12} /> : <ArrowDownToLine size={12} />}<span>{label}</span>
  </button>;
}

export function UpdateDetails({ state, bridgeError, onAction, onClose }: {
  state: UpdateState | null; bridgeError: string | null;
  onAction: (action: 'check' | 'download' | 'install') => void; onClose: () => void;
}) {
  if (!state) return <div className="update-details"><p role="status">{bridgeError || 'Connecting to Branchline…'}</p></div>;
  const phase = state.phase;
  const error = bridgeError || state.error?.message;
  const title = phase === 'disabled' ? 'Updates in the desktop app' : phase === 'checking' ? 'Checking for updates…'
    : phase === 'available' ? `Branchline ${state.availableVersion} is available`
      : phase === 'downloading' ? 'Downloading your update…' : phase === 'downloaded' ? 'Ready when you are'
        : state.lastCheckedAt && !error ? 'You’re up to date' : 'Keep Branchline up to date';
  return <>
    <div className="update-details">
      <div className="update-version"><span>INSTALLED VERSION</span><code>{state.currentVersion}</code></div>
      <div className="update-status" role="status" aria-live="polite">
        <span className="update-status-icon">{phase === 'downloading' || phase === 'checking' ? <LoaderCircle className="spin" size={22} /> : phase === 'downloaded' ? <RotateCw size={22} /> : phase === 'idle' && state.lastCheckedAt && !error ? <Check size={22} /> : <ArrowDownToLine size={22} />}</span>
        <div><h3>{title}</h3><p>{phase === 'disabled' ? state.disabledReason : phase === 'downloaded' ? 'Restart to install. Your review work will be saved first.' : phase === 'downloading' ? 'You can close this window and keep reviewing.' : 'Updates are checked automatically. You choose when to download and restart.'}</p></div>
      </div>
      {phase === 'downloading' && <div className="update-download"><progress aria-label="Update download progress" max={100} value={state.progress || 0} /><span>{Math.round(state.progress || 0)}%</span></div>}
      {error && <div className="update-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
      {state.availableVersion && state.releaseNotes && <section className="update-notes"><h4>What’s new in {state.availableVersion}</h4><pre>{state.releaseNotes}</pre></section>}
    </div>
    <div className="modal-footer">
      <button className="button button-secondary" onClick={onClose}>{phase === 'available' || phase === 'downloaded' ? 'Later' : 'Close'}</button>
      {phase === 'downloaded' && error && <button className="button button-secondary" onClick={() => onAction('download')}>Download again</button>}
      {phase === 'idle' && <button className="button button-primary" onClick={() => onAction('check')}><RefreshCw size={14} />{error ? 'Retry check' : 'Check for updates'}</button>}
      {phase === 'available' && <button className="button button-primary" onClick={() => onAction('download')}><ArrowDownToLine size={14} />{state.error?.action === 'download' ? 'Retry download' : 'Download update'}</button>}
      {phase === 'downloaded' && <button className="button button-primary" onClick={() => onAction('install')}><RotateCw size={14} />{error ? 'Retry update' : 'Restart to update'}</button>}
    </div>
  </>;
}
