import * as stylex from '@stylexjs/stylex';
import { useState, type ReactNode } from 'react';
import { colors, fonts, radii, spacing, typeScale } from '../../theme/tokens.stylex';
import { Button } from '../../ui/Button';
import { errorMessage } from '../../lib/errorMessage';

export function IntegrationLink({
  url,
  children,
  button = false,
  variant,
}: {
  url: string;
  children: ReactNode;
  button?: boolean;
  variant?: 'pullRequest' | 'description' | 'feedback' | 'branch' | 'merge' | 'publication' | 'retry';
}) {
  const [error, setError] = useState('');
  const linkStyle = stylex.props(
    styles.link,
    variant === 'pullRequest' && styles.prRowLink,
    variant === 'description' && styles.jiraDescriptionLink,
    variant === 'feedback' && styles.feedbackOpenPR,
    variant === 'branch' && styles.branchRepoLink,
    variant === 'merge' && styles.mergeNameLink,
    variant === 'publication' && styles.feedbackPublicationLink,
    variant === 'retry' && styles.unknownDeliveryRetry,
  );
  const open = () => {
    setError('');
    void window.reviewAPI.openIntegrationLink(url).catch((reason) => setError(errorMessage(reason)));
  };
  return (
    <>
      {button ? (
        <Button type="button" role="link" {...linkStyle} onClick={open}>
          {children}
        </Button>
      ) : (
        <button type="button" role="link" {...linkStyle} onClick={open}>
          {children}
        </button>
      )}
      {error && (
        <span
          {...stylex.props(styles.inlineError, variant === 'feedback' && styles.feedbackLinkError)}
          role="alert"
        >
          {error}
        </span>
      )}
    </>
  );
}

const styles = stylex.create({
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '0',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: colors.textTertiary, ':hover': colors.textPrimary },
    textDecoration: { default: 'none', ':hover': 'underline' },
    opacity: { default: 1, ':disabled': 0.4 },
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    overflowWrap: 'anywhere',
  },
  prRowLink: { color: colors.textSecondary, fontSize: typeScale.compact },
  jiraDescriptionLink: { color: colors.textDefault, textDecoration: 'underline' },
  feedbackOpenPR: {
    minHeight: '30px',
    paddingBlock: '0',
    paddingInline: '10px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: colors.borderStrong, ':hover': colors.borderSelected },
    borderRadius: radii.md,
    backgroundColor: { default: colors.interactive, ':hover': colors.hover },
    color: colors.textSecondary,
    textDecoration: { default: 'none', ':hover': 'none' },
    fontSize: typeScale.small,
    fontWeight: 550,
    whiteSpace: 'nowrap',
  },
  branchRepoLink: { fontSize: typeScale.caption, justifySelf: 'end' },
  mergeNameLink: {
    flexShrink: '0',
    color: colors.textQuiet,
    fontFamily: fonts.code,
    fontSize: typeScale.caption,
  },
  feedbackPublicationLink: { fontSize: typeScale.small, marginTop: spacing.sm },
  unknownDeliveryRetry: { marginTop: '10px' },
  inlineError: { display: 'block', color: colors.dangerText, fontSize: typeScale.small },
  feedbackLinkError: { marginTop: '5px', overflowWrap: 'anywhere' },
});
