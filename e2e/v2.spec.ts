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
        // Write a clean single-item state (as a fresh install would read it):
        // drop the extras item so the patch is not taken for an old device's edit.
        const got = await chrome.storage.sync.get(key);
        await chrome.storage.sync.remove(`${key}-v2-extras`);
        await chrome.storage.sync.set({ [key]: { ...(got[key] ?? {}), homeZone: 'UTC', ...patch } });
      },
      { key: KEY, patch },
    );
  }
  async function getPrefs(): Promise<Record<string, unknown>> {
    // Settings as the extension reads them: the extras item (full zones and
    // the newer fields) over the legacy one.
    return sw.evaluate(async (k) => {
      const got = await chrome.storage.sync.get([k, `${k}-v2-extras`]);
      const legacy = (got[k] ?? {}) as Record<string, unknown>;
      const extras = (got[`${k}-v2-extras`] ?? {}) as Record<string, unknown>;
      const out = { ...legacy };
      for (const f of ['homeZone', 'targetZones', 'cardSize', 'lastCardSize', 'numericDateOrder']) {
        if (extras[f] !== undefined) out[f] = extras[f];
      }
      return out;
    }, KEY);
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

  /** Text selected anywhere: the page selection, or a selection inside a card's shadow root. */
  async function selectedText(page: Page): Promise<string> {
    return page.evaluate(() => {
      const host = document.getElementById('tz-extension-popover-host');
      const root = host?.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null | undefined;
      const inCard = root?.getSelection?.()?.toString() ?? '';
      return inCard || (window.getSelection()?.toString() ?? '');
    });
  }

  test('card text can be drag-selected and double-clicked, and buttons keep the page selection', async () => {
    await setPrefs({ targetZones: ['UTC'], hour12: false });
    const page = await openPage('<p id="t">Deploy at 2024-01-02T15:04:05Z sharp.</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const time = card(page).locator('.tzx-row .tzx-time').first();
    // "Tue 15:04:05" in UTC, whatever zone the first (local) row shows.
    const shown = (await time.innerText()).trim();
    expect(shown).toMatch(/\d{2}:\d{2}:05/);
    const box = (await time.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await selectedText(page)).toContain(shown.slice(-8));
    // Selecting inside the card does not close it or open another one.
    await page.waitForTimeout(400);
    await expect(card(page)).toBeVisible();

    await time.dblclick();
    expect((await selectedText(page)).trim().length).toBeGreaterThan(0);
    expect(shown).toContain((await selectedText(page)).trim());
    await page.close();
  });

  test('the new card takes keyboard focus without clearing the page selection', async () => {
    const page = await openPage('<p id="t">Standup at 1700000000 today.</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('tz-extension-popover-host');
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Standup at 1700000000');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      () => document.getElementById('tz-extension-popover-host')?.shadowRoot?.activeElement?.getAttribute('aria-label') ?? '',
    );
    expect(focused).toBe('Pin to page');
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Standup at 1700000000');
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Standup at 1700000000');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
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
    await expect(order).toContainText('3 Apr 2024');
    await order.getByRole('button', { name: /Mar 4, 2024/ }).click();
    await expect(card(page).locator('.tzx-date').first()).toHaveText('2024-03-04');
    await expect.poll(async () => (await getPrefs()).numericDateOrder).toBe('mdy');
    await page.close();
  });

  test('day/month labels follow the written date, and compact cards offer the choice too', async () => {
    await setPrefs({ numericDateOrder: 'dmy', targetZones: ['UTC'], hour12: false });
    const page = await openPage('<p id="a">Call 03/04/2024 22:00 PDT ok</p>');
    await page.locator('#a').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('.tzx-order-btn')).toHaveText(['✓3 Apr 2024', 'Mar 4, 2024']);
    await card(page).getByLabel('Make compact').click();
    const mini = card(page).locator('.tzx-order.mini .tzx-order-btn');
    await expect(mini).toHaveText(['✓3 Apr', 'Mar 4']);
    await mini.nth(1).click();
    await expect(mini).toHaveText(['3 Apr', '✓Mar 4']);
    await expect(mini.nth(1)).toHaveAttribute('aria-pressed', 'true');
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
    // Escape in the search clears it first, not the card.
    await search.fill('lon');
    await search.press('Escape');
    await expect(card(page)).toBeVisible();
    // With nothing left to clear, Escape closes the card.
    await expect(search).toHaveValue('');
    await search.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.close();
  });

  test('at 390 px the zone-search placeholder fits and the dock stays on top of cards', async () => {
    const page = await openPage(
      '<p id="a">1700000000</p><p id="b" style="margin-top:600px">2024-01-02T10:00:00Z</p><p id="c" style="margin-top:600px">1600000000</p>',
    );
    await page.setViewportSize({ width: 390, height: 700 });
    await page.locator('#a').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const fit = await page.evaluate(() => {
      const input = document.getElementById('tz-extension-popover-host')?.shadowRoot?.querySelector('input');
      if (!input) return null;
      const cs = getComputedStyle(input);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { text: ctx.measureText(input.placeholder).width, room };
    });
    expect(fit).not.toBeNull();
    expect(fit!.text).toBeLessThanOrEqual(fit!.room);
    // Rows never clip the offset.
    const clipped = await card(page)
      .locator('.tzx-row')
      .evaluateAll((rows) => rows.some((r) => r.scrollWidth > r.clientWidth + 1));
    expect(clipped).toBe(false);

    for (const id of ['#a', '#b', '#c']) {
      await page.mouse.click(5, 5);
      await page.locator(id).click({ clickCount: 3 });
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      await card(page).getByLabel('Pin to page').click();
    }
    const pins = page.locator('.tz-extension-pin-host');
    await expect(pins).toHaveCount(3);
    const dock = page.locator('#tz-extension-pin-dock');
    await dock.getByRole('button', { name: 'Unpin all' }).click();
    await expect(pins.locator('.tzx-card.floating')).toHaveCount(3);
    const db = (await dock.boundingBox())!;
    expect(db.x).toBeGreaterThanOrEqual(0);
    expect(db.x + db.width).toBeLessThanOrEqual(390);
    // The dock is what sits under its own centre, so no card covers it.
    const top = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.id ?? '',
      { x: db.x + db.width / 2, y: db.y + db.height / 2 },
    );
    expect(top).toBe('tz-extension-pin-dock');
    // Its buttons can be clicked: minimize all from the dock.
    await dock.getByRole('button', { name: 'Minimize all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(3);
    // Floating cards keep out of the dock's way.
    for (const p of await pins.all()) {
      const b = (await p.boundingBox())!;
      const overlap = b.x < db.x + db.width && b.x + b.width > db.x && b.y < db.y + db.height && b.y + b.height > db.y;
      expect(overlap).toBe(false);
    }
    await page.close();
  });

  test('Escape closes the card even when the page stops Escape on body', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full' });
    const page = await openPage(
      '<p id="t">Standup at 1700000000 today.</p>' +
        '<script>document.body.addEventListener("keydown", (e) => { if (e.key === "Escape") e.stopPropagation(); });</script>',
    );
    // From the card itself (it has focus after opening).
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('tz-extension-popover-host');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);

    // From the zone search: with text, the first Escape only clears it.
    await page.mouse.click(5, 5);
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const search = card(page).getByRole('combobox', { name: 'Add a timezone' });
    await search.fill('lon');
    await search.press('Escape');
    await expect(card(page)).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(search).toHaveAttribute('aria-expanded', 'false');
    // Empty and shut: Escape closes the card.
    await search.press('Escape');
    await expect(card(page)).toHaveCount(0);

    // An empty search box whose list is open: the first Escape shuts the list, the next closes the card.
    await page.mouse.click(5, 5);
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await card(page).getByRole('combobox', { name: 'Add a timezone' }).click();
    await expect(card(page).getByRole('combobox', { name: 'Add a timezone' })).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    await page.close();
  });

  test('at 390 px, "Unpin all" with 5 pins leaves every card header reachable, at the same width', async () => {
    await setPrefs({ targetZones: ['UTC', 'Asia/Tokyo'], cardSize: 'full' });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const page = await openPage(
      ids.map((id, i) => `<p id="${id}" style="margin-top:${i ? 420 : 0}px">${1700000000 + i * 1000}</p>`).join(''),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ids) {
      await page.mouse.click(5, 5);
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await page.locator(`#${id}`).click({ clickCount: 3 });
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      await card(page).getByLabel('Pin to page').click();
    }
    const pins = page.locator('.tz-extension-pin-host');
    await expect(pins).toHaveCount(5);
    const widths = async (): Promise<number[]> =>
      pins.evaluateAll((hosts) => hosts.map((h) => Math.round(h.getBoundingClientRect().width)));
    const pinnedWidths = await widths();
    await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Unpin all' }).click();
    await expect(pins.locator('.tzx-card.floating')).toHaveCount(5);
    expect(await widths()).toEqual(pinnedWidths);

    const report = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((host) => {
        const head = host.shadowRoot?.querySelector('.tzx-head')?.getBoundingClientRect();
        if (!head) return { ok: false, at: 'no header' };
        const x = head.left + 4;
        const y = head.top + 4;
        const r = host.getBoundingClientRect();
        return { ok: document.elementFromPoint(x, y) === host, at: `${Math.round(r.left)},${Math.round(r.top)}` };
      }),
    );
    expect(report.map((r) => r.ok), JSON.stringify(report)).toEqual([true, true, true, true, true]);
    expect(new Set(report.map((r) => r.at)).size).toBe(5);
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
