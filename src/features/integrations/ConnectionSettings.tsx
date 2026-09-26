import * as stylex from '@stylexjs/stylex';
import { Check, Copy, ExternalLink, KeyRound, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { connectionScopes } from '../../../shared/connection-scopes';
import type { ConnectionInfo, ConnectionInput, ConnectionKind } from '../../../shared/integrations';
import { colors, fonts, radii, spacing, typeScale } from '../../tokens.stylex';
import { Spinner } from '../../ui/Spinner';

const styles = stylex.create({
  root: { width: '100%', maxWidth: 760, paddingBottom: 30 },
  headingEyebrow: {
    display: 'block',
    color: colors.textFaint,
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
    letterSpacing: '1.1px',
  },
  headingTitle: {
    marginTop: '9px',
    marginRight: '0',
    marginBottom: '7px',
    marginLeft: '0',
    fontSize: 28,
    fontWeight: 550,
    letterSpacing: '-.7px',
  },
  headingDescription: { margin: 0, color: colors.textSubtle, fontSize: typeScale.body, lineHeight: 1.7 },
  accountNote: {
    maxWidth: 610,
    marginTop: '15px',
    marginRight: '0',
    marginBottom: '27px',
    marginLeft: '0',
    color: colors.textQuiet,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
  },
  sectionTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.lg,
    marginBottom: 11,
  },
  sectionTitleHeading: { margin: 0, fontSize: typeScale.body, fontWeight: 550 },
  sectionTitleCount: { color: colors.textFaint, fontFamily: fonts.code, fontSize: typeScale.caption },
  account: {
    paddingBlock: '15px',
    paddingInline: spacing.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: 5,
    backgroundColor: colors.inset,
    marginTop: 9,
  },
  accountTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 },
  accountIdentity: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  accountName: { fontSize: typeScale.body, fontWeight: 550, overflowWrap: 'anywhere' },
  accountDetail: {
    color: colors.textMuted,
    fontSize: typeScale.small,
    overflowWrap: 'anywhere',
    lineHeight: 1.5,
  },
  accountState: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    fontSize: typeScale.caption,
    color: colors.successText,
    whiteSpace: 'nowrap',
    paddingTop: spacing.xxs,
  },
  disconnected: { color: colors.warningText },
  accountStateDot: { width: 4, height: 4, backgroundColor: 'currentColor', borderRadius: '50%' },
  accountBottom: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: { default: 12, '@media (max-width: 1050px)': 10 },
    marginTop: 15,
  },
  accountStorage: { color: colors.textFaint, fontSize: typeScale.caption },
  accountActions: { display: 'flex', flexWrap: 'wrap', gap: 15 },
  textButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 5,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover:not(:disabled)': colors.textPrimary },
    fontSize: typeScale.small,
    lineHeight: 1.6,
    textDecoration: { default: 'none', ':hover:not(:disabled)': 'underline' },
    textUnderlineOffset: { default: null, ':hover:not(:disabled)': 3 },
    opacity: { default: 1, ':disabled': 0.4 },
  },
  textButtonIcon: { flexShrink: 0 },
  addAccount: { marginTop: 18 },
  setup: {
    marginTop: 28,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    paddingTop: 22,
  },
  setupHeading: {
    marginTop: '0',
    marginRight: '0',
    marginBottom: '23px',
    marginLeft: '0',
    fontSize: 14,
    fontWeight: 550,
    outline: { default: null, ':focus': 'none' },
  },
  steps: { padding: 0, margin: 0, listStyle: 'none' },
  step: {
    display: 'grid',
    gridTemplateColumns: '27px minmax(0, 1fr)',
    gap: 14,
    paddingTop: '0',
    paddingRight: '0',
    paddingBottom: '27px',
    paddingLeft: '0',
  },
  stepAfterFirst: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    paddingTop: 25,
  },
  stepLast: { paddingBottom: 0 },
  stepNumber: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 25,
    height: 25,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderStrong,
    borderRadius: 5,
    color: colors.textTertiary,
    backgroundColor: colors.surface,
    fontFamily: fonts.code,
    fontSize: typeScale.small,
  },
  stepContent: { minWidth: 0 },
  stepHeading: {
    marginTop: spacing.xs,
    marginRight: '0',
    marginBottom: '13px',
    marginLeft: '0',
    fontSize: typeScale.body,
    fontWeight: 550,
  },
  stepText: {
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    marginTop: '11px',
    marginRight: '0',
    marginBottom: '14px',
    marginLeft: '0',
  },
  strong: { fontWeight: 550, color: colors.textEmphasis },
  field: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.md,
    minWidth: 0,
    marginTop: 15,
    fontSize: typeScale.small,
    color: colors.textEmphasis,
  },
  fieldInput: {
    width: '100%',
    height: 36,
    paddingBlock: '0',
    paddingInline: '11px',
    fontSize: typeScale.compact,
    backgroundColor: { default: colors.inset, ':read-only': colors.surface },
    color: { default: null, ':read-only': colors.textMuted },
    '::placeholder': { color: colors.textFaint },
  },
  fieldHint: { color: colors.textFaint, fontSize: typeScale.small, lineHeight: 1.6 },
  accountFields: { display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 15 },
  optional: { color: colors.textFaint, fontSize: typeScale.caption },
  optionalInField: { position: 'absolute', right: 0, top: 0 },
  setupLinkWrap: { display: 'inline-flex', flexDirection: 'column', verticalAlign: 'baseline' },
  prominentLink: {
    width: 'fit-content',
    marginTop: '1px',
    marginRight: '0',
    marginBottom: spacing.xxs,
    marginLeft: '0',
  },
  linkError: {
    display: 'block',
    fontSize: typeScale.small,
    color: colors.dangerText,
    overflowWrap: 'anywhere',
    lineHeight: 1.6,
    marginTop: 5,
  },
  scopeHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: '20px',
    marginRight: '0',
    marginBottom: '10px',
    marginLeft: '0',
  },
  scopeHeadingLabel: { fontSize: typeScale.small, color: colors.textSubtle },
  scopeCopyButton: { fontSize: typeScale.caption, color: colors.textQuiet },
  scopes: {
    margin: 0,
    paddingBlock: '0',
    paddingInline: '13px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.inset,
  },
  scope: {
    display: 'grid',
    gridTemplateColumns: {
      default: 'minmax(0, 1.25fr) minmax(0, 1fr)',
      '@media (max-width: 1050px)': 'minmax(0, 1.4fr) minmax(0, 1fr)',
    },
    alignItems: 'center',
    gap: 14,
    minHeight: 36,
    paddingBlock: spacing.md,
    paddingInline: '0',
  },
  scopeAfterFirst: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  scopeTerm: { margin: 0 },
  scopeCode: {
    fontSize: typeScale.small,
    color: colors.textEmphasis,
    userSelect: 'text',
    overflowWrap: 'anywhere',
  },
  scopeDescription: { margin: 0, fontSize: typeScale.small, color: colors.textQuiet, lineHeight: 1.5 },
  optionalScope: {
    paddingTop: spacing.lg,
    paddingRight: '13px',
    paddingBottom: '0',
    paddingLeft: '13px',
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: colors.border,
    marginTop: '14px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.md,
  },
  optionalScopeText: { margin: 0, color: colors.textQuiet, fontSize: typeScale.small, lineHeight: 1.7 },
  help: { marginBottom: 0, color: colors.textFaint, fontSize: typeScale.small },
  helpLinkWrap: { marginLeft: 3 },
  copyStatus: {
    fontSize: typeScale.small,
    marginTop: '9px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textSubtle,
  },
  storageNote: {
    display: 'flex',
    gap: spacing.md,
    color: colors.textFaint,
    fontSize: typeScale.small,
    marginTop: spacing.lg,
    marginRight: '0',
    marginBottom: '20px',
    marginLeft: '0',
  },
  storageIcon: { flexShrink: 0, marginTop: spacing.xxs },
  setupActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 20 },
  setupSubmit: { minHeight: 35 },
  problem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 9,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: 5,
    paddingBlock: spacing.lg,
    paddingInline: '14px',
    color: colors.warningText,
    backgroundColor: colors.warningSurface,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
    marginTop: 21,
    overflowWrap: 'anywhere',
  },
  problemIcon: { flexShrink: 0, marginTop: spacing.xxs },
  problemBody: { display: 'flex', flexDirection: 'column', gap: 9 },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: spacing.md,
    fontSize: typeScale.compact,
    lineHeight: 1.7,
    color: colors.textMuted,
    marginTop: '20px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    overflowWrap: 'anywhere',
  },
  successNotice: { color: colors.successText },
  noticeIcon: { flexShrink: 0, marginTop: spacing.xxs },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '7px',
    minHeight: '33px',
    paddingBlock: '0',
    paddingInline: spacing.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: '5px',
    fontSize: typeScale.compact,
    fontWeight: 550,
    whiteSpace: 'nowrap',
    transition: 'background-color 140ms, color 140ms, opacity 140ms, border-color 140ms',
    opacity: { default: null, ':disabled': '.4' },
  },
  'button-secondary': {
    backgroundColor: { default: colors.raised, ':hover:not(:disabled)': colors.hover },
    borderColor: { default: colors.borderStrong, ':hover:not(:disabled)': colors.borderSelected },
    color: colors.textDefault,
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
  'button-primary': {
    backgroundColor: { default: colors.accent, ':hover:not(:disabled)': colors.textPrimary },
    borderColor: { default: colors.accent, ':hover:not(:disabled)': colors.textPrimary },
    color: colors.textInverse,
  },
});

const TOKEN_SETTINGS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const providers = {
  jira: {
    name: 'Jira',
    description: 'Keep the ticket title and description beside your review.',
    scopes: connectionScopes.jira,
    docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
  },
  bitbucket: {
    name: 'Bitbucket',
    description: 'Review branches across repositories, create missing PRs, publish feedback and merge.',
    scopes: connectionScopes.bitbucket,
    docs: 'https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/',
  },
} as const;

const errorMessage = (reason: unknown) =>
  reason instanceof Error
    ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(reason);
const newConnection = (kind: ConnectionKind): ConnectionInput => ({
  kind,
  email: '',
  token: '',
  ...(kind === 'jira' ? { siteUrl: '' } : {}),
});

function SetupLink({
  url,
  children,
  prominent = false,
  inHelp = false,
}: {
  url: string;
  children: ReactNode;
  prominent?: boolean;
  inHelp?: boolean;
}) {
  const [error, setError] = useState('');
  const buttonStyle = stylex.props(prominent ? styles.prominentLink : styles.textButton);
  return (
    <span {...stylex.props(styles.setupLinkWrap, inHelp && styles.helpLinkWrap)}>
      <button
        type="button"
        role="link"
        {...buttonStyle}
        className={
          prominent
            ? `${`button button-secondary ${stylex.props(styles['button'], styles['button-secondary']).className}`} ${buttonStyle.className}`
            : buttonStyle.className
        }
        onClick={() => {
          setError('');
          void window.reviewAPI.openIntegrationLink(url).catch((reason) => setError(errorMessage(reason)));
        }}
      >
        {children}
        <ExternalLink size={12} aria-hidden="true" {...stylex.props(styles.textButtonIcon)} />
      </button>
      {error && (
        <span {...stylex.props(styles.linkError)} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function ConnectionSettings({
  kind,
  onChanged,
  onBusyChange,
}: {
  kind: ConnectionKind;
  onChanged: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const provider = providers[kind];
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [editor, setEditor] = useState<ConnectionInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const lock = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const editorHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void window.reviewAPI
      .getIntegrations()
      .then((state) => {
        if (!live) return;
        const accounts = state.connections.filter((connection) => connection.kind === kind);
        setConnections(accounts);
        if (!accounts.length) setEditor((previous) => previous || newConnection(kind));
      })
      .catch((reason) => {
        if (live) setError(errorMessage(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [kind, loadAttempt]);

  useEffect(
    () => () => {
      busyCallback.current?.(false);
    },
    [],
  );

  function updateAccount(connection: ConnectionInfo) {
    setConnections((previous) =>
      previous.some((item) => item.id === connection.id)
        ? previous.map((item) => (item.id === connection.id ? connection : item))
        : [...previous, connection],
    );
  }

  async function action(key: string, run: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    busyCallback.current?.(true);
    setError('');
    setStatus('');
    try {
      await run();
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      lock.current = false;
      setBusy('');
      busyCallback.current?.(false);
    }
  }

  function edit(connection?: ConnectionInfo) {
    setEditor(
      connection
        ? {
            id: connection.id,
            kind,
            label: connection.label,
            email: connection.email,
            token: '',
            siteUrl: connection.siteUrl,
          }
        : newConnection(kind),
    );
    setError('');
    setStatus('');
    setCopyStatus('');
    requestAnimationFrame(() => editorHeading.current?.focus());
  }

  function cancel() {
    setEditor(null);
    setError('');
    setCopyStatus('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !canSave) return;
    const input = {
      ...editor,
      email: editor.email.trim(),
      token: editor.token.trim(),
      siteUrl: editor.siteUrl?.trim(),
    };
    void action('save', async () => {
      const saved = await window.reviewAPI.saveConnection(input);
      updateAccount(saved);
      setEditor(null);
      setStatus(
        `${provider.name} account verified and saved. Choose it in your project integrations.${saved.storage === 'session' ? ' Secure storage is unavailable, so this token is kept for this session only.' : ''}`,
      );
    });
  }

  const selectedAccount = editor?.id
    ? connections.find((connection) => connection.id === editor.id)
    : undefined;
  const canSave =
    !!editor?.email.trim() &&
    !!editor?.token.trim() &&
    (kind !== 'jira' || !!editor.siteUrl?.trim()) &&
    !busy;

  const fieldInputStyle = stylex.props(styles.fieldInput);
  const submitStyle = stylex.props(styles.setupSubmit);
  const addAccountStyle = stylex.props(styles.addAccount);
  return (
    <section {...stylex.props(styles.root)} aria-label={`${provider.name} connections`}>
      <header>
        <span {...stylex.props(styles.headingEyebrow)}>CONNECTIONS</span>
        <h2 {...stylex.props(styles.headingTitle)}>{provider.name}</h2>
        <p {...stylex.props(styles.headingDescription)}>{provider.description}</p>
      </header>
      <p {...stylex.props(styles.accountNote)}>
        Jira and Bitbucket connect independently. Use the account for each service, even when their emails are
        different.
      </p>

      {loading && (
        <p {...stylex.props(styles.notice)} role="status">
          <Spinner size={14} />
          Loading accounts…
        </p>
      )}
      {!!connections.length && (
        <div>
          <div {...stylex.props(styles.sectionTitle)}>
            <h3 {...stylex.props(styles.sectionTitleHeading)}>Your accounts</h3>
            <span {...stylex.props(styles.sectionTitleCount)}>
              {connections.length} {connections.length === 1 ? 'account' : 'accounts'}
            </span>
          </div>
          {connections.map((connection) => (
            <article
              {...stylex.props(styles.account)}
              key={connection.id}
              aria-label={`${connection.label || connection.displayName} account`}
            >
              <div {...stylex.props(styles.accountTop)}>
                <div {...stylex.props(styles.accountIdentity)}>
                  <strong {...stylex.props(styles.accountName)}>
                    {connection.label || connection.displayName}
                  </strong>
                  <span {...stylex.props(styles.accountDetail)}>
                    {connection.displayName} · {connection.email}
                  </span>
                  {connection.siteUrl && (
                    <span {...stylex.props(styles.accountDetail)}>{connection.siteUrl}</span>
                  )}
                </div>
                <span {...stylex.props(styles.accountState, !connection.connected && styles.disconnected)}>
                  <span {...stylex.props(styles.accountStateDot)} />
                  {connection.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              <div {...stylex.props(styles.accountBottom)}>
                <small {...stylex.props(styles.accountStorage)}>
                  {!connection.connected
                    ? 'Reconnect to continue using this account.'
                    : connection.storage === 'session'
                      ? 'Session only · reconnect after restarting'
                      : 'Stored securely on this device'}
                </small>
                <div {...stylex.props(styles.accountActions)}>
                  <button
                    type="button"
                    {...stylex.props(styles.textButton)}
                    disabled={!!busy || !connection.connected}
                    onClick={() =>
                      void action(`test:${connection.id}`, async () => {
                        updateAccount(await window.reviewAPI.testConnection(connection.id));
                        setStatus(`${connection.label || connection.displayName}: connection verified.`);
                      })
                    }
                  >
                    {busy === `test:${connection.id}` ? <Spinner size={12} /> : <Check size={12} />}Test
                  </button>
                  <button
                    type="button"
                    {...stylex.props(styles.textButton)}
                    disabled={!!busy}
                    onClick={() => edit(connection)}
                  >
                    {connection.connected ? 'Replace token' : 'Reconnect'}
                  </button>
                  <button
                    type="button"
                    {...stylex.props(styles.textButton)}
                    disabled={!!busy || !connection.connected}
                    aria-label={`Disconnect ${connection.label || connection.displayName}`}
                    onClick={() =>
                      void action(`disconnect:${connection.id}`, async () => {
                        const state = await window.reviewAPI.disconnectConnection(connection.id);
                        setConnections(state.connections.filter((item) => item.kind === kind));
                        if (editor?.id === connection.id) setEditor(null);
                        setStatus(
                          `${connection.label || connection.displayName} disconnected. The saved token was removed.`,
                        );
                      })
                    }
                  >
                    {busy === `disconnect:${connection.id}` && <Spinner size={12} />}Disconnect
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && !editor && (
        <button
          type="button"
          {...addAccountStyle}
          className={`${`button button-secondary ${stylex.props(styles['button'], styles['button-secondary']).className}`} ${addAccountStyle.className}`}
          disabled={!!busy}
          onClick={() => edit()}
        >
          <Plus size={13} />
          {connections.length ? `Add another ${provider.name} account` : `Connect ${provider.name}`}
        </button>
      )}

      {editor && (
        <form {...stylex.props(styles.setup)} onSubmit={save}>
          <h3 {...stylex.props(styles.setupHeading)} ref={editorHeading} tabIndex={-1}>
            {editor.id
              ? selectedAccount?.connected
                ? 'Replace your API token'
                : `Reconnect ${provider.name}`
              : `Connect ${provider.name}`}
          </h3>
          <ol {...stylex.props(styles.steps)}>
            <li {...stylex.props(styles.step)}>
              <span {...stylex.props(styles.stepNumber)} aria-hidden="true">
                1
              </span>
              <div {...stylex.props(styles.stepContent)}>
                <h4 {...stylex.props(styles.stepHeading)}>
                  {kind === 'jira' ? 'Enter your Jira site and account' : 'Enter your Bitbucket account'}
                </h4>
                {kind === 'jira' && (
                  <label {...stylex.props(styles.field)}>
                    Jira site URL
                    <input
                      {...fieldInputStyle}
                      className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${fieldInputStyle.className}`}
                      aria-label="Jira site URL"
                      type="url"
                      placeholder="https://your-team.atlassian.net"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={!!busy}
                      readOnly={!!editor.id}
                      value={editor.siteUrl || ''}
                      onChange={(event) => setEditor({ ...editor, siteUrl: event.target.value })}
                    />
                    <small {...stylex.props(styles.fieldHint)}>
                      Use your Jira Cloud site address, including https://.
                    </small>
                  </label>
                )}
                <div {...stylex.props(styles.accountFields)}>
                  <label {...stylex.props(styles.field)}>
                    Account email
                    <input
                      {...fieldInputStyle}
                      className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${fieldInputStyle.className}`}
                      aria-label="Account email"
                      type="email"
                      placeholder="you@company.com"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      disabled={!!busy}
                      readOnly={!!editor.id}
                      value={editor.email}
                      onChange={(event) => setEditor({ ...editor, email: event.target.value })}
                    />
                  </label>
                  <label {...stylex.props(styles.field)}>
                    Account label{' '}
                    <span {...stylex.props(styles.optional, styles.optionalInField)}>Optional</span>
                    <input
                      {...fieldInputStyle}
                      className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${fieldInputStyle.className}`}
                      aria-label="Account label (optional)"
                      placeholder={`e.g. Work ${provider.name}`}
                      maxLength={200}
                      disabled={!!busy}
                      value={editor.label || ''}
                      onChange={(event) => setEditor({ ...editor, label: event.target.value })}
                    />
                  </label>
                </div>
                <p {...stylex.props(styles.stepText)}>
                  {editor.id
                    ? 'Use a new token for this same account. Add another account to connect a different identity or Jira site.'
                    : 'Use the email you sign in to Atlassian with. Each project can choose which account to use.'}
                </p>
              </div>
            </li>
            <li {...stylex.props(styles.step, styles.stepAfterFirst)}>
              <span {...stylex.props(styles.stepNumber)} aria-hidden="true">
                2
              </span>
              <div {...stylex.props(styles.stepContent)}>
                <h4 {...stylex.props(styles.stepHeading)}>Create a scoped API token</h4>
                <p {...stylex.props(styles.stepText)}>
                  Open Atlassian’s token settings and sign in with the email above. Choose{' '}
                  <strong {...stylex.props(styles.strong)}>Create API token with scopes</strong>, give it a
                  name and expiry, then select{' '}
                  <strong {...stylex.props(styles.strong)}>{provider.name}</strong>.
                </p>
                <SetupLink url={TOKEN_SETTINGS_URL} prominent>
                  Create {provider.name} API token
                </SetupLink>
                <div {...stylex.props(styles.scopeHeading)}>
                  <span {...stylex.props(styles.scopeHeadingLabel)}>
                    Required permissions{kind === 'jira' ? ' · Classic scopes' : ''}
                  </span>
                  <button
                    type="button"
                    {...stylex.props(styles.textButton, styles.scopeCopyButton)}
                    onClick={() => {
                      setCopyStatus('');
                      void window.reviewAPI
                        .copyConnectionScopes(kind)
                        .then(() => setCopyStatus('Scopes copied.'))
                        .catch(() =>
                          setCopyStatus(
                            'Could not copy. Select the scope names below to copy them manually.',
                          ),
                        );
                    }}
                  >
                    <Copy size={12} />
                    Copy required scopes
                  </button>
                </div>
                <dl {...stylex.props(styles.scopes)}>
                  {provider.scopes.map(([scope, description], index) => (
                    <div {...stylex.props(styles.scope, index > 0 && styles.scopeAfterFirst)} key={scope}>
                      <dt {...stylex.props(styles.scopeTerm)}>
                        <code {...stylex.props(styles.scopeCode)}>{scope}</code>
                      </dt>
                      <dd {...stylex.props(styles.scopeDescription)}>{description}</dd>
                    </div>
                  ))}
                </dl>
                {kind === 'bitbucket' && (
                  <div {...stylex.props(styles.optionalScope)}>
                    <span {...stylex.props(styles.optional)}>Repository write access</span>
                    <p {...stylex.props(styles.optionalScopeText)}>
                      Repositories · Write lets Branchline delete matching empty branches after merging and
                      optionally update submodule pointers. If your existing token only has repository read
                      access, replace it with a token containing all the scopes above.
                    </p>
                  </div>
                )}
                {copyStatus && (
                  <p {...stylex.props(styles.copyStatus)} role="status">
                    {copyStatus}
                  </p>
                )}
                <p {...stylex.props(styles.stepText, styles.help)}>
                  {kind === 'jira'
                    ? 'Choose these classic scopes within the scoped-token flow. Jira access stays limited to the issues your account can view.'
                    : 'These permissions enable branch reviews, PR creation, inline feedback, approval, merging and branch cleanup. Repository permissions and merge checks still apply.'}{' '}
                  <SetupLink url={provider.docs} inHelp>
                    Token setup guide
                  </SetupLink>
                </p>
              </div>
            </li>
            <li {...stylex.props(styles.step, styles.stepAfterFirst, styles.stepLast)}>
              <span {...stylex.props(styles.stepNumber)} aria-hidden="true">
                3
              </span>
              <div {...stylex.props(styles.stepContent)}>
                <h4 {...stylex.props(styles.stepHeading)}>Paste your token and connect</h4>
                <p {...stylex.props(styles.stepText)}>
                  Copy the token when Atlassian displays it, then paste it here.
                </p>
                <label {...stylex.props(styles.field)}>
                  API token
                  <input
                    {...fieldInputStyle}
                    className={`${`text-input ${stylex.props(styles['text-input']).className}`} ${fieldInputStyle.className}`}
                    aria-label="API token"
                    type="password"
                    placeholder="Paste your API token"
                    autoComplete="new-password"
                    spellCheck={false}
                    required
                    disabled={!!busy}
                    value={editor.token}
                    onChange={(event) => setEditor({ ...editor, token: event.target.value })}
                  />
                </label>
                <p {...stylex.props(styles.stepText, styles.storageNote)}>
                  <ShieldCheck size={14} {...stylex.props(styles.storageIcon)} />
                  <span>
                    Branchline verifies the account before saving. Tokens are encrypted on this device, or
                    kept only for this session if secure storage is unavailable.
                  </span>
                </p>
                <div {...stylex.props(styles.setupActions)}>
                  <button
                    type="button"
                    {...stylex.props(styles.textButton)}
                    disabled={!!busy}
                    onClick={cancel}
                  >
                    Cancel connection
                  </button>
                  <button
                    type="submit"
                    {...submitStyle}
                    className={`${`button button-primary ${stylex.props(styles['button'], styles['button-primary']).className}`} ${submitStyle.className}`}
                    disabled={!canSave}
                  >
                    {busy === 'save' ? <Spinner size={13} /> : <KeyRound size={13} />}Verify and save account
                  </button>
                </div>
              </div>
            </li>
          </ol>
        </form>
      )}

      {error && (
        <div {...stylex.props(styles.problem)} role="alert">
          <TriangleAlert size={15} {...stylex.props(styles.problemIcon)} />
          <div {...stylex.props(styles.problemBody)}>
            <span>{error}</span>
            {!loading && !editor && !connections.length && (
              <button
                type="button"
                {...stylex.props(styles.textButton)}
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                Retry loading accounts
              </button>
            )}
          </div>
        </div>
      )}
      {status && (
        <p {...stylex.props(styles.notice, styles.successNotice)} role="status">
          <Check size={14} {...stylex.props(styles.noticeIcon)} />
          <span>{status}</span>
        </p>
      )}
    </section>
  );
}
