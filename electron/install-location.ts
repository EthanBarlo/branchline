import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

export async function validateInstallLocation(executable: string, writable = (path: string) => access(path, constants.W_OK)): Promise<void> {
  const bundle = executable.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  if (!bundle || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    throw new Error('Move Branchline to your Applications folder, open it there, and try again.');
  }
  try { await writable(bundle); await writable(dirname(bundle)); }
  catch { throw new Error('Branchline needs a writable installation location. Move it to your Applications folder and try again.'); }
}
