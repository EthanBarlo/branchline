import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export function validateReleaseVersion(tag, pkg, lock) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || '')) throw new Error('Release tags must be stable versions: vX.Y.Z.');
  if (tag !== `v${pkg.version}` || pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
    throw new Error('The release tag, package.json and package-lock.json versions must match.');
  }
}

export async function verifyUpdateMetadata(metadata, directory, version) {
  if (metadata?.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Invalid update metadata version or files.');
  const required = new Set([`Branchline-${version}-universal.zip`, `Branchline-${version}-universal.dmg`]);
  for (const file of metadata.files) {
    if (typeof file.url !== 'string' || basename(file.url) !== file.url || !required.delete(file.url)) throw new Error('Unexpected or duplicate update artifact.');
    const path = join(directory, file.url);
    const info = await stat(path);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (file.size !== info.size || file.sha512 !== hash.digest('base64')) throw new Error(`Invalid size or SHA-512 for ${file.url}.`);
  }
  if (required.size) throw new Error('The release requires both universal DMG and ZIP artifacts.');
}
