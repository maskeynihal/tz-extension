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
});
