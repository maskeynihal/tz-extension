#!/usr/bin/env node
// Builds the marketing site, the online converter and the world clock into
// docs/ for GitHub Pages.
//   - site/demo.ts          -> docs/demo.js   (converter on app.html)
//   - site/clock.ts         -> docs/clock.js + docs/clock.css (clock.html; the
//                              same React app the extension opens, mounted via
//                              src/clock/mount.tsx)
// Both website entries call enableWebStorageBackend() first, so settings live in
// the site's localStorage. The extension's own entries never do.
// Both import the extension's real libs. Shared code (React, tz, storage) is
// split into docs/chunks/. HTML pages and assets are copied verbatim, and a
// .nojekyll marker is written. This does not type-check; `npm run build:site`
// runs tsc first.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = resolve(root, 'site');
const outDir = resolve(root, 'docs');
const PAGES = ['index.html', 'app.html', 'clock.html', 'privacy.html'];

mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: {
    demo: resolve(siteDir, 'demo.ts'),
    clock: resolve(siteDir, 'clock.ts'),
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
  metafile: true,
  absWorkingDir: root,
});

// Chunk names carry content hashes; drop the previous build's so they do not
// pile up. Done only after a successful build, so a failed one leaves the last
// good docs/ intact.
const chunksDir = resolve(outDir, 'chunks');
const built = new Set(Object.keys(result.metafile.outputs).map((f) => relative(chunksDir, resolve(root, f))));
for (const f of existsSync(chunksDir) ? readdirSync(chunksDir) : []) {
  if (!built.has(f)) rmSync(resolve(chunksDir, f), { force: true });
}

for (const page of PAGES) copyFileSync(resolve(siteDir, page), resolve(outDir, page));
// Copy static assets (screenshots, video) if present.
if (existsSync(resolve(siteDir, 'assets'))) {
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true });
}
// GitHub Pages: skip Jekyll so files/underscores are served verbatim.
writeFileSync(resolve(outDir, '.nojekyll'), '');

console.log(`[site] built to docs/ (${PAGES.join(' + ')} + demo.js + clock.js/css + chunks + assets)`);
