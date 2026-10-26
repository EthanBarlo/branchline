// Run with node scripts/time-current-review.mjs <repo> <target>. Times the Current review in the built app.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

const [repoPath, target] = process.argv.slice(2);
const data = await mkdtemp(join(tmpdir(), 'branchline-timing-'));
// Block Git network transports so the app's automatic fetch cannot update the repository's remote refs.
const env = smokeEnv({ BRANCHLINE_DATA_DIR: data, GIT_ALLOW_PROTOCOL: 'file' });
delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
const desktop = await electron.launch({ executablePath: electronExecutable, args: [resolve('.')], env });
const errors = [];
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Add your first project', exact: true }).waitFor();
  const project = await page.evaluate(async repoPath => {
    const project = await window.reviewAPI.createProject({ name: 'Timing', repoPath });
    localStorage.setItem('branchline.selectedProject', project.id);
    return project;
  }, repoPath);
  const coldBuild = await page.evaluate(async ({ id, target }) => {
    const started = performance.now();
    const result = await window.reviewAPI.setCurrentTarget(id, target);
    return { ms: Math.round(performance.now() - started), files: result.snapshot.files.length, warnings: result.snapshot.warnings };
  }, { id: project.id, target });
  const warmBuilds = [];
  for (let run = 0; run < 3; run++)
    warmBuilds.push(await page.evaluate(async id => {
      const started = performance.now();
      await window.reviewAPI.refreshReview(`current:${id}`);
      return Math.round(performance.now() - started);
    }, project.id));
  let started = performance.now();
  await page.reload();
  await page.locator('.review-diff-accordion').first().waitFor();
  const reopenMs = Math.round(performance.now() - started);
  const shown = await page.locator('.review-diff-accordion').count();
  console.log(JSON.stringify({ coldBuild, warmBuildsMs: warmBuilds, reopenToFirstFileMs: reopenMs, accordionsShown: shown, errors }, null, 2));
} finally { await desktop.close().catch(() => {}); await rm(data, { recursive: true, force: true }); }
