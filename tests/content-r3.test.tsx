import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

/**
 * Round-3 fixes for the content script: "Unpin all" keeps every card's whole
 * header row clear, "Pin all" puts each card back by its own source, "Expand"
 * gives a card back its full-size width, and closing a card from the
 * keyboard gives focus back to the page.
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
const px = (el: HTMLElement, prop: 'top' | 'left'): number => parseFloat(el.style.getPropertyValue(prop));

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

/**
 * Give a card host a layout, as a browser would: its box is where its style
 * puts it (page coordinates when pinned, viewport when floating; the page is
 * not scrolled), `width` wide (the fixed width when it has one) and
 * `height` tall.
 */
function layOut(host: HTMLElement, natural: () => number, height = 313): void {
  host.getBoundingClientRect = () => {
    const fixed = parseFloat(host.style.getPropertyValue('width'));
    const w = Number.isFinite(fixed) ? fixed : natural();
    return new DOMRect(px(host, 'left') || 0, px(host, 'top') || 0, w, height);
  };
}

async function pinFrom(listener: Listener, id: string, natural: () => number = () => 245): Promise<HTMLElement> {
  const before = pinHosts().length;
  await convert(listener, id);
  button(transient(), 'Pin to page').click();
  await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
  const host = pinHosts().at(-1) as HTMLElement;
  await vi.waitFor(() => expect(host.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  layOut(host, natural);
  return host;
}

/** Five dates 138 px apart, as in the round-3 QA report. */
const PAGE = [0, 1, 2, 3, 4]
  .map((i) => `<p id="p${i}" data-top="${77 + i * 138}">2024-01-${10 + i}T12:00:00Z</p>`)
  .join('');

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

describe('content script, round 3', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 2000, configurable: true });
  });
  afterEach(() => {
    setViewport(view.w, view.h);
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
  });

  // QA #2
  it.each([390, 1280])('at %i px, "Pin all to page" puts each card back next to its own date', async (width) => {
    setViewport(width, 800);
    const listener = await load({ cardSize: 'full' });
    const hosts: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) hosts.push(await pinFrom(listener, `p${i}`));
    // Below each date: its bottom (top + 20) + 8.
    const anchors = [0, 1, 2, 3, 4].map((i) => 77 + i * 138 + 28);
    expect(hosts.map((h) => px(h, 'top'))).toEqual(anchors);

    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
    // The last two float right where the third and fourth cards' own spots
    // are (as at 390 px in the QA report): putting those back must not step
    // off where they float now.
    for (const [i, at] of [
      [4, anchors[2]],
      [3, anchors[3]],
    ] as const) {
      hosts[i]?.style.setProperty('top', `${(at ?? 0) + 10}px`, 'important');
      hosts[i]?.style.setProperty('left', '110px', 'important');
    }
    button(dock(), 'Pin all to page').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));
    expect(hosts.map((h) => px(h, 'top'))).toEqual(anchors);
    expect(hosts.map((h) => px(h, 'left'))).toEqual([100, 100, 100, 100, 100]);
  });

  it('"Pin all to page" still steps a card off one already put back on the same spot', async () => {
    setViewport(390, 800);
    document.body.innerHTML = '<p id="a" data-top="100">1700000000</p><p id="b" data-top="100">1600000000</p>';
    const listener = await load({ cardSize: 'full' });
    const a = await pinFrom(listener, 'a');
    const b = await pinFrom(listener, 'b');
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(b.style.getPropertyValue('position')).toBe('fixed'));
    button(dock(), 'Pin all to page').click();
    await vi.waitFor(() => expect(b.style.getPropertyValue('position')).toBe('absolute'));
    expect([px(a, 'top'), px(a, 'left')]).toEqual([128, 100]);
    // 36 px a step, until 48 px clear of it: two steps.
    expect([px(b, 'top'), px(b, 'left')]).toEqual([128 + 72, 100 + 72]);
  });

  // Review #4: the layout uses the height a card has once it floats.
  it('"Unpin all" lays cards out at their floating height, so none ends below the screen', async () => {
    setViewport(1280, 800);
    const listener = await load({ cardSize: 'full' });
    const hosts: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) hosts.push(await pinFrom(listener, `p${i}`));
    // Once floating, the card is 60 px taller.
    for (const h of hosts) {
      const flat = h.getBoundingClientRect.bind(h);
      h.getBoundingClientRect = () => {
        const r = flat();
        const floating = !!h.shadowRoot?.querySelector('.tzx-card.floating');
        return new DOMRect(r.left, r.top, r.width, floating ? 373 : 313);
      };
    }
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
    for (const h of hosts) expect(px(h, 'top') + 373).toBeLessThanOrEqual(800 - 8);
  });

  // QA #3
  it('"Expand all" and "Expand card" give a card back the width it had at full size', async () => {
    setViewport(1280, 800);
    const listener = await load({ cardSize: 'full' });
    // A card's natural width can change while it is compact (the page
    // reflows, or it moved): at full size it now would be 311 px.
    let natural = 245;
    const a = await pinFrom(listener, 'p0', () => natural);
    const b = await pinFrom(listener, 'p1', () => natural);
    const width = (h: HTMLElement): number => h.getBoundingClientRect().width;

    button(dock(), 'Minimize all').click();
    await vi.waitFor(() => expect(shadowOf(a).querySelector('.tzx-card.compact')).not.toBeNull());
    expect(a.style.getPropertyValue('width')).toBe('');
    natural = 311;
    button(dock(), 'Expand all').click();
    await vi.waitFor(() => expect(shadowOf(a).querySelector('.tzx-card.compact')).toBeNull());
    expect([width(a), width(b)]).toEqual([245, 245]);

    // One card, floating, by its own button.
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(a.style.getPropertyValue('position')).toBe('fixed'));
    button(shadowOf(a), 'Make compact').click();
    await vi.waitFor(() => expect(shadowOf(a).querySelector('.tzx-card.compact')).not.toBeNull());
    natural = 330;
    button(shadowOf(a), 'Expand card').click();
    await vi.waitFor(() => expect(shadowOf(a).querySelector('.tzx-card.compact')).toBeNull());
    expect(width(a)).toBe(245);

    // Close all → Undo keeps it: a compact card restored and expanded gets 245 back.
    button(dock(), 'Minimize all').click();
    await vi.waitFor(() => expect(shadowOf(a).querySelector('.tzx-card.compact')).not.toBeNull());
    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    Array.from(dock().querySelectorAll('button'))
      .find((x) => x.textContent?.includes('Undo'))
      ?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(2));
    const restored = pinHosts();
    for (const h of restored) layOut(h, () => natural);
    await vi.waitFor(() => expect(shadowOf(restored[0]).querySelector('.tzx-card.compact')).not.toBeNull());
    button(dock(), 'Expand all').click();
    await vi.waitFor(() => expect(shadowOf(restored[0]).querySelector('.tzx-card.compact')).toBeNull());
    expect(restored.map(width)).toEqual([245, 245]);
  });

  // QA #10
  describe('focus after closing a card from the keyboard', () => {
    const escape = (el: Element): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    };

    it('Escape on a card button gives focus back to the page control it came from', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button id="f">Notes</button>');
      const listener = await load({ cardSize: 'full' });
      const f = document.getElementById('f') as HTMLButtonElement;
      f.focus();
      await convert(listener, 'p0');
      expect(document.activeElement).toBe(f);
      // Tab from the page into the card.
      const pin = button(transient(), 'Pin to page');
      pin.focus();
      expect(document.activeElement).toBe(transientHost());
      escape(pin);
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(f);
    });

    it('Escape in the zone search does the same', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button id="f">Notes</button>');
      const listener = await load({ cardSize: 'full' });
      const f = document.getElementById('f') as HTMLButtonElement;
      f.focus();
      await convert(listener, 'p0');
      const input = transient().querySelector<HTMLInputElement>('input[role="combobox"]');
      if (!input) throw new Error('no zone search');
      input.focus();
      // Focus opens the list: the first Escape shuts it, the next closes the card.
      await vi.waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('true'));
      fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
      await vi.waitFor(() => expect(input.getAttribute('aria-expanded')).toBe('false'));
      expect(transientHost()).not.toBeNull();
      fireEvent.keyDown(input, { key: 'Escape', bubbles: true, composed: true });
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(f);
    });

    it('the close button gives focus back too', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button id="f">Notes</button>');
      const listener = await load({ cardSize: 'full' });
      const f = document.getElementById('f') as HTMLButtonElement;
      f.focus();
      await convert(listener, 'p0');
      const close = button(transient(), 'Close');
      close.focus();
      close.click();
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(f);
    });

    it('leaves focus on the body when that control is gone, or the card took focus from no one', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button id="f">Notes</button>');
      const listener = await load({ cardSize: 'full' });
      const f = document.getElementById('f') as HTMLButtonElement;
      f.focus();
      await convert(listener, 'p0');
      button(transient(), 'Pin to page').focus();
      f.remove();
      const scroll = vi.spyOn(window, 'scrollTo');
      escape(button(transient(), 'Pin to page'));
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(document.body);

      // Nothing had focus: the card takes it on opening, and gives it to no one.
      await convert(listener, 'p1');
      await vi.waitFor(() => expect(document.activeElement).toBe(transientHost()));
      escape(transient().querySelector('.tzx-card') as HTMLElement);
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(document.body);
      expect(scroll).not.toHaveBeenCalled();
      scroll.mockRestore();
    });

    it('an Escape pressed in the page while the card is open leaves focus where it is', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button id="f">Notes</button><button id="g">Other</button>');
      const listener = await load({ cardSize: 'full' });
      const f = document.getElementById('f') as HTMLButtonElement;
      const g = document.getElementById('g') as HTMLButtonElement;
      f.focus();
      await convert(listener, 'p0');
      button(transient(), 'Pin to page').focus();
      g.focus();
      escape(g);
      expect(transientHost()).toBeNull();
      expect(document.activeElement).toBe(g);
    });
  });
});

// --- Layout of floating cards: whole header rows ------------------------------

describe('layoutFloating keeps every header button clear', () => {
  type Box = { top: number; left: number; width: number; height: number; header: number };
  const inside = (x: number, y: number, b: Box): boolean =>
    x > b.left && x < b.left + b.width && y > b.top && y < b.top + b.height;
  const hits = (a: Box, b: { top: number; left: number; width: number; height: number }): boolean =>
    a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

  /**
   * A card's header controls as laid out in Chrome: the grip at the left and
   * three 24 px buttons at the right (inside 1 px border + 12 px padding), all
   * on the header row's middle line.
   */
  function headerCentres(b: Box): Array<[number, number]> {
    const y = b.top + 11 + (b.header - 11) / 2;
    const right = b.left + b.width - 13;
    return [[b.left + 18, y], [right - 12, y], [right - 36, y], [right - 60, y]];
  }

  function check(boxes: Box[], vw: number, vh: number, dock: { top: number; left: number; right: number; bottom: number }): void {
    const dockBox = { top: dock.top, left: dock.left, width: dock.right - dock.left, height: dock.bottom - dock.top };
    boxes.forEach((b, i) => {
      expect(b.left).toBeGreaterThanOrEqual(8);
      expect(b.top).toBeGreaterThanOrEqual(8);
      expect(b.left + b.width).toBeLessThanOrEqual(vw - 8);
      expect(b.top + b.height).toBeLessThanOrEqual(vh - 8);
      expect(hits({ ...b, height: b.header }, dockBox), `card ${i} header under the dock`).toBe(false);
      for (const [j, later] of boxes.entries()) {
        if (j <= i) continue;
        for (const [x, y] of headerCentres(b)) {
          expect(inside(x, y, later), `card ${i} button at ${x},${y} under card ${j}`).toBe(false);
        }
        // The whole header row, not only the button centres.
        expect(hits(later, { ...b, height: b.header }), `card ${i} header under card ${j}`).toBe(false);
      }
    });
  }

  // Sizes measured in Chrome: 245 × 313 with a 31 px header; a wider, taller card too.
  const sizes = [
    { w: 245, h: 313, head: 31 },
    { w: 311, h: 360, head: 31 },
  ];
  const views = [
    { vw: 390, vh: 844 },
    { vw: 1280, vh: 800 },
  ];
  const cases = sizes.flatMap((s) => views.flatMap((v) => [5, 15].map((n) => ({ ...s, ...v, n }))));

  const wants = {
    // Pinned 138 px apart from y = 97: the lower ones are clamped onto each other.
    'the QA page': (i: number) => ({ top: 97 + i * 138, left: 22 }),
    'one spot': () => ({ top: 479, left: 97 }),
    // Scrolled away: gathered near the top right.
    'the top right': (i: number, vw: number, w: number) => ({ top: 64 + i * 32, left: vw - w - 24 - i * 32 }),
  } as const;

  for (const [name, want] of Object.entries(wants)) {
    it.each(cases)(`$n cards of $w×$h at $vw×$vh wanting ${name}`, async ({ w, h, head, vw, vh, n }) => {
      const { layoutFloating } = await import('../src/content/index');
      const dock = { top: vh - 54, left: vw - 225, right: vw - 16, bottom: vh - 16 };
      const cards = Array.from({ length: n }, (_, i) => ({ ...want(i, vw, w), width: w, height: h, header: head }));
      const at = layoutFloating(cards, { width: vw, height: vh }, dock);
      check(
        at.map((p) => ({ ...p, width: w, height: h, header: head })),
        vw,
        vh,
        dock,
      );
    });
  }

  it('keeps cards that are clear of each other where they are', async () => {
    const { layoutFloating } = await import('../src/content/index');
    const cards = [0, 1, 2].map((i) => ({ top: 97 + i * 138, left: 22, width: 245, height: 313, header: 31 }));
    expect(layoutFloating(cards, { width: 1280, height: 800 }, null)).toEqual([
      { top: 97, left: 22 },
      { top: 235, left: 22 },
      { top: 373, left: 22 },
    ]);
  });

  it('a card may cover the body of the card under it, never its header', async () => {
    const { layoutFloating } = await import('../src/content/index');
    const at = layoutFloating(
      [
        { top: 100, left: 22, width: 245, height: 313, header: 31 },
        { top: 110, left: 22, width: 245, height: 313, header: 31 },
      ],
      { width: 390, height: 844 },
      null,
    );
    expect(at[1]).toEqual({ top: 100 + 31 + 2, left: 22 });
  });

  it('is quick enough to run on every click', async () => {
    const { layoutFloating } = await import('../src/content/index');
    const cards = Array.from({ length: 15 }, (_, i) => ({ top: 64 + i * 32, left: 1000 - i * 32, width: 245, height: 313, header: 31 }));
    const t0 = performance.now();
    layoutFloating(cards, { width: 1280, height: 800 }, { top: 746, left: 1055, right: 1264, bottom: 784 });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
