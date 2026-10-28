#!/usr/bin/env node
// Builds the marketing + live-demo site into docs/ for GitHub Pages.
// Bundles site/demo.ts (which imports the extension's real conversion libs)
// with esbuild, copies site/index.html, and writes a .nojekyll marker.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = resolve(root, 'site');
const outDir = resolve(root, 'docs');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(siteDir, 'demo.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outfile: resolve(outDir, 'demo.js'),
  logLevel: 'info',
});

copyFileSync(resolve(siteDir, 'index.html'), resolve(outDir, 'index.html'));
copyFileSync(resolve(siteDir, 'app.html'), resolve(outDir, 'app.html'));
// Copy static assets (screenshots, video) if present.
if (existsSync(resolve(siteDir, 'assets'))) {
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true });
}
// GitHub Pages: skip Jekyll so files/underscores are served verbatim.
writeFileSync(resolve(outDir, '.nojekyll'), '');

console.log('[site] built to docs/ (index.html + app.html + demo.js + assets)');
