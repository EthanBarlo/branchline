import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router';
import { createWorkspaceHistory } from '../src/navigation/createWorkspaceHistory';

type Navigation = {
  action: 'PUSH' | 'REPLACE' | 'BACK' | 'FORWARD' | 'GO';
  navigate: (history: RouterHistory) => void;
  destination: string;
};
const navigations: Navigation[] = [
  { action: 'PUSH', navigate: (history) => history.push('/new'), destination: '/new' },
  { action: 'REPLACE', navigate: (history) => history.replace('/replacement'), destination: '/replacement' },
  { action: 'BACK', navigate: (history) => history.back(), destination: '/first' },
  { action: 'FORWARD', navigate: (history) => history.forward(), destination: '/last' },
  { action: 'GO', navigate: (history) => history.go(-1), destination: '/first' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

for (const { action, navigate, destination } of navigations) {
  test(`${action} waits for pending saves before committing`, async () => {
    const saving = deferred<boolean>();
    const history = createWorkspaceHistory({
      initialEntries: ['/first', '/current', '/last'],
      initialIndex: 1,
    });
    const events: string[] = [];
    history.subscribe((event) => events.push(event.action.type));
    history.block({
      blockerFn: ({ currentLocation, nextLocation, action: attempted }) => {
        assert.equal(attempted, action);
        assert.equal(currentLocation.pathname, '/current');
        assert.equal(nextLocation.pathname, destination);
        return saving.promise;
      },
    });
    const original = history.location;
    navigate(history);
    assert.strictEqual(history.location, original);
    assert.deepEqual(events, []);
    saving.resolve(false);
    await setImmediate();
    assert.equal(history.location.pathname, destination);
    assert.deepEqual(events, [action]);
  });

  test(`${action} remains in place when saving fails`, async () => {
    const saving = deferred<boolean>();
    let blocked = 0;
    const history = createWorkspaceHistory({
      initialEntries: ['/first', '/current', '/last'],
      initialIndex: 1,
      onBlocked: () => blocked++,
    });
    let notified = false;
    history.subscribe(() => { notified = true; });
    history.block({ blockerFn: () => saving.promise });
    const original = history.location;
    navigate(history);
    saving.reject(new Error('Could not save comment'));
    await setImmediate();
    assert.strictEqual(history.location, original);
    assert.equal(history.length, 3);
    assert.equal(notified, false);
    assert.equal(blocked, 1);
  });
}

test('a blocked settings save stops traversal and its unregister restores navigation', async () => {
  let saving = true;
  let blocked = 0;
  const history = createWorkspaceHistory({
    initialEntries: ['/review', '/settings/jira'],
    onBlocked: () => blocked++,
  });
  const unregister = history.block({ blockerFn: () => saving });
  history.back();
  await setImmediate();
  assert.equal(history.location.pathname, '/settings/jira');
  assert.equal(blocked, 1);
  saving = false;
  history.back();
  await setImmediate();
  assert.equal(history.location.pathname, '/review');
  saving = true;
  unregister();
  history.forward();
  assert.equal(history.location.pathname, '/settings/jira');
});

test('traversal presents and restores the original history state and entry keys', async () => {
  const history = createWorkspaceHistory({ initialEntries: ['/first'] });
  history.push('/settings/jira?tab=links#example', { workspace: { projectId: 'p', reviewId: 'r' } });
  const settings = history.location;
  history.push('/last');
  const last = history.location;
  history.block({
    blockerFn: ({ nextLocation, action }) => {
      const expected = action === 'BACK' ? settings : last;
      assert.deepEqual(nextLocation, expected);
      return false;
    },
  });
  history.back();
  await setImmediate();
  assert.deepEqual(history.location, settings);
  history.forward();
  await setImmediate();
  assert.deepEqual(history.location, last);
  assert.equal(settings.state.__TSR_index, 1);
  assert.equal(settings.state.key, settings.state.__TSR_key);
});

test('a newer navigation supersedes an older pending save', async () => {
  const older = deferred<boolean>();
  const history = createWorkspaceHistory({ initialEntries: ['/current'] });
  const events: string[] = [];
  history.subscribe(({ location }) => events.push(location.pathname));
  history.block({
    blockerFn: ({ nextLocation }) => nextLocation.pathname === '/older' ? older.promise : false,
  });
  history.push('/older');
  history.push('/newer');
  await setImmediate();
  assert.equal(history.location.pathname, '/newer');
  older.resolve(false);
  await setImmediate();
  assert.equal(history.location.pathname, '/newer');
  assert.equal(history.length, 2);
  assert.deepEqual(events, ['/newer']);
});

test('a blocked newer intent also cancels the older pending navigation', async () => {
  const older = deferred<boolean>();
  let blocked = 0;
  const history = createWorkspaceHistory({ initialEntries: ['/current'], onBlocked: () => blocked++ });
  history.block({
    blockerFn: ({ nextLocation }) => nextLocation.pathname === '/older' ? older.promise : true,
  });
  history.push('/older');
  history.push('/newer');
  await setImmediate();
  older.resolve(false);
  await setImmediate();
  assert.equal(history.location.pathname, '/current');
  assert.equal(history.length, 1);
  assert.equal(blocked, 1);
});

test('an internal redirect bypasses guards and invalidates a pending navigation', async () => {
  const saving = deferred<boolean>();
  let blocked = 0;
  const history = createWorkspaceHistory({
    initialEntries: ['/deleted-review'],
    onBlocked: () => blocked++,
  });
  let checks = 0;
  history.block({ blockerFn: () => { checks++; return saving.promise; } });
  history.push('/settings/jira');
  history.replace('/current', { repaired: true }, { ignoreBlocker: true });
  assert.equal(history.location.pathname, '/current');
  assert.equal(Reflect.get(history.location.state, 'repaired'), true);
  saving.resolve(false);
  await setImmediate();
  assert.equal(history.location.pathname, '/current');
  assert.equal(history.length, 1);
  assert.equal(checks, 1);
  assert.equal(blocked, 0);
});

test('a stale rejected save does not cancel or settle a newer navigation', async () => {
  const older = deferred<boolean>();
  const newer = deferred<boolean>();
  let blocked = 0;
  const history = createWorkspaceHistory({ initialEntries: ['/current'], onBlocked: () => blocked++ });
  history.block({
    blockerFn: ({ nextLocation }) => nextLocation.pathname === '/older' ? older.promise : newer.promise,
  });
  history.push('/older');
  history.push('/newer');
  older.reject(new Error('stale failure'));
  await setImmediate();
  assert.equal(blocked, 0);
  assert.equal(history.location.pathname, '/current');
  newer.resolve(false);
  await setImmediate();
  assert.equal(history.location.pathname, '/newer');
});

test('initialIndex zero, replacement, and branching retain normal memory history semantics', () => {
  const history = createWorkspaceHistory({ initialEntries: ['/first', '/second', '/third'], initialIndex: 0 });
  assert.equal(history.location.pathname, '/first');
  assert.equal(history.canGoBack(), false);
  history.forward();
  assert.equal(history.location.pathname, '/second');
  const secondKey = history.location.state.__TSR_key;
  history.replace('/changed', { userState: 'kept' });
  assert.notEqual(history.location.state.__TSR_key, secondKey);
  assert.equal(history.location.state.__TSR_index, 1);
  history.push('/branch');
  assert.equal(history.length, 3);
  history.go(-1);
  assert.equal(Reflect.get(history.location.state, 'userState'), 'kept');
  history.forward();
  assert.equal(history.location.pathname, '/branch');
});

test('destroying history cancels pending navigation and clears subscribers', async () => {
  const saving = deferred<boolean>();
  const history = createWorkspaceHistory();
  let notified = false;
  history.subscribe(() => { notified = true; });
  history.block({ blockerFn: () => saving.promise });
  history.push('/next');
  history.destroy();
  saving.resolve(false);
  await setImmediate();
  assert.equal(history.location.pathname, '/');
  assert.equal(history.subscribers.size, 0);
  assert.equal(notified, false);
});


test('blocked router.navigate promises settle without changing the route', { timeout: 1000 }, async () => {
  const root = createRootRoute();
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/' }),
    createRoute({ getParentRoute: () => root, path: '/next' }),
  ]);
  const history = createWorkspaceHistory({ initialEntries: ['/'], onBlocked: () => { void router.load(); } });
  const router = createRouter({ routeTree, history, isServer: false });
  const unsubscribe = history.subscribe(router.load);
  await router.load();
  history.block({ blockerFn: () => true });
  await router.navigate({ href: '/next' });
  assert.equal(router.state.location.pathname, '/');
  assert.equal(history.location.pathname, '/');
  unsubscribe();
  history.destroy();
});
