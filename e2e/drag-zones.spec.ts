import { test, expect, chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');
const KEY = 'tz-extension-prefs';
const ORIGIN = 'https://tz-drag.local';

/**
 * Drag-to-reorder in the toolbar popup (converter and epoch tabs, saved to
 * settings) and in the card that opens on a selection (this card only).
 */
test.describe('draggable zones in the popup and the selection card', () => {
  let context: BrowserContext;
  let sw: Worker;
  let extId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) throw new Error('run `npm run build:chrome` first');
    context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--headless=new'],
    });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    extId = new URL(sw.url()).host;
    await expect
      .poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && typeof chrome.storage?.sync !== 'undefined'))
      .toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.beforeEach(async () => {
    await sw.evaluate(async () => chrome.storage.sync.clear());
  });

  async function setPrefs(patch: Record<string, unknown>): Promise<void> {
    await sw.evaluate(
      async ({ key, patch }) => {
        await chrome.storage.sync.remove(`${key}-v2-extras`);
        await chrome.storage.sync.set({ [key]: { homeZone: 'UTC', ...patch } });
      },
      { key: KEY, patch },
    );
  }

  async function savedTargets(): Promise<unknown> {
    return sw.evaluate(async (k) => {
      const got = await chrome.storage.sync.get([k, `${k}-v2-extras`]);
      const extras = (got[`${k}-v2-extras`] ?? {}) as Record<string, unknown>;
      const legacy = (got[k] ?? {}) as Record<string, unknown>;
      return extras.targetZones ?? legacy.targetZones;
    }, KEY);
  }

  /** Press on `handle`, move in steps to just above `target`'s handle, release. */
  async function dragAbove(page: Page, handle: Locator, target: Locator): Promise<void> {
    const from = (await handle.boundingBox())!;
    const to = (await target.boundingBox())!;
    const x = from.x + from.width / 2;
    const y0 = from.y + from.height / 2;
    const y1 = to.y + 2;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x, y0 + ((y1 - y0) * i) / 10);
    await page.mouse.up();
  }

  test('popup converter: dragging a result card reorders and saves the target zones', async () => {
    await setPrefs({ targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const list = popup.getByRole('list', { name: 'Converted times' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await dragAbove(
      popup,
      list.getByRole('button', { name: /^Drag to reorder .*Tokyo/ }),
      list.getByRole('button', { name: /^Drag to reorder UTC/ }),
    );
    await expect.poll(savedTargets).toEqual(['Asia/Tokyo', 'UTC', 'Europe/London']);
    await expect(list.getByRole('listitem').first()).toContainText('Tokyo');

    // Keyboard: pick up, move down, drop.
    const utc = list.getByRole('button', { name: /^Drag to reorder UTC/ });
    await utc.focus();
    await popup.keyboard.press('Space');
    await popup.keyboard.press('ArrowDown');
    await popup.keyboard.press('Space');
    await expect.poll(savedTargets).toEqual(['Asia/Tokyo', 'Europe/London', 'UTC']);

    // The remove button still works, with its collapse.
    await list.getByRole('button', { name: /^Remove .*London/ }).click();
    await expect.poll(savedTargets).toEqual(['Asia/Tokyo', 'UTC']);
    await popup.close();
  });

  test('popup epoch tab: result cards reorder by dragging too', async () => {
    await setPrefs({ targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
    await popup.getByRole('tab', { name: /Epoch/ }).click();
    await popup.getByLabel('Unix epoch timestamp').fill('1700000000');
    const list = popup.getByRole('list', { name: 'Times in your zones' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await dragAbove(
      popup,
      list.getByRole('button', { name: /^Drag to reorder .*London/ }),
      list.getByRole('button', { name: /^Drag to reorder UTC/ }),
    );
    await expect.poll(savedTargets).toEqual(['Europe/London', 'UTC', 'Asia/Tokyo']);
    await popup.close();
  });

  test('selection card: zones reorder by dragging and from the keyboard, keeping the card and the selection', async () => {
    await setPrefs({ targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] });
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body style="padding:40px;font-size:18px"><p id="t">Deploy at 2024-01-02T15:04:05Z today.</p></body></html>',
      }),
    );
    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(300);
    await page.locator('#t').click({ clickCount: 3 });
    const card = page.locator('#tz-extension-popover-host .tzx-card');
    await expect(card).toBeVisible({ timeout: 5000 });
    const list = card.getByRole('list', { name: 'Times in your zones' });
    const names = (): Promise<string[]> => list.locator('.tzx-zone').allInnerTexts();
    const before = await names();
    expect(before.length).toBeGreaterThanOrEqual(3);
    const last = before[before.length - 1] as string;
    expect(last).toMatch(/Tokyo/);

    await dragAbove(
      page,
      list.getByRole('button', { name: `Drag to reorder ${last}` }),
      list.getByRole('button', { name: `Drag to reorder ${before[0]}` }),
    );
    await expect.poll(names).toEqual([last, ...before.slice(0, -1)]);
    // Still one card, and the page selection is intact.
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(1);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('2024-01-02T15:04:05Z');
    expect(await page.evaluate(() => document.documentElement.classList.contains('tzx-sort-grabbing'))).toBe(false);
    // The card changes only itself: saved settings keep their order.
    expect(await savedTargets()).toEqual(['UTC', 'Europe/London', 'Asia/Tokyo']);

    // Keyboard: Escape on a held row cancels the move and keeps the card open.
    const handle = list.getByRole('button', { name: `Drag to reorder ${last}` });
    await handle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(card).toBeVisible();
    await expect.poll(names).toEqual([last, ...before.slice(0, -1)]);
    // Pick up, move down, drop.
    await handle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(names).toEqual([before[0], last, ...before.slice(1, -1)]);
    // Escape during a mouse drag puts the row back and keeps the card.
    const order = await names();
    const grip = list.getByRole('button', { name: `Drag to reorder ${order[0]}` });
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 120, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(card).toBeVisible();
    await expect.poll(names).toEqual(order);
    // A second Escape (nothing held) closes the card as before.
    await card.focus();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.close();
  });

  test('a pinned card reorders its zones and stays pinned', async () => {
    await setPrefs({ targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] });
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p id="t" style="margin:40px;font-size:18px">At 2024-01-02T15:04:05Z.</p>' }),
    );
    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(300);
    await page.locator('#t').click({ clickCount: 3 });
    await expect(page.locator('#tz-extension-popover-host .tzx-card')).toBeVisible({ timeout: 5000 });
    await page.locator('#tz-extension-popover-host').getByRole('button', { name: 'Pin to page' }).click();
    const pin = page.locator('.tz-extension-pin-host').first();
    await expect(pin.locator('.tzx-card.pinned')).toBeVisible();
    const list = pin.getByRole('list', { name: 'Times in your zones' });
    const names = (): Promise<string[]> => list.locator('.tzx-zone').allInnerTexts();
    const before = await names();
    const last = before[before.length - 1] as string;
    await dragAbove(
      page,
      list.getByRole('button', { name: `Drag to reorder ${last}` }),
      list.getByRole('button', { name: `Drag to reorder ${before[0]}` }),
    );
    await expect.poll(names).toEqual([last, ...before.slice(0, -1)]);
    await expect(page.locator('.tz-extension-pin-host')).toHaveCount(1);
    await expect(pin.locator('.tzx-card.pinned')).toBeVisible();
    await page.close();
  });

  test('a compact card shows no grips', async () => {
    await setPrefs({ targetZones: ['UTC', 'Asia/Tokyo'], cardSize: 'compact' });
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p id="t" style="margin:40px">At 2024-01-02T15:04:05Z.</p>' }),
    );
    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(300);
    await page.locator('#t').click({ clickCount: 3 });
    const card = page.locator('#tz-extension-popover-host .tzx-card.compact');
    await expect(card).toBeVisible({ timeout: 5000 });
    await expect(card.locator('[data-sort-handle]')).toHaveCount(0);
    await page.close();
  });
});
