import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';
import { FOCUS_COMMAND, FOCUS_COMMAND_DESCRIPTION, FOCUS_SUGGESTED_KEY } from './background/commands';

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
  // The browser owns the key (rebindable in its shortcut settings); the
  // worker forwards it to the tab, so the page's own keys are never touched.
  commands: {
    [FOCUS_COMMAND]: {
      suggested_key: { ...FOCUS_SUGGESTED_KEY },
      description: FOCUS_COMMAND_DESCRIPTION,
    },
  },
  // storage: preferences. contextMenus: the right-click "Convert" item.
  // activeTab + scripting: when that item is clicked in a tab that has no
  // content script yet (opened before install/update, or a site whose access
  // the user narrowed), inject it into that one tab on demand.
  permissions: ['storage', 'contextMenus', 'activeTab', 'scripting'],
  // Standing access to every site, matching the content script above, so
  // select-to-convert works from the moment the extension is installed. With
  // activeTab alone the browser hands over a tab only when the user invokes
  // the extension, and reports site access as "on click"; a reader who just
  // highlights a time never invokes it, so nothing would convert.
  host_permissions: ['<all_urls>'],
});
