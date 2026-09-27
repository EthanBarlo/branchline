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

test('workspace requests use both shutdown gates while lifecycle controls remain available', async () => {
  const f = fixture(); let acknowledgements = 0;
  f.handle('copy', id => id);
  f.handle('close-ready', () => { acknowledgements++; });
  await f.closeGate.prepare(async () => {});
  await assert.rejects(Promise.resolve().then(() => f.invoke('copy', 'review')), /preparing to close/);
  f.invoke('close-ready', 1, true);
  f.closeGate.reset();
  await f.installGate.prepare(async () => {});
  await assert.rejects(Promise.resolve().then(() => f.invoke('copy', 'review')), /preparing to update/);
  f.invoke('close-ready', 2, true);
  assert.equal(acknowledgements, 2);
});

test('accepted IPC operations stay tracked until their complete asynchronous work finishes', async () => {
  const f = fixture();
  let finish!: (value: string) => void;
  f.handle('copy', () => new Promise<string>(resolve => { finish = resolve; }));
  const pending = f.invoke('copy', 'review');
  await new Promise<void>(resolve => setImmediate(resolve));
  let prepared = false;
  const preparation = f.closeGate.prepare(async () => {}).then(() => { prepared = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(prepared, false);
  finish('feedback');
  assert.equal(await pending, 'feedback');
  await preparation;
  assert.equal(prepared, true);
});
