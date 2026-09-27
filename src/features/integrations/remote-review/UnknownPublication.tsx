import * as stylex from '@stylexjs/stylex';
import { ExternalLink } from 'lucide-react';
import type { FeedbackItem, PullRequest } from '../../../../shared/integrations';
import { pullRequestKey } from '../../../../shared/integrations';
import { colors, spacing, typeScale } from '../../../theme/tokens.stylex';
import { Button } from '../../../ui/Button';
import { TextInput } from '../../../ui/Field';
import { IntegrationLink } from '../IntegrationLink';

const styles = stylex.create({
  unknownDelivery: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.warningBorder,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    fontSize: typeScale.small,
  },
  note: {
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.65,
    marginBlock: '10px',
    marginInline: '0',
  },
  linkIcon: { flexShrink: '0' },
  unknownCommentLink: { display: 'flex', gap: spacing.md, marginBlock: spacing.lg, marginInline: '0' },
  unknownCommentInput: { height: '29px', fontSize: typeScale.small, maxWidth: '165px' },
  unknownCommentButton: { minHeight: '29px', fontSize: typeScale.small },
  checkbox: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: '9px',
  },
  checkboxInput: { accentColor: colors.accent, marginTop: spacing.xxs, flexShrink: '0' },
  checkboxContent: { display: 'flex', flexDirection: 'column', gap: '5px' },
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
});

interface UnknownPublicationProps {
  item: FeedbackItem;
  pullRequests: PullRequest[];
  busy: boolean;
  unknownId: string;
  checkedDelivery: boolean;
  onUnknownIdChange: (value: string) => void;
  onCheckedDeliveryChange: (checked: boolean) => void;
  onReconcile: (remoteId: number | null) => void;
}
export function UnknownPublication({
  item,
  pullRequests,
  busy,
  unknownId,
  checkedDelivery,
  onUnknownIdChange,
  onCheckedDeliveryChange,
  onReconcile,
}: UnknownPublicationProps) {
  return (
    <div {...stylex.props(styles.unknownDelivery)}>
      <p {...stylex.props(styles.note)}>
        Delivery is uncertain. Check Bitbucket before deciding whether to retry.
      </p>
      {pullRequests
        .filter((pr) => pr.repository.relativePath === item.repositoryPath && pr.id === item.prId)
        .map((pr) => (
          <IntegrationLink key={pullRequestKey(pr)} url={pr.url} variant="retry">
            Check PR #{pr.id} in Bitbucket
            <ExternalLink size={11} {...stylex.props(styles.linkIcon)} />
          </IntegrationLink>
        ))}
      <div {...stylex.props(styles.unknownCommentLink)}>
        <TextInput
          {...stylex.props(styles.unknownCommentInput)}
          type="text"
          inputMode="numeric"
          aria-label="Existing Bitbucket comment ID"
          placeholder="Existing comment ID"
          value={unknownId}
          disabled={busy}
          onChange={(event) => onUnknownIdChange(event.target.value)}
        />
        <Button
          variant="secondary"
          type="button"
          {...stylex.props(styles.unknownCommentButton)}
          disabled={busy || !/^[1-9]\d*$/.test(unknownId) || !Number.isSafeInteger(Number(unknownId))}
          onClick={() => onReconcile(Number(unknownId))}
        >
          Link existing comment
        </Button>
      </div>
      <label {...stylex.props(styles.checkbox)}>
        <input
          {...stylex.props(styles.checkboxInput)}
          type="checkbox"
          checked={checkedDelivery}
          disabled={busy}
          onChange={(event) => onCheckedDeliveryChange(event.target.checked)}
        />
        <span {...stylex.props(styles.checkboxContent)}>
          I checked Bitbucket: this comment was not posted.
        </span>
      </label>
      <button
        type="button"
        {...stylex.props(styles.link)}
        disabled={busy || !checkedDelivery}
        onClick={() => onReconcile(null)}
      >
        Allow retry
      </button>
    </div>
  );
}
