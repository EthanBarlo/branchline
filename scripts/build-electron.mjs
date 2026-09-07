import { build } from 'esbuild';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'],
  outdir: 'dist-electron',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outExtension: { '.js': '.cjs' },
  external: ['electron', 'electron-updater', 'electron-log/main'],
  sourcemap: true,
});
