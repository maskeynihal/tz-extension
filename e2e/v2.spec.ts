import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { shortcutLabel } from '../src/background/commands';

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

  /** Count every transient card added to the page from now on (a flicker or a duplicate adds one). */
  async function watchTransient(page: Page): Promise<() => Promise<number>> {
    await page.evaluate(() => {
      const w = window as unknown as { __tzxAdded: number };
      w.__tzxAdded = 0;
      new MutationObserver((list) => {
        for (const m of list) {
          for (const n of Array.from(m.addedNodes)) if ((n as Element).id === 'tz-extension-popover-host') w.__tzxAdded++;
        }
      }).observe(document.body, { childList: true });
    });
    return () => page.evaluate(() => (window as unknown as { __tzxAdded: number }).__tzxAdded);
  }

  test('clicking card buttons with the mouse never re-opens or duplicates the card, and a mouse pin leaves none behind', async () => {
    await setPrefs({ targetZones: ['UTC', 'Asia/Tokyo'], cardSize: 'full', keepSelection: true });
    const page = await openPage('<p id="t" style="margin-top:200px">Standup 1700000000 today</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const added = await watchTransient(page);

    await card(page).getByLabel('Make compact').click();
    await page.waitForTimeout(600);
    await expect(card(page)).toHaveClass(/compact/);
    await card(page).getByLabel('Expand card').click();
    await card(page).locator('button.tzx-del[aria-label*="Tokyo"]').click();
    await page.waitForTimeout(600);
    await expect(card(page)).toHaveCount(1);
    await expect(card(page).locator('button.tzx-del[aria-label*="Tokyo"]')).toHaveCount(0);
    expect(await added()).toBe(0);

    await card(page).getByLabel('Pin to page').click();
    await expect(page.locator('.tz-extension-pin-host')).toHaveCount(1);
    await page.waitForTimeout(600);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);
    expect(await added()).toBe(0);
    // The selection is kept (copy works), and buttons on the pin do not bring the card back either.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('1700000000');
    await page.locator('.tz-extension-pin-host .tzx-card').getByLabel('Make compact').click();
    await page.waitForTimeout(600);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);
    await page.close();
  });

  test('a selection with two dates steps between them, marks the shown one and pins it', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const page = await openPage('<p id="t">2024-03-22-2024-03-25</p>');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const src = card(page).locator('.tzx-src > span').first();
    const status = card(page).locator('[aria-live="polite"]');
    const marked = (): Promise<string> =>
      page.evaluate(() => {
        const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('tz-extension-match');
        return hl ? Array.from(hl).map(String).join('|') : '';
      });
    await expect(src).toHaveText('“2024-03-22”');
    await expect(status).toHaveText('Time 1 of 2');
    await expect(card(page).locator('.tzx-step')).toContainText('1 of 2');
    await expect.poll(marked).toBe('2024-03-22');

    await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect(src).toHaveText('“2024-03-25”');
    await expect(status).toHaveText('Time 2 of 2');
    await expect.poll(marked).toBe('2024-03-25');
    // From the keyboard too: Previous wraps around.
    await card(page).getByRole('button', { name: 'Previous time' }).focus();
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Time 1 of 2');
    await page.keyboard.press('Enter');
    await expect(status).toHaveText('Time 2 of 2');

    await card(page).getByLabel('Pin to page').click();
    const pin = page.locator('.tz-extension-pin-host .tzx-card');
    await expect(pin.locator('.tzx-src > span').first()).toHaveText('“2024-03-25”');
    // Round 6 (QA F12): the pin keeps the stepper, on the step it was pinned at.
    await expect(pin.locator('[aria-live="polite"]')).toHaveText('Time 2 of 2');
    await page.waitForTimeout(600);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);
    await page.close();
  });

  /** Run the "focus the card" command as the browser would: the worker forwards it to the tabs. */
  async function focusCommand(): Promise<void> {
    await sw.evaluate(async () => {
      const send = (globalThis as unknown as { tzxFocusCard: (tabId: number) => Promise<void> }).tzxFocusCard;
      for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined) await send(tab.id);
    });
  }

  test('the focus command moves focus from a keyboard selection in a textarea into the card and back', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full' });
    const links = Array.from({ length: 30 }, (_, i) => `<a href="#l${i}">link ${i}</a>`).join(' ');
    const page = await openPage(`<textarea id="ta" cols="60">Deploy at 1700000000 sharp</textarea><p>${links}</p>`);
    // The page's own key listeners see every key, card open or not.
    await page.evaluate(() => {
      (window as unknown as { keysSeen: string[] }).keysSeen = [];
      document.addEventListener('keydown', (e) => {
        if (e.altKey && e.code.startsWith('Key')) {
          (window as unknown as { keysSeen: string[] }).keysSeen.push(`${e.code}:${e.defaultPrevented}`);
        }
      });
    });
    await page.locator('#ta').focus();
    await page.evaluate(() => (document.getElementById('ta') as HTMLTextAreaElement).setSelectionRange(10, 19));
    // Extend the selection by one character with the keyboard: "1700000000".
    await page.keyboard.press('Shift+ArrowRight');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(100);
    const active = (): Promise<string> =>
      page.evaluate(() => {
        const host = document.getElementById('tz-extension-popover-host');
        if (document.activeElement === host) return `card:${host?.shadowRoot?.activeElement?.className ?? ''}`;
        return document.activeElement?.id ?? '';
      });
    // Opening did not take the focus.
    expect(await active()).toBe('ta');
    // The hint names the browser's binding for the command.
    const bound = await sw.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === 'focus-card')?.shortcut ?? '');
    const label = shortcutLabel(bound);
    if (label) {
      await expect(card(page)).toHaveAttribute('aria-description', `${label.display} to focus`);
      await expect(card(page)).toHaveAttribute('aria-keyshortcuts', label.aria);
    } else {
      await expect(card(page)).toHaveAttribute('aria-description', /shortcut settings/);
    }

    await focusCommand();
    await expect.poll(active).toMatch(/^card:tzx-card/);
    // One Tab reaches the card's first button.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.getElementById('tz-extension-popover-host')?.shadowRoot?.activeElement?.getAttribute('aria-label'),
      ),
    ).toBe('Pin to page');
    await focusCommand();
    await expect.poll(active).toBe('ta');
    expect(
      await page.evaluate(() => {
        const ta = document.getElementById('ta') as HTMLTextAreaElement;
        return [ta.value, ta.selectionStart, ta.selectionEnd];
      }),
    ).toEqual(['Deploy at 1700000000 sharp', 10, 20]);
    await expect(card(page)).toBeVisible();

    // Alt+Shift+T (Chrome's toolbar key) and Alt+Shift+K reach the page untouched while the card is open.
    await page.keyboard.press('Alt+Shift+T');
    await page.keyboard.press('Alt+Shift+K');
    expect(await page.evaluate(() => (window as unknown as { keysSeen: string[] }).keysSeen)).toEqual([
      'KeyT:false',
      'KeyK:false',
    ]);

    await focusCommand();
    await expect.poll(active).toMatch(/^card:/);
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await active()).toBe('ta');
    // With no card open the command does nothing.
    await focusCommand();
    expect(await active()).toBe('ta');
    await page.close();
  });

  const markedText = (page: Page): Promise<string> =>
    page.evaluate(() => {
      const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('tz-extension-match');
      return hl ? Array.from(hl).map(String).join('|') : '';
    });

  test('the stepper counts in reading order, opens on the best match, and marks each where it is', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const page = await openPage(
      '<p id="t">Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC</p>' +
        '<p id="w">See John 3:16. Call at 3:16 today, or at 10:00\n        UTC tomorrow</p>',
    );
    const status = card(page).locator('[aria-live="polite"]');
    await page.locator('#t').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(status).toHaveText('Time 3 of 3');
    await expect.poll(() => markedText(page)).toBe('2024-04-02 18:00 UTC');
    await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect(status).toHaveText('Time 1 of 3');
    await expect.poll(() => markedText(page)).toBe('09:00 UTC');
    await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect(status).toHaveText('Time 2 of 3');
    await expect.poll(() => markedText(page)).toBe('13:30 UTC');
    await page.keyboard.press('Escape');

    // "10:00 UTC" spans a collapsed line break; the refused "3:16" (a verse) is not marked.
    await page.locator('#w').click({ clickCount: 3 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const offsets = (): Promise<number[]> =>
      page.evaluate(() => {
        const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('tz-extension-match');
        const r = hl ? (Array.from(hl)[0] as Range | undefined) : undefined;
        return r ? [r.startOffset, r.endOffset] : [];
      });
    const text = await page.locator('#w').evaluate((el) => el.textContent ?? '');
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const m = await markedText(page);
      seen.add(m.replace(/\s+/g, ' '));
      const [start] = await offsets();
      if (m === '3:16') expect(start).toBe(text.indexOf('3:16', text.indexOf('Call')));
      await card(page).getByRole('button', { name: 'Next time' }).click();
    }
    expect([...seen].sort()).toEqual(['10:00 UTC', '3:16']);
    await page.close();
  });

  test('at 1280×700, stepping to a time below the screen scrolls it into view and keeps the card by it', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const lines = Array.from(
      { length: 30 },
      (_, i) => `<div style="line-height:32px">Item ${i} at 2024-06-${String(i + 1).padStart(2, '0')} 20:05 UTC</div>`,
    ).join('');
    const page = await openPage(`<section id="list">${lines}</section>`);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('list') as HTMLElement);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const status = card(page).locator('[aria-live="polite"]');
    await expect(status).toHaveText('Time 1 of 30');
    const box = (): Promise<{ top: number; bottom: number; card: { top: number; bottom: number } } | null> =>
      page.evaluate(() => {
        const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('tz-extension-match');
        const r = hl ? (Array.from(hl)[0] as Range | undefined) : undefined;
        const host = document.getElementById('tz-extension-popover-host');
        if (!r || !host) return null;
        const b = r.getBoundingClientRect();
        const c = host.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, card: { top: c.top, bottom: c.bottom } };
      });
    let scrolled = false;
    for (let i = 1; i < 30; i++) {
      await card(page).getByRole('button', { name: 'Next time' }).click();
      await expect(status).toHaveText(`Time ${i + 1} of 30`);
      await page.waitForTimeout(50);
      const b = await box();
      expect(b, `card and mark after step ${i + 1}`).not.toBeNull();
      const { top, bottom, card: c } = b as NonNullable<typeof b>;
      // The time is on screen, and the card does not cover it.
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(700);
      expect(c.bottom <= top || c.top >= bottom).toBe(true);
      if ((await page.evaluate(() => window.scrollY)) > 0) scrolled = true;
    }
    expect(scrolled).toBe(true);
    await expect.poll(() => markedText(page)).toBe('2024-06-30 20:05 UTC');
    // A scroll by the user still closes it.
    await page.mouse.move(1200, 20);
    await page.mouse.wheel(0, 300);
    await expect(card(page)).toHaveCount(0);
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

  /**
   * A page of `n` dates 138 px apart (as in the round-3 QA report), each
   * pinned from its own card, at the given viewport size.
   */
  async function pinMany(n: number, width: number, height: number): Promise<Page> {
    await setPrefs({ targetZones: ['UTC', 'America/New_York'], cardSize: 'full', hour12: false });
    const page = await openPage(
      Array.from(
        { length: n },
        (_, i) =>
          `<p id="p${i}" style="margin-top:${i ? 120 : 20}px">Item ${i} <span>2024-01-${String(i + 10).padStart(2, '0')} 12:00 UTC</span> x</p>`,
      ).join(''),
    );
    await page.setViewportSize({ width, height });
    for (let i = 0; i < n; i++) {
      await page.evaluate((i) => {
        window.getSelection()?.removeAllRanges();
        document.querySelector(`#p${i}`)?.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.selectNodeContents(document.querySelector(`#p${i} span`)!);
        window.getSelection()?.addRange(r);
      }, i);
      await page.dispatchEvent(`#p${i} span`, 'mouseup');
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      await card(page).getByLabel('Pin to page').click();
      await expect(page.locator('.tz-extension-pin-host')).toHaveCount(i + 1);
    }
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);
    return page;
  }

  /**
   * Pinned cards that overlap each other, and cards over their own date or
   * the date of a card pinned before them (round 6, QA F6), as "i/j" and
   * "i>date j". Round 7 (QA G1): pins never move for a new one, so an
   * earlier card may cover a later card's date.
   */
  async function coverReport(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const over = (a: DOMRect, b: DOMRect): boolean =>
        a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((h) => h.getBoundingClientRect());
      const dates = Array.from(document.querySelectorAll('p span')).map((s) => s.getBoundingClientRect());
      const out: string[] = [];
      cards.forEach((c, i) => {
        cards.forEach((d, j) => {
          if (i < j && over(c, d)) out.push(`${i}/${j}`);
        });
        dates.forEach((d, j) => {
          if (j <= i && over(c, d)) out.push(`${i}>date ${j}`);
        });
      });
      return out;
    });
  }

  /** For each card: how many of its header buttons are what sits under their centre, of how many, and its box. */
  async function headerReach(page: Page): Promise<Array<{ hit: number; of: number; box: number[] }>> {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((host) => {
        const root = host.shadowRoot!;
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.tzx-head button'));
        const hit = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return document.elementFromPoint(x, y) === host && root.elementFromPoint(x, y)?.closest('button') === b;
        }).length;
        const r = host.getBoundingClientRect();
        return { hit, of: buttons.length, box: [r.left, r.top, r.width, r.height].map(Math.round) };
      }),
    );
  }

  for (const [width, height] of [
    [390, 844],
    [1280, 800],
  ] as const) {
    test(`at ${width} px, "Unpin all" with 5 pins leaves every header button clickable, and "Pin all" puts each card back by its date`, async () => {
      const page = await pinMany(5, width, height);
      const pins = page.locator('.tz-extension-pin-host');
      const pinnedTops = await pins.evaluateAll((hosts) => hosts.map((h) => Math.round(h.getBoundingClientRect().top)));
      const sources = await page.evaluate(() =>
        Array.from(document.querySelectorAll('p span')).map((s) => Math.round(s.getBoundingClientRect().bottom)),
      );
      // Round 7 (QA G1, G4): pinned one by one, no card covers another, at
      // 390 px too (they stack down the page there).
      expect(await coverReport(page), `${pinnedTops}`).toEqual([]);
      await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Unpin all' }).click();
      await expect(pins.locator('.tzx-card.floating')).toHaveCount(5);
      const reach = await headerReach(page);
      for (const r of reach) {
        expect(r.of, JSON.stringify(reach)).toBe(3);
        expect(r.hit, JSON.stringify(reach)).toBe(r.of);
        // Wholly on screen, at the height it has once floating.
        expect(r.box[1]! + r.box[3]!, JSON.stringify(reach)).toBeLessThanOrEqual(height);
      }

      await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Pin all to page' }).click();
      await expect(pins.locator('.tzx-card.floating')).toHaveCount(0);
      const tops = await pins.evaluateAll((hosts) => hosts.map((h) => Math.round(h.getBoundingClientRect().top)));
      // Put back one by one, in reading order, by the same rule. (Not
      // always at the same spots: each pin was placed with its own date
      // scrolled to the middle of the screen, and the rule prefers spots
      // on screen.) The first goes right below its date.
      expect(await coverReport(page), `${tops} vs ${pinnedTops}`).toEqual([]);
      expect(Math.abs(tops[0]! - (sources[0]! + 8)), `${tops} vs ${sources}`).toBeLessThanOrEqual(1);
      const across = await pins.evaluateAll((hosts) => hosts.map((h) => Math.round(h.getBoundingClientRect().right)));
      for (const r of across) expect(r, `${across}`).toBeLessThanOrEqual(width);
      await page.close();
    });
  }

  test('at 1280 px, "Unpin all" with 15 pins leaves every header button clickable and every card on screen', async () => {
    test.setTimeout(90_000);
    const page = await pinMany(15, 1280, 800);
    // Every pinned card has the same width (pins 10 to 15 have two-digit
    // numbers). Round 6 (QA F6): they no longer all sit at their date's left
    // edge, stacked over each other; none covers another or another's date.
    const placed = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((h) => ({
        w: Math.round(h.getBoundingClientRect().width),
      })),
    );
    expect(new Set(placed.map((p) => p.w)).size, JSON.stringify(placed)).toBe(1);
    expect(await coverReport(page)).toEqual([]);
    await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Unpin all' }).click();
    await expect(page.locator('.tz-extension-pin-host .tzx-card.floating')).toHaveCount(15);
    const reach = await headerReach(page);
    for (const r of reach) {
      expect(r.hit, JSON.stringify(reach)).toBe(r.of);
      expect(r.box[1]! + r.box[3]!, JSON.stringify(reach)).toBeLessThanOrEqual(800);
    }
    await page.close();
  });

  test('"Minimize all" then "Expand all" gives every card back its width', async () => {
    const page = await pinMany(3, 1280, 800);
    const pins = page.locator('.tz-extension-pin-host');
    const widths = (): Promise<number[]> =>
      pins.evaluateAll((hosts) => hosts.map((h) => Math.round(h.getBoundingClientRect().width)));
    const dock = page.locator('#tz-extension-pin-dock');
    const before = await widths();
    await dock.getByRole('button', { name: 'Minimize all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(3);
    await dock.getByRole('button', { name: 'Expand all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(0);
    expect(await widths()).toEqual(before);
    // Floating, and one card on its own.
    await dock.getByRole('button', { name: 'Unpin all' }).click();
    await expect(pins.locator('.tzx-card.floating')).toHaveCount(3);
    await dock.getByRole('button', { name: 'Minimize all' }).click();
    await dock.getByRole('button', { name: 'Expand all' }).click();
    await expect(pins.locator('.tzx-card.compact')).toHaveCount(0);
    expect(await widths()).toEqual(before);
    const first = pins.first().locator('.tzx-card');
    await first.getByLabel('Make compact').click();
    await first.getByLabel('Expand card').click();
    expect(await widths()).toEqual(before);
    await page.close();
  });

  test('closing a card with Escape gives focus back to the page control that had it', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full' });
    const page = await openPage('<p id="t">Standup at 1700000000 today.</p><button id="f">Notes</button>');
    const open = async (): Promise<void> => {
      await page.locator('#f').focus();
      await page.evaluate(() => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById('t')!);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
      });
      await page.dispatchEvent('#t', 'mouseup');
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      // The button keeps focus; the user tabs from it into the card.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('f');
    };
    const active = (): Promise<string> => page.evaluate(() => document.activeElement?.id ?? '');

    // From a card button.
    await open();
    await page.keyboard.press('Tab');
    await expect.poll(active).toBe('tz-extension-popover-host');
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await active()).toBe('f');

    // From the card's zone search.
    await page.mouse.click(5, 5);
    await open();
    const search = card(page).getByRole('combobox', { name: 'Add a timezone' });
    await search.focus();
    // Focus opens its list; the first Escape shuts it, the next closes the card.
    if ((await search.getAttribute('aria-expanded')) === 'true') {
      await page.keyboard.press('Escape');
      await expect(search).toHaveAttribute('aria-expanded', 'false');
    }
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await active()).toBe('f');

    // A card that took focus from no one leaves it on the body, without scrolling.
    await page.mouse.click(5, 5);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('#t').click({ clickCount: 3 });
    await expect.poll(active).toBe('tz-extension-popover-host');
    const y = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Escape');
    await expect(card(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
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

  // --- Round 6 ---------------------------------------------------------------

  /** The text of a highlight (live mark by default), joined. */
  const highlightText = (page: Page, name = 'tz-extension-match'): Promise<string> =>
    page.evaluate((n) => {
      const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(n);
      return hl ? Array.from(hl).map(String).join('|') : '';
    }, name);

  /** Viewport box of a highlight's first range. */
  const highlightBox = (page: Page, name = 'tz-extension-match'): Promise<{ top: number; bottom: number; left: number; right: number } | null> =>
    page.evaluate((n) => {
      const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(n);
      const r = hl ? (Array.from(hl)[0] as Range | undefined) : undefined;
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    }, name);

  /** Select an element's contents and end it as a mouse drag would, at (x, y). */
  async function selectAll(page: Page, id: string, at?: { x: number; y: number }): Promise<void> {
    await page.evaluate(
      ({ id, at }) => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById(id) as HTMLElement);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: at?.x ?? 0, clientY: at?.y ?? 0 }));
      },
      { id, at },
    );
  }

  test('round 6: on text-transform pages the marks and the pin mark the time, not the paragraph', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const page = await openPage(
      '<p id="up" style="text-transform:uppercase">meet 10:00 utc then 3pm est, deploy 2024-04-02 18:00 utc</p>' +
        '<p id="cap" style="text-transform:capitalize">call at 10:00 utc today</p>',
    );
    expect(await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('up') as HTMLElement);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      return s?.toString();
    })).toBe('MEET 10:00 UTC THEN 3PM EST, DEPLOY 2024-04-02 18:00 UTC');
    await selectAll(page, 'up');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const status = card(page).locator('[aria-live="polite"]');
    await expect(status).toHaveText('Time 3 of 3');
    await expect.poll(() => highlightText(page)).toBe('2024-04-02 18:00 utc');
    await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect.poll(() => highlightText(page)).toBe('10:00 utc');
    await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect.poll(() => highlightText(page)).toBe('3pm est');
    await card(page).getByRole('button', { name: 'Pin to page' }).click();
    await expect(page.locator('.tz-extension-pin-host')).toHaveCount(1);
    await expect.poll(() => highlightText(page, 'tz-pin-0')).toBe('3pm est');
    await selectAll(page, 'cap');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect.poll(() => highlightText(page)).toBe('10:00 utc');
    await page.close();
  });

  test('round 6: off-screen and screen-reader-only times are left out; a positioned edge is a word break', async () => {
    await setPrefs({ homeZone: 'Asia/Tokyo', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const page = await openPage(
      '<p id="off">x <span style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> y</p>' +
        '<p id="sr">Updated <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">on 2024-08-13 07:00 UTC</span><span aria-hidden="true">3 days ago</span></p>' +
        '<p id="mix">Visible 2024-08-01 10:00 UTC and offscreen <span style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> end</p>' +
        '<p id="glue" style="position:relative">Updated <span style="position:absolute;left:0;top:30px">2024-08-13 07:00 UTC</span> 3 days ago</p>',
    );
    for (const id of ['off', 'sr']) {
      await selectAll(page, id);
      await page.waitForTimeout(500);
      await expect(card(page), `#${id}`).toHaveCount(0);
    }
    await selectAll(page, 'mix');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('.tzx-src span').first()).toHaveText('“2024-08-01 10:00 UTC”');
    await expect(card(page).locator('.tzx-step')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await selectAll(page, 'glue');
    // Chrome's string runs the positioned time into the next words.
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Updated 2024-08-13 07:00 UTC3 days ago');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('.tzx-src span').first()).toHaveText('“2024-08-13 07:00 UTC”');
    await expect(card(page).locator('.tzx-src')).toContainText('read as UTC');
    await page.close();
  });

  test('round 6: two pins 140 px apart cover neither each other nor each other’s marked time', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Tokyo'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
    const page = await openPage(
      '<p id="l1" style="margin:0;line-height:20px">Standup is at 09:00 UTC, every day</p>' +
        '<p id="l2" style="margin:120px 0 0;line-height:20px">03/04/2024 10:00 and 05/06/2024 11:00</p>',
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await selectAll(page, 'l1');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await card(page).getByRole('button', { name: 'Pin to page' }).click();
    await expect(page.locator('.tz-extension-pin-host')).toHaveCount(1);
    await selectAll(page, 'l2');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const status = card(page).locator('[aria-live="polite"]');
    if ((await status.textContent())?.includes('1 of 2')) await card(page).getByRole('button', { name: 'Next time' }).click();
    await expect(status).toHaveText('Time 2 of 2');
    await card(page).getByRole('button', { name: 'Pin to page' }).click();
    await expect(page.locator('.tz-extension-pin-host')).toHaveCount(2);
    await page.waitForTimeout(200);
    const boxes = await page.evaluate(() => {
      const rect = (b: DOMRect): { top: number; bottom: number; left: number; right: number } => ({ top: b.top, bottom: b.bottom, left: b.left, right: b.right });
      const pins = Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((h) => rect(h.getBoundingClientRect()));
      const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      const marks = ['tz-pin-0', 'tz-pin-1'].map((n) => rect((Array.from(reg.get(n) ?? [])[0] as Range).getBoundingClientRect()));
      return { pins, marks, gap: document.getElementById('l2')!.getBoundingClientRect().top - document.getElementById('l1')!.getBoundingClientRect().top };
    });
    expect(boxes.gap).toBe(140);
    const over = (a: { top: number; bottom: number; left: number; right: number }, b: typeof a): boolean =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    expect(over(boxes.pins[0]!, boxes.pins[1]!)).toBe(false);
    // Round 7 (QA G1): the first pin stays where it was pinned, so it may
    // cover the second line; the second covers neither line's mark.
    expect(over(boxes.pins[0]!, boxes.marks[0]!)).toBe(false);
    for (const m of boxes.marks) expect(over(boxes.pins[1]!, m)).toBe(false);
    console.log('pins', JSON.stringify(boxes));
    await page.close();
  });

  test('round 6: a pin keeps the stepper and a step moves its mark', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const page = await openPage('<p id="t">Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC</p>');
    await selectAll(page, 't');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await card(page).getByRole('button', { name: 'Pin to page' }).click();
    const pin = page.locator('.tz-extension-pin-host .tzx-card');
    await expect(pin.locator('[aria-live="polite"]')).toHaveText('Time 3 of 3');
    await expect.poll(() => highlightText(page, 'tz-pin-0')).toBe('2024-04-02 18:00 UTC');
    await pin.getByRole('button', { name: 'Next time' }).click();
    await expect(pin.locator('[aria-live="polite"]')).toHaveText('Time 1 of 3');
    await expect.poll(() => highlightText(page, 'tz-pin-0')).toBe('09:00 UTC');
    await page.close();
  });

  test('round 6: a selection running above the screen opens on a time on screen, and a step scrolls with a margin', async () => {
    await setPrefs({ targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const lines = Array.from(
      { length: 60 },
      (_, i) => `<div style="line-height:32px">Item ${i} at 2024-06-${String((i % 28) + 1).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:05 UTC</div>`,
    ).join('');
    const page = await openPage(`<section id="list">${lines}</section>`);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.evaluate(() => window.scrollTo(0, 900));
    await selectAll(page, 'list', { x: 200, y: 300 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    const mark = await highlightBox(page);
    expect(mark).not.toBeNull();
    expect(mark!.top).toBeGreaterThanOrEqual(0);
    expect(mark!.bottom).toBeLessThanOrEqual(700);
    // Nearest the mouse (y = 300).
    expect(Math.abs((mark!.top + mark!.bottom) / 2 - 300)).toBeLessThan(40);
    // Step past the bottom of the screen: the time lands at least 40 px clear of the edge.
    const status = card(page).locator('[aria-live="polite"]');
    let moved = false;
    for (let i = 0; i < 20; i++) {
      const before = await page.evaluate(() => window.scrollY);
      await card(page).getByRole('button', { name: 'Next time' }).click();
      await page.waitForTimeout(60);
      const after = await page.evaluate(() => window.scrollY);
      if (after !== before) {
        const b = await highlightBox(page);
        expect(b!.bottom).toBeLessThanOrEqual(700 - 40);
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
    await expect(status).toBeVisible();
    await page.close();
  });

  test('round 6: Ctrl+A on a 2.5M-character page opens a card on its time (timings logged)', async () => {
    test.setTimeout(120_000);
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const para = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>';
    const page = await openPage(`<p>Release at 2024-04-02 18:00 UTC</p>${para.repeat(20000)}`);
    await page.evaluate(() => {
      (window as unknown as { __lt: number[] }).__lt = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) (window as unknown as { __lt: number[] }).__lt.push(Math.round(e.duration));
      }).observe({ type: 'longtask', buffered: false });
    });
    const chars = await page.evaluate(() => document.body.innerText.length);
    // What the browser itself spends on the selection (string and line boxes), for comparison.
    const own = await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.body);
      const t0 = performance.now();
      const s = r.toString();
      const t1 = performance.now();
      r.getClientRects();
      const t2 = performance.now();
      return { toString: Math.round(t1 - t0), rects: Math.round(t2 - t1), len: s.length };
    });
    await page.evaluate(() => {
      (window as unknown as { __lt: number[] }).__lt = [];
    });
    const t0 = Date.now();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(card(page)).toBeVisible({ timeout: 60_000 });
    const open = Date.now() - t0;
    await page.waitForTimeout(500);
    const lt = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
    await expect.poll(() => highlightText(page)).toBe('2024-04-02 18:00 UTC');
    console.log(`chars=${chars} open=${open}ms longTasks=${JSON.stringify(lt)} browserOwn=${JSON.stringify(own)}`);
    await page.close();
  });

  // --- Round 7 ---------------------------------------------------------------

  test('round 7: a selection in an inner scroll pane lists every row, scrolled or not; a time past a <pre>’s edge opens a card', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<div style="line-height:32px">Row ${i} at 2024-06-01 ${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')} UTC</div>`,
    ).join('');
    // The usual web-app layout: the page itself does not scroll, a pane does.
    const page = await openPage(
      '<style>html, body { height: 100%; min-height: 0 !important; overflow: hidden; margin: 0; padding: 0 !important; }</style>' +
        `<main id="pane" style="height:100%;overflow:auto">${rows}</main>` +
        `<pre id="code" style="position:fixed;bottom:0;left:0;width:300px;overflow-x:auto;background:#fff">deploy ${'x'.repeat(200)} 2024-05-05T10:00:00Z</pre>`,
    );
    await page.setViewportSize({ width: 1280, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(700);
    const status = card(page).locator('[aria-live="polite"]');
    await selectAll(page, 'pane', { x: 200, y: 100 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(status).toHaveText(/^Time \d+ of 60$/);
    await page.keyboard.press('Escape');
    // Scrolled to the middle: the rows above the pane's top count too.
    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      (document.getElementById('pane') as HTMLElement).scrollTop = 900;
    });
    await selectAll(page, 'pane', { x: 200, y: 100 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(status).toHaveText(/^Time \d+ of 60$/);
    await page.keyboard.press('Escape');
    await selectAll(page, 'code');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('.tzx-src span').first()).toHaveText('“2024-05-05T10:00:00Z”');
    await page.close();
  });

  test('round 7: times in inline-block pieces read whole; opacity 0 and transparent text are left out', async () => {
    await setPrefs({ homeZone: 'Asia/Tokyo', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const ib = (t: string): string => `<span style="display:inline-block">${t}</span>`;
    const page = await openPage(
      `<p id="flip">Starts ${ib('10')}:${ib('30')} UTC</p>` +
        `<p id="digits">Starts ${['1', '0', ':', '3', '0'].map(ib).join('')} UTC</p>` +
        `<p id="chips">${ib('2024-08-13')}${ib('07:00 UTC')}</p>` +
        '<p id="f5b">Visible 2024-08-01 10:00 UTC, <span style="opacity:0">2024-08-02 11:00 UTC</span>, <span style="color:transparent">2024-08-04 13:00 UTC</span> end</p>',
    );
    const quoted = card(page).locator('.tzx-src span').first();
    for (const [id, text] of [
      ['flip', '“10:30 UTC”'],
      ['digits', '“10:30 UTC”'],
      ['chips', '“2024-08-1307:00 UTC”'],
      ['f5b', '“2024-08-01 10:00 UTC”'],
    ] as const) {
      await selectAll(page, id);
      await expect(card(page), `#${id}`).toBeVisible({ timeout: 5000 });
      await expect(quoted, `#${id}`).toHaveText(text);
      if (id === 'f5b') await expect(card(page).locator('.tzx-step')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
    await page.close();
  });

  for (const [width, height] of [
    [390, 800],
    [1280, 800],
  ] as const) {
    test(`round 7: at ${width} px, five lines 40 px apart pin without moving earlier pins or overlapping, and Pin all keeps that`, async () => {
      await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Tokyo'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
      const lines = [
        'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
        '03/04/2024 10:00 and 05/06/2024 11:00',
        'Release 2024-05-10 08:00 PST',
        'Window 2024-06-01 12:00 UTC to 2024-06-01 14:00 UTC',
        'Cutover 2024-07-04T23:00:00Z',
      ];
      const page = await openPage(
        lines.map((t, i) => `<p id="l${i}" style="margin:0 0 20px;line-height:20px"><span>${t}</span></p>`).join(''),
      );
      await page.setViewportSize({ width, height });
      const spots = (): Promise<string[]> =>
        page.locator('.tz-extension-pin-host').evaluateAll((hosts) =>
          hosts.map((h) => `${h.style.getPropertyValue('left')},${h.style.getPropertyValue('top')}`),
        );
      let before: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await selectAll(page, `l${i}`);
        await expect(card(page)).toBeVisible({ timeout: 5000 });
        await card(page).getByRole('button', { name: 'Pin to page' }).click();
        await expect(page.locator('.tz-extension-pin-host')).toHaveCount(i + 1);
        await page.waitForTimeout(100);
        const now = await spots();
        expect(now.slice(0, i), `pin ${i}`).toEqual(before);
        before = now;
      }
      await page.evaluate(() => {
        window.getSelection()?.removeAllRanges();
        window.scrollTo(0, 0);
      });
      expect(await coverReport(page), before.join(' ')).toEqual([]);
      const right = await page.locator('.tz-extension-pin-host').evaluateAll((hosts) => hosts.map((h) => h.getBoundingClientRect().right));
      for (const r of right) expect(r).toBeLessThanOrEqual(width);
      if (width > 1000) {
        // Room on screen for the first four, side by side.
        const bottoms = await page.locator('.tz-extension-pin-host').evaluateAll((hosts) => hosts.map((h) => h.getBoundingClientRect().bottom));
        for (const b of bottoms.slice(0, 4)) expect(b, bottoms.join(' ')).toBeLessThanOrEqual(height);
      }
      await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Unpin all' }).click();
      await expect(page.locator('.tz-extension-pin-host .tzx-card.floating')).toHaveCount(5);
      await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Pin all to page' }).click();
      await expect(page.locator('.tz-extension-pin-host .tzx-card.floating')).toHaveCount(0);
      await page.waitForTimeout(100);
      // The same spots, but for sub-pixel widths (a card's width is fixed at
      // a whole pixel when it floats).
      const after = await spots();
      after.forEach((spot, i) => {
        const [x, y] = spot.split(',').map(parseFloat);
        const [x0, y0] = before[i]!.split(',').map(parseFloat);
        expect(Math.abs(x! - x0!) <= 1 && Math.abs(y! - y0!) <= 1, `${after} vs ${before}`).toBe(true);
      });
      expect(await coverReport(page)).toEqual([]);
      console.log(`pins7 ${width}: ${before.join(' ')}`);
      await page.close();
    });
  }

  // --- Round 8 ---------------------------------------------------------------

  test('round 8: a column-reverse chat scrolled up lists every message and opens on a visible one', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const msgs = Array.from(
      { length: 120 },
      (_, i) =>
        `<p ${i === 20 ? 'id="m20"' : ''} style="margin:0;line-height:30px">Msg ${i} sent 2024-05-${String((i % 28) + 1).padStart(2, '0')} 1${i % 10}:00 UTC</p>`,
    ).join('');
    const page = await openPage(
      `<div id="chat" style="height:600px;overflow-y:auto;display:flex;flex-direction:column-reverse"><div>${msgs}</div></div>`,
    );
    await page.setViewportSize({ width: 1280, height: 700 });
    // Scrolled up inside the pane only: its scrollTop goes negative.
    const at = await page.evaluate(() => {
      const pane = document.getElementById('chat') as HTMLElement;
      pane.scrollTop = -2600;
      const b = (document.getElementById('m20') as HTMLElement).getBoundingClientRect();
      return { scrollTop: pane.scrollTop, top: b.top, bottom: b.bottom };
    });
    expect(at.scrollTop).toBeLessThan(0);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(700);
    await selectAll(page, 'm20');
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('.tzx-src span').first()).toHaveText('“2024-05-21 10:00 UTC”');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await selectAll(page, 'chat', { x: 200, y: (at.top + at.bottom) / 2 });
    await expect(card(page)).toBeVisible({ timeout: 5000 });
    await expect(card(page).locator('[aria-live="polite"]')).toHaveText(/^Time \d+ of 120$/);
    await page.close();
  });

  test('round 8: right-to-left panes and pages scrolled sideways list their times; positioned off-page text is still left out', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC'], cardSize: 'full', keepSelection: true });
    const table = (id: string): string =>
      `<table style="width:3000px"><tr><td style="width:2600px">first</td><td id="${id}">end 2024-05-06 11:00 UTC</td></tr></table>`;
    const box = (page: Page, id: string): Promise<{ left: number; right: number }> =>
      page.evaluate((id) => {
        const r = document.createRange();
        r.selectNodeContents(document.getElementById(id) as HTMLElement);
        const b = r.getBoundingClientRect();
        return { left: b.left, right: b.right };
      }, id);
    const opens = async (page: Page, id: string): Promise<void> => {
      await selectAll(page, id);
      await expect(card(page), `#${id}`).toBeVisible({ timeout: 5000 });
      await expect(card(page).locator('.tzx-src span').first(), `#${id}`).toHaveText('“2024-05-06 11:00 UTC”');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    };

    // A right-to-left table in a scroller on a left-to-right page, scrolled so the time shows.
    let page = await openPage(`<div id="pane" dir="rtl" style="overflow-x:auto;width:100%">${table('t')}</div>`);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.evaluate(() => {
      (document.getElementById('pane') as HTMLElement).scrollLeft = -3000;
    });
    expect(await page.evaluate(() => (document.getElementById('pane') as HTMLElement).scrollLeft)).toBeLessThan(0);
    const inPane = await box(page, 't');
    expect(inPane.left).toBeGreaterThanOrEqual(0);
    expect(inPane.right).toBeLessThanOrEqual(1280);
    await opens(page, 't');
    await page.close();

    // A right-to-left page, 3000 px wide: the time off to the left, then scrolled into view.
    page = await openPage(
      table('t') +
        '<p id="right">x <span style="position:absolute;right:-9999px">2024-08-12 06:00 UTC</span> y</p>' +
        '<p id="fixed">x <span style="position:fixed;top:-500px">2024-08-12 06:00 UTC</span> y</p>',
    );
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    expect((await box(page, 't')).right).toBeLessThan(0);
    await opens(page, 't');
    await page.evaluate(() => window.scrollTo(-3000, 0));
    expect(await page.evaluate(() => window.scrollX)).toBeLessThan(0);
    const onPage = await box(page, 't');
    expect(onPage.left).toBeGreaterThanOrEqual(0);
    expect(onPage.right).toBeLessThanOrEqual(1280);
    await opens(page, 't');
    // Positioned text past the side the page cannot scroll to, or above a scrolled page, gives no card.
    await page.evaluate(() => window.scrollTo(-500, 600));
    for (const id of ['right', 'fixed']) {
      await selectAll(page, id);
      await page.waitForTimeout(500);
      await expect(card(page), `#${id}`).toHaveCount(0);
    }
    await page.close();
  });

  /** The QA's five-line page (pins3.mjs): lines `gap` px apart, each indented 30 px more. */
  async function qaLines(width: number, gap = 40): Promise<Page> {
    const lines = [
      'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
      '03/04/2024 10:00 and 05/06/2024 11:00',
      'Release 2024-05-10 08:00 PST',
      'Window 2024-06-01 12:00 UTC to 2024-06-01 14:00 UTC',
      'Cutover 2024-07-04T23:00:00Z',
    ];
    const page = await openPage(
      '<style>body { padding: 0 8px !important; margin: 0; }</style><div style="height:60px"></div>' +
        lines.map((l, i) => `<p id="l${i}" style="margin:${gap}px 0 0 ${i * 30}px"><span>${l}</span></p>`).join(''),
    );
    await page.setViewportSize({ width, height: 800 });
    return page;
  }

  /** Pin the first `n` QA lines, from the top of the page; true for each pin wholly on screen right after it was pinned. */
  async function pinLines(page: Page, n: number): Promise<boolean[]> {
    const shown: boolean[] = [];
    for (let i = 0; i < n; i++) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await selectAll(page, `l${i}`);
      await expect(card(page)).toBeVisible({ timeout: 5000 });
      await card(page).getByRole('button', { name: 'Pin to page' }).click();
      await expect(page.locator('.tz-extension-pin-host')).toHaveCount(i + 1);
      await page.waitForTimeout(150);
      shown.push(await wholly(page, i));
    }
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    return shown;
  }

  /** Whether pin `i` is wholly in the viewport. */
  function wholly(page: Page, i: number): Promise<boolean> {
    return page.evaluate((i) => {
      const b = (document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')[i] as HTMLElement).getBoundingClientRect();
      return b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth;
    }, i);
  }

  for (const n of [2, 5]) {
    test(`round 8: at 390 px with ${n} pins, a new pin is scrolled into view and a stepped pin stays on screen`, async () => {
      await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Kathmandu', 'America/New_York'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
      const page = await qaLines(390);
      expect(await pinLines(page, n)).toEqual(Array(n).fill(true));
      await page.evaluate(() => window.scrollTo(0, 0));
      const first = page.locator('.tz-extension-pin-host').first();
      const status = first.locator('[aria-live="polite"]');
      // Step through all three times of line 1; the card never leaves the screen.
      for (let s = 0; s < 3; s++) {
        const was = (await status.textContent()) ?? '';
        await first.getByRole('button', { name: 'Next time' }).click();
        await expect(status).not.toHaveText(was);
        await page.waitForTimeout(100);
        expect(await wholly(page, 0), `after step ${s + 1}: ${await status.textContent()}`).toBe(true);
      }
      expect(await coverReport(page).then((r) => r.filter((x) => x.includes('/')))).toEqual([]);
      await page.close();
    });
  }

  test('round 8: at 1280 px the QA’s five pins all land on screen, the last two in the free column on the right', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Kathmandu', 'America/New_York'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
    const page = await qaLines(1280);
    expect(await pinLines(page, 5)).toEqual([true, true, true, true, true]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const boxes = await page.locator('.tz-extension-pin-host').evaluateAll((hosts) => hosts.map((h) => h.getBoundingClientRect().toJSON() as DOMRect));
    const third = boxes[2]!;
    for (const b of boxes.slice(3)) expect(b.left, JSON.stringify(boxes)).toBeGreaterThanOrEqual(third.right);
    expect(await coverReport(page).then((r) => r.filter((x) => x.includes('/')))).toEqual([]);
    console.log(`pins8 1280: ${boxes.map((b) => `${Math.round(b.left)},${Math.round(b.top)}`).join(' ')}`);
    await page.close();
  });

  // --- Round 9 ---------------------------------------------------------------

  // An app shell (Gmail, Slack, Jira): the window cannot scroll, an inner pane does.
  const SHELL_LINES = [
    'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
    '03/04/2024 10:00 and 05/06/2024 11:00',
    'Release 2024-05-10 08:00 PST',
    'Window 2024-06-01 12:00 UTC to 2024-06-01 14:00 UTC',
    'Cutover 2024-07-04T23:00:00Z',
  ];
  for (const width of [390, 1280]) {
    test(`round 9: on an app-shell page at ${width} px, pins stay on screen and the page never scrolls`, async () => {
      await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Kathmandu', 'America/New_York'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
      const page = await openPage(
        '<style>html, body { margin: 0 !important; height: 100% !important; } body { overflow: hidden !important; display: flex; flex-direction: column; padding: 0 !important; }' +
          'header { flex: none; height: 48px; background: #ddd; } main { flex: 1; overflow: auto; padding: 8px 20px; font-size: 16px; }' +
          'main p { margin: 0; height: 40px; line-height: 20px; }</style>' +
          '<header id="bar">Toolbar</header><main id="pane">' +
          [...SHELL_LINES, ...SHELL_LINES.map((t) => `Later: ${t}`)].map((t, i) => `<p id="l${i}">${t}</p>`).join('') +
          '<p>filler</p>'.repeat(40) +
          '</main>',
      );
      await page.setViewportSize({ width, height: 800 });
      // Ten pins: more than fit on screen without overlapping at either width.
      for (let i = 0; i < 10; i++) {
        const before = await page.locator('.tz-extension-pin-host').count();
        await selectAll(page, `l${i}`);
        await expect(card(page)).toBeVisible({ timeout: 5000 });
        await card(page).getByRole('button', { name: 'Pin to page' }).click();
        await expect(page.locator('.tz-extension-pin-host')).toHaveCount(before + 1);
        // The window never scrolls, and the app's toolbar stays at the top.
        expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
        expect((await page.locator('#bar').boundingBox())?.y).toBe(0);
        // Every pin is wholly on screen, where the user can reach it.
        const boxes = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.tz-extension-pin-host')).map((h) => h.getBoundingClientRect().toJSON()),
        );
        for (const b of boxes as Array<{ top: number; left: number; bottom: number; right: number }>) {
          expect(b.top, JSON.stringify(boxes)).toBeGreaterThanOrEqual(0);
          expect(b.bottom, JSON.stringify(boxes)).toBeLessThanOrEqual(800);
          expect(b.left, JSON.stringify(boxes)).toBeGreaterThanOrEqual(0);
          expect(b.right, JSON.stringify(boxes)).toBeLessThanOrEqual(width);
        }
        // Close the card if one is still open, so the next selection starts clean.
        await page.keyboard.press('Escape');
      }
      await page.close();
    });
  }

  test('round 8: "Pin all to page" after scrolling to y 2000 puts each card back by its own text', async () => {
    await setPrefs({ homeZone: 'UTC', targetZones: ['UTC', 'Asia/Kathmandu', 'America/New_York'], cardSize: 'full', keepSelection: true, numericDateOrder: 'mdy' });
    // The review's page (pins8.spec.ts): three lines 120 px apart near the top.
    const page = await openPage(
      '<style>body { margin: 0; padding: 40px 20px !important; font-size: 16px !important; min-height: 4000px !important; }</style>' +
        [
          'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
          '03/04/2024 10:00 and 05/06/2024 11:00',
          'Release 2024-05-10 08:00 PST',
        ]
          .map((t, i) => `<p id="l${i}" style="margin:0;height:120px;line-height:20px">${t}</p>`)
          .join(''),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await pinLines(page, 3);
    await page.evaluate(() => window.scrollTo(0, 2000));
    expect(await page.evaluate(() => window.scrollY)).toBe(2000);
    await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Unpin all' }).click();
    await expect(page.locator('.tz-extension-pin-host .tzx-card.floating')).toHaveCount(3);
    await page.locator('#tz-extension-pin-dock').getByRole('button', { name: 'Pin all to page' }).click();
    await expect(page.locator('.tz-extension-pin-host .tzx-card.floating')).toHaveCount(0);
    await page.waitForTimeout(100);
    const far = await page.evaluate(() => {
      const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights;
      return Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host')).map((h, i) => {
        const card = h.getBoundingClientRect();
        const text = (Array.from(reg.get(`tz-pin-${i}`) ?? [])[0] as Range).getBoundingClientRect();
        // The gap between the card and its marked time, in card heights.
        const dx = Math.max(0, text.left - card.right, card.left - text.right);
        const dy = Math.max(0, text.top - card.bottom, card.top - text.bottom);
        return Math.hypot(dx, dy) / card.height;
      });
    });
    for (const d of far) expect(d, JSON.stringify(far)).toBeLessThanOrEqual(1);
    await page.close();
  });
});
