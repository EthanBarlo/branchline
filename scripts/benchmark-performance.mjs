// Run with node --import tsx scripts/benchmark-performance.mjs [baseline checkout].
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const directory = await mkdtemp(join(tmpdir(), 'branchline-benchmark-'));
const repo = join(directory, 'project');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=Benchmark', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const content = version => Array.from({ length: 200 }, (_, index) => `export const item${index} = ${index === 100 ? version : 0};`).join('\n') + '\n';
async function populate(cwd, version) { for (let index = 0; index < 40; index++) await writeFile(join(cwd, `file-${index}.ts`), content(version)); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', `Version ${version}`); }
const results = [];
try {
  await mkdir(repo); git(repo, 'init', '-q', '-b', 'main'); await populate(repo, 0);
  for (let index = 0; index < 3; index++) {
    const source = join(directory, `source-${index}`); await mkdir(source); git(source, 'init', '-q', '-b', 'main'); await populate(source, 0);
    git(repo, 'submodule', 'add', '-q', source, `module-${index}`);
  }
  git(repo, 'commit', '-qm', 'Submodules'); git(repo, 'switch', '-qc', 'feature'); await populate(repo, 1);
  for (let index = 0; index < 3; index++) { const module = join(repo, `module-${index}`); git(module, 'switch', '-qc', 'feature'); await populate(module, 1); }
  for (const [label, checkout] of [['baseline', process.argv[2]], ['current', resolve('.')]]) {
    if (!checkout) continue;
    const { buildSnapshot } = await import(pathToFileURL(join(checkout, 'electron/git/repository.ts')).href);
    const { GitWorkflowService } = await import(pathToFileURL(join(checkout, 'electron/git/workflow-service.ts')).href);
    const project = { id: 'benchmark', repoPath: repo, name: 'Benchmark', defaultBaseBranch: null, createdAt: '' };
    const service = new GitWorkflowService(join(directory, `${label}-journal.json`), () => project); await service.load();
    let commands = 0; const command = service.command.bind(service);
    service.command = (...args) => { commands++; return command(...args); };
    const scans = [], snapshots = [];
    for (let index = 0; index < 4; index++) {
      commands = 0;
      let started = performance.now(); const status = await service.getStatus(project.id); scans.push({ ms: Math.round(performance.now() - started), commands, repositories: status.repositories.length });
      started = performance.now(); const snapshot = await buildSnapshot({ id: 'review', repoPath: repo, baseBranch: 'main', featureBranch: 'feature', includeWorkingTree: false }); snapshots.push({ ms: Math.round(performance.now() - started), files: snapshot.files.length });
    }
    results.push({ label, scans, snapshots });
  }
  console.log(JSON.stringify({ fixture: { repositories: 4, files: 160, linesPerFile: 200 }, results }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
