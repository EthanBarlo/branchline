import * as stylex from '@stylexjs/stylex';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import type { PullRequest } from '../../../shared/integrations';
import { pullRequestKey } from '../../../shared/integrations';
import { colors, spacing, typeScale } from '../../tokens.stylex';
import { IntegrationLink } from './IntegrationPrimitives';

export function FeedbackPullRequests({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (!pullRequests.length) return null;
  return (
    <section {...stylex.props(styles.feedbackPRs)} aria-label="Pull requests in Bitbucket">
      <div {...stylex.props(styles.sectionHeading)}>
        <div>
          <h3 {...stylex.props(styles.sectionTitle)}>Continue in Bitbucket</h3>
          <p {...stylex.props(styles.sectionDescription)}>
            View published comments and request changes on the pull request.
          </p>
        </div>
      </div>
      <ul {...stylex.props(styles.feedbackPRList)}>
        {pullRequests.map((pr, index) => (
          <li
            key={pullRequestKey(pr)}
            {...stylex.props(styles.feedbackPRRow, index > 0 && styles.feedbackPRFollowingRow)}
          >
            <GitPullRequest size={15} aria-hidden="true" {...stylex.props(styles.feedbackPRIcon)} />
            <div>
              <strong {...stylex.props(styles.feedbackPRName)}>
                {pr.repository.repoSlug} <span {...stylex.props(styles.feedbackPRId)}>#{pr.id}</span>
              </strong>
              <code {...stylex.props(styles.feedbackPRCode)}>
                {pr.repository.workspace}/{pr.repository.repoSlug}
              </code>
            </div>
            <div {...stylex.props(styles.feedbackPRAction)}>
              <IntegrationLink url={pr.url} variant="feedback">
                Open PR
                <ExternalLink size={12} aria-hidden="true" {...stylex.props(styles.linkIcon)} />
                <span className="sr-only">
                  : {pr.repository.repoSlug} #{pr.id}
                </span>
              </IntegrationLink>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const styles = stylex.create({
  feedbackPRs: {
    marginTop: '18px',
    marginRight: '0',
    marginBottom: '22px',
    marginLeft: '0',
  },
  sectionHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  sectionTitle: { margin: '0', fontSize: typeScale.body, fontWeight: 550 },
  sectionDescription: {
    marginTop: '5px',
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    color: colors.textQuiet,
    fontSize: typeScale.small,
    lineHeight: 1.7,
  },
  feedbackPRList: {
    listStyle: 'none',
    marginTop: spacing.lg,
    marginRight: '0',
    marginBottom: '0',
    marginLeft: '0',
    padding: '0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '5px',
    overflow: 'hidden',
  },
  feedbackPRRow: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    gap: spacing.lg,
    alignItems: 'center',
    padding: spacing.lg,
    backgroundColor: colors.surface,
  },
  feedbackPRFollowingRow: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
  },
  feedbackPRIcon: { color: colors.textMuted },
  feedbackPRName: {
    display: 'block',
    fontSize: typeScale.compact,
    fontWeight: 550,
    overflowWrap: 'anywhere',
  },
  feedbackPRId: { color: colors.textQuiet, fontWeight: 400 },
  feedbackPRCode: {
    display: 'block',
    marginTop: spacing.xs,
    fontSize: typeScale.caption,
    color: colors.textQuiet,
    overflowWrap: 'anywhere',
  },
  feedbackPRAction: { maxWidth: '180px' },
  linkIcon: { flexShrink: '0' },
});
