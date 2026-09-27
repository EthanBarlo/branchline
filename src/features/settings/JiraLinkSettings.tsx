import * as stylex from '@stylexjs/stylex';
import { Check, ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { jiraTicketUrl, normalizeJiraBaseUrl } from '../../../shared/jira';
import type { AppSettings } from '../../../shared/types';
import { colors, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { errorMessage as message } from '../../lib/errorMessage';
import { FormError } from '../../ui/Field';
import { Spinner } from '../../ui/Spinner';

export function JiraLinkSettings({
  settings,
  ticket,
  initiallyOpen,
  onSaved,
  onBusyChange,
}: {
  settings: AppSettings;
  ticket: string | null;
  initiallyOpen: boolean;
  onSaved: (settings: AppSettings) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.jiraBaseUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const inputStyle = stylex.props(styles.browserInput);
  let preview = '';
  try {
    if (baseUrl.trim()) preview = jiraTicketUrl(normalizeJiraBaseUrl(baseUrl), ticket || 'APP-123');
  } catch {
    /* Validate the completed URL on save. */
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError('');
    setSaved(false);
    try {
      const updated = await window.reviewAPI.updateSettings({ jiraBaseUrl: normalizeJiraBaseUrl(baseUrl) });
      setBaseUrl(updated.jiraBaseUrl);
      onSaved(updated);
      setSaved(true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      inFlight.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  }
  return (
    <details
      {...stylex.props(styles.browserLinks, stylex.defaultMarker())}
      open={initiallyOpen || undefined}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary {...stylex.props(styles.browserSummary)}>
        <span>
          Browser links only
          <small {...stylex.props(styles.browserSummaryDetail)}>
            For Jira Server, Data Center, or opening tickets without an API token.
          </small>
        </span>
        <ChevronDown
          size={15}
          {...stylex.props(styles.browserChevron, expanded && styles.openBrowserChevron)}
        />
      </summary>
      <form onSubmit={(event) => void save(event)} noValidate>
        <p {...stylex.props(styles.browserDescription)}>
          This optional URL opens branch ticket keys in your browser. A connected Jira Cloud account above
          also shows ticket details inside Branchline.
        </p>
        <label {...stylex.props(styles.browserLabel)} htmlFor="jira-base-url">
          Jira base URL
        </label>
        <input
          {...inputStyle}
          className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${inputStyle.className}`}
          id="jira-base-url"
          type="url"
          placeholder="https://jira.example.com/jira"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          aria-describedby="jira-url-hint"
          aria-invalid={error ? true : undefined}
          disabled={saving}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setError('');
            setSaved(false);
          }}
        />
        <p {...stylex.props(styles.browserHint)} id="jira-url-hint">
          Include any site path, such as <code>/jira</code>. Leave blank to clear it. Applies to all projects
          without a connected Jira account.
        </p>
        {preview && (
          <div {...stylex.props(styles.linkPreview)}>
            <span {...stylex.props(styles.linkPreviewLabel)}>
              {ticket ? `Detected ${ticket}` : 'Example ticket link'}
            </span>
            <code {...stylex.props(styles.linkPreviewCode)}>{preview}</code>
          </div>
        )}
        {error && <FormError>{error}</FormError>}
        <div {...stylex.props(styles.saveRow)}>
          {saved && (
            <span {...stylex.props(styles.saveStatus)} role="status">
              <Check size={13} />
              Link settings saved
            </span>
          )}
          <Button variant="primary" type="submit" disabled={saving || baseUrl === settings.jiraBaseUrl}>
            {saving && <Spinner size={13} />}Save link settings
          </Button>
        </div>
      </form>
    </details>
  );
}

const styles = stylex.create({
  browserInput: { width: '100%', fontSize: typeScale.body, height: 38 },
  browserLinks: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    marginTop: 34,
  },
  browserSummary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingBlock: '22px',
    paddingInline: '0',
    color: colors.textTertiary,
    fontSize: typeScale.body,
    cursor: 'pointer',
    listStyle: 'none',
  },
  browserSummaryDetail: {
    display: 'block',
    marginTop: 5,
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    fontWeight: 400,
    lineHeight: 1.7,
  },
  browserChevron: { flexShrink: 0, transform: 'rotate(-90deg)' },
  openBrowserChevron: { transform: 'none' },
  browserDescription: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '20px',
    marginLeft: '0',
    fontSize: typeScale.body,
    lineHeight: 1.8,
    color: colors.textMuted,
  },
  browserLabel: {
    display: 'block',
    marginTop: '14px',
    marginRight: '0',
    marginBottom: spacing.md,
    marginLeft: '0',
    fontSize: typeScale.body,
  },
  'text-input': {
    width: '100%',
    backgroundColor: colors.panel,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '5px',
    minHeight: '37px',
    paddingBlock: '0',
    paddingInline: '11px',
    color: colors.textDefault,
    fontSize: typeScale.compact,
    borderColor: { default: colors.borderStrong, ':focus': colors.textSubtle },
    '::placeholder': { color: colors.textFaint, opacity: '1' },
  },
  browserHint: {
    marginTop: '9px',
    marginRight: '0',
    marginBottom: '20px',
    marginLeft: '0',
    fontSize: typeScale.compact,
  },
  linkPreview: {
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderStrong,
    paddingLeft: 14,
    marginBlock: '19px',
    marginInline: '0',
  },
  linkPreviewLabel: { display: 'block', color: colors.textQuiet, fontSize: typeScale.small, marginBottom: 7 },
  linkPreviewCode: {
    color: colors.textTertiary,
    fontSize: typeScale.compact,
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  saveRow: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 15, marginTop: 22 },
  saveStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    fontSize: typeScale.compact,
    color: colors.successText,
  },
});
