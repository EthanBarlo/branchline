import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Circle, CirclePause, ExternalLink, GitMerge, GitPullRequest, LoaderCircle, Plus, RefreshCw, Send, Settings2, SkipForward, Trash2, TriangleAlert, X } from 'lucide-react';
import type { Project, Review, ReviewComment } from '../../shared/types';
import type { CommentPublication, FeedbackPreview, IntegrationState, JiraIssue, MergeOperation, MergePreview, MergeProgress, ProjectIntegration, PullRequest, PullRequestFilter, RemoteReviewState } from '../../shared/integrations';
import { pullRequestKey } from '../../shared/integrations';
import { flushPendingComments } from './commentAutosave';
import './integrations.css';

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);
const emptyProject = (): ProjectIntegration => ({ repositories: [], updateSubmodulePointers: false });
const human = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');

function Problem({ children }: { children: ReactNode }) {
  return <div className="integration-error" role="alert"><TriangleAlert size={14} /><span>{children}</span></div>;
}

function IntegrationDialog({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
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
  return <div className="modal-backdrop integration-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={container} className="modal integration-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="modal-header"><div><span className="eyebrow">BRANCHLINE · CONNECTED REVIEW</span><h2 id={titleId}>{title}</h2></div><button className="icon-button" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      {children}
    </div>
  </div>;
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
  const [excluded, setExcluded] = useState(new Set<string>());
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
    try { await flushPendingComments(); onOpened(await window.reviewAPI.openPullRequestReview(project.id, selected.map(pr => ({ repositoryPath: pr.repository.relativePath, prId: pr.id })))); }
    catch (reason) { setError(message(reason)); }
    finally { setOpening(''); }
  }
  return <IntegrationDialog title="Pull requests" onClose={onClose} busy={!!opening}>
    <div className="integration-body"><div className="pr-list-controls"><div className="integration-segments" aria-label="Filter pull requests">{(['all', 'reviewer', 'author'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} disabled={!!opening} onClick={() => setFilter(value)}>{value === 'all' ? 'All open' : value === 'reviewer' ? 'Needs my review' : 'Created by me'}</button>)}</div><button type="button" className="icon-button" aria-label="Refresh pull requests" title="Refresh pull requests" disabled={loading || !!opening} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></button></div>
      <p className="integration-note">{project.name} · PRs with the same source and target form one review.{checkedAt && ` Checked ${checkedAt}.`}</p>
      {error && <Problem>{error}</Problem>}
      {!items.length && <div className="integration-empty" role="status">{loading ? <LoaderCircle className="spin" size={21} /> : <GitPullRequest size={23} />}<strong>{loading ? 'Finding pull requests…' : 'No open pull requests'}</strong><span>{loading ? 'Reading your project’s Bitbucket repositories.' : 'Try another filter or check the project’s repository mappings.'}</span></div>}
      <div className="pr-groups">{groups.map(([key, prs]) => {
        const selected = prs.filter(pr => !pr.unsupportedReason && !excluded.has(pullRequestKey(pr)));
        return <section className="pr-group" key={key}><div className="pr-group-heading"><code title={`${prs[0].sourceBranch} → ${prs[0].targetBranch}`}>{prs[0].sourceBranch}<span> → </span>{prs[0].targetBranch}</code><button className="button button-primary" type="button" disabled={!selected.length || !!opening} onClick={() => void open(key, selected)}>{opening === key ? <LoaderCircle className="spin" size={12} /> : <GitPullRequest size={12} />}Review {selected.length} {selected.length === 1 ? 'PR' : 'PRs'}</button></div>{prs.map(pr => <div className="pr-row" key={pullRequestKey(pr)}><input type="checkbox" aria-label={`Include ${pr.repository.repoSlug} PR ${pr.id}`} checked={!pr.unsupportedReason && !excluded.has(pullRequestKey(pr))} disabled={!!opening || !!pr.unsupportedReason} onChange={event => { const next = new Set(excluded); if (event.target.checked) next.delete(pullRequestKey(pr)); else next.add(pullRequestKey(pr)); setExcluded(next); }} /><div><IntegrationLink url={pr.url}>{pr.title}<ExternalLink size={11} /></IntegrationLink><span><code>{pr.repository.relativePath === '.' ? pr.repository.repoSlug : pr.repository.relativePath}</code> · #{pr.id} · {pr.author.name}{pr.draft ? ' · Draft' : ''}</span>{pr.unsupportedReason && <span className="integration-inline-error">{pr.unsupportedReason}</span>}</div></div>)}</section>;
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
  return <section className={`jira-issue-panel ${open ? 'is-open' : ''}`} aria-label="Jira ticket details">
    <div className="jira-issue-heading"><button className="jira-issue-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={13} /><span className="jira-issue-key">{issue?.key || ticket || 'Jira ticket'}</span><span className="jira-issue-title">{loading ? 'Loading ticket…' : issue?.title || 'Choose a ticket to view its details'}</span></button>{issue && <IntegrationLink url={issue.url} className="jira-open-link"><ExternalLink size={12} />Open in Jira<span className="sr-only">: {issue.key}</span></IntegrationLink>}</div>
    {open && <div className="jira-issue-content"><form className="jira-ticket-form" onSubmit={event => void changeTicket(event)}><label htmlFor="review-ticket-key">Ticket</label><input id="review-ticket-key" aria-label="Review ticket key" className="text-input" placeholder="APP-123" value={key} onChange={event => setKey(event.target.value)} disabled={loading} /><button type="submit" className="button button-secondary" disabled={loading}>Use ticket</button><button className="icon-button" type="button" aria-label="Refresh Jira ticket" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={13} /></button></form>{error && <Problem>{error}</Problem>}{issue && <JiraDescription value={issue.description} />}</div>}
  </section>;
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

function mergeStatus(pr: PullRequest, item: MergeProgress | undefined, operation: MergeOperation | undefined, action: 'approve' | 'merge') {
  const phaseLabels = { checking: 'Checking…', approving: 'Approving…', merging: 'Merging…', cleanup: 'Checking branch deletion…', 'updating-pointers': 'Updating pointers…' };
  if (operation?.state === 'running' && item?.phase) return { label: phaseLabels[item.phase], tone: 'active', icon: LoaderCircle };
  if (item?.merge === 'merged' || pr.state === 'MERGED') return item?.skipped || !item
    ? { label: 'Skipped · already merged', tone: 'complete', icon: SkipForward }
    : { label: 'Merged', tone: 'complete', icon: Check };
  if (item?.merge === 'failed' || item?.approval === 'failed') return { label: 'Failed', tone: 'warning', icon: TriangleAlert };
  if (item?.pointerState === 'review') return { label: 'Needs review', tone: 'warning', icon: CirclePause };
  if (item?.merge === 'unknown') return { label: 'Awaiting confirmation', tone: 'warning', icon: CirclePause };
  if (item?.merge === 'sending' || item?.merge === 'merging') return operation?.state === 'running'
    ? { label: 'Merging…', tone: 'active', icon: LoaderCircle }
    : { label: 'Awaiting confirmation', tone: 'warning', icon: CirclePause };
  if (action === 'approve' && item?.approval === 'approved') return { label: 'Approved', tone: 'complete', icon: Check };
  if (item?.error) return { label: 'Paused', tone: 'warning', icon: CirclePause };
  return { label: 'Waiting', tone: 'waiting', icon: Circle };
}

export function MergeProgressView({ pullRequests, operation, action = operation?.action || 'merge', checking = false }: { pullRequests: PullRequest[]; operation?: MergeOperation; action?: 'approve' | 'merge'; checking?: boolean }) {
  const ordered = [...pullRequests].sort((a, b) => {
    const depth = (pr: PullRequest) => pr.repository.relativePath === '.' ? 0 : pr.repository.relativePath.split('/').length;
    return depth(b) - depth(a) || a.repository.relativePath.localeCompare(b.repository.relativePath);
  });
  const finished = pullRequests.filter(pr => {
    const item = operation?.items.find(progress => progress.prKey === pullRequestKey(pr));
    return item?.merge === 'merged' || pr.state === 'MERGED' || (action === 'approve' && item?.approval === 'approved');
  }).length;
  const title = checking ? 'Checking pull requests…' : !operation ? 'Repositories' : operation.state === 'complete' ? action === 'merge' ? 'Repositories merged' : 'Repositories approved' : operation.state === 'paused' ? 'Operation paused' : action === 'merge' ? 'Merging repositories' : 'Approving repositories';
  return <section className="merge-progress" aria-label="Pull request operation progress" aria-live="polite">
    <div className="integration-section-heading"><h3>{title}</h3><span className="merge-progress-count">{finished} / {pullRequests.length}</span></div>
    <ul className="merge-repository-list" aria-label="Repositories">{ordered.map(pr => {
      const item = operation?.items.find(progress => progress.prKey === pullRequestKey(pr));
      const status = mergeStatus(pr, item, operation, action);
      const Icon = status.icon;
      const merged = item?.merge === 'merged' || pr.state === 'MERGED';
      const cleanup = action === 'merge' && merged && item?.phase !== 'cleanup' ? item?.cleanup || 'unknown' : undefined;
      return <li className={`merge-progress-row merge-row-${status.tone}`} key={pullRequestKey(pr)} aria-label={`${pr.repository.repoSlug} pull request ${pr.id}`}>
        <span className={`merge-repository-icon ${status.tone === 'active' ? 'is-active' : ''}`} aria-hidden="true"><Icon className={status.tone === 'active' ? 'spin' : ''} size={16} /></span>
        <div className="merge-repository-details"><div className="merge-repository-name"><strong>{pr.repository.repoSlug}</strong><IntegrationLink url={pr.url}>#{pr.id}<ExternalLink size={10} /></IntegrationLink></div><span className="merge-repository-path">{pr.repository.relativePath === '.' ? 'Parent repository' : pr.repository.relativePath}</span><code className="merge-repository-branches">{pr.sourceBranch}<span> → </span>{pr.targetBranch}</code></div>
        <div className="merge-repository-result"><span className="merge-repository-status">{status.label}</span>{cleanup && <span className={`merge-cleanup merge-cleanup-${cleanup}`} title={cleanup === 'deleted' ? 'Remote source branch deleted' : cleanup === 'retained' ? 'Remote source branch still exists' : 'Remote source branch deletion could not be confirmed'}>{cleanup === 'deleted' ? <Trash2 size={11} aria-hidden="true" /> : <TriangleAlert size={11} aria-hidden="true" />}{cleanup === 'deleted' ? 'Deleted' : cleanup === 'retained' ? 'Retained' : 'Deletion unconfirmed'}</span>}</div>
        {item?.pointerState === 'review' && <span className="pointer-progress">Pointer changes are ready. Return to the diff, review them, then resume.</span>}
        {item?.error && <span className="integration-inline-error">{item.error}</span>}
      </li>;
    })}</ul>
    {operation?.error && <Problem>{operation.error}</Problem>}
  </section>;
}

export function RemoteReviewControls({ review, remote, onRemote, onChanged, onReanchor, onMergeComplete, jiraLink }: { review: Review; remote: RemoteReviewState | null; onRemote: (state: RemoteReviewState) => void; onChanged: () => Promise<void>; onReanchor: (commentId: string) => void; onMergeComplete: (state: RemoteReviewState) => Promise<void>; jiraLink: { key: string; url: string } | null }) {
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
      if (event.reviewId === review.id) latest.current.onRemote(event.state);
    });
  }, [review.id]);
  async function preview(action: 'publish' | 'approve' | 'merge') {
    setDialog(action); setLoading(true); setError(''); setResult(''); setJiraError(''); setFeedback(null); setMerge(null);
    try {
      await flushPendingComments();
      if (action === 'publish') {
        await onChanged();
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
      const state = dialog === 'publish' ? await window.reviewAPI.publishFeedback(review.id) : await window.reviewAPI.runPullRequestAction(review.id, dialog);
      onRemote(state);
      if (dialog === 'merge' && state.operation?.action === 'merge' && state.operation.state === 'complete' && state.pullRequests.length > 0 && state.pullRequests.every(pr => state.operation?.items.some(item => item.prKey === pullRequestKey(pr) && item.merge === 'merged'))) {
        await onMergeComplete(state);
        setDialog(null);
        return;
      }
      await onChanged();
      if (dialog === 'publish') { const next = await window.reviewAPI.previewFeedback(review.id); setFeedback(next); setResult(next.items.length ? 'Completed items are saved. Review the remaining items below.' : 'Feedback published to Bitbucket.'); }
      else { setMerge(await window.reviewAPI.previewMerge(review.id, dialog)); }
    } catch (reason) { setError(message(reason)); const state = await window.reviewAPI.getRemoteReview(review.id).catch(() => null); if (state) onRemote(state); }
    finally { setBusy(false); }
  }
  async function conflict(commentId: string, choice: 'local' | 'remote') {
    setBusy(true); setError('');
    try { await flushPendingComments(); await window.reviewAPI.resolveCommentConflict(review.id, commentId, choice); await onChanged(); setFeedback(await window.reviewAPI.previewFeedback(review.id)); const state = await window.reviewAPI.getRemoteReview(review.id); if (state) onRemote(state); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function reconcileUnknown(commentId: string, remoteId: number | null) {
    setBusy(true); setError('');
    try {
      onRemote(await window.reviewAPI.resolveUnknownPublication(review.id, commentId, remoteId));
      await onChanged(); setFeedback(await window.reviewAPI.previewFeedback(review.id));
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
  const canMerge = !!merge && !merge.blockers.length && (merge.pullRequests.some(pr => pr.state === 'OPEN') || visibleOperation?.action === 'merge' && visibleOperation.state === 'paused');
  const canApprove = !!merge && !merge.blockers.length && merge.pullRequests.some(pr => pr.state === 'OPEN' && !pr.draft);
  const completed = dialog !== 'publish' && operation?.state === 'complete' && operation.action === dialog;
  return <><div className="remote-review-controls" aria-label="Bitbucket review controls"><div className="remote-review-origin"><GitPullRequest size={14} /><span>Bitbucket</span><span className="integration-note">{remote?.pullRequests.length || '…'} PRs</span>{remote?.pullRequests.map(pr => <IntegrationLink key={pullRequestKey(pr)} url={pr.url}>{pr.repository.repoSlug} #{pr.id}<ExternalLink size={10} /></IntegrationLink>)}</div><div className="remote-review-actions">{operation && operation.state !== 'complete' && <button type="button" className="integration-link" onClick={() => void preview(operation.action)}>{operation.state === 'paused' ? 'Resume operation' : 'View progress'}</button>}<button className="button button-secondary" type="button" onClick={() => void preview('publish')}><Send size={12} />Publish feedback</button><button className="button button-secondary" type="button" onClick={() => void preview('approve')}><Check size={13} />Approve</button><button className="button button-primary" type="button" onClick={() => void preview('merge')}><GitMerge size={13} />Approve and merge</button></div></div>
    {dialog && <IntegrationDialog title={dialog === 'publish' ? 'Publish feedback' : dialog === 'approve' ? 'Approve pull requests' : 'Approve and merge'} busy={busy || loading} onClose={() => setDialog(null)}>
      <div className="integration-body"><p className="modal-introduction">{dialog === 'publish' ? 'Each comment goes to its file and exact lines in Bitbucket. Local drafts stay saved until publication succeeds.' : dialog === 'approve' ? 'Approve the selected pull requests with your connected Bitbucket account.' : 'Create regular merge commits, then delete the merged source branches. Each repository’s result is saved so you can resume a paused operation.'}</p>{loading && <p className="integration-loading" role="status"><LoaderCircle className="spin" size={15} />Checking the latest pull requests…</p>}{error && <Problem>{error}</Problem>}{result && <p className="integration-note" role="status">{result}</p>}
        {dialog === 'publish' && <FeedbackPullRequests pullRequests={remote?.pullRequests || []} />}
        {dialog === 'publish' && feedback && <><div className="feedback-publication-list">{feedback.items.map(item => <article className="feedback-publication" key={item.commentId}><div><code>{item.repositoryPath} · #{item.prId}</code><span className={`publication-status publication-${item.state}`}>{item.state === 'synced' ? 'Changes to publish' : human(item.state)}</span><span className="feedback-publication-action">{human(item.action)}</span></div><strong>{item.path} · {item.lineStart ? `L${item.lineStart}${item.lineEnd !== item.lineStart ? `–${item.lineEnd}` : ''}` : 'File comment'} · {item.side === 'deletions' ? 'Original' : 'New version'}</strong><p>{item.body}</p>{item.error && <Problem>{item.error}</Problem>}{item.state === 'unknown' && <div className="unknown-delivery"><p className="integration-note">Delivery is uncertain. Check Bitbucket before deciding whether to retry.</p>{remote?.pullRequests.filter(pr => pr.repository.relativePath === item.repositoryPath && pr.id === item.prId).map(pr => <IntegrationLink key={pullRequestKey(pr)} url={pr.url}>Check PR #{pr.id} in Bitbucket<ExternalLink size={11} /></IntegrationLink>)}<div className="unknown-comment-link"><input className="text-input" type="text" inputMode="numeric" aria-label="Existing Bitbucket comment ID" placeholder="Existing comment ID" value={unknownIds[item.commentId] || ''} disabled={busy} onChange={event => setUnknownIds(previous => ({ ...previous, [item.commentId]: event.target.value }))} /><button type="button" className="button button-secondary" disabled={busy || !/^[1-9]\d*$/.test(unknownIds[item.commentId] || '') || !Number.isSafeInteger(Number(unknownIds[item.commentId]))} onClick={() => void reconcileUnknown(item.commentId, Number(unknownIds[item.commentId]))}>Link existing comment</button></div><label className="integration-checkbox"><input type="checkbox" checked={!!checkedDelivery[item.commentId]} disabled={busy} onChange={event => setCheckedDelivery(previous => ({ ...previous, [item.commentId]: event.target.checked }))} /><span>I checked Bitbucket: this comment was not posted.</span></label><button type="button" className="integration-link" disabled={busy || !checkedDelivery[item.commentId]} onClick={() => void reconcileUnknown(item.commentId, null)}>Allow retry</button></div>}{item.state === 'conflict' && <div className="publication-conflict"><span>Bitbucket version</span><p>{item.remote?.deleted ? 'Deleted in Bitbucket' : item.remote?.body}</p><div className="integration-inline-actions"><button type="button" disabled={busy} onClick={() => void conflict(item.commentId, 'local')}>Keep local version</button><button type="button" disabled={busy} onClick={() => void conflict(item.commentId, 'remote')}>Use Bitbucket version</button></div></div>}{!remote?.publications[item.commentId]?.remoteId && review.comments.some(comment => comment.id === item.commentId) && item.state !== 'sending' && item.state !== 'unknown' && <button type="button" className="integration-link" disabled={busy} onClick={() => { setDialog(null); onReanchor(item.commentId); }}>Choose current lines…</button>}</article>)}</div>{!feedback.items.length && <p className="integration-note">No feedback to publish.</p>}{feedback.blockers.map((blocker, index) => <Problem key={index}>{blocker}</Problem>)}</>}
        {dialog !== 'publish' && <><MergeProgressView pullRequests={merge?.pullRequests || remote?.pullRequests || []} operation={visibleOperation} action={dialog} checking={loading} />{merge && <>{dialog === 'merge' && <p className="integration-note pointer-preview">Submodule pointers: {merge.updateSubmodulePointers ? 'update after children merge; review before parent merge' : 'leave unchanged'}</p>}{merge.warnings.map((warning, index) => <p className="integration-note" key={index}>{warning}</p>)}{merge.blockers.map((blocker, index) => <Problem key={index}>{blocker}</Problem>)}</>}{jiraError && <Problem>{jiraError}</Problem>}</>}
      </div><div className="modal-footer">{dialog !== 'publish' && jiraLink && <button className="button button-secondary merge-jira-button" title={`Open ${jiraLink.key} to update its status in Jira`} onClick={() => void openTicket()}><ExternalLink size={12} />Open in Jira</button>}<button className="button button-secondary" disabled={busy || loading} onClick={() => setDialog(null)}>{visibleOperation?.state === 'paused' ? 'Return to review' : 'Close'}</button>{dialog === 'publish' && <button className="button button-secondary" disabled={busy || loading} onClick={() => void preview('publish')}>Refresh delivery status</button>}<button className="button button-primary" disabled={busy || loading || !!completed || (dialog === 'publish' ? !publishable : dialog === 'merge' ? !canMerge : !canApprove)} onClick={() => void run()}>{busy && <LoaderCircle className="spin" size={13} />}{busy ? 'Working…' : dialog === 'publish' ? 'Publish to Bitbucket' : completed ? 'Complete' : visibleOperation?.state === 'paused' ? 'Resume operation' : dialog === 'approve' ? 'Approve pull requests' : 'Approve, merge and delete branches'}</button></div>
    </IntegrationDialog>}
  </>;
}
