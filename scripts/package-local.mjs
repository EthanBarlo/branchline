import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(projectDir, 'release');
const stagingDir = join(releaseDir, '.local-package-staging');
const backupDir = join(releaseDir, '.local-package-previous');
const electronDist = join(projectDir, 'node_modules', 'electron', 'dist');
const builderCli = join(projectDir, 'node_modules', 'electron-builder', 'cli.js');
const platformFlag = { darwin: '--mac', win32: '--win', linux: '--linux' }[process.platform];
const archFlag = { x64: '--x64', arm64: '--arm64', ia32: '--ia32', arm: '--armv7l' }[process.arch];

if (!platformFlag || !archFlag) {
  throw new Error(`Unsupported local package target: ${process.platform}/${process.arch}`);
}
if (!existsSync(electronDist) || !existsSync(builderCli)) {
  throw new Error('Install dependencies before packaging (npm ci or npm install).');
}

const args = [
  builderCli, '--dir', platformFlag, archFlag, '--publish', 'never',
  `--config.directories.output=${stagingDir}`,
  `--config.electronDist=${electronDist}`,
];
if (process.platform === 'darwin') {
  args.push('--config.mac.identity=null', '--config.mac.notarize=false');
}

function runBuilder() {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: projectDir,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Local packaging failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function recoverPrevious() {
  if (!existsSync(backupDir)) return;
  const entries = await readdir(backupDir, { withFileTypes: true });
  if (entries.length > 1 || (entries.length === 1 && !entries[0].isDirectory())) {
    throw new Error(`Cannot recover unexpected local package backup: ${backupDir}`);
  }
  if (entries.length === 1) {
    const folder = entries[0].name;
    const currentDir = join(releaseDir, folder);
    if (!existsSync(currentDir)) await rename(join(backupDir, folder), currentDir);
  }
  await rm(backupDir, { recursive: true, force: true });
}

await recoverPrevious();
await rm(stagingDir, { recursive: true, force: true });
try {
  await runBuilder();
  const outputDirs = (await readdir(stagingDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  if (outputDirs.length !== 1) {
    throw new Error(`Expected one unpacked app in ${stagingDir}; found ${outputDirs.length}.`);
  }

  const folder = outputDirs[0].name;
  const currentDir = join(releaseDir, folder);
  const hadPrevious = existsSync(currentDir);
  if (hadPrevious) {
    await mkdir(backupDir);
    await rename(currentDir, join(backupDir, folder));
  }
  try {
    await rename(join(stagingDir, folder), currentDir);
  } catch (error) {
    if (hadPrevious) await rename(join(backupDir, folder), currentDir);
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
  console.log(`Local app: ${currentDir}`);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
