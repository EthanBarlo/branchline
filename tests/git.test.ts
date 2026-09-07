import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildSnapshot, inspectRepo } from '../electron/git';
import type { ReviewConfig } from '../shared/types';

const fixtures: string[] = [];
after(async () => { await Promise.all(fixtures.map(dir => rm(dir, { recursive: true, force: true }))); });
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  }).trimEnd();
}
async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'branchline-git-'));
  fixtures.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'shared.txt'), 'original\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
  return dir;
}
function config(repoPath: string, extra: Partial<ReviewConfig> = {}): ReviewConfig {
  return { id: 'review', name: 'Review', repoPath, baseBranch: 'main', featureBranch: 'feature', includeWorkingTree: true, createdAt: new Date().toISOString(), ...extra };
}
async function commitFile(dir: string, file: string, content: string | Buffer, message = 'update'): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
  git(dir, 'add', '--', file); git(dir, 'commit', '-qm', message);
}

test('uses merge base to exclude target-only commits and includes final staged/unstaged/new content', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await commitFile(dir, 'shared.txt', 'feature commit\n');
  git(dir, 'checkout', '-q', 'main');
  await commitFile(dir, 'target-only.txt', 'do not review\n');
  git(dir, 'checkout', '-q', 'feature');
  await writeFile(path.join(dir, 'shared.txt'), 'staged\n'); git(dir, 'add', 'shared.txt');
  await writeFile(path.join(dir, 'shared.txt'), 'final worktree\n');
  await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(dir, 'ignored.txt'), 'not visible\n');
  await writeFile(path.join(dir, 'new\tfile\nname.txt'), 'new file\n');
  const before = git(dir, 'status', '--porcelain=v1', '-z');
  const snapshot = await buildSnapshot(config(dir));
  assert.equal(snapshot.warnings.length, 0);
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), ['.gitignore', 'new\tfile\nname.txt', 'shared.txt'].sort());
  const changed = snapshot.files.find(file => file.path === 'shared.txt')!;
  assert.equal(changed.oldContent, 'original\n');
  assert.equal(changed.newContent, 'final worktree\n');
  assert.equal(changed.source, 'working-tree');
  assert.equal(snapshot.repos[0].workingTreeIncluded, true);
  assert.equal(git(dir, 'status', '--porcelain=v1', '-z'), before, 'review must not mutate index or worktree');
  const committed = await buildSnapshot(config(dir, { includeWorkingTree: false }));
  assert.deepEqual(committed.files.map(file => file.path), ['shared.txt']);
  assert.equal(committed.files[0].newContent, 'feature commit\n');
});

test('unrelated checked-out branch and detached HEAD never contribute working changes', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await commitFile(dir, 'shared.txt', 'feature\n');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(path.join(dir, 'shared.txt'), 'wrong branch work\n');
  await writeFile(path.join(dir, 'wrong.txt'), 'wrong\n');
  let snapshot = await buildSnapshot(config(dir));
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].newContent, 'feature\n');
  assert.equal(snapshot.repos[0].workingTreeIncluded, false);
  assert.match(snapshot.warnings[0], /working changes excluded/);
  git(dir, 'checkout', '--', 'shared.txt');
  git(dir, 'checkout', '-q', '--detach', 'feature');
  snapshot = await buildSnapshot(config(dir));
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.repos[0].workingTreeIncluded, false);
});

test('fingerprints depend on file content and modes, survive unrelated commits and committing working content', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await writeFile(path.join(dir, 'shared.txt'), 'changed\n');
  await writeFile(path.join(dir, 'new.txt'), 'new\n');
  const first = await buildSnapshot(config(dir));
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'commit reviewed work');
  const committed = await buildSnapshot(config(dir));
  for (const file of first.files) assert.equal(committed.files.find(other => other.id === file.id)?.fingerprint, file.fingerprint);
  await commitFile(dir, 'unrelated.txt', 'another file\n');
  const unrelated = await buildSnapshot(config(dir));
  assert.equal(unrelated.files.find(file => file.path === 'shared.txt')?.fingerprint, first.files.find(file => file.path === 'shared.txt')?.fingerprint);
  await writeFile(path.join(dir, 'shared.txt'), 'new change\n');
  const changed = await buildSnapshot(config(dir));
  assert.notEqual(changed.files.find(file => file.path === 'shared.txt')?.fingerprint, first.files.find(file => file.path === 'shared.txt')?.fingerprint);
});

test('preserves rename paths, binary files, deletions and symlinks without reading their target', async () => {
  const dir = await repo();
  await commitFile(dir, 'delete.txt', 'delete me\n');
  git(dir, 'checkout', '-qb', 'feature');
  await rename(path.join(dir, 'shared.txt'), path.join(dir, 'renamed\tfile.txt'));
  await rm(path.join(dir, 'delete.txt'));
  await writeFile(path.join(dir, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
  await symlink('/etc/passwd', path.join(dir, 'outside-link'));
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'rename delete binary symlink');
  const snapshot = await buildSnapshot(config(dir));
  const renamed = snapshot.files.find(file => file.path === 'renamed\tfile.txt')!;
  assert.equal(renamed.status, 'R');
  assert.equal(renamed.oldPath, 'shared.txt');
  assert.equal(renamed.oldContent, 'original\n');
  assert.equal(snapshot.files.find(file => file.path === 'delete.txt')?.status, 'D');
  assert.equal(snapshot.files.find(file => file.path === 'binary.dat')?.binary, true);
  assert.equal(snapshot.files.find(file => file.path === 'binary.dat')?.newContent, null);
  assert.equal(snapshot.files.find(file => file.path === 'outside-link')?.newContent, '/etc/passwd');
  assert.equal(snapshot.files.find(file => file.path === 'outside-link')?.newMode, '120000');
});

test('compares matching branches recursively even when parent submodule pointers did not change', async () => {
  const leaf = await repo();
  const child = await repo();
  git(child, 'submodule', 'add', '-q', leaf, 'nested');
  git(child, 'commit', '-qm', 'add nested module');
  const root = await repo();
  git(root, 'submodule', 'add', '-q', child, 'packages/child');
  git(root, 'commit', '-qm', 'add child module');
  git(root, 'submodule', 'update', '--init', '--recursive', '-q');
  const childCheckout = path.join(root, 'packages/child');
  const leafCheckout = path.join(childCheckout, 'nested');
  git(root, 'checkout', '-qb', 'feature');
  git(childCheckout, 'checkout', '-qb', 'feature');
  await commitFile(childCheckout, 'shared.txt', 'child feature\n');
  git(leafCheckout, 'checkout', '-qb', 'feature');
  await commitFile(leafCheckout, 'shared.txt', 'leaf feature\n');
  await writeFile(path.join(leafCheckout, 'new.txt'), 'leaf working\n');
  const snapshot = await buildSnapshot(config(root));
  assert.deepEqual(snapshot.files.map(file => file.id), ['packages/child/nested/new.txt', 'packages/child/nested/shared.txt', 'packages/child/shared.txt']);
  assert.equal(snapshot.files.find(file => file.id === 'packages/child/shared.txt')?.oldContent, 'original\n');
  assert.equal(snapshot.files.find(file => file.id === 'packages/child/nested/shared.txt')?.newContent, 'leaf feature\n');
  assert.equal(snapshot.files.find(file => file.id === 'packages/child/nested/new.txt')?.repoRelativePath, 'packages/child/nested');
  assert.equal(snapshot.repos.length, 3);
  assert.equal(snapshot.warnings.length, 0);
  assert.equal(git(root, 'diff', '--name-only', 'main', 'feature'), '');
});

test('surfaces missing submodule branch and uninitialized module without using unrelated HEAD', async () => {
  const child = await repo();
  const root = await repo();
  git(root, 'submodule', 'add', '-q', child, 'module'); git(root, 'commit', '-qm', 'module');
  git(root, 'checkout', '-qb', 'feature');
  let snapshot = await buildSnapshot(config(root));
  assert.equal(snapshot.files.length, 0);
  assert.match(snapshot.repos.find(repo => repo.relativePath === 'module')?.error ?? '', /feature.*not found/);
  git(root, 'submodule', 'deinit', '-f', '--', 'module');
  snapshot = await buildSnapshot(config(root));
  assert.match(snapshot.repos.find(repo => repo.relativePath === 'module')?.error ?? '', /not initialized/);
  assert.equal(snapshot.files.length, 0);
});

test('resolves remote-tracking fallback and reports missing root branches', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await commitFile(dir, 'shared.txt', 'remote feature\n');
  git(dir, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
  git(dir, 'checkout', '-q', 'main'); git(dir, 'branch', '-D', 'feature');
  const snapshot = await buildSnapshot(config(dir, { includeWorkingTree: false }));
  assert.equal(snapshot.files[0].newContent, 'remote feature\n');
  assert.equal(snapshot.warnings.length, 0);
  const inspection = await inspectRepo(dir);
  assert.ok(inspection.branches.includes('origin/feature'));
  assert.equal(inspection.currentBranch, 'main');
  const missing = await buildSnapshot(config(dir, { featureBranch: 'missing' }));
  assert.equal(missing.files.length, 0);
  assert.match(missing.repos[0].error ?? '', /missing.*not found/);
});

test('caps large text display while fingerprinting subsequent large file changes', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await writeFile(path.join(dir, 'large.txt'), 'a'.repeat(1024 * 1024 + 10));
  const first = await buildSnapshot(config(dir));
  assert.equal(first.files[0].tooLarge, true);
  assert.equal(first.files[0].newContent, null);
  await writeFile(path.join(dir, 'large.txt'), 'b'.repeat(1024 * 1024 + 10));
  const second = await buildSnapshot(config(dir));
  assert.notEqual(second.files[0].fingerprint, first.files[0].fingerprint);
});

test('reports unresolved working merge conflicts and permits committed comparison', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-qb', 'feature');
  await commitFile(dir, 'shared.txt', 'feature change\n');
  git(dir, 'checkout', '-q', 'main');
  await commitFile(dir, 'shared.txt', 'conflicting target\n');
  git(dir, 'checkout', '-q', 'feature');
  assert.throws(() => git(dir, 'merge', 'main'));
  const working = await buildSnapshot(config(dir));
  assert.equal(working.files.length, 0);
  assert.match(working.repos[0].error ?? '', /unresolved merge conflicts/);
  const committed = await buildSnapshot(config(dir, { includeWorkingTree: false }));
  assert.equal(committed.files[0].newContent, 'feature change\n');
  assert.equal(committed.repos[0].error, undefined);
});

test('reports multiple merge bases instead of choosing an arbitrary ancestor', async () => {
  const dir = await repo();
  const original = git(dir, 'rev-parse', 'HEAD');
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  const left = git(dir, 'commit-tree', tree, '-p', original, '-m', 'left');
  const right = git(dir, 'commit-tree', tree, '-p', original, '-m', 'right');
  const targetMerge = git(dir, 'commit-tree', tree, '-p', left, '-p', right, '-m', 'target merge');
  const featureMerge = git(dir, 'commit-tree', tree, '-p', right, '-p', left, '-m', 'feature merge');
  git(dir, 'update-ref', 'refs/heads/main', targetMerge);
  git(dir, 'update-ref', 'refs/heads/feature', featureMerge);
  git(dir, 'checkout', '-q', 'feature');
  const snapshot = await buildSnapshot(config(dir));
  assert.equal(snapshot.files.length, 0);
  assert.match(snapshot.repos[0].error ?? '', /Multiple merge bases/);
});
