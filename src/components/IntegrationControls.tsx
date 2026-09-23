import { createPortal } from 'react-dom';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Circle, CirclePause, ExternalLink, FolderGit2, Ticket, GitMerge, GitPullRequest, LoaderCircle, Plus, RefreshCw, Send, Settings2, SkipForward, Trash2, TriangleAlert, X } from 'lucide-react';
import type { Project, Review, ReviewComment } from '../../shared/types';
import type { BranchReviewRepository, CommentPublication, FeedbackPreview, IntegrationState, JiraIssue, MergeOperation, MergePreview, ProjectIntegration, PullRequest, PullRequestFilter, RemoteRepositoryLoad, RemoteReviewState } from '../../shared/integrations';
import { isMergeComplete, pullRequestKey } from '../../shared/integrations';
import { flushPendingComments } from './commentAutosave';
import { repositoryMergeProgress } from './mergeProgress';
import './integrations.css';

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
const emptyProject = (): ProjectIntegration => ({ repositories: [], updateSubmodulePointers: false });
const human = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');

function Problem({ children }: { children: ReactNode }) {
  return <div className="integration-error" role="alert"><TriangleAlert size={14} /><span>{children}</span></div>;
}

export function IntegrationDialog({ title, onClose, children, busy = false, className = '' }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; className?: string }) {
  const titleId = useId();
  const container = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = () => { if (!busy) onClose(); };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => [...(container.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])].filter(item => item.offsetParent !== null);
    focusables()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop integration-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={container} className={`modal integration-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-header"><div><span className="eyebrow">BRANCHLINE · CONNECTED REVIEW</span><h2 id={titleId}>{title}</h2></div><button className="icon-button" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      {children}
    </div>
  </div>, document.body);
}

export function IntegrationLink({ url, children, className = '' }: { url: string; children: ReactNode; className?: string }) {
  const [error, setError] = useState('');
  return <><button type="button" role="link" className={`integration-link ${className}`} onClick={() => { setError(''); void window.reviewAPI.openIntegrationLink(url).catch(reason => setError(message(reason))); }}>{children}</button>{error && <span className="integration-link-error" role="alert">{error}</span>}</>;
}

export function ProjectIntegrationDialog({ project, onClose, onSaved, onAccounts }: { project: Project; onClose: () => void; onSaved: () => void; onAccounts: () => void }) {
  const [state, setState] = useState<IntegrationState | null>(null);
  const [value, setValue] = useState<ProjectIntegration>(emptyProject);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void window.reviewAPI.getIntegrations().then(result => { if (live) { setState(result); setValue(result.projects[project.id] || emptyProject()); } }).catch(reason => { if (live) setError(message(reason)); }).finally(() => { if (live) setBusy(''); });
    return () => { live = false; };
  }, [project.id]);
  async function discover() {
    setBusy('discover'); setError('');
    try {
      const discovered = await window.reviewAPI.discoverRepositories(project.id);
      setValue(previous => ({ ...previous, repositories: [...previous.repositories, ...discovered.filter(item => !previous.repositories.some(saved => saved.relativePath === item.relativePath))] }));
      if (!discovered.length) setError('No Bitbucket Cloud repositories were detected. Add a repository mapping below.');
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setError('');
    try { await window.reviewAPI.configureProjectIntegration(project.id, value); onSaved(); onClose(); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  return <IntegrationDialog title={`${project.name} integrations`} onClose={onClose} busy={!!busy}>
    <div className="integration-body"><p className="modal-introduction">Choose this project’s accounts and the repositories to include in connected reviews.</p>
      <div className="integration-field-pair">{(['bitbucket', 'jira'] as const).map(kind => <label key={kind}>{kind === 'jira' ? 'Jira account' : 'Bitbucket account'}<select aria-label={`${kind === 'jira' ? 'Jira' : 'Bitbucket'} account`} disabled={!!busy} value={value[kind === 'jira' ? 'jiraConnectionId' : 'bitbucketConnectionId'] || ''} onChange={event => setValue({ ...value, [kind === 'jira' ? 'jiraConnectionId' : 'bitbucketConnectionId']: event.target.value || undefined })}><option value="">Not connected</option>{state?.connections.filter(item => item.kind === kind).map(item => <option key={item.id} value={item.id}>{item.label || item.displayName} · {item.email}{item.connected === false ? ' (disconnected)' : ''}</option>)}</select></label>)}</div>
      <button type="button" className="integration-link" disabled={!!busy} onClick={onAccounts}><Settings2 size={12} />Manage connected accounts</button>
      <div className="integration-section-heading mapping-heading"><div><h3>Bitbucket repositories</h3><p>Paths are relative to your project; use <code>.</code> for the parent.</p></div><button className="button button-secondary" type="button" disabled={!!busy} onClick={() => void discover()}><RefreshCw size={12} className={busy === 'discover' ? 'spin' : ''} />Discover</button></div>
      <div className="repository-mappings">{value.repositories.map((mapping, index) => <div className="repository-mapping" key={index}><label>Local path<input className="text-input" aria-label={`Repository ${index + 1} local path`} value={mapping.relativePath} placeholder="." disabled={!!busy} onChange={event => setValue({ ...value, repositories: value.repositories.map((item, row) => row === index ? { ...item, relativePath: event.target.value } : item) })} /></label><label>Workspace<input className="text-input" aria-label={`Repository ${index + 1} workspace`} value={mapping.workspace} disabled={!!busy} onChange={event => setValue({ ...value, repositories: value.repositories.map((item, row) => row === index ? { ...item, workspace: event.target.value, uuid: undefined } : item) })} /></label><label>Repository<input className="text-input" aria-label={`Repository ${index + 1} slug`} value={mapping.repoSlug} disabled={!!busy} onChange={event => setValue({ ...value, repositories: value.repositories.map((item, row) => row === index ? { ...item, repoSlug: event.target.value, uuid: undefined } : item) })} /></label><button type="button" className="icon-button" disabled={!!busy} aria-label={`Remove repository ${index + 1}`} onClick={() => setValue({ ...value, repositories: value.repositories.filter((_, row) => row !== index) })}><X size={13} /></button>{mapping.relativePath && mapping.relativePath !== '.' && <div className="mapping-hierarchy"><label>Parent local path<input className="text-input" aria-label={`Repository ${index + 1} parent path`} placeholder="." value={mapping.parentRelativePath || ''} disabled={!!busy} onChange={event => setValue({ ...value, repositories: value.repositories.map((item, row) => row === index ? { ...item, parentRelativePath: event.target.value || undefined } : item) })} /></label><label>Submodule path in parent<input className="text-input" aria-label={`Repository ${index + 1} submodule path`} placeholder={mapping.relativePath} value={mapping.submodulePath || ''} disabled={!!busy} onChange={event => setValue({ ...value, repositories: value.repositories.map((item, row) => row === index ? { ...item, submodulePath: event.target.value || undefined } : item) })} /></label></div>}</div>)}</div>
      <button className="integration-link" type="button" disabled={!!busy} onClick={() => setValue({ ...value, repositories: [...value.repositories, { relativePath: '', workspace: '', repoSlug: '' }] })}><Plus size={12} />Add repository mapping</button>
      <label className="integration-checkbox pointer-setting"><input type="checkbox" disabled={!!busy} checked={value.updateSubmodulePointers} onChange={event => setValue({ ...value, updateSubmodulePointers: event.target.checked })} /><span><strong>Update submodule pointers when merging</strong><small>Merge children first, then review the pointer update before merging the parent.</small></span></label>
      {error && <Problem>{error}</Problem>}
    </div><div className="modal-footer"><button className="button button-secondary" disabled={!!busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!!busy || !state} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}Save integrations</button></div>
  </IntegrationDialog>;
}

export function PullRequestsDialog({ project, onClose, onOpened, onSettings }: { project: Project; onClose: () => void; onOpened: (review: Review) => void; onSettings: () => void }) {
  const [filter, setFilter] = useState<PullRequestFilter>('all');
  const [items, setItems] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState('');
  const request = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const generation = ++request.current;
    inFlight.current = true; setLoading(true); setError('');
    try { const result = await window.reviewAPI.listPullRequests(project.id, filter); if (generation === request.current) { setItems(result); setCheckedAt(new Date().toLocaleTimeString()); } }
    catch (reason) { if (generation === request.current) setError(message(reason)); }
    finally { if (generation === request.current) { inFlight.current = false; setLoading(false); } }
  }, [project.id, filter]);
  useEffect(() => {
    inFlight.current = false; setItems([]); void load();
    const visibleRefresh = () => { if (!document.hidden) void load(); };
    const interval = setInterval(visibleRefresh, 60000);
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    return () => { request.current++; clearInterval(interval); window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [load]);
  const groups = useMemo(() => {
    const result = new Map<string, PullRequest[]>();
    for (const item of items) { const key = JSON.stringify([item.sourceBranch, item.targetBranch]); result.set(key, [...(result.get(key) || []), item]); }
    return [...result.entries()];
  }, [items]);
  async function open(key: string, selected: PullRequest[]) {
    setOpening(key); setError('');
    try { await flushPendingComments(); onOpened(await window.reviewAPI.openPullRequestReview(project.id, selected.slice(0, 1).map(pr => ({ repositoryPath: pr.repository.relativePath, prId: pr.id })))); }
    catch (reason) { setError(message(reason)); }
    finally { setOpening(''); }
  }
  return <IntegrationDialog title="Pull requests" onClose={onClose} busy={!!opening}>
    <div className="integration-body"><div className="pr-list-controls"><div className="integration-segments" aria-label="Filter pull requests">{(['all', 'reviewer', 'author'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} disabled={!!opening} onClick={() => setFilter(value)}>{value === 'all' ? 'All open' : value === 'reviewer' ? 'Needs my review' : 'Created by me'}</button>)}</div><button type="button" className="icon-button" aria-label="Refresh pull requests" title="Refresh pull requests" disabled={loading || !!opening} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
      <p className="integration-note">{project.name} · Opening a PR includes this branch across every mapped repository, including repositories without a PR.{checkedAt && ` Checked ${checkedAt}.`}</p>
      {error && <Problem>{error}</Problem>}
      {!items.length && <div className="integration-empty" role="status">{loading ? <LoaderCircle className="spin" size={21} /> : <GitPullRequest size={23} />}<strong>{loading ? 'Finding pull requests…' : 'No open pull requests'}</strong><span>{loading ? 'Reading your project’s Bitbucket repositories.' : 'Try another filter or check the project’s repository mappings.'}</span></div>}
      <div className="pr-groups">{groups.map(([key, prs]) => {
        const selected = prs.filter(pr => !pr.unsupportedReason);
        return <section className="pr-group" key={key}><div className="pr-group-heading"><code title={`${prs[0].sourceBranch} → ${prs[0].targetBranch}`}>{prs[0].sourceBranch}<span> → </span>{prs[0].targetBranch}</code><button className="button button-primary" type="button" disabled={!selected.length || !!opening} onClick={() => void open(key, selected)}>{opening === key ? <LoaderCircle className="spin" size={12} /> : <GitPullRequest size={12} />}{opening === key ? 'Opening review…' : 'Review branch'}</button></div>{prs.map(pr => <div className="pr-row" key={pullRequestKey(pr)}><GitPullRequest size={14} aria-hidden="true" /><div><IntegrationLink url={pr.url}>{pr.title}<ExternalLink size={11} /></IntegrationLink><span><code>{pr.repository.relativePath === '.' ? pr.repository.repoSlug : pr.repository.relativePath}</code> · #{pr.id} · {pr.author.name}{pr.draft ? ' · Draft' : ''}</span>{pr.unsupportedReason && <span className="integration-inline-error">{pr.unsupportedReason}</span>}</div></div>)}</section>;
      })}</div>
    </div><div className="modal-footer"><span className="modal-local-note">Refreshes every minute while visible</span><button className="button button-secondary" disabled={!!opening} onClick={onSettings}><Settings2 size={12} />Project integrations</button><button className="button button-secondary" disabled={!!opening} onClick={onClose}>Close</button></div>
  </IntegrationDialog>;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return; }
}

/** Render ADF as React text/elements. Never trust remote HTML or fetch embedded media. */
export function JiraDescription({ value }: { value: unknown }) {
  let remaining = 2500;
  function render(node: unknown, depth = 0): ReactNode {
    if (--remaining < 0 || depth > 24 || !node || typeof node !== 'object') return null;
    const item = node as { type?: string; text?: unknown; content?: unknown[]; attrs?: Record<string, unknown>; marks?: { type?: string; attrs?: Record<string, unknown> }[] };
    const children = Array.isArray(item.content) ? item.content.map((child, index) => <Fragment key={index}>{render(child, depth + 1)}</Fragment>) : null;
    if (item.type === 'text') {
      let text: ReactNode = typeof item.text === 'string' ? item.text : '';
      for (const mark of Array.isArray(item.marks) ? item.marks : []) {
        if (mark.type === 'strong') text = <strong>{text}</strong>;
        else if (mark.type === 'em') text = <em>{text}</em>;
        else if (mark.type === 'code') text = <code>{text}</code>;
        else if (mark.type === 'strike') text = <s>{text}</s>;
        else if (mark.type === 'link') { const url = safeUrl(mark.attrs?.href); if (url) text = <IntegrationLink url={url}>{text}</IntegrationLink>; }
      }
      return text;
    }
    switch (item.type) {
      case 'paragraph': return <p>{children}</p>;
      case 'heading': return <h4>{children}</h4>;
      case 'bulletList': return <ul>{children}</ul>;
      case 'orderedList': return <ol>{children}</ol>;
      case 'listItem': return <li>{children}</li>;
      case 'blockquote': return <blockquote>{children}</blockquote>;
      case 'codeBlock': return <pre><code>{children}</code></pre>;
      case 'hardBreak': return <br />;
      case 'rule': return <hr />;
      case 'table': return <table><tbody>{children}</tbody></table>;
      case 'tableRow': return <tr>{children}</tr>;
      case 'tableCell': return <td>{children}</td>;
      case 'tableHeader': return <th>{children}</th>;
      case 'mention': case 'status': return <span>{typeof item.attrs?.text === 'string' ? item.attrs.text : ''}</span>;
      case 'emoji': return <span>{typeof item.attrs?.text === 'string' ? item.attrs.text : typeof item.attrs?.shortName === 'string' ? item.attrs.shortName : ''}</span>;
      case 'inlineCard': { const url = safeUrl(item.attrs?.url); return url ? <IntegrationLink url={url}>{url}</IntegrationLink> : null; }
      case 'media': return <span className="integration-note">[Attachment — view in Jira]</span>;
      default: return children;
    }
  }
  return <div className="jira-description">{typeof value === 'string' ? <p>{value}</p> : value ? render(value) : <p className="integration-note">No description provided.</p>}</div>;
}

export function JiraIssuePanel({ review, ticket, refreshKey = '', onTicketChanged }: { review: Review; ticket: string | null; refreshKey?: string; onTicketChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [key, setKey] = useState(ticket || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true); setError('');
    try { const result = await window.reviewAPI.getJiraIssue(review.id); if (generation === request.current) { setIssue(result); setKey(result.key); } }
    catch (reason) { if (generation === request.current) { setIssue(null); setError(message(reason)); } }
    finally { if (generation === request.current) setLoading(false); }
  }, [review.id]);
  useEffect(() => { setIssue(null); setKey(ticket || ''); void load(); return () => { request.current++; }; }, [load, ticket, refreshKey]);
  async function changeTicket(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try { await window.reviewAPI.setReviewTicket(review.id, key.trim()); onTicketChanged?.(); await load(); }
    catch (reason) { setError(message(reason)); setLoading(false); }
  }
  return <>
    <button className="button button-secondary integration-context-button jira-ticket-button" type="button" aria-label={`View Jira ticket${issue?.key || ticket ? ` ${issue?.key || ticket}` : ''}`} aria-haspopup="dialog" title={error ? `Jira ticket: ${error}` : issue?.title || 'View Jira ticket'} onClick={() => setOpen(true)}>
      {loading ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Ticket size={13} aria-hidden="true" />}<span>{issue?.key || ticket || 'Jira ticket'}</span>{error && <TriangleAlert size={12} className="integration-context-warning" aria-label="Ticket unavailable" />}
    </button>
    {open && <IntegrationDialog title="Jira ticket" onClose={() => setOpen(false)}>
      <div className="integration-body jira-ticket-body">
        <form className="jira-ticket-form" onSubmit={event => void changeTicket(event)}><label htmlFor={`review-ticket-key-${review.id}`}>Ticket</label><input id={`review-ticket-key-${review.id}`} aria-label="Review ticket key" className="text-input" placeholder="APP-123" value={key} onChange={event => setKey(event.target.value)} disabled={loading} /><button type="submit" className="button button-secondary" disabled={loading}>Use ticket</button><button className="icon-button" type="button" aria-label="Refresh Jira ticket" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={13} /></button></form>
        {loading && <p className="integration-loading" role="status"><LoaderCircle size={14} className="spin" />Loading ticket…</p>}
        {error && <Problem>{error}</Problem>}
        {issue && <><div className="jira-ticket-heading"><span className="jira-issue-key">{issue.key}</span><h3>{issue.title}</h3></div><JiraDescription value={issue.description} /></>}
      </div>
      <div className="modal-footer">{issue && <IntegrationLink url={issue.url} className="button button-secondary"><ExternalLink size={12} />Open in Jira<span className="sr-only">: {issue.key}</span></IntegrationLink>}<button className="button button-primary" type="button" onClick={() => setOpen(false)}>Done</button></div>
    </IntegrationDialog>}
  </>;
}

export function PublicationStatus({ publication, comment }: { publication?: CommentPublication; comment?: Pick<ReviewComment, 'body' | 'resolved'> }) {
  const dirty = publication?.acknowledged && comment && (publication.acknowledged.body !== comment.body || publication.acknowledged.resolved !== comment.resolved);
  const state = !publication ? 'draft' : dirty && publication.state === 'synced' ? 'draft' : publication.state;
  const label = state === 'synced' ? 'Published' : state === 'unknown' ? 'Delivery unknown' : state === 'conflict' ? 'Conflict' : state === 'sending' ? 'Publishing…' : state === 'failed' ? 'Publish failed' : dirty ? 'Changes to publish' : 'Local draft';
  return <span className={`publication-status publication-${state}`} title={publication?.error} role="status">{label}</span>;
}

function FeedbackPullRequests({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (!pullRequests.length) return null;
  return <section className="feedback-pull-requests" aria-label="Pull requests in Bitbucket">
    <div className="integration-section-heading"><div><h3>Continue in Bitbucket</h3><p>View published comments and request changes on the pull request.</p></div></div>
    <ul>{pullRequests.map(pr => <li key={pullRequestKey(pr)}>
      <GitPullRequest size={15} aria-hidden="true" />
      <div><strong>{pr.repository.repoSlug} <span>#{pr.id}</span></strong><code>{pr.repository.workspace}/{pr.repository.repoSlug}</code></div>
      <div className="feedback-pr-action"><IntegrationLink url={pr.url} className="feedback-open-pr">Open PR<ExternalLink size={12} aria-hidden="true" /><span className="sr-only">: {pr.repository.repoSlug} #{pr.id}</span></IntegrationLink></div>
    </li>)}</ul>
  </section>;
}

function repositoryRows(pullRequests: PullRequest[], repositories?: BranchReviewRepository[]): BranchReviewRepository[] {
  const rows = [...(repositories || [])];
  for (const pr of pullRequests) {
    const index = rows.findIndex(row => row.repository.relativePath === pr.repository.relativePath);
    if (index < 0) rows.push({ repository: pr.repository, sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch, status: 'pull-request', prId: pr.id });
    else rows[index] = { ...rows[index], prId: pr.id };
  }
  return rows.sort((a, b) => {
    const depth = (row: BranchReviewRepository) => row.repository.relativePath === '.' ? 0 : row.repository.relativePath.split('/').length;
    return depth(b) - depth(a) || a.repository.relativePath.localeCompare(b.repository.relativePath);
  });
}

function branchStatus(row: BranchReviewRepository, pr?: PullRequest) {
  if (pr?.state === 'MERGED') return { label: 'Merged', tone: 'complete', icon: Check };
  if (pr?.state === 'DECLINED') return { label: 'Declined', tone: 'waiting', icon: SkipForward };
  if (pr?.state === 'SUPERSEDED') return { label: 'Closed', tone: 'waiting', icon: SkipForward };
  if (row.creation?.state === 'sending') return { label: 'Creating PR…', tone: 'active', icon: LoaderCircle };
  if (row.creation?.state === 'unknown') return { label: 'PR creation unconfirmed', tone: 'warning', icon: CirclePause };
  if (row.creation?.state === 'failed') return { label: 'PR creation failed', tone: 'warning', icon: TriangleAlert };
  if (row.status === 'unavailable') return { label: 'Unavailable', tone: 'warning', icon: TriangleAlert };
  if (row.status === 'missing-branch') return { label: 'Branch missing', tone: 'waiting', icon: SkipForward };
  if (row.status === 'no-changes') return { label: 'No changes', tone: row.cleanup?.state === 'deleted' ? 'complete' : 'waiting', icon: SkipForward };
  if (row.status === 'changes') return { label: 'Changes without a PR', tone: 'waiting', icon: GitPullRequest };
  return { label: 'PR exists', tone: 'complete', icon: GitPullRequest };
}

function CleanupStatus({ state }: { state?: NonNullable<BranchReviewRepository['cleanup']>['state'] }) {
  if (!state || ['pending', 'checking', 'sending'].includes(state)) return null;
  return <span className={`merge-cleanup merge-cleanup-${state}`} title={state === 'deleted' ? 'Remote source branch deleted' : state === 'retained' ? 'Remote source branch still exists' : state === 'skipped' ? 'No source branch to delete' : 'Remote source branch deletion could not be confirmed'}>{state === 'deleted' ? <Trash2 size={11} aria-hidden="true" /> : state === 'skipped' ? <SkipForward size={11} aria-hidden="true" /> : <TriangleAlert size={11} aria-hidden="true" />}{state === 'deleted' ? 'Deleted' : state === 'retained' ? 'Retained' : state === 'skipped' ? 'Cleanup skipped' : 'Deletion unconfirmed'}</span>;
}

function loadStatus(load: RemoteRepositoryLoad) {
  return load.phase === 'ready' ? { label: 'Ready to review', tone: 'complete', icon: Check }
    : load.phase === 'failed' ? { label: 'Could not load', tone: 'warning', icon: TriangleAlert }
    : { label: load.phase === 'queued' ? 'Queued…' : load.phase === 'files' ? 'Loading files…' : 'Checking branch…', tone: 'active', icon: LoaderCircle };
}

export function RemoteLoadRepositories({ repositories }: { repositories: RemoteRepositoryLoad[] }) {
  const finished = repositories.filter(row => row.phase === 'ready' || row.phase === 'failed').length;
  return <section className="remote-load-repositories" aria-label="Repository loading progress" aria-live="polite">
    <div className="remote-load-heading"><strong>Repositories</strong><span>{finished} / {repositories.length} checked</span></div>
    <ul>{repositories.map(row => {
      const status = loadStatus(row); const Icon = status.icon;
      return <li key={row.repository.relativePath} className={`remote-load-row branch-status-${status.tone}`} aria-label={`${row.repository.repoSlug} loading progress`}>
        <Icon size={15} className={status.tone === 'active' ? 'spin' : ''} aria-hidden="true" /><div><strong>{row.repository.repoSlug}</strong><code>{row.repository.relativePath === '.' ? 'Parent repository' : row.repository.relativePath}</code></div><span>{status.label}</span>{row.error && <small>{row.error}</small>}
      </li>;
    })}</ul>
  </section>;
}

function BranchReviewRepositories({ remote, loadingRepositories }: { remote: RemoteReviewState; loadingRepositories?: RemoteRepositoryLoad[] }) {
  const [open, setOpen] = useState(false);
  const rows = repositoryRows(remote.pullRequests, remote.repositories);
  for (const load of loadingRepositories || []) if (!rows.some(row => row.repository.relativePath === load.repository.relativePath)) rows.push({ repository: load.repository, sourceBranch: '', targetBranch: '', status: 'no-changes' });
  const unavailable = rows.filter(row => row.status === 'unavailable' && (!loadingRepositories || loadingRepositories.find(load => load.repository.relativePath === row.repository.relativePath)?.phase === 'failed')).length;
  const failedLoads = loadingRepositories?.filter(row => row.phase === 'failed').length || 0;
  const errors = Math.max(unavailable, failedLoads);
  const loaded = loadingRepositories?.filter(row => row.phase === 'ready' || row.phase === 'failed').length;
  const loading = !!loadingRepositories?.some(row => row.phase !== 'ready' && row.phase !== 'failed');
  const statusLabel = loadingRepositories ? `${loaded} / ${loadingRepositories.length} loaded` : `${rows.length} repositories`;
  return <>
    <button className="button button-secondary integration-context-button repository-context-button" type="button" aria-label={`Repositories: ${statusLabel}${errors ? `, ${errors} unavailable` : ''}`} aria-haspopup="dialog" title={`Repositories in this review · ${statusLabel}${errors ? ` · ${errors} unavailable` : ''}`} onClick={() => setOpen(true)}>
      {loading ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <FolderGit2 size={13} aria-hidden="true" />}<span className="repository-context-label">Repositories</span><span className="integration-context-count">{loadingRepositories ? `${loaded}/${loadingRepositories.length}` : rows.length}</span>{errors > 0 && <span className="integration-context-warning" aria-hidden="true"><TriangleAlert size={12} />{errors}</span>}
    </button>
    {open && <IntegrationDialog title="Repositories in this review" onClose={() => setOpen(false)}>
      <div className="integration-body"><p className="modal-introduction" role="status">{statusLabel}{errors ? ` · ${errors} unavailable` : ''}. Files are ready to review as each repository loads.</p>
        <div className="branch-review-repositories"><ul aria-label="Branch review repositories">{rows.map(row => {
          const pr = remote.pullRequests.find(pr => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId);
          const load = loadingRepositories?.find(load => load.repository.relativePath === row.repository.relativePath);
          const status = load && load.phase !== 'ready' ? loadStatus(load) : branchStatus(row, pr);
          const Icon = status.icon;
          return <li key={row.repository.relativePath} aria-label={`${row.repository.repoSlug} branch review`}>
            <Icon className={status.tone === 'active' ? 'spin' : ''} size={13} aria-hidden="true" />
            <div><strong>{row.repository.repoSlug}</strong><code>{row.repository.relativePath === '.' ? 'Parent repository' : row.repository.relativePath}</code></div>
            <span className={`branch-review-status branch-status-${status.tone}`}>{status.label}</span>
            {pr && <IntegrationLink url={pr.url}>Open PR #{pr.id}<ExternalLink size={10} /></IntegrationLink>}
            {(load?.error || row.error || row.creation?.error) && <span className="integration-inline-error">{load?.error || row.error || row.creation?.error}</span>}
          </li>;
        })}</ul></div>
      </div>
      <div className="modal-footer"><button className="button button-primary" type="button" onClick={() => setOpen(false)}>Done</button></div>
    </IntegrationDialog>}
  </>;
}

export function MergeProgressView({ pullRequests, repositories, operation, action = operation?.action || 'merge', checking = false, running = false }: { pullRequests: PullRequest[]; repositories?: BranchReviewRepository[]; operation?: MergeOperation; action?: 'approve' | 'merge'; checking?: boolean; running?: boolean }) {
  const rows = repositoryRows(pullRequests, repositories).map(row => {
    const pr = pullRequests.find(pr => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId);
    const item = pr && operation?.items.find(progress => progress.prKey === pullRequestKey(pr));
    return { row, pr, item, ...repositoryMergeProgress({ row, pr, item, operation, action, checking, running }) };
  });
  const finished = rows.filter(row => row.finished).length;
  const allMerged = action === 'merge' && !!operation?.items.length && operation.items.every(item => item.merge === 'merged');
  const title = operation?.state === 'paused' ? 'Operation paused'
    : operation?.state === 'complete' ? action === 'merge' ? finished === rows.length ? 'Repositories complete' : 'Branch cleanup needs attention' : 'Repositories approved'
    : running || operation?.state === 'running' ? action === 'merge' ? allMerged ? 'Deleting branches' : 'Merging repositories' : 'Approving repositories'
    : checking ? 'Checking repositories…' : 'Repositories';
  const icons = { spinner: LoaderCircle, check: Check, skip: SkipForward, warning: TriangleAlert, pause: CirclePause, circle: Circle, pr: GitPullRequest };
  return <section className="merge-progress" aria-label="Pull request operation progress" aria-live="polite">
    <div className="integration-section-heading"><h3>{title}</h3><span className="merge-progress-count" title="Completed repository workflows">{finished} / {rows.length}</span></div>
    <ul className="merge-repository-list" aria-label="Repositories">{rows.map(({ row, pr, item, status, cleanup, detail, error }) => {
      const Icon = icons[status.icon];
      return <li className={`merge-progress-row merge-row-${status.tone}`} key={row.repository.relativePath} aria-label={pr ? `${pr.repository.repoSlug} pull request ${pr.id}` : `${row.repository.repoSlug} branch cleanup`}>
        <span className={`merge-repository-icon ${status.tone === 'active' ? 'is-active' : ''}`} aria-hidden="true"><Icon className={status.tone === 'active' ? 'spin' : ''} size={16} /></span>
        <div className="merge-repository-details"><div className="merge-repository-name"><strong>{row.repository.repoSlug}</strong>{pr && <IntegrationLink url={pr.url}>#{pr.id}<ExternalLink size={10} /></IntegrationLink>}</div><span className="merge-repository-path">{row.repository.relativePath === '.' ? 'Parent repository' : row.repository.relativePath}</span><code className="merge-repository-branches">{row.sourceBranch}<span> → </span>{row.targetBranch}</code></div>
        <div className="merge-repository-result"><span className="merge-repository-status">{status.label}</span>{detail && <span className="merge-repository-path">{detail}</span>}<CleanupStatus state={cleanup} /></div>
        {item?.pointerState === 'review' && <span className="pointer-progress">Pointer changes are ready. Return to the diff, review them, then resume.</span>}
        {error && <span className="integration-inline-error">{error}</span>}
      </li>;
    })}</ul>
    {operation?.error && <Problem>{operation.error}</Problem>}
  </section>;
}

export function RemoteReviewControls({ review, remote, onRemote, onChanged, onReanchor, onMergeComplete, jiraLink, loadingRepositories, reviewLoading = false }: { review: Review; remote: RemoteReviewState | null; onRemote: (state: RemoteReviewState) => void; onChanged: () => Promise<boolean>; onReanchor: (commentId: string) => void; onMergeComplete: (state: RemoteReviewState) => Promise<void>; jiraLink: { key: string; url: string } | null; loadingRepositories?: RemoteRepositoryLoad[]; reviewLoading?: boolean }) {
  const [dialog, setDialog] = useState<'publish' | 'approve' | 'merge' | null>(null);
  const [feedback, setFeedback] = useState<FeedbackPreview | null>(null);
  const [merge, setMerge] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [jiraError, setJiraError] = useState('');
  const [unknownIds, setUnknownIds] = useState<Record<string, string>>({});
  const [checkedDelivery, setCheckedDelivery] = useState<Record<string, boolean>>({});
  const latest = useRef({ onRemote, onChanged }); latest.current = { onRemote, onChanged };
  useEffect(() => {
    return window.reviewAPI.onRemoteReviewChanged(event => {
      if (event.reviewId === review.id) {
        latest.current.onRemote(event.state);
      }
    });
  }, [review.id]);
  async function preview(action: 'publish' | 'approve' | 'merge') {
    setDialog(action); setLoading(true); setError(''); setResult(''); setJiraError(''); setFeedback(null); setMerge(null);
    try {
      await flushPendingComments();
      if (action === 'merge' && isMergeComplete(remote)) {
        // Completion is already confirmed. Retrying local removal must also
        // work after the server saved it but its response was lost.
        setMerge({ pullRequests: remote!.pullRequests, repositories: remote!.repositories, operation: remote!.operation, blockers: [], warnings: [], updateSubmodulePointers: false });
        return;
      }
      if (action === 'publish') {
        if (!await onChanged()) { setDialog(null); return; }
        setFeedback(await window.reviewAPI.previewFeedback(review.id));
      } else setMerge(await window.reviewAPI.previewMerge(review.id, action));
      const state = await window.reviewAPI.getRemoteReview(review.id);
      if (state) onRemote(state);
    }
    catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  }
  async function run() {
    if (!dialog || busy) return;
    setBusy(true); setError(''); setResult('');
    try {
      await flushPendingComments();
      if (dialog === 'merge' && isMergeComplete(remote)) {
        await onMergeComplete(remote!);
        setDialog(null);
        return;
      }
      const state = dialog === 'publish' ? await window.reviewAPI.publishFeedback(review.id) : await window.reviewAPI.runPullRequestAction(review.id, dialog);
      onRemote(state);
      if (dialog === 'merge' && isMergeComplete(state)) {
        await onMergeComplete(state);
        setDialog(null);
        return;
      }
      if (!await onChanged()) { setDialog(null); return; }
      if (dialog === 'publish') { const next = await window.reviewAPI.previewFeedback(review.id); setFeedback(next); setResult(next.items.length ? 'Completed items are saved. Review the remaining items below.' : 'Feedback published to Bitbucket.'); }
      else { setMerge(await window.reviewAPI.previewMerge(review.id, dialog)); }
    } catch (reason) { setError(message(reason)); const state = await window.reviewAPI.getRemoteReview(review.id).catch(() => null); if (state) onRemote(state); }
    finally { setBusy(false); }
  }
  async function conflict(commentId: string, choice: 'local' | 'remote') {
    setBusy(true); setError('');
    try { await flushPendingComments(); await window.reviewAPI.resolveCommentConflict(review.id, commentId, choice); if (!await onChanged()) { setDialog(null); return; } setFeedback(await window.reviewAPI.previewFeedback(review.id)); const state = await window.reviewAPI.getRemoteReview(review.id); if (state) onRemote(state); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function reconcileUnknown(commentId: string, remoteId: number | null) {
    setBusy(true); setError('');
    try {
      onRemote(await window.reviewAPI.resolveUnknownPublication(review.id, commentId, remoteId));
      if (!await onChanged()) { setDialog(null); return; } setFeedback(await window.reviewAPI.previewFeedback(review.id));
      setCheckedDelivery(previous => ({ ...previous, [commentId]: false }));
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function openTicket() {
    setJiraError('');
    try { await window.reviewAPI.openJiraTicket(review.id); }
    catch (reason) { setJiraError(message(reason)); }
  }
  const operation = remote?.operation || merge?.operation;
  const visibleOperation = operation?.action === dialog ? operation : undefined;
  const publishable = !!feedback && !feedback.blockers.length && feedback.items.some(item => item.state !== 'unknown' && item.state !== 'conflict');
  // A task can finish in Bitbucket while Branchline is paused. Resuming still
  // needs to reconcile its cleanup and close the review when every PR is merged.
  const pendingRepositories = merge?.repositories || remote?.repositories || [];
  const needsPullRequest = pendingRepositories.some(row => row.status === 'changes' && !row.prId);
  const pendingPullRequests = merge?.pullRequests || remote?.pullRequests || [];
  const needsCleanup = pendingRepositories.some(row => {
    const pr = pendingPullRequests.find(pr => pr.repository.relativePath === row.repository.relativePath && pr.id === row.prId);
    const item = pr && operation?.items.find(item => item.prKey === pullRequestKey(pr));
    if (pr && item?.merge !== 'merged' && pr.state !== 'MERGED') return false;
    if (!pr && !['no-changes', 'missing-branch'].includes(row.status)) return false;
    return !['deleted', 'skipped'].includes(row.cleanup?.state || item?.cleanup || '');
  }) || operation?.action === 'merge' && operation.items.some(item => item.merge === 'merged' && item.cleanup !== 'deleted');
  const readyToFinish = isMergeComplete(remote);
  const resumeNeeded = operation?.state === 'paused' || operation?.action === 'merge' && operation.state === 'complete' && !readyToFinish;
  const canMerge = !!merge && !merge.blockers.length && (readyToFinish || needsPullRequest || needsCleanup || merge.pullRequests.some(pr => pr.state === 'OPEN') || visibleOperation?.action === 'merge' && resumeNeeded);
  const canApprove = !!merge && !merge.blockers.length && (needsPullRequest || merge.pullRequests.some(pr => pr.state === 'OPEN' && !pr.draft));
  const completed = dialog === 'approve' && operation?.state === 'complete' && operation.action === dialog && !needsPullRequest;
  const progressPullRequests = busy ? remote?.pullRequests || merge?.pullRequests || [] : merge?.pullRequests || remote?.pullRequests || [];
  const repositoryProgress = busy || loading ? remote?.repositories || merge?.repositories : merge?.repositories || remote?.repositories;
  return <><div className="remote-review-controls" aria-label="Bitbucket review controls">
    {remote && <BranchReviewRepositories remote={remote} loadingRepositories={loadingRepositories} />}
    <div className="remote-review-actions">
      {operation && (operation.state !== 'complete' || resumeNeeded || readyToFinish) && <button type="button" className="button button-secondary remote-progress-button" aria-label={readyToFinish ? 'Finish review' : resumeNeeded ? 'Resume operation' : 'View progress'} title={readyToFinish ? 'Remove the completed review from Branchline' : resumeNeeded ? 'Merge or branch cleanup needs attention. Resume operation.' : 'View operation progress'} disabled={reviewLoading} onClick={() => void preview(operation.action)}>{readyToFinish ? <Check size={13} /> : resumeNeeded ? <CirclePause size={13} /> : <LoaderCircle size={13} className="spin" />}<span>{readyToFinish ? 'Finish review' : resumeNeeded ? 'Resume operation' : 'View progress'}</span></button>}
      <button className="button button-secondary remote-secondary-action" type="button" aria-label="Publish feedback" disabled={reviewLoading} title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Publish feedback'} onClick={() => void preview('publish')}><Send size={12} /><span>Publish feedback</span></button>
      <button className="button button-secondary remote-secondary-action" type="button" aria-label="Approve" disabled={reviewLoading} title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Approve'} onClick={() => void preview('approve')}><Check size={13} /><span>Approve</span></button>
      <button className="button button-primary" type="button" aria-label="Approve and merge" disabled={reviewLoading} title={reviewLoading ? 'Wait for all repositories to finish loading.' : 'Approve and merge'} onClick={() => void preview('merge')}><GitMerge size={13} /><span>Approve and merge</span></button>
    </div>
  </div>
    {dialog && <IntegrationDialog title={dialog === 'publish' ? 'Publish feedback' : dialog === 'approve' ? 'Approve pull requests' : 'Approve and merge'} busy={busy || loading} onClose={() => setDialog(null)}>
      <div className="integration-body"><p className="modal-introduction">{dialog === 'publish' ? 'Each comment goes to its file and exact lines in Bitbucket. Missing PRs are created when you publish; drafts remain saved locally.' : dialog === 'approve' ? 'Approve changes across this branch with your connected Bitbucket account. Missing PRs are created for repositories with changes.' : 'All required pull requests must merge successfully before any source branches are deleted. Repositories without changes wait for that cleanup stage. Progress is saved so you can resume.'}</p>{loading && dialog === 'publish' && <p className="integration-loading" role="status"><LoaderCircle className="spin" size={15} />Checking the branch across all repositories…</p>}{error && <Problem>{error}</Problem>}{result && <p className="integration-note" role="status">{result}</p>}
        {dialog === 'publish' && <FeedbackPullRequests pullRequests={remote?.pullRequests || []} />}
        {dialog === 'publish' && feedback && <><div className="feedback-publication-list">{feedback.items.map(item => <article className="feedback-publication" key={item.commentId}><div><code>{item.repositoryPath} · {item.createsPullRequest ? 'Create PR on publish' : `#${item.prId}`}</code><span className={`publication-status publication-${item.state}`}>{item.state === 'synced' ? 'Changes to publish' : human(item.state)}</span><span className="feedback-publication-action">{human(item.action)}</span></div><strong>{item.path} · {item.lineStart ? `L${item.lineStart}${item.lineEnd !== item.lineStart ? `–${item.lineEnd}` : ''}` : 'File comment'} · {item.side === 'deletions' ? 'Original' : 'New version'}</strong><p>{item.body}</p>{item.error && <Problem>{item.error}</Problem>}{item.state === 'unknown' && <div className="unknown-delivery"><p className="integration-note">Delivery is uncertain. Check Bitbucket before deciding whether to retry.</p>{remote?.pullRequests.filter(pr => pr.repository.relativePath === item.repositoryPath && pr.id === item.prId).map(pr => <IntegrationLink key={pullRequestKey(pr)} url={pr.url}>Check PR #{pr.id} in Bitbucket<ExternalLink size={11} /></IntegrationLink>)}<div className="unknown-comment-link"><input className="text-input" type="text" inputMode="numeric" aria-label="Existing Bitbucket comment ID" placeholder="Existing comment ID" value={unknownIds[item.commentId] || ''} disabled={busy} onChange={event => setUnknownIds(previous => ({ ...previous, [item.commentId]: event.target.value }))} /><button type="button" className="button button-secondary" disabled={busy || !/^[1-9]\d*$/.test(unknownIds[item.commentId] || '') || !Number.isSafeInteger(Number(unknownIds[item.commentId]))} onClick={() => void reconcileUnknown(item.commentId, Number(unknownIds[item.commentId]))}>Link existing comment</button></div><label className="integration-checkbox"><input type="checkbox" checked={!!checkedDelivery[item.commentId]} disabled={busy} onChange={event => setCheckedDelivery(previous => ({ ...previous, [item.commentId]: event.target.checked }))} /><span>I checked Bitbucket: this comment was not posted.</span></label><button type="button" className="integration-link" disabled={busy || !checkedDelivery[item.commentId]} onClick={() => void reconcileUnknown(item.commentId, null)}>Allow retry</button></div>}{item.state === 'conflict' && <div className="publication-conflict"><span>Bitbucket version</span><p>{item.remote?.deleted ? 'Deleted in Bitbucket' : item.remote?.body}</p><div className="integration-inline-actions"><button type="button" disabled={busy} onClick={() => void conflict(item.commentId, 'local')}>Keep local version</button><button type="button" disabled={busy} onClick={() => void conflict(item.commentId, 'remote')}>Use Bitbucket version</button></div></div>}{!remote?.publications[item.commentId]?.remoteId && review.comments.some(comment => comment.id === item.commentId) && item.state !== 'sending' && item.state !== 'unknown' && <button type="button" className="integration-link" disabled={busy} onClick={() => { setDialog(null); onReanchor(item.commentId); }}>Choose current lines…</button>}</article>)}</div>{!feedback.items.length && <p className="integration-note">No feedback to publish.</p>}{feedback.blockers.map((blocker, index) => <Problem key={index}>{blocker}</Problem>)}</>}
        {dialog !== 'publish' && <><MergeProgressView pullRequests={progressPullRequests} repositories={repositoryProgress} operation={visibleOperation} action={dialog} checking={loading} running={busy} />{merge && <>{dialog === 'merge' && !readyToFinish && <p className="integration-note pointer-preview">Submodule pointers: {merge.updateSubmodulePointers ? 'update after children merge; review before parent merge' : 'leave unchanged'}</p>}{merge.warnings.map((warning, index) => <p className="integration-note" key={index}>{warning}</p>)}{merge.blockers.map((blocker, index) => <Problem key={index}>{blocker}</Problem>)}</>}{jiraError && <Problem>{jiraError}</Problem>}</>}
      </div><div className="modal-footer">{dialog !== 'publish' && jiraLink && <button className="button button-secondary merge-jira-button" title={`Open ${jiraLink.key} to update its status in Jira`} onClick={() => void openTicket()}><ExternalLink size={12} />Open in Jira</button>}<button className="button button-secondary" disabled={busy || loading} onClick={() => setDialog(null)}>{visibleOperation && resumeNeeded ? 'Return to review' : 'Close'}</button>{dialog === 'publish' && <button className="button button-secondary" disabled={busy || loading} onClick={() => void preview('publish')}>Refresh delivery status</button>}<button className="button button-primary" disabled={busy || loading || !!completed || (dialog === 'publish' ? !publishable : dialog === 'merge' ? !canMerge : !canApprove)} onClick={() => void run()}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? 'Working…' : dialog === 'publish' ? 'Publish to Bitbucket' : completed ? 'Complete' : dialog === 'merge' && readyToFinish ? 'Finish review' : visibleOperation && resumeNeeded ? 'Resume operation' : dialog === 'approve' ? 'Approve pull requests' : 'Approve, merge and delete branches'}</button></div>
    </IntegrationDialog>}
  </>;
}
