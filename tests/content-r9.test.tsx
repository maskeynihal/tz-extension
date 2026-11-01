import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';

/**
 * Round-9 fixes for the content script: on an app-shell page (the window
 * cannot scroll; an inner pane does) pins stay on screen and nothing
 * scrolls the window; an off-page wrapper that clips its content is still
 * seen as positioned; and on a right-to-left page `left: -9999px` text is
 * left out again.
 */

const KEY = 'tz-extension-prefs';

/** The window's scroll, as the mocks below and `window.scrollX/Y` report it. */
const scroll = { x: 0, y: 0 };

/** Rect of a page range: `data-top` / `data-left` of its element, less the window's scroll; 80×20. */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  const left = Number(el?.closest('[data-left]')?.getAttribute('data-left') ?? 100);
  return new DOMRect(left - scroll.x, top - scroll.y, 80, 20);
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

async function load(): Promise<void> {
  const data: Record<string, unknown> = { homeZone: 'UTC', targetZones: ['UTC'], hour12: false, cardSize: 'full', keepSelection: true };
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
const quoted = (): string => transient().querySelector('.tzx-src span')?.textContent ?? '';
const live = (): string => transient().querySelector('.tzx-stepcount[aria-live="polite"]')?.textContent ?? '';

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

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
}

function setDocumentSize(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
}

/** Pinned hosts measure 245×313 where their style puts them, less the window's scroll. */
function layOutPins(): void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (!this.classList.contains('tz-extension-pin-host')) return real.call(this);
    const left = parseFloat(this.style.getPropertyValue('left')) || 0;
    const top = parseFloat(this.style.getPropertyValue('top')) || 0;
    const fixed = this.style.getPropertyValue('position') === 'fixed';
    return new DOMRect(fixed ? left : left - scroll.x, fixed ? top : top - scroll.y, 245, 313);
  };
  onTestFinished(() => {
    HTMLElement.prototype.getBoundingClientRect = real;
  });
}

describe('content script, round 9', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;
  const view = { w: window.innerWidth, h: window.innerHeight };

  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('dir');
    origRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = rangeRect;
    scroll.x = 0;
    scroll.y = 0;
    Object.defineProperty(window, 'scrollX', { get: () => scroll.x, configurable: true });
    Object.defineProperty(window, 'scrollY', { get: () => scroll.y, configurable: true });
    setViewport(390, 800);
    setDocumentSize(390, 800);
  });
  afterEach(() => {
    setViewport(view.w, view.h);
    setDocumentSize(0, 0);
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true, writable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('dir');
    if (origRect) Range.prototype.getBoundingClientRect = origRect;
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
    vi.restoreAllMocks();
  });

  // Review r9 Major #1
  it('on an app-shell page (body overflow hidden), every new pin stays on screen and the window is never scrolled', async () => {
    document.body.style.setProperty('overflow', 'hidden');
    layOutPins();
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });
    document.body.innerHTML = Array.from(
      { length: 6 },
      (_, i) => `<p id="l${i}" data-top="${60 + i * 40}">Line ${i} at 2024-06-0${i + 1} 10:00 UTC</p>`,
    ).join('');
    await load();
    for (let i = 0; i < 6; i++) {
      await select(`l${i}`);
      mouseClick(transient().querySelector<HTMLButtonElement>('button[aria-label="Pin to page"]') as HTMLButtonElement);
      await vi.waitFor(() => expect(pinHosts()).toHaveLength(i + 1));
      for (const h of pinHosts()) {
        const b = h.getBoundingClientRect();
        expect(b.top, `pin over ${i}`).toBeGreaterThanOrEqual(0);
        expect(b.bottom, `pin over ${i}`).toBeLessThanOrEqual(800);
      }
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scroll.y).toBe(0);
  });

  it('the same page with html overflow hidden (body visible) counts as an app shell too', async () => {
    document.documentElement.style.setProperty('overflow', 'hidden');
    layOutPins();
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });
    document.body.innerHTML = Array.from(
      { length: 4 },
      (_, i) => `<p id="l${i}" data-top="${60 + i * 40}">Line ${i} at 2024-06-0${i + 1} 10:00 UTC</p>`,
    ).join('');
    await load();
    for (let i = 0; i < 4; i++) {
      await select(`l${i}`);
      mouseClick(transient().querySelector<HTMLButtonElement>('button[aria-label="Pin to page"]') as HTMLButtonElement);
      await vi.waitFor(() => expect(pinHosts()).toHaveLength(i + 1));
    }
    for (const h of pinHosts()) expect(h.getBoundingClientRect().bottom).toBeLessThanOrEqual(800);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('a page that scrolls still stacks pins below the screen and brings each into view', async () => {
    setDocumentSize(390, 3000);
    layOutPins();
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });
    document.body.innerHTML = Array.from(
      { length: 3 },
      (_, i) => `<p id="l${i}" data-top="${60 + i * 40}">Line ${i} at 2024-06-0${i + 1} 10:00 UTC</p>`,
    ).join('');
    await load();
    for (let i = 0; i < 3; i++) {
      await select(`l${i}`);
      mouseClick(transient().querySelector<HTMLButtonElement>('button[aria-label="Pin to page"]') as HTMLButtonElement);
      await vi.waitFor(() => expect(pinHosts()).toHaveLength(i + 1));
    }
    expect(Math.max(...pinHosts().map((h) => h.getBoundingClientRect().bottom))).toBeGreaterThan(800);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  // Review r9 Minor #3
  it('an off-left wrapper that clips its content is still positioned text, and left out', async () => {
    setViewport(1280, 800);
    document.body.innerHTML =
      '<p id="p" data-top="100">Visible 2024-08-01 10:00 UTC <span style="position:absolute;left:-9999px;overflow:hidden" data-left="-9999"><b>2024-08-12 06:00 UTC</b></span> end</p>';
    await load();
    await select('p');
    expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
    expect(transient().querySelector('.tzx-step')).toBeNull();
  });

  // Review r9 Minor #4
  it('on a right-to-left page, left:-9999px text is left out again, while text a screen to the left is kept', async () => {
    setViewport(1280, 800);
    setDocumentSize(3000, 800);
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.style.setProperty('direction', 'rtl');
    document.body.innerHTML = `
      <p id="sr" data-top="100">Visible 2024-08-01 10:00 UTC <span style="position:absolute;left:-9999px" data-left="-9999">2024-08-12 06:00 UTC</span> end</p>
      <p id="near" data-top="200">x <span style="position:absolute;left:-800px" data-left="-800">2024-08-13 07:00 UTC</span> y</p>`;
    await load();
    await select('sr');
    expect(quoted()).toBe('“2024-08-01 10:00 UTC”');
    expect(transient().querySelector('.tzx-step')).toBeNull();
    transient().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await select('near');
    expect(quoted()).toBe('“2024-08-13 07:00 UTC”');
    expect(live()).toBe('');
  });
});
