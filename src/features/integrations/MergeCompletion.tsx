import * as stylex from '@stylexjs/stylex';
import { CircleCheck, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { RemoteReviewState } from '../../../shared/integrations';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { Button } from '../../ui/Button';
import { DialogFooter } from '../../ui/Dialog';
import { Spinner } from '../../ui/Spinner';
import { IntegrationDialog, IntegrationError } from './IntegrationPrimitives';
import { MergeProgressView } from './MergeProgressView';

export function MergeCompletion({
  remote,
  jiraLink,
  onDismiss,
}: {
  reviewId: string;
  remote: RemoteReviewState;
  jiraLink: { key: string; url: string } | null;
  onDismiss: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  async function openTicket() {
    if (opening || !jiraLink) return;
    setOpening(true);
    setError('');
    // The completed review has been removed. The captured, validated URL keeps
    // this action available without looking up deleted review data.
    try {
      await window.reviewAPI.openIntegrationLink(jiraLink.url);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : 'The Jira ticket could not be opened.',
      );
    } finally {
      setOpening(false);
    }
  }
  return (
    <IntegrationDialog title="Pull requests merged" onClose={onDismiss}>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.summary)}>
          <CircleCheck size={21} aria-hidden="true" {...stylex.props(styles.icon)} />
          <p {...stylex.props(styles.message)}>
            This review has been removed from Branchline.
            {jiraLink ? ` Open ${jiraLink.key} in Jira to update its status.` : ''}
          </p>
        </div>
        {error && <IntegrationError noBottomMargin>{error}</IntegrationError>}
        <MergeProgressView
          operation={remote.operation}
          pullRequests={remote.pullRequests}
          repositories={remote.repositories}
        />
      </div>
      <DialogFooter className={stylex.props(styles.footer).className}>
        {jiraLink && (
          <Button type="button" disabled={opening} onClick={() => void openTicket()}>
            {opening ? <Spinner size={13} /> : <ExternalLink size={13} />}Open in Jira
          </Button>
        )}
        <Button variant="primary" type="button" onClick={onDismiss}>
          Done
        </Button>
      </DialogFooter>
    </IntegrationDialog>
  );
}

const styles = stylex.create({
  body: {
    paddingTop: '0',
    paddingRight: '27px',
    paddingBottom: spacing.xxl,
    paddingLeft: '27px',
    minHeight: 0,
    overflow: 'auto',
  },
  footer: { flexShrink: 0 },
  summary: { display: 'flex', alignItems: 'flex-start', gap: 11, marginTop: 17 },
  icon: { flexShrink: 0, marginTop: spacing.xxs, color: colors.successText },
  message: {
    margin: 0,
    fontSize: typeScale.compact,
    lineHeight: 1.8,
    color: colors.successText,
  },
});
