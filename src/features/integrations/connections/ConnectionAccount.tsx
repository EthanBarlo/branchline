import * as stylex from '@stylexjs/stylex';
import { Check } from 'lucide-react';
import type { ConnectionInfo } from '../../../../shared/integrations';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Spinner } from '../../../ui/Spinner';
import { ConnectionTextButton } from './ConnectionTextButton';
import type { ConnectionOperation } from './useConnections';

const styles = stylex.create({
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
});

interface ConnectionAccountProps {
  connection: ConnectionInfo;
  busy: ConnectionOperation;
  onTest: (connection: ConnectionInfo) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDisconnect: (connection: ConnectionInfo) => void;
}
export function ConnectionAccount({
  connection,
  busy,
  onTest,
  onEdit,
  onDisconnect,
}: ConnectionAccountProps) {
  return (
    <article
      {...stylex.props(styles.account)}
      aria-label={`${connection.label || connection.displayName} account`}
    >
      <div {...stylex.props(styles.accountTop)}>
        <div {...stylex.props(styles.accountIdentity)}>
          <strong {...stylex.props(styles.accountName)}>{connection.label || connection.displayName}</strong>
          <span {...stylex.props(styles.accountDetail)}>
            {connection.displayName} · {connection.email}
          </span>
          {connection.siteUrl && <span {...stylex.props(styles.accountDetail)}>{connection.siteUrl}</span>}
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
          <ConnectionTextButton disabled={!!busy || !connection.connected} onClick={() => onTest(connection)}>
            {busy === `test:${connection.id}` ? <Spinner size={12} /> : <Check size={12} />}Test
          </ConnectionTextButton>
          <ConnectionTextButton disabled={!!busy} onClick={() => onEdit(connection)}>
            {connection.connected ? 'Replace token' : 'Reconnect'}
          </ConnectionTextButton>
          <ConnectionTextButton
            disabled={!!busy || !connection.connected}
            aria-label={`Disconnect ${connection.label || connection.displayName}`}
            onClick={() => onDisconnect(connection)}
          >
            {busy === `disconnect:${connection.id}` && <Spinner size={12} />}Disconnect
          </ConnectionTextButton>
        </div>
      </div>
    </article>
  );
}
