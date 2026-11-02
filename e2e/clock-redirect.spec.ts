import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { SITE_CLOCK_URL } from '../src/lib/site';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');

/**
 * The popup's world clock button opens the clock on the website, and the
 * extension no longer carries a copy of that page.
 *
 * Its own context, because the tab is opened by the extension through
 * chrome.tabs.create: Playwright's routing does not intercept that first
 * navigation, so the only way to keep the real site off the network is to
 * make the host unresolvable for this browser. The clock itself is tested
 * against the built pages in e2e/site.spec.ts.
 */
test.describe('world clock button', () => {
  let context: BrowserContext;
  let extId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) throw new Error('run `npm run build:chrome` first');
    const host = new URL(SITE_CLOCK_URL).host;
    context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--headless=new',
        // Nothing may actually reach the site from this test.
        `--host-resolver-rules=MAP ${host} 127.0.0.1:1`,
      ],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    extId = new URL(sw.url()).host;
    await expect.poll(() => sw.evaluate(() => typeof chrome?.storage?.sync !== 'undefined')).toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('opens a tab off the extension, labelled with where it goes', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const button = popup.getByRole('button', { name: 'Open world clock' });
    // The tooltip says where it goes, so leaving the extension is no surprise.
    await expect(button).toHaveAttribute('title', /tz\.nihal\.com\.np/);
    const opened = context.waitForEvent('page');
    await button.click();
    const clock = await opened;
    // A real tab, not a navigation of the popup. Which URL it asks for is
    // asserted in tests/clock-redirect.test.tsx: the host is blackholed here,
    // so the tab lands on a network error page and page.url() is that error.
    expect(clock).not.toBe(popup);
    expect(popup.url()).toContain('/src/popup/index.html');
    await clock.close();
    await popup.close();
  });

  test('the extension serves no clock page of its own', async () => {
    const probe = await context.newPage();
    for (const path of ['src/clock/index.html', 'src/clock/main.tsx']) {
      const res = await probe.goto(`chrome-extension://${extId}/${path}`).catch(() => null);
      expect(res === null || res.status() >= 400, `${path} should not be served`).toBe(true);
    }
    await probe.close();
  });
});
