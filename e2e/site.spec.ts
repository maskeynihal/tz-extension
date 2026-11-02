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
        // Any failed load counts (a missing favicon once logged a 404 on every page).
        if (m.type() === 'error') errors.push(m.text());
      });
      // The web font is not needed here and must not slow the test down.
      await page.route('https://rsms.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      // A server answers /favicon.ico; file:// has none. Pages must name their icon.
      if (how === 'https') await page.route(`${ORIGIN}/favicon.ico`, (r) => r.fulfill({ status: 404, body: '' }));
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
    test('planning a time tags days from home’s real today', async ({ page }) => {
      const errors = await open(page, 'clock.html');
      const app = page.locator('#clock-root .tzc-app');
      const homeCard = app.locator('.tzc-card.is-home');
      await expect(homeCard.locator('.tzc-day')).toHaveText('Today');
      // +36h is always a later calendar day at home.
      await app.getByRole('button', { name: /36 hours/i }).click();
      await expect(homeCard.locator('.tzc-day')).not.toHaveText('Today');
      await expect(homeCard.locator('.tzc-day')).toHaveText(/Tomorrow|In 2 days/);
      await app.getByRole('button', { name: 'Back to now' }).click();
      await expect(homeCard.locator('.tzc-day')).toHaveText('Today');
      expect(errors).toEqual([]);
    });

    test('the picker plans any date and every card shows that one instant', async ({ page }) => {
      const errors = await open(page, 'clock.html');
      const app = page.locator('#clock-root .tzc-app');
      // 24-hour clock, so every card's time parses the same way below.
      await app.getByRole('button', { name: '24-hour clock' }).click();
      const homeCard = app.locator('.tzc-card.is-home');
      await expect(homeCard.locator('.tzc-day')).toHaveText('Today');

      await app.locator('[data-dp-trigger]').click();
      const pop = app.getByRole('dialog');
      await expect(pop).toBeVisible();
      // The 15th of next month: always out of the scrubber's +36 h reach.
      await pop.getByRole('button', { name: 'Next month' }).click();
      const fifteenth = pop.locator('button[data-day]').nth(14);
      const iso = await fifteenth.getAttribute('data-day');
      expect(iso).toMatch(/^\d{4}-\d{2}-15$/);
      await fifteenth.click();
      await pop.getByLabel('Hour').fill('9');
      await pop.getByLabel('Minute').fill('30');
      await pop.getByRole('button', { name: 'Apply' }).click();
      await expect(pop).toBeHidden();

      // Home shows the wall clock that was picked, tagged days out.
      await expect(homeCard.locator('.tzc-time')).toHaveText('09:30');
      await expect(homeCard.locator('.tzc-day')).toHaveText(/In \d+ days/);
      await expect(app.locator('.tzc-plan-chip')).toContainText(/\+\d+d/);
      await expect(app.locator('[data-dp-trigger]')).toContainText('09:30');
      // Nothing is "today" a month out, in any zone on the board.
      expect(await app.locator('.tzc-day').allInnerTexts()).not.toContain('Today');

      // Every card is the same instant: its own clock less its own UTC offset,
      // both read off the card, so this does not lean on the app's own maths.
      const stamps = await app.locator('.tzc-card').evaluateAll((cards) =>
        cards.map((c) => {
          const [h, mi] = (c.querySelector('.tzc-time')?.textContent ?? '').split(':').map(Number);
          const off = /UTC([+-])(\d{2}):(\d{2})/.exec(c.querySelector('.tzc-facts dd')?.textContent ?? '');
          const minutes = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : 0;
          return ((((h ?? 0) * 60 + (mi ?? 0) - minutes) % 1440) + 1440) % 1440;
        }),
      );
      expect(stamps.length).toBeGreaterThanOrEqual(3);
      expect(new Set(stamps).size, stamps.join(' ')).toBe(1);

      // Back to now releases every card.
      await app.getByRole('button', { name: 'Back to now' }).click();
      await expect(homeCard.locator('.tzc-day')).toHaveText('Today');
      await expect(app.locator('[data-dp-trigger]')).toHaveText('Pick date & time');
      expect(errors).toEqual([]);
    });

    test('the picker is fully operable from the keyboard', async ({ page }) => {
      const errors = await open(page, 'clock.html');
      const app = page.locator('#clock-root .tzc-app');
      await app.getByRole('button', { name: '24-hour clock' }).click();
      const trigger = app.locator('[data-dp-trigger]');
      const pop = app.getByRole('dialog');
      const focusedDay = (): Promise<string | null> =>
        page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
      const dayMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

      await trigger.press('Enter');
      await expect(pop).toBeVisible();
      // Opening puts focus on the selected day, which is today at home.
      const start = await focusedDay();
      expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      const moved = await focusedDay();
      expect(dayMs(moved!) - dayMs(start!)).toBe(8 * 86_400_000);

      await page.keyboard.press('PageDown');
      const nextMonth = await focusedDay();
      expect(nextMonth!.slice(0, 7)).not.toBe(moved!.slice(0, 7));
      await expect(page.locator('button[data-day]', { hasText: /^1$/ }).first()).toBeVisible();

      // Tab reaches the time fields, then Apply.
      await page.keyboard.press('Tab');
      await expect(pop.getByLabel('Hour')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(pop.getByLabel('Minute')).toBeFocused();
      await pop.getByRole('button', { name: 'Apply' }).press('Enter');
      await expect(pop).toBeHidden();
      await expect(app.locator('.tzc-card.is-home .tzc-day')).not.toHaveText('Today');
      await expect(trigger).toBeFocused();

      // Escape closes, returns to live and leaves focus on the trigger.
      await trigger.press('Enter');
      await expect(pop).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(pop).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(app.locator('.tzc-live-chip')).toBeVisible();
      await expect(app.locator('.tzc-card.is-home .tzc-day')).toHaveText('Today');
      expect(errors).toEqual([]);
    });

    for (const width of [1280, 390]) {
      test(`at ${width} px the header is the same on every page and links to both tools`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const spots: string[] = [];
        for (const name of ['index.html', 'app.html', 'clock.html', 'privacy.html', 'terms.html']) {
          const errors = await open(page, name);
          const nav = page.getByRole('navigation', { name: 'Site' });
          for (const label of ['Converter', 'World clock']) {
            const link = nav.getByRole('link', { name: label, exact: true });
            await expect(link).toBeVisible();
            const box = (await link.boundingBox())!;
            expect(box.height, `${name} ${label} stays one line`).toBeLessThan(30);
          }
          const cta = nav.locator('.site-cta');
          const header = (await page.locator('.site-nav').boundingBox())!;
          const btn = (await cta.boundingBox())!;
          expect(btn.y).toBeGreaterThanOrEqual(header.y);
          expect(btn.y + btn.height).toBeLessThanOrEqual(header.y + header.height);
          const brand = (await page.locator('.site-brand').boundingBox())!;
          spots.push(`${Math.round(brand.x)},${Math.round(brand.y)},${Math.round(header.height)}`);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(errors).toEqual([]);
          page.removeAllListeners('pageerror');
          page.removeAllListeners('console');
          await page.unrouteAll({ behavior: 'ignoreErrors' });
        }
        expect(new Set(spots).size, spots.join(' ')).toBe(1);
      });
    }
  });
}
