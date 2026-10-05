import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'branchline-performance-'));
const repo = join(fixture, 'repo');
await mkdir(repo);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Performance Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, stdio: 'pipe' });
const largeFile = 'a-large.ts';
const lineCount = 18000;
const content = (version, count) => Array.from({ length: count }, (_, index) => `export const item${index} = ${version};`).join('\n') + '\n';
const paths = [largeFile, ...Array.from({ length: 45 }, (_, index) => `file-${String(index).padStart(2, '0')}.ts`)];
git('init', '-q', '-b', 'main');
for (const path of paths) await writeFile(join(repo, path), content(0, path === largeFile ? lineCount : 80));
git('add', '.'); git('commit', '-qm', 'Base'); git('switch', '-qc', 'feature/performance');
for (const path of paths) await writeFile(join(repo, path), content(1, path === largeFile ? lineCount : 80));
let desktop;
const errors = [];
try {
  const env = smokeEnv({ BRANCHLINE_DATA_DIR: join(fixture, 'data') });
  delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
  desktop = await electron.launch({ executablePath: electronExecutable, args: [resolve('.')], env });
  const page = await desktop.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('button', { name: 'Add your first project', exact: true }).waitFor();
  const project = await page.evaluate(async repoPath => {
    const project = await window.reviewAPI.createProject({ name: 'Performance fixture', repoPath });
    await window.reviewAPI.setCurrentTarget(project.id, 'main');
    localStorage.setItem('branchline.selectedProject', project.id);
    localStorage.setItem('branchline.fileFilter', 'all');
    return project;
  }, repo);
  await page.reload();
  await page.locator('.review-diff-accordion').first().waitFor();
  await page.locator('.review-code-diff [data-line]').first().waitFor();
  const initial = await page.evaluate(() => {
    const active = document.querySelector('.review-code-diff');
    return { files: document.querySelectorAll('.review-diff-accordion').length,
      mounted: document.querySelectorAll('diffs-container').length,
      rows: active.shadowRoot.querySelectorAll('[data-line]').length,
      height: document.querySelector('.review-diff-viewer').scrollHeight };
  });
  assert.equal(initial.files, paths.length);
  assert.ok(initial.mounted < 8, `Offscreen files parsed too eagerly: ${initial.mounted}`);
  assert.ok(initial.rows < 1000, `Large diff rendered too many rows: ${initial.rows}`);
  const header = page.getByRole('button', { name: `Collapse ${largeFile}`, exact: true });
  await header.click();
  await page.getByRole('button', { name: `Expand ${largeFile}`, exact: true }).waitFor();
  const collapsedHeight = await page.locator('.review-diff-viewer').evaluate(node => node.scrollHeight);
  assert.ok(collapsedHeight < initial.height / 2, 'Collapsing a large file must release its layout height.');
  await page.getByRole('button', { name: `Expand ${largeFile}`, exact: true }).click();
  await page.locator('.review-code-diff [data-line]').first().waitFor();
  // Deep navigation must expand/load its file without parsing every intervening body.
  await page.locator('.review-file-header button[title="file-44.ts"]').click();
  await page.locator('.diff-file-name').filter({ hasText: 'file-44.ts' }).waitFor();
  await page.locator('.review-code-diff [data-line]').first().waitFor();
  const activeHeader = page.locator('[data-active-diff] .review-file-header');
  assert.ok(await activeHeader.isVisible());
  await page.locator('.review-code-diff [data-line-type="change-addition"][data-column-number="1"]').first().click();
  await page.getByRole('textbox', { name: 'Comment text', exact: true }).fill('A draft on the last stacked file.');
  await page.getByRole('button', { name: 'Collapse file-44.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Expand file-44.ts', exact: true }).waitFor();
  const saved = await page.evaluate(id => window.reviewAPI.getState().then(state => state.reviews.find(review => review.id === `current:${id}`)), project.id);
  assert.ok(saved.comments.some(comment => comment.fileId === 'file-44.ts' && comment.body === 'A draft on the last stacked file.'));
  await page.getByRole('button', { name: 'Expand file-44.ts', exact: true }).click();
  await page.locator('[data-active-diff]').getByText('A draft on the last stacked file.', { exact: true }).waitFor();
  await page.waitForFunction(() => { const header = document.querySelector('[data-active-diff] .review-file-header'); const scroller = document.querySelector('.review-diff-viewer'); return Math.abs(header.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 5; });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/performance-stacked-diffs.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fixture: { files: paths.length, largeFileLines: lineCount }, initial, collapsedHeight, result: 'virtualized rows, lazy offscreen bodies, accordion collapse/expand, deep selection and durable file-bound draft passed' }, null, 2));
} catch (error) {
  const page = desktop?.windows()[0];
  if (page) {
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/performance-failure.png' }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(0, 8000));
  }
  console.error(errors); throw error;
} finally { await desktop?.close().catch(() => {}); await rm(fixture, { recursive: true, force: true }); }
