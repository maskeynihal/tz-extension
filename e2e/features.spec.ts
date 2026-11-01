import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../dist');
const KEY = 'tz-extension-prefs';
const ORIGIN = 'https://tz-features.local';

/**
 * End-to-end checks for format management, the right-click menu, and the
 * select-to-convert preference, against the built extension in Chromium.
 * Requires `npm run build:chrome` first.
 */
test.describe('formats, context menu, select-to-convert', () => {
  let context: BrowserContext;
  let sw: Worker;
  let extId: string;

  test.beforeAll(async () => {
    if (!existsSync(resolve(DIST, 'manifest.json'))) {
      throw new Error('dist/manifest.json missing — run `npm run build:chrome` before e2e.');
    }
    context = await chromium.launchPersistentContext('', {
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--headless=new'],
    });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    extId = new URL(sw.url()).host;
    // Extension APIs bind a moment after the worker starts.
    await expect
      .poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && typeof chrome.storage?.sync !== 'undefined'))
      .toBe(true);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.beforeEach(async () => {
    // Fresh preferences for every test (the worker re-seeds defaults on read).
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

  async function openPage(body: string): Promise<Page> {
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body style="padding:40px;font-size:18px">${body}</body></html>`,
      }),
    );
    await page.goto(`${ORIGIN}/`);
    // Let the content script load its preferences.
    await page.waitForTimeout(300);
    return page;
  }

  async function selectText(page: Page, selector: string): Promise<void> {
    await page.locator(selector).click({ clickCount: 3 });
  }

  /** Run the worker's menu-click handler for the newest tab. */
  async function menuConvert(text: string): Promise<void> {
    await sw.evaluate(
      async (text) => {
        // Without the "tabs" permission URLs are hidden; the newest tab is ours.
        const tabs = await chrome.tabs.query({});
        const tab = tabs.reduce<chrome.tabs.Tab | undefined>((a, t) => (!a || (t.id ?? 0) > (a.id ?? 0) ? t : a), undefined);
        if (!tab?.id) throw new Error('test tab not found');
        const fn = (globalThis as unknown as { tzxConvertInTab: (t: number, f: number, s: string) => Promise<void> })
          .tzxConvertInTab;
        await fn(tab.id, 0, text);
      },
      text,
    );
  }

  const popover = (page: Page) => page.locator('#tz-extension-popover-host .tzx-card');

  test('the right-click menu item is registered', async () => {
    const err = await sw.evaluate(
      () =>
        new Promise<string | null>((done) => {
          chrome.contextMenus.update('tzx-convert-selection', {}, () =>
            done(chrome.runtime.lastError?.message ?? null),
          );
        }),
    );
    expect(err).toBeNull();
  });

  test('with select-to-convert off, selecting does nothing but the menu converts', async () => {
    await setPrefs({ selectToConvert: false });
    const page = await openPage('<p id="t">2024-01-02T15:04:05Z</p>');
    await selectText(page, '#t');
    await page.waitForTimeout(600);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);

    await menuConvert('2024-01-02T15:04:05Z');
    await expect(popover(page)).toBeVisible();
    await expect(popover(page)).toContainText('2024-01-02T15:04:05Z');
    await expect(popover(page)).toContainText('format: ISO 8601');
    await page.close();
  });

  test('turning select-to-convert back on applies live in an open tab', async () => {
    await setPrefs({ selectToConvert: false });
    const page = await openPage('<p id="t">1700000000</p>');
    await setPrefs({ selectToConvert: true });
    await page.waitForTimeout(200);
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await page.close();
  });

  test('the menu shows a "no time recognized" card and can open settings', async () => {
    const page = await openPage('<p id="t">not a date at all</p>');
    await selectText(page, '#t');
    await menuConvert('not a date at all');
    const card = page.locator('#tz-extension-popover-host .tzx-nomatch');
    await expect(card).toBeVisible();
    await expect(card).toContainText('No date or time recognized');
    const optionsPage = context.waitForEvent('page');
    await card.getByRole('button', { name: 'Open format settings' }).click();
    const opened = await optionsPage;
    expect(opened.url()).toContain(`chrome-extension://${extId}/src/options/index.html`);
    await opened.close();
    await page.close();
  });

  test('a disabled built-in format no longer converts', async () => {
    await setPrefs({ disabledFormats: ['epoch-seconds'] });
    const page = await openPage('<p id="t">1700000000</p>');
    await selectText(page, '#t');
    await page.waitForTimeout(600);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);
    await page.close();
  });

  test('a custom format beats the epoch reading of the same digits', async () => {
    await setPrefs({
      customFormats: [{ id: 'c1', label: 'Compact stamp', pattern: 'YYYYMMDDHHmm', advanced: false, enabled: true }],
    });
    const page = await openPage('<p id="t">202412311030</p>');
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await expect(popover(page)).toContainText('format: Compact stamp');
    await expect(popover(page).locator('.tzx-row').filter({ hasText: 'UTC' }).first()).toContainText('10:30');
    await page.close();
  });

  test('settings: list built-ins, switch one off, add, edit and use a custom format', async () => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options/index.html`);

    const builtins = opt.getByRole('list', { name: 'Built-in formats' });
    await expect(builtins.getByRole('listitem')).toHaveCount(13);
    const isoSwitch = opt.getByRole('switch', { name: 'ISO 8601 format' });
    await expect(isoSwitch).toHaveAttribute('aria-checked', 'true');
    await isoSwitch.click();
    await expect(isoSwitch).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(async () => sw.evaluate(async (k) => (await chrome.storage.sync.get(k))[k]?.disabledFormats, KEY))
      .toEqual(['iso-8601']);

    // The tester reflects the disabled format.
    await opt.getByLabel('Test text').fill('2024-01-02T10:00:00Z');
    await expect(opt.getByText('No enabled format recognizes this text.')).toBeVisible();
    await isoSwitch.click();
    await expect(opt.locator('.tzx-test-out')).toContainText('ISO 8601');

    // Invalid patterns explain themselves.
    await opt.getByLabel('Format pattern').fill('D MM YYYY M');
    await expect(opt.getByText(/repeats the month/)).toBeVisible();
    await expect(opt.getByRole('button', { name: 'Add format' })).toBeDisabled();
    await opt.getByLabel('Format pattern').fill('hh:mm');
    await expect(opt.getByText(/12-hour clock tokens/)).toBeVisible();

    // A valid one previews against the sample.
    await opt.getByLabel('Format pattern').fill('DD.MM.YYYY [um] HH:mm');
    await opt.getByLabel('Format name').fill('German');
    await opt.getByLabel('Sample text to test').fill('Termin 31.12.2024 um 10:30');
    await expect(opt.locator('.tzx-adder .tzx-good')).toContainText('31.12.2024 um 10:30');
    await opt.getByRole('button', { name: 'Add format' }).click();
    const custom = opt.getByRole('list', { name: 'Custom formats' });
    await expect(custom.getByRole('listitem')).toHaveCount(1);
    await expect(custom).toContainText('German');

    // Edit it.
    await custom.getByRole('button', { name: 'Edit German' }).click();
    await expect(opt.getByLabel('Format pattern')).toHaveValue('DD.MM.YYYY [um] HH:mm');
    await opt.getByLabel('Format name').fill('German date');
    await opt.getByRole('button', { name: 'Save changes' }).click();
    await expect(custom).toContainText('German date');
    await expect(custom.getByRole('listitem')).toHaveCount(1);

    // It converts on a page.
    const page = await openPage('<p id="t">Termin 31.12.2024 um 10:30</p>');
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await expect(popover(page)).toContainText('format: German date');

    // Switch it off from settings: the built-in numeric-date format reads it instead.
    await custom.getByRole('switch', { name: 'German date format' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.mouse.click(5, 5);
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await expect(popover(page)).toContainText('format: Numeric date');
    await page.close();
    await opt.close();
  });

  test('a card near the bottom of the viewport stays fully visible', async () => {
    const page = await openPage('<div style="height:2000px"></div><p id="t">2024-12-31 10:30 UTC</p>');
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.locator('#t').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -10));
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await expect(popover(page)).toContainText('read as UTC');
    await page.waitForTimeout(100);
    const box = await page.locator('#tz-extension-popover-host').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    await page.close();
  });

  test('keyboard selection (Shift+Home in a text field) opens the converter', async () => {
    const page = await openPage('<textarea id="t">1700000000</textarea>');
    await page.locator('#t').focus();
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Home');
    await page.keyboard.up('Shift');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await page.close();
  });

  test('"Open format settings" lands on the formats section', async () => {
    const page = await openPage('<p id="t">not a date</p>');
    await selectText(page, '#t');
    await menuConvert('not a date');
    const opened = context.waitForEvent('page');
    await page.locator('#tz-extension-popover-host .tzx-nomatch').getByRole('button', { name: 'Open format settings' }).click();
    const opt = await opened;
    expect(opt.url()).toMatch(/#formats$/);
    await expect(opt.getByRole('heading', { name: 'Recognized formats' })).toBeInViewport();
    await opt.close();
    await page.close();
  });

  test('a dismissed card stays closed (Escape in a field, Shift+click, keep-selection off)', async () => {
    await setPrefs({ keepSelection: false });
    const page = await openPage(
      '<input id="i" value="Meeting at 2024-01-02T15:04:05Z" style="width:400px"><p id="t">1700000000</p>',
    );
    // Escape inside a text field.
    await page.locator('#i').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);

    // Close with ×, then Shift+click at the end of the same page selection.
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await popover(page).getByLabel('Close').click();
    const before = await page.evaluate(() => window.getSelection()?.toString());
    // Re-dispatch a mouseup over the unchanged selection (what Shift+click at
    // its end does) and a Shift keyup: neither may bring the card back.
    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, shiftKey: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
    });
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(before);
    await expect(page.locator('#tz-extension-popover-host')).toHaveCount(0);
    // A new selection converts again.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.click(5, 5);
    await selectText(page, '#t');
    await expect(popover(page)).toBeVisible({ timeout: 5000 });
    await page.close();
  });

  test('the menu card says when a very long selection was only partly checked', async () => {
    const page = await openPage('<p>long</p>');
    await menuConvert('lorem ipsum '.repeat(2100));
    const card = page.locator('#tz-extension-popover-host .tzx-nomatch');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Only the first 20,000 characters');
    await page.close();
  });

  test('settings: the select-to-convert switch persists', async () => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/src/options/index.html`);
    const sw2c = opt.getByRole('switch', { name: 'Convert when I select text' });
    await expect(sw2c).toHaveAttribute('aria-checked', 'true');
    await sw2c.click();
    await expect
      .poll(async () => sw.evaluate(async (k) => (await chrome.storage.sync.get(k))[k]?.selectToConvert, KEY))
      .toBe(false);
    await opt.reload();
    await expect(opt.getByRole('switch', { name: 'Convert when I select text' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await opt.close();
  });
});
