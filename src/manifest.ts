import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

// Single source manifest in the Chromium MV3 shape (crxjs types are Chromium-focused).
// The Firefox build runs `vite build` with TARGET=firefox, then `scripts/firefox-manifest.mjs`
// rewrites dist-firefox/manifest.json into the Firefox MV3 shape (event-page background +
// browser_specific_settings). See package.json build:firefox.
export default defineManifest({
  manifest_version: 3,
  name: 'TZ Converter — Timezone Tools',
  version: pkg.version,
  description:
    'Convert times across timezones: select text to convert in place, a full converter, and an epoch converter.',
  icons: {
    16: 'public/icons/icon16.png',
    32: 'public/icons/icon32.png',
    48: 'public/icons/icon48.png',
    128: 'public/icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'TZ Converter',
    default_icon: {
      16: 'public/icons/icon16.png',
      32: 'public/icons/icon32.png',
    },
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage'],
  host_permissions: [],
});
