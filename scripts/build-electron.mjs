import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/jira-browser-preload.ts'],
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'electron-updater', 'electron-log/main'],
  sourcemap: true,
});
await rm('dist-electron/jira-browser.html', { force: true });
