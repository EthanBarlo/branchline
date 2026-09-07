import type { UpdateAPI } from './updates';

export type DiffSide = 'additions' | 'deletions';
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'T';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBaseBranch: string | null;
  createdAt: string;
}

export interface ReviewConfig {
  id: string;
  projectId?: string;
  kind?: 'current' | 'saved';
  name: string;
  repoPath: string;
  baseBranch: string;
  featureBranch: string;
  includeWorkingTree: boolean;
  createdAt: string;
}

export interface ReviewFile {
  id: string;
  repoRelativePath: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  oldContent: string | null;
  newContent: string | null;
  binary: boolean;
  tooLarge?: boolean;
  fingerprint: string;
  oldMode?: string;
  newMode?: string;
  baseCommit: string;
  headCommit: string;
  source: 'working-tree' | 'committed';
}

export interface RepoStatus {
  relativePath: string;
  currentBranch: string | null;
  baseCommit?: string;
  headCommit?: string;
  workingTreeIncluded: boolean;
  error?: string;
}

export interface ReviewSnapshot {
  reviewId: string;
  files: ReviewFile[];
  repos: RepoStatus[];
  warnings: string[];
  refreshedAt: string;
  fingerprint: string;
}

export interface ReviewComment {
  id: string;
  fileId: string;
  repoRelativePath: string;
  path: string;
  side: DiffSide;
  /** One-based on the selected side; 0/0 denotes a file-level comment. */
  lineStart: number;
  lineEnd: number;
  body: string;
  fingerprint: string;
  context: string;
  contextBefore?: string;
  contextAfter?: string;
  createdAt: string;
  resolved: boolean;
}

export interface Review extends ReviewConfig {
  projectId: string;
  kind: 'current' | 'saved';
  comments: ReviewComment[];
  approvals: Record<string, string>;
  /** Inactive branch/target feedback for the permanent Current review. */
  currentContexts?: Record<string, { comments: ReviewComment[]; approvals: Record<string, string> }>;
}

export const currentReviewId = (projectId: string): string => `current:${projectId}`;
export const reviewContextKey = (review: Pick<Review, 'featureBranch' | 'baseBranch'>): string => JSON.stringify([review.featureBranch, review.baseBranch]);

export interface ReviewRefresh {
  review: Review;
  snapshot: ReviewSnapshot;
  inspection?: RepoInspection;
  requiresTarget?: boolean;
}

export interface AppSettings { jiraBaseUrl: string }
export interface AppState { projects: Project[]; reviews: Review[]; settings: AppSettings }
export interface RepoInspection {
  rootPath: string;
  name: string;
  branches: string[];
  currentBranch: string | null;
}
export interface NewReview {
  projectId?: string;
  repoPath?: string;
  name?: string;
  baseBranch?: string;
  featureBranch?: string;
  includeWorkingTree?: boolean;
}
export interface NewProject { repoPath: string; name?: string }
export type NewComment = Omit<ReviewComment, 'id' | 'createdAt' | 'resolved'> & {
  /** A stable client UUID makes retries of the initial autosave idempotent. */
  id?: string;
};

export interface FileApproval { fileId: string; fingerprint: string }

export interface ReviewAPI extends UpdateAPI {
  onBeforeClose(callback: (reason: 'close' | 'install') => Promise<void>): () => void;
  getState(): Promise<AppState>;
  updateSettings(changes: { jiraBaseUrl: string }): Promise<AppSettings>;
  openJiraTicket(reviewId: string): Promise<void>;
  chooseRepo(): Promise<string | null>;
  inspectRepo(path: string): Promise<RepoInspection>;
  createProject(input: NewProject): Promise<Project>;
  updateProject(id: string, changes: { name?: string; defaultBaseBranch?: string }): Promise<Project>;
  deleteProject(id: string): Promise<AppState>;
  createReview(input: NewReview): Promise<Review>;
  deleteReview(id: string): Promise<AppState>;
  refreshReview(id: string): Promise<ReviewRefresh>;
  setCurrentTarget(projectId: string, target: string): Promise<ReviewRefresh>;
  setApproval(reviewId: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string): Promise<Review>;
  setApprovals(reviewId: string, files: FileApproval[], approved: boolean, contextKey?: string): Promise<Review>;
  addComment(reviewId: string, input: NewComment, contextKey?: string): Promise<Review>;
  updateComment(reviewId: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string): Promise<Review>;
  deleteComment(reviewId: string, commentId: string, contextKey?: string): Promise<Review>;
  copyFeedback(reviewId: string, contextKey?: string): Promise<string>;
}

declare global {
  interface Window { reviewAPI: ReviewAPI }
}
