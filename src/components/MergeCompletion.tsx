import { useState } from 'react';
import { CircleCheck, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { RemoteReviewState } from '../../shared/integrations';
import { IntegrationDialog, MergeProgressView } from './IntegrationControls';
import './merge-completion.css';

export function MergeCompletion({ remote, jiraLink, onDismiss }: {
  reviewId: string; remote: RemoteReviewState; jiraLink: { key: string; url: string } | null; onDismiss: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  async function openTicket() {
    if (opening || !jiraLink) return;
    setOpening(true); setError('');
    // The completed review has been removed. The captured, validated URL keeps
    // this action available without looking up deleted review data.
    try { await window.reviewAPI.openIntegrationLink(jiraLink.url); }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'The Jira ticket could not be opened.'); }
    finally { setOpening(false); }
  }
  return <IntegrationDialog title="Pull requests merged" className="merge-completion-modal" onClose={onDismiss}>
    <div className="integration-body merge-completion-body">
      <div className="merge-completion-summary"><CircleCheck size={21} aria-hidden="true" /><p>This review has been removed from Branchline.{jiraLink ? ` Open ${jiraLink.key} in Jira to update its status.` : ''}</p></div>
      {error && <div className="integration-error" role="alert"><TriangleAlert size={14} /><span>{error}</span></div>}
      <MergeProgressView operation={remote.operation} pullRequests={remote.pullRequests} repositories={remote.repositories} />
    </div>
    <div className="modal-footer">
      {jiraLink && <button className="button button-secondary" type="button" disabled={opening} onClick={() => void openTicket()}>{opening ? <LoaderCircle size={13} className="spin" /> : <ExternalLink size={13} />}Open in Jira</button>}
      <button className="button button-primary" type="button" onClick={onDismiss}>Done</button>
    </div>
  </IntegrationDialog>;
}
