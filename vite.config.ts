import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

// Per-target output so Chrome and Firefox builds do not clobber each other.
const TARGET = (process.env.TARGET ?? 'chrome').toLowerCase();
const outDir = TARGET === 'firefox' ? 'dist-firefox' : 'dist';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      // crxjs handles entry points from the manifest
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
