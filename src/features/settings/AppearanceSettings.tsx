import * as stylex from '@stylexjs/stylex';
import { Check, Monitor, Moon, Sun, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { errorMessage as message } from '../../ui/errorMessage';
import { Spinner } from '../../ui/Spinner';

const themes = [
  {
    id: 'system',
    label: 'System',
    description: 'Match your device appearance and follow changes automatically.',
    icon: Monitor,
  },
  { id: 'light', label: 'Light', description: 'Use the light appearance at any time.', icon: Sun },
  { id: 'dark', label: 'Dark', description: 'Use the dark appearance at any time.', icon: Moon },
] as const;

export function AppearanceSettings({
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
  const errorStyle = stylex.props(styles.themeError);
  async function save(theme: AppSettings['theme']) {
    if (inFlight.current || theme === settings.theme) return;
    inFlight.current = true;
    setSaving(true);
    onBusyChange(true);
    setError('');
    setSaved(false);
    try {
      onSaved(await window.reviewAPI.updateSettings({ theme }));
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
    <section aria-labelledby="appearance-heading">
      <header {...stylex.props(styles.pageHeading)}>
        <span {...stylex.props(styles.kicker)}>APPLICATION</span>
        <h2 {...stylex.props(styles.pageTitle)} id="appearance-heading">
          Appearance
        </h2>
        <p {...stylex.props(styles.pageDescription)}>Choose how Branchline looks on this device.</p>
      </header>
      <fieldset
        {...stylex.props(styles.themeChoices)}
        disabled={saving}
        aria-describedby="settings-theme-hint"
      >
        <legend {...stylex.props(styles.themeLegend)}>Theme</legend>
        <p {...stylex.props(styles.themeHint)} id="settings-theme-hint">
          Changes apply as soon as you choose an option. System is the default.
        </p>
        <div {...stylex.props(styles.themeOptions)}>
          {themes.map(({ id, label, description, icon: Icon }) => (
            <label
              key={id}
              {...stylex.props(
                styles.themeOption,
                settings.theme === id && styles.selectedThemeOption,
                saving && styles.disabledThemeOption,
              )}
            >
              <input
                {...stylex.props(styles.themeInput)}
                type="radio"
                name="branchline-theme"
                value={id}
                checked={settings.theme === id}
                onChange={() => void save(id)}
              />
              <Icon size={18} aria-hidden="true" {...stylex.props(styles.themeIcon)} />
              <span {...stylex.props(styles.themeOptionBody)}>
                <strong {...stylex.props(styles.themeOptionTitle)}>{label}</strong>
                <small {...stylex.props(styles.themeOptionDescription)}>{description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {saving && (
        <span {...stylex.props(styles.themeStatus)} role="status">
          <Spinner size={13} />
          Saving preference…
        </span>
      )}
      {saved && (
        <span {...stylex.props(styles.themeStatus)} role="status">
          <Check size={13} />
          Preference saved
        </span>
      )}
      {error && (
        <div
          {...errorStyle}
          className={`${`form-error ${stylex.props(styles['form-error']).className}`} ${errorStyle.className}`}
          role="alert"
        >
          <TriangleAlert size={15} />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}

const styles = stylex.create({
  themeError: { marginTop: spacing.xl },
  pageHeading: { marginBottom: 31 },
  kicker: {
    color: colors.textQuiet,
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    letterSpacing: '1.3px',
  },
  pageTitle: {
    marginTop: spacing.lg,
    marginRight: '0',
    marginBottom: '10px',
    marginLeft: '0',
    fontSize: 28,
    fontWeight: 500,
    letterSpacing: '-.8px',
  },
  pageDescription: { margin: 0, fontSize: typeScale.body, lineHeight: 1.8, color: colors.textMuted },
  themeChoices: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  themeLegend: { marginBottom: 5, padding: 0, fontSize: typeScale.body, fontWeight: 550 },
  themeHint: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: spacing.xl,
    marginLeft: '0',
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
  },
  themeOptions: { display: 'grid', gap: 9, maxWidth: 580 },
  themeOption: {
    display: 'flex',
    alignItems: 'center',
    gap: 15,
    minHeight: 75,
    paddingBlock: '14px',
    paddingInline: spacing.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: 7,
    backgroundColor: { default: colors.surface, ':hover': colors.raised },
    cursor: 'pointer',
    outlineWidth: { default: 0, ':focus-within': 2 },
    outlineStyle: { default: 'none', ':focus-within': 'solid' },
    outlineColor: colors.focus,
    outlineOffset: { default: null, ':focus-within': 2 },
  },
  selectedThemeOption: { borderColor: colors.focus, backgroundColor: colors.raised },
  disabledThemeOption: { cursor: 'default' },
  themeInput: {
    flexGrow: '0',
    flexShrink: '0',
    flexBasis: 'auto',
    margin: 0,
    accentColor: colors.accent,
  },
  themeIcon: {
    flexGrow: '0',
    flexShrink: '0',
    flexBasis: 'auto',
    color: colors.textMuted,
  },
  themeOptionBody: { display: 'grid', gap: spacing.xs, minWidth: 0 },
  themeOptionTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: 550 },
  themeOptionDescription: { color: colors.textMuted, fontSize: typeScale.compact, lineHeight: 1.45 },
  themeStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
    color: colors.textMuted,
    fontSize: typeScale.compact,
  },
  'form-error': {
    marginTop: '18px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: '10px',
    backgroundColor: colors.dangerSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.warningRaised,
    borderRadius: radii.md,
    fontSize: typeScale.small,
    color: colors.warningText,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
});
