import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { createServer } from 'node:http';
import { GitWorkflowService } from '../electron/git/workflow-service';
import type { GitActionInput } from '../shared/git-workflow';

const fixtures: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(directory: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Workflow Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
async function commit(directory: string, filename: string, contents: string): Promise<string> {
  await writeFile(path.join(directory, filename), contents);
  git(directory, 'add', filename);
  git(directory, 'commit', '-qm', filename);
  return git(directory, 'rev-parse', 'HEAD');
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'branchline-workflow-'));
  fixtures.push(directory);
  const remote = path.join(directory, 'remote.git');
  const local = path.join(directory, 'local');
  const peer = path.join(directory, 'peer');
  await mkdir(local);
  git(directory, 'init', '--bare', '-q', '-b', 'main', remote);
  git(local, 'init', '-q', '-b', 'main');
  await commit(local, 'file.txt', 'initial\n');
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-qu', 'origin', 'main');
  git(directory, 'clone', '-q', remote, peer);
  const journal = path.join(directory, 'workflow.json');
  const project = { id: 'project', name: 'Test', repoPath: local, defaultBaseBranch: null, createdAt: '' };
  const service = new GitWorkflowService(journal, () => project);
  await service.load();
  return { directory, remote, local, peer, service, journal, project };
}
async function run(service: GitWorkflowService, input: GitActionInput) {
  const preview = await service.preview('project', input);
  assert.equal(preview.ready, true, JSON.stringify(preview.rows));
  return service.run('project', preview.id);
}
afterEach(async () => {
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('fetch reports incoming, pull fast-forwards, and push reports outgoing', async () => {
  const { local, peer, remote, service } = await fixture();
  const incoming = await commit(peer, 'incoming.txt', 'remote\n');
  git(peer, 'push', '-q');
  const fetched = await service.fetch('project');
  assert.equal(fetched.repositories[0].incoming, 1);
  assert.ok(fetched.repositories[0].lastFetched);
  assert.equal((await run(service, { action: 'pull' })).state, 'completed');
  assert.equal(git(local, 'rev-parse', 'HEAD'), incoming);
  const outgoing = await commit(local, 'outgoing.txt', 'local\n');
  assert.equal((await service.getStatus('project')).repositories[0].outgoing, 1);
  assert.equal((await run(service, { action: 'push' })).state, 'completed');
  assert.equal(git(remote, 'rev-parse', 'main'), outgoing);
});

test('conflict-free divergent history is blocked without creating merge state', async () => {
  const { local, peer, remote, service } = await fixture();
  const localHead = await commit(local, 'local-only.txt', 'local\n');
  await commit(peer, 'remote-only.txt', 'remote\n');
  git(peer, 'push', '-q');
  const remoteHead = git(remote, 'rev-parse', 'main');
  const preview = await service.preview('project', { action: 'pull' });
  assert.equal(preview.ready, false);
  assert.match(preview.rows[0].blockers.join(' '), /diverged/);
  await assert.rejects(service.run('project', preview.id), /unblocked/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), localHead);
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
  assert.throws(() => git(local, 'rev-parse', '--verify', 'MERGE_HEAD'));
});

test('ahead-only pull is a no-op; dirty files block pull and checkout but not push', async () => {
  const { local, service } = await fixture();
  await commit(local, 'ahead.txt', 'ahead\n');
  assert.equal((await service.preview('project', { action: 'pull' })).rows[0].noop, true);
  git(local, 'branch', 'feature');
  await writeFile(path.join(local, 'untracked.txt'), 'dirty\n');
  for (const input of [
    { action: 'pull' },
    { action: 'checkout', branch: { name: 'feature' } },
  ] as GitActionInput[]) {
    const preview = await service.preview('project', input);
    assert.equal(preview.ready, false);
    assert.match(preview.rows[0].blockers.join(' '), /Commit or stash/);
  }
  assert.equal((await run(service, { action: 'push' })).state, 'completed');
  assert.equal(await readFile(path.join(local, 'untracked.txt'), 'utf8'), 'dirty\n');
});

test('publishes a local branch and establishes tracking only after success', async () => {
  const { local, remote, service } = await fixture();
  git(local, 'switch', '-qc', 'feature');
  const head = await commit(local, 'feature.txt', 'feature\n');
  assert.equal((await service.preview('project', { action: 'push' })).ready, false);
  assert.equal(
    (await run(service, { action: 'push', publishRemotes: { '.': 'origin' } })).state,
    'completed',
  );
  assert.equal(git(remote, 'rev-parse', 'feature'), head);
  assert.equal(git(local, 'config', 'branch.feature.remote'), 'origin');
  assert.equal(git(local, 'config', 'branch.feature.merge'), 'refs/heads/feature');
});

test('remote-only checkout creates a tracking branch and local checkout preserves its tracking', async () => {
  const { local, peer, service } = await fixture();
  git(peer, 'switch', '-qc', 'feature');
  await commit(peer, 'feature.txt', 'feature\n');
  git(peer, 'push', '-qu', 'origin', 'feature');
  await service.fetch('project');
  const branches = (await service.getStatus('project')).branches;
  assert.ok(
    branches.some((branch) => branch.name === 'feature' && branch.repositories[0].remotes.includes('origin')),
  );
  assert.equal(
    (await run(service, { action: 'checkout', branch: { name: 'feature', remote: 'origin' } })).state,
    'completed',
  );
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'feature');
  assert.equal(git(local, 'config', 'branch.feature.remote'), 'origin');
  await run(service, { action: 'checkout', branch: { name: 'main' } });
  assert.equal(git(local, 'config', 'branch.main.remote'), 'origin');
});

test('rejects stale previews after local edits, checkout changes, or remote changes', async () => {
  const { local, peer, service } = await fixture();
  git(local, 'branch', 'feature');
  const checkout = await service.preview('project', { action: 'checkout', branch: { name: 'feature' } });
  await writeFile(path.join(local, 'file.txt'), 'dirty\n');
  await assert.rejects(service.run('project', checkout.id), /changed since/);
  git(local, 'restore', 'file.txt');
  await commit(local, 'outgoing.txt', 'outgoing\n');
  const push = await service.preview('project', { action: 'push' });
  await commit(peer, 'incoming.txt', 'incoming\n');
  git(peer, 'push', '-q');
  await assert.rejects(service.run('project', push.id), /changed since/);
});

test('blocks worktree-held branches, ambiguous remotes, missing branches and invalid names', async () => {
  const { directory, local, remote, service } = await fixture();
  git(local, 'branch', 'held');
  git(local, 'worktree', 'add', '-q', path.join(directory, 'worktree'), 'held');
  assert.match(
    (
      await service.preview('project', { action: 'checkout', branch: { name: 'held' } })
    ).rows[0].blockers.join(' '),
    /another worktree/,
  );
  git(local, 'remote', 'add', 'second', remote);
  git(local, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
  git(local, 'update-ref', 'refs/remotes/second/remote-only', 'HEAD');
  assert.match(
    (
      await service.preview('project', { action: 'checkout', branch: { name: 'remote-only' } })
    ).rows[0].blockers.join(' '),
    /ambiguous/,
  );
  for (const name of ['missing', '--discard-changes', '../bad']) {
    assert.equal((await service.preview('project', { action: 'checkout', branch: { name } })).ready, false);
  }
});

async function withChild() {
  const result = await fixture();
  const childSource = path.join(result.directory, 'child-source');
  await mkdir(childSource);
  git(childSource, 'init', '-q', '-b', 'main');
  await commit(childSource, 'child.txt', 'child\n');
  git(result.local, 'submodule', 'add', '-q', childSource, 'child');
  git(result.local, 'commit', '-qm', 'Add child');
  git(result.local, 'push', '-q');
  const child = path.join(result.local, 'child');
  git(child, 'branch', 'feature');
  git(result.local, 'branch', 'feature');
  return { ...result, child };
}

test('project checkout tolerates unstaged pointers, switches children, and blocks staged pointers', async () => {
  const { local, child, service } = await withChild();
  await commit(child, 'child.txt', 'new child\n');
  const snapshot = await service.getStatus('project');
  assert.equal(snapshot.repositories.length, 2);
  assert.deepEqual(snapshot.repositories[0].pointerChanges, ['child']);
  assert.equal(snapshot.repositories[0].changes, 0);
  assert.equal((await run(service, { action: 'checkout', branch: { name: 'feature' } })).state, 'completed');
  assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'feature');
  await run(service, { action: 'checkout', branch: { name: 'main' } });
  git(local, 'add', 'child');
  assert.equal(
    (await service.preview('project', { action: 'checkout', branch: { name: 'feature' } })).ready,
    false,
  );
});

test('missing child branch or mixed checkout blocks the whole project before mutation', async () => {
  const { local, child, service } = await withChild();
  git(child, 'branch', '-D', 'feature');
  const preview = await service.preview('project', { action: 'checkout', branch: { name: 'feature' } });
  assert.equal(preview.ready, false);
  await assert.rejects(service.run('project', preview.id));
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  git(child, 'switch', '-qc', 'other');
  assert.equal((await service.preview('project', { action: 'pull' })).ready, false);
  assert.equal((await service.preview('project', { action: 'push' })).ready, false);
});

test('uninitialized submodules stay visible; topology changes block checkout', async () => {
  const { local, child, service } = await withChild();
  git(local, 'switch', '-q', 'feature');
  git(local, 'rm', '-q', '-f', 'child');
  git(local, 'commit', '-qm', 'Remove child');
  git(local, 'switch', '-q', 'main');
  const snapshot = await service.getStatus('project');
  assert.equal(snapshot.repositories[1].path, 'child');
  assert.match(snapshot.repositories[1].error!, /initialized/);
  assert.equal(
    (await service.preview('project', { action: 'checkout', branch: { name: 'feature' } })).ready,
    false,
  );
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.ok(child);
});

test('partial checkout results persist and stop after a child changes externally', async () => {
  const { local, child, service, journal, project } = await withChild();
  const hook = path.join(local, '.git/hooks/post-checkout');
  await writeFile(hook, '#!/bin/sh\nprintf changed > child/untracked.txt\n');
  await chmod(hook, 0o755);
  const operation = await run(service, { action: 'checkout', branch: { name: 'feature' } });
  assert.equal(operation.state, 'failed');
  assert.equal(operation.rows[0].state, 'done');
  assert.equal(operation.rows[1].state, 'failed');
  assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'main');
  const restarted = new GitWorkflowService(journal, () => project);
  await restarted.load();
  assert.equal((await restarted.getStatus('project')).operation?.rows[0].state, 'done');
});

test('failed fetch preserves counts and previous successful fetch time', async () => {
  const { local, service } = await fixture();
  const previous = await service.fetch('project');
  git(local, 'remote', 'set-url', 'origin', '/missing/branchline-remote');
  const failed = await service.fetch('project');
  assert.equal(failed.repositories[0].lastFetched, previous.repositories[0].lastFetched);
  assert.ok(failed.repositories[0].fetchError);
  assert.equal(failed.repositories[0].incoming, 0);
  assert.equal((await service.preview('project', { action: 'pull' })).ready, false);
});

test('interrupted actions reconcile to Git state and never automatically replay', async () => {
  const { local, service, journal, project } = await fixture();
  git(local, 'branch', 'feature');
  const operation = await run(service, { action: 'checkout', branch: { name: 'feature' } });
  const persisted = JSON.parse(await readFile(journal, 'utf8'));
  persisted.operations.project.state = 'running';
  persisted.operations.project.rows[0].state = 'running';
  await writeFile(journal, JSON.stringify(persisted));
  const restarted = new GitWorkflowService(journal, () => project);
  await restarted.load();
  const snapshot = await restarted.getStatus('project');
  assert.equal(snapshot.operation?.state, 'interrupted');
  assert.equal(snapshot.operation?.rows[0].state, 'done');
  assert.equal(snapshot.operation?.id, operation.id);
});

test('readers coexist; Git writes drain readers and block subsequent reads', async () => {
  const { service } = await fixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const first = service.read(async () => {
    events.push('start');
    await hold;
    events.push('end');
  });
  await service.read(async () => {
    events.push('light read');
  });
  service.subscribe((change) => { if (!change.snapshot) events.push(change.busy ? 'write start' : 'write end'); });
  const write = service.fetch('project');
  const second = service.getStatus('project').then(() => events.push('status'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start', 'light read']);
  release();
  await Promise.all([first, write, second]);
  assert.deepEqual(events, ['start', 'light read', 'end', 'write start', 'write end', 'status']);
});

test('project push publishes child commits before referenced parent commits', async () => {
  const { local, child, remote, service } = await withChild();
  const childRemote = git(child, 'remote', 'get-url', 'origin');
  git(childRemote, 'config', 'receive.denyCurrentBranch', 'ignore');
  const childHead = await commit(child, 'child.txt', 'child outgoing\n');
  git(local, 'add', 'child');
  git(local, 'commit', '-qm', 'Update pointer manually');
  const parentHead = git(local, 'rev-parse', 'HEAD');
  const order: string[] = [];
  service.subscribe((change) => {
    const running = change.operation?.rows.find((row) => row.state === 'running')?.path;
    if (running && order.at(-1) !== running) order.push(running);
  });
  const operation = await run(service, { action: 'push' });
  assert.equal(operation.state, 'completed', JSON.stringify(operation));
  assert.deepEqual(order, ['child', '.']);
  assert.equal(git(childRemote, 'rev-parse', 'main'), childHead);
  assert.equal(git(remote, 'rev-parse', 'main'), parentHead);
});

test('project pull fast-forwards parents and children without detached submodule checkouts', async () => {
  const { local, child, peer, service } = await withChild();
  const childSource = git(child, 'remote', 'get-url', 'origin');
  const childHead = await commit(childSource, 'child.txt', 'child incoming\n');
  git(peer, 'pull', '-q', '--ff-only');
  git(peer, 'update-index', '--add', '--cacheinfo', `160000,${childHead},child`);
  git(peer, 'commit', '-qm', 'Remote pointer update');
  git(peer, 'push', '-q');
  const parentHead = git(peer, 'rev-parse', 'HEAD');
  const operation = await run(service, { action: 'pull' });
  assert.equal(operation.state, 'completed', JSON.stringify(operation));
  assert.equal(git(local, 'rev-parse', 'HEAD'), parentHead);
  assert.equal(git(child, 'rev-parse', 'HEAD'), childHead);
  assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('nested submodules are discovered and file edits block every checkout', async () => {
  const { directory, child, local, service } = await withChild();
  const leafSource = path.join(directory, 'leaf-source');
  await mkdir(leafSource);
  git(leafSource, 'init', '-q', '-b', 'main');
  await commit(leafSource, 'leaf.txt', 'leaf\n');
  git(child, 'submodule', 'add', '-q', leafSource, 'nested');
  git(child, 'commit', '-qm', 'Nested module');
  const leaf = path.join(child, 'nested');
  git(leaf, 'branch', 'feature');
  await writeFile(path.join(leaf, 'leaf.txt'), 'dirty\n');
  const snapshot = await service.getStatus('project');
  assert.deepEqual(
    snapshot.repositories.map((row) => row.path),
    ['.', 'child', 'child/nested'],
  );
  const preview = await service.preview('project', { action: 'checkout', branch: { name: 'feature' } });
  assert.equal(preview.ready, false);
  assert.match(preview.rows[2].blockers.join(' '), /Commit or stash/);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('push uses a configured separate push URL and stale remote destinations block execution', async () => {
  const { directory, local, remote, service } = await fixture();
  const fork = path.join(directory, 'fork.git');
  git(directory, 'clone', '-q', '--bare', remote, fork);
  git(local, 'remote', 'set-url', '--push', 'origin', fork);
  const original = git(remote, 'rev-parse', 'main');
  const head = await commit(local, 'fork.txt', 'fork\n');
  await service.fetch('project');
  assert.equal((await service.getStatus('project')).repositories[0].outgoing, 1);
  assert.equal((await run(service, { action: 'push' })).state, 'completed');
  assert.equal(git(fork, 'rev-parse', 'main'), head);
  assert.equal(git(remote, 'rev-parse', 'main'), original);
  const preview = await service.preview('project', { action: 'push' });
  git(local, 'remote', 'set-url', '--push', 'origin', remote);
  await assert.rejects(service.run('project', preview.id), /changed since/);
});

test('authentication failure is noninteractive, redacted, and never marked fresh', async () => {
  const { local, service } = await fixture();
  await service.fetch('project');
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
    response.end('Unauthorized');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    git(local, 'config', 'credential.helper', '');
    git(local, 'remote', 'set-url', 'origin', `http://user:fixture-secret@127.0.0.1:${address.port}/repo`);
    const snapshot = await service.fetch('project');
    assert.ok(snapshot.repositories[0].fetchError);
    assert.doesNotMatch(JSON.stringify(snapshot), /fixture-secret/);
    const preview = await service.preview('project', { action: 'pull' });
    assert.equal(preview.ready, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a rejected push preserves remote history and reconciles a known failure', async () => {
  const { local, remote, service } = await fixture();
  const original = git(remote, 'rev-parse', 'main');
  await commit(local, 'outgoing.txt', 'outgoing\n');
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const result = await run(service, { action: 'push' });
  assert.equal(result.state, 'failed');
  assert.equal(result.rows[0].state, 'failed');
  assert.equal(git(remote, 'rev-parse', 'main'), original);
  assert.equal((await service.preview('project', { action: 'push' })).ready, true);
});

test('an uncertain receipt blocks overlapping projects and can be acknowledged from either alias', async () => {
  const { local, journal, project, service } = await fixture();
  git(local, 'branch', 'feature');
  await run(service, { action: 'checkout', branch: { name: 'feature' } });
  git(local, 'switch', '-qc', 'other');
  await commit(local, 'other.txt', 'different history\n');
  const persisted = JSON.parse(await readFile(journal, 'utf8'));
  persisted.operations.project.state = 'running';
  persisted.operations.project.rows[0].state = 'running';
  await writeFile(journal, JSON.stringify(persisted));
  const restarted = new GitWorkflowService(journal, (id) => ({ ...project, id }));
  await restarted.load();
  const alias = await restarted.getStatus('alias');
  assert.equal(alias.operation?.rows[0].state, 'unknown');
  const blocked = await restarted.preview('alias', { action: 'checkout', branch: { name: 'main' } });
  assert.equal(blocked.ready, false);
  await restarted.acknowledge('alias');
  assert.equal(
    (await restarted.preview('alias', { action: 'checkout', branch: { name: 'main' } })).ready,
    true,
  );
});

test('merge/rebase state blocks mutations and staged file edits block checkout', async () => {
  const { local, service } = await fixture();
  git(local, 'branch', 'feature');
  await writeFile(path.join(local, '.git/MERGE_HEAD'), `${git(local, 'rev-parse', 'HEAD')}\n`);
  const merge = await service.preview('project', { action: 'checkout', branch: { name: 'feature' } });
  assert.equal(merge.ready, false);
  assert.match(merge.rows[0].blockers.join(' '), /Finish the current merge/);
  await rm(path.join(local, '.git/MERGE_HEAD'));
  await writeFile(path.join(local, 'file.txt'), 'staged\n');
  git(local, 'add', 'file.txt');
  assert.equal(
    (await service.preview('project', { action: 'checkout', branch: { name: 'feature' } })).ready,
    false,
  );
});

test('branch discovery combines nested repositories and deduplicates local and remote branch names', async () => {
  const { directory, local, child, service } = await withChild();
  const leafSource = path.join(directory, 'branch-leaf');
  await mkdir(leafSource);
  git(leafSource, 'init', '-q', '-b', 'main');
  await commit(leafSource, 'leaf.txt', 'leaf\n');
  git(child, 'submodule', 'add', '-q', leafSource, 'nested');
  git(child, 'commit', '-qm', 'Nested branch fixture');
  const leaf = path.join(child, 'nested');
  git(leaf, 'branch', 'feature');
  git(local, 'branch', 'root-only');
  git(child, 'branch', 'topic/child-only');
  git(leaf, 'branch', 'topic/nested/leaf-only');
  git(child, 'remote', 'add', 'mirror', path.join(directory, 'child-source'));
  git(child, 'fetch', '-q', 'mirror');
  const snapshot = await service.getStatus('project');
  const feature = snapshot.branches.find((branch) => branch.name === 'feature')!;
  assert.deepEqual(
    feature.repositories.map((repo) => repo.path),
    ['.', 'child', 'child/nested'],
  );
  assert.deepEqual(
    snapshot.branches
      .find((branch) => branch.name === 'topic/child-only')!
      .repositories.map((repo) => repo.path),
    ['child'],
  );
  assert.deepEqual(
    snapshot.branches
      .find((branch) => branch.name === 'topic/nested/leaf-only')!
      .repositories.map((repo) => repo.path),
    ['child/nested'],
  );
  assert.deepEqual(
    snapshot.branches.find((branch) => branch.name === 'root-only')!.repositories.map((repo) => repo.path),
    ['.'],
  );
  assert.equal(snapshot.branches.filter((branch) => branch.name === 'main').length, 1);
  const childMain = snapshot.branches
    .find((branch) => branch.name === 'main')!
    .repositories.find((repo) => repo.path === 'child')!;
  assert.equal(childMain.local, true);
  assert.deepEqual(childMain.remotes.sort(), ['mirror', 'origin']);
});

test('non-current branch counts track their own destinations and invalidate on external ref and config changes', async () => {
  const { local, peer, service } = await fixture();
  git(local, 'switch', '-qc', 'Feature/example');
  git(local, 'push', '-qu', 'origin', 'Feature/example');
  await commit(local, 'local-feature.txt', 'local\n');
  git(local, 'switch', '-q', 'main');
  git(peer, 'fetch', '-q');
  git(peer, 'switch', '-qc', 'Feature/example', '--track', 'origin/Feature/example');
  await commit(peer, 'remote-feature.txt', 'remote\n');
  git(peer, 'push', '-q');
  const member = (snapshot: Awaited<ReturnType<GitWorkflowService['getStatus']>>) =>
    snapshot.branches.find((branch) => branch.name === 'Feature/example')!.repositories[0];
  const fetched = member(await service.fetch('project'));
  assert.equal(fetched.current, false);
  assert.equal(fetched.incoming, 1);
  assert.equal(fetched.outgoing, 1);
  assert.equal(fetched.diverged, true);
  assert.deepEqual(member(await service.getStatus('project')), fetched);
  git(local, 'update-ref', 'refs/heads/Feature/example', 'refs/remotes/origin/Feature/example');
  const updated = member(await service.getStatus('project'));
  assert.equal(updated.incoming, 0);
  assert.equal(updated.outgoing, 0);
  git(local, 'config', 'branch.Feature/example.merge', 'refs/heads/main');
  const reconfigured = member(await service.getStatus('project'));
  assert.equal(reconfigured.upstream?.branch, 'main');
  assert.equal(reconfigured.incoming, 0);
  assert.equal(reconfigured.outgoing, 1);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('creates project branches from captured source commits without checkout, tracking, or file/index changes', async () => {
  const { local, child, service } = await withChild();
  await writeFile(path.join(local, 'file.txt'), 'staged edit\n');
  git(local, 'add', 'file.txt');
  await writeFile(path.join(child, 'untracked.txt'), 'local edit\n');
  const before = [local, child].map(repo => ({ head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain'), index: git(repo, 'write-tree'), source: git(repo, 'rev-parse', 'feature') }));
  const preview = await service.preview('project', { action: 'create', branch: { name: 'feature' }, newBranch: 'topic/new' });
  assert.equal(preview.ready, true);
  assert.equal(service.needsJiraClose('project', preview.id), false);
  assert.equal((await service.run('project', preview.id)).state, 'completed');
  for (const [i, repo] of [local, child].entries()) {
    assert.equal(git(repo, 'rev-parse', 'topic/new'), before[i].source);
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before[i].head);
    assert.equal(git(repo, 'status', '--porcelain'), before[i].status);
    assert.equal(git(repo, 'write-tree'), before[i].index);
    assert.throws(() => git(repo, 'config', 'branch.topic/new.remote'));
  }
});

test('new branch from a remote-only source uses the resolved commit without establishing tracking', async () => {
  const { local, peer, service } = await fixture();
  git(peer, 'switch', '-qc', 'remote-source');
  const source = await commit(peer, 'source.txt', 'source\n');
  git(peer, 'push', '-qu', 'origin', 'remote-source');
  await service.fetch('project');
  const result = await run(service, { action: 'create', branch: { name: 'remote-source', remote: 'origin' }, newBranch: 'from-remote' });
  assert.equal(result.rows[0].source?.remote, 'origin');
  assert.equal(git(local, 'rev-parse', 'from-remote'), source);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.throws(() => git(local, 'config', 'branch.from-remote.remote'));
  const rename = await service.preview('project', { action: 'rename', branch: { name: 'remote-source' }, newBranch: 'renamed' });
  assert.equal(rename.ready, false);
  assert.match(rename.rows[0].blockers.join(' '), /requires a local branch/);
});

test('invalid names, existing branches, folder/config collisions, and missing sources block all branch writes', async () => {
  const { local, child, service } = await withChild();
  git(child, 'branch', 'taken');
  git(child, 'branch', 'folder/existing');
  git(child, 'config', 'branch.configured.description', 'orphan config');
  git(child, 'branch', '-D', 'feature');
  const before = [local, child].map(repo => git(repo, 'show-ref'));
  const inputs: GitActionInput[] = [
    ...['HEAD', '--bad', 'bad..name', 'main', 'taken', 'folder', 'folder/existing/deeper', 'configured'].map(newBranch => ({ action: 'create' as const, branch: { name: 'main' }, newBranch })),
    { action: 'create', branch: { name: 'feature' }, newBranch: 'missing-child' },
    { action: 'rename', branch: { name: 'feature' }, newBranch: 'renamed-child' },
  ];
  for (const input of inputs) {
    const preview = await service.preview('project', input);
    assert.equal(preview.ready, false, JSON.stringify(input));
    await assert.rejects(service.run('project', preview.id), /unblocked/);
    assert.deepEqual([local, child].map(repo => git(repo, 'show-ref')), before);
  }
});

test('renames the current project branch preserving upstream, push destination, files, index, and remote refs', async () => {
  const { local, child, remote, service } = await withChild();
  for (const repo of [local, child]) {
    git(repo, 'config', 'branch.main.description', 'Branch notes');
    git(repo, 'config', 'branch.main.pushRemote', 'origin');
    await writeFile(path.join(repo, repo === local ? 'file.txt' : 'child.txt'), 'staged\n');
    git(repo, 'add', '.');
  }
  const heads = [local, child].map(repo => git(repo, 'rev-parse', 'HEAD'));
  const indexes = [local, child].map(repo => git(repo, 'write-tree'));
  const remoteHead = git(remote, 'rev-parse', 'main');
  const preview = await service.preview('project', { action: 'rename', branch: { name: 'main' }, newBranch: 'renamed/main' });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  assert.equal(service.needsJiraClose('project', preview.id), true);
  assert.equal((await service.run('project', preview.id)).state, 'completed');
  for (const [i, repo] of [local, child].entries()) {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'renamed/main');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), heads[i]);
    assert.equal(git(repo, 'write-tree'), indexes[i]);
    assert.equal(git(repo, 'config', 'branch.renamed/main.remote'), 'origin');
    assert.equal(git(repo, 'config', 'branch.renamed/main.merge'), 'refs/heads/main');
    assert.equal(git(repo, 'config', 'branch.renamed/main.pushRemote'), 'origin');
    assert.equal(git(repo, 'config', 'branch.renamed/main.description'), 'Branch notes');
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/heads/main'));
    assert.throws(() => git(repo, 'config', 'branch.main.remote'));
  }
  assert.equal(git(remote, 'rev-parse', 'main'), remoteHead);
  assert.throws(() => git(remote, 'rev-parse', '--verify', 'refs/heads/renamed/main'));
});

test('renaming a non-current branch preserves checkout and branches held by another worktree block the whole project', async () => {
  const { local, child, directory, service } = await withChild();
  const worktree = path.join(directory, 'held');
  git(child, 'worktree', 'add', '-q', worktree, 'feature');
  const preview = await service.preview('project', { action: 'rename', branch: { name: 'feature' }, newBranch: 'renamed' });
  assert.equal(preview.ready, false);
  assert.match(preview.rows[1].blockers.join(' '), /another worktree/);
  await assert.rejects(service.run('project', preview.id));
  assert.throws(() => git(local, 'rev-parse', '--verify', 'refs/heads/renamed'));
  git(child, 'worktree', 'remove', worktree);
  assert.equal((await run(service, { action: 'rename', branch: { name: 'feature' }, newBranch: 'renamed' })).state, 'completed');
  for (const repo of [local, child]) {
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git(repo, 'rev-parse', 'renamed'), git(repo, 'rev-parse', 'HEAD'));
    assert.throws(() => git(repo, 'rev-parse', '--verify', 'refs/heads/feature'));
  }
});

test('changes to a source commit, source tracking, or destination after preview prevent all branch edits', async () => {
  const { local, child, service } = await withChild();
  const input: GitActionInput = { action: 'rename', branch: { name: 'feature' }, newBranch: 'renamed' };
  const configured = await service.preview('project', input);
  git(child, 'config', 'branch.feature.remote', 'origin');
  await assert.rejects(service.run('project', configured.id), /changed since/);
  const moved = await service.preview('project', input);
  await commit(child, 'new.txt', 'new\n');
  git(child, 'branch', '-f', 'feature', 'HEAD');
  await assert.rejects(service.run('project', moved.id), /changed since/);
  const exists = await service.preview('project', input);
  git(child, 'branch', 'renamed');
  await assert.rejects(service.run('project', exists.id), /changed since/);
  assert.throws(() => git(local, 'rev-parse', '--verify', 'refs/heads/renamed'));
  assert.ok(git(local, 'rev-parse', 'feature'));
});

test('branch edits retain partial results and reconcile interrupted writes after restart', async () => {
  for (const action of ['create', 'rename'] as const) {
    const { local, child, service, journal, project } = await withChild();
    const canonicalLocal = await realpath(local);
    const driver = service as unknown as { command(directory: string, args: string[]): Promise<string> };
    const command = driver.command.bind(service);
    driver.command = async (directory, args) => {
      const result = await command(directory, args);
      if (directory === canonicalLocal && args[0] === 'branch' && args.includes('edited')) git(child, 'branch', 'edited');
      return result;
    };
    const operation = await run(service, { action, branch: { name: 'feature' }, newBranch: 'edited' });
    assert.equal(operation.state, 'failed');
    assert.equal(operation.rows[0].state, 'done');
    assert.equal(operation.rows[1].state, 'failed');
    assert.match(operation.rows[1].message!, /already exists/);
    const persisted = JSON.parse(await readFile(journal, 'utf8'));
    persisted.operations.project.state = 'running';
    persisted.operations.project.rows[0].state = 'running';
    await writeFile(journal, JSON.stringify(persisted));
    const restarted = new GitWorkflowService(journal, () => project);
    await restarted.load();
    const reconciled = await restarted.getStatus('project');
    assert.equal(reconciled.operation?.rows[0].state, 'done');
    assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
  }
});

test('a source moved during rename stays uncertain and requires manual acknowledgement', async () => {
  const { local, service, journal, project } = await fixture();
  git(local, 'branch', 'feature');
  const source = git(local, 'rev-parse', 'feature');
  await commit(local, 'new.txt', 'new\n');
  const newer = git(local, 'rev-parse', 'HEAD');
  const driver = service as unknown as { command(directory: string, args: string[]): Promise<string> };
  const command = driver.command.bind(service);
  driver.command = async (directory, args) => {
    if (args[0] === 'branch' && args.includes('-m')) git(local, 'update-ref', 'refs/heads/feature', newer, source);
    return command(directory, args);
  };
  const operation = await run(service, { action: 'rename', branch: { name: 'feature' }, newBranch: 'renamed' });
  assert.equal(operation.state, 'failed');
  assert.equal(operation.rows[0].state, 'unknown');
  assert.equal(git(local, 'rev-parse', 'renamed'), newer);
  const restarted = new GitWorkflowService(journal, () => project);
  await restarted.load();
  assert.equal((await restarted.getStatus('project')).operation?.rows[0].state, 'unknown');
  assert.equal((await restarted.preview('project', { action: 'create', branch: { name: 'main' }, newBranch: 'blocked' })).ready, false);
  await restarted.acknowledge('project');
  assert.equal((await restarted.preview('project', { action: 'create', branch: { name: 'main' }, newBranch: 'blocked' })).ready, true);
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for streamed Git status')), 15000); })]); }
  finally { clearTimeout(timer); }
}

test('repository reads start independently and publish child branches while a parent is still loading', async () => {
  const { local, child, service } = await withChild();
  const canonicalLocal = await realpath(local);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const driver = service as unknown as { command(directory: string, args: string[]): Promise<string> };
  const command = driver.command.bind(service);
  driver.command = async (directory, args) => {
    if (directory === canonicalLocal && args.includes('status')) await held;
    return command(directory, args);
  };
  let received!: (snapshot: import('../shared/git-workflow').GitWorkflowSnapshot) => void;
  const childResult = new Promise<import('../shared/git-workflow').GitWorkflowSnapshot>(resolve => { received = resolve; });
  const unsubscribe = service.subscribe(change => {
    if (change.snapshot?.repositories.some(repo => repo.path === 'child')) received(change.snapshot);
  });
  const reading = service.getStatus('project');
  try {
    const partial = await bounded(childResult);
    assert.equal(partial.loading, true);
    assert.ok(partial.pendingRepositories?.includes('.'));
    assert.equal(partial.repositories.some(repo => repo.path === '.'), false);
    assert.ok(partial.branches.find(branch => branch.name === 'feature')?.repositories.some(repo => repo.path === 'child'));
    assert.equal(git(child, 'symbolic-ref', '--short', 'HEAD'), 'main');
  } finally { release(); unsubscribe(); }
  const final = await reading;
  assert.equal(final.loading, false);
  assert.deepEqual(final.repositories.map(repo => repo.path), ['.', 'child']);
});

test('project fetch runs repositories concurrently and publishes each completed result', async () => {
  const { local, service } = await withChild();
  const canonicalLocal = await realpath(local);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const driver = service as unknown as { command(directory: string, args: string[]): Promise<string> };
  const command = driver.command.bind(service);
  driver.command = async (directory, args) => {
    if (directory === canonicalLocal && args.includes('fetch')) await held;
    return command(directory, args);
  };
  let received!: () => void;
  const childFetched = new Promise<void>(resolve => { received = resolve; });
  const unsubscribe = service.subscribe(change => {
    if (change.snapshot?.loading && change.snapshot.repositories.some(repo => repo.path === 'child' && repo.lastFetched) && change.snapshot.pendingRepositories?.includes('.')) received();
  });
  const fetching = service.fetch('project');
  try { await bounded(childFetched); }
  finally { release(); unsubscribe(); }
  assert.equal((await fetching).repositories.every(repo => !!repo.lastFetched), true);
});

test('restart restores cached branches without Git reads, rejects relocated project caches, and preflight ignores cached refs', async () => {
  const { local, service, journal, project } = await fixture();
  git(local, 'branch', 'feature');
  const snapshot = await service.fetch('project');
  const restarted = new GitWorkflowService(journal, () => project);
  await restarted.load();
  const driver = restarted as unknown as { command(directory: string, args: string[]): Promise<string> };
  const command = driver.command.bind(restarted);
  driver.command = async () => { throw new Error('Display cache must not query Git'); };
  const cached = restarted.getCachedStatus('project')!;
  assert.equal(cached.cached, true);
  assert.equal(cached.loading, true);
  assert.deepEqual(cached.branches, JSON.parse(JSON.stringify(snapshot.branches)));
  assert.equal(cached.repositories[0].lastFetched, snapshot.repositories[0].lastFetched);
  const previousPath = project.repoPath;
  project.repoPath = `${local}-elsewhere`;
  assert.equal(restarted.getCachedStatus('project'), undefined);
  project.repoPath = previousPath;
  driver.command = command;
  git(local, 'branch', '-D', 'feature');
  const preview = await restarted.preview('project', { action: 'checkout', branch: { name: 'feature' } });
  assert.equal(preview.ready, false);
  assert.match(preview.rows[0].blockers.join(' '), /missing/);
  assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('remote branch rows have separate counts and creating from one resolves its remote commit even when local exists', async () => {
  const { local, peer, service } = await fixture();
  const remoteHead = await commit(peer, 'remote.txt', 'remote\n');
  git(peer, 'push', '-q');
  const snapshot = await service.fetch('project');
  const main = snapshot.branches.find(branch => branch.name === 'main')!.repositories[0];
  assert.equal(main.remoteStatus?.origin.incoming, 1);
  assert.equal(main.remoteStatus?.origin.outgoing, 0);
  const result = await run(service, { action: 'create', branch: { name: 'main', kind: 'remote', remote: 'origin' }, newBranch: 'remote-copy' });
  assert.equal(result.rows[0].source?.remote, 'origin');
  assert.equal(git(local, 'rev-parse', 'remote-copy'), remoteHead);
  assert.notEqual(git(local, 'rev-parse', 'HEAD'), remoteHead);
});

test('late parallel scans cannot replace a newer snapshot or its persistent cache', async () => {
  const { local, service } = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let captured!: () => void;
  const capturedStatus = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  const driver = service as unknown as { command(directory: string, args: string[]): Promise<string> };
  const command = driver.command.bind(service);
  driver.command = async (directory, args) => {
    const hold = args.includes('status') && first;
    if (hold) first = false;
    const result = await command(directory, args);
    if (hold) { captured(); await held; }
    return result;
  };
  const oldScan = service.getStatus('project');
  let newer!: Awaited<ReturnType<GitWorkflowService['getStatus']>>;
  try {
    await bounded(capturedStatus);
    const head = await commit(local, 'fresh.txt', 'fresh\n');
    newer = await service.getStatus('project');
    assert.equal(newer.repositories[0].head, head);
  } finally { release(); }
  const oldResult = await oldScan;
  assert.equal(oldResult.version, newer.version);
  assert.equal(oldResult.repositories[0].head, newer.repositories[0].head);
  assert.equal(service.getCachedStatus('project')!.repositories[0].head, newer.repositories[0].head);
  assert.ok((await service.acknowledge('project')).version! > newer.version!);
});
