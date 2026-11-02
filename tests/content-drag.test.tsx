import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';

/**
 * The selection card's reorderable zones with the real content script:
 * Escape on a row held from the keyboard puts the row back and leaves the
 * card open; the next Escape closes it.
 */

const KEY = 'tz-extension-prefs';

async function load(): Promise<void> {
  const data = { homeZone: 'UTC', targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'], hour12: false, cardSize: 'full' };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: { get: vi.fn(async () => ({ [KEY]: data })), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      id: 'ext-id',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
  };
  const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
  slot.__tzExtensionContent__?.dispose();
  delete slot.__tzExtensionContent__;
  vi.resetModules();
  await import('../src/content/index');
  await new Promise((r) => setTimeout(r, 0));
}

const host = (): HTMLElement | null => document.getElementById('tz-extension-popover-host');
const card = (): Element | null => host()?.shadowRoot?.querySelector('.tzx-card') ?? null;
const keys = (): string[] =>
  Array.from(host()?.shadowRoot?.querySelectorAll<HTMLElement>('li[data-sort-key]') ?? []).map((li) => li.dataset.sortKey ?? '');

function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true }));
  });
}

describe('selection card: keyboard reorder and Escape', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  beforeEach(async () => {
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      return this.collapsed ? new DOMRect(0, 0, 0, 0) : new DOMRect(100, 100, 80, 20);
    };
    document.body.innerHTML = '<p id="t">Deploy at 2024-01-02T15:04:05Z today.</p>';
    await load();
  });
  afterEach(() => {
    (window as unknown as Record<string, { dispose(): void } | undefined>).__tzExtensionContent__?.dispose();
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    document.body.innerHTML = '';
  });

  it('Escape on a held row cancels the move and keeps the card; the next Escape closes it', async () => {
    const el = document.getElementById('t') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
    await vi.waitFor(() => expect(card()).toBeTruthy());

    const before = keys();
    expect(before).toContain('Asia/Tokyo');
    const root = host()?.shadowRoot as ShadowRoot;
    const grip = root.querySelector('button[aria-label="Drag to reorder UTC"]') as HTMLButtonElement;
    grip.focus();
    key(grip, ' ');
    expect(grip.getAttribute('aria-pressed')).toBe('true');
    key(root.activeElement as Element, 'ArrowDown');
    expect(keys()).not.toEqual(before);

    key(root.activeElement as Element, 'Escape');
    expect(card()).toBeTruthy();
    expect(keys()).toEqual(before);
    expect(root.querySelector('button[aria-label="Drag to reorder UTC"]')?.getAttribute('aria-pressed')).toBe('false');

    key(root.activeElement ?? (card() as Element), 'Escape');
    await vi.waitFor(() => expect(card()).toBeNull());
  });
});
