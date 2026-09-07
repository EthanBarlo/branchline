import { extractJiraTicketKey, jiraTicketUrl } from '../shared/jira';
import { inspectRepo } from './git';
import { ReviewStore } from './store';

/** The renderer supplies a review ID; only the main process constructs a URL. */
export class JiraService {
  constructor(
    private readonly store: ReviewStore,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly inspect = inspectRepo,
  ) {}

  async openJiraTicket(reviewId: string): Promise<void> {
    const review = this.store.getReview(reviewId);
    const branch = review.kind === 'current' ? (await this.inspect(review.repoPath)).currentBranch : review.featureBranch;
    if (!branch) throw new Error('The current checkout is detached. Switch to a branch containing a Jira ticket key.');
    const key = extractJiraTicketKey(branch);
    if (!key) throw new Error('The reviewed branch does not contain a Jira ticket key.');
    const url = jiraTicketUrl(this.store.getSettings().jiraBaseUrl, key);
    await this.openExternal(url);
  }
}
