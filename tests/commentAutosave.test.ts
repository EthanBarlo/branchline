import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { CommentAutosave, flushPendingComments, hasPendingComments, loadCommentBackups, type CommentAnchor, type CommentBackup } from '../src/components/commentAutosave';
import type { ReviewComment } from '../shared/types';

class MemoryStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}
const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
beforeEach(() => storage.clear());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const id = '147f6095-a9df-4f65-8133-c2f22206c4e5';
const anchor: CommentAnchor = { side: 'additions', lineStart: 2, lineEnd: 3, context: 'selected code', fingerprint: 'file-version', path: 'src/file.ts' };
const original: ReviewComment = {
  id, fileId: 'src/file.ts', repoRelativePath: '.', path: 'src/file.ts', side: 'additions', lineStart: 2, lineEnd: 3,
  context: 'selected code', fingerprint: 'file-version', body: 'Original body', resolved: false, createdAt: '2026-09-07T00:00:00.000Z',
};

function fixture(existing = false, backup?: CommentBackup) {
  const server = { comment: existing ? { ...original } : null as ReviewComment | null };
  const events: string[] = [];
  const callbacks = {
    add: async (_anchor: CommentAnchor, body: string, commentId: string) => {
      events.push(`add:${body}`);
      // Matches the backend's idempotent create: retries preserve newer edits.
      server.comment ??= { ...original, id: commentId, body };
    },
    update: async (_id: string, changes: { body?: string; resolved?: boolean }) => {
      events.push(`update:${JSON.stringify(changes)}`);
      if (!server.comment) throw new Error('Comment missing');
      Object.assign(server.comment, changes);
    },
    delete: async () => { events.push('delete'); server.comment = null; },
    removed: () => { events.push('removed'); },
  };
  const session = new CommentAutosave({
    id, scope: 'review:["feature","main"]', fileId: original.fileId, anchor,
    ...(existing ? { comment: { ...original } } : {}), ...(backup ? { backup } : {}), callbacks,
  });
  return { session, callbacks, server, events };
}

test('autosave follows rapid typing during the initial create through to the latest body', async () => {
  const f = fixture();
  const started = deferred();
  const finish = deferred();
  const add = f.callbacks.add;
  f.callbacks.add = async (...args) => { started.resolve(); await finish.promise; await add(...args); };
  f.session.change('First text');
  const saving = f.session.flush();
  await started.promise;
  f.session.change('Latest text while saving');
  finish.resolve();
  await saving;
  await f.session.flush();
  assert.equal(f.server.comment?.body, 'Latest text while saving');
  assert.equal(f.session.getSnapshot().body, 'Latest text while saving');
  assert.equal(f.session.hasPending(), false);
  assert.equal(storage.length, 0);
});

test('typing during automatic deletion persists the new text even when its debounce fires during delete', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(true);
  const started = deferred();
  const finish = deferred();
  const remove = f.callbacks.delete;
  f.callbacks.delete = async () => { started.resolve(); await finish.promise; await remove(); };
  f.session.change('');
  const saving = f.session.flush();
  await started.promise;
  f.session.change('New text typed while delete is pending');
  t.mock.timers.tick(300);
  finish.resolve();
  await saving;
  assert.equal(f.server.comment?.body, 'New text typed while delete is pending');
  assert.equal(f.session.getSnapshot().persisted, true);
  assert.equal(f.session.hasPending(), false);
});

test('retrying an ambiguous initial create applies the latest body after idempotent create acknowledgement', async () => {
  const f = fixture();
  const add = f.callbacks.add;
  let attempts = 0;
  f.callbacks.add = async (...args) => {
    await add(...args);
    if (attempts++ === 0) throw new Error('Response lost after persistence');
  };
  f.session.change('Initially persisted text');
  await assert.rejects(f.session.flush(), /Response lost/);
  assert.equal(f.server.comment?.body, 'Initially persisted text');
  f.session.change('New text before retry');
  await f.session.flush();
  assert.equal(f.server.comment?.body, 'New text before retry');
  assert.equal(f.session.hasPending(), false);
  assert.equal(f.session.getSnapshot().error, '');
  assert.equal(storage.length, 0);
});

test('clearing after an ambiguous create deletes the possibly persisted comment', async () => {
  const f = fixture();
  const add = f.callbacks.add;
  f.callbacks.add = async (...args) => { await add(...args); throw new Error('Response lost after persistence'); };
  f.session.change('Possibly persisted text');
  await assert.rejects(f.session.flush(), /Response lost/);
  f.session.change('');
  await f.session.closeEditor();
  assert.equal(f.server.comment, null);
  assert.equal(f.session.getSnapshot().removed, true);
  assert.equal(storage.length, 0);
});

test('recovered unacknowledged creates can be cleared or retried without keeping stale server text', async () => {
  const backup: CommentBackup = {
    id, scope: 'review:["feature","main"]', fileId: original.fileId, anchor,
    body: 'Recovered latest text', savedBody: '', persisted: false, resolved: false,
  };
  const retry = fixture(false, backup);
  retry.server.comment = { ...original, body: 'Earlier ambiguous create' };
  await retry.session.flush();
  assert.equal(retry.server.comment?.body, 'Recovered latest text');
  const clear = fixture(false, { ...backup, body: '' });
  clear.server.comment = { ...original, body: 'Earlier ambiguous create' };
  await clear.session.closeEditor();
  assert.equal(clear.server.comment, null);
  assert.equal(clear.session.getSnapshot().removed, true);
});

test('resolve waits for an in-flight body save and flush waits for both operations', async () => {
  const f = fixture(true);
  const started = deferred();
  const finish = deferred();
  const update = f.callbacks.update;
  f.callbacks.update = async (...args) => {
    if (args[1].body) { started.resolve(); await finish.promise; }
    await update(...args);
  };
  f.session.change('Edited text before resolving');
  const saving = f.session.flush();
  await started.promise;
  const resolving = f.session.resolve();
  const flushing = f.session.flush();
  assert.equal(f.session.getSnapshot().busy, true);
  assert.equal(f.server.comment?.resolved, false);
  finish.resolve();
  await Promise.all([saving, resolving, flushing]);
  assert.equal(f.server.comment?.body, 'Edited text before resolving');
  assert.equal(f.server.comment?.resolved, true);
  assert.equal(f.session.getSnapshot().editing, false);
  assert.equal(f.session.hasPending(), false);
});

test('explicit deletion waits for an initial create and removes its result', async () => {
  const f = fixture();
  const started = deferred();
  const finish = deferred();
  const add = f.callbacks.add;
  f.callbacks.add = async (...args) => { started.resolve(); await finish.promise; await add(...args); };
  f.session.change('Text submitted before delete');
  const saving = f.session.flush();
  await started.promise;
  const deleting = f.session.delete();
  f.session.change('Should be ignored during explicit deletion');
  finish.resolve();
  await Promise.all([saving, deleting]);
  assert.equal(f.server.comment, null);
  assert.equal(f.session.getSnapshot().removed, true);
  assert.equal(f.events.at(-1), 'removed');
  assert.equal(storage.length, 0);
});

test('flush-all waits for pending mounted sessions and reports failures with recoverable text', async t => {
  const f = fixture();
  const unmount = f.session.mount();
  t.after(unmount);
  f.callbacks.add = async () => { throw new Error('Disk is unavailable'); };
  f.session.change('Keep this unsaved feedback');
  assert.equal(hasPendingComments(), true);
  await assert.rejects(flushPendingComments(), /Disk is unavailable/);
  assert.equal(f.session.getSnapshot().body, 'Keep this unsaved feedback');
  assert.equal(f.session.hasPending(), true);
  const backups = loadCommentBackups('review:["feature","main"]', original.fileId);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].body, 'Keep this unsaved feedback');
  f.callbacks.add = async (_anchor, body) => { f.server.comment = { ...original, body }; };
  await flushPendingComments();
  assert.equal(f.server.comment?.body, 'Keep this unsaved feedback');
  assert.equal(hasPendingComments(), false);
  assert.equal(storage.length, 0);
});
