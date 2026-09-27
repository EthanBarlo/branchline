import * as stylex from '@stylexjs/stylex';
import { Check, Plus, TriangleAlert } from 'lucide-react';
import { colors, fonts, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/Spinner';
import { ConnectionAccount } from './ConnectionAccount';
import { ConnectionEditor } from './ConnectionEditor';
import { ConnectionTextButton } from './ConnectionTextButton';
import { connectionProviders } from './connectionProviders';
import { useConnections, type ConnectionSettingsProps } from './useConnections';

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
  addAccount: { marginTop: 18 },
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
});

export function ConnectionSettings(props: ConnectionSettingsProps) {
  const { kind } = props;
  const provider = connectionProviders[kind];
  const {
    connections,
    editor,
    loading,
    busy,
    error,
    status,
    copyStatus,
    editorHeading,
    selectedAccount,
    canSave,
    edit,
    cancel,
    save,
    test,
    disconnect,
    copyScopes,
    setEditor,
    retry,
  } = useConnections(props);
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
            <ConnectionAccount
              key={connection.id}
              connection={connection}
              busy={busy}
              onTest={test}
              onEdit={edit}
              onDisconnect={disconnect}
            />
          ))}
        </div>
      )}

      {!loading && !editor && (
        <Button type="button" xstyle={styles.addAccount} disabled={!!busy} onClick={() => edit()}>
          <Plus size={13} />
          {connections.length ? `Add another ${provider.name} account` : `Connect ${provider.name}`}
        </Button>
      )}

      {editor && (
        <ConnectionEditor
          kind={kind}
          editor={editor}
          selectedAccount={selectedAccount}
          busy={busy}
          canSave={canSave}
          copyStatus={copyStatus}
          headingRef={editorHeading}
          onChange={setEditor}
          onSave={save}
          onCancel={cancel}
          onCopyScopes={copyScopes}
        />
      )}

      {error && (
        <div {...stylex.props(styles.problem)} role="alert">
          <TriangleAlert size={15} {...stylex.props(styles.problemIcon)} />
          <div {...stylex.props(styles.problemBody)}>
            <span>{error}</span>
            {!loading && !editor && !connections.length && (
              <ConnectionTextButton onClick={retry}>Retry loading accounts</ConnectionTextButton>
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
