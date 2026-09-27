import * as stylex from '@stylexjs/stylex';
import { Copy } from 'lucide-react';
import type { ConnectionKind } from '../../../../shared/integrations';
import { colors, radii, spacing, typeScale } from '../../../theme/tokens.stylex';
import { connectionProviders, TOKEN_SETTINGS_URL } from './connectionProviders';
import { ConnectionSetupLink } from './ConnectionSetupLink';
import { ConnectionTextButton } from './ConnectionTextButton';

const styles = stylex.create({
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
  optional: { color: colors.textFaint, fontSize: typeScale.caption },
  optionalScopeText: { margin: 0, color: colors.textQuiet, fontSize: typeScale.small, lineHeight: 1.7 },
  copyStatus: {
    fontSize: typeScale.small,
    marginTop: '9px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textSubtle,
  },
  help: { marginBottom: 0, color: colors.textFaint, fontSize: typeScale.small },
});

export function ConnectionScopes({
  kind,
  copyStatus,
  onCopyScopes,
}: {
  kind: ConnectionKind;
  copyStatus: string;
  onCopyScopes: () => void;
}) {
  const provider = connectionProviders[kind];
  return (
    <>
      <p {...stylex.props(styles.stepText)}>
        Open Atlassian’s token settings and sign in with the email above. Choose{' '}
        <strong {...stylex.props(styles.strong)}>Create API token with scopes</strong>, give it a name and
        expiry, then select <strong {...stylex.props(styles.strong)}>{provider.name}</strong>.
      </p>
      <ConnectionSetupLink url={TOKEN_SETTINGS_URL} prominent>
        Create {provider.name} API token
      </ConnectionSetupLink>
      <div {...stylex.props(styles.scopeHeading)}>
        <span {...stylex.props(styles.scopeHeadingLabel)}>
          Required permissions{kind === 'jira' ? ' · Classic scopes' : ''}
        </span>
        <ConnectionTextButton xstyle={styles.scopeCopyButton} onClick={onCopyScopes}>
          <Copy size={12} />
          Copy required scopes
        </ConnectionTextButton>
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
            Repositories · Write lets Branchline delete matching empty branches after merging and optionally
            update submodule pointers. If your existing token only has repository read access, replace it with
            a token containing all the scopes above.
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
        <ConnectionSetupLink url={provider.docs} inHelp>
          Token setup guide
        </ConnectionSetupLink>
      </p>
    </>
  );
}
