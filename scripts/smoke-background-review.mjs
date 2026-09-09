import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';

// Exercise the real renderer, production main process and sandboxed preload.
// A temporary launcher delays one completed Git read, without product hooks or
// changing its result, so navigation cannot accidentally pass after a fast scan.
const fixture = await mkdtemp(join(tmpdir(), 'branchline-background-review-'));
const repo = join(fixture, 'checkout');
const dataDir = join(fixture, 'data');
const feedback = 'Keep this feedback while the agent updates the implementation.';
const contents = value => `export function calculate() {\n  const value = ${value};\n  return value;\n}\n`;
const errors = [];
let desktop;

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=Branchline Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function installGitDelay() {
  const cp = require('node:child_process');
  const original = cp.execFile;
  const state = globalThis.backgroundReviewSmoke = { commands: [], scans: 0, holdNextRaw: false, held: false, release: null };
  cp.execFile = function (command, args, options, callback) {
    if (command !== 'git') return original.call(this, command, args, options, callback);
    state.commands.push(args);
    if (args.some(arg => ['fetch', 'checkout', 'switch', 'reset', 'push', 'update-ref', 'update-index', 'read-tree'].includes(arg))) {
      throw new Error('Current reviews must leave local Git state untouched.');
    }
    const isScan = args.includes('diff') && args.includes('--raw');
    if (isScan) state.scans++;
    const hold = isScan && state.holdNextRaw;
    if (hold) state.holdNextRaw = false;
    return original.call(this, command, args, options, (...result) => {
      if (!hold) return callback(...result);
      state.held = true;
      state.release = () => {
        state.release = null;
        state.held = false;
        callback(...result);
      };
    });
  };
  globalThis.fetch = async () => { throw new Error('This local review test must not use a provider network.'); };
}

async function until(read, predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await read();
    if (predicate(result)) return result;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const counters = () => desktop.evaluate(() => ({ scans: globalThis.backgroundReviewSmoke.scans, held: globalThis.backgroundReviewSmoke.held }));
const currentReview = page => page.evaluate(async () => (await window.reviewAPI.getState()).reviews.find(review => review.kind === 'current'));

try {
  await mkdir(repo);
  git('init', '-b', 'main');
  for (const file of ['a-first.ts', 'z-next.ts']) await writeFile(join(repo, file), contents(0));
  git('add', '.'); git('commit', '-m', 'Initial files'); git('checkout', '-b', 'feature/agent-work');
  for (const file of ['a-first.ts', 'z-next.ts']) await writeFile(join(repo, file), contents(1));
  // Include both staged and unstaged changes: reading either must not refresh or
  // rewrite the user's index, branch, references, or working files.
  git('add', 'z-next.ts');
  const before = { head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain=v1'), index: await readFile(join(repo, '.git/index')) };
  const entry = join(fixture, 'main.cjs');
  await writeFile(entry, `(${installGitDelay.toString()})();\nrequire(${JSON.stringify(resolve('dist-electron/main.cjs'))});\n`);
  const env = { ...process.env, BRANCHLINE_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
  desktop = await electron.launch({ executablePath: process.env.BRANCHLINE_TEST_EXECUTABLE || electronExecutable, args: [entry], env, timeout: 30000 });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('button', { name: 'Add your first project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#project-repo-path').fill(repo);
  await dialog.locator('#project-name').fill('Background review');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByRole('combobox', { name: 'Current target branch', exact: true }).click();
  await page.getByRole('option', { name: 'main', exact: true }).click();
  await page.locator('.diff-file-name').filter({ hasText: 'a-first.ts' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);

  await desktop.evaluate(() => { globalThis.backgroundReviewSmoke.holdNextRaw = true; });
  await page.getByRole('button', { name: 'Refresh review', exact: true }).click();
  const blocked = await until(counters, state => state.held, 'a full comparison to pause in the background');
  // Leave an editor dirty and immediately click Mark reviewed. This covers the
  // real flush-before-navigation path, not just calling an approval API directly.
  await page.locator('[data-column-number="2"][data-line-type="change-addition"]').first().click();
  await page.getByRole('textbox', { name: 'Comment text', exact: true }).fill(feedback);
  const started = Date.now();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await page.locator('.diff-file-name').filter({ hasText: 'z-next.ts' }).waitFor();
  const advanceMs = Date.now() - started;
  const marked = await until(() => currentReview(page), review => Object.keys(review.approvals).length === 1 && review.comments.some(comment => comment.body === feedback), 'durable feedback and reviewed marker before the full comparison finishes');
  assert.deepEqual(await counters(), blocked, 'Comment saving and Mark reviewed must complete while the full scan is still blocked, without starting another comparison.');
  const fileId = Object.keys(marked.approvals)[0];
  const comment = marked.comments.find(comment => comment.body === feedback);
  assert.equal(comment.fileId, fileId, 'Feedback and its reviewed marker belong to the file that was displayed.');
  assert.equal(comment.fingerprint, marked.approvals[fileId], 'The reviewed marker describes the exact file version shown to the reviewer.');
  const durable = JSON.parse(await readFile(join(dataDir, 'reviews.json'), 'utf8')).reviews.find(review => review.id === marked.id);
  assert.equal(durable.approvals[fileId], marked.approvals[fileId]);
  assert.equal(durable.comments.find(saved => saved.id === comment.id)?.body, feedback, 'Navigation must wait for local feedback persistence.');

  await writeFile(join(repo, 'a-first.ts'), contents(2));
  await desktop.evaluate(() => globalThis.backgroundReviewSmoke.release());
  await page.waitForFunction(() => !document.querySelector('[aria-label="Refresh review"]')?.disabled);
  // A refresh that overlapped a mutation must not replace newer renderer state.
  // The regular visible Current poll then delivers the newest comparison.
  const changed = await until(() => currentReview(page), review => !review.approvals[fileId] && review.comments.some(saved => saved.id === comment.id), 'the agent edit to invalidate only the old reviewed marker');
  assert.equal(changed.comments.find(saved => saved.id === comment.id)?.body, feedback);
  assert.equal(changed.comments.find(saved => saved.id === comment.id)?.fingerprint, comment.fingerprint, 'The saved feedback retains its original review context.');
  await page.locator('[data-item-path="a-first.ts"]').getByText('↻ Changed', { exact: true }).waitFor();
  await page.locator('[data-item-path="a-first.ts"]').click();
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).waitFor();
  await page.locator('.changed-since-review').waitFor();
  await page.getByText(feedback, { exact: true }).first().waitFor();
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('show-ref'), before.refs);
  assert.equal(git('status', '--porcelain=v1'), before.status);
  assert.deepEqual(await readFile(join(repo, '.git/index')), before.index, 'Background review must leave staged changes and index bytes untouched.');
  assert.equal(await readFile(join(repo, 'a-first.ts'), 'utf8'), contents(2), 'The app must preserve the agent edit.');
  assert.equal(await readFile(join(repo, 'z-next.ts'), 'utf8'), contents(1));
  assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`);
  console.log(`Background Current desktop passed: pending feedback saves and Mark reviewed advances in ${advanceMs}ms while a full comparison is blocked; no additional scan, agent edits clear reviewed markers, feedback survives, and checkout/index remain untouched.`);
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/background-review-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(0, 10000));
    console.error('Renderer errors:', errors);
  }
  throw error;
} finally {
  if (desktop) await desktop.evaluate(() => globalThis.backgroundReviewSmoke.release?.()).catch(() => {});
  await desktop?.close().catch(() => {});
  await rm(fixture, { recursive: true, force: true });
}
