import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { execSync } from 'node:child_process';
import manifest from './src/manifest';
import pkg from './package.json';

// Per-target output so Chrome and Firefox builds do not clobber each other.
const TARGET = (process.env.TARGET ?? 'chrome').toLowerCase();
const outDir = TARGET === 'firefox' ? 'dist-firefox' : 'dist';

// Resolve the git commit the build was produced from. Falls back gracefully
// outside a git checkout (e.g. a source tarball). A trailing "-dirty" marks a
// build made with uncommitted changes.
function gitCommit(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    let dirty = '';
    try {
      const status = execSync('git status --porcelain', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (status.length > 0) dirty = '-dirty';
    } catch {
      /* ignore */
    }
    return sha ? `${sha}${dirty}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

const BUILD_COMMIT = process.env.BUILD_COMMIT ?? gitCommit();
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
