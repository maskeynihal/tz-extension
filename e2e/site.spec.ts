import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(__dirname, '../docs');
const ORIGIN = 'https://tz-site.local';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

/**
 * The built website (docs/), served over https and opened straight from disk.
 * Module scripts are blocked on file:// pages, which once left the converter
 * and the clock blank; both ways must show live times.
 */
for (const how of ['https', 'file'] as const) {
  test.describe(`website over ${how}`, () => {
    test.beforeAll(() => {
      if (!existsSync(resolve(DOCS, 'clock.js'))) throw new Error('run `npm run build:site` first');
    });

    async function open(page: Page, name: string): Promise<string[]> {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/rsms\.me|Failed to load resource/.test(m.text())) errors.push(m.text());
      });
      // The web font is not needed here and must not slow the test down.
      await page.route('https://rsms.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      if (how === 'https') {
        await page.route(`${ORIGIN}/**`, (route) => {
          const path = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
          const file = resolve(DOCS, path);
          if (!file.startsWith(DOCS) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
        });
        await page.goto(`${ORIGIN}/${name}`);
      } else {
        await page.goto(pathToFileURL(resolve(DOCS, name)).href);
      }
      return errors;
    }

    test('the converter shows live times in every zone and saves an added zone', async ({ page }) => {
      const errors = await open(page, 'app.html');
      const rows = page.getByRole('list', { name: 'Converted times' }).getByRole('listitem');
      await expect(page.getByText(/^Read ".+" as/)).toBeVisible();
      await expect(page.getByText('America/New_York').first()).toBeVisible();
      expect(await rows.count()).toBeGreaterThanOrEqual(3);

      // Typing a time converts it.
      const input = page.getByLabel('Time to convert');
      await input.fill('2024-01-02T15:04:05Z');
      await expect(page.getByText(/2024-01-02T15:04:05\.000Z/)).toBeVisible();

      // Adding a zone works and is still there after a reload (localStorage).
      await page.getByRole('combobox').fill('Tokyo');
      await page.getByRole('option', { name: /Tokyo/ }).first().click();
      await expect(page.getByText('Asia/Tokyo').first()).toBeVisible();
      await page.reload();
      await expect(page.getByText('Asia/Tokyo').first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('the world clock ticks, shows every zone, and saves an added zone', async ({ page }) => {
      const errors = await open(page, 'clock.html');
      const app = page.locator('#clock-root .tzc-app');
      await expect(app).toBeVisible();
      await expect(app.getByText('America/New_York')).toBeVisible();
      await expect(app.getByText('Europe/London')).toBeVisible();
      // The seconds move.
      const yours = app.locator('.tzc-local-time');
      const first = await yours.innerText();
      await expect.poll(() => yours.innerText(), { timeout: 4000 }).not.toBe(first);

      await app.getByRole('combobox', { name: 'Add a timezone' }).fill('Tokyo');
      await page.getByRole('option', { name: /Tokyo/ }).first().click();
      await expect(app.getByText('Asia/Tokyo')).toBeVisible();
      await page.reload();
      await expect(page.locator('#clock-root').getByText('Asia/Tokyo')).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}
