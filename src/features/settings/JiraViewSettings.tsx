import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { errorMessage as message } from '../../ui/errorMessage';
import { FormError } from '../../ui/Field';
import { Spinner } from '../../ui/Spinner';

export function JiraViewSettings({
  settings,
  onSaved,
  onBusyChange,
}: {
  settings: AppSettings;
  onSaved: (settings: AppSettings) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const inputStyle = stylex.props(styles.ticketViewInput);
  const selectedView = settings.jiraTicketView ?? 'website';
  async function save(view: NonNullable<AppSettings['jiraTicketView']>) {
    if (inFlight.current || view === selectedView) return;
    inFlight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError('');
    setSaved(false);
    try {
      onSaved(await window.reviewAPI.updateSettings({ jiraTicketView: view }));
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
    <section {...stylex.props(styles.ticketView)} aria-labelledby="jira-ticket-view-heading">
      <h3 {...stylex.props(styles.ticketViewTitle)} id="jira-ticket-view-heading">
        Opening tickets
      </h3>
      <label {...stylex.props(styles.ticketViewLabel)} htmlFor="jira-ticket-view">
        Default ticket view
      </label>
      <select
        id="jira-ticket-view"
        {...inputStyle}
        className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${inputStyle.className}`}
        value={selectedView}
        disabled={saving}
        aria-describedby="jira-ticket-view-hint"
        onChange={(event) => void save(event.target.value as NonNullable<AppSettings['jiraTicketView']>)}
      >
        <option value="website">Full Jira page</option>
        <option value="summary">Ticket summary</option>
      </select>
      <p {...stylex.props(styles.ticketViewDescription)} id="jira-ticket-view-hint">
        {selectedView === 'website'
          ? 'Edit tickets and add comments inside Branchline. Sign in to Jira separately for each account.'
          : 'Show the ticket title and description in a compact, read-only view using your API token.'}
      </p>
      {saving && (
        <span {...stylex.props(styles.ticketViewStatus)} role="status">
          <Spinner size={13} />
          Saving preference…
        </span>
      )}
      {saved && (
        <span {...stylex.props(styles.ticketViewStatus)} role="status">
          <Check size={13} />
          Preference saved
        </span>
      )}
      {error && <FormError>{error}</FormError>}
    </section>
  );
}

const styles = stylex.create({
  ticketViewInput: { width: 260, maxWidth: '100%', height: 38, fontSize: typeScale.body },
  ticketView: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    marginTop: 34,
    paddingTop: spacing.xxl,
  },
  ticketViewTitle: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '18px',
    marginLeft: '0',
    color: colors.accent,
    fontSize: 14,
    fontWeight: 500,
  },
  ticketViewLabel: { display: 'block', marginBottom: spacing.md, fontSize: typeScale.body },
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
  ticketViewDescription: {
    marginTop: '10px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
  },
  ticketViewStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    color: colors.successText,
    fontSize: typeScale.compact,
  },
});
