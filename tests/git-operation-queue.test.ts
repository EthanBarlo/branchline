import assert from 'node:assert/strict';
import test from 'node:test';
import { GitOperationQueue } from '../electron/git/operation-queue';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const scope = (...paths: string[]) => Promise.resolve(paths);

test('unrelated project writes and reads proceed while an overlapping write waits for its readers', async () => {
  const queue = new GitOperationQueue();
  const hold = gate();
  const events: string[] = [];
  const read = queue.run(false, scope('/a'), async () => {
    events.push('reader');
    await hold.promise;
  });
  const write = queue.run(true, scope('/a'), async () => {
    events.push('writer');
  });
  const later = queue.run(false, scope('/a/child'), async () => {
    events.push('later');
  });
  await queue.run(true, scope('/ab'), async () => {
    events.push('independent');
  });
  assert.deepEqual(events, ['reader', 'independent']);
  hold.release();
  await Promise.all([read, write, later]);
  assert.deepEqual(events, ['reader', 'independent', 'writer', 'later']);
});

test('linked worktrees and parent/submodule Git directories share a write barrier', async () => {
  for (const paths of [
    ['/worktree-b', '/shared/git'],
    ['/checkout/module', '/shared/git/modules/module'],
  ]) {
    const queue = new GitOperationQueue();
    const hold = gate();
    let started = false;
    const write = queue.run(true, scope('/checkout', '/shared/git'), () => hold.promise);
    const read = queue.run(false, scope(...paths), async () => {
      started = true;
    });
    await tick();
    assert.equal(started, false);
    hold.release();
    await Promise.all([write, read]);
    assert.equal(started, true);
  }
});

test('registration order survives delayed scope resolution and a failed operation does not poison the queue', async () => {
  const queue = new GitOperationQueue();
  const hold = gate();
  const events: string[] = [];
  const first = queue.run(
    true,
    hold.promise.then(() => ['/a']),
    async () => {
      events.push('write');
      throw new Error('failure');
    },
  );
  const caught = first.catch(() => {});
  const second = queue.run(false, scope('/a'), async () => {
    events.push('read');
  });
  await tick();
  assert.equal(events.length, 0);
  hold.release();
  await Promise.all([caught, second]);
  assert.deepEqual(events, ['write', 'read']);
  const badScope = queue.run(true, Promise.reject(new Error('missing repo')), async () => {});
  const recovered = queue.run(false, scope('/a'), async () => {
    events.push('recovered');
  });
  await Promise.all([badScope.catch(() => {}), recovered]);
  assert.equal(events.at(-1), 'recovered');
});
