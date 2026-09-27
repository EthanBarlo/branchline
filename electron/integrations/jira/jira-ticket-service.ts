import type { Review } from '../../../shared/types';
import { extractJiraTicketKey, jiraTicketUrl } from '../../../shared/jira';
import type { ConnectionManager } from '../connection-manager';
import type { IntegrationStore } from '../integration-store';
import type { ReviewStore } from '../../reviews/review-store';
import { inspectRepo } from '../../git/repository';
import { validateIntegrationLink } from '../integration-links';
import type { JiraBrowserTarget } from './jira-browser-policy';

type TrackOperation = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

export class JiraTicketService {
  private ticketChanges = new Map<string, Promise<unknown>>();
  private legacyTicketBranches = new Map<string, string>();

  constructor(
    private readonly reviews: ReviewStore,
    private readonly state: IntegrationStore,
    private readonly connections: ConnectionManager,
    private readonly trackLocalRefresh: TrackOperation,
    private readonly inspect = inspectRepo,
  ) {
    for (const review of reviews.getState().reviews) {
      if (
        review.kind === 'current' &&
        state.ticket(review.id) !== undefined &&
        state.ticketBranch(review.id) === undefined
      )
        this.legacyTicketBranches.set(review.id, review.featureBranch);
    }
  }

  private serialTicket<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.trackLocalRefresh(id, () => {
      const operation = (this.ticketChanges.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
      this.ticketChanges.set(id, operation);
      const cleanup = () => {
        if (this.ticketChanges.get(id) === operation) this.ticketChanges.delete(id);
      };
      void operation.then(cleanup, cleanup);
      return operation;
    });
  }
  async getJiraTicketSuggestions(id: string, query: string) {
    const review = this.reviews.getReview(id);
    const connectionId = this.state.project(review.projectId).jiraConnectionId;
    if (!connectionId) throw new Error('Choose a Jira connection in Project integrations to search tickets.');
    const result = await this.connections.getIssueSuggestions(connectionId, query);
    if (this.state.project(review.projectId).jiraConnectionId !== connectionId)
      throw new Error('The Jira connection changed. Search again.');
    return result;
  }
  private currentTicket(id: string) {
    return this.serialTicket(id, async () => {
      const review = this.reviews.getReview(id);
      const branch = (await this.inspect(review.repoPath)).currentBranch ?? '';
      let key = this.state.ticket(id);
      if (key !== undefined) {
        // Older selections belong to the last checkout saved with Current.
        const selectedBranch =
          this.state.ticketBranch(id) ?? this.legacyTicketBranches.get(id) ?? review.featureBranch;
        if (selectedBranch !== branch) {
          await this.state.setTicket(id, '');
          key = undefined;
        } else if (this.state.ticketBranch(id) === undefined) await this.state.setTicket(id, key, branch);
        this.legacyTicketBranches.delete(id);
      }
      return { key, branch };
    });
  }
  async reconcileCurrentTicket(id: string): Promise<void> {
    if (this.reviews.getReview(id).kind === 'current' && this.state.ticket(id) !== undefined)
      await this.currentTicket(id);
  }
  private async jiraTicketKey(review: Review): Promise<string | null> {
    const { key, branch } =
      review.kind === 'current'
        ? await this.currentTicket(review.id)
        : { key: this.state.ticket(review.id), branch: review.featureBranch };
    return key === undefined ? extractJiraTicketKey(branch) : key;
  }
  async setReviewTicket(id: string, key: string | null, expectedBranch?: string | null) {
    const review = this.reviews.getReview(id);
    if (
      key !== null &&
      (typeof key !== 'string' || (key.trim() && !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(key.trim())))
    )
      throw new Error('Enter a Jira issue key such as APP-123.');
    if (
      expectedBranch !== undefined &&
      expectedBranch !== null &&
      (typeof expectedBranch !== 'string' || expectedBranch.length > 1024 || expectedBranch.includes('\0'))
    )
      throw new Error('The Jira ticket branch context is invalid.');
    const value = key === null ? null : key.trim().toUpperCase();
    if (review.kind !== 'current') {
      if (expectedBranch !== undefined)
        throw new Error('A Jira ticket branch context is only valid for the Current review.');
      await this.state.setTicket(id, value);
      return;
    }
    await this.serialTicket(id, async () => {
      const current = this.reviews.getReview(id);
      const branch = (await this.inspect(current.repoPath)).currentBranch ?? '';
      if (expectedBranch !== undefined && (expectedBranch ?? '') !== branch)
        throw new Error('The checked-out branch changed. Reopen Jira before changing its ticket.');
      await this.state.setTicket(id, value, branch);
      this.legacyTicketBranches.delete(id);
    });
  }
  /** Browser navigation uses saved site metadata, so it remains available during a merge or after token expiry. */
  async getJiraTicketLink(id: string): Promise<{ key: string; url: string } | null> {
    const review = this.reviews.getReview(id);
    const project = this.state.project(review.projectId);
    const connection = project.jiraConnectionId
      ? this.connections
          .list()
          .find((value) => value.id === project.jiraConnectionId && value.kind === 'jira')
      : undefined;
    if (project.jiraConnectionId && !connection?.siteUrl)
      throw new Error(
        'The project’s Jira account is unavailable. Choose its Jira connection in Project integrations.',
      );
    const baseUrl = connection?.siteUrl || this.reviews.getSettings().jiraBaseUrl;
    if (!baseUrl) return null;
    const key = await this.jiraTicketKey(review);
    return key ? { key: key.toUpperCase(), url: jiraTicketUrl(baseUrl, key) } : null;
  }
  async getJiraBrowserTarget(id: string): Promise<JiraBrowserTarget> {
    const review = this.reviews.getReview(id);
    const connectionId = this.state.project(review.projectId).jiraConnectionId;
    const connection = this.connections
      .list()
      .find((value) => value.id === connectionId && value.kind === 'jira');
    if (!connection?.siteUrl)
      throw new Error('Choose a Jira connection in Project integrations before opening Jira in Branchline.');
    const siteUrl = validateIntegrationLink(connection.siteUrl);
    const link = await this.getJiraTicketLink(id);
    if (!link) throw new Error('Enter a Jira ticket key to open it in Branchline.');
    if (
      this.state.project(review.projectId).jiraConnectionId !== connectionId ||
      new URL(link.url).origin !== new URL(siteUrl).origin
    ) {
      throw new Error('The project’s Jira connection changed. Open the ticket again.');
    }
    return {
      connectionId: connection.id,
      siteUrl,
      url: validateIntegrationLink(link.url),
      key: link.key,
      accountLabel: `${connection.displayName || connection.label} (${connection.email})`,
    };
  }
  getJiraIssue(id: string, override?: string) {
    return this.trackLocalRefresh(id, async () => {
      const review = this.reviews.getReview(id);
      const settings = this.state.project(review.projectId);
      if (!settings.jiraConnectionId) throw new Error('Choose a Jira connection in project integrations.');
      const detected = await this.jiraTicketKey(review);
      const key = override || detected;
      if (!key || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/i.test(key))
        throw new Error('Enter a Jira ticket key to show its details.');
      return this.connections.getIssue(settings.jiraConnectionId, key.toUpperCase());
    });
  }
  forgetReview(id: string): void {
    this.legacyTicketBranches.delete(id);
  }
}
