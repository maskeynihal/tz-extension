import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Popover, moreTimesText } from '../src/content/Popover';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';
import { parseTimes } from '../src/lib/parse';

/**
 * Round-4 fixes for the content script: a mouse pin does not bring the
 * transient card back over the new pin, a selection with several times can
 * step through them, and Alt+Shift+T moves focus into the open card and back.
 */

const KEY = 'tz-extension-prefs';

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

async function load(initial: Record<string, unknown> = {}): Promise<void> {
  const data: Record<string, unknown> = { homeZone: 'UTC', targetZones: ['UTC'], hour12: false, cardSize: 'full', ...initial };
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
  // Preferences load asynchronously; select-to-convert waits for them.
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
const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};

/** Select an element's text and release the mouse on it, as a user's drag would end. */
async function selectWithMouse(id: string): Promise<void> {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
  await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
}

/** A real mouse click on a control inside a card: mousedown, mouseup, then click, all crossing the shadow root. */
function mouseClick(el: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
}

/** Longer than the selection debounce (200 ms). */
const AFTER_DEBOUNCE = 320;

const PAGE = `
  <p id="a" data-top="100">1700000000</p>
  <p id="two" data-top="300">2024-03-22-2024-03-25</p>
  <p id="three" data-top="500">Standup 10:00 UTC, retro 14:00 UTC, demo 16:30 UTC</p>
  <textarea id="ta" data-top="700">Deploy at 1700000000 sharp</textarea>
  <button id="other">Other</button>`;

describe('content script, round 4', () => {
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

  // Review #1
  it('pinning with the mouse does not bring the transient card back over the pin', async () => {
    await load();
    await selectWithMouse('a');
    mouseClick(button(transient(), 'Pin to page'));
    expect(pinHosts()).toHaveLength(1);
    await sleep(AFTER_DEBOUNCE);
    expect(transientHost()).toBeNull();
    expect(pinHosts()).toHaveLength(1);
    // The page selection is still there (copy keeps working).
    expect(window.getSelection()?.toString()).toBe('1700000000');
  });

  it('a later release over the kept selection does not reopen a pinned card either', async () => {
    await load();
    await selectWithMouse('a');
    // Pinned from the keyboard: no mouseup from the card at all.
    button(transient(), 'Pin to page').click();
    expect(pinHosts()).toHaveLength(1);
    // A key release that reads the selection again (Shift+Arrow, then Shift up).
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    await sleep(AFTER_DEBOUNCE);
    expect(transientHost()).toBeNull();
    // A fresh selection gesture of the same text opens it again.
    await selectWithMouse('a');
    expect(transientHost()).not.toBeNull();
  });

  it('clicking card buttons (compact, a zone ×) keeps the same card open, without a second one', async () => {
    await load({ targetZones: ['UTC', 'Asia/Tokyo'] });
    await selectWithMouse('a');
    const host = transientHost();
    mouseClick(button(transient(), 'Make compact'));
    await sleep(AFTER_DEBOUNCE);
    expect(transientHost()).toBe(host);
    expect(transient().querySelector('.tzx-card.compact')).toBeTruthy();
    mouseClick(button(transient(), 'Expand card'));
    const remove = (): HTMLButtonElement | null => transient().querySelector<HTMLButtonElement>('button.tzx-del[aria-label*="Tokyo"]');
    await vi.waitFor(() => expect(remove()).toBeTruthy());
    mouseClick(remove() as HTMLButtonElement);
    await sleep(AFTER_DEBOUNCE);
    expect(transientHost()).toBe(host);
    expect(document.querySelectorAll('#tz-extension-popover-host')).toHaveLength(1);
    expect(remove()).toBeNull();
  });

  it('a drag-selection of page text that ends over a pinned card still opens a card', async () => {
    await load();
    await selectWithMouse('a');
    button(transient(), 'Pin to page').click();
    const pin = pinHosts()[0] as HTMLElement;
    const el = document.getElementById('two') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }));
    pin.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0 }));
    await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
  });

  // QA #2
  it('steps between the times of one selection, keeps the mark on the shown one, and pins the shown one', async () => {
    await load();
    await selectWithMouse('two');
    const root = transient();
    const src = (): string => root.querySelector('.tzx-src span')?.textContent ?? '';
    const live = (): string => root.querySelector('[aria-live="polite"]')?.textContent ?? '';
    const marked = (): string => highlights.get('tz-extension-match')?.ranges[0]?.toString() ?? '';
    expect(src()).toBe('“2024-03-22”');
    expect(live()).toBe('Time 1 of 2');
    expect(root.querySelector('.tzx-step')?.textContent).toContain('1 of 2');
    expect(marked()).toBe('2024-03-22');

    mouseClick(button(root, 'Next time'));
    await vi.waitFor(() => expect(src()).toBe('“2024-03-25”'));
    expect(live()).toBe('Time 2 of 2');
    expect(marked()).toBe('2024-03-25');
    // Wraps around, both ways.
    mouseClick(button(root, 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 1 of 2'));
    expect(marked()).toBe('2024-03-22');
    mouseClick(button(root, 'Previous time'));
    await vi.waitFor(() => expect(live()).toBe('Time 2 of 2'));
    await sleep(AFTER_DEBOUNCE);
    expect(transientHost()?.shadowRoot).toBe(root);

    mouseClick(button(root, 'Pin to page'));
    const pin = pinHosts()[0] as HTMLElement;
    await vi.waitFor(() => expect(pin.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
    const pinRoot = pin.shadowRoot as ShadowRoot;
    expect(pinRoot.querySelector('.tzx-src span')?.textContent).toBe('“2024-03-25”');
    expect(pinRoot.querySelector('.tzx-more')?.textContent).toBe('+1 more time in selection');
    expect(highlights.get('tz-pin-0')?.ranges[0]?.toString()).toBe('2024-03-25');
  });

  it('a pinned second match keeps showing it when the day/month order changes', async () => {
    document.body.insertAdjacentHTML('beforeend', '<p id="dm" data-top="900">03/04/2024 10:00 UTC and 05/06/2024 11:00 UTC</p>');
    await load({ numericDateOrder: 'mdy' });
    await selectWithMouse('dm');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(transient().querySelector('[aria-live="polite"]')?.textContent).toBe('Time 2 of 2'));
    mouseClick(button(transient(), 'Pin to page'));
    const pin = pinHosts()[0] as HTMLElement;
    await vi.waitFor(() => expect(pin.shadowRoot?.querySelector('.tzx-order-btn')).toBeTruthy());
    const root = pin.shadowRoot as ShadowRoot;
    expect(root.querySelector('.tzx-src span')?.textContent).toBe('“05/06/2024 11:00 UTC”');
    const other = Array.from(root.querySelectorAll<HTMLButtonElement>('.tzx-order-btn')).find((b) => !b.classList.contains('on'));
    other?.click();
    await vi.waitFor(() => expect(root.querySelector('.tzx-order-btn.on')?.textContent).toContain('5 Jun'));
    expect(root.querySelector('.tzx-src span')?.textContent).toBe('“05/06/2024 11:00 UTC”');
  });

  it('marks the shown match, also when its text appears inside an earlier match', async () => {
    document.body.insertAdjacentHTML('beforeend', '<p id="dup" data-top="900">2024-01-02 10:00 UTC <b>and</b> 10:00 UTC</p>');
    await load();
    await selectWithMouse('dup');
    const marked = (): Range | undefined => highlights.get('tz-extension-match')?.ranges[0];
    const b = document.querySelector('#dup b') as HTMLElement;
    expect(marked()?.toString()).toBe('2024-01-02 10:00 UTC');
    await vi.waitFor(() => expect(transient().querySelector('button[aria-label="Next time"]')).toBeTruthy());
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(marked()?.toString()).toBe('10:00 UTC'));
    expect(marked()?.startContainer).toBe(b.nextSibling);
  });

  it('finds each match in the text: the most specific first, the rest in text order', async () => {
    await load();
    const { matchSpans, matchRange } = await import('../src/content/index');
    const m = (...texts: string[]): ParsedTime[] => texts.map((t) => ({ matchedText: t }) as ParsedTime);
    const text = '10:00 UTC or 2024-01-02 10:00 UTC or 10:00 UTC later 11:00 UTC';
    // The parser leads with the full timestamp, then the rest in text order.
    expect(matchSpans(text, m('2024-01-02 10:00 UTC', '10:00 UTC', '11:00 UTC'))).toEqual([
      [13, 33],
      [0, 9],
      [53, 62],
    ]);
    expect(matchSpans(text, m('2024-01-02 10:00 UTC', '11:00 UTC', '10:00 UTC'))).toEqual([[13, 33], [53, 62], null]);
    expect(matchSpans(text, m('nope'))).toEqual([null]);
    // Across text nodes.
    document.body.insertAdjacentHTML('beforeend', '<p id="split">at <i>2024-01-02</i> 10:00 UTC</p>');
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('split') as HTMLElement);
    expect(matchRange(r, m('2024-01-02 10:00 UTC'), 0)?.toString()).toBe('2024-01-02 10:00 UTC');
    expect(matchRange(r, m('2024-01-02 10:00 UTC'), 1)).toBeNull();
  });

  // QA #3
  it('Alt+Shift+T moves focus from a page field into the open card and back; Escape also returns it', async () => {
    await load();
    const ta = document.getElementById('ta') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(10, 20);
    // A keyboard selection: Shift+Arrow, then Shift released.
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
    await sleep(20);
    // Not taken: focus stays in the field.
    expect(document.activeElement).toBe(ta);
    const cardEl = transient().querySelector('.tzx-card') as HTMLElement;
    expect(cardEl.getAttribute('aria-description')).toBe('Alt+Shift+T to focus');
    expect(cardEl.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+T');
    expect(transient().querySelector('.tzx-head')?.getAttribute('title')).toContain('Alt+Shift+T to focus');

    // macOS sends "ˇ" as the key for Option+Shift+T; the physical key is what counts.
    const shortcut = (target: EventTarget): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: 'ˇ', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(e);
      return e;
    };
    expect(shortcut(ta).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(transientHost());
    expect(transient().activeElement).toBe(cardEl);
    // Again: back to the field, its selection intact, the card still open.
    expect(shortcut(cardEl).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([10, 20]);
    expect(transientHost()).not.toBeNull();

    // In again, then Escape closes the card and gives focus back.
    shortcut(ta);
    expect(transient().activeElement).toBe(cardEl);
    cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(transientHost()).toBeNull();
    expect(document.activeElement).toBe(ta);

    // No card: the keys are the page's, and focus does not move.
    expect(shortcut(ta).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(ta);
  });

  it('pinned cards do not offer the focus shortcut, and other modifier combinations do nothing', async () => {
    await load();
    const other = document.getElementById('other') as HTMLButtonElement;
    other.focus();
    await selectWithMouse('a');
    await sleep(20);
    expect(document.activeElement).toBe(other);
    for (const mods of [{ altKey: true }, { altKey: true, shiftKey: true, ctrlKey: true }, { shiftKey: true }]) {
      const e = new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', bubbles: true, cancelable: true, ...mods });
      other.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(other);
    }
    button(transient(), 'Pin to page').click();
    const pin = pinHosts()[0] as HTMLElement;
    await vi.waitFor(() => expect(pin.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
    expect(pin.shadowRoot?.querySelector('.tzx-card')?.hasAttribute('aria-description')).toBe(false);
  });
});

// --- Popover on its own ------------------------------------------------------

const PREFS: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC'], hour12: false };

function matches(text: string): ParsedTime[] {
  return parseTimes(text, { assumedZone: 'UTC' });
}

describe('Popover, round 4', () => {
  it('says "1 more time" and "2 more times"', () => {
    expect(moreTimesText(1)).toBe('+1 more time in selection');
    expect(moreTimesText(2)).toBe('+2 more times in selection');
    const m = matches('10:00 UTC, 11:00 UTC, 12:00 UTC');
    expect(m).toHaveLength(3);
    const { container } = render(
      <Popover parsed={m[0] as ParsedTime} matchCount={3} prefs={PREFS} pinned onClose={() => {}} />,
    );
    expect(container.querySelector('.tzx-more')?.textContent).toBe('+2 more times in selection');
    expect(container.querySelector('button[aria-label="Next time"]')).toBeNull();
  });

  it('offers a stepper when it can step, and reports which way', () => {
    const m = matches('10:00 UTC, 11:00 UTC, 12:00 UTC');
    const onStep = vi.fn();
    const { container } = render(
      <Popover parsed={m[1] as ParsedTime} matchCount={3} matchIndex={1} prefs={PREFS} pinned={false} onClose={() => {}} onStep={onStep} />,
    );
    const group = container.querySelector('[role="group"][aria-label="Times in selection"]');
    expect(group).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Time 2 of 3');
    // Buttons keep the page selection like every other card control.
    const next = container.querySelector('button[aria-label="Next time"]') as HTMLButtonElement;
    expect(fireEvent.mouseDown(next)).toBe(false);
    fireEvent.click(next);
    fireEvent.click(container.querySelector('button[aria-label="Previous time"]') as HTMLButtonElement);
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('shows no stepper for a single match or on a compact card', () => {
    const m = matches('10:00 UTC, 11:00 UTC');
    const one = render(<Popover parsed={m[0] as ParsedTime} matchCount={1} prefs={PREFS} pinned={false} onClose={() => {}} onStep={() => {}} />);
    expect(one.container.querySelector('.tzx-step')).toBeNull();
    const compact = render(
      <Popover parsed={m[0] as ParsedTime} matchCount={2} prefs={PREFS} pinned={false} compact onClose={() => {}} onStep={() => {}} />,
    );
    expect(compact.container.querySelector('.tzx-step')).toBeNull();
  });
});
