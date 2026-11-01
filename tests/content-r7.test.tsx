import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render } from '@testing-library/react';
import { Popover } from '../src/content/Popover';
import { parseTimes } from '../src/lib/parse';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

/**
 * Round-7 fixes for the content script: times scrolled away inside a pane
 * or a code block are listed, while off-screen, screen-reader-only,
 * `opacity: 0` and transparent text is not; inline-block edges read as a
 * space only where a letter is involved; a new pin takes the first free
 * spot without moving any other pin, at 1280 and 390 px and for "Pin all";
 * a stepped pin moves off its own new mark; a pin keeps no selection map;
 * and a capped selection with one time shows "1 of 1+".
 */

const KEY = 'tz-extension-prefs';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

/**
 * Rect of a page range: `data-top` / `data-left` of the element holding it,
 * 80×20; zero when collapsed.
 */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  const left = Number(el?.closest('[data-left]')?.getAttribute('data-left') ?? 100);
  return new DOMRect(left, top, 80, 20);
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
const marked = (name = 'tz-extension-match'): Range | undefined => highlights.get(name)?.ranges[0];
const px = (el: HTMLElement, prop: 'top' | 'left'): number => parseFloat(el.style.getPropertyValue(prop));

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
}

/** The document's scroll area, as a browser reports it. */
function setDocumentSize(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
}

/** Pinned hosts measure 245×313 at the place their style puts them (the page is not scrolled). */
function layOutPins(): void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (!this.classList.contains('tz-extension-pin-host')) return real.call(this);
    const w = parseFloat(this.style.getPropertyValue('width'));
    const left = parseFloat(this.style.getPropertyValue('left')) || 0;
    const top = parseFloat(this.style.getPropertyValue('top')) || 0;
    return new DOMRect(left, top, Number.isFinite(w) ? w : 245, 313);
  };
  onTestFinished(() => {
    HTMLElement.prototype.getBoundingClientRect = real;
  });
}

interface R {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const overlap = (a: R, b: R): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const boxOf = (h: HTMLElement): R => {
  const r = h.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};
/** A text's box (as rangeRect gives it), by element id. */
function textBox(id: string): R {
  const el = document.getElementById(id) as HTMLElement;
  const top = Number(el.closest('[data-top]')?.getAttribute('data-top'));
  const left = Number(el.closest('[data-left]')?.getAttribute('data-left') ?? 100);
  return { left, top, right: left + 80, bottom: top + 20 };
}
const where = (h: HTMLElement): string => `${px(h, 'left')},${px(h, 'top')}`;

describe('content script, round 7', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    document.body.innerHTML = '';
    highlights.clear();
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true, writable: true });
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    setDocumentSize(2000, 800);
  });
  afterEach(() => {
    setViewport(view.w, view.h);
    setDocumentSize(0, 0);
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
    vi.restoreAllMocks();
  });

  // Review #1
  describe('text scrolled away in a pane or a code block', () => {
    /** A pane of 60 rows 30 px apart, scrolled down `scroll` px; the document is 800 px tall. */
    function pane(scroll: number): HTMLElement {
      const rows = Array.from(
        { length: 60 },
        (_, i) => `<div data-top="${40 + i * 30 - scroll}">Row ${i} at 2024-06-01 ${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')} UTC</div>`,
      ).join('');
      document.body.innerHTML = `<main id="pane" style="height:700px;overflow:auto">${rows}</main>`;
      const el = document.getElementById('pane') as HTMLElement;
      el.scrollTop = scroll;
      // Its box, as a browser lays it out (not a 0×0 box with overflow, which hides).
      el.getBoundingClientRect = () => new DOMRect(0, 40, 1280, 700);
      return el;
    }

    it('lists all 60 rows of an inner scroll pane, the ones past the document’s height too', async () => {
      setViewport(1280, 800);
      pane(0);
      await load();
      await select('pane');
      expect(live()).toMatch(/^Time \d+ of 60$/);
    });

    it('lists all 60 rows with the pane scrolled to the middle, the ones scrolled above it too', async () => {
      setViewport(1280, 800);
      // Rows 0 to 29 are above the pane's top (negative viewport y).
      const el = pane(900);
      expect(el.scrollTop).toBe(900);
      await load();
      await select('pane');
      expect(live()).toMatch(/^Time \d+ of 60$/);
    });

    it('reads a time past the right edge of a sideways-scrolling <pre>, and one scrolled off its left', async () => {
      setViewport(1280, 800);
      document.body.innerHTML = `
        <pre id="code" data-top="100" style="overflow-x:auto">deploy ${'x'.repeat(300)} <span data-left="2400">2024-05-05T10:00:00Z</span></pre>
        <pre id="left" data-top="200" style="overflow-x:auto"><span data-left="-300">2024-05-06T11:00:00Z</span> ${'y'.repeat(300)}</pre>`;
      (document.getElementById('left') as HTMLElement).scrollLeft = 500;
      await load();
      await select('code');
      expect(quoted()).toBe('“2024-05-05T10:00:00Z”');
      closeCard();
      await select('left');
      expect(quoted()).toBe('“2024-05-06T11:00:00Z”');
    });

    it('still leaves out off-screen and screen-reader-only text (round 6)', async () => {
      document.body.innerHTML = `
        <p id="off" data-top="100">x <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> y</p>
        <p id="fixed" data-top="100">x <span data-top="-500" style="position:fixed;top:-500px">2024-08-12 06:00 UTC</span> y</p>
        <p id="sr" data-top="100">Updated <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">on 2024-08-13 07:00 UTC</span><span aria-hidden="true">3 days ago</span></p>
        <p id="mix" data-top="100">Visible 2024-08-01 10:00 UTC and <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> end</p>`;
      await load();
      for (const id of ['off', 'fixed', 'sr']) {
        await select(id, false);
        expect(transientHost(), `#${id}`).toBeNull();
      }
      await select('mix');
      expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
      expect(transient().querySelector('.tzx-step')).toBeNull();
    });
  });

  // QA G10, with the markup of f5b.log
  it('leaves out text with opacity 0 (on it or an element it is in) or a transparent colour; keeps gradient text', async () => {
    document.body.innerHTML = `
      <p id="f5b" data-top="100">Visible 2024-08-01 10:00 UTC, <span style="opacity:0">2024-08-02 11:00 UTC</span>,
        <span style="opacity:0"><b>2024-08-03 12:00 UTC</b></span>,
        <span style="color:transparent">2024-08-04 13:00 UTC</span>,
        <span style="color:rgba(10, 20, 30, 0)">2024-08-05 14:00 UTC</span> end</p>
      <p id="none" data-top="200"><span style="opacity:0">2024-08-02 11:00 UTC</span></p>
      <p id="grad" data-top="300"><span style="background-clip:text;color:transparent">Launch 2024-09-01 09:00 UTC</span></p>
      <p id="black" data-top="400"><span style="color:rgb(0, 0, 0)">Black 2024-09-02 09:00 UTC</span>,
        <span style="color:rgba(0, 0, 0, 0.5)">grey 2024-09-03 09:00 UTC</span></p>`;
    await load();
    await select('f5b');
    expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
    expect(transient().querySelector('.tzx-step')).toBeNull();
    closeCard();
    await select('none', false);
    expect(transientHost()).toBeNull();
    await select('grad');
    expect(quoted()).toBe('“2024-09-01 09:00 UTC”');
    closeCard();
    // A channel at 0 is not a transparent colour (only the alpha is).
    await select('black');
    expect(live()).toMatch(/^Time \d of 2$/);
  });

  it('reads only a zero alpha as no ink', async () => {
    const { NO_INK } = await import('../src/content/index');
    for (const c of ['transparent', 'rgba(0, 0, 0, 0)', 'rgba(10, 20, 30, 0.0)', 'rgb(0 0 0 / 0)', 'rgb(0 0 0 / 0%)', 'color(srgb 1 0 0 / 0)']) {
      expect(NO_INK.test(c), c).toBe(true);
    }
    for (const c of ['rgb(0, 0, 0)', 'rgb(255, 0, 0)', 'rgba(0, 0, 0, 0.5)', 'rgb(0 0 0 / 0.2)', 'rgb(0 0 0)', 'color(srgb 1 0 0)']) {
      expect(NO_INK.test(c), c).toBe(false);
    }
  });

  // Review #2
  describe('inline-block edges', () => {
    const ib = (t: string, tag = 'span'): string => `<${tag} style="display:inline-block">${t}</${tag}>`;

    it('reads "10" : "30" in boxes as 10:30 UTC', async () => {
      document.body.innerHTML = `<p id="t" data-top="100">Starts ${ib('10')}:${ib('30')} UTC</p>`;
      await load();
      await select('t');
      expect(quoted()).toBe('“10:30 UTC”');
      expect(marked()?.toString()).toBe('10:30 UTC');
    });

    it('reads one inline-block per digit as 10:30 UTC, not midnight', async () => {
      document.body.innerHTML = `<p id="t" data-top="100">Starts ${['1', '0', ':', '3', '0'].map((c) => ib(c, 'b')).join('')} UTC</p>`;
      await load();
      await select('t');
      expect(quoted()).toBe('“10:30 UTC”');
    });

    it('still splits a letter from what follows ("UTC3 days ago", "UTCend") and reads a date box and a time box whole', async () => {
      document.body.innerHTML = `
        <p id="days" data-top="100">${ib('at 07:00 UTC')}${ib('3 days ago')}</p>
        <p id="end" data-top="200">${ib('at 08:00 UTC')}${ib('end')}</p>
        <p id="chips" data-top="300">${ib('2024-08-13')}${ib('07:00 UTC')}</p>`;
      await load({ homeZone: 'Asia/Tokyo' });
      await select('days');
      expect(quoted()).toBe('“07:00 UTC”');
      closeCard();
      await select('end');
      expect(quoted()).toBe('“08:00 UTC”');
      closeCard();
      await select('chips');
      expect(quoted()).toBe('“2024-08-1307:00 UTC”');
      expect(transient().querySelector('.tzx-src')?.textContent).toContain('read as UTC');
    });
  });

  // QA G1, G2, G4; review #3 and nit #5
  describe('where pins go', () => {
    const LINES = [
      'Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC',
      '03/04/2024 10:00 and 05/06/2024 11:00',
      'Release 2024-05-10 08:00 PST',
      'Window 2024-06-01 12:00 UTC to 2024-06-01 14:00 UTC',
      'Cutover 2024-07-04T23:00:00Z',
    ];
    /** The five lines of the QA repro, 40 px apart. */
    function page(): void {
      document.body.innerHTML = LINES.map((t, i) => `<p id="l${i}" data-top="${150 + i * 40}">${t}</p>`).join('');
    }

    async function pin(id: string): Promise<HTMLElement> {
      const before = pinHosts().length;
      await select(id);
      mouseClick(button(transient(), 'Pin to page'));
      await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
      return pinHosts().at(-1) as HTMLElement;
    }

    /** Pin every line in turn; pins already there must not move. */
    async function pinEach(): Promise<{ hosts: HTMLElement[]; spots: string[] }> {
      const hosts: HTMLElement[] = [];
      const spots: string[] = [];
      for (let i = 0; i < LINES.length; i++) {
        hosts.push(await pin(`l${i}`));
        expect(hosts.slice(0, i).map(where), `after pin ${i}`).toEqual(spots);
        spots.push(where(hosts[i] as HTMLElement));
      }
      return { hosts, spots };
    }

    /** No pin covers another, its own line, or a line pinned before it. */
    function noCover(hosts: HTMLElement[]): void {
      const boxes = hosts.map(boxOf);
      boxes.forEach((box, i) => {
        boxes.forEach((other, j) => {
          if (i < j) expect(overlap(box, other), `pins ${i} and ${j}: ${hosts.map(where)}`).toBe(false);
        });
        for (let k = 0; k <= i; k++) expect(overlap(box, textBox(`l${k}`)), `pin ${i} over line ${k}`).toBe(false);
      });
    }

    it('at 1280 px, five lines 40 px apart: no pin moves, none overlaps, and they stay on screen while there is room', async () => {
      setViewport(1280, 800);
      layOutPins();
      page();
      await load();
      const { hosts } = await pinEach();
      noCover(hosts);
      // Right below line 0; then side by side, each by its own line. Four
      // 245 px cards fill the width (100 to 1104), so no spot is left wholly
      // on screen for the fifth: it takes the nearest free one, under the first.
      expect(hosts.map(where)).toEqual(['100,178', '353,218', '606,258', '859,298', '100,499']);
      for (const b of hosts.slice(0, 4).map(boxOf)) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(1280);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.bottom).toBeLessThanOrEqual(800);
      }
    });

    it('at 390 px, five lines 40 px apart: the pins stack down the page without overlapping', async () => {
      setViewport(390, 800);
      layOutPins();
      page();
      await load();
      const { hosts } = await pinEach();
      noCover(hosts);
      const tops = hosts.map((h) => px(h, 'top'));
      // Each under the one before: its bottom (313 px tall) + 8.
      expect(tops).toEqual([178, 178 + 321, 178 + 2 * 321, 178 + 3 * 321, 178 + 4 * 321]);
      // On screen across.
      for (const b of hosts.map(boxOf)) expect(b.right).toBeLessThanOrEqual(390);
    });

    it.each([1280, 390])('at %i px, "Unpin all" then "Pin all to page" gives each card the spot it was pinned at', async (width) => {
      setViewport(width, 800);
      layOutPins();
      page();
      await load();
      const { hosts, spots } = await pinEach();
      button(dock(), 'Unpin all').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
      button(dock(), 'Pin all to page').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));
      expect(hosts.map(where)).toEqual(spots);
      noCover(hosts);
    });

    it('"Pin all to page" places the cards in reading order, whatever order they were pinned in', async () => {
      setViewport(390, 800);
      layOutPins();
      page();
      await load();
      // Pinned last line first.
      const hosts: HTMLElement[] = [];
      for (const i of [4, 3, 2, 1, 0]) hosts.unshift(await pin(`l${i}`));
      button(dock(), 'Unpin all').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
      button(dock(), 'Pin all to page').click();
      await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));
      // Line 0's card first, right below it; then each one under the last.
      expect(hosts.map((h) => px(h, 'top'))).toEqual([178, 178 + 321, 178 + 2 * 321, 178 + 3 * 321, 178 + 4 * 321]);
    });

    // QA G3
    it('a stepped pin moves only when its own new mark would be under it', async () => {
      setViewport(1280, 800);
      layOutPins();
      document.body.innerHTML =
        '<p id="two" data-top="100"><span id="t1" data-top="100">10:00 UTC</span> and <span id="t2" data-top="200" data-left="150">11:00 UTC</span> and <span id="t3" data-top="100" data-left="600">12:00 UTC</span></p>';
      await load();
      const host = await pin('two');
      const card = host.shadowRoot as ShadowRoot;
      await vi.waitFor(() => expect(live(card)).toBe('Time 1 of 3'));
      expect(where(host)).toBe('100,128');
      // 11:00 is under the card: it moves off it, to right below that time.
      mouseClick(button(card, 'Next time'));
      await vi.waitFor(() => expect(marked('tz-pin-0')?.toString()).toBe('11:00 UTC'));
      expect(overlap(boxOf(host), textBox('t2'))).toBe(false);
      expect(where(host)).toBe('150,228');
      // 12:00 is clear of it: it stays.
      mouseClick(button(card, 'Next time'));
      await vi.waitFor(() => expect(marked('tz-pin-0')?.toString()).toBe('12:00 UTC'));
      expect(where(host)).toBe('150,228');
    });
  });

  // Review nit #6
  it('a pin made from a large selection keeps no selection map, before or after it steps, and still marks', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `<div>Row ${i} ${'lorem ipsum '.repeat(8)} at 2024-06-01 10:${String(i % 60).padStart(2, '0')} UTC</div>`).join('');
    document.body.innerHTML = `<section id="big" data-top="100">${rows}</section>`;
    await load();
    const { pinsHoldMaps } = await import('../src/content/index');
    await select('big');
    mouseClick(button(transient(), 'Pin to page'));
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    const card = pinHosts()[0]?.shadowRoot as ShadowRoot;
    await vi.waitFor(() => expect(live(card)).toBe('Time 1 of 60'));
    expect(pinsHoldMaps()).toEqual([false]);
    mouseClick(button(card, 'Previous time'));
    await vi.waitFor(() => expect(live(card)).toBe('Time 60 of 60'));
    expect(marked('tz-pin-0')?.toString()).toBe('2024-06-01 10:59 UTC');
    expect(pinsHoldMaps()).toEqual([false]);
  });

  // QA G7
  it('shows "1 of 1+" when one time is listed and the selection runs past what is read, on the card and the pin', async () => {
    document.body.innerHTML = `<p id="cut" data-top="100">2024-05-01 01:00 UTC ${'y'.repeat(60_000)} 2024-05-06 11:00 UTC</p>`;
    await load();
    await select('cut');
    const note = 'Text past the first 50,000 characters is not read';
    expect(live()).toBe(`Time 1 of 1+. ${note}`);
    expect(transient().querySelector('.tzx-step')?.getAttribute('title')).toBe(note);
    expect(button(transient(), 'Next time').disabled).toBe(true);
    mouseClick(button(transient(), 'Pin to page'));
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    const card = pinHosts()[0]?.shadowRoot as ShadowRoot;
    await vi.waitFor(() => expect(live(card)).toBe(`Time 1 of 1+. ${note}`));
  });
});

describe('Popover, round 7', () => {
  const PREFS: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC'], hour12: false };
  const one = parseTimes('2024-05-01 01:00 UTC', { assumedZone: 'UTC' })[0] as ParsedTime;

  it.each([
    [false, 'Time 1 of 1+'],
    [true, 'Time 1/1+'],
  ])('compact %s: a capped single time shows %s, with why, and disabled steps', (compact, text) => {
    const { container } = render(
      <Popover parsed={one} matchCount={1} matchesCapped compact={compact} prefs={PREFS} pinned={false} onClose={() => {}} onStep={() => {}} />,
    );
    const step = container.querySelector('.tzx-step') as HTMLElement;
    expect(step).toBeTruthy();
    expect(step.getAttribute('title')).toBe('Text past the first 50,000 characters is not read');
    expect(step.querySelector('[aria-live="polite"]')?.textContent?.startsWith(text)).toBe(true);
    for (const b of step.querySelectorAll('button')) expect(b.disabled).toBe(true);
  });

  it('a single time that is not capped shows no stepper; 500 listed says the list is full', () => {
    const a = render(<Popover parsed={one} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} onStep={() => {}} />);
    expect(a.container.querySelector('.tzx-step')).toBeNull();
    a.unmount();
    const b = render(<Popover parsed={one} matchCount={500} matchesCapped prefs={PREFS} pinned={false} onClose={() => {}} onStep={() => {}} />);
    expect(b.container.querySelector('.tzx-step')?.getAttribute('title')).toBe('Only the first 500 times are listed');
    expect(b.container.querySelector('.tzx-stepbtn')).not.toHaveProperty('disabled', true);
  });
});
