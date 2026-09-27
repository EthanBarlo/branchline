import * as stylex from '@stylexjs/stylex';
import { KeyRound, ShieldCheck } from 'lucide-react';
import type { FormEvent, Ref } from 'react';
import type { ConnectionInfo, ConnectionInput, ConnectionKind } from '../../../../shared/integrations';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { TextInput } from '../../../ui/Field';
import { Spinner } from '../../../ui/Spinner';
import { connectionProviders } from './connectionProviders';
import { ConnectionScopes } from './ConnectionScopes';
import { ConnectionStep } from './ConnectionStep';
import { ConnectionTextButton } from './ConnectionTextButton';
import type { ConnectionOperation } from './useConnections';

const styles = stylex.create({
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
    color: { default: colors.textDefault, ':read-only': colors.textMuted },
    '::placeholder': { color: colors.textFaint },
  },
  fieldHint: { color: colors.textFaint, fontSize: typeScale.small, lineHeight: 1.6 },
  accountFields: { display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 15 },
  optional: { color: colors.textFaint, fontSize: typeScale.caption },
  optionalInField: { position: 'absolute', right: 0, top: 0 },
  stepText: {
    color: colors.textMuted,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    marginTop: '11px',
    marginRight: '0',
    marginBottom: '14px',
    marginLeft: '0',
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
});

interface ConnectionEditorProps {
  kind: ConnectionKind;
  editor: ConnectionInput;
  selectedAccount?: ConnectionInfo;
  busy: ConnectionOperation;
  canSave: boolean;
  copyStatus: string;
  headingRef: Ref<HTMLHeadingElement>;
  onChange: (input: ConnectionInput) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  onCopyScopes: () => void;
}
export function ConnectionEditor({
  kind,
  editor,
  selectedAccount,
  busy,
  canSave,
  copyStatus,
  headingRef,
  onChange,
  onSave,
  onCancel,
  onCopyScopes,
}: ConnectionEditorProps) {
  const provider = connectionProviders[kind];
  return (
    <form {...stylex.props(styles.setup)} onSubmit={onSave}>
      <h3 {...stylex.props(styles.setupHeading)} ref={headingRef} tabIndex={-1}>
        {editor.id
          ? selectedAccount?.connected
            ? 'Replace your API token'
            : `Reconnect ${provider.name}`
          : `Connect ${provider.name}`}
      </h3>
      <ol {...stylex.props(styles.steps)}>
        <ConnectionStep
          number={1}
          title={kind === 'jira' ? 'Enter your Jira site and account' : 'Enter your Bitbucket account'}
        >
          {kind === 'jira' && (
            <label {...stylex.props(styles.field)}>
              Jira site URL
              <TextInput
                xstyle={styles.fieldInput}
                aria-label="Jira site URL"
                type="url"
                placeholder="https://your-team.atlassian.net"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={!!busy}
                readOnly={!!editor.id}
                value={editor.siteUrl || ''}
                onChange={(event) => onChange({ ...editor, siteUrl: event.target.value })}
              />
              <small {...stylex.props(styles.fieldHint)}>
                Use your Jira Cloud site address, including https://.
              </small>
            </label>
          )}
          <div {...stylex.props(styles.accountFields)}>
            <label {...stylex.props(styles.field)}>
              Account email
              <TextInput
                xstyle={styles.fieldInput}
                aria-label="Account email"
                type="email"
                placeholder="you@company.com"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={!!busy}
                readOnly={!!editor.id}
                value={editor.email}
                onChange={(event) => onChange({ ...editor, email: event.target.value })}
              />
            </label>
            <label {...stylex.props(styles.field)}>
              Account label <span {...stylex.props(styles.optional, styles.optionalInField)}>Optional</span>
              <TextInput
                xstyle={styles.fieldInput}
                aria-label="Account label (optional)"
                placeholder={`e.g. Work ${provider.name}`}
                maxLength={200}
                disabled={!!busy}
                value={editor.label || ''}
                onChange={(event) => onChange({ ...editor, label: event.target.value })}
              />
            </label>
          </div>
          <p {...stylex.props(styles.stepText)}>
            {editor.id
              ? 'Use a new token for this same account. Add another account to connect a different identity or Jira site.'
              : 'Use the email you sign in to Atlassian with. Each project can choose which account to use.'}
          </p>
        </ConnectionStep>
        <ConnectionStep number={2} title="Create a scoped API token">
          <ConnectionScopes kind={kind} copyStatus={copyStatus} onCopyScopes={onCopyScopes} />
        </ConnectionStep>
        <ConnectionStep number={3} title="Paste your token and connect">
          <p {...stylex.props(styles.stepText)}>
            Copy the token when Atlassian displays it, then paste it here.
          </p>
          <label {...stylex.props(styles.field)}>
            API token
            <TextInput
              xstyle={styles.fieldInput}
              aria-label="API token"
              type="password"
              placeholder="Paste your API token"
              autoComplete="new-password"
              spellCheck={false}
              required
              disabled={!!busy}
              value={editor.token}
              onChange={(event) => onChange({ ...editor, token: event.target.value })}
            />
          </label>
          <p {...stylex.props(styles.stepText, styles.storageNote)}>
            <ShieldCheck size={14} {...stylex.props(styles.storageIcon)} />
            <span>
              Branchline verifies the account before saving. Tokens are encrypted on this device, or kept only
              for this session if secure storage is unavailable.
            </span>
          </p>
          <div {...stylex.props(styles.setupActions)}>
            <ConnectionTextButton disabled={!!busy} onClick={onCancel}>
              Cancel connection
            </ConnectionTextButton>
            <Button type="submit" variant="primary" xstyle={styles.setupSubmit} disabled={!canSave}>
              {busy === 'save' ? <Spinner size={13} /> : <KeyRound size={13} />}Verify and save account
            </Button>
          </div>
        </ConnectionStep>
      </ol>
    </form>
  );
}
