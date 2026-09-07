import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { verifyUpdateMetadata } from './release-utils.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const directory = process.argv[2] || 'release';
const metadata = load(await readFile(join(directory, 'latest-mac.yml'), 'utf8'));
await verifyUpdateMetadata(metadata, directory, version);
const temporary = await mkdtemp(join(tmpdir(), 'branchline-release-'));
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8' });
try {
  command('ditto', ['-x', '-k', join(directory, `Branchline-${version}-universal.zip`), temporary]);
  const bundle = join(temporary, 'Branchline.app');
  const plist = join(bundle, 'Contents/Info.plist');
  if (command('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]).trim() !== version) throw new Error('Packaged application version does not match the release.');
  const arch = command('lipo', ['-archs', join(bundle, 'Contents/MacOS/Branchline')]);
  if (!arch.includes('arm64') || !arch.includes('x86_64')) throw new Error('The application must support Intel and Apple Silicon.');
  command('codesign', ['--verify', '--deep', '--strict', bundle]);
  command('xcrun', ['stapler', 'validate', bundle]);
  command('spctl', ['--assess', '--type', 'execute', '--verbose', bundle]);
  const feed = load(await readFile(join(bundle, 'Contents/Resources/app-update.yml'), 'utf8'));
  if (feed.provider !== 'github' || feed.owner !== 'EthanBarlo' || feed.repo !== 'branchline' || feed.private || feed.token) throw new Error('The packaged update feed must use public Branchline releases without credentials.');
  console.log('Universal update archive, signature, notarization, version, feed and checksums verified.');
} finally { await rm(temporary, { recursive: true, force: true }); }
