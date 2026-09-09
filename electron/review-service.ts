import { buildSnapshot, inspectRepo } from './git';
import { validBranch } from './project-service';
import { formatFeedback, ReviewStore, validateApprovalFiles } from './store';
import { currentReviewId, reviewContextKey } from '../shared/types';
import type { FileApproval, NewComment, RepoInspection, Review, ReviewRefresh, ReviewSnapshot } from '../shared/types';

/** Serializes feedback and snapshot commits; expensive local comparisons run outside that queue. */
export class ReviewService {
  private pending = new Map<string, Promise<unknown>>();
  private snapshots = new Map<string, ReviewSnapshot>();
  private deleting = new Set<string>();
  private generations = new Map<string, number>();
  private refreshing = new Map<string, { generation: number; promise: Promise<ReviewRefresh> }>();
  private scans = new Map<string, Set<Promise<ReviewRefresh>>>();
  private scanSequences = new Map<string, number>();
  private completed = new Map<string, { generation: number; sequence: number; result: ReviewRefresh }>();

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
    const result = { review, snapshot, inspection, requiresTarget: !review.baseBranch };
    this.completed.set(review.id, { generation: this.generations.get(review.id) ?? 0, sequence: this.scanSequences.get(review.id) ?? 0, result });
    return result;
  }

  private invalidateSnapshot(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.snapshots.delete(id);
    this.completed.delete(id);
  }

  /** Called only in the mutation queue, including the lightweight checkout guard. */
  private async currentContext(review: Review, inspection: RepoInspection, target?: string): Promise<Review> {
    const next = await this.store.switchCurrentContext(review.projectId, inspection.currentBranch, target);
    if (reviewContextKey(next) !== reviewContextKey(review)) this.invalidateSnapshot(review.id);
    return next;
  }

  private async refreshRemote(id: string): Promise<ReviewRefresh> {
    const previous = this.store.getReview(id);
    const snapshot = await this.snapshot(previous);
    const review = await this.store.reconcileApprovals(id, snapshot);
    this.snapshots.set(id, snapshot);
    return { review, snapshot };
  }

  private async refreshLocal(id: string, active: { generation: number; promise: Promise<ReviewRefresh> }): Promise<ReviewRefresh> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = await this.enqueue(id, async () => {
        let review = this.store.getReview(id);
        let inspection: RepoInspection | undefined;
        if (review.kind === 'current') {
          inspection = await this.inspect(review.repoPath);
          review = await this.currentContext(review, inspection);
          if (!review.baseBranch || !inspection.currentBranch) {
            return { result: this.empty(review, inspection, inspection.currentBranch ? [] : ['HEAD is detached. Check out a branch to review Current.']) };
          }
        }
        const generation = this.generations.get(id) ?? 0;
        // Retries can overlap a newly requested context. Only the newest scan
        // may publish, even if both scans eventually use the same comparison.
        const sequence = (this.scanSequences.get(id) ?? 0) + 1;
        this.scanSequences.set(id, sequence);
        active.generation = generation;
        this.refreshing.set(id, active);
        return { review, generation, sequence };
      });
      if (prepared.result) return prepared.result;
      const { review: captured, generation, sequence } = prepared;
      // This may read many repositories and files. Comments and file markers can
      // continue saving against the displayed snapshot while the reads run.
      let snapshot: ReviewSnapshot;
      try { snapshot = await this.snapshot(captured); }
      catch (error) {
        // A superseded comparison is obsolete even when its old Git reads
        // failed. Otherwise retain the last good cache.
        if (!this.deleting.has(id) && (generation !== (this.generations.get(id) ?? 0) || sequence !== this.scanSequences.get(id))) {
          const replacement = this.replacementRefresh(id, active);
          if (replacement) return replacement;
          continue;
        }
        throw error;
      }
      const result = await this.enqueue(id, async () => {
        let review = this.store.getReview(id);
        if (generation !== (this.generations.get(id) ?? 0) || sequence !== this.scanSequences.get(id)
          || reviewContextKey(review) !== reviewContextKey(captured)) return null;
        let inspection: RepoInspection | undefined;
        if (review.kind === 'current') {
          inspection = await this.inspect(review.repoPath);
          review = await this.currentContext(review, inspection);
          if (reviewContextKey(review) !== reviewContextKey(captured)) return null;
        }
        // Reconcile the latest persisted review, preserving feedback written
        // during the scan and clearing only markers for changed file versions.
        review = await this.store.reconcileApprovals(id, snapshot, reviewContextKey(captured));
        this.snapshots.set(id, snapshot);
        const result = { review, snapshot, ...(inspection ? { inspection, requiresTarget: false } : {}) };
        this.completed.set(id, { generation, sequence, result });
        return result;
      });
      if (result) return result;
      const replacement = this.replacementRefresh(id, active);
      if (replacement) return replacement;
    }
    return this.enqueue(id, async () => {
      let review = this.store.getReview(id);
      const inspection = await this.inspect(review.repoPath);
      review = await this.currentContext(review, inspection);
      return this.empty(review, inspection, ['The checked-out branch or target is changing. Current will retry on the next refresh.']);
    });
  }

  private replacementRefresh(id: string, previous: { generation: number; promise: Promise<ReviewRefresh> }): Promise<ReviewRefresh> | ReviewRefresh | undefined {
    const generation = this.generations.get(id) ?? 0;
    const newer = this.refreshing.get(id);
    if (newer && newer !== previous && newer.generation === generation) return newer.promise;
    const completed = this.completed.get(id);
    if (completed?.generation === generation && completed.sequence === (this.scanSequences.get(id) ?? 0)) {
      return { ...completed.result, review: this.store.getReview(id) };
    }
  }

  async refreshReview(id: string): Promise<ReviewRefresh> {
    if (this.deleting.has(id)) return Promise.reject(new Error('This review is being removed.'));
    if (this.store.getReview(id).remote) return this.enqueue(id, () => this.refreshRemote(id));
    const generation = this.generations.get(id) ?? 0;
    const existing = this.refreshing.get(id);
    if (existing?.generation === generation) return existing.promise;
    const active = { generation, promise: undefined as unknown as Promise<ReviewRefresh> };
    active.promise = this.refreshLocal(id, active);
    this.refreshing.set(id, active);
    const scans = this.scans.get(id) ?? new Set<Promise<ReviewRefresh>>();
    scans.add(active.promise);
    this.scans.set(id, scans);
    const cleanup = () => {
      scans.delete(active.promise);
      if (!scans.size) this.scans.delete(id);
      if (this.refreshing.get(id) === active) this.refreshing.delete(id);
    };
    void active.promise.then(cleanup, cleanup);
    return active.promise;
  }

  async setCurrentTarget(projectId: string, target: string): Promise<ReviewRefresh> {
    const id = currentReviewId(projectId);
    await this.enqueue(id, async () => {
      const review = this.store.getReview(id);
      const inspection = await this.inspect(review.repoPath);
      const branch = validBranch(inspection, target, 'Target branch');
      await this.currentContext(review, inspection, branch);
    });
    return this.refreshReview(id);
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
    if (review.kind === 'current') review = await this.currentContext(review, await this.inspect(review.repoPath));
    this.checkContext(review, expected);
    return review;
  }

  setApproval(id: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string): Promise<Review> {
    return this.setApprovals(id, [{ fileId, fingerprint }], approved, contextKey);
  }

  setApprovals(id: string, files: FileApproval[], approved: boolean, contextKey?: string): Promise<Review> {
    return this.enqueue(id, async () => {
      const selected = validateApprovalFiles(files, approved);
      const review = await this.prepareMutation(id, contextKey);
      // A marker describes the version already displayed. Background/open/manual
      // refreshes reconcile it if the agent or remote author changes that file.
      const snapshot = this.snapshots.get(id);
      if (approved && !snapshot) throw new Error(`Open or refresh this ${review.remote ? 'PR ' : ''}review before marking files reviewed.`);
      if (approved && snapshot) {
        const versions = new Map(snapshot.files.map(file => [file.id, file]));
        if (selected.some(file => versions.get(file.fileId)?.unavailable)) throw new Error('This file could not be loaded. Refresh it before marking it reviewed.');
        if (selected.some(file => versions.get(file.fileId)?.fingerprint !== file.fingerprint)) {
          throw new Error('A selected file changed or left this comparison. Refresh and review its latest changes first.');
        }
      }
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
      const review = await this.prepareMutation(id, contextKey);
      return formatFeedback(review);
    });
  }

  async deleteReview(id: string) {
    this.deleting.add(id);
    this.invalidateSnapshot(id);
    try {
      await Promise.allSettled([...(this.scans.get(id) ?? []), this.pending.get(id)]);
      const state = await this.store.deleteReview(id);
      this.snapshots.delete(id);
      this.completed.delete(id);
      this.generations.delete(id);
      this.scanSequences.delete(id);
      return state;
    } finally { this.deleting.delete(id); }
  }

  async deleteProject(projectId: string) {
    const ids = this.store.getState().reviews.filter(review => review.projectId === projectId).map(review => review.id);
    ids.forEach(id => { this.deleting.add(id); this.invalidateSnapshot(id); });
    try {
      await Promise.allSettled(ids.flatMap(id => [...(this.scans.get(id) ?? []), this.pending.get(id)]));
      const state = await this.store.deleteProject(projectId);
      ids.forEach(id => {
        this.snapshots.delete(id);
        this.completed.delete(id);
        this.generations.delete(id);
        this.scanSequences.delete(id);
      });
      return state;
    } finally { ids.forEach(id => this.deleting.delete(id)); }
  }
}
