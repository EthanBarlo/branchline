import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { AppState, FileApproval, NewComment, NewProject, NewReview, Project, Review, ReviewSnapshot } from '../shared/types';
import { currentReviewId, reviewContextKey } from '../shared/types';

function nonempty(value: unknown, label: string, max = 20000, trim = true): string {
  if (typeof value !== 'string' || !(trim ? value.trim() : value) || value.length > max || value.includes('\0')) {
    throw new Error(`${label} is required and must be valid text.`);
  }
  return trim ? value.trim() : value;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const savedText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const savedDate = (value: unknown): value is string => savedText(value) && Number.isFinite(Date.parse(value));
const savedBranch = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && !value.includes('\0');

export function validateApprovalFiles(files: unknown, approved: unknown): FileApproval[] {
  if (typeof approved !== 'boolean') throw new Error('Choose whether to mark the selected files reviewed.');
  if (!Array.isArray(files) || files.length === 0) throw new Error('Select at least one file to update.');
  const versions = new Map<string, string>();
  for (const file of files) {
    if (!record(file)) throw new Error('Each selected file must have a valid path and version.');
    const fileId = nonempty(file.fileId, 'File', 20000, false);
    const fingerprint = nonempty(file.fingerprint, 'File version');
    if (versions.has(fileId) && versions.get(fileId) !== fingerprint) throw new Error('A selected file has conflicting versions. Refresh and try again.');
    versions.set(fileId, fingerprint);
  }
  return [...versions].map(([fileId, fingerprint]) => ({ fileId, fingerprint }));
}

function validFeedback(value: unknown): boolean {
  return record(value)
    && Array.isArray(value.comments) && value.comments.every(comment => record(comment)
      && ['id', 'fileId', 'repoRelativePath', 'path', 'body', 'fingerprint'].every(key => savedText(comment[key]))
      && (comment.side === 'additions' || comment.side === 'deletions')
      && typeof comment.lineStart === 'number' && Number.isInteger(comment.lineStart) && comment.lineStart >= 0
      && typeof comment.lineEnd === 'number' && Number.isInteger(comment.lineEnd) && comment.lineEnd >= comment.lineStart
      && (comment.lineStart !== 0 || comment.lineEnd === 0)
      && ['contextBefore', 'contextAfter'].every(key => comment[key] === undefined || (typeof comment[key] === 'string' && comment[key].length <= 20000))
      && typeof comment.context === 'string' && typeof comment.resolved === 'boolean' && savedDate(comment.createdAt))
    && record(value.approvals) && Object.values(value.approvals).every(savedText);
}

function validContextKey(key: string): boolean {
  try {
    const fields = JSON.parse(key);
    return Array.isArray(fields) && fields.length === 2 && fields.every(savedBranch) && JSON.stringify(fields) === key;
  } catch { return false; }
}

function validReview(value: unknown): value is Review {
  if (!record(value) || !['id', 'name', 'repoPath'].every(key => savedText(value[key]))
    || !savedDate(value.createdAt) || typeof value.includeWorkingTree !== 'boolean' || !validFeedback(value)) return false;
  if (value.kind !== undefined && value.kind !== 'current' && value.kind !== 'saved') return false;
  if (value.kind !== 'current') return savedText(value.baseBranch) && savedText(value.featureBranch) && value.currentContexts === undefined;
  if (!savedText(value.projectId) || value.id !== currentReviewId(value.projectId)
    || value.name !== 'Current' || value.includeWorkingTree !== true
    || !savedBranch(value.baseBranch) || !savedBranch(value.featureBranch)) return false;
  if (value.currentContexts === undefined) return true;
  const activeKey = reviewContextKey({ baseBranch: value.baseBranch, featureBranch: value.featureBranch });
  return record(value.currentContexts) && Object.entries(value.currentContexts).every(([key, feedback]) =>
    key !== activeKey && validContextKey(key) && validFeedback(feedback));
}

function newCurrentReview(project: Project): Review {
  return {
    id: currentReviewId(project.id), projectId: project.id, kind: 'current', name: 'Current',
    repoPath: project.repoPath, baseBranch: '', featureBranch: '', includeWorkingTree: true,
    createdAt: project.createdAt, comments: [], approvals: {}, currentContexts: {},
  };
}

function validProject(value: unknown): value is Project {
  return record(value) && ['id', 'name', 'repoPath'].every(key => savedText(value[key]))
    && (value.defaultBaseBranch === null || savedText(value.defaultBaseBranch)) && savedDate(value.createdAt);
}

function migrateState(parsed: unknown): { state: AppState; migrated: boolean } {
  const invalid = () => new Error('The saved review file has an invalid format. It has been left untouched.');
  if (!record(parsed) || !Array.isArray(parsed.reviews) || !parsed.reviews.every(validReview)) throw invalid();
  let reviews = parsed.reviews;
  if (new Set(reviews.map(review => review.id)).size !== reviews.length) throw invalid();
  let projects: Project[];
  let migrated = false;
  if (Object.hasOwn(parsed, 'projects')) {
    if (!Array.isArray(parsed.projects) || !parsed.projects.every(validProject)) throw invalid();
    projects = parsed.projects;
    if (new Set(projects.map(project => project.id)).size !== projects.length
      || new Set(projects.map(project => project.repoPath)).size !== projects.length) throw invalid();
    const byId = new Map(projects.map(project => [project.id, project]));
    if (reviews.some(review => !savedText(review.projectId) || byId.get(review.projectId)?.repoPath !== review.repoPath)) throw invalid();
  } else {
    // A missing project array denotes the original review-only format. Avoid
    // treating a damaged newer file with dangling project IDs as legacy data.
    if (reviews.some(review => review.projectId !== undefined || review.kind !== undefined)) throw invalid();
    const byPath = new Map<string, Project>();
    const latest = new Map<string, number>();
    for (const review of reviews) {
      let project = byPath.get(review.repoPath);
      if (!project) {
        project = {
          id: randomUUID(), name: basename(review.repoPath) || review.repoPath,
          repoPath: review.repoPath, defaultBaseBranch: review.baseBranch, createdAt: review.createdAt,
        };
        byPath.set(review.repoPath, project);
      }
      const created = Date.parse(review.createdAt);
      if (created > (latest.get(review.repoPath) ?? -Infinity)) {
        project.defaultBaseBranch = review.baseBranch;
        latest.set(review.repoPath, created);
      }
      if (created < Date.parse(project.createdAt)) project.createdAt = review.createdAt;
    }
    projects = [...byPath.values()];
    reviews = reviews.map(review => ({ ...review, projectId: byPath.get(review.repoPath)!.id }));
    migrated = true;
  }
  const hasKinds = reviews.some(review => review.kind !== undefined);
  if (hasKinds) {
    if (reviews.some(review => review.kind === undefined)) throw invalid();
    for (const project of projects) {
      if (reviews.filter(review => review.projectId === project.id && review.kind === 'current').length !== 1) throw invalid();
    }
  } else {
    const currentIds = new Set(projects.map(project => currentReviewId(project.id)));
    if (reviews.some(review => currentIds.has(review.id))) throw invalid();
    reviews = [...reviews.map(review => ({ ...review, kind: 'saved' as const })), ...projects.map(newCurrentReview)];
    migrated ||= projects.length > 0;
  }
  return { state: { ...parsed, projects, reviews }, migrated };
}

export class ReviewStore {
  private state: AppState = { projects: [], reviews: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private loadError: Error | null = null;
  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const { state, migrated } = migrateState(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.loadError = null;
      if (migrated) await this.mutate(() => { this.state = state; });
      else this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
      this.loadError = null;
    }
  }

  getState(): AppState { return structuredClone(this.state); }
  getProject(id: string): Project {
    const project = this.state.projects.find(item => item.id === id);
    if (!project) throw new Error('This project no longer exists.');
    return structuredClone(project);
  }
  getReview(id: string): Review {
    const review = this.state.reviews.find(item => item.id === id);
    if (!review) throw new Error('This review no longer exists.');
    return structuredClone(review);
  }

  private mutate<T>(action: () => T, hasChanges: () => boolean = () => true): Promise<T> {
    const next = this.pending.then(async () => {
      if (this.loadError) throw new Error('Saved reviews could not be loaded. Fix the saved file and reopen Branchline before making changes.');
      const previous = structuredClone(this.state);
      try {
        const result = action();
        if (!hasChanges()) return structuredClone(result);
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        await rename(temporary, this.filePath);
        return structuredClone(result);
      } catch (error) { this.state = previous; throw error; }
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private ensureProject(input: NewProject & { defaultBaseBranch?: string | null }): Project {
    const repoPath = nonempty(input.repoPath, 'Repository path', 8192, false);
    const name = input.name === undefined ? basename(repoPath) || repoPath : nonempty(input.name, 'Project name', 200);
    const defaultBaseBranch = input.defaultBaseBranch == null ? null : nonempty(input.defaultBaseBranch, 'Target branch', 1024);
    const existing = this.state.projects.find(project => project.repoPath === repoPath);
    if (existing) return existing;
    const project: Project = { id: randomUUID(), name, repoPath, defaultBaseBranch, createdAt: new Date().toISOString() };
    this.state.projects.push(project);
    this.state.reviews.push(newCurrentReview(project));
    return project;
  }

  createProject(input: NewProject & { defaultBaseBranch?: string | null }): Promise<Project> {
    let changed = false;
    return this.mutate(() => {
      const count = this.state.projects.length;
      const project = this.ensureProject(input);
      changed = this.state.projects.length !== count;
      return project;
    }, () => changed);
  }

  updateProject(id: string, changes: { name?: string; defaultBaseBranch?: string | null }): Promise<Project> {
    return this.mutate(() => {
      const project = this.state.projects.find(item => item.id === id);
      if (!project) throw new Error('This project no longer exists.');
      if (changes.name !== undefined) project.name = nonempty(changes.name, 'Project name', 200);
      if (changes.defaultBaseBranch !== undefined) project.defaultBaseBranch = changes.defaultBaseBranch === null ? null : nonempty(changes.defaultBaseBranch, 'Target branch', 1024);
      return project;
    });
  }

  deleteProject(id: string): Promise<AppState> {
    return this.mutate(() => {
      if (!this.state.projects.some(project => project.id === id)) throw new Error('This project no longer exists.');
      this.state.projects = this.state.projects.filter(project => project.id !== id);
      this.state.reviews = this.state.reviews.filter(review => review.projectId !== id);
      return this.state;
    });
  }

  createReview(input: NewReview): Promise<Review> {
    return this.mutate(() => {
      const project = input.projectId === undefined
        ? this.ensureProject({ repoPath: nonempty(input.repoPath, 'Repository path', 8192, false) })
        : this.state.projects.find(item => item.id === input.projectId);
      if (!project) throw new Error('This project no longer exists.');
      if (input.repoPath !== undefined && input.repoPath !== project.repoPath) throw new Error('The review repository does not match its project.');
      const featureBranch = nonempty(input.featureBranch, 'Feature branch', 1024);
      const baseBranch = nonempty(input.baseBranch ?? project.defaultBaseBranch, 'Target branch', 1024);
      if (input.includeWorkingTree !== undefined && typeof input.includeWorkingTree !== 'boolean') throw new Error('Working changes must be enabled or disabled.');
      const review: Review = {
        id: randomUUID(), projectId: project.id, kind: 'saved', name: input.name === undefined ? featureBranch : nonempty(input.name, 'Review name', 200),
        repoPath: project.repoPath, baseBranch, featureBranch,
        includeWorkingTree: input.includeWorkingTree ?? true,
        createdAt: new Date().toISOString(), comments: [], approvals: {},
      };
      project.defaultBaseBranch = baseBranch;
      this.state.reviews.unshift(review);
      return review;
    });
  }

  deleteReview(id: string): Promise<AppState> {
    return this.mutate(() => {
      if (this.state.reviews.some(review => review.id === id && review.kind === 'current')) throw new Error('Current is permanent. Remove the project to remove its Current review.');
      this.state.reviews = this.state.reviews.filter(review => review.id !== id);
      return this.state;
    });
  }

  switchCurrentContext(projectId: string, featureBranch: string | null, target?: string | null): Promise<Review> {
    let changed = false;
    return this.mutate(() => {
      const project = this.state.projects.find(item => item.id === projectId);
      const current = this.state.reviews.find(review => review.id === currentReviewId(projectId) && review.kind === 'current');
      if (!project || !current) throw new Error('This project no longer exists.');
      const nextFeature = featureBranch === null || featureBranch === '' ? '' : nonempty(featureBranch, 'Feature branch', 1024);
      const nextTarget = target === undefined ? current.baseBranch : target === null || target === '' ? '' : nonempty(target, 'Target branch', 1024);
      const oldKey = reviewContextKey(current);
      const nextKey = reviewContextKey({ featureBranch: nextFeature, baseBranch: nextTarget });
      if (oldKey !== nextKey) {
        const contexts = current.currentContexts ?? {};
        contexts[oldKey] = { comments: current.comments, approvals: current.approvals };
        const nextFeedback = contexts[nextKey] ?? { comments: [], approvals: {} };
        delete contexts[nextKey];
        current.currentContexts = contexts;
        current.comments = nextFeedback.comments;
        current.approvals = nextFeedback.approvals;
        current.featureBranch = nextFeature;
        current.baseBranch = nextTarget;
        changed = true;
      }
      if (target !== undefined && nextTarget && project.defaultBaseBranch !== nextTarget) {
        project.defaultBaseBranch = nextTarget;
        changed = true;
      }
      return current;
    }, () => changed);
  }

  private assertContext(review: Review, contextKey?: string): void {
    if (contextKey !== undefined && contextKey !== reviewContextKey(review)) throw new Error('This review context changed. Refresh before applying feedback.');
  }

  private changeReview(id: string, action: (review: Review) => void, contextKey?: string, hasChanges: () => boolean = () => true): Promise<Review> {
    return this.mutate(() => {
      const review = this.state.reviews.find(item => item.id === id);
      if (!review) throw new Error('This review no longer exists.');
      this.assertContext(review, contextKey);
      action(review);
      return review;
    }, hasChanges);
  }

  async reconcileApprovals(id: string, snapshot: ReviewSnapshot, contextKey?: string): Promise<Review> {
    const versions = new Map(snapshot.files.map(file => [file.id, file.fingerprint]));
    const repositories = [...snapshot.repos].sort((a, b) =>
      (b.relativePath === '.' ? 0 : b.relativePath.length) - (a.relativePath === '.' ? 0 : a.relativePath.length));
    const repositoryFailed = (fileId: string): boolean => Boolean(repositories.find(repository =>
      repository.relativePath === '.' || fileId === repository.relativePath || fileId.startsWith(`${repository.relativePath}/`))?.error);
    let changed = false;
    // The check belongs in the queue too: an approval may already be queued
    // behind another disk write when a newly refreshed snapshot arrives.
    return this.mutate(() => {
      const current = this.state.reviews.find(review => review.id === id);
      if (!current) throw new Error('This review no longer exists.');
      this.assertContext(current, contextKey);
      for (const [fileId, fingerprint] of Object.entries(current.approvals)) {
        // An unavailable repository has no authoritative file list. Preserve
        // its approvals until a successful read can compare actual versions.
        if (!repositoryFailed(fileId) && versions.get(fileId) !== fingerprint) {
          delete current.approvals[fileId];
          changed = true;
        }
      }
      return current;
    }, () => changed);
  }

  setApproval(id: string, fileId: string, fingerprint: string, approved: boolean, contextKey?: string): Promise<Review> {
    return this.setApprovals(id, [{ fileId, fingerprint }], approved, contextKey);
  }

  setApprovals(id: string, files: FileApproval[], approved: boolean, contextKey?: string): Promise<Review> {
    let changed = false;
    return this.changeReview(id, review => {
      const selected = validateApprovalFiles(files, approved);
      const approvals = { ...review.approvals };
      for (const { fileId, fingerprint } of selected) {
        if (approved && (!Object.hasOwn(approvals, fileId) || approvals[fileId] !== fingerprint)) {
          Object.defineProperty(approvals, fileId, { value: fingerprint, enumerable: true, writable: true, configurable: true });
          changed = true;
        } else if (!approved && Object.hasOwn(approvals, fileId)) {
          delete approvals[fileId];
          changed = true;
        }
      }
      if (changed) review.approvals = approvals;
    }, contextKey, () => changed);
  }

  addComment(id: string, input: NewComment, contextKey?: string): Promise<Review> {
    let changed = false;
    return this.changeReview(id, review => {
      if (!Number.isInteger(input.lineStart) || !Number.isInteger(input.lineEnd) || input.lineStart < 0 || input.lineEnd < input.lineStart || (input.lineStart === 0 && input.lineEnd !== 0)) {
        throw new Error('Select a valid line or line range.');
      }
      if (input.side !== 'additions' && input.side !== 'deletions') throw new Error('Invalid comment side.');
      if (['contextBefore', 'contextAfter'].some(key => input[key as 'contextBefore' | 'contextAfter'] !== undefined && typeof input[key as 'contextBefore' | 'contextAfter'] !== 'string')) {
        throw new Error('Surrounding comment context must be text.');
      }
      if (input.id !== undefined && (typeof input.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id))) {
        throw new Error('Comment ID must be a valid UUID.');
      }
      const commentId = input.id?.toLowerCase() ?? randomUUID();
      const anchor = {
        fileId: nonempty(input.fileId, 'File', 20000, false),
        repoRelativePath: nonempty(input.repoRelativePath || '.', 'Repository', 20000, false),
        path: nonempty(input.path, 'File path', 20000, false), side: input.side,
        lineStart: input.lineStart, lineEnd: input.lineEnd,
        fingerprint: nonempty(input.fingerprint, 'File version'),
        context: typeof input.context === 'string' ? input.context.slice(0, 20000) : '',
        ...(input.contextBefore !== undefined ? { contextBefore: input.contextBefore.slice(0, 20000) } : {}),
        ...(input.contextAfter !== undefined ? { contextAfter: input.contextAfter.slice(0, 20000) } : {}),
      };
      const existing = review.comments.find(comment => comment.id === commentId);
      if (existing) {
        if ([...Object.keys(anchor), 'contextBefore', 'contextAfter'].some(field => existing[field as keyof typeof anchor] !== anchor[field as keyof typeof anchor])) {
          throw new Error('This comment ID is already attached to different code.');
        }
        // Retrying a lost create response must not replace subsequent edits.
        return;
      }
      review.comments.push({
        id: commentId, ...anchor, body: nonempty(input.body, 'Comment', 50000),
        createdAt: new Date().toISOString(), resolved: false,
      });
      changed = true;
    }, contextKey, () => changed);
  }

  updateComment(id: string, commentId: string, changes: { body?: string; resolved?: boolean }, contextKey?: string): Promise<Review> {
    return this.changeReview(id, review => {
      const comment = review.comments.find(item => item.id === commentId);
      if (!comment) throw new Error('This comment no longer exists.');
      if (changes.body !== undefined) comment.body = nonempty(changes.body, 'Comment', 50000);
      if (typeof changes.resolved === 'boolean') comment.resolved = changes.resolved;
    }, contextKey);
  }

  deleteComment(id: string, commentId: string, contextKey?: string): Promise<Review> {
    return this.changeReview(id, review => { review.comments = review.comments.filter(item => item.id !== commentId); }, contextKey);
  }
}

export function formatFeedback(review: Review): string {
  const byFile = new Map<string, Review['comments']>();
  for (const comment of review.comments) {
    if (comment.resolved) continue;
    const path = comment.repoRelativePath === '.' ? comment.path : `${comment.repoRelativePath}/${comment.path}`;
    const comments = byFile.get(path) ?? [];
    comments.push(comment);
    byFile.set(path, comments);
  }
  return [...byFile].flatMap(([path, comments]) => comments
    .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd)
    .map(comment => {
      const reference = comment.lineStart === 0 ? path : `${path}:${comment.lineStart}${comment.lineEnd !== comment.lineStart ? `-${comment.lineEnd}` : ''}`;
      return `${reference}\n${comment.body}`;
    })).join('\n\n');
}
