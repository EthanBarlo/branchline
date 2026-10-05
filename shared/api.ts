import type { UpdateAPI } from './updates';
import type { IntegrationAPI } from './integrations';
import type { GitWorkflowAPI } from './git-workflow';
import type {
  AppState,
  AppSettings,
  RepoInspection,
  NewProject,
  Project,
  NewReview,
  Review,
  ReviewRefresh,
  FileApproval,
  NewComment,
} from './types';

export interface ReviewAPI extends UpdateAPI, IntegrationAPI, GitWorkflowAPI {
  onBeforeClose(callback: (reason: 'close' | 'install') => Promise<void>): () => void;
  onCloseCancelled(callback: (message: string) => void): () => void;
  getState(): Promise<AppState>;
  updateSettings(changes: Partial<AppSettings>): Promise<AppSettings>;
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
  setApproval(
    reviewId: string,
    fileId: string,
    fingerprint: string,
    approved: boolean,
    contextKey?: string,
  ): Promise<Review>;
  setApprovals(
    reviewId: string,
    files: FileApproval[],
    approved: boolean,
    contextKey?: string,
  ): Promise<Review>;
  addComment(reviewId: string, input: NewComment, contextKey?: string): Promise<Review>;
  updateComment(
    reviewId: string,
    commentId: string,
    changes: { body?: string; resolved?: boolean },
    contextKey?: string,
  ): Promise<Review>;
  deleteComment(reviewId: string, commentId: string, contextKey?: string): Promise<Review>;
  copyFeedback(reviewId: string, contextKey?: string): Promise<string>;
}
