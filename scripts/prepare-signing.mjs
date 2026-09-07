import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateReleaseVersion } from './release-utils.mjs';

validateReleaseVersion(process.env.GITHUB_REF_NAME, JSON.parse(readFileSync('package.json')), JSON.parse(readFileSync('package-lock.json')));
const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY_CONTENT', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error(`Configure these GitHub Actions secrets before releasing: ${missing.join(', ')}. See docs/releases.md.`);
if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('Run signing preparation in GitHub Actions.');
const path = join(process.env.RUNNER_TEMP, 'branchline-notarization.p8');
writeFileSync(path, process.env.APPLE_API_KEY_CONTENT, { mode: 0o600 });
appendFileSync(process.env.GITHUB_ENV, `APPLE_API_KEY=${path}\n`);
console.log('Release version and signing inputs are ready.');
