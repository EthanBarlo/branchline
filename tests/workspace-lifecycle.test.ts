import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceLifecycle, type WorkspaceWindow } from '../electron/application/workspace-lifecycle';
import { JiraBrowserOperations } from '../electron/application/jira-browser-operations';
import { reviewEvents } from '../shared/ipc';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const messages: { channel: string; args: unknown[] }[] = [];
  let closes = 0, quits = 0, restored = 0, prevented = 0, jiraChecks = 0;
  let destroyed = false, busy = false, jiraOpen = false;
  let jiraCanClose = true;
  const jiraChanges = new JiraBrowserOperations();
  const host: WorkspaceWindow = {
    isDestroyed: () => destroyed,
    close: () => { closes++; },
    webContents: { isDestroyed: () => destroyed, send: (channel, ...args) => messages.push({ channel, args }) },
  };
  let window: WorkspaceWindow | null = host;
  const lifecycle = new WorkspaceLifecycle({
    getWindow: () => window,
    waitForJiraChanges: () => jiraChanges.idle(),
    jira: { hasOpenWindows: () => jiraOpen, prepareClose: async () => { jiraChecks++; return jiraCanClose; } },
    updatesBusy: () => busy,
    quit: () => { quits++; },
    restoreWindow: () => { restored++; },
  });
  const close = () => lifecycle.requestClose({ preventDefault: () => { prevented++; } });
  const request = () => [...messages].reverse().find(message => message.channel === reviewEvents.beforeClose)?.args[0] as { id: number; reason: 'close' | 'install' };
  return { lifecycle, jiraChanges, messages, host, close, request,
    get closes() { return closes; }, get quits() { return quits; }, get restored() { return restored; }, get prevented() { return prevented; }, get jiraChecks() { return jiraChecks; },
    busy: (value: boolean) => { busy = value; }, jiraOpen: (value: boolean) => { jiraOpen = value; }, jiraCanClose: (value: boolean) => { jiraCanClose = value; },
    destroy: () => { destroyed = true; window = null; }, replace: () => { window = { ...host }; },
  };
}

test('save acknowledgements require a ready renderer and match the current request', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.flushWindow('close'), /not ready/);
  f.lifecycle.setListenerReady(true);
  let saved = false;
  const saving = f.lifecycle.flushWindow('close').then(() => { saved = true; });
  await assert.rejects(f.lifecycle.flushWindow('install'), /not ready/);
  f.lifecycle.acknowledgeFlush(f.request().id + 1, true);
  await tick();
  assert.equal(saved, false);
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  assert.equal(saved, false, 'save acknowledgement reaches preload before close continues');
  await saving;
  assert.equal(saved, true);
});

test('listener loss cancels saving and a late acknowledgement cannot save the recreated renderer', async () => {
  const f = fixture();
  f.lifecycle.setListenerReady(true);
  const first = f.lifecycle.flushWindow('close');
  const cancelled = assert.rejects(first, /did not finish saving/);
  const oldRequest = f.request().id;
  f.lifecycle.setListenerReady(false);
  await cancelled;
  f.lifecycle.windowCreated();
  f.lifecycle.setListenerReady(true);
  let saved = false;
  const next = f.lifecycle.flushWindow('close').then(() => { saved = true; });
  f.lifecycle.acknowledgeFlush(oldRequest, true);
  await tick();
  assert.equal(saved, false);
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await next;
});

test('close waits for Jira changes, renderer saves and accepted writes, then seals new writes', async () => {
  const f = fixture();
  const jira = deferred(), write = deferred();
  const jiraChange = f.jiraChanges.run(() => jira.promise);
  const acceptedWrite = f.lifecycle.closeGate.run('project-create', () => write.promise);
  f.lifecycle.setListenerReady(true);
  f.close(); f.close();
  assert.equal(f.lifecycle.closing, true);
  await assert.rejects(f.lifecycle.closeGate.run('project-create', () => {}), /preparing to close/);
  await f.lifecycle.closeGate.run('comment-update', () => {});
  await tick();
  assert.equal(f.messages.length, 0, 'native Jira changes finish before renderer saving begins');
  jira.resolve(); await jiraChange; await tick();
  assert.equal(f.request().reason, 'close');
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await tick(); await tick();
  assert.equal(f.closes, 0, 'accepted desktop writes finish after renderer acknowledgement');
  await assert.rejects(f.lifecycle.closeGate.run('comment-update', () => {}), /preparing to close/);
  write.resolve(); await acceptedWrite; await tick(); await tick();
  assert.equal(f.closes, 1);
  assert.equal(f.jiraChecks, 2, 'Jira closure is rechecked immediately before window close');
});

test('failed close saving restores editing and a retry can quit the application', async () => {
  const f = fixture();
  f.lifecycle.setListenerReady(true);
  f.lifecycle.beforeQuit();
  f.close(); await tick();
  f.lifecycle.acknowledgeFlush(f.request().id, false);
  await tick(); await tick();
  assert.equal(f.quits, 0);
  assert.equal(f.closes, 0);
  assert.equal(f.lifecycle.closing, false);
  assert.match(String(f.messages.find(message => message.channel === reviewEvents.closeCancelled)?.args[0]), /pending comments could not be saved/);
  await f.lifecycle.closeGate.run('project-create', () => {});
  f.lifecycle.beforeQuit();
  f.close(); await tick();
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await tick(); await tick();
  assert.equal(f.quits, 1);
});

test('close cancellation by Jira leaves the renderer open and restores accepted operations', async () => {
  const f = fixture();
  f.lifecycle.setListenerReady(true);
  f.close(); await tick();
  f.jiraCanClose(false);
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await tick(); await tick();
  assert.equal(f.closes, 0);
  assert.match(String(f.messages.find(message => message.channel === reviewEvents.closeCancelled)?.args[0]), /Jira is still open/);
  await f.lifecycle.closeGate.run('project-create', () => {});
});

test('reload cancels pending close and old window completion cannot close its replacement', async () => {
  const f = fixture();
  f.lifecycle.setListenerReady(true);
  f.close(); await tick();
  f.lifecycle.loadingStarted();
  await tick();
  assert.equal(f.lifecycle.ready, false);
  assert.equal(f.lifecycle.closing, false);
  await f.lifecycle.closeGate.run('project-create', () => {});
  f.lifecycle.setListenerReady(true);
  f.close(); await tick();
  f.replace();
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await tick(); await tick();
  assert.equal(f.closes, 0);
});

test('update preparation blocks close and releasing a failed install restores the missing window', async () => {
  const f = fixture();
  f.busy(true);
  f.close();
  assert.equal(f.prevented, 1);
  assert.equal(f.messages.length, 0);
  f.lifecycle.setListenerReady(true);
  const preparing = f.lifecycle.prepareInstall();
  assert.equal(f.request().reason, 'install');
  f.lifecycle.acknowledgeFlush(f.request().id, true);
  await preparing;
  f.close();
  assert.equal(f.prevented, 1, 'successful preparation permits the native installer to close');
  await assert.rejects(f.lifecycle.installGate.run('comment-update', () => {}), /preparing to update/);
  f.destroy();
  f.lifecycle.releaseInstall();
  assert.equal(f.restored, 1);
  await f.lifecycle.installGate.run('project-create', () => {});
});

test('update installation respects an active close and Jira sessions', async () => {
  const f = fixture();
  f.jiraOpen(true);
  assert.throws(() => f.lifecycle.assertCanInstall(), /Close the Jira ticket/);
  f.jiraOpen(false);
  f.lifecycle.setListenerReady(true);
  f.close();
  assert.throws(() => f.lifecycle.assertCanInstall(), /preparing to close/);
  await tick();
  f.lifecycle.acknowledgeFlush(f.request().id, false);
  await tick(); await tick();
});
