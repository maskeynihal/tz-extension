// What the website is made of, shared by the production build
// (scripts/build-site.mjs) and the dev server (scripts/dev-site.mjs), so the
// two can never disagree about which entries and pages exist.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const siteDir = resolve(root, 'site');
export const PAGES = ['index.html', 'app.html', 'clock.html', 'privacy.html', 'terms.html'];

/** esbuild options for the site's two script entries, written into `outdir`. */
export function siteBuildOptions(outdir, { dev = false } = {}) {
  return {
    entryPoints: {
      demo: resolve(siteDir, 'demo.ts'),
      clock: resolve(siteDir, 'clock.ts'),
    },
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    jsx: 'automatic',
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
    outdir,
    logLevel: 'info',
    absWorkingDir: root,
  };
}
