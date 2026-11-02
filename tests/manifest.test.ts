import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// src/manifest.ts cannot be imported here: it calls crxjs's defineManifest,
// whose module graph fails under jsdom. The declarations are asserted on the
// source text instead, the way tests/site.test.ts checks the site sources.
const manifest = readFileSync(resolve(__dirname, '../src/manifest.ts'), 'utf8');
const firefoxPatch = readFileSync(resolve(__dirname, '../scripts/firefox-manifest.mjs'), 'utf8');

describe('site access', () => {
  /**
   * Select-to-convert starts when the user highlights text on the page, not
   * when they click the extension, so there is no click for the browser to
   * hang temporary access on. With activeTab alone the browser reports site
   * access as "on click" and a reader who only highlights a time converts
   * nothing. Standing host access is what makes it work from install.
   */
  it('asks for standing access to every site, matching the content script', () => {
    expect(manifest).toMatch(/host_permissions:\s*\['<all_urls>'\]/);
    expect(manifest).not.toMatch(/host_permissions:\s*\[\s*\]/);
    expect(manifest).toMatch(/matches:\s*\['<all_urls>'\]/);
  });

  /** activeTab + scripting stay as the fallback for a tab the content script never reached. */
  it('keeps the on-demand injection fallback', () => {
    expect(manifest).toMatch(/permissions:\s*\['storage', 'contextMenus', 'activeTab', 'scripting'\]/);
  });

  /** The Firefox rewrite only touches background, gecko and web_accessible_resources. */
  it('the Firefox manifest step leaves host permissions alone', () => {
    expect(firefoxPatch).not.toMatch(/host_permissions/);
  });
});

describe('the world clock is a website page, not an extension page', () => {
  const popup = readFileSync(resolve(__dirname, '../src/popup/App.tsx'), 'utf8');
  const vite = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
  const clockDir = resolve(__dirname, '../src/clock');

  it('the popup opens the site URL and no extension page', () => {
    expect(popup).toMatch(/SITE_CLOCK_URL/);
    expect(popup).not.toMatch(/src\/clock\/index\.html/);
  });

  it('nothing builds an extension clock page any more', () => {
    expect(existsSync(resolve(clockDir, 'index.html'))).toBe(false);
    expect(existsSync(resolve(clockDir, 'main.tsx'))).toBe(false);
    expect(vite).not.toMatch(/src\/clock\/index\.html/);
    // The shared app the website mounts is still here.
    expect(existsSync(resolve(clockDir, 'Clock.tsx'))).toBe(true);
    expect(existsSync(resolve(clockDir, 'mount.tsx'))).toBe(true);
  });
});
