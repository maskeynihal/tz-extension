import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');

/**
 * Loads the built extension into a persistent Chromium context and drives the
 * popup page directly. Requires `npm run build` to have produced dist/ first.
 */
test.describe('tz-extension smoke', () => {
  let context: BrowserContext;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) {
      throw new Error('dist/manifest.json missing — run `npm run build` before e2e.');
    }
    context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--headless=new',
      ],
    });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('extension loads and exposes a service worker', async () => {
    // Give MV3 service worker a moment to register.
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    expect(sw.url()).toContain('service-worker');
    const extId = new URL(sw.url()).host;
    expect(extId.length).toBeGreaterThan(10);
  });

  test('popup renders the converter and produces output', async () => {
    const [sw] = context.serviceWorkers();
    const extId = new URL(sw!.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/src/popup/index.html`);

    await expect(page.getByRole('tab', { name: 'Converter' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Epoch' })).toBeVisible();

    // The converter defaults to "now" and must render at least one result card.
    await expect(page.locator('.tzx-result-big').first()).toBeVisible();

    // Switch to Epoch tab and convert a known timestamp.
    await page.getByRole('tab', { name: 'Epoch' }).click();
    await page.getByLabel('Unix epoch timestamp').fill('1700000000');
    await expect(page.getByText('2023-11-14T22:13:20.000Z')).toBeVisible();

    await page.close();
  });

  test('select-to-convert popover shows a pinnable card that persists', async () => {
    const [sw] = context.serviceWorkers();
    const extId = new URL(sw!.url()).host;
    const page = await context.newPage();

    // Serve a real page (content scripts do not run on about:blank). Two epoch
    // values stand in for a table of timestamps the user wants to compare.
    const html = `<!doctype html><html><body style="padding:40px;font-size:18px">
      <p id="a">1700000000</p>
      <p id="b" style="margin-top:600px">1793159889000</p>
    </body></html>`;
    await page.route('https://tz-test.local/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto('https://tz-test.local/');

    // Select the first epoch by triple-clicking its paragraph.
    await page.locator('#a').click({ clickCount: 3 });
    await page.mouse.up();

    // The transient popover host appears in the page.
    const transient = page.locator('#tz-extension-popover-host');
    await expect(transient).toBeVisible({ timeout: 5000 });

    // It reads the value as UTC and shows a converted row with a date.
    const card = transient.locator('.tzx-card');
    await expect(card.getByText(/1700000000/)).toBeVisible();
    await expect(card.locator('.tzx-date').first()).toBeVisible();

    // Pin it. The transient host is replaced by a pinned host.
    await card.getByLabel('Pin to page').click();
    const pins = page.locator('.tz-extension-pin-host');
    await expect(pins).toHaveCount(1);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);

    // Select and pin the second epoch — both pinned cards must coexist.
    await page.locator('#b').click({ clickCount: 3 });
    await page.mouse.up();
    await expect(page.locator('#tz-extension-popover-host .tzx-card')).toBeVisible({
      timeout: 5000,
    });
    await page.locator('#tz-extension-popover-host .tzx-card').getByLabel('Pin to page').click();
    await expect(pins).toHaveCount(2);

    // Closing one pinned card leaves the other.
    await pins.first().locator('.tzx-card').getByLabel('Close').click();
    await expect(pins).toHaveCount(1);

    await page.close();
  });
});
