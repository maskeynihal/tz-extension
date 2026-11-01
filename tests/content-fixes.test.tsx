import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { Popover } from '../src/content/Popover';
import { PinDock, UNDO_MS } from '../src/content/PinDock';
import { parseTimes } from '../src/lib/parse';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

/**
 * Round-1 fixes for the content script: selectable card text, day/month
 * labels, the compact day/month choice, highlight gating, size writes, undo,
 * dock focus and stacking, pin-back placement, Escape and pin cascading.
 */

const KEY = 'tz-extension-prefs';
type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown;
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

/** Rect of a page range: from the `data-top` of the element holding it; zero when collapsed. */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  return new DOMRect(100, top, 80, 20);
}

interface Env {
  readonly listener: Listener;
  readonly set: ReturnType<typeof vi.fn>;
  /** What storage holds now. */
  stored(): Record<string, unknown>;
  /** Write prefs as another context would (fires onChanged). */
  writeElsewhere(patch: Record<string, unknown>): Promise<void>;
  /** Change storage without telling this tab (its copy goes stale). */
  writeSilently(patch: Record<string, unknown>): void;
}

async function load(initial: Record<string, unknown>): Promise<Env> {
  let data: Record<string, unknown> = { homeZone: 'UTC', targetZones: ['UTC'], hour12: false, ...initial };
  const changeListeners: ChangeListener[] = [];
  const listeners: Listener[] = [];
  const set = vi.fn(async (items: Record<string, unknown>) => {
    const oldValue = data;
    data = items[KEY] as Record<string, unknown>;
    for (const l of changeListeners) l({ [KEY]: { oldValue, newValue: data } }, 'sync');
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: { get: vi.fn(async () => ({ [KEY]: data })), set },
      onChanged: { addListener: (l: ChangeListener) => changeListeners.push(l), removeListener: vi.fn() },
    },
    runtime: {
      id: 'ext-id',
      onMessage: { addListener: (l: Listener) => listeners.push(l), removeListener: vi.fn() },
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
  };
  const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
  slot.__tzExtensionContent__?.dispose();
  delete slot.__tzExtensionContent__;
  vi.resetModules();
  await import('../src/content/index');
  const listener = listeners[0];
  if (!listener) throw new Error('no message listener');
  // Let the stored preferences load.
  await new Promise((r) => setTimeout(r, 0));
  return {
    listener,
    set,
    stored: () => data,
    writeElsewhere: async (patch) => {
      await set({ [KEY]: { ...data, ...patch } });
      set.mockClear();
    },
    writeSilently: (patch) => {
      data = { ...data, ...patch };
    },
  };
}

const shadowOf = (el: Element | null | undefined): ShadowRoot => {
  const root = (el as HTMLElement | null)?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
};
const transientHost = (): HTMLElement | null => document.getElementById('tz-extension-popover-host');
const transient = (): ShadowRoot => shadowOf(transientHost());
const pinHosts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host'));
const dockHost = (): HTMLElement | null => document.getElementById('tz-extension-pin-dock');
const dock = (): ShadowRoot => shadowOf(dockHost());
const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Select an element's text on the page and convert it from the menu. */
async function convert(env: Env, id: string): Promise<void> {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const respond = vi.fn();
  env.listener({ type: 'tzx/convert-selection', text: el.textContent ?? '' }, { id: 'ext-id' }, respond);
  await vi.waitFor(() => expect(respond).toHaveBeenCalled());
  await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
}

async function pinFrom(env: Env, id: string): Promise<HTMLElement> {
  const before = pinHosts().length;
  await convert(env, id);
  button(transient(), 'Pin to page').click();
  await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
  const host = pinHosts().at(-1) as HTMLElement;
  await vi.waitFor(() => expect(host.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  return host;
}

const px = (el: HTMLElement, prop: 'top' | 'left'): number => parseFloat(el.style.getPropertyValue(prop));

const PAGE = `
  <p id="a" data-top="100">1700000000</p>
  <p id="b" data-top="300">2024-01-02T10:00:00Z</p>
  <p id="c" data-top="500">2024-05-06T07:08:09Z</p>
  <p id="d" data-top="700">1600000000</p>
  <p id="a2" data-top="100">1700000100</p>
  <p id="a3" data-top="100">1700000200</p>`;

describe('content script fixes', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    highlights.clear();
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true, writable: true });
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 2000, configurable: true });
  });
  afterEach(() => {
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
  });

  // Fix 4
  it('marks pins only when "also mark the matched text" is on, and follows the setting live', async () => {
    const env = await load({ keepSelection: false });
    await pinFrom(env, 'a');
    expect(highlights.has('tz-pin-0')).toBe(false);
    expect(highlights.has('tz-extension-match')).toBe(false);

    await env.writeElsewhere({ keepSelection: true });
    expect(highlights.has('tz-pin-0')).toBe(true);
    // A transient card opened now is marked too.
    await convert(env, 'b');
    expect(highlights.has('tz-extension-match')).toBe(true);

    await env.writeElsewhere({ keepSelection: false });
    expect(highlights.has('tz-pin-0')).toBe(false);
    expect(highlights.has('tz-extension-match')).toBe(false);
    // The pin and the transient card stay open; only the marks go.
    expect(pinHosts()).toHaveLength(1);
    expect(transientHost()).not.toBeNull();
  });

  // Fix 5
  it('saves the size only for "Last used", once per burst of toggles', async () => {
    const env = await load({ cardSize: 'last', lastCardSize: 'full' });
    await convert(env, 'a');
    button(transient(), 'Make compact').click();
    await vi.waitFor(() => button(transient(), 'Expand card'));
    button(transient(), 'Expand card').click();
    await vi.waitFor(() => button(transient(), 'Make compact'));
    button(transient(), 'Make compact').click();
    await vi.waitFor(() => button(transient(), 'Expand card'));
    expect(env.set).not.toHaveBeenCalled();
    await sleep(700);
    expect(env.set).toHaveBeenCalledTimes(1);
    expect(env.stored().lastCardSize).toBe('compact');
  });

  it('writes nothing for size toggles when the size on open is fixed', async () => {
    const env = await load({ cardSize: 'full' });
    await pinFrom(env, 'a');
    button(shadowOf(pinHosts()[0]), 'Make compact').click();
    button(dock(), 'Expand all').click();
    button(dock(), 'Minimize all').click();
    await sleep(700);
    expect(env.set).not.toHaveBeenCalled();
  });

  it('merges a card change into what storage holds now, not a stale copy', async () => {
    const env = await load({ numericDateOrder: 'dmy' });
    document.body.insertAdjacentHTML('beforeend', '<p id="amb" data-top="900">03/04/2024 10:00</p>');
    await convert(env, 'amb');
    // Settings changed elsewhere; this tab has not heard yet.
    env.writeSilently({ hour12: true, targetZones: ['Asia/Tokyo'] });
    const monthFirst = Array.from(transient().querySelectorAll<HTMLButtonElement>('.tzx-order-btn')).find((b) =>
      b.textContent?.includes('Mar 4'),
    );
    monthFirst?.click();
    await vi.waitFor(() => expect(env.set).toHaveBeenCalledTimes(1));
    expect(env.stored()).toMatchObject({ numericDateOrder: 'mdy', hour12: true, targetZones: ['Asia/Tokyo'] });
  });

  // Fix 6
  it('Undo after Close all restores slots, size, placement and position, and keeps the open card', async () => {
    const env = await load({ keepSelection: true });
    const a = await pinFrom(env, 'a');
    const b = await pinFrom(env, 'b');
    const c = await pinFrom(env, 'c');
    button(shadowOf(b), 'Close').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(2));
    button(shadowOf(a), 'Make compact').click();
    button(shadowOf(c), 'Float on screen').click();
    await vi.waitFor(() => expect(shadowOf(c).querySelector('.tzx-card.floating')).not.toBeNull());
    const box = (h: HTMLElement): string[] => ['position', 'top', 'left'].map((k) => h.style.getPropertyValue(k));
    const before = [box(a), box(c)];

    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    // The user opens another card during the undo offer.
    await convert(env, 'd');
    expect(highlights.has('tz-extension-match')).toBe(true);

    const undo = Array.from(dock().querySelectorAll('button')).find((x) => x.textContent?.includes('Undo'));
    undo?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(2));
    await vi.waitFor(() => expect(pinHosts().every((h) => h.shadowRoot?.querySelector('.tzx-pinbadge'))).toBe(true));

    const badges = pinHosts().map((h) => shadowOf(h).querySelector<HTMLElement>('.tzx-pinbadge'));
    expect(badges.map((x) => x?.textContent)).toEqual(['1', '3']);
    const { pinColor } = await import('../src/content/index');
    const hex = (c: string): string => {
      const probe = document.createElement('i');
      probe.style.background = c;
      return probe.style.background;
    };
    expect(badges.map((x) => x?.style.background)).toEqual([hex(pinColor(0).dot), hex(pinColor(2).dot)]);
    expect(highlights.has('tz-pin-0') && highlights.has('tz-pin-2')).toBe(true);
    expect(highlights.has('tz-pin-1')).toBe(false);

    const [ra, rc] = pinHosts() as [HTMLElement, HTMLElement];
    expect([box(ra), box(rc)]).toEqual(before);
    expect(shadowOf(ra).querySelector('.tzx-card.compact')).not.toBeNull();
    expect(shadowOf(rc).querySelector('.tzx-card.floating')).not.toBeNull();

    // The card opened meanwhile and its mark are still there.
    expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy();
    expect(highlights.has('tz-extension-match')).toBe(true);
  });

  it('Undo still works after the page removed a pinned text', async () => {
    const env = await load({ keepSelection: true });
    await pinFrom(env, 'a');
    document.getElementById('a')?.remove();
    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    Array.from(dock().querySelectorAll('button')).find((x) => x.textContent?.includes('Undo'))?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
  });

  // Fix 7 (content-script wiring)
  it('focuses Undo after Close all, with only the message as the status', async () => {
    const env = await load({});
    await pinFrom(env, 'a');
    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(dock().activeElement?.textContent).toContain('Undo'));
    const status = dock().querySelectorAll('[role="status"]');
    expect(status).toHaveLength(1);
    expect(status[0]?.textContent).toBe('Closed 1 card');
    expect(status[0]?.querySelector('button')).toBeNull();
    (dock().activeElement as HTMLButtonElement).click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    // Focus stays in the dock, on its first button.
    await vi.waitFor(() => expect(dock().activeElement?.classList.contains('count')).toBe(true));
  });

  // Fix 8
  it('stacks the dock above every card and moves floating cards out of its way', async () => {
    const env = await load({});
    const pin = await pinFrom(env, 'a');
    await convert(env, 'b');
    const z = (h: HTMLElement | null): number => Number(h?.style.getPropertyValue('z-index'));
    expect(z(dockHost())).toBeGreaterThan(z(pin));
    expect(z(dockHost())).toBeGreaterThan(z(transientHost()));

    const vh = window.innerHeight;
    (dockHost() as HTMLElement).getBoundingClientRect = () => new DOMRect(200, vh - 56, 180, 40);
    pin.getBoundingClientRect = () => new DOMRect(210, vh - 80, 300, 150);
    button(shadowOf(pin), 'Float on screen').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('fixed'));
    // Above the dock: dock top − margin − card height.
    expect(px(pin, 'top')).toBe(vh - 56 - 8 - 150);
    expect(px(pin, 'left')).toBe(210);
  });

  // Fix 9
  it('"Pin to page" from floating goes back next to the source text, or stays put if the text is gone', async () => {
    const env = await load({});
    const pin = await pinFrom(env, 'b');
    expect(px(pin, 'top')).toBe(300 + 20 + 8);
    button(shadowOf(pin), 'Float on screen').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('fixed'));
    // The text moved down the page meanwhile.
    document.getElementById('b')?.setAttribute('data-top', '640');
    button(shadowOf(pin), 'Pin to page').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('absolute'));
    // Round 7 (QA G2): right below it (668) the 200 px card would run past
    // the 768 px screen, so it takes the nearest spot wholly on screen that
    // does not cover its text: beside it (180 + 8), as low as fits.
    expect(window.innerHeight).toBe(768);
    expect(px(pin, 'top')).toBe(768 - 200 - 8 + window.scrollY);
    expect(px(pin, 'left')).toBe(100 + 80 + 8);

    // Without its text, the card pins where it is on screen.
    button(shadowOf(pin), 'Float on screen').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('fixed'));
    document.getElementById('b')?.remove();
    pin.getBoundingClientRect = () => new DOMRect(50, 60, 300, 150);
    button(shadowOf(pin), 'Pin to page').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('absolute'));
    expect(px(pin, 'top')).toBe(60 + window.scrollY);
    expect(px(pin, 'left')).toBe(50 + window.scrollX);
  });

  // Fix 10
  it('Escape closes the card from the page, from the card and from an empty zone search', async () => {
    const env = await load({ cardSize: 'full' });
    await convert(env, 'a');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(transientHost()).toBeNull();

    await convert(env, 'a2');
    const card = transient().querySelector('.tzx-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(transientHost()).toBeNull();

    await convert(env, 'a3');
    const input = transient().querySelector<HTMLInputElement>('input[role="combobox"]');
    if (!input) throw new Error('no zone search');
    input.focus();
    // First Escape clears the query; the card stays.
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).not.toBeNull();
    // Nothing left to clear or close: Escape closes the card.
    await vi.waitFor(() => expect(input.value).toBe(''));
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).toBeNull();
  });

  // Fix 12
  it('cascades a new pin against where other cards are now', async () => {
    const env = await load({});
    const a = await pinFrom(env, 'a');
    expect(px(a, 'top')).toBe(128);
    // The user dragged the first card away: the spot is free again.
    a.style.setProperty('top', '900px', 'important');
    const b = await pinFrom(env, 'a2');
    expect(px(b, 'top')).toBe(128);
    // Now a card does sit there. Round 6 (QA F6): the next one goes where
    // it covers no card and no card's text, instead of 72 px down-right
    // over it. Round 7: the nearest such spot to below its text, which is
    // right under that card (200 px tall while it cannot be measured, + 8:
    // 208 px away), not beside it (360 + 8 = 368 px away).
    const c = await pinFrom(env, 'a3');
    expect(px(c, 'top')).toBe(128 + 200 + 8);
    expect(px(c, 'left')).toBe(100);
  });

  // Fix 1 (keyboard reachability)
  it('focuses a new transient card when nothing else on the page has focus, without dropping the selection', async () => {
    const env = await load({});
    await convert(env, 'a');
    await vi.waitFor(() => expect(document.activeElement).toBe(transientHost()));
    expect(window.getSelection()?.toString()).toBe('1700000000');
  });

  it('leaves focus in a page field when the card opens', async () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="btn">x</button>');
    const env = await load({});
    (document.getElementById('btn') as HTMLButtonElement).focus();
    await convert(env, 'a');
    await sleep(20);
    expect(document.activeElement?.id).toBe('btn');
  });
});

// --- Popover on its own ------------------------------------------------------

const PREFS: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC'], hour12: false };

function parsed(text: string): ParsedTime {
  const p = parseTimes(text, { assumedZone: 'UTC', numericDateOrder: 'dmy' })[0];
  if (!p) throw new Error(`no match for ${text}`);
  return p;
}

/** WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (h: string): number => {
    const hex = h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

describe('Popover', () => {
  // Fix 1
  it('lets card text be selected but keeps the page selection on controls', () => {
    const { container } = render(
      <Popover parsed={parsed('1700000000')} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} onPin={() => {}} />,
    );
    const q = (s: string): Element => {
      const el = container.querySelector(s);
      if (!el) throw new Error(s);
      return el;
    };
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.mouseDown(q('.tzx-time'))).toBe(true);
    expect(fireEvent.mouseDown(q('.tzx-zone'))).toBe(true);
    expect(fireEvent.mouseDown(q('.tzx-src'))).toBe(true);
    expect(fireEvent.mouseDown(q('input'))).toBe(true);
    expect(fireEvent.mouseDown(q('button[aria-label="Pin to page"]'))).toBe(false);
    expect(fireEvent.mouseDown(q('button[aria-label="Pin to page"] svg'))).toBe(false);
    expect(fireEvent.mouseDown(q('.tzx-head'))).toBe(false);
    expect(fireEvent.mouseDown(q('.tzx-card'))).toBe(false);
  });

  // Fix 2
  it.each([
    ['03/04/2024 22:00 PDT'],
    ['03/04/2024 00:30 CET'],
  ])('labels the day/month readings of %s from the written date', (text) => {
    const p = parsed(text);
    expect(p.dateOrder).toBeDefined();
    const { container } = render(
      <Popover parsed={p} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} onDateOrder={() => {}} />,
    );
    const labels = Array.from(container.querySelectorAll('.tzx-order-btn')).map((b) => b.textContent);
    expect(labels).toEqual(['✓3 Apr 2024', 'Mar 4, 2024']);
  });

  // Fix 3
  it('offers a small day/month choice on compact cards, with the reading in use marked', () => {
    const onDateOrder = vi.fn();
    const { container } = render(
      <Popover
        parsed={parsed('03/04/2024 10:00')}
        matchCount={1}
        prefs={PREFS}
        pinned={false}
        compact
        onClose={() => {}}
        onDateOrder={onDateOrder}
      />,
    );
    const group = container.querySelector('.tzx-order.mini');
    expect(group).not.toBeNull();
    const btns = Array.from(group?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    expect(btns.map((b) => b.textContent)).toEqual(['✓3 Apr', 'Mar 4']);
    expect(btns.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(btns[0]?.classList.contains('on')).toBe(true);
    expect(btns[1]?.getAttribute('aria-label')).toBe('Mar 4, 2024, month first');
    expect(container.textContent).not.toMatch(/D\/M|M\/D/);
    btns[1]?.click();
    expect(onDateOrder).toHaveBeenCalledWith('mdy');
  });

  it('the selected day/month pill meets AA contrast in light and dark', () => {
    const { container } = render(
      <Popover parsed={parsed('03/04/2024 10:00')} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} onDateOrder={() => {}} />,
    );
    const css = container.querySelector('style')?.textContent ?? '';
    const rule = (selector: string): { bg: string; fg: string } => {
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(?:^|\\n)\\s*${esc} \\{ background: (#[0-9a-f]{3,6});[^}]*?; color: (#[0-9a-f]{3,6})`).exec(css);
      if (!m) throw new Error(`no rule ${selector}`);
      return { bg: m[1] as string, fg: m[2] as string };
    };
    const light = rule('.tzx-order-btn.on');
    const dark = rule(":host([data-tz-theme='dark']) .tzx-order-btn.on");
    expect(contrast(light.bg, light.fg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark.bg, dark.fg)).toBeGreaterThanOrEqual(4.5);
    // The unselected pill's text too.
    const darkOff = rule(":host([data-tz-theme='dark']) .tzx-order-btn");
    expect(contrast('#ffffff', '#5b5e68')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkOff.bg, darkOff.fg)).toBeGreaterThanOrEqual(4.5);
  });

  // Fix 11
  it('uses a short zone-search placeholder', () => {
    const { container } = render(
      <Popover parsed={parsed('1700000000')} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} />,
    );
    const placeholder = container.querySelector('input')?.getAttribute('placeholder') ?? '';
    expect(placeholder).toBe('+ Add zone: city, PDT, UTC+3');
    expect(placeholder.length).toBeLessThanOrEqual(30);
  });
});

// --- PinDock on its own -------------------------------------------------------

describe('PinDock focus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const props = {
    count: 0,
    compactCount: 0,
    floatingCount: 0,
    onMinimizeAll: () => {},
    onExpandAll: () => {},
    onTogglePlacementAll: () => {},
    onCloseAll: () => {},
  };

  it('focuses Undo, and after a timeout moves focus to the dock or lets it go without throwing', () => {
    vi.useFakeTimers();
    const onDismissUndo = vi.fn();
    const onUndo = vi.fn();
    const { rerender, unmount, getByRole } = render(
      <PinDock {...props} closed={2} onUndo={onUndo} onDismissUndo={onDismissUndo} />,
    );
    expect(document.activeElement).toBe(getByRole('button', { name: 'Undo' }));
    expect(getByRole('status').textContent).toBe('Closed 2 cards');
    expect(getByRole('group', { name: 'Closed cards' })).not.toHaveAttribute('aria-live');

    act(() => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    expect(onDismissUndo).toHaveBeenCalledTimes(1);
    // A card was pinned meanwhile, so the dock stays: focus lands on it.
    rerender(<PinDock {...props} count={1} closed={null} onUndo={onUndo} onDismissUndo={onDismissUndo} />);
    expect((document.activeElement as HTMLElement).classList.contains('count')).toBe(true);

    // Undo: focus moves to the restored dock.
    rerender(<PinDock {...props} count={1} closed={1} onUndo={onUndo} onDismissUndo={onDismissUndo} />);
    expect(document.activeElement).toBe(getByRole('button', { name: 'Undo' }));
    fireEvent.click(getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    rerender(<PinDock {...props} count={2} closed={null} onUndo={onUndo} onDismissUndo={onDismissUndo} />);
    expect((document.activeElement as HTMLElement).classList.contains('count')).toBe(true);

    // The offer times out with no cards left: the dock goes, focus falls back to the page.
    rerender(<PinDock {...props} closed={2} onUndo={onUndo} onDismissUndo={onDismissUndo} />);
    act(() => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    expect(() => unmount()).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });
});
