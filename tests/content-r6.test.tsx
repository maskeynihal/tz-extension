import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';

/**
 * Round-6 fixes for the content script: it lists times with readTimes from
 * src/lib/read-times.ts (no time budget; long selections are read), marks
 * text on text-transform pages and never the whole selection, maps only
 * what it reads, asks for the focus key only when a card opens, leaves out
 * hidden and off-screen text and reads element edges as word breaks, pins
 * cards clear of each other and of each other's text, opens on a time on
 * screen, scrolls with a margin, and gives pins the stepper.
 */

const KEY = 'tz-extension-prefs';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

/** Page scroll the rect mock subtracts. */
let scrolled = 0;

/**
 * Rect of a page range: `data-top` / `data-left` of the element holding it
 * (less the scroll), 80×20; zero when collapsed.
 */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  const left = Number(el?.closest('[data-left]')?.getAttribute('data-left') ?? 100);
  return new DOMRect(left, top - scrolled, 80, 20);
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

interface Env {
  readonly listener: Listener;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  writeElsewhere(patch: Record<string, unknown>): void;
}

async function load(initial: Record<string, unknown> = {}): Promise<Env> {
  let data: Record<string, unknown> = {
    homeZone: 'Asia/Tokyo',
    targetZones: ['UTC'],
    hour12: false,
    cardSize: 'full',
    keepSelection: true,
    ...initial,
  };
  const changeListeners: ChangeListener[] = [];
  const listeners: Listener[] = [];
  const sendMessage = vi.fn(async (msg: { type?: string }) =>
    msg?.type === 'tzx/get-shortcut' ? { shortcut: 'Alt+Shift+K' } : { ok: true },
  );
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: { get: vi.fn(async () => ({ [KEY]: data })), set: vi.fn(async () => undefined) },
      onChanged: { addListener: (l: ChangeListener) => changeListeners.push(l), removeListener: vi.fn() },
    },
    runtime: {
      id: 'ext-id',
      onMessage: { addListener: (l: Listener) => listeners.push(l), removeListener: vi.fn() },
      sendMessage,
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
  return {
    listener,
    sendMessage,
    writeElsewhere: (patch) => {
      const oldValue = data;
      data = { ...data, ...patch };
      for (const l of changeListeners) l({ [KEY]: { oldValue, newValue: data } }, 'sync');
    },
  };
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
const src = (root: ShadowRoot = transient()): string => root.querySelector('.tzx-src')?.textContent ?? '';
const quoted = (root: ShadowRoot = transient()): string => root.querySelector('.tzx-src span')?.textContent ?? '';
const marked = (name = 'tz-extension-match'): Range | undefined => highlights.get(name)?.ranges[0];
const px = (el: HTMLElement, prop: 'top' | 'left'): number => parseFloat(el.style.getPropertyValue(prop));

/** Select an element's text and release the mouse at (x, y), as a user's drag would end. */
async function selectWithMouse(id: string, at = { x: 0, y: 0 }, expectCard = true): Promise<void> {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0, clientX: at.x, clientY: at.y }));
  if (expectCard) await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  else await sleep(320);
}

function mouseClick(el: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
}

/** Make the selection's string what a browser gives for styled text (text-transform, positioned elements). */
function selectionStringIs(text: string): void {
  const spy = vi.spyOn(Selection.prototype, 'toString').mockReturnValue(text);
  onTestFinished(() => spy.mockRestore());
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

describe('content script, round 6', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    document.body.innerHTML = '';
    highlights.clear();
    scrolled = 0;
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true, writable: true });
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
    vi.restoreAllMocks();
  });

  // QA F3, F4 (brief item 1)
  it('lists the same count every time, up to 500 with "+", and reads past 20,000 characters', async () => {
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `Item ${i} at 2024-05-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} UTC`).join('<br>');
    document.body.innerHTML = `<p id="three" data-top="100">${lines(300)}</p><p id="many" data-top="100">${lines(600)}</p>
      <p id="far" data-top="100">${'x'.repeat(19_994)} 2024-05-05 10:00 UTC</p>`;
    await load();
    for (let run = 0; run < 2; run++) {
      await selectWithMouse('three');
      expect(live()).toMatch(/^Time \d+ of 300$/);
      transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      await vi.waitFor(() => expect(transientHost()).toBeNull());
    }
    await selectWithMouse('many');
    expect(live()).toMatch(/^Time \d+ of 500\+\. Only the first 500 times are listed$/);
    transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    // A time past the parser's 20,000-character window still gets a card.
    await selectWithMouse('far');
    expect(quoted()).toBe('“2024-05-05 10:00 UTC”');
  });

  // Review #3
  it('marks the shown time on an uppercase page, and the pin marks it too, not the whole paragraph', async () => {
    document.body.innerHTML = '<p id="up" data-top="100" style="text-transform:uppercase">meet 10:00 utc then 3pm est, deploy 2024-04-02 18:00 utc</p>';
    selectionStringIs('MEET 10:00 UTC THEN 3PM EST, DEPLOY 2024-04-02 18:00 UTC');
    await load();
    await selectWithMouse('up');
    expect(live()).toBe('Time 3 of 3');
    expect(marked()?.toString()).toBe('2024-04-02 18:00 utc');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 1 of 3'));
    expect(marked()?.toString()).toBe('10:00 utc');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(marked()?.toString()).toBe('3pm est'));
    mouseClick(button(transient(), 'Pin to page'));
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    expect(marked('tz-pin-0')?.toString()).toBe('3pm est');
  });

  it('marks a capitalized time', async () => {
    document.body.innerHTML = '<p id="cap" data-top="100" style="text-transform:capitalize">call at 10:00 utc today</p>';
    selectionStringIs('Call At 10:00 Utc Today');
    await load();
    await selectWithMouse('cap');
    expect(quoted()).toBe('“10:00 Utc”');
    expect(marked()?.toString()).toBe('10:00 utc');
  });

  it('marks nothing, never the whole selection, when the time cannot be found on the page', async () => {
    document.body.innerHTML = '<p id="t" data-top="100">at 10:00 UTC and 10:00 UTC</p>';
    // A string that differs from the page where the second time is.
    selectionStringIs('at 10:00 UTC and 10:30 UTC');
    await load();
    await selectWithMouse('t');
    expect(live()).toBe('Time 1 of 2');
    expect(marked()?.toString()).toBe('10:00 UTC');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 2 of 2'));
    expect(quoted()).toBe('“10:30 UTC”');
    expect(marked()).toBeUndefined();
  });

  // Review nit #10
  it('maps only as much of a selection as is read', async () => {
    const { mapSelection, mapSelectionText } = await import('../src/content/index');
    document.body.innerHTML = `<div id="big">${Array.from({ length: 3000 }, (_, i) => `<p>Line ${i} ${'lorem ipsum '.repeat(8)}</p>`).join('')}</div>`;
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('big') as HTMLElement);
    const sel = Array.from(document.querySelectorAll('#big p'), (p) => p.textContent).join('\n\n');
    let read = 0;
    const real = document.createTreeWalker.bind(document);
    vi.spyOn(document, 'createTreeWalker').mockImplementation((root, what, filter) => {
      const w = real(root, what, filter);
      const next = w.nextNode.bind(w);
      w.nextNode = () => {
        read++;
        return next();
      };
      return w;
    });
    const short = mapSelection(r, sel, 1000);
    expect(short.map).toHaveLength(1000);
    expect(read).toBeLessThan(20);
    expect(short.map[0]?.node.data.startsWith('Line 0')).toBe(true);
    // The whole thing reads every node.
    read = 0;
    const all = mapSelectionText(r, sel);
    expect(all).toHaveLength(sel.length);
    expect(read).toBeGreaterThanOrEqual(3000);
    expect(all.slice(0, 1000)).toEqual(short.map);
  });

  // Review nit #9
  it('asks the worker for the focus key when a card opens, not when the page loads, and paints the known key at once', async () => {
    document.body.innerHTML = '<p id="a" data-top="100">10:00 UTC</p><p id="b" data-top="200">11:00 UTC</p>';
    const env = await load();
    await sleep(20);
    const asks = (): number => env.sendMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === 'tzx/get-shortcut').length;
    expect(asks()).toBe(0);
    await selectWithMouse('a');
    expect(asks()).toBe(1);
    await vi.waitFor(() => expect(transient().querySelector('.tzx-card')?.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+K'));
    transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await selectWithMouse('b');
    // The next card shows the key it knows on its first paint, and asks again.
    expect(transient().querySelector('.tzx-card')?.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+K');
    expect(asks()).toBe(2);
  });

  // QA F5, with the markup of real2.log
  it('leaves out off-screen text: a selection holding only that opens no card', async () => {
    document.body.innerHTML =
      '<p id="off" data-top="100">x <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> y</p>';
    await load();
    await selectWithMouse('off', { x: 0, y: 0 }, false);
    expect(transientHost()).toBeNull();
  });

  it('does not step to off-screen text next to visible text', async () => {
    document.body.innerHTML =
      '<p id="mix" data-top="100">Visible 2024-08-01 10:00 UTC and offscreen <span data-left="-9999" style="position:absolute;left:-9999px">2024-08-12 06:00 UTC</span> end</p>';
    await load();
    await selectWithMouse('mix');
    expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
    expect(transient().querySelector('.tzx-step')).toBeNull();
  });

  it('leaves out screen-reader-only text (clipped to nothing)', async () => {
    document.body.innerHTML = `
      <p id="sr" data-top="100">Updated <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">on 2024-08-13 07:00 UTC</span><span aria-hidden="true">3 days ago</span></p>
      <p id="inset" data-top="200">Due 09:00 UTC <span style="position:absolute;clip-path:inset(50%)">or 2024-08-14 08:00 UTC</span></p>`;
    await load();
    await selectWithMouse('sr', { x: 0, y: 0 }, false);
    expect(transientHost()).toBeNull();
    await selectWithMouse('inset');
    expect(quoted()).toBe('“09:00 UTC”');
    expect(transient().querySelector('.tzx-step')).toBeNull();
  });

  it('reads an element edge the string runs together as a word break', async () => {
    // Chrome drops the space after a positioned element: "…07:00 UTC3 days ago".
    document.body.innerHTML =
      '<p id="g" data-top="100">Updated <span style="position:absolute;left:0">2024-08-13 07:00 UTC</span> 3 days ago</p>';
    selectionStringIs('Updated 2024-08-13 07:00 UTC3 days ago');
    await load();
    await selectWithMouse('g');
    expect(quoted()).toBe('“2024-08-13 07:00 UTC”');
    expect(src()).toContain('read as UTC');
    expect(marked()?.toString()).toBe('2024-08-13 07:00 UTC');
  });

  it('reads two inline-blocks side by side as separate words, and a date and time across them whole', async () => {
    document.body.innerHTML = `
      <p id="ib" data-top="100"><span style="display:inline-block">at 07:00 UTC</span><span style="display:inline-block">3 days ago</span></p>
      <p id="dt" data-top="200"><span style="display:inline-block">2024-08-13</span><span style="display:inline-block">07:00 UTC</span></p>`;
    await load();
    await selectWithMouse('ib');
    expect(quoted()).toBe('“07:00 UTC”');
    expect(src()).toContain('read as UTC');
    transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await selectWithMouse('dt');
    expect(quoted()).toBe('“2024-08-1307:00 UTC”');
    expect(src()).toContain('read as UTC');
    expect(marked()?.toString()).toBe('2024-08-1307:00 UTC');
  });

  it('cuts a time that runs into a positioned element at its edge', async () => {
    // "10:00" then an absolutely positioned "+05:30 note": not one time.
    document.body.innerHTML =
      '<p id="cut" data-top="100">Call 2024-08-13 10:00<span style="position:absolute;left:0">+05:30 note</span></p>';
    await load({ homeZone: 'UTC' });
    await selectWithMouse('cut');
    expect(quoted()).toBe('“2024-08-13 10:00”');
    expect(src()).toContain('UTC (assumed)');
  });

  // QA F7
  it('opens on the time on screen nearest the mouse when the best one is above the screen', async () => {
    setViewport(1280, 700);
    // The page is scrolled 1000 px down: rows from y = -900 (on screen), 30 px apart.
    const scrollY = window.scrollY;
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
    });
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<div data-top="${-900 + i * 30}">Row ${i} at 2024-06-01 10:${String(i).padStart(2, '0')} UTC</div>`,
    ).join('');
    document.body.innerHTML = `<section id="rows" data-top="-900">${rows}</section>`;
    await load();
    // Released at y = 150: row 35 (top 150) is there.
    await selectWithMouse('rows', { x: 120, y: 155 });
    expect(live()).toBe('Time 36 of 40');
    expect(marked()?.toString()).toBe('2024-06-01 10:35 UTC');
    // The card sits next to that time, not next to the selection's far edge.
    expect(px(transientHost() as HTMLElement, 'top')).toBe(150 + 20 + 8);
  });

  // QA F12
  it('a pin from a multi-time selection steps, moves its mark, and keeps its step through Close all, Undo and settings', async () => {
    document.body.innerHTML = '<p id="dm" data-top="100">03/04/2024 10:00 UTC and 05/06/2024 11:00 UTC, then 12:00 UTC</p>';
    const env = await load({ numericDateOrder: 'mdy', homeZone: 'UTC' });
    await selectWithMouse('dm');
    mouseClick(button(transient(), 'Pin to page'));
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    let pin = pinHosts()[0]?.shadowRoot as ShadowRoot;
    await vi.waitFor(() => expect(pin.querySelector('.tzx-card')).toBeTruthy());
    expect(pin.querySelector('.tzx-more:not(.tzx-step)')).toBeNull();
    const first = Number(/^Time (\d) of 3$/.exec(live(pin))?.[1]);
    expect(first).toBeGreaterThan(0);
    // Step to 2 of 3, one step at a time.
    for (let k = first; k !== 2; k = (k % 3) + 1) {
      const next = `Time ${(k % 3) + 1} of 3`;
      mouseClick(button(pin, 'Next time'));
      await vi.waitFor(() => expect(live(pin)).toBe(next));
    }
    expect(quoted(pin)).toBe('“05/06/2024 11:00 UTC”');
    expect(marked('tz-pin-0')?.toString()).toBe('05/06/2024 11:00 UTC');
    // Close all, Undo: the same step and mark.
    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    expect(highlights.has('tz-pin-0')).toBe(false);
    Array.from(dock().querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Undo'))
      ?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    pin = pinHosts()[0]?.shadowRoot as ShadowRoot;
    await vi.waitFor(() => expect(live(pin)).toBe('Time 2 of 3'));
    expect(marked('tz-pin-0')?.toString()).toBe('05/06/2024 11:00 UTC');
    // Day first from Settings: same step, read the other way.
    env.writeElsewhere({ numericDateOrder: 'dmy' });
    await vi.waitFor(() => expect(pin.querySelector('.tzx-order-btn.on')?.textContent).toContain('5 Jun'));
    expect(live(pin)).toBe('Time 2 of 3');
    // And it still steps, wrapping around.
    mouseClick(button(pin, 'Next time'));
    await vi.waitFor(() => expect(live(pin)).toBe('Time 3 of 3'));
    expect(marked('tz-pin-0')?.toString()).toBe('12:00 UTC');
    mouseClick(button(pin, 'Next time'));
    await vi.waitFor(() => expect(live(pin)).toBe('Time 1 of 3'));
    expect(marked('tz-pin-0')?.toString()).toBe('03/04/2024 10:00 UTC');
  });
});

/** Pinned hosts measure 245×313 at the place their style puts them. */
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

// QA F6
describe('where pins go', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    highlights.clear();
    scrolled = 0;
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;
    Object.defineProperty(globalThis, 'CSS', { value: { highlights }, configurable: true, writable: true });
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
    vi.restoreAllMocks();
  });

  async function pin(id: string, at?: { x: number; y: number }): Promise<HTMLElement> {
    const before = pinHosts().length;
    await selectWithMouse(id, at);
    mouseClick(button(transient(), 'Pin to page'));
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(before + 1));
    return pinHosts().at(-1) as HTMLElement;
  }

  /** Each text's box (as rangeRect gives it), by element id. */
  function textBox(id: string): R {
    const el = document.getElementById(id) as HTMLElement;
    const top = Number(el.getAttribute('data-top'));
    const left = Number(el.getAttribute('data-left') ?? 100);
    return { left, top, right: left + 80, bottom: top + 20 };
  }

  it('two pins 140 px apart cover neither each other nor each other’s text', async () => {
    setViewport(1280, 800);
    layOutPins();
    document.body.innerHTML =
      '<p id="l1" data-top="91">Standup 09:00 UTC</p><p id="l2" data-top="231" data-left="300">05/06/2024 11:00 UTC</p>';
    await load({ homeZone: 'UTC' });
    const a = await pin('l1');
    // Pin 1 goes right below its text.
    expect([px(a, 'top'), px(a, 'left')]).toEqual([91 + 20 + 8, 100]);
    const b = await pin('l2');
    const boxes = [boxOf(a), boxOf(b)];
    expect(overlap(boxes[0] as R, boxes[1] as R)).toBe(false);
    expect(overlap(boxes[1] as R, textBox('l1'))).toBe(false);
    expect(overlap(boxes[1] as R, textBox('l2'))).toBe(false);
    // Round 7 (QA G1, review nit #5): pin 1 no longer steps aside off the
    // new pin's text; it stays where it was pinned (and may cover that
    // text). Pin 2 goes beside its own text, since right below it is pin 1.
    expect([px(a, 'top'), px(a, 'left')]).toEqual([91 + 20 + 8, 100]);
    expect([px(b, 'top'), px(b, 'left')]).toEqual([231, 300 + 80 + 8]);
  });

  it('at 1280 px, five dates 138 px apart: no pin moves or covers another, before and after "Pin all to page"', async () => {
    setViewport(1280, 800);
    layOutPins();
    document.body.innerHTML = [0, 1, 2, 3, 4]
      .map((i) => `<p id="p${i}" data-top="${77 + i * 138}">2024-01-${10 + i}T12:00:00Z</p>`)
      .join('');
    await load({ homeZone: 'UTC' });
    const hosts: HTMLElement[] = [];
    const spots: string[] = [];
    const where = (h: HTMLElement): string => `${px(h, 'left')},${px(h, 'top')}`;
    for (let i = 0; i < 5; i++) {
      hosts.push(await pin(`p${i}`));
      // Round 7 (QA G1): pins already on the page never move.
      expect(hosts.slice(0, i).map(where)).toEqual(spots);
      spots.push(where(hosts[i] as HTMLElement));
    }
    // Round 7: a pin covers no other pin, and no date already pinned when it
    // was placed (nor its own). An earlier pin may cover a later date.
    const check = (): void => {
      const boxes = hosts.map(boxOf);
      boxes.forEach((box, i) => {
        boxes.forEach((other, j) => {
          if (i !== j) expect(overlap(box, other), `pins ${i} and ${j}`).toBe(false);
        });
        for (let k = 0; k <= i; k++) expect(overlap(box, textBox(`p${k}`)), `pin ${i} over date ${k}`).toBe(false);
      });
    };
    check();
    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true));
    button(dock(), 'Pin all to page').click();
    await vi.waitFor(() => expect(hosts.every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));
    // One by one in reading order, by the same rule: the same spots.
    expect(hosts.map(where)).toEqual(spots);
    check();
  });

  it('with no room beside (390 px), a pin on the same spot still steps off the other', async () => {
    setViewport(390, 800);
    layOutPins();
    document.body.innerHTML = '<p id="a" data-top="100">1700000000</p><p id="b" data-top="100">1600000000</p>';
    await load({ homeZone: 'UTC' });
    const a = await pin('a');
    const b = await pin('b');
    expect([px(a, 'top'), px(a, 'left')]).toEqual([128, 100]);
    expect([px(b, 'top'), px(b, 'left')]).not.toEqual([128, 100]);
  });
});
