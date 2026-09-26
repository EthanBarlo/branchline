import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import stylex from '@stylexjs/unplugin';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [stylex.vite({
    useCSSLayers: true,
    treeshakeCompensation: true,
    unstable_moduleResolution: { type: 'commonJS', rootDir: process.cwd() },
  }), react()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 1800,
    rollupOptions: { input: {
      main: resolve('index.html'),
      jiraBrowser: resolve('electron/jira-browser.html'),
    } },
  },
});
