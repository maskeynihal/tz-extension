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
// stayed blank when docs/*.html was opened from disk. HTML pages are copied with the
// support buttons filtered by env flags (see site-config.mjs); assets verbatim. This does not type-check; `npm run build:site` runs
// tsc first.
import { build } from 'esbuild';
import { mkdirSync, cpSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, siteDir, PAGES, siteBuildOptions, applySupportFlags, supportFlags } from './site-config.mjs';

const outDir = resolve(root, 'docs');

mkdirSync(outDir, { recursive: true });

await build(siteBuildOptions(outDir));

// Earlier builds split shared code into docs/chunks/; nothing loads it now.
// Removed only after a successful build, so a failed one leaves docs/ intact.
rmSync(resolve(outDir, 'chunks'), { recursive: true, force: true });

for (const page of PAGES) {
  writeFileSync(resolve(outDir, page), applySupportFlags(readFileSync(resolve(siteDir, page), 'utf8')));
}
console.log('[site] support buttons:', supportFlags());
// Copy static assets (screenshots, video) if present.
if (existsSync(resolve(siteDir, 'assets'))) {
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true });
}

console.log(`[site] built to docs/ (${PAGES.join(' + ')} + demo.js + clock.js/css + assets)`);
