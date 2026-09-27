import * as stylex from '@stylexjs/stylex';
import { ExternalLink, RefreshCw, Ticket, TriangleAlert } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { JiraIssue } from '../../../shared/integrations';
import type { AppSettings, Review } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button, IconButton } from '../../ui/Button';
import { DialogFooter } from '../../ui/Dialog';
import { TextInput } from '../../ui/Field';
import { Spinner, spinStyle } from '../../ui/Spinner';
import { JiraBrowserDialog } from '../jira/browser/JiraBrowserDialog';
import { IntegrationDialog } from './IntegrationDialog';
import { IntegrationLink } from './IntegrationLink';
import { Problem } from './IntegrationError';
import { errorMessage as message } from '../../lib/errorMessage';

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return;
  }
}

/** Render ADF as React text/elements. Never trust remote HTML or fetch embedded media. */
export function JiraDescription({ value }: { value: unknown }) {
  let remaining = 2500;
  function render(node: unknown, depth = 0): ReactNode {
    if (--remaining < 0 || depth > 24 || !node || typeof node !== 'object') return null;
    const item = node as {
      type?: string;
      text?: unknown;
      content?: unknown[];
      attrs?: Record<string, unknown>;
      marks?: { type?: string; attrs?: Record<string, unknown> }[];
    };
    const children = Array.isArray(item.content)
      ? item.content.map((child, index) => <Fragment key={index}>{render(child, depth + 1)}</Fragment>)
      : null;
    if (item.type === 'text') {
      let text: ReactNode = typeof item.text === 'string' ? item.text : '';
      for (const mark of Array.isArray(item.marks) ? item.marks : []) {
        if (mark.type === 'strong') text = <strong>{text}</strong>;
        else if (mark.type === 'em') text = <em>{text}</em>;
        else if (mark.type === 'code')
          text = <code {...stylex.props(styles.jiraDescriptionCode)}>{text}</code>;
        else if (mark.type === 'strike') text = <s>{text}</s>;
        else if (mark.type === 'link') {
          const url = safeUrl(mark.attrs?.href);
          if (url)
            text = (
              <IntegrationLink url={url} variant="description">
                {text}
              </IntegrationLink>
            );
        }
      }
      return text;
    }
    switch (item.type) {
      case 'paragraph':
        return <p {...stylex.props(styles.jiraDescriptionParagraph)}>{children}</p>;
      case 'heading':
        return <h4 {...stylex.props(styles.jiraDescriptionHeading)}>{children}</h4>;
      case 'bulletList':
        return <ul {...stylex.props(styles.jiraDescriptionList)}>{children}</ul>;
      case 'orderedList':
        return <ol {...stylex.props(styles.jiraDescriptionList)}>{children}</ol>;
      case 'listItem':
        return <li>{children}</li>;
      case 'blockquote':
        return <blockquote {...stylex.props(styles.jiraDescriptionQuote)}>{children}</blockquote>;
      case 'codeBlock':
        return (
          <pre {...stylex.props(styles.jiraDescriptionPre)}>
            <code {...stylex.props(styles.jiraDescriptionCode)}>{children}</code>
          </pre>
        );
      case 'hardBreak':
        return <br />;
      case 'rule':
        return <hr />;
      case 'table':
        return (
          <table {...stylex.props(styles.jiraDescriptionTable)}>
            <tbody>{children}</tbody>
          </table>
        );
      case 'tableRow':
        return <tr>{children}</tr>;
      case 'tableCell':
        return <td {...stylex.props(styles.jiraDescriptionCell)}>{children}</td>;
      case 'tableHeader':
        return <th {...stylex.props(styles.jiraDescriptionCell)}>{children}</th>;
      case 'mention':
      case 'status':
        return <span>{typeof item.attrs?.text === 'string' ? item.attrs.text : ''}</span>;
      case 'emoji':
        return (
          <span>
            {typeof item.attrs?.text === 'string'
              ? item.attrs.text
              : typeof item.attrs?.shortName === 'string'
                ? item.attrs.shortName
                : ''}
          </span>
        );
      case 'inlineCard': {
        const url = safeUrl(item.attrs?.url);
        return url ? (
          <IntegrationLink url={url} variant="description">
            {url}
          </IntegrationLink>
        ) : null;
      }
      case 'media':
        return <span {...stylex.props(styles.note)}>[Attachment — view in Jira]</span>;
      default:
        return children;
    }
  }
  return (
    <div className={`jira-description ${stylex.props(styles.jiraDescription).className}`}>
      {typeof value === 'string' ? (
        <p {...stylex.props(styles.jiraDescriptionParagraph)}>{value}</p>
      ) : value ? (
        render(value)
      ) : (
        <p {...stylex.props(styles.note, styles.jiraDescriptionParagraph)}>No description provided.</p>
      )}
    </div>
  );
}

export function JiraIssuePanel({
  review,
  ticket,
  currentBranch,
  ticketView = 'website',
  refreshKey = '',
  onTicketChanged,
}: {
  review: Review;
  ticket: string | null;
  currentBranch?: string | null;
  ticketView?: AppSettings['jiraTicketView'];
  refreshKey?: string;
  onTicketChanged?: () => void;
}) {
  const [view, setView] = useState<'summary' | 'website' | null>(null);
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [key, setKey] = useState(ticket || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const lastBranch = useRef(currentBranch);
  useEffect(() => {
    const previous = lastBranch.current;
    lastBranch.current = currentBranch;
    if (
      previous !== currentBranch &&
      previous !== undefined &&
      currentBranch !== undefined &&
      view === 'summary'
    )
      setView(null);
  }, [currentBranch, view]);
  const load = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await window.reviewAPI.getJiraIssue(review.id);
      if (generation === request.current) {
        setIssue(result);
        setKey(result.key);
      }
    } catch (reason) {
      if (generation === request.current) {
        setIssue(null);
        setError(message(reason));
      }
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, [review.id]);
  useEffect(() => {
    setIssue(null);
    setKey(ticket || '');
    setError('');
  }, [ticket, refreshKey]);
  useEffect(() => {
    if (view === 'summary' && ticket) void load();
    else setLoading(false);
    return () => {
      request.current++;
    };
  }, [load, ticket, refreshKey, view]);
  async function changeTicket(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await window.reviewAPI.setReviewTicket(review.id, key.trim(), currentBranch);
      onTicketChanged?.();
      await load();
    } catch (reason) {
      setError(message(reason));
      setLoading(false);
    }
  }
  const linkedTicket = issue?.key || ticket;
  return (
    <>
      <Button
        className={`jira-ticket-button ${stylex.props(styles.ticketButton, styles.contextButton, styles.jiraButton).className}`}
        type="button"
        aria-label={`View Jira ticket${linkedTicket ? ` ${linkedTicket}` : ''}`}
        aria-haspopup="dialog"
        title={error ? `Jira ticket: ${error}` : issue?.title || 'View Jira ticket'}
        onClick={() => setView(ticketView === 'website' ? 'website' : 'summary')}
      >
        {loading ? <Spinner size={12} aria-hidden="true" /> : <Ticket size={13} aria-hidden="true" />}
        <span {...stylex.props(styles.jiraButtonLabel)}>{issue?.key || ticket || 'Jira ticket'}</span>
        {error && (
          <TriangleAlert size={12} {...stylex.props(styles.contextWarning)} aria-label="Ticket unavailable" />
        )}
      </Button>
      {view === 'website' && (
        <JiraBrowserDialog
          reviewId={review.id}
          ticket={linkedTicket}
          currentBranch={currentBranch}
          onClose={() => setView(null)}
          onDetails={() => setView('summary')}
          onTicketChanged={() => {
            setIssue(null);
            onTicketChanged?.();
          }}
        />
      )}
      {view === 'summary' && (
        <IntegrationDialog title="Jira ticket" onClose={() => setView(null)}>
          <div {...stylex.props(styles.body)}>
            <form {...stylex.props(styles.jiraTicketForm)} onSubmit={(event) => void changeTicket(event)}>
              <label {...stylex.props(styles.jiraTicketFormLabel)} htmlFor={`review-ticket-key-${review.id}`}>
                Ticket
              </label>
              <TextInput
                id={`review-ticket-key-${review.id}`}
                aria-label="Review ticket key"
                {...stylex.props(styles.jiraTicketInput)}
                placeholder="APP-123"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                disabled={loading}
              />
              <Button
                variant="secondary"
                type="submit"
                {...stylex.props(styles.jiraTicketAction)}
                disabled={loading}
              >
                Use ticket
              </Button>
              <IconButton
                type="button"
                aria-label="Refresh Jira ticket"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw
                  className={`${loading ? 'spin ' : ''}${stylex.props(loading && spinStyle).className}`}
                  size={13}
                />
              </IconButton>
            </form>
            {loading && (
              <p className={`integration-loading ${stylex.props(styles.loading).className}`} role="status">
                <Spinner size={14} />
                Loading ticket…
              </p>
            )}
            {error && <Problem>{error}</Problem>}
            {issue && (
              <>
                <div {...stylex.props(styles.jiraTicketHeading)}>
                  <span {...stylex.props(styles.jiraIssueKey)}>{issue.key}</span>
                  <h3 {...stylex.props(styles.jiraTicketTitle)}>{issue.title}</h3>
                </div>
                <JiraDescription value={issue.description} />
              </>
            )}
            <p {...stylex.props(styles.note)}>
              {linkedTicket
                ? 'Open the full Jira page to edit this ticket and add comments. Sign in separately the first time.'
                : 'Enter a ticket key to link Jira to this review.'}
            </p>
          </div>
          <DialogFooter {...stylex.props(styles.modalChrome)}>
            {issue && (
              <IntegrationLink url={issue.url} button>
                <ExternalLink size={12} {...stylex.props(styles.linkIcon)} />
                Open in Jira<span className="sr-only">: {issue.key}</span>
              </IntegrationLink>
            )}
            {linkedTicket && (
              <Button variant="primary" type="button" disabled={loading} onClick={() => setView('website')}>
                Open in Branchline
              </Button>
            )}
            <Button type="button" onClick={() => setView(null)}>
              Done
            </Button>
          </DialogFooter>
        </IntegrationDialog>
      )}
    </>
  );
}

const styles = stylex.create({
  jiraDescriptionCode: { fontSize: typeScale.small },
  jiraDescriptionParagraph: { marginBlock: '7px', marginInline: '0', whiteSpace: 'pre-wrap' },
  jiraDescriptionHeading: {
    marginTop: '14px',
    marginRight: '0',
    marginBottom: '5px',
    marginLeft: '0',
    fontSize: typeScale.base,
    fontWeight: 600,
  },
  jiraDescriptionList: { paddingLeft: '23px', marginBlock: '7px', marginInline: '0' },
  jiraDescriptionQuote: {
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSelected,
    paddingLeft: spacing.lg,
    marginLeft: '0',
  },
  jiraDescriptionPre: {
    maxWidth: '100%',
    padding: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    overflow: 'auto',
    fontSize: typeScale.small,
  },
  jiraDescriptionTable: { borderCollapse: 'collapse', maxWidth: '100%' },
  jiraDescriptionCell: {
    paddingBlock: '7px',
    paddingInline: '11px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    textAlign: 'left',
  },
  note: {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: '10px',
    marginInline: '0',
  },
  jiraDescription: {
    maxWidth: '920px',
    color: colors.textTertiary,
    fontSize: typeScale.body,
    lineHeight: 1.8,
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  contextButton: {
    minHeight: 27,
    height: 27,
    paddingBlock: 0,
    paddingInline: 9,
    gap: spacing.sm,
    fontSize: typeScale.small,
    whiteSpace: 'nowrap',
    flexShrink: '0',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: { default: 'none', ':focus-visible': 'solid' },
    outlineColor: colors.focus,
    outlineOffset: { default: 0, ':focus-visible': 3 },
  },
  ticketButton: {
    flexShrink: 0,
    maxWidth: 145,
    height: 25,
    paddingBlock: 0,
    paddingInline: 7,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
    fontWeight: 400,
  },
  jiraButton: { maxWidth: '145px' },
  jiraButtonLabel: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  contextWarning: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: colors.warningText,
  },
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: '0',
    overflow: 'auto',
  },
  jiraTicketForm: {
    display: 'flex',
    alignItems: 'center',
    gap: '9px',
    marginTop: '7px',
    marginRight: '0',
    marginBottom: '13px',
    marginLeft: '0',
  },
  jiraTicketFormLabel: { fontSize: typeScale.small, color: colors.textQuiet },
  jiraTicketInput: {
    height: '28px',
    maxWidth: '150px',
    paddingBlock: '0',
    paddingInline: spacing.md,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  jiraTicketAction: { minHeight: '28px', fontSize: typeScale.small },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    color: colors.textSubtle,
    fontSize: typeScale.compact,
  },
  jiraTicketHeading: {
    marginTop: '23px',
    marginRight: '0',
    marginBottom: '17px',
    marginLeft: '0',
  },
  jiraIssueKey: {
    color: colors.textTertiary,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  jiraTicketTitle: {
    marginTop: spacing.md,
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    fontSize: '17px',
    fontWeight: 500,
    color: colors.accent,
    lineHeight: 1.5,
  },
  modalChrome: { flexShrink: '0' },
  linkIcon: { flexShrink: '0' },
});
