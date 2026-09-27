export async function validateInstallLocation(executable: string): Promise<void> {
  const bundle = executable.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  if (!bundle || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    throw new Error('Move Branchline to your Applications folder, open it there, and try again.');
  }
  // Squirrel checks both the bundle and its parent and requests native macOS
  // authorization when either is protected. A W_OK preflight suppresses that
  // prompt and incorrectly rejects legitimate administrator-owned installs.
}
