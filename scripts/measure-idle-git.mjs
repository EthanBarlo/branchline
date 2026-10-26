// Run with node scripts/measure-idle-git.mjs <repo> <target> [seconds]. Run `npm run build` first.
// Counts the Git processes the built app starts while the Current review sits open and idle.
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';
import electronExecutable from 'electron';
import { smokeEnv } from './smoke-env.mjs';

const [repoPath, target, seconds = '60'] = process.argv.slice(2);
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const fixture = await mkdtemp(join(tmpdir(), 'branchline-idle-git-'));
const log = join(fixture, 'git.log');
await writeFile(join(fixture, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
await chmod(join(fixture, 'git'), 0o755);
// Block Git network transports so the app's automatic fetch cannot update the repository's remote refs.
const env = smokeEnv({ BRANCHLINE_DATA_DIR: join(fixture, 'data'), GIT_ALLOW_PROTOCOL: 'file', PATH: `${fixture}:${process.env.PATH}` });
delete env.ELECTRON_RUN_AS_NODE; delete env.BRANCHLINE_DEV_URL;
const lines = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const subcommand = line => {
  const words = line.split(' ');
  for (let index = 0; index < words.length; index++) {
    if (words[index] === '-c' || words[index] === '-C') index++;
    else return words[index];
  }
};
const desktop = await electron.launch({ executablePath: electronExecutable, args: [resolve('.')], env });
try {
  const page = await desktop.firstWindow(); page.setDefaultTimeout(120000);
  await page.getByRole('button', { name: 'Add your first project', exact: true }).waitFor();
  await page.evaluate(async ({ repoPath, target }) => {
    const project = await window.reviewAPI.createProject({ name: 'Idle', repoPath });
    await window.reviewAPI.setCurrentTarget(project.id, target);
    localStorage.setItem('branchline.selectedProject', project.id);
  }, { repoPath, target });
  await page.reload();
  await page.locator('.review-diff-accordion').first().waitFor();
  await page.waitForTimeout(5000);
  const before = (await lines()).length;
  const cpuBefore = await desktop.evaluate(() => process.cpuUsage());
  await page.waitForTimeout(Number(seconds) * 1000);
  const cpuAfter = await desktop.evaluate(() => process.cpuUsage());
  const idle = (await lines()).slice(before);
  const bySubcommand = {};
  for (const line of idle) bySubcommand[subcommand(line)] = (bySubcommand[subcommand(line)] ?? 0) + 1;
  console.log(JSON.stringify({
    seconds: Number(seconds),
    gitProcesses: idle.length,
    snapshotBuilds: idle.filter(line => line.includes('ls-files --others --exclude-standard -z --directory')).length,
    statusScans: idle.filter(line => / status --porcelain/.test(` ${line}`)).length,
    mainProcessCpuMs: Math.round((cpuAfter.user + cpuAfter.system - cpuBefore.user - cpuBefore.system) / 1000),
    bySubcommand: Object.fromEntries(Object.entries(bySubcommand).sort((a, b) => b[1] - a[1])),
  }, null, 2));
} finally { await desktop.close().catch(() => {}); await rm(fixture, { recursive: true, force: true }); }
