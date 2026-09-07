import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateReleaseVersion } from './release-utils.mjs';

const repository = 'EthanBarlo/branchline';
const tag = process.env.GITHUB_REF_NAME;
const pkg = JSON.parse(readFileSync('package.json'));
validateReleaseVersion(tag, pkg, JSON.parse(readFileSync('package-lock.json')));
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const repo = JSON.parse(gh(['api', `repos/${repository}`]));
if (repo.private) throw new Error('Make EthanBarlo/branchline public before distributing unauthenticated updates.');
let release;
try { release = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`])); }
catch (error) { if (!String(error.stderr).includes('HTTP 404')) throw error; }
if (release && !release.draft) throw new Error(`${tag} is already published. Release a new version instead of replacing its artifacts.`);
if (process.argv.includes('--check')) {
  console.log(`${tag} can be built as a draft release.`);
} else {
  if (!release) gh(['release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--title', `Branchline ${pkg.version}`, '--generate-notes']);
  gh(['release', 'upload', tag, '--repo', repository, '--clobber',
    `release/Branchline-${pkg.version}-universal.dmg`, `release/Branchline-${pkg.version}-universal.zip`,
    `release/Branchline-${pkg.version}-universal.dmg.blockmap`, `release/Branchline-${pkg.version}-universal.zip.blockmap`, 'release/latest-mac.yml']);
  console.log(`Draft ready: https://github.com/${repository}/releases`);
}
