import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';

/**
 * Round-8 fixes for the content script: text in panes scrolled the
 * negative way (a `column-reverse` chat scrolled up, right-to-left panes and
 * pages scrolled sideways) is listed, while positioned off-page text is still
 * left out; a stepped pin never jumps off screen; a new pin is scrolled into
 * view and uses the free columns right of other pins; and "Pin all to page"
 * after scrolling away puts each card back by its own text.
 */

const KEY = 'tz-extension-prefs';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

/** The window's scroll, as the mocks below and `window.scrollX/Y` report it. */
const scroll = { x: 0, y: 0 };

/**
 * Rect of a page range: `data-top` / `data-left` (page coordinates) of the
 * element holding it, less the window's scroll, `data-w` wide (80) and 20
 * tall; zero when collapsed.
 */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  const left = Number(el?.closest('[data-left]')?.getAttribute('data-left') ?? 100);
  const w = Number(el?.closest('[data-w]')?.getAttribute('data-w') ?? 80);
  return new DOMRect(left - scroll.x, top - scroll.y, w, 20);
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

async function load(initial: Record<string, unknown> = {}): Promise<void> {
  const data: Record<string, unknown> = {
    homeZone: 'UTC',
    targetZones: ['UTC'],
    hour12: false,
    cardSize: 'full',
    keepSelection: true,
    ...initial,
  };
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
  await new Promise((r) => setTimeout(r, 0));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const transientHost = (): HTMLElement | null => document.getElementById('tz-extension-popover-host');
const transient = (): ShadowRoot => {
  const root = transientHost()?.shadowRoot;
  if (!root) throw new Error('no transient card');
  return root;
};
const pinHosts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host'));
const dock = (): ShadowRoot => {
  const root = document.getElementById('tz-extension-pin-dock')?.shadowRoot;
  if (!root) throw new Error('no dock');
  return root;
};
const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};
const live = (root: ShadowRoot = transient()): string => root.querySelector('[aria-live="polite"]')?.textContent ?? '';
const quoted = (root: ShadowRoot = transient()): string => root.querySelector('.tzx-src span')?.textContent ?? '';
const marked = (name: string): Range | undefined => highlights.get(name)?.ranges[0];
const px = (el: HTMLElement, prop: 'top' | 'left'): number => parseFloat(el.style.getPropertyValue(prop));
const where = (h: HTMLElement): string => `${px(h, 'left')},${px(h, 'top')}`;

/** Select an element's text and release the mouse, as a user's drag would end. */
async function select(id: string, expectCard = true): Promise<void> {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
  if (expectCard) await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  else await sleep(320);
}

function mouseClick(el: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
}

function closeCard(): void {
  transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
}

/** The document's scroll area, as a browser reports it. */
function setDocumentSize(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
}

/** Scroll the window (negative x on a right-to-left page), as a browser would report it. */
function scrollWindow(x: number, y: number): void {
  scroll.x = x;
  scroll.y = y;
}

/**
 * Pinned hosts measure `size(index)` (245×313 by default) where their style
 * puts them: page coordinates less the window's scroll, or viewport
 * coordinates when floating.
 */
function layOutPins(size: (i: number) => { w: number; h: number } = () => ({ w: 245, h: 313 })): void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (!this.classList.contains('tz-extension-pin-host')) return real.call(this);
    const i = pinHosts().indexOf(this);
    const s = size(i < 0 ? pinHosts().length : i);
    const locked = parseFloat(this.style.getPropertyValue('width'));
    const left = parseFloat(this.style.getPropertyValue('left')) || 0;
    const top = parseFloat(this.style.getPropertyValue('top')) || 0;
    const fixed = this.style.getPropertyValue('position') === 'fixed';
    const w = Number.isFinite(locked) ? locked : s.w;
    return new DOMRect(fixed ? left : left - scroll.x, fixed ? top : top - scroll.y, w, s.h);
  };
  onTestFinished(() => {
    HTMLElement.prototype.getBoundingClientRect = real;
  });
}

/**
 * `scrollIntoView` as a browser does it for `block: 'nearest'`: the least
 * window scroll that brings the element's box into view, then a scroll
 * event a moment later. Calls are recorded.
 */
function fakeScrollIntoView(): Array<{ el: Element; opts: unknown }> {
  const calls: Array<{ el: Element; opts: unknown }> = [];
  const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView');
  const real = (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  (Element.prototype as unknown as { scrollIntoView: (o?: unknown) => void }).scrollIntoView = function (this: Element, opts?: unknown) {
    calls.push({ el: this, opts });
    const b = this.getBoundingClientRect();
    const vh = window.innerHeight;
    const dy = b.bottom > vh ? Math.min(b.bottom - vh, b.top) : b.top < 0 ? b.top : 0;
    if (dy) {
      scroll.y += dy;
      setTimeout(() => document.dispatchEvent(new Event('scroll')), 0);
    }
  };
  onTestFinished(() => {
    if (had) (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = real;
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  return calls;
}

interface R {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const overlap = (a: R, b: R): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
/** A pinned card's box in viewport coordinates. */
const boxOf = (h: HTMLElement): R => {
  const r = h.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
const inViewport = (b: R): boolean => b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight;

describe('content script, round 8', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('dir');
    document.documentElement.style.removeProperty('direction');
    highlights.clear();
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true, writable: true });
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    scrollWindow(0, 0);
    Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
    setViewport(1280, 800);
    setDocumentSize(2000, 800);
  });
  afterEach(() => {
    setViewport(view.w, view.h);
    setDocumentSize(0, 0);
    scrollWindow(0, 0);
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true, writable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    document.documentElement.removeAttribute('dir');
    document.documentElement.style.removeProperty('direction');
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
    vi.restoreAllMocks();
  });

  /** A scroll container's offsets, as a browser reports them (negative ones too). */
  function scrolled(el: HTMLElement, left: number, top: number): void {
    Object.defineProperty(el, 'scrollLeft', { value: left, configurable: true, writable: true });
    Object.defineProperty(el, 'scrollTop', { value: top, configurable: true, writable: true });
    // Its box, as a browser lays it out (not a 0×0 box with overflow, which hides).
    el.getBoundingClientRect = () => new DOMRect(0, 40, 1280, 600);
  }

  // Review Major #1
  describe('text scrolled the negative way', () => {
    /**
     * A stick-to-bottom chat: 120 messages 30 px tall in a 600 px
     * `column-reverse` pane at y 40, scrolled up `up` px (scrollTop −up).
     * Message i is at 610 − (119 − i)·30 + up.
     */
    function chat(up: number): HTMLElement {
      const rows = Array.from(
        { length: 120 },
        (_, i) =>
          `<p id="m${i}" data-top="${610 - (119 - i) * 30 + up}">Msg ${i} sent 2024-05-${String((i % 28) + 1).padStart(2, '0')} 1${i % 10}:00 UTC</p>`,
      ).join('');
      document.body.innerHTML = `<div id="pane" style="height:600px;overflow-y:auto;display:flex;flex-direction:column-reverse"><div>${rows}</div></div>`;
      const el = document.getElementById('pane') as HTMLElement;
      scrolled(el, 0, -up);
      return el;
    }

    it('a column-reverse chat pane scrolled up: a visible message gives a card, and the whole list lists 120', async () => {
      chat(2685);
      expect(Number(document.getElementById('m20')?.getAttribute('data-top'))).toBe(325);
      await load();
      await select('m20');
      expect(quoted()).toBe('“2024-05-21 10:00 UTC”');
      closeCard();
      await select('pane');
      expect(live()).toMatch(/^Time \d+ of 120$/);
    });

    it('a right-to-left table in a scroller, scrolled so the time shows', async () => {
      document.body.innerHTML =
        '<div id="pane" dir="rtl" style="overflow-x:auto;width:100%"><table style="width:3000px"><tr><td style="width:2600px">first</td><td id="t" data-top="11" data-left="223">end 2024-05-06 11:00 UTC</td></tr></table></div>';
      scrolled(document.getElementById('pane') as HTMLElement, -1736, 0);
      await load();
      await select('t');
      expect(quoted()).toBe('“2024-05-06 11:00 UTC”');
    });

    /** A right-to-left page 3000 px wide, the time in its far (left) cell. */
    function rtlPage(): void {
      document.documentElement.setAttribute('dir', 'rtl');
      document.documentElement.style.setProperty('direction', 'rtl');
      setDocumentSize(3000, 800);
    }

    it('a right-to-left page scrolled sideways, the time on screen', async () => {
      rtlPage();
      scrollWindow(-1728, 0);
      // At x 215 on screen (−1513 at scrollX 0).
      document.body.innerHTML =
        '<table style="width:3000px"><tr><td style="width:2600px">first</td><td id="t" data-top="11" data-left="-1513">end 2024-05-06 11:00 UTC</td></tr></table>';
      await load();
      await select('t');
      expect(quoted()).toBe('“2024-05-06 11:00 UTC”');
    });

    it('a right-to-left wide table with the time off to the left, not scrolled', async () => {
      rtlPage();
      document.body.innerHTML =
        '<table style="width:3000px"><tr><td style="width:2600px">first</td><td id="t" data-top="11" data-left="-1513">end 2024-05-06 11:00 UTC</td></tr></table>';
      await load();
      await select('t');
      expect(quoted()).toBe('“2024-05-06 11:00 UTC”');
    });

    it('on a right-to-left page, positioned text moved past its right edge is left out; past the left it can be scrolled to', async () => {
      rtlPage();
      scrollWindow(-500, 0);
      document.body.innerHTML = `
        <p id="right" data-top="100">x <span data-left="11780" style="position:absolute;right:-9999px">2024-08-12 06:00 UTC</span> y</p>
        <p id="left" data-top="100">x <span data-left="-300" style="position:absolute;left:-800px">2024-08-12 07:00 UTC</span> y</p>`;
      await load();
      await select('right', false);
      expect(transientHost()).toBeNull();
      await select('left');
      expect(quoted()).toBe('“2024-08-12 07:00 UTC”');
    });

    it('still leaves out off-page, fixed top:-500 and screen-reader-only text (rounds 6 and 7), scrolled or not', async () => {
      document.body.innerHTML = `
        <p id="off" data-top="100">x <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> y</p>
        <p id="fixed" data-top="100">x <span data-top="-500" style="position:fixed;top:-500px">2024-08-12 06:00 UTC</span> y</p>
        <p id="inner" data-top="100">x <span style="position:absolute;left:-9999px"><b data-left="-9999">2024-08-12 06:00 UTC</b></span> y</p>
        <p id="sr" data-top="100">Updated <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">on 2024-08-13 07:00 UTC</span><span aria-hidden="true">3 days ago</span></p>
        <p id="mix" data-top="100">Visible 2024-08-01 10:00 UTC and <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> end</p>`;
      await load();
      for (const [x, y] of [
        [0, 0],
        [0, 600],
      ]) {
        scrollWindow(x as number, y as number);
        for (const id of ['off', 'fixed', 'inner', 'sr']) {
          await select(id, false);
          expect(transientHost(), `#${id} at scrollY ${y}`).toBeNull();
        }
      }
      // Fixed text is measured on screen: 600 px of window scroll does not bring it in.
      scrollWindow(0, 600);
      await select('mix');
      expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
      expect(transient().querySelector('.tzx-step')).toBeNull();
    });

    it('still lists every row of a pane scrolled the usual way, and a time past a <pre>’s edge (round 7)', async () => {
      const rows = Array.from(
        { length: 60 },
        (_, i) => `<div data-top="${40 + i * 30 - 900}">Row ${i} at 2024-06-01 ${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')} UTC</div>`,
      ).join('');
      document.body.innerHTML =
        `<main id="pane" style="height:700px;overflow:auto">${rows}</main>` +
        `<pre id="code" data-top="100" style="position:fixed;overflow-x:auto">deploy ${'x'.repeat(300)} <span data-left="2400">2024-05-05T10:00:00Z</span></pre>` +
        '<pre id="left" data-top="200" style="overflow-x:auto"><span data-left="-300">2024-05-06T11:00:00Z</span> y</pre>';
      scrolled(document.getElementById('pane') as HTMLElement, 0, 900);
      scrolled(document.getElementById('left') as HTMLElement, 500, 0);
      await load();
      await select('pane');
      expect(live()).toMatch(/^Time \d+ of 60$/);
      closeCard();
      await select('code');
      expect(quoted()).toBe('“2024-05-05T10:00:00Z”');
      closeCard();
      await select('left');
      expect(quoted()).toBe('“2024-05-06T11:00:00Z”');
    });
  });

  describe('where pins go', () => {
    const LINES = [
      'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
      '03/04/2024 10:00 and 05/06/2024 11:00',
      'Release 2024-05-10 08:00 PST',
      'Window 2024-06-01 12:00 UTC to 2024-06-01 14:00 UTC',
      'Cutover 2024-07-04T23:00:00Z',
    ];

    async function pin(id: string): Promise<HTMLElement> {
      const before = pinHosts().length;
      await select(id);
      mouseClick(button(transient(), 'Pin to page'));
      await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
      return pinHosts().at(-1) as HTMLElement;
    }

    /** Pin every line in turn; pins already there must not move. */
    async function pinEach(count = LINES.length): Promise<HTMLElement[]> {
      const hosts: HTMLElement[] = [];
      const spots: string[] = [];
      for (let i = 0; i < count; i++) {
        hosts.push(await pin(`l${i}`));
        expect(hosts.slice(0, i).map(where), `after pin ${i}`).toEqual(spots);
        spots.push(where(hosts[i] as HTMLElement));
      }
      return hosts;
    }

    function noOverlap(hosts: HTMLElement[]): void {
      const boxes = hosts.map(boxOf);
      boxes.forEach((a, i) =>
        boxes.forEach((b, j) => {
          if (i < j) expect(overlap(a, b), `pins ${i} and ${j}: ${hosts.map(where)}`).toBe(false);
        }),
      );
    }

    // QA H1
    it.each([2, 5])('at 390 px with %i pins, stepping pin 1 onto a time under it keeps it on screen', async (count) => {
      setViewport(390, 800);
      setDocumentSize(390, 2400);
      layOutPins();
      // Line 0 wraps: "13:30 UTC" is on its second row (y 170), where pin 1 (from y 178) is.
      document.body.innerHTML =
        `<p id="l0" data-top="150">Standup <span>09:00 UTC</span>, review <span data-top="170" data-left="200">13:30 UTC</span>, deploy <span>2024-04-02 18:00 UTC</span></p>` +
        LINES.slice(1)
          .map((t, i) => `<p id="l${i + 1}" data-top="${190 + i * 40}">${t}</p>`)
          .join('');
      await load();
      const hosts = await pinEach(count);
      const first = hosts[0] as HTMLElement;
      expect(where(first)).toBe('100,178');
      const card = first.shadowRoot as ShadowRoot;
      for (let i = 0; i < 3 && marked('tz-pin-0')?.toString() !== '13:30 UTC'; i++) mouseClick(button(card, 'Next time'));
      await vi.waitFor(() => expect(marked('tz-pin-0')?.toString()).toBe('13:30 UTC'));
      // No spot on screen by the mark is free of pin 2: it stays (over its mark), on screen.
      expect(where(first)).toBe('100,178');
      expect(inViewport(boxOf(first))).toBe(true);
      noOverlap(hosts);
    });

    it('at 390 px with one pin, stepping onto a time under it moves it next to that time, on screen', async () => {
      setViewport(390, 800);
      setDocumentSize(390, 2400);
      layOutPins();
      document.body.innerHTML =
        '<p id="l0" data-top="150">Standup <span>09:00 UTC</span>, review <span data-top="170" data-left="40">13:30 UTC</span>, deploy <span>2024-04-02 18:00 UTC</span></p>';
      await load();
      const [first] = await pinEach(1);
      const card = (first as HTMLElement).shadowRoot as ShadowRoot;
      for (let i = 0; i < 3 && marked('tz-pin-0')?.toString() !== '13:30 UTC'; i++) mouseClick(button(card, 'Next time'));
      await vi.waitFor(() => expect(marked('tz-pin-0')?.toString()).toBe('13:30 UTC'));
      // Just right of the mark (40–120 × 170–190), the free spot nearest where it was (100,178).
      expect(where(first as HTMLElement)).toBe('128,170');
      expect(inViewport(boxOf(first as HTMLElement))).toBe(true);
    });

    // Review Minor #2 / QA G2
    it('at 390 px, a new pin placed past the bottom of the screen is scrolled into view, and that scroll dismisses nothing', async () => {
      setViewport(390, 800);
      setDocumentSize(390, 3000);
      layOutPins();
      const calls = fakeScrollIntoView();
      document.body.innerHTML = LINES.map((t, i) => `<p id="l${i}" data-top="${150 + i * 40}">${t}</p>`).join('');
      await load();
      const hosts = await pinEach(3);
      // Pin 0 (178–491) is on screen; pins 1 (499–812) and 2 (820–1133) are not, when placed.
      expect(calls.map((c) => hosts.indexOf(c.el as HTMLElement))).toEqual([1, 2]);
      for (const c of calls) expect(c.opts).toMatchObject({ block: 'nearest' });
      expect(scroll.y).toBe(1133 - 800);
      expect(inViewport(boxOf(hosts[2] as HTMLElement))).toBe(true);

      // Float pin 2, open a card on line 3, and pin pin 2 back from the keyboard
      // (no mouse press closes the card): its scroll back to it keeps the card.
      scrollWindow(0, 0);
      const card2 = (hosts[2] as HTMLElement).shadowRoot as ShadowRoot;
      button(card2, 'Float on screen').click();
      await vi.waitFor(() => expect((hosts[2] as HTMLElement).style.getPropertyValue('position')).toBe('fixed'));
      await select('l3');
      button(card2, 'Pin to page').click();
      await vi.waitFor(() => expect((hosts[2] as HTMLElement).style.getPropertyValue('position')).toBe('absolute'));
      expect(calls).toHaveLength(3);
      expect(scroll.y).toBeGreaterThan(0);
      await sleep(30);
      expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy();
    });

    it('a new pin wholly on screen scrolls nothing', async () => {
      setViewport(1280, 800);
      layOutPins();
      const calls = fakeScrollIntoView();
      document.body.innerHTML = LINES.map((t, i) => `<p id="l${i}" data-top="${150 + i * 40}">${t}</p>`).join('');
      await load();
      await pinEach(4);
      expect(calls).toHaveLength(0);
      expect(scroll.y).toBe(0);
    });

    it('at 1280 px, the QA’s five lines: pins 4 and 5 take the free column right of the others, on screen', async () => {
      setViewport(1280, 800);
      setDocumentSize(1280, 3000);
      // The QA's cards (pin 2 is wider) and text boxes (pins3-1280.log).
      layOutPins((i) => ({ w: i === 1 ? 314 : 254, h: 336 }));
      const text = [
        [148, 112, 77],
        [207, 78, 125],
        [265, 171, 162],
        [324, 199, 164],
        [382, 228, 164],
      ];
      document.body.innerHTML = LINES.map(
        (t, i) => `<p id="l${i}" data-top="${text[i]?.[0]}" data-left="${text[i]?.[1]}" data-w="${text[i]?.[2]}">${t}</p>`,
      ).join('');
      await load();
      const hosts = await pinEach();
      noOverlap(hosts);
      for (const h of hosts) expect(inViewport(boxOf(h)), hosts.map(where).join(' ')).toBe(true);
      // Pin 3 ends at 950: pins 4 and 5 go in the empty x 958–1280.
      const third = boxOf(hosts[2] as HTMLElement);
      for (const h of hosts.slice(3)) expect(boxOf(h).left).toBeGreaterThanOrEqual(third.right);
      expect(hosts.slice(3).map(where)).toEqual([`${third.right + 8},352`, `${third.right + 8},8`]);
    });

    // Review Minor #3
    it('"Pin all to page" after scrolling to y 2000 puts each card back by its own text', async () => {
      setViewport(1280, 800);
      setDocumentSize(1280, 4000);
      layOutPins();
      document.body.innerHTML = LINES.slice(0, 3)
        .map((t, i) => `<p id="l${i}" data-top="${150 + i * 40}">${t}</p>`)
        .join('');
      await load();
      const hosts = await pinEach(3);
      const spots = hosts.map(where);
      scrollWindow(0, 2000);
      button(dock(), 'Unpin all').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
      button(dock(), 'Pin all to page').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));
      hosts.forEach((h, i) => {
        const textBottom = 150 + i * 40 + 20;
        expect(Math.abs(px(h, 'top') - textBottom), `card ${i} at ${where(h)}`).toBeLessThanOrEqual(313);
      });
      // The first two get their spots back. The third takes the free spot
      // nearest below its text (under the first card), not the one right of
      // the second it got while its text was on screen: no spot on screen
      // is preferred now.
      expect(spots).toEqual(['100,178', '353,218', '606,258']);
      expect(hosts.map(where)).toEqual(['100,178', '353,218', '100,499']);
      noOverlap(hosts);
    });
  });
});
