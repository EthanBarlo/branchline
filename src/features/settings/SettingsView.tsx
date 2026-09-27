import * as stylex from '@stylexjs/stylex';
import { useBlocker } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import type { UpdateState } from '../../../shared/updates';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { ConnectionSettings } from '../integrations/connections/ConnectionSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { DiagnosticSettings } from './DiagnosticSettings';
import { JiraLinkSettings } from './JiraLinkSettings';
import { JiraViewSettings } from './JiraViewSettings';
import { UpdateDetails } from './UpdateControls';
import { settingsSections as sections, type SettingsSection } from './settingsSections';

const styles = stylex.create({
  scroll: { flex: '1', minWidth: 0, overflow: 'auto', overscrollBehavior: 'contain' },
  view: { display: 'flex', flex: '1', minHeight: 0, backgroundColor: colors.canvas },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 0,
    flexShrink: 0,
    paddingTop: spacing.xxl,
    paddingRight: '17px',
    paddingBottom: '22px',
    paddingLeft: '17px',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    backgroundColor: colors.panel,
    flexBasis: { default: '220px', '@media (max-width: 1150px)': '205px' },
  },
  back: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'flex-start',
    paddingBlock: '7px',
    paddingInline: '9px',
    marginBottom: 27,
    borderWidth: 0,
    borderRadius: 5,
    backgroundColor: { default: 'transparent', ':hover': colors.raised },
    color: { default: colors.textSubtle, ':hover': colors.textPrimary },
    fontSize: typeScale.compact,
    opacity: { default: 1, ':disabled': 0.45 },
  },
  sidebarHeading: {
    paddingBlock: '0',
    paddingInline: '10px',
    marginBottom: 25,
  },
  sidebarTitle: { margin: 0, fontSize: 23, fontWeight: 550, letterSpacing: '-.6px' },
  sidebarDescription: {
    marginTop: '7px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
  },
  navigation: { display: 'flex', flexDirection: 'column', gap: 5 },
  navigationButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    paddingBlock: '11px',
    paddingInline: spacing.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: radii.lg,
    backgroundColor: { default: 'transparent', ':hover': colors.surface },
    textAlign: 'left',
    color: { default: colors.textMuted, ':hover': colors.textPrimary },
    fontSize: typeScale.body,
    opacity: { default: 1, ':disabled': 0.55 },
  },
  selectedNavigationButton: {
    backgroundColor: colors.raised,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
  },
  navigationDot: {
    width: 4,
    height: 4,
    marginLeft: 'auto',
    borderRadius: '50%',
    backgroundColor: colors.textSecondary,
  },
  sidebarFootnote: {
    marginTop: 'auto',
    paddingTop: '30px',
    paddingRight: '10px',
    paddingBottom: '0',
    paddingLeft: '10px',
    color: colors.textMuted,
    fontSize: typeScale.small,
    lineHeight: 1.75,
  },
  sidebarFootnoteDetail: { display: 'block', marginTop: spacing.sm, color: colors.textFaint },
  content: {
    maxWidth: 900,
    marginBlock: '0',
    marginInline: 'auto',
    paddingTop: { default: 42, '@media (max-width: 1150px)': 32 },
    paddingRight: { default: 48, '@media (max-width: 1150px)': 32 },
    paddingBottom: { default: 72, '@media (max-width: 1150px)': 60 },
    paddingLeft: { default: 48, '@media (max-width: 1150px)': 32 },
  },
  tabPanel: { minWidth: 0 },
  hidden: { display: 'none' },
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
  updateCard: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    borderRadius: 7,
    backgroundColor: colors.panel,
    overflow: 'hidden',
  },
});

export function SettingsView({
  section,
  onSectionChange,
  showLegacyLinks = false,
  settings,
  ticket,
  onSaved,
  onConnectionsChanged,
  onClose,
  updateState,
  updateBridgeError,
  onUpdateAction,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  showLegacyLinks?: boolean;
  settings: AppSettings;
  ticket: string | null;
  onSaved: (settings: AppSettings) => void;
  onConnectionsChanged: () => void;
  onClose: () => void;
  updateState: UpdateState | null;
  updateBridgeError: string | null;
  onUpdateAction: (action: 'check' | 'download' | 'install') => void;
}) {
  const [busy, setBusy] = useState({
    appearance: false,
    jira: false,
    bitbucket: false,
    links: false,
    ticketView: false,
  });
  const appearanceBusy = useCallback(
    (value: boolean) => setBusy((previous) => ({ ...previous, appearance: value })),
    [],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const jiraBusy = useCallback((value: boolean) => setBusy((previous) => ({ ...previous, jira: value })), []);
  const bitbucketBusy = useCallback(
    (value: boolean) => setBusy((previous) => ({ ...previous, bitbucket: value })),
    [],
  );
  const linksBusy = useCallback(
    (value: boolean) => setBusy((previous) => ({ ...previous, links: value })),
    [],
  );
  const ticketViewBusy = useCallback(
    (value: boolean) => setBusy((previous) => ({ ...previous, ticketView: value })),
    [],
  );
  const saving = Object.values(busy).some(Boolean);
  const blockWhileSaving = useCallback(() => saving, [saving]);
  useBlocker({ shouldBlockFn: blockWhileSaving, enableBeforeUnload: false });
  const scrollStyle = stylex.props(styles.scroll);
  useEffect(() => {
    document.getElementById(`settings-tab-${section}`)?.focus();
    scroll.current?.scrollTo({ top: 0 });
  }, [section]);
  function select(next: SettingsSection) {
    if (saving || next === section) return;
    onSectionChange(next);
  }

  return (
    <section {...stylex.props(styles.view)} role="region" aria-label="Settings">
      <aside {...stylex.props(styles.sidebar)}>
        <button {...stylex.props(styles.back)} type="button" disabled={saving} onClick={onClose}>
          <ArrowLeft size={15} />
          Back to review
        </button>
        <div {...stylex.props(styles.sidebarHeading)}>
          <h1 {...stylex.props(styles.sidebarTitle)}>Settings</h1>
          <p {...stylex.props(styles.sidebarDescription)}>
            Appearance, accounts and application preferences.
          </p>
        </div>
        <div
          {...stylex.props(styles.navigation)}
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
        >
          {sections.map(({ id, label, icon: Icon }, index) => (
            <button
              {...stylex.props(styles.navigationButton, section === id && styles.selectedNavigationButton)}
              key={id}
              id={`settings-tab-${id}`}
              role="tab"
              type="button"
              disabled={saving}
              aria-controls={`settings-panel-${id}`}
              aria-selected={section === id}
              tabIndex={section === id ? 0 : -1}
              onClick={() => select(id)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowDown'
                    ? (index + 1) % sections.length
                    : event.key === 'ArrowUp'
                      ? (index - 1 + sections.length) % sections.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? sections.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                select(sections[next].id);
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
              {section === id && <span {...stylex.props(styles.navigationDot)} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div {...stylex.props(styles.sidebarFootnote)}>
          Your accounts, on this device.
          <span {...stylex.props(styles.sidebarFootnoteDetail)}>
            Choose which accounts each project uses in Project integrations.
          </span>
        </div>
      </aside>
      <div {...scrollStyle} className={`settings-scroll ${scrollStyle.className}`} ref={scroll}>
        <div {...stylex.props(styles.content)}>
          <div
            id="settings-panel-appearance"
            {...stylex.props(styles.tabPanel, section !== 'appearance' && styles.hidden)}
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
            hidden={section !== 'appearance'}
          >
            <AppearanceSettings settings={settings} onSaved={onSaved} onBusyChange={appearanceBusy} />
          </div>
          <div
            id="settings-panel-jira"
            {...stylex.props(styles.tabPanel, section !== 'jira' && styles.hidden)}
            role="tabpanel"
            aria-labelledby="settings-tab-jira"
            hidden={section !== 'jira'}
          >
            <ConnectionSettings kind="jira" onChanged={onConnectionsChanged} onBusyChange={jiraBusy} />
            <JiraViewSettings settings={settings} onSaved={onSaved} onBusyChange={ticketViewBusy} />
            <JiraLinkSettings
              settings={settings}
              ticket={ticket}
              initiallyOpen={showLegacyLinks || !!settings.jiraBaseUrl}
              onSaved={onSaved}
              onBusyChange={linksBusy}
            />
          </div>
          <div
            id="settings-panel-bitbucket"
            {...stylex.props(styles.tabPanel, section !== 'bitbucket' && styles.hidden)}
            role="tabpanel"
            aria-labelledby="settings-tab-bitbucket"
            hidden={section !== 'bitbucket'}
          >
            <ConnectionSettings
              kind="bitbucket"
              onChanged={onConnectionsChanged}
              onBusyChange={bitbucketBusy}
            />
          </div>
          <div
            id="settings-panel-updates"
            {...stylex.props(styles.tabPanel, section !== 'updates' && styles.hidden)}
            role="tabpanel"
            aria-labelledby="settings-tab-updates"
            hidden={section !== 'updates'}
          >
            <header {...stylex.props(styles.pageHeading)}>
              <span {...stylex.props(styles.kicker)}>APPLICATION</span>
              <h2 {...stylex.props(styles.pageTitle)}>Updates</h2>
              <p {...stylex.props(styles.pageDescription)}>
                Keep Branchline current. Choose when to download and restart.
              </p>
            </header>
            <div {...stylex.props(styles.updateCard)}>
              <UpdateDetails
                state={updateState}
                bridgeError={updateBridgeError}
                onAction={onUpdateAction}
                onClose={onClose}
                embedded
              />
            </div>
          </div>
          <div
            id="settings-panel-diagnostics"
            {...stylex.props(styles.tabPanel, section !== 'diagnostics' && styles.hidden)}
            role="tabpanel"
            aria-labelledby="settings-tab-diagnostics"
            hidden={section !== 'diagnostics'}
          >
            <DiagnosticSettings visible={section === 'diagnostics'} />
          </div>
        </div>
      </div>
    </section>
  );
}
