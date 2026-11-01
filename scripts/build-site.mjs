#!/usr/bin/env node
// Builds the marketing site, the online converter and the world clock into
// docs/ for GitHub Pages.
//   - site/demo.ts          -> docs/demo.js   (converter on app.html)
//   - src/clock/main.tsx    -> docs/clock.js + docs/clock.css (clock.html; the
//                              same React app the extension opens)
// Both import the extension's real libs. Shared code (React, tz, storage) is
// split into docs/chunks/. HTML pages and assets are copied verbatim, and a
// .nojekyll marker is written. This does not type-check; `npm run build:site`
// runs tsc first.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = resolve(root, 'site');
const outDir = resolve(root, 'docs');
const PAGES = ['index.html', 'app.html', 'clock.html', 'privacy.html'];

mkdirSync(outDir, { recursive: true });
// Chunk names carry content hashes; drop the previous build's so they do not pile up.
rmSync(resolve(outDir, 'chunks'), { recursive: true, force: true });

await build({
  entryPoints: {
    demo: resolve(siteDir, 'demo.ts'),
    clock: resolve(root, 'src/clock/main.tsx'),
  },
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outdir: outDir,
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

for (const page of PAGES) copyFileSync(resolve(siteDir, page), resolve(outDir, page));
// Copy static assets (screenshots, video) if present.
if (existsSync(resolve(siteDir, 'assets'))) {
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true });
}
// GitHub Pages: skip Jekyll so files/underscores are served verbatim.
writeFileSync(resolve(outDir, '.nojekyll'), '');

console.log(`[site] built to docs/ (${PAGES.join(' + ')} + demo.js + clock.js/css + chunks + assets)`);
