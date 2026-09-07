import type { DiffSide, ReviewComment } from '../../shared/types';

export interface CommentAnchor {
  side: DiffSide;
  lineStart: number;
  lineEnd: number;
  context: string;
  contextBefore?: string;
  contextAfter?: string;
  fingerprint?: string;
  path?: string;
}

export interface CommentBackup {
  id: string;
  scope: string;
  fileId: string;
  anchor: CommentAnchor;
  body: string;
  persisted: boolean;
  savedBody: string;
  resolved: boolean;
}

interface CommentCallbacks {
  add: (anchor: CommentAnchor, body: string, id: string) => Promise<void>;
  update: (id: string, changes: { body?: string; resolved?: boolean }) => Promise<void>;
  delete: (id: string) => Promise<void>;
  removed: (id: string) => void;
}

export interface CommentState {
  body: string;
  persisted: boolean;
  resolved: boolean;
  editing: boolean;
  saving: boolean;
  busy: boolean;
  error: string;
  removed: boolean;
  editVersion: number;
}

const active = new Set<CommentAutosave>();
const PREFIX = 'branchline.commentDraft:';
const storagePrefix = (scope: string, fileId: string) => `${PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(fileId)}:`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function hasPendingComments(): boolean {
  return [...active].some(session => session.hasPending());
}

export async function flushPendingComments(): Promise<void> {
  const results = await Promise.allSettled([...active].map(session => session.flush()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export function loadCommentBackups(scope: string, fileId: string): CommentBackup[] {
  const prefix = storagePrefix(scope, fileId);
  const result: CommentBackup[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const entry = JSON.parse(localStorage.getItem(key) || 'null') as CommentBackup | null;
      if (entry && entry.scope === scope && entry.fileId === fileId && typeof entry.id === 'string' && typeof entry.body === 'string' && entry.anchor && typeof entry.anchor.lineStart === 'number' && typeof entry.anchor.lineEnd === 'number' && (entry.anchor.side === 'additions' || entry.anchor.side === 'deletions')) result.push(entry);
    }
  } catch { /* A corrupt backup must not prevent the review from opening. */ }
  return result;
}

export class CommentAutosave {
  readonly id: string;
  readonly anchor: CommentAnchor;
  readonly scope: string;
  readonly fileId: string;
  private state: CommentState;
  private savedBody: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private action: Promise<void> | null = null;
  private deleting = false;
  private createAttempted = false;
  private listeners = new Set<() => void>();
  private mounts = 0;
  private readonly callbacks: CommentCallbacks;

  constructor(input: { scope: string; fileId: string; id: string; anchor: CommentAnchor; comment?: ReviewComment; backup?: CommentBackup; callbacks: CommentCallbacks }) {
    this.id = input.id;
    this.scope = input.scope;
    this.fileId = input.fileId;
    this.anchor = { ...input.anchor };
    this.callbacks = input.callbacks;
    this.savedBody = input.comment?.body || input.backup?.savedBody || '';
    this.state = {
      body: input.backup?.body ?? input.comment?.body ?? '',
      persisted: Boolean(input.comment || input.backup?.persisted),
      resolved: input.comment?.resolved ?? input.backup?.resolved ?? false,
      editing: Boolean(input.backup || !input.comment), saving: false, busy: false,
      error: input.backup ? 'Recovered unsaved text. Your original line reference is preserved.' : '',
      removed: false, editVersion: 0,
    };
    // A recovered unacknowledged create may already exist on disk.
    this.createAttempted = Boolean(input.comment || input.backup);
  }

  getSnapshot = (): CommentState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  mount(): () => void {
    this.mounts++;
    active.add(this);
    return () => {
      this.mounts--;
      if (this.mounts > 0) return;
      active.delete(this);
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.hasPending()) void this.flush().catch(() => {});
    };
  }

  hasPending(): boolean { return !this.state.removed && (this.dirty() || Boolean(this.running || this.action || this.timer)); }
  hasUnsavedText(): boolean { return this.dirty(); }
  private dirty(): boolean { return this.state.body.trim() !== this.savedBody || (!this.state.persisted && (Boolean(this.state.body.trim()) || this.createAttempted)); }
  private patch(changes: Partial<CommentState>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }
  private backup() {
    try {
      const key = `${storagePrefix(this.scope, this.fileId)}${this.id}`;
      if (this.state.removed || (!this.dirty() && !this.running)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ id: this.id, scope: this.scope, fileId: this.fileId, anchor: this.anchor, body: this.state.body, persisted: this.state.persisted, savedBody: this.savedBody, resolved: this.state.resolved } satisfies CommentBackup));
    } catch { /* The persistence error itself remains visible if the save fails. */ }
  }

  edit() {
    if (this.state.removed || this.state.busy) return;
    this.patch({ editing: true, editVersion: this.state.editVersion + 1 });
  }

  change(body: string) {
    if (this.state.removed || this.deleting) return;
    this.patch({ body, error: '' });
    this.backup();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 300);
  }

  sync(comment: ReviewComment) {
    if (this.state.removed || this.deleting) return;
    const idle = !this.running && !this.action && !this.dirty() && !this.state.editing;
    if (idle) this.savedBody = comment.body;
    this.patch({ persisted: true, resolved: this.action ? this.state.resolved : comment.resolved, ...(idle ? { body: comment.body } : {}) });
  }

  flush(): Promise<void> { return this.action || this.flushBody(); }

  private flushBody(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    if (this.state.removed || this.deleting || !this.dirty()) return Promise.resolve();
    this.patch({ saving: true, error: '' });
    this.running = this.persistLoop().catch(error => {
      this.patch({ error: `${message(error)} Your text is kept locally; edit it to retry.` });
      throw error;
    }).finally(() => {
      this.running = null;
      this.patch({ saving: false });
      this.backup();
    });
    return this.running;
  }

  private async persistLoop() {
    while (!this.deleting && !this.state.removed) {
      const body = this.state.body.trim();
      if (!body) {
        if (this.state.persisted || this.createAttempted) await this.callbacks.delete(this.id);
        this.createAttempted = false;
        this.savedBody = '';
        this.patch({ persisted: false });
        if (this.state.body.trim()) continue;
        break;
      }
      if (!this.state.persisted) {
        const retrying = this.createAttempted;
        this.createAttempted = true;
        await this.callbacks.add(this.anchor, body, this.id);
        this.patch({ persisted: true });
        // An idempotent create retry can return an earlier body; explicitly
        // apply this attempt's body before considering it acknowledged.
        if (retrying) await this.callbacks.update(this.id, { body });
        this.savedBody = body;
      } else if (body !== this.savedBody) {
        await this.callbacks.update(this.id, { body });
        this.savedBody = body;
      } else break;
      this.backup();
    }
  }

  async closeEditor(): Promise<void> {
    const version = this.state.body;
    await this.flush();
    if (this.state.body !== version) return;
    if (!this.state.body.trim() && !this.state.persisted) this.discard();
    else this.patch({ editing: false });
  }

  delete(): Promise<void> {
    if (this.action) return this.action;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deleting = true;
    this.patch({ busy: true, error: '' });
    this.action = (async () => {
      try {
        if (this.running) await this.running.catch(() => {});
        if (this.state.persisted || this.createAttempted) await this.callbacks.delete(this.id);
        this.discard();
      } catch (error) {
        this.deleting = false;
        this.patch({ error: `${message(error)} Your text is kept locally.` });
        this.backup();
        throw error;
      } finally { this.action = null; this.patch({ busy: false }); }
    })();
    return this.action;
  }

  resolve(): Promise<void> {
    if (this.action) return this.action;
    this.patch({ busy: true, error: '' });
    this.action = (async () => {
      try {
        await this.flushBody();
        if (!this.state.persisted) { this.discard(); return; }
        const resolved = !this.state.resolved;
        await this.callbacks.update(this.id, { resolved });
        this.patch({ resolved, editing: false });
      } catch (error) {
        this.patch({ error: `${message(error)} Your text is kept locally.` });
        this.backup();
        throw error;
      } finally { this.action = null; this.patch({ busy: false }); }
    })();
    return this.action;
  }

  externallyRemoved() {
    if (!this.hasPending()) this.discard();
  }

  private discard() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.savedBody = '';
    this.patch({ removed: true, persisted: false, body: '', editing: false });
    this.backup();
    active.delete(this);
    this.callbacks.removed(this.id);
  }
}
