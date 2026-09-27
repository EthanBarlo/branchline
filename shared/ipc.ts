import type { ReviewAPI } from './api';

type AsyncReviewMethod = {
  [Method in keyof ReviewAPI]: ReturnType<ReviewAPI[Method]> extends Promise<unknown> ? Method : never;
}[keyof ReviewAPI];

/** Existing channel names remain stable for packaged preload and desktop clients. */
export const reviewRequestMethods = {
  'integrations-state': 'getIntegrations',
  'integration-diagnostics': 'getIntegrationDiagnostics',
  'integration-log-open': 'openIntegrationLog',
  'connection-copy-scopes': 'copyConnectionScopes',
  'connection-save': 'saveConnection',
  'connection-test': 'testConnection',
  'connection-disconnect': 'disconnectConnection',
  'integrations-project': 'configureProjectIntegration',
  'integrations-discover': 'discoverRepositories',
  'pullrequests-list': 'listPullRequests',
  'pullrequests-open': 'openPullRequestReview',
  'pullrequests-state': 'getRemoteReview',
  'jira-issue': 'getJiraIssue',
  'jira-ticket-suggestions': 'getJiraTicketSuggestions',
  'jira-ticket-link': 'getJiraTicketLink',
  'jira-browser-open': 'openJiraBrowser',
  'jira-browser-resize': 'resizeJiraBrowser',
  'jira-browser-focus': 'focusJiraBrowser',
  'jira-browser-close': 'closeJiraBrowser',
  'jira-ticket': 'setReviewTicket',
  'feedback-preview': 'previewFeedback',
  'feedback-publish': 'publishFeedback',
  'feedback-reanchor': 'reanchorComment',
  'feedback-conflict': 'resolveCommentConflict',
  'feedback-unknown': 'resolveUnknownPublication',
  'merge-preview': 'previewMerge',
  'pullrequests-action': 'runPullRequestAction',
  'pullrequests-complete': 'completeMergedReview',
  'closed-review-check': 'checkClosedReview',
  'closed-reviews-remove': 'removeClosedReviews',
  'integration-open': 'openIntegrationLink',
  'update-state': 'getUpdateState',
  'update-check': 'checkForUpdates',
  'update-download': 'downloadUpdate',
  'update-install': 'installUpdate',
  state: 'getState',
  'settings-update': 'updateSettings',
  'jira-open': 'openJiraTicket',
  'choose-repo': 'chooseRepo',
  inspect: 'inspectRepo',
  'project-create': 'createProject',
  'project-update': 'updateProject',
  'project-delete': 'deleteProject',
  create: 'createReview',
  delete: 'deleteReview',
  refresh: 'refreshReview',
  'current-target': 'setCurrentTarget',
  approve: 'setApproval',
  'approve-many': 'setApprovals',
  'comment-add': 'addComment',
  'comment-update': 'updateComment',
  'comment-delete': 'deleteComment',
  copy: 'copyFeedback',
} as const satisfies Record<string, AsyncReviewMethod>;

type AssertNever<Value extends never> = Value;
export type MissingReviewRequests = AssertNever<
  Exclude<AsyncReviewMethod, (typeof reviewRequestMethods)[keyof typeof reviewRequestMethods]>
>;

type ReviewRequests = {
  [Name in keyof typeof reviewRequestMethods]: ReviewAPI[(typeof reviewRequestMethods)[Name]];
} & {
  'close-listener': (ready: boolean) => Promise<void>;
  'close-ready': (id: number, saved: boolean) => Promise<void>;
};

export type ReviewRequestName = keyof ReviewRequests;
export type ReviewRequestArguments<Name extends ReviewRequestName> = Parameters<ReviewRequests[Name]>;
export type ReviewRequestResult<Name extends ReviewRequestName> = Awaited<ReturnType<ReviewRequests[Name]>>;
export type ReviewRequestHandler<Name extends ReviewRequestName> = (
  ...args: ReviewRequestArguments<Name>
) => ReviewRequestResult<Name> | Promise<ReviewRequestResult<Name>>;

export const reviewEvents = {
  beforeClose: 'review:before-close',
  closeCancelled: 'review:close-cancelled',
  updateStateChanged: 'review:update-state-changed',
  updateShow: 'review:update-show',
  remoteReviewChanged: 'review:remote-review-changed',
  remoteReviewLoad: 'review:remote-review-load',
  jiraBrowserClosed: 'review:jira-browser-closed',
  jiraBrowserClearTicket: 'review:jira-browser-clear-ticket',
} as const;
