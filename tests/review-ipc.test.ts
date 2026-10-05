import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewHandlerRegistrar, type ReviewIpcEvent } from '../electron/ipc/register-review-handlers';
import { InstallGate } from '../electron/application/install-gate';

function fixture() {
  const trustedURL = 'file:///Applications/Branchline.app/Contents/Resources/app/dist/index.html';
  const frame = { url: trustedURL };
  let contents: { mainFrame: unknown } | null = { mainFrame: frame };
  const handlers = new Map<string, (event: ReviewIpcEvent, ...args: unknown[]) => unknown>();
  const closeGate = new InstallGate('close'), installGate = new InstallGate();
  const handle = createReviewHandlerRegistrar({
    register: (name, handler) => { handlers.set(name, handler); },
    getContents: () => contents,
    trustedURL, closeGate, installGate,
  });
  const event: ReviewIpcEvent = { sender: contents, senderFrame: frame };
  const invoke = (name: string, ...args: unknown[]) => handlers.get(`review:${name}`)!(event, ...args);
  return { handle, handlers, closeGate, installGate, event, frame, invoke, replaceWindow: () => { contents = { mainFrame: { url: trustedURL } }; } };
}

test('registered handlers reject foreign frames and replaced windows before touching services', async () => {
  const f = fixture(); let calls = 0;
  f.handle('copy', id => { calls++; return id; });
  const handler = f.handlers.get('review:copy')!;
  assert.throws(() => handler({ ...f.event, senderFrame: { ...f.frame } }, 'review'), /did not come from/);
  assert.throws(() => handler({ ...f.event, sender: {} }, 'review'), /did not come from/);
  f.frame.url += '#different';
  assert.throws(() => f.invoke('copy', 'review'), /did not come from/);
  f.frame.url = f.frame.url.replace('#different', '');
  assert.equal(await f.invoke('copy', 'review'), 'review');
  f.replaceWindow();
  assert.throws(() => f.invoke('copy', 'review'), /did not come from/);
  assert.equal(calls, 1);
});

test('mutations use both shutdown gates while lifecycle controls remain available', async () => {
  const f = fixture(); let acknowledgements = 0;
  f.handle('settings-update', () => ({} as never));
  f.handle('close-ready', () => { acknowledgements++; });
  await f.closeGate.prepare(async () => {});
  await assert.rejects(Promise.resolve().then(() => f.invoke('settings-update', {})), /preparing to close/);
  f.invoke('close-ready', 1, true);
  f.closeGate.reset();
  await f.installGate.prepare(async () => {});
  await assert.rejects(Promise.resolve().then(() => f.invoke('settings-update', {})), /preparing to update/);
  f.invoke('close-ready', 2, true);
  assert.equal(acknowledgements, 2);
});

test('accepted IPC operations stay tracked until their complete asynchronous work finishes', async () => {
  const f = fixture();
  let finish!: (value: string) => void;
  f.handle('comment-update', () => new Promise<never>(resolve => { finish = body => resolve({ body } as never); }));
  const pending = f.invoke('comment-update', 'review', 'comment', { body: 'feedback' });
  await new Promise<void>(resolve => setImmediate(resolve));
  let prepared = false;
  const preparation = f.closeGate.prepare(async () => {}).then(() => { prepared = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(prepared, false);
  finish('feedback');
  assert.deepEqual(await pending, { body: 'feedback' });
  await preparation;
  assert.equal(prepared, true);
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('normal close ignores unfinished history, fetches, scans, previews and remote reads', async () => {
  const names = ['git-history', 'git-project-history', 'git-status', 'git-fetch', 'git-preview',
    'refresh', 'inspect', 'connection-test', 'integrations-discover', 'pullrequests-list', 'jira-issue',
    'jira-ticket-suggestions', 'feedback-preview', 'merge-preview', 'closed-review-check'] as const;
  for (const name of names) {
    const f = fixture();
    let finish!: () => void;
    f.handle(name, () => new Promise<never>(resolve => { finish = () => resolve(undefined as never); }));
    const pending = f.invoke(name);
    await tick();
    await f.closeGate.prepare(async () => {});
    // Installation still waits for the same work before replacing application files.
    let installed = false;
    const installing = f.installGate.prepare(async () => {}).then(() => { installed = true; });
    await tick();
    assert.equal(installed, false, name);
    finish(); await pending; await installing;
    await assert.rejects(Promise.resolve().then(() => f.invoke(name)), /preparing to update/, name);
  }
});

test('closing still waits for comment saves, settings, Git mutations and remote writes', async () => {
  for (const name of ['comment-add', 'comment-update', 'comment-delete', 'approve-many',
    'settings-update', 'project-create', 'git-run', 'feedback-publish', 'pullrequests-action'] as const) {
    const f = fixture();
    let finish!: () => void;
    f.handle(name, () => new Promise<never>(resolve => { finish = () => resolve(undefined as never); }));
    const pending = f.invoke(name);
    await tick();
    let closed = false;
    const closing = f.closeGate.prepare(async () => {}).then(() => { closed = true; });
    await tick();
    assert.equal(closed, false, name);
    finish(); await pending; await closing;
    assert.equal(closed, true, name);
  }
});

test('a background fetch failure during comment flushing cannot cancel closing', async () => {
  const f = fixture();
  let fail!: (error: Error) => void, flush!: () => void;
  f.handle('git-fetch', () => new Promise<never>((_, reject) => { fail = reject; }));
  const failed = assert.rejects(Promise.resolve(f.invoke('git-fetch', 'project')), /Offline/);
  await tick();
  const closing = f.closeGate.prepare(() => new Promise<void>(resolve => { flush = resolve; }));
  fail(new Error('Offline')); await failed;
  flush(); await closing;
});
