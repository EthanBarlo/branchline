import { useEffect, useRef, useState } from 'react';
import { CircleCheck, ExternalLink, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import type { RemoteReviewState } from '../../shared/integrations';
import { MergeProgressView } from './IntegrationControls';
import './merge-completion.css';

export function MergeCompletion({ reviewId, remote, jiraLink, onDismiss }: {
  reviewId: string; remote: RemoteReviewState; jiraLink: { key: string; url: string } | null; onDismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { heading.current?.focus(); setError(''); }, [reviewId]);
  async function openTicket() {
    if (opening) return;
    setOpening(true); setError('');
    try { await window.reviewAPI.openJiraTicket(reviewId); }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The Jira ticket could not be opened.'); }
    finally { setOpening(false); }
  }
  return <section className="merge-completion" aria-label="Merge complete">
    <header className="merge-completion-heading">
      <CircleCheck size={22} aria-hidden="true" />
      <div><h2 tabIndex={-1} ref={heading}>Pull requests merged</h2><p>Review closed.{jiraLink ? ` Open ${jiraLink.key} in Jira to update its status.` : ''}</p></div>
      {jiraLink && <button className="button button-secondary" type="button" disabled={opening} onClick={() => void openTicket()}>{opening ? <LoaderCircle size={13} className="spin" /> : <ExternalLink size={13} />}Open in Jira</button>}
      <button className="icon-button" type="button" aria-label="Dismiss merge results" onClick={onDismiss}><X size={15} /></button>
    </header>
    {error && <div className="integration-error" role="alert"><TriangleAlert size={14} /><span>{error}</span></div>}
    <MergeProgressView operation={remote.operation} pullRequests={remote.pullRequests} />
  </section>;
}
