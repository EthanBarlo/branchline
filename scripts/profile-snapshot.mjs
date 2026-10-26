// Run with node --import tsx scripts/profile-snapshot.mjs <repo> <base> <feature> [--working-tree] [--runs=3].
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [repoPath, baseBranch, featureBranch] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (!featureBranch) {
  console.error('Usage: node --import tsx scripts/profile-snapshot.mjs <repo> <base> <feature> [--working-tree] [--runs=3]');
  process.exit(1);
}
const includeWorkingTree = process.argv.includes('--working-tree');
const runs = Number(process.argv.find(arg => arg.startsWith('--runs='))?.slice(7) ?? 3);

// Count Git subprocesses and file opens without changing the code under test.
const counts = {};
const execFile = childProcess.execFile;
childProcess.execFile = function (file, args, options, callback) {
  const started = performance.now(); counts.gitCalls++;
  return execFile.call(this, file, args, options, (...result) => { counts.gitSummedMs += performance.now() - started; callback(...result); });
};
const open = fsPromises.open;
fsPromises.open = (...args) => { counts.fileOpens++; return open(...args); };
syncBuiltinESMExports();
const { buildSnapshot } = await import(pathToFileURL(resolve('electron/git/repository.ts')).href);

for (let run = 1; run <= runs; run++) {
  Object.assign(counts, { gitCalls: 0, gitSummedMs: 0, fileOpens: 0 });
  const started = performance.now();
  const snapshot = await buildSnapshot({ id: 'profile', repoPath: resolve(repoPath), baseBranch, featureBranch, includeWorkingTree });
  console.log(JSON.stringify({
    run, ms: Math.round(performance.now() - started), files: snapshot.files.length,
    fileOpens: counts.fileOpens, gitCalls: counts.gitCalls, gitSummedMs: Math.round(counts.gitSummedMs), warnings: snapshot.warnings,
  }));
}
