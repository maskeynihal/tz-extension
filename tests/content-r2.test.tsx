import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Popover, wallClockNote } from '../src/content/Popover';
import { PinDock, UNDO_MS, UNDO_MAX_MS } from '../src/content/PinDock';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

/**
 * Round-2 fixes for the content script: Escape in the capture phase, the
 * floating-card layout, the undo offer's timeout, card width across
 * placements, anchoring below a wrapped selection, and the DST note.
 */

const KEY = 'tz-extension-prefs';
type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown;

/** Rect of a page range: from the `data-top` of the element holding it; zero when collapsed. */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  return new DOMRect(100, top, 80, 20);
}

async function load(initial: Record<string, unknown>): Promise<Listener> {
  const data: Record<string, unknown> = { homeZone: 'UTC', targetZones: ['UTC'], hour12: false, ...initial };
  const listeners: Listener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: { get: vi.fn(async () => ({ [KEY]: data })), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
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
  await new Promise((r) => setTimeout(r, 0));
  return listener;
}

const shadowOf = (el: Element | null | undefined): ShadowRoot => {
  const root = (el as HTMLElement | null)?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
};
const transientHost = (): HTMLElement | null => document.getElementById('tz-extension-popover-host');
const transient = (): ShadowRoot => shadowOf(transientHost());
const pinHosts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host'));
const dock = (): ShadowRoot => shadowOf(document.getElementById('tz-extension-pin-dock'));
const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};

async function convert(listener: Listener, id: string): Promise<void> {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const respond = vi.fn();
  listener({ type: 'tzx/convert-selection', text: el.textContent ?? '' }, { id: 'ext-id' }, respond);
  await vi.waitFor(() => expect(respond).toHaveBeenCalled());
  await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
}

async function pinFrom(listener: Listener, id: string): Promise<HTMLElement> {
  const before = pinHosts().length;
  await convert(listener, id);
  button(transient(), 'Pin to page').click();
  await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
  const host = pinHosts().at(-1) as HTMLElement;
  await vi.waitFor(() => expect(host.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  return host;
}

const PAGE = `
  <p id="a" data-top="100">1700000000</p>
  <p id="b" data-top="300">2024-01-02T10:00:00Z</p>
  <p id="c" data-top="500">2024-05-06T07:08:09Z</p>`;

/** A page listener that swallows Escape before it reaches the document. */
const swallowEscape = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') e.stopPropagation();
};

describe('content script, round 2', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 2000, configurable: true });
  });
  afterEach(() => {
    document.body.removeEventListener('keydown', swallowEscape);
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
  });

  // Fix 1
  it('Escape closes the focused card even when the page stops Escape on body', async () => {
    const listener = await load({ cardSize: 'full' });
    document.body.addEventListener('keydown', swallowEscape);

    await convert(listener, 'a');
    const card = transient().querySelector('.tzx-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(transientHost()).toBeNull();

    // From the zone search: the first Escape only clears the text.
    await convert(listener, 'b');
    const input = transient().querySelector<HTMLInputElement>('input[role="combobox"]');
    if (!input) throw new Error('no zone search');
    input.focus();
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).not.toBeNull();
    await vi.waitFor(() => expect(input.value).toBe(''));
    await vi.waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('false'));
    // Empty, list shut: the next Escape closes the card despite the page.
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).toBeNull();
  });

  it('an Escape in an empty zone search with its list open closes the list first', async () => {
    const listener = await load({ cardSize: 'full' });
    document.body.addEventListener('keydown', swallowEscape);
    await convert(listener, 'a');
    const input = transient().querySelector<HTMLInputElement>('input[role="combobox"]');
    if (!input) throw new Error('no zone search');
    input.focus();
    fireEvent.click(input);
    await vi.waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'));
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).not.toBeNull();
    await vi.waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('false'));
    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
    expect(transientHost()).toBeNull();
  });

  // Fix 4
  it('a card keeps its width when it floats and pins back; a size change lets it resize', async () => {
    const listener = await load({});
    const pin = await pinFrom(listener, 'a');
    pin.getBoundingClientRect = () => new DOMRect(100, 128, 245.4, 180);
    button(shadowOf(pin), 'Float on screen').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('fixed'));
    expect(pin.style.getPropertyValue('width')).toBe('246px');
    // It would be wider now (the "floating" tag); the fixed width holds.
    pin.getBoundingClientRect = () => new DOMRect(100, 128, 246, 180);
    button(shadowOf(pin), 'Pin to page').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('absolute'));
    expect(pin.style.getPropertyValue('width')).toBe('246px');

    button(shadowOf(pin), 'Make compact').click();
    await vi.waitFor(() => expect(shadowOf(pin).querySelector('.tzx-card.compact')).not.toBeNull());
    expect(pin.style.getPropertyValue('width')).toBe('');

    // "Unpin all" fixes the width too, and Undo after "Close all" restores it.
    pin.getBoundingClientRect = () => new DOMRect(100, 128, 200, 120);
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(pin.style.getPropertyValue('position')).toBe('fixed'));
    expect(pin.style.getPropertyValue('width')).toBe('200px');
    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    Array.from(dock().querySelectorAll('button'))
      .find((x) => x.textContent?.includes('Undo'))
      ?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    expect(pinHosts()[0]?.style.getPropertyValue('width')).toBe('200px');
  });

  // Fix 2 (wiring): "Unpin all" never stacks cards on one spot.
  it('"Unpin all" spreads cards that would land on the same spot', async () => {
    const listener = await load({});
    const hosts = [await pinFrom(listener, 'a'), await pinFrom(listener, 'b'), await pinFrom(listener, 'c')];
    // All three are near the bottom of the screen, so clamping alone would stack them.
    const vh = window.innerHeight;
    for (const h of hosts) h.getBoundingClientRect = () => new DOMRect(100, vh - 100, 245, 200);
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
    const spots = hosts.map((h) => `${h.style.getPropertyValue('top')},${h.style.getPropertyValue('left')}`);
    expect(new Set(spots).size).toBe(3);
  });

  // Fix 5
  it('anchors the card below the last line of a selection that wraps', async () => {
    const listener = await load({});
    // The first line's box, as some engines report for the whole range, and
    // the range's two line boxes.
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      return this.collapsed ? new DOMRect(0, 0, 0, 0) : new DOMRect(100, 100, 200, 20);
    };
    (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = function (
      this: Range,
    ): DOMRect[] {
      return this.collapsed ? [] : [new DOMRect(100, 100, 200, 20), new DOMRect(8, 124, 150, 20)];
    };
    await convert(listener, 'a');
    expect(parseFloat(transientHost()?.style.getPropertyValue('top') ?? '')).toBe(144 + 8);
    expect(parseFloat(transientHost()?.style.getPropertyValue('left') ?? '')).toBe(8);
  });
});

// --- Layout of floating cards ---------------------------------------------------

describe('layoutFloating', () => {
  type Box = { top: number; left: number; width: number; height: number };
  // Round 3: the whole header row (FLOAT_HEADER, the default) is protected, not a 24 px corner.
  const header = 40;
  const hits = (a: Box, b: Box): boolean =>
    a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

  /**
   * Every card's header row is uncovered by the cards painted above it; all
   * on screen and clear of the dock. With 15 cards at 390 px there is no room
   * to keep every body clear of the dock too (14 header steps + a card is
   * 820 px, 776 px are free above the dock), so there only headers must be.
   */
  function check(boxes: Box[], vw: number, vh: number, dock: Box): void {
    const tight = vw === 390 && boxes.length === 15;
    boxes.forEach((b, i) => {
      expect(b.left).toBeGreaterThanOrEqual(8);
      expect(b.top).toBeGreaterThanOrEqual(8);
      expect(b.left + b.width).toBeLessThanOrEqual(vw - 8);
      expect(b.top + b.height).toBeLessThanOrEqual(vh - 8);
      expect(hits(tight ? { ...b, height: header } : b, dock)).toBe(false);
      for (const later of boxes.slice(i + 1)) {
        expect(hits(later, { top: b.top, left: b.left, width: b.width, height: header })).toBe(false);
        // Never exactly on top of another.
        expect(later.top === b.top && later.left === b.left).toBe(false);
      }
    });
  }

  const cases = [
    { vw: 390, vh: 844, w: 245, h: 260, n: 5 },
    { vw: 390, vh: 844, w: 245, h: 260, n: 15 },
    { vw: 1280, vh: 800, w: 311, h: 300, n: 5 },
    { vw: 1280, vh: 800, w: 311, h: 300, n: 15 },
  ];

  it.each(cases)('$n cards at $vw×$vh, all wanting the same spot', async ({ vw, vh, w, h, n }) => {
    const { layoutFloating } = await import('../src/content/index');
    const dockBox = { top: vh - 52, left: vw - 216, width: 200, height: 36 };
    const dock = { top: dockBox.top, left: dockBox.left, right: dockBox.left + 200, bottom: dockBox.top + 36 };
    // Every card was clamped to the same place (the round-2 QA report: 4–6 at (97,479)).
    const wanted = Array.from({ length: n }, () => ({ top: 479, left: 97, width: w, height: h }));
    const at = layoutFloating(wanted, { width: vw, height: vh }, dock);
    check(
      at.map((p) => ({ ...p, width: w, height: h })),
      vw,
      vh,
      dockBox,
    );
  });

  it.each(cases)('$n cards at $vw×$vh, wanting spread-out spots on and off screen', async ({ vw, vh, w, h, n }) => {
    const { layoutFloating } = await import('../src/content/index');
    const dockBox = { top: vh - 52, left: vw - 216, width: 200, height: 36 };
    const dock = { top: dockBox.top, left: dockBox.left, right: dockBox.left + 200, bottom: dockBox.top + 36 };
    const wanted = Array.from({ length: n }, (_, i) => ({ top: 40 + i * 70, left: 20 + (i % 3) * 30, width: w, height: h }));
    const at = layoutFloating(wanted, { width: vw, height: vh }, dock);
    check(
      at.map((p) => ({ ...p, width: w, height: h })),
      vw,
      vh,
      dockBox,
    );
  });

  it('keeps a card where it is when nothing is in its way', async () => {
    const { layoutFloating } = await import('../src/content/index');
    const at = layoutFloating(
      [
        { top: 50, left: 50, width: 300, height: 200 },
        { top: 400, left: 600, width: 300, height: 200 },
      ],
      { width: 1280, height: 800 },
      null,
    );
    expect(at).toEqual([
      { top: 50, left: 50 },
      { top: 400, left: 600 },
    ]);
  });

  // Round 3: the FLOAT_STEP diagonal cascade (82,82) still covered the first
  // card's header row; the card now goes to the nearest spot that clears it,
  // just under that header (40 px + a 2 px gap).
  it('moves a card that would hide another one just below that header', async () => {
    const { layoutFloating, FLOAT_HEADER } = await import('../src/content/index');
    const at = layoutFloating(
      [
        { top: 50, left: 50, width: 300, height: 200 },
        { top: 50, left: 50, width: 300, height: 200 },
      ],
      { width: 1280, height: 800 },
      null,
    );
    expect(at[1]).toEqual({ top: 50 + FLOAT_HEADER + 2, left: 50 });
  });

  it('measures a selection by all its lines', async () => {
    const { selectionRect } = await import('../src/content/index');
    const range = {
      getBoundingClientRect: () => new DOMRect(100, 100, 200, 20),
      getClientRects: () => [new DOMRect(100, 100, 200, 20), new DOMRect(8, 124, 150, 20)],
    } as unknown as Range;
    const r = selectionRect(range);
    expect([r.left, r.top, r.right, r.bottom]).toEqual([8, 100, 300, 144]);
  });
});

// --- The undo offer's timeout ---------------------------------------------------

describe('PinDock undo offer', () => {
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
    onUndo: () => {},
  };
  const pointer = (el: Element, type: string, x: number, y: number): void => {
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: type === 'pointermove' }));
  };
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('a pointer resting where the toast appeared does not hold it', () => {
    vi.useFakeTimers();
    const onDismissUndo = vi.fn();
    const { getByRole } = render(<PinDock {...props} closed={2} onDismissUndo={onDismissUndo} />);
    const bar = getByRole('group', { name: 'Closed cards' });
    // The toast appears under the pointer: enter, and a move event at the same spot.
    pointer(bar, 'pointerenter', 300, 700);
    pointer(bar, 'pointermove', 300, 700);
    expect(bar).not.toHaveAttribute('data-paused');
    advance(UNDO_MS);
    expect(onDismissUndo).toHaveBeenCalledTimes(1);
  });

  it('a real move over the dock holds the offer, for at most UNDO_MAX_MS', () => {
    vi.useFakeTimers();
    const onDismissUndo = vi.fn();
    const { getByRole } = render(<PinDock {...props} closed={2} onDismissUndo={onDismissUndo} />);
    const bar = getByRole('group', { name: 'Closed cards' });
    advance(1000);
    pointer(bar, 'pointerenter', 300, 700);
    pointer(bar, 'pointermove', 304, 700);
    expect(bar).toHaveAttribute('data-paused');
    advance(20_000);
    expect(onDismissUndo).not.toHaveBeenCalled();
    advance(UNDO_MAX_MS - 21_000 - 1);
    expect(onDismissUndo).not.toHaveBeenCalled();
    advance(1);
    expect(onDismissUndo).toHaveBeenCalledTimes(1);
  });

  it('leaving the dock resumes the countdown where it stopped', () => {
    vi.useFakeTimers();
    const onDismissUndo = vi.fn();
    const { getByRole } = render(<PinDock {...props} closed={1} onDismissUndo={onDismissUndo} />);
    const bar = getByRole('group', { name: 'Closed cards' });
    advance(2000);
    pointer(bar, 'pointermove', 10, 10);
    advance(10_000);
    pointer(bar, 'pointerleave', 500, 10);
    expect(bar).not.toHaveAttribute('data-paused');
    advance(UNDO_MS - 2000 - 1);
    expect(onDismissUndo).not.toHaveBeenCalled();
    advance(1);
    expect(onDismissUndo).toHaveBeenCalledTimes(1);
  });

  it('the programmatic focus on Undo does not hold it; the user moving focus does, up to the cap', () => {
    vi.useFakeTimers();
    const onDismissUndo = vi.fn();
    const first = render(<PinDock {...props} closed={1} onDismissUndo={onDismissUndo} />);
    expect(document.activeElement).toBe(first.getByRole('button', { name: 'Undo' }));
    advance(UNDO_MS);
    expect(onDismissUndo).toHaveBeenCalledTimes(1);
    first.unmount();

    const onDismiss2 = vi.fn();
    const { getByRole } = render(<PinDock {...props} closed={1} onDismissUndo={onDismiss2} />);
    // Tab from Undo to Dismiss.
    getByRole('button', { name: 'Dismiss' }).focus();
    advance(UNDO_MAX_MS - 1);
    expect(onDismiss2).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss2).toHaveBeenCalledTimes(1);
  });
});

// --- DST note -------------------------------------------------------------------

const PREFS: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'UTC',
  targetZones: ['America/New_York'],
  hour12: false,
};

function wall(epochMs: number, wallClock: 'gap' | 'ambiguous', zone: 'source' | 'assumed'): ParsedTime {
  return {
    epochMs,
    matchedText: 'x',
    sourceZone: zone === 'source' ? 'ET (America/New_York)' : null,
    assumedZone: zone === 'source' ? 'UTC' : 'America/New_York',
    assumed: zone === 'assumed',
    kind: 'datetime-no-tz',
    wallClock,
  };
}

// 2024-03-10 02:30 in New York never happened: read with EST (-05:00) it is
// 07:30Z, which New York shows as 03:30 EDT.
const GAP = Date.UTC(2024, 2, 10, 7, 30);
// 2024-11-03 01:30 in New York happened twice; the first is 05:30Z (EDT).
const AMBIGUOUS = Date.UTC(2024, 10, 3, 5, 30);

describe('DST note', () => {
  it.each(['source', 'assumed'] as const)('explains a time in a DST gap (%s zone)', (zone) => {
    expect(wallClockNote(wall(GAP, 'gap', zone), false)).toBe(
      "02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30.",
    );
  });

  it('explains a time that happens twice', () => {
    expect(wallClockNote(wall(AMBIGUOUS, 'ambiguous', 'source'), false)).toBe(
      '01:30 happens twice on 3 Nov in New York; showing the first (EDT).',
    );
  });

  it('follows the 12-hour setting and says nothing for ordinary times', () => {
    expect(wallClockNote(wall(GAP, 'gap', 'source'), true)).toBe(
      "2:30 AM doesn't exist on 10 Mar in New York (clocks jump forward); shown as 3:30 AM.",
    );
    expect(wallClockNote({ ...wall(GAP, 'gap', 'source'), wallClock: undefined }, false)).toBeNull();
  });

  it('shows the note in a full card and a DST badge in a compact one', () => {
    const p = wall(GAP, 'gap', 'source');
    const note = "02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30.";
    const full = render(<Popover parsed={p} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} />);
    expect(full.container.querySelector('.tzx-dst')?.textContent).toBe(note);
    full.unmount();

    const compact = render(<Popover parsed={p} matchCount={1} prefs={PREFS} pinned={false} compact onClose={() => {}} />);
    expect(compact.container.querySelector('.tzx-dst')).toBeNull();
    const badge = compact.getByRole('img', { name: note });
    expect(badge.textContent).toBe('DST');
    expect(badge.getAttribute('title')).toBe(note);
    compact.unmount();

    const amb = render(
      <Popover parsed={wall(AMBIGUOUS, 'ambiguous', 'source')} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} />,
    );
    expect(amb.container.querySelector('.tzx-dst')?.textContent).toBe(
      '01:30 happens twice on 3 Nov in New York; showing the first (EDT).',
    );
  });

  it('no card shows an offset with a Unicode minus', () => {
    const r = render(<Popover parsed={wall(GAP, 'gap', 'source')} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} />);
    const offsets = Array.from(r.container.querySelectorAll('.tzx-off')).map((e) => e.textContent ?? '');
    expect(offsets).toContain('-04:00');
    expect(offsets.join('')).not.toContain('\u2212');
  });
});

// Fix 7: offsets come from tz.ts; the content script hard-codes no "−".
describe('display minus', () => {
  it('no content-script source writes a Unicode minus', () => {
    const dir = resolve(__dirname, '../src/content');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(resolve(dir, f), 'utf8').includes('\u2212'), f).toBe(false);
    }
  });
});
