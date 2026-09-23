import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CirclePause, ExternalLink, GitPullRequest, LoaderCircle, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import type { ClosedReviewCheck, ClosedReviewCleanupResult } from '../../shared/integrations';
import type { Project, Review } from '../../shared/types';
import { flushPendingComments } from './commentAutosave';
import { IntegrationDialog, IntegrationLink } from './IntegrationControls';
import './closed-review-cleanup.css';

type CleanupRow = { reviewId: string; name: string; phase: 'checking' | 'checked' | 'removed'; dataRemoved?: boolean; check?: ClosedReviewCheck };
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

function rowStatus(row: CleanupRow) {
  if (row.phase === 'checking') return { label: 'Checking…', icon: LoaderCircle, tone: 'checking' };
  if (row.dataRemoved && row.phase !== 'removed') return { label: 'Cleanup pending', icon: TriangleAlert, tone: 'warning' };
  if (row.phase === 'removed') return { label: 'Removed', icon: Check, tone: 'removed' };
  if (row.check?.status === 'closed') return { label: 'Ready to remove', icon: Check, tone: 'ready' };
  if (row.check?.status === 'open') return { label: 'Still open', icon: GitPullRequest, tone: 'open' };
  if (row.check?.status === 'blocked') return { label: 'Needs attention', icon: CirclePause, tone: 'warning' };
  return { label: 'Could not check', icon: TriangleAlert, tone: 'warning' };
}

export function ClosedReviewCleanup({ project, reviews, onClose, onRemoved }: {
  project: Project;
  reviews: Review[];
  onClose: () => void;
  onRemoved: (result: ClosedReviewCleanupResult) => void;
}) {
  const [rows, setRows] = useState<CleanupRow[]>([]);
  const [scanning, setScanning] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ removed: number; retained: number; metadataPending: number } | null>(null);
  const [retryIds, setRetryIds] = useState<string[]>([]);
  const retryIdsRef = useRef(retryIds); retryIdsRef.current = retryIds;
  const generation = useRef(0);
  const reviewsRef = useRef(reviews); reviewsRef.current = reviews;
  const removedRef = useRef(onRemoved); removedRef.current = onRemoved;
  const removalInFlight = useRef(false);

  const scan = useCallback(async () => {
    if (removalInFlight.current) return;
    const current = ++generation.current;
    const candidates = reviewsRef.current.filter(review => review.remote && review.projectId === project.id);
    setRows(previous => [
      ...previous.filter(row => retryIdsRef.current.includes(row.reviewId) && !candidates.some(review => review.id === row.reviewId)),
      ...candidates.map(review => ({ reviewId: review.id, name: review.name, phase: 'checking' as const })),
    ]);
    setScanning(true); setError(''); setResult(null);
    try {
      await flushPendingComments();
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (current === generation.current && next < candidates.length) {
          const review = candidates[next++];
          let check: ClosedReviewCheck;
          try { check = await window.reviewAPI.checkClosedReview(review.id); }
          catch (reason) { check = { reviewId: review.id, name: review.name, status: 'unavailable', pullRequests: [], unpublishedComments: 0, reason: message(reason) }; }
          if (current !== generation.current) return;
          setRows(previous => previous.map(row => row.reviewId === review.id ? { ...row, phase: 'checked', check } : row));
        }
      }));
    } catch (reason) {
      if (current === generation.current) {
        const reasonText = message(reason);
        setError(reasonText);
        setRows(previous => previous.map(row => ({ ...row, phase: 'checked', check: { reviewId: row.reviewId, name: row.name, status: 'unavailable', pullRequests: [], unpublishedComments: 0, reason: 'Save your pending feedback, then rescan.' } })));
      }
    } finally { if (current === generation.current) setScanning(false); }
  }, [project.id]);

  useEffect(() => { void scan(); return () => { generation.current++; }; }, [scan]);

  const eligible = rows.filter(row => row.phase === 'checked' && row.check?.status === 'closed');
  const unpublished = eligible.reduce((count, row) => count + (row.check?.unpublishedComments || 0), 0);
  const checked = rows.filter(row => row.phase !== 'checking').length;

  async function remove(ids: string[]) {
    if (removalInFlight.current || scanning || !ids.length) return;
    removalInFlight.current = true;
    const current = ++generation.current;
    setRemoving(true); setError('');
    try {
      await flushPendingComments();
      const response = await window.reviewAPI.removeClosedReviews(project.id, ids);
      removedRef.current(response);
      if (current !== generation.current) return;
      const removed = new Set(response.removedIds);
      const retained = new Map(response.retained.map(check => [check.reviewId, check]));
      const savedIds = new Set(response.state.reviews.map(review => review.id));
      const metadataPending = response.retained.filter(check => !savedIds.has(check.reviewId)).length;
      setRetryIds(previous => [...previous.filter(id => !ids.includes(id)), ...response.retained.filter(check => check.status === 'unavailable').map(check => check.reviewId)]);
      setRows(previous => previous.map(row => removed.has(row.reviewId) ? { ...row, phase: 'removed', dataRemoved: true } : retained.has(row.reviewId) ? { ...row, phase: 'checked', dataRemoved: !savedIds.has(row.reviewId), check: retained.get(row.reviewId) } : row));
      setResult({ removed: response.removedIds.length + metadataPending, retained: response.retained.length - metadataPending, metadataPending });
    } catch (reason) {
      if (current === generation.current) {
        setError(message(reason));
        setRetryIds(previous => [...new Set([...previous, ...ids])]);
      }
    }
    finally { removalInFlight.current = false; if (current === generation.current) setRemoving(false); }
  }

  return <IntegrationDialog title="Clean up closed Bitbucket reviews" className="closed-review-cleanup-modal" onClose={onClose} busy={removing}>
    <div className="integration-body closed-review-cleanup-body">
      <p className="modal-introduction">Check saved reviews in <strong>{project.name}</strong>. Reviews whose pull requests are all closed can be removed from Branchline.</p>
      <div className="closed-review-scan-status" role="status"><span>{removing ? <><LoaderCircle size={14} className="spin" />Rechecking and removing closed reviews…</> : scanning ? <><LoaderCircle size={14} className="spin" />Checking reviews…</> : 'Review check complete'}</span><span>{checked} / {rows.length} checked</span></div>
      {error && <div className="integration-error" role="alert"><TriangleAlert size={14} /><span>{error}</span></div>}
      {result && <p className="closed-review-result" role="status">Removed {result.removed} {result.removed === 1 ? 'review' : 'reviews'}.{result.retained > 0 ? ` ${result.retained} ${result.retained === 1 ? 'review was' : 'reviews were'} kept after rechecking. See the reasons below.` : ''}{result.metadataPending > 0 ? ` Local cleanup still needs attention for ${result.metadataPending} ${result.metadataPending === 1 ? 'review' : 'reviews'}.` : ''}</p>}
      <ul className="closed-review-list" aria-label="Saved Bitbucket reviews">{rows.map(row => {
        const status = rowStatus(row); const Icon = status.icon;
        return <li key={row.reviewId} className={`closed-review-row closed-review-${status.tone}`} aria-label={row.name}>
          <div className="closed-review-row-heading"><Icon size={15} className={row.phase === 'checking' ? 'spin' : ''} aria-hidden="true" /><strong>{row.name}</strong><span className="closed-review-row-status">{status.label}</span></div>
          {row.phase !== 'removed' && row.check?.reason && <p className="closed-review-reason">{row.check.reason}</p>}
          {!!row.check?.unpublishedComments && <p className="closed-review-unpublished">{row.check.unpublishedComments} unpublished {row.check.unpublishedComments === 1 ? 'comment' : 'comments'}{row.phase === 'removed' || row.dataRemoved ? ' removed from Branchline.' : row.check.status === 'closed' ? ' will be removed from Branchline.' : ' saved in Branchline.'}</p>}
          {!!row.check?.pullRequests.length && <ul className="closed-review-prs" aria-label={`Pull requests for ${row.name}`}>{row.check.pullRequests.map(pr => <li key={`${pr.repositoryPath}#${pr.id}`}><IntegrationLink url={pr.url}>{pr.repoSlug} #{pr.id}<ExternalLink size={11} /></IntegrationLink><span>{pr.state.toLowerCase().replaceAll('_', ' ')}</span></li>)}</ul>}
        </li>;
      })}</ul>
      {!scanning && !eligible.length && !retryIds.length && !result && <p className="integration-note">No closed reviews to remove.</p>}
      {eligible.length > 0 && <div className="closed-review-removal-notice"><p>Removing a review deletes its local comments and review progress from Branchline. Pull requests, comments and branches in Bitbucket stay unchanged.</p>{unpublished > 0 && <strong>{unpublished} unpublished {unpublished === 1 ? 'comment will' : 'comments will'} also be removed.</strong>}<p>Each review is checked again before removal. Reviews that reopen or cannot be verified will be kept.</p></div>}
    </div>
    <div className="modal-footer"><button className="button button-secondary closed-review-rescan" type="button" disabled={scanning || removing || !reviews.length} onClick={() => void scan()}><RefreshCw size={13} />Rescan</button><button className="button button-secondary" type="button" disabled={removing} onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>{(retryIds.length > 0 || eligible.length > 0) && <button className="button button-danger" type="button" disabled={scanning || removing} onClick={() => void remove(retryIds.length ? retryIds : eligible.map(row => row.reviewId))}>{removing ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}{retryIds.length ? 'Retry removal' : `Remove ${eligible.length} closed ${eligible.length === 1 ? 'review' : 'reviews'}`}</button>}</div>
  </IntegrationDialog>;
}
