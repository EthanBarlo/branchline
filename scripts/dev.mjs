import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';

await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true,
});
const server = await createServer();
await server.listen();
server.printUrls();
const childEnv = { ...process.env, BRANCHLINE_DEV_URL: 'http://127.0.0.1:5173' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: childEnv,
});
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exit(code);
}
child.on('exit', code => close(code ?? 0));
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
