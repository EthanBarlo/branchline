import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PointerService, type PointerPrepareInput } from '../electron/pointer-service';

const fixtures: string[] = [];
const identity = { name: 'Pointer Test', email: 'pointers@example.com' };
const oldChild = '1'.repeat(40);
const mergedChild = '2'.repeat(40);
after(async () => { await Promise.all(fixtures.map(dir => rm(dir, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email },
  }).trimEnd();
}

function service(workspace: string, remote: string, beforePush?: () => Promise<void>): PointerService {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try { return new PointerService(workspace, { testTransport: { remoteFor: () => remote, beforePush } }); }
  finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
}

async function fixture(): Promise<{ root: string; local: string; remote: string; workspace: string; base: string; input: PointerPrepareInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchline-pointer-'));
  fixtures.push(root);
  const local = path.join(root, 'local');
  const remote = path.join(root, 'remote.git');
  const workspace = path.join(root, 'app-pointer-workspace');
  await mkdir(local);
  git(local, 'init', '--quiet', '-b', 'main');
  git(local, 'config', 'user.name', identity.name);
  git(local, 'config', 'user.email', identity.email);
  await writeFile(path.join(local, 'ordinary.txt'), 'unchanged source\n');
  await writeFile(path.join(local, '.gitmodules'), '[submodule "child"]\n\tpath = packages/child\n\turl = https://bitbucket.org/example/child.git\n');
  git(local, 'add', '.');
  git(local, 'update-index', '--add', '--cacheinfo', `160000,${oldChild},packages/child`);
  git(local, 'commit', '--quiet', '-m', 'parent with submodule');
  git(local, 'checkout', '--quiet', '-b', 'feature/TICKET-12');
  await writeFile(path.join(local, 'feature.txt'), 'reviewed feature\n');
  git(local, 'add', '.');
  // An absent gitlink is represented as a deletion by `git add .`; restore it.
  git(local, 'update-index', '--add', '--cacheinfo', `160000,${oldChild},packages/child`);
  git(local, 'commit', '--quiet', '-m', 'feature changes');
  const base = git(local, 'rev-parse', 'HEAD');
  git(root, 'clone', '--quiet', '--bare', local, remote);
  return { root, local, remote, workspace, base, input: {
    repository: { workspace: 'example', repoSlug: 'parent', relativePath: '.' },
    sourceBranch: 'feature/TICKET-12', expectedHead: base, updates: { 'packages/child': mergedChild },
    identity, credentials: { email: 'personal@example.com', token: 'fake-test-api-token' }, operationId: 'saved-merge-1',
  } };
}

test('reads Git identity including configuration includes without changing local state and reports invalid identity', async () => {
  const { root, local, workspace } = await fixture();
  const pointers = new PointerService(workspace);
  const before = await readFile(path.join(local, '.git', 'index'));
  assert.deepEqual(await pointers.preflight(local), identity);
  assert.deepEqual(await readFile(path.join(local, '.git', 'index')), before);
  git(local, 'config', '--unset', 'user.name');
  git(local, 'config', '--unset', 'user.email');
  const identityFile = path.join(root, 'identity.gitconfig');
  await writeFile(identityFile, `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`);
  git(local, 'config', 'include.path', identityFile);
  assert.deepEqual(await pointers.preflight(local), identity);
  git(local, 'config', '--unset', 'include.path');
  git(local, 'config', 'user.name', identity.name);
  git(local, 'config', 'user.email', 'invalid');
  await assert.rejects(pointers.preflight(local), /valid Git user.name and user.email/);
});

test('prepares and pushes one pointer-only direct-child commit, preserving local worktree, index and refs', async () => {
  const { local, remote, workspace, input, base } = await fixture();
  await writeFile(path.join(local, 'ordinary.txt'), 'staged user changes\n');
  git(local, 'add', 'ordinary.txt');
  await writeFile(path.join(local, 'ordinary.txt'), 'unstaged user changes\n');
  await writeFile(path.join(local, 'untracked.txt'), 'untracked user file\n');
  const before = {
    index: await readFile(path.join(local, '.git', 'index')),
    refs: git(local, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: await readFile(path.join(local, '.git', 'HEAD')),
    status: git(local, 'status', '--porcelain=v1', '-z'),
  };
  const pointers = service(workspace, remote);
  const prepared = await pointers.prepare(input);
  assert.equal(prepared.base, base);
  assert.notEqual(prepared.commit, base);
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), base, 'prepare does not push');
  await pointers.push({ ...input, commit: prepared.commit });
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), prepared.commit);
  assert.equal(git(remote, 'show', '-s', '--format=%P', prepared.commit), base);
  assert.equal(git(remote, 'diff-tree', '--no-commit-id', '--name-only', '-r', base, prepared.commit), 'packages/child');
  assert.equal(git(remote, 'ls-tree', prepared.commit, 'packages/child'), `160000 commit ${mergedChild}\tpackages/child`);
  assert.equal(git(remote, 'show', `${prepared.commit}:.gitmodules`), git(remote, 'show', `${base}:.gitmodules`));
  assert.deepEqual(await readFile(path.join(local, '.git', 'index')), before.index);
  assert.deepEqual(await readFile(path.join(local, '.git', 'HEAD')), before.head);
  assert.equal(git(local, 'for-each-ref', '--format=%(refname) %(objectname)'), before.refs);
  assert.equal(git(local, 'status', '--porcelain=v1', '-z'), before.status);
  assert.equal(await readFile(path.join(local, 'ordinary.txt'), 'utf8'), 'unstaged user changes\n');
});

test('resumes the same prepared commit across service restarts and reconciles repeated pushes', async () => {
  const { remote, workspace, input } = await fixture();
  const prepared = await service(workspace, remote).prepare(input);
  const resumed = service(workspace, remote);
  assert.deepEqual(await resumed.prepare(input), prepared);
  await resumed.push({ ...input, commit: prepared.commit });
  assert.deepEqual(await service(workspace, remote).prepare(input), prepared);
  await service(workspace, remote).push({ ...input, commit: prepared.commit });
  assert.equal(git(remote, 'rev-list', '--count', input.sourceBranch), '3');
  assert.equal(await resumed.verifyRemote({ ...input, expectedHead: prepared.commit }), true);
  assert.equal(await resumed.verifyRemote(input), false);
});

test('does not create a commit when selected pointers already match the merge results', async () => {
  const { remote, workspace, input, base } = await fixture();
  const pointers = service(workspace, remote);
  const noChange = { ...input, updates: { 'packages/child': oldChild } };
  const prepared = await pointers.prepare(noChange);
  assert.deepEqual(prepared, { commit: base, base });
  await pointers.push({ ...noChange, commit: prepared.commit });
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), base);
});

test('updates multiple existing gitlinks using selected merge results and preserves unusual literal paths', async () => {
  const { local, remote, workspace, input } = await fixture();
  const unusualPath = 'nested/child\twith a newline\n';
  const nestedMerged = '3'.repeat(40);
  git(local, 'update-index', '--add', '--cacheinfo', `160000,${oldChild},${unusualPath}`);
  git(local, 'commit', '--quiet', '-m', 'another nested gitlink');
  const base = git(local, 'rev-parse', 'HEAD');
  git(local, 'push', '--quiet', remote, `HEAD:refs/heads/${input.sourceBranch}`);
  const multiple = { ...input, expectedHead: base, updates: { ...input.updates, [unusualPath]: nestedMerged } };
  const pointers = service(workspace, remote);
  const prepared = await pointers.prepare(multiple);
  await pointers.push({ ...multiple, commit: prepared.commit });
  assert.equal(git(remote, 'ls-tree', '-z', prepared.commit, '--', `:(literal)${unusualPath}`), `160000 commit ${nestedMerged}\t${unusualPath}\0`);
  assert.deepEqual(new Set(git(remote, 'diff-tree', '--no-commit-id', '--name-only', '-z', '-r', base, prepared.commit).split('\0').filter(Boolean)), new Set(['packages/child', unusualPath]));
});

test('rejects non-gitlink, missing and noncanonical paths and invalid hashes', async () => {
  const { remote, workspace, input } = await fixture();
  const pointers = service(workspace, remote);
  for (const file of ['ordinary.txt', '.gitmodules', 'missing/module']) {
    await assert.rejects(pointers.prepare({ ...input, updates: { [file]: mergedChild } }), /not an existing submodule/);
  }
  for (const file of ['../child', '/child', 'packages//child', 'packages/./child', '.git/config', 'packages\\child']) {
    await assert.rejects(pointers.prepare({ ...input, updates: { [file]: mergedChild } }), /canonical repository-relative/);
  }
  for (const hash of ['abc', 'g'.repeat(40), '0'.repeat(40), `${mergedChild}; touch bad`]) {
    await assert.rejects(pointers.prepare({ ...input, updates: { 'packages/child': hash } }), /complete, nonzero/);
  }
});

test('rejects a source that changed before fetch, and a remote that changes after prepare', async () => {
  const { remote, workspace, input, base } = await fixture();
  const previous = git(remote, 'rev-parse', `${base}^`);
  const pointers = service(workspace, remote);
  await assert.rejects(pointers.prepare({ ...input, expectedHead: previous }), /source branch changed/);
  const prepared = await pointers.prepare(input);
  git(remote, 'update-ref', `refs/heads/${input.sourceBranch}`, previous);
  await assert.rejects(pointers.push({ ...input, commit: prepared.commit }), /source branch changed/);
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), previous);
});

test('explicit lease catches a remote rollback racing the final read without replacing it', async () => {
  const { remote, workspace, input, base } = await fixture();
  const previous = git(remote, 'rev-parse', `${base}^`);
  const pointers = service(workspace, remote, async () => { git(remote, 'update-ref', `refs/heads/${input.sourceBranch}`, previous); });
  const prepared = await pointers.prepare(input);
  await assert.rejects(pointers.push({ ...input, commit: prepared.commit }), /stale info|failed to push/);
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), previous);
});

test('only pushes the saved prepared commit and rejects unrelated content', async () => {
  const { remote, workspace, input, base } = await fixture();
  const pointers = service(workspace, remote);
  await pointers.prepare(input);
  await assert.rejects(pointers.push({ ...input, commit: base }), /Prepare and save/);
  assert.equal(git(remote, 'rev-parse', input.sourceBranch), base);
});

test('does not invoke configured local hooks or helpers, persist credentials, or leave temporary indexes', async () => {
  const { root, local, remote, workspace, input } = await fixture();
  const marker = path.join(root, 'hook-ran');
  await mkdir(path.join(root, 'dangerous-hooks'));
  await writeFile(path.join(root, 'dangerous-hooks', 'pre-push'), `#!/bin/sh\nprintf broken > '${marker}'\n`, { mode: 0o755 });
  git(local, 'config', 'core.hooksPath', path.join(root, 'dangerous-hooks'));
  git(local, 'config', 'credential.helper', `!printf broken > '${marker}'`);
  const pointers = service(workspace, remote);
  await pointers.preflight(local);
  const prepared = await pointers.prepare(input);
  await pointers.push({ ...input, commit: prepared.commit });
  await assert.rejects(readFile(marker), /ENOENT/);
  for (const repo of await readdir(workspace)) {
    const files = await readdir(path.join(workspace, repo));
    assert.ok(!files.some(file => file.startsWith('pointer-index-')));
    assert.ok(!(await readFile(path.join(workspace, repo, 'config'), 'utf8')).includes(input.credentials.token));
    assert.ok(!(await readFile(path.join(workspace, repo, 'config'), 'utf8')).includes('credential'));
  }
});

test('validates Bitbucket remotes and source refs and honors pre-aborted work', async () => {
  const { remote, workspace, input } = await fixture();
  const pointers = service(workspace, remote);
  for (const workspaceName of ['../escape', 'evil.org/path', 'user@evil', 'https:']) {
    await assert.rejects(pointers.prepare({ ...input, repository: { ...input.repository, workspace: workspaceName } }), /valid Bitbucket workspace/);
  }
  for (const sourceBranch of ['--upload-pack=bad', 'feature..old', 'feature:other']) {
    await assert.rejects(pointers.prepare({ ...input, sourceBranch }));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pointers.prepare({ ...input, signal: controller.signal }), /cancelled/);
});

test('transport override is rejected outside test mode', () => {
  const original = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try { assert.throws(() => new PointerService('/tmp/unused', { testTransport: { remoteFor: () => '/tmp/remote' } }), /only available in tests/); }
  finally { if (original !== undefined) process.env.NODE_ENV = original; }
});
