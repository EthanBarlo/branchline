import type { DiffSide, Review, ReviewComment, ReviewSnapshot, ReviewRefresh } from './types';

export type ConnectionKind = 'jira' | 'bitbucket';
export interface ConnectionInfo { id: string; kind: ConnectionKind; label: string; email: string; accountId: string; displayName: string; siteUrl?: string; cloudId?: string; storage: 'secure' | 'session'; connected: boolean; }
export interface ConnectionInput { id?: string; kind: ConnectionKind; label?: string; email: string; token: string; siteUrl?: string; }
export interface RepositoryMapping { relativePath: string; workspace: string; repoSlug: string; uuid?: string; parentRelativePath?: string; submodulePath?: string; }
export interface ProjectIntegration { jiraConnectionId?: string; bitbucketConnectionId?: string; repositories: RepositoryMapping[]; updateSubmodulePointers: boolean; }
export interface IntegrationState { connections: ConnectionInfo[]; projects: Record<string, ProjectIntegration>; }
export interface IntegrationDiagnosticsInfo { path: string; available: boolean; }
export interface PullRequest {
  id: number; repository: RepositoryMapping; title: string; url: string;
  sourceBranch: string; targetBranch: string; sourceHash: string; targetHash: string;
  mergeBaseHash?: string;
  author: { id: string; name: string }; reviewers: { id: string; name: string }[];
  participants: { id: string; approved: boolean }[];
  state: string; draft: boolean; mergeStrategies: string[]; mergeCommit?: string;
  sourceRepositoryUuid?: string; destinationRepositoryUuid?: string;
  taskCount?: number;
  checks?: { name: string; state: string; url?: string }[];
  unsupportedReason?: string;
}
export interface PullRequestRef { repositoryPath: string; prId: number; }
/** Captured branch comparison, including repositories that do not yet have a PR. */
export interface BranchReviewRepository {
  repository: RepositoryMapping; sourceBranch: string; targetBranch: string;
  sourceHash?: string; targetHash?: string; mergeBaseHash?: string;
  status: 'pull-request' | 'changes' | 'no-changes' | 'missing-branch' | 'unavailable';
  prId?: number; error?: string;
  check?: { state: 'queued' | 'checking' | 'ready' | 'failed'; error?: string };
  creation?: { state: 'sending' | 'unknown' | 'failed'; sourceHash: string; targetHash: string; startedAt: string; marker: string; error?: string };
  cleanup?: { state: 'pending' | 'checking' | 'sending' | 'deleted' | 'retained' | 'unknown' | 'skipped'; expectedHead?: string; error?: string };
}
export const branchReviewKey = (repositoryPath: string): string => `${repositoryPath}#branch`;
export type PullRequestFilter = 'all' | 'reviewer' | 'author';
export interface JiraIssue { key: string; title: string; description: unknown; url: string; }
export interface RemoteAnchor { prKey: string; sourceHash: string; targetHash: string; path: string; side: DiffSide; lineStart: number; lineEnd: number; fingerprint: string; }
export interface PublishedValue { body: string; resolved: boolean; deleted: boolean; }
export interface CommentPublication {
  commentId: string; anchor: RemoteAnchor; remoteId?: number; authorId?: string; url?: string;
  acknowledged?: PublishedValue; intended?: PublishedValue; remote?: PublishedValue;
  state: 'draft' | 'sending' | 'synced' | 'failed' | 'unknown' | 'conflict';
  action?: 'create' | 'update' | 'delete' | 'resolve' | 'reopen';
  startedAt?: string; baselineIds?: number[]; error?: string;
  backup?: ReviewComment;
}
export interface MergeProgress {
  prKey: string; approval: 'pending' | 'approved' | 'failed';
  merge: 'pending' | 'sending' | 'merging' | 'merged' | 'failed' | 'unknown';
  sourceHash: string; targetHash: string; mergeCommit?: string; taskId?: string;
  cleanup?: 'deleted' | 'retained' | 'unknown'; error?: string;
  phase?: 'checking' | 'approving' | 'merging' | 'cleanup' | 'updating-pointers';
  skipped?: boolean;
  pointerCommit?: string; pointerBase?: string; pointerChildren?: Record<string, string>;
  pointerState?: 'prepared' | 'pushing' | 'review' | 'ready';
}
export interface MergeOperation { action: 'approve' | 'merge'; state: 'running' | 'paused' | 'complete'; items: MergeProgress[]; updatedAt: string; error?: string; }
export interface RemoteReviewState {
  connectionId: string; pullRequests: PullRequest[]; publications: Record<string, CommentPublication>;
  repositories?: BranchReviewRepository[];
  ticketKey?: string; operation?: MergeOperation;
}
export interface RemoteReviewChanged { reviewId: string; state: RemoteReviewState; }
export interface RemoteRepositoryLoad { repository: RepositoryMapping; phase: 'queued' | 'checking' | 'files' | 'ready' | 'failed'; error?: string; }
export interface RemoteReviewLoadProgress { reviewId: string; sequence: number; repositories: RemoteRepositoryLoad[]; result?: ReviewRefresh; complete: boolean; error?: string; }
export interface FeedbackItem { commentId: string; repositoryPath: string; prId: number; createsPullRequest?: boolean; path: string; side: DiffSide; lineStart: number; lineEnd: number; body: string; action: string; state: CommentPublication['state']; error?: string; remote?: PublishedValue; }
export interface FeedbackPreview { items: FeedbackItem[]; blockers: string[]; }
export interface MergePreview { pullRequests: PullRequest[]; repositories?: BranchReviewRepository[]; blockers: string[]; warnings: string[]; updateSubmodulePointers: boolean; operation?: MergeOperation; }
export interface ReanchorInput { fileId: string; fingerprint: string; side: DiffSide; lineStart: number; lineEnd: number; }
export interface RemoteComment { id: number; authorId: string; body: string; resolved: boolean; deleted: boolean; path?: string; from?: number; to?: number; startFrom?: number; startTo?: number; createdAt?: string; updatedAt?: string; url?: string; }
export interface InlinePayload { content: { raw: string }; inline: { path: string; from?: number; to?: number; start_from?: number; start_to?: number }; }
export interface RemoteSnapshotResult { snapshot: ReviewSnapshot; pullRequests: PullRequest[]; repositories?: BranchReviewRepository[]; }
export const pullRequestKey = (pr: Pick<PullRequest, 'repository' | 'id'>): string => `${pr.repository.relativePath}#${pr.id}`;
export interface IntegrationAPI {
  getIntegrations(): Promise<IntegrationState>;
  getIntegrationDiagnostics(): Promise<IntegrationDiagnosticsInfo>;
  openIntegrationLog(): Promise<void>;
  copyConnectionScopes(kind: ConnectionKind): Promise<void>;
  saveConnection(input: ConnectionInput): Promise<ConnectionInfo>;
  testConnection(id: string): Promise<ConnectionInfo>;
  disconnectConnection(id: string): Promise<IntegrationState>;
  configureProjectIntegration(projectId: string, input: ProjectIntegration): Promise<ProjectIntegration>;
  discoverRepositories(projectId: string): Promise<RepositoryMapping[]>;
  listPullRequests(projectId: string, filter: PullRequestFilter): Promise<PullRequest[]>;
  openPullRequestReview(projectId: string, refs: PullRequestRef[]): Promise<Review>;
  getRemoteReview(reviewId: string): Promise<RemoteReviewState | null>;
  onRemoteReviewChanged(callback: (event: RemoteReviewChanged) => void): () => void;
  onRemoteReviewLoadProgress(callback: (event: RemoteReviewLoadProgress) => void): () => void;
  getJiraIssue(reviewId: string, key?: string): Promise<JiraIssue>;
  getJiraTicketLink(reviewId: string): Promise<{ key: string; url: string } | null>;
  setReviewTicket(reviewId: string, key: string): Promise<void>;
  previewFeedback(reviewId: string): Promise<FeedbackPreview>;
  publishFeedback(reviewId: string): Promise<RemoteReviewState>;
  reanchorComment(reviewId: string, commentId: string, input: ReanchorInput): Promise<Review>;
  resolveCommentConflict(reviewId: string, commentId: string, choice: 'local' | 'remote'): Promise<Review>;
  resolveUnknownPublication(reviewId: string, commentId: string, remoteId: number | null): Promise<RemoteReviewState>;
  previewMerge(reviewId: string, action?: 'approve' | 'merge'): Promise<MergePreview>;
  runPullRequestAction(reviewId: string, action: 'approve' | 'merge'): Promise<RemoteReviewState>;
  openIntegrationLink(url: string): Promise<void>;
}
