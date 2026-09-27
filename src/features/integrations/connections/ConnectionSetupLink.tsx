import * as stylex from '@stylexjs/stylex';
import { ExternalLink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { errorMessage } from '../../../lib/errorMessage';
import { ConnectionTextButton } from './ConnectionTextButton';

const styles = stylex.create({
  setupLinkWrap: { display: 'inline-flex', flexDirection: 'column', verticalAlign: 'baseline' },
  helpLinkWrap: { marginLeft: 3 },
  prominentLink: {
    width: 'fit-content',
    marginTop: '1px',
    marginRight: '0',
    marginBottom: spacing.xxs,
    marginLeft: '0',
  },
  textButtonIcon: { flexShrink: 0 },
  linkError: {
    display: 'block',
    fontSize: typeScale.small,
    color: colors.dangerText,
    overflowWrap: 'anywhere',
    lineHeight: 1.6,
    marginTop: 5,
  },
});

export function ConnectionSetupLink({
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
  const LinkButton = prominent ? Button : ConnectionTextButton;
  return (
    <span {...stylex.props(styles.setupLinkWrap, inHelp && styles.helpLinkWrap)}>
      <LinkButton
        type="button"
        role="link"
        xstyle={prominent && styles.prominentLink}
        onClick={() => {
          setError('');
          void window.reviewAPI.openIntegrationLink(url).catch((reason) => setError(errorMessage(reason)));
        }}
      >
        {children}
        <ExternalLink size={12} aria-hidden="true" {...stylex.props(styles.textButtonIcon)} />
      </LinkButton>
      {error && (
        <span {...stylex.props(styles.linkError)} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
