import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');
const KEY = 'tz-extension-prefs';
const ORIGIN = 'https://tz-v2.local';

/**
 * Real-browser checks for v2: copy-safe selection, locale formats with the
 * day/month picker, searchable zones in the card, the pin dock, card size,
 * tabbed settings with drag-to-reorder, and the world clock page.
 */
test.describe('v2 features', () => {
  let context: BrowserContext;
  let sw: Worker;
  let extId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) throw new Error('run `npm run build:chrome` first');
    context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--headless=new'],
      permissions: ['clipboard-read', 'clipboard-write'],
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
        const got = await chrome.storage.sync.get(key);
        await chrome.storage.sync.set({ [key]: { ...(got[key] ?? {}), homeZone: 'UTC', ...patch } });
      },
      { key: KEY, patch },
    );
  }
  async function getPrefs(): Promise<Record<string, unknown>> {
    return sw.evaluate(async (k) => (await chrome.storage.sync.get(k))[k] ?? {}, KEY);
  }

  async function openPage(body: string): Promise<Page> {
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body style="padding:40px;font-size:18px;min-height:3000px">${body}</body></html>`,
      }),
    );
    await page.goto(`${ORIGIN}/`);
    await page.waitForTimeout(300);
    return page;
  }

  const card = (page: Page) => page.locator('#tz-extension-popover-host .tzx-card');

  test('a long selection containing a time stays selected and copies in full', async () => {
    await setPrefs({ keepSelection: true });
    const page = await openPage(
      '<p id="t">Quarterly notes. The review is on 2024-01-02T15:04:05Z in room 4, followed by lunch and a walk.</p>',
    );
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected).toContain('Quarterly notes.');
    expect(selected).toContain('a walk.');
    await page.keyboard.press('ControlOrMeta+c');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('Quarterly notes.');
    expect(clip).toContain('2024-01-02T15:04:05Z');
    // Clicking a button in the card keeps the selection too.
    await card(page).getByLabel('Make compact').click();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('a walk.');
    await page.close();
  });

  test('a selection in a text field keeps focus and can be copied', async () => {
    const page = await openPage('<input id="i" style="width:500px" value="Deploy at 1700000000 sharp">');
    await page.locator('#i').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('i');
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Deploy at 1700000000 sharp');
    await page.close();
  });

  test('a European date converts and an ambiguous one offers the day/month choice', async () => {
    await setPrefs({ numericDateOrder: 'dmy', targetZones: ['UTC'], hour12: false });
    const page = await openPage('<p id="a">Termin 24.12.2024 um 18:30 MEZ</p><p id="b">Due 03/04/2024 10:00</p>');
    await page.locator('#a').click({ clickCount: 3 });
    await expect(card(page)).toContainText('format: Numeric date');
    await expect(card(page).locator('.tzx-row').filter({ hasText: 'UTC' }).first()).toContainText('17:30');
    await page.keyboard.press('Escape');

    await page.mouse.click(5, 5);
    await page.locator('#b').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const order = card(page).locator('.tzx-order');
    await expect(order).toContainText('3 Apr');
    await order.getByRole('button', { name: /4 Mar/ }).click();
    await expect(card(page).locator('.tzx-date').first()).toHaveText('2024-03-04');
    await expect.poll(async () => (await getPrefs()).numericDateOrder).toBe('mdy');
    await page.close();
  });

  test('the card adds zones from a grouped search: city, abbreviation and UTC offset', async () => {
    await setPrefs({ targetZones: ['UTC'] });
    const page = await openPage('<p id="t">1700000000</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const search = card(page).getByRole('combobox', { name: 'Add a timezone' });
    await search.fill('pdt');
    await expect(card(page).getByRole('listbox')).toContainText('Abbreviations');
    await search.press('Enter');
    await search.fill('utc+5:45');
    await search.press('Enter');
    await search.fill('tokyo');
    await search.press('Enter');
    const zones = card(page).locator('.tzx-zone');
    await expect(zones).toContainText(['PDT', 'UTC+05:45', 'Asia/Tokyo']);
    // Escape in the search closes the list, not the card.
    await search.fill('lon');
    await search.press('Escape');
    await expect(card(page)).toBeVisible();
    await page.close();
  });

  test('pin dock: minimize, expand, unpin, pin, close all and undo', async () => {
    const page = await openPage('<p id="a">1700000000</p><p id="b" style="margin-top:300px">2024-01-02T10:00:00Z</p>');
    for (const id of ['#a', '#b']) {
      await page.mouse.click(5, 5);
      await page.locator(id).click({ clickCount: 3 });
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      await card(page).getByLabel('Pin to page').click();
    }
    const pins = page.locator('.tz-extension-pin-host');
    await expect(pins).toHaveCount(2);
    const dock = page.locator('#tz-extension-pin-dock');
    await expect(dock.getByRole('toolbar')).toHaveAttribute('aria-label', 'Pinned cards: 2 pinned cards');

    await dock.getByRole('button', { name: 'Minimize all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(2);
    await dock.getByRole('button', { name: 'Expand all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(0);

    await page.evaluate(() => window.scrollTo(0, 1500));
    await dock.getByRole('button', { name: 'Unpin all' }).click();
    await expect(pins.locator('.tzx-card.floating')).toHaveCount(2);
    // Floating cards are on screen even after scrolling away.
    for (const b of await pins.all()) {
      const box = (await b.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeLessThan(page.viewportSize()!.height);
    }
    await dock.getByRole('button', { name: 'Pin all to page' }).click();
    await expect(pins.locator('.tzx-card.floating')).toHaveCount(0);

    await dock.getByRole('button', { name: 'Close all' }).click();
    await expect(pins).toHaveCount(0);
    await expect(dock).toContainText('Closed 2 cards');
    await dock.getByRole('button', { name: 'Undo' }).click();
    await expect(pins).toHaveCount(2);
    await page.close();
  });

  test('card size on open: compact, and "last used" follows the last toggle', async () => {
    await setPrefs({ cardSize: 'compact' });
    const page = await openPage('<p id="t">1700000000</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(page.locator('#tz-extension-popover-host .tzx-card.compact')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');

    await setPrefs({ cardSize: 'last', lastCardSize: 'full' });
    await page.waitForTimeout(200);
    await page.mouse.click(5, 5);
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page)).not.toHaveClass(/compact/);
    await card(page).getByLabel('Make compact').click();
    await expect.poll(async () => (await getPrefs()).lastCardSize).toBe('compact');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.mouse.click(5, 5);
    await page.locator('#t').click({ clickCount: 3 });
    await expect(page.locator('#tz-extension-popover-host .tzx-card.compact')).toBeVisible({ timeout: 5000 });
    await page.close();
  });

  test('settings: tabs jump to sections and target zones reorder by dragging', async () => {
    await setPrefs({ targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] });
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options/index.html`);
    const nav = opt.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('link', { name: 'Formats' }).click();
    await expect(opt.getByRole('heading', { name: 'Recognized formats' })).toBeInViewport();
    await expect(nav.getByRole('link', { name: 'Formats' })).toHaveAttribute('aria-current', 'true');
    await nav.getByRole('link', { name: 'Timezones' }).click();
    await expect(nav.getByRole('link', { name: 'Timezones' })).toHaveAttribute('aria-current', 'true');

    const list = opt.getByRole('list', { name: 'Target timezones' });
    const handle = list.getByRole('button', { name: 'Drag to reorder Asia/Tokyo' });
    const first = list.getByRole('button', { name: 'Drag to reorder UTC' });
    await handle.scrollIntoViewIfNeeded();
    const from = (await handle.boundingBox())!;
    const to = (await first.boundingBox())!;
    await opt.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await opt.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await opt.mouse.move(from.x + from.width / 2, from.y + ((to.y - from.y) * i) / 8 - 4);
    }
    await opt.mouse.up();
    await expect.poll(async () => (await getPrefs()).targetZones).toEqual(['Asia/Tokyo', 'UTC', 'Europe/London']);

    // Keyboard reorder.
    await list.getByRole('button', { name: 'Drag to reorder UTC' }).focus();
    await opt.keyboard.press('Alt+ArrowDown');
    await expect.poll(async () => (await getPrefs()).targetZones).toEqual(['Asia/Tokyo', 'Europe/London', 'UTC']);
    await opt.close();
  });

  test('world clock opens from the popup and shows every zone', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC+05:45', 'abbr:PDT'] });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup/index.html`);
    const opened = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open world clock' }).click();
    const clock = await opened;
    await clock.waitForLoadState();
    expect(clock.url()).toBe(`chrome-extension://${extId}/src/clock/index.html`);
    await expect(clock.getByRole('heading', { level: 1, name: 'World clock' })).toBeVisible();
    await expect(clock.locator('.tzc-card')).toHaveCount(3);
    await expect(clock.locator('.tzc-card[data-zone="UTC+05:45"]')).toContainText('+5h 45m');
    await expect(clock.locator('.tzc-card[data-zone="abbr:PDT"]')).toContainText('−7h');
    // Scrub two hours ahead and back.
    const slider = clock.getByLabel('Shift all clocks');
    await slider.focus();
    for (let i = 0; i < 8; i++) await clock.keyboard.press('ArrowRight');
    await expect(clock.getByText('Planning:')).toBeVisible();
    await clock.getByRole('button', { name: 'Back to now' }).click();
    await expect(clock.getByText('Planning:')).toHaveCount(0);
    const errors: string[] = [];
    clock.on('pageerror', (e) => errors.push(e.message));
    await clock.reload();
    await expect(clock.locator('.tzc-card')).toHaveCount(3);
    expect(errors).toEqual([]);
    await clock.close();
    await popup.close();
  });
});
