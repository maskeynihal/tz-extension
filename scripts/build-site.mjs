#!/usr/bin/env node
// Builds the marketing site, the online converter and the world clock into
// docs/, which Cloudflare Workers serves as static assets (see wrangler.jsonc).
//   - site/demo.ts          -> docs/demo.js   (converter on app.html)
//   - site/clock.ts         -> docs/clock.js + docs/clock.css (clock.html; the
//                              same React app the extension opens, mounted via
//                              src/clock/mount.tsx)
// Both website entries call enableWebStorageBackend() first, so settings live in
// the site's localStorage. The extension's own entries never do.
// Both import the extension's real libs. Each entry is one self-contained
// classic script (IIFE, no ES modules, no shared chunks): browsers refuse
// module scripts on file:// pages, so with modules the converter and the clock
// stayed blank when docs/*.html was opened from disk. HTML pages and assets
// are copied verbatim. This does not type-check; `npm run build:site` runs
// tsc first.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = resolve(root, 'site');
const outDir = resolve(root, 'docs');
const PAGES = ['index.html', 'app.html', 'clock.html', 'privacy.html', 'terms.html'];

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    demo: resolve(siteDir, 'demo.ts'),
    clock: resolve(siteDir, 'clock.ts'),
  },
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outdir: outDir,
  logLevel: 'info',
  absWorkingDir: root,
});

// Earlier builds split shared code into docs/chunks/; nothing loads it now.
// Removed only after a successful build, so a failed one leaves docs/ intact.
rmSync(resolve(outDir, 'chunks'), { recursive: true, force: true });

for (const page of PAGES) copyFileSync(resolve(siteDir, page), resolve(outDir, page));
// Copy static assets (screenshots, video) if present.
if (existsSync(resolve(siteDir, 'assets'))) {
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true });
}

console.log(`[site] built to docs/ (${PAGES.join(' + ')} + demo.js + clock.js/css + assets)`);
