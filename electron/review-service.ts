import { buildSnapshot, inspectRepo } from './git';
import { validBranch } from './project-service';
import { formatFeedback, ReviewStore, validateApprovalFiles } from './store';
import { currentReviewId, reviewContextKey } from '../shared/types';
import type { FileApproval, NewComment, RepoInspection, Review, ReviewRefresh, ReviewSnapshot } from '../shared/types';

/** Serializes refreshes and feedback so a checkout cannot move feedback between branches. */
export class ReviewService {
  private pending = new Map<string, Promise<unknown>>();
  private snapshots = new Map<string, ReviewSnapshot>();
  private deleting = new Set<string>();

  constructor(
    private store: ReviewStore,
    private inspect = inspectRepo,
    private snapshot = buildSnapshot,
  ) {}

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.deleting.has(id)) return Promise.reject(new Error('This review is being removed.'));
    const task = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.pending.set(id, task);
    const cleanup = () => { if (this.pending.get(id) === task) this.pending.delete(id); };
    void task.then(cleanup, cleanup);
    return task;
  }

  private empty(review: Review, inspection: RepoInspection, warnings: string[] = []): ReviewRefresh {
    const snapshot: ReviewSnapshot = {
      reviewId: review.id, files: [], repos: [], warnings,
      refreshedAt: new Date().toISOString(), fingerprint: `pending:${reviewContextKey(review)}`,
    };
    this.snapshots.set(review.id, snapshot);
    return { review, snapshot, inspection, requiresTarget: !review.baseBranch };
  }

  private async refreshNow(id: string): Promise<ReviewRefresh> {
    let review = this.store.getReview(id);
    if (review.kind !== 'current') {
      const snapshot = await this.snapshot(review);
      review = await this.store.reconcileApprovals(id, snapshot);
      this.snapshots.set(id, snapshot);
      return { review, snapshot };
    }

    // Git also checks revisions during its reads. Reinspect the branch here to
    // ensure Current's persisted feedback context matches the completed diff.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inspection = await this.inspect(review.repoPath);
      review = await this.store.switchCurrentContext(review.projectId, inspection.currentBranch);
      if (!review.baseBranch || !inspection.currentBranch) {
        return this.empty(review, inspection, inspection.currentBranch ? [] : ['HEAD is detached. Check out a branch to review Current.']);
      }
      const snapshot = await this.snapshot(review);
      const after = await this.inspect(review.repoPath);
      if (after.currentBranch !== inspection.currentBranch) continue;
      review = await this.store.reconcileApprovals(id, snapshot, reviewContextKey(review));
      this.snapshots.set(id, snapshot);
      return { review, snapshot, inspection: after, requiresTarget: false };
    }
    const inspection = await this.inspect(review.repoPath);
    review = await this.store.switchCurrentContext(review.projectId, inspection.currentBranch);
    return this.empty(review, inspection, ['The checked-out branch is changing. Current will retry on the next refresh.']);
  }

  refreshReview(id: string): Promise<ReviewRefresh> {
    return this.enqueue(id, () => this.refreshNow(id));
  }

  setCurrentTarget(projectId: string, target: string): Promise<ReviewRefresh> {
    const id = currentReviewId(projectId);
    return this.enqueue(id, async () => {
      const project = this.store.getProject(projectId);
      const inspection = await this.inspect(project.repoPath);
      const branch = validBranch(inspection, target, 'Target branch');
      await this.store.switchCurrentContext(projectId, inspection.currentBranch, branch);
      return this.refreshNow(id);
    });
  }

  private checkContext(review: Review, expected?: string): void {
    if ((review.kind === 'current' || expected !== undefined) && expected !== reviewContextKey(review)) {
      throw new Error('The current branch or target changed. Refresh before saving feedback for this comparison.');
    }
    if (review.kind === 'current' && (!review.featureBranch || !review.baseBranch)) {
      throw new Error('Choose a target and check out a branch before reviewing Current.');
    }
  }

  private async prepareMutation(id: string, expected?: string): Promise<Review> {
    let review = this.store.getReview(id);
    // Detect branch switches even if the renderer's next poll has not run yet.
    if (review.kind === 'current') review = (await this.refreshNow(id)).review;
    this.checkContext(review, expected);
    return review;
  }

  setApproval(id: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string): Promise<Review> {
    return this.setApprovals(id, [{ fileId, fingerprint }], approved, contextKey);
  }

  setApprovals(id: string, files: FileApproval[], approved: boolean, contextKey?: string): Promise<Review> {
    return this.enqueue(id, async () => {
      const selected = validateApprovalFiles(files, approved);
      let review: Review;
      if (approved) {
        // Build one fresh comparison for the whole selection, including saved
        // reviews, and validate all files before changing any approval.
        const refreshed = await this.refreshNow(id);
        review = refreshed.review;
        this.checkContext(review, contextKey);
        const versions = new Map(refreshed.snapshot.files.map(file => [file.id, file.fingerprint]));
        if (selected.some(file => versions.get(file.fileId) !== file.fingerprint)) {
          throw new Error('A selected file changed or left this comparison. Refresh and review its latest changes first.');
        }
      } else review = await this.prepareMutation(id, contextKey);
      return this.store.setApprovals(id, selected, approved, contextKey ?? reviewContextKey(review));
    });
  }

  addComment(id: string, input: NewComment, contextKey?: string): Promise<Review> {
    return this.enqueue(id, async () => {
      await this.prepareMutation(id, contextKey);
      const file = this.snapshots.get(id)?.files.find(file => file.id === input.fileId);
      // A draft may retain an older file version within the same comparison.
      if (!file && !input.fingerprint) throw new Error('Select a file to comment on.');
      return this.store.addComment(id, input, contextKey);
    });
  }

  updateComment(id: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string): Promise<Review> {
    return this.enqueue(id, async () => {
      await this.prepareMutation(id, contextKey);
      return this.store.updateComment(id, commentId, changes, contextKey);
    });
  }

  deleteComment(id: string, commentId: string, contextKey?: string): Promise<Review> {
    return this.enqueue(id, async () => {
      await this.prepareMutation(id, contextKey);
      return this.store.deleteComment(id, commentId, contextKey);
    });
  }

  copyFeedback(id: string, contextKey?: string): Promise<string> {
    return this.enqueue(id, async () => {
      const { review } = await this.refreshNow(id);
      this.checkContext(review, contextKey);
      return formatFeedback(review);
    });
  }

  async deleteReview(id: string) {
    this.deleting.add(id);
    try {
      await this.pending.get(id)?.catch(() => undefined);
      const state = await this.store.deleteReview(id);
      this.snapshots.delete(id);
      return state;
    } finally { this.deleting.delete(id); }
  }

  async deleteProject(projectId: string) {
    const ids = this.store.getState().reviews.filter(review => review.projectId === projectId).map(review => review.id);
    ids.forEach(id => this.deleting.add(id));
    try {
      await Promise.all(ids.map(id => this.pending.get(id)?.catch(() => undefined)));
      const state = await this.store.deleteProject(projectId);
      ids.forEach(id => this.snapshots.delete(id));
      return state;
    } finally { ids.forEach(id => this.deleting.delete(id)); }
  }
}
