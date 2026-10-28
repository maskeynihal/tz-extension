#!/usr/bin/env node
// Rewrites dist-firefox/manifest.json from the Chromium MV3 shape (emitted by crxjs)
// into the Firefox MV3 shape:
//   - background.service_worker  ->  background.scripts (Firefox has no SW background)
//   - adds browser_specific_settings.gecko (required add-on id + min version)
// Run after `TARGET=firefox vite build`. Idempotent.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'dist-firefox', 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`[firefox-manifest] not found: ${manifestPath} (run the firefox build first)`);
  process.exit(1);
}

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Convert the background to an event-page script list.
if (m.background && typeof m.background === 'object') {
  const sw = m.background.service_worker;
  if (sw) {
    m.background = { scripts: [sw], type: m.background.type ?? 'module' };
  }
}

// Firefox MV3 requires an explicit add-on id and a minimum version.
m.browser_specific_settings = {
  ...(m.browser_specific_settings ?? {}),
  gecko: {
    id: 'tz-converter@maskeynihal',
    strict_min_version: '115.0',
    ...(m.browser_specific_settings?.gecko ?? {}),
  },
};

// Strip Chrome-only keys Firefox warns about. `use_dynamic_url` in
// web_accessible_resources is a Chromium MV3 extension that Firefox does not
// recognize ("An unexpected property was found in the WebExtension manifest").
if (Array.isArray(m.web_accessible_resources)) {
  for (const entry of m.web_accessible_resources) {
    if (entry && typeof entry === 'object' && 'use_dynamic_url' in entry) {
      delete entry.use_dynamic_url;
    }
  }
}

writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log('[firefox-manifest] patched dist-firefox/manifest.json for Firefox MV3');
