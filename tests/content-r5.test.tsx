import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Popover, focusHint, stepCountText, UNBOUND_FOCUS_HINT, moreTimesText } from '../src/content/Popover';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';
import { parseTimes } from '../src/lib/parse';
import { shortcutLabel } from '../src/background/commands';

/**
 * Round-5 fixes for the content script: the focus key is a browser command
 * (no page keys are intercepted), the stepper counts in reading order and
 * marks each match through its place in the selection's string, more than
 * 25 times are listed, compact cards step too, stepping scrolls an
 * off-screen match into view, and open cards follow settings changed
 * elsewhere.
 */

const KEY = 'tz-extension-prefs';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const highlights = new Map<string, FakeHighlight>();

/** Page scroll the rect mock subtracts (moved by the scroll mocks). */
let scrolled = 0;

/** Rect of a page range: from the `data-top` of the element holding it, less the scroll; zero when collapsed. */
function rangeRect(this: Range): DOMRect {
  if (this.collapsed) return new DOMRect(0, 0, 0, 0);
  const node = this.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const top = Number(el?.closest('[data-top]')?.getAttribute('data-top') ?? 100);
  return new DOMRect(100, top - scrolled, 80, 20);
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

interface Env {
  /** The content script's runtime message listener. */
  readonly listener: Listener;
  readonly sendMessage: ReturnType<typeof vi.fn>;
  /** Write prefs as another context would (fires onChanged). */
  writeElsewhere(patch: Record<string, unknown>): void;
}

/** Load the content script; the worker answers `tzx/get-shortcut` with `shortcut`. */
async function load(initial: Record<string, unknown> = {}, shortcut: string | null = 'Alt+Shift+K'): Promise<Env> {
  let data: Record<string, unknown> = { homeZone: 'UTC', targetZones: ['UTC'], hour12: false, cardSize: 'full', ...initial };
  const changeListeners: ChangeListener[] = [];
  const listeners: Listener[] = [];
  const sendMessage = vi.fn(async (msg: { type?: string }) =>
    msg?.type === 'tzx/get-shortcut' && shortcut !== null ? { shortcut } : { ok: true },
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
const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
  const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};
const live = (): string => transient().querySelector('.tzx-stepcount[aria-live="polite"]')?.textContent ?? '';
const src = (): string => transient().querySelector('.tzx-src span')?.textContent ?? '';
const marked = (): Range | undefined => highlights.get('tz-extension-match')?.ranges[0];

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

function mouseClick(el: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 }));
  }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, button: 0 }));
}

/** Send the worker's focus command to the content script; resolves with its answer, if any. */
function focusCommand(env: Env): unknown {
  let answer: unknown;
  env.listener({ type: 'tzx/focus-card' }, { id: 'ext-id' }, (r) => {
    answer = r;
  });
  return answer;
}

const PAGE = `
  <p id="three" data-top="100">Standup 09:00 UTC, review 13:30 UTC, deploy 2024-04-02 18:00 UTC</p>
  <p id="cite" data-top="200">See John 3:16. Call at 3:16 today</p>
  <p id="wrap" data-top="300">at 10:00
     UTC today</p>
  <p id="dm" data-top="400">03/04/2024 10:00 UTC and 05/06/2024 11:00 UTC</p>
  <textarea id="ta" data-top="500">Deploy at 1700000000 sharp</textarea>`;

describe('content script, round 5', () => {
  let origRect: typeof Range.prototype.getBoundingClientRect | undefined;

  beforeEach(() => {
    document.body.innerHTML = PAGE;
    highlights.clear();
    scrolled = 0;
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
    vi.restoreAllMocks();
  });

  // Review #2
  it('the focus command moves focus from a page field into the card and back; page keys are never taken', async () => {
    const env = await load();
    const ta = document.getElementById('ta') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(10, 20);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    await vi.waitFor(() => expect(transientHost()?.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
    const cardEl = transient().querySelector('.tzx-card') as HTMLElement;
    // The binding comes from the worker (chrome.commands.getAll there).
    await vi.waitFor(() => expect(cardEl.getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+K'));
    expect(env.sendMessage).toHaveBeenCalledWith({ type: 'tzx/get-shortcut' });
    expect(cardEl.getAttribute('aria-description')).toBe('Alt+Shift+K to focus');
    expect(transient().querySelector('.tzx-head')?.getAttribute('title')).toBe('Drag to move · Alt+Shift+K to focus');
    expect(document.activeElement).toBe(ta);

    // No key handler: neither the old keys nor the new ones are stopped.
    for (const [key, code] of [['ˇ', 'KeyT'], ['K', 'KeyK']]) {
      const e = new KeyboardEvent('keydown', { key, code, altKey: true, shiftKey: true, bubbles: true, cancelable: true });
      ta.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(ta);
    }

    expect(focusCommand(env)).toEqual({ ok: true });
    expect(document.activeElement).toBe(transientHost());
    expect(transient().activeElement).toBe(cardEl);
    expect(focusCommand(env)).toEqual({ ok: true });
    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([10, 20]);

    // No card: no answer (another frame may have it), focus stays.
    cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(transientHost()).toBeNull();
    expect(focusCommand(env)).toBeUndefined();
    expect(document.activeElement).toBe(ta);
  });

  it('ignores a focus command from anyone but the extension', async () => {
    const env = await load();
    await selectWithMouse('three');
    let answered = false;
    env.listener({ type: 'tzx/focus-card' }, { id: 'other-ext' }, () => {
      answered = true;
    });
    expect(answered).toBe(false);
  });

  it('with no key bound, the hint says where to set one', async () => {
    await load({}, '');
    await selectWithMouse('three');
    const cardEl = transient().querySelector('.tzx-card') as HTMLElement;
    await vi.waitFor(() => expect(cardEl.getAttribute('aria-description')).toBe(UNBOUND_FOCUS_HINT));
    expect(cardEl.hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(transient().querySelector('.tzx-head')?.getAttribute('title')).toBe(`Drag to move · ${UNBOUND_FOCUS_HINT}`);
  });

  // QA N1 and review #5
  it('numbers the times in reading order, opens on the best one, and marks each where it is', async () => {
    await load();
    await selectWithMouse('three');
    const p = document.querySelector('#three')?.firstChild as Text;
    expect(src()).toBe('“2024-04-02 18:00 UTC”');
    expect(live()).toBe('Time 3 of 3');
    expect(marked()?.toString()).toBe('2024-04-02 18:00 UTC');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 1 of 3'));
    expect(src()).toBe('“09:00 UTC”');
    expect(marked()?.startOffset).toBe(8);
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 2 of 3'));
    expect(src()).toBe('“13:30 UTC”');
    expect(marked()?.startContainer).toBe(p);
    expect(marked()?.startOffset).toBe(26);
  });

  it('marks the time the parser read, not an earlier copy of its text that was refused', async () => {
    await load();
    await selectWithMouse('cite');
    expect(src()).toBe('“3:16”');
    // "See John 3:16" is a verse; the mark is on the second "3:16".
    expect(marked()?.toString()).toBe('3:16');
    expect(marked()?.startOffset).toBe(23);
  });

  it('marks the right place when the selection starts with whitespace the parser trims', async () => {
    document.body.insertAdjacentHTML('beforeend', '<p id="lead" data-top="600">   \n  meet at 09:30 UTC, not 09:30</p>');
    await load();
    await selectWithMouse('lead');
    const text = (document.getElementById('lead') as HTMLElement).textContent as string;
    expect(marked()?.toString()).toBe('09:30 UTC');
    expect(marked()?.startOffset).toBe(text.indexOf('09:30'));
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(marked()?.startOffset).toBe(text.lastIndexOf('09:30')));
  });

  it('the day/month order picked on a card keeps the step it shows', async () => {
    await load({ numericDateOrder: 'mdy' });
    await selectWithMouse('dm');
    expect(live()).toBe('Time 1 of 2');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 2 of 2'));
    const other = Array.from(transient().querySelectorAll<HTMLButtonElement>('.tzx-order-btn')).find((b) => !b.classList.contains('on'));
    other?.click();
    await vi.waitFor(() => expect(transient().querySelector('.tzx-order-btn.on')?.textContent).toContain('5 Jun'));
    expect(live()).toBe('Time 2 of 2');
    expect(src()).toBe('“05/06/2024 11:00 UTC”');
  });

  // QA N9
  it('an open card follows settings changed in another tab, on the same step', async () => {
    const env = await load({ numericDateOrder: 'mdy', targetZones: ['UTC'] });
    await selectWithMouse('dm');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 2 of 2'));
    const rows = (): string[] => Array.from(transient().querySelectorAll('.tzx-row')).map((r) => r.textContent ?? '');
    expect(rows().join('|')).toContain('11:00');
    env.writeElsewhere({ numericDateOrder: 'dmy', hour12: true, targetZones: ['UTC', 'Asia/Tokyo'] });
    await vi.waitFor(() => expect(transient().querySelector('.tzx-order-btn.on')?.textContent).toContain('5 Jun'));
    expect(live()).toBe('Time 2 of 2');
    expect(src()).toBe('“05/06/2024 11:00 UTC”');
    await vi.waitFor(() => expect(rows().some((r) => /Tokyo/.test(r))).toBe(true));
    expect(rows().join('|')).toMatch(/11:00:00\sAM/);
    // A pinned card follows too.
    mouseClick(button(transient(), 'Pin to page'));
    const pin = pinHosts()[0] as HTMLElement;
    await vi.waitFor(() => expect(pin.shadowRoot?.querySelector('.tzx-card')).toBeTruthy());
    const pinRows = (): string =>
      Array.from(pin.shadowRoot?.querySelectorAll('.tzx-row') ?? []).map((r) => r.textContent ?? '').join('|');
    expect(pinRows()).toMatch(/11:00:00\sAM/);
    env.writeElsewhere({ hour12: false });
    await vi.waitFor(() => expect(pinRows()).not.toMatch(/AM|PM/));
    expect(pinRows()).toMatch(/11:00:00/);
  });

  // QA N4
  it('stepping to a time below the screen scrolls it into view, keeps the card and puts it next to the time', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `<div data-top="${40 + i * 30}">Item ${i} at 2024-06-${String(i + 1).padStart(2, '0')} 10:05 UTC</div>`).join('\n');
    document.body.insertAdjacentHTML('beforeend', `<section id="list">${lines}</section>`);
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    });
    const scrollIntoView = vi.fn(function (this: Element, _opts?: ScrollIntoViewOptions) {
      const top = Number(this.closest('[data-top]')?.getAttribute('data-top') ?? 0);
      if (top - scrolled > 700 - 20) scrolled = top + 20 - 700;
    });
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(((o: ScrollToOptions) => {
      scrolled += o.top ?? 0;
    }) as typeof window.scrollBy);
    await load();
    await selectWithMouse('list');
    const host = transientHost() as HTMLElement;
    expect(live()).toBe('Time 1 of 30');
    // Items 0-21 (data-top up to 670) are on screen; item 22 (700) is not.
    for (let i = 0; i < 21; i++) mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 22 of 30'));
    expect(scrollIntoView).not.toHaveBeenCalled();
    const before = host.style.getPropertyValue('top');
    mouseClick(button(transient(), 'Next time'));
    await vi.waitFor(() => expect(live()).toBe('Time 23 of 30'));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ block: 'nearest' });
    expect(marked()?.toString()).toBe('2024-06-23 10:05 UTC');
    // That scroll's event does not close the card.
    document.dispatchEvent(new Event('scroll'));
    expect(transientHost()).toBe(host);
    // The time is on screen now, and the card sits next to it (above: no room below).
    // Round 6 (QA F7): not flush on the edge; 48 px (REVEAL_MARGIN) clear of it.
    const box = marked()?.getBoundingClientRect() as DOMRect;
    expect(scrollBy).toHaveBeenCalledWith({ top: 48, behavior: 'instant' });
    expect(box.top).toBe(680 - 48);
    expect(box.bottom).toBe(700 - 48);
    const top = parseFloat(host.style.getPropertyValue('top'));
    expect(host.style.getPropertyValue('top')).not.toBe(before);
    expect(top).toBe(680 - 48 - 8 - 200);
    // A user's scroll later still closes it.
    await sleep(300);
    document.dispatchEvent(new Event('scroll'));
    expect(transientHost()).toBeNull();
  });
});

describe('mapping the selection string to the page', () => {
  afterEach(() => {
    const slot = window as unknown as Record<string, { dispose(): void } | undefined>;
    slot.__tzExtensionContent__?.dispose();
    delete slot.__tzExtensionContent__;
  });

  async function api(): Promise<typeof import('../src/content/index')> {
    await load();
    return import('../src/content/index');
  }

  it('lines a collapsed-whitespace string up with the page text, across a line break', async () => {
    const { mapSelectionText, spanRange } = await api();
    document.body.innerHTML = '<p id="w">at 10:00\n     UTC today</p>';
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('w') as HTMLElement);
    // What Chrome's Selection.toString() gives for it.
    const sel = 'at 10:00 UTC today';
    const found = parseTimes(sel, 'UTC')[0] as ParsedTime;
    expect(found.matchedText).toBe('10:00 UTC');
    const map = mapSelectionText(r, sel);
    const range = spanRange(sel, map, found.sourceIndex as number, (found.sourceIndex as number) + found.matchedText.length);
    expect(range?.toString()).toBe('10:00\n     UTC');
  });

  it('across elements, with breaks the string adds between blocks and text it leaves out', async () => {
    const { mapSelectionText, spanRange } = await api();
    document.body.innerHTML = '<div id="d"><p>Deploy <b>2024-01-02</b></p><script>var x = "10:00";</script><p>  10:00   UTC </p></div>';
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('d') as HTMLElement);
    const sel = 'Deploy 2024-01-02\n\n10:00 UTC';
    const map = mapSelectionText(r, sel);
    const at = sel.indexOf('10:00');
    const range = spanRange(sel, map, at, at + '10:00 UTC'.length);
    expect(range?.toString()).toBe('10:00   UTC');
    expect(range?.startContainer.parentElement?.tagName).toBe('P');
    const date = spanRange(sel, map, 7, 17);
    expect(date?.toString()).toBe('2024-01-02');
    // A span whose text is not what the page has there: none.
    expect(spanRange('Deploy 2024-01-03', map, 7, 17)).toBeNull();
  });
});

describe('listing every time (QA N2)', () => {
  // Round 6: the content script uses readTimes from src/lib/read-times.ts
  // (its own copy, with a time budget, is gone); these call that one.
  it('lists 60 times past the parser cap of 25 per format, in reading order, fast', async () => {
    const { readTimes } = await import('../src/lib/read-times');
    const text = Array.from(
      { length: 60 },
      (_, i) => `Item ${i} at 2024-05-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:15 UTC`,
    ).join('\n');
    expect(parseTimes(text, 'UTC')).toHaveLength(25);
    const t0 = performance.now();
    const r = readTimes(text, { assumedZone: 'UTC' });
    const ms = performance.now() - t0;
    expect(r.matches).toHaveLength(60);
    expect(r.capped).toBe(false);
    expect(ms).toBeLessThan(50);
    r.matches.forEach((p, i) => {
      expect(p.matchedText).toBe(`2024-05-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:15 UTC`);
      expect(text.slice(p.sourceIndex, (p.sourceIndex as number) + p.matchedText.length)).toBe(p.matchedText);
    });
  });
});

// --- Popover on its own ------------------------------------------------------

const PREFS: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC'], hour12: false };

describe('Popover, round 5', () => {
  it('compact cards step too, with a small "‹ 1/2 ›"', () => {
    const m = parseTimes('2024-03-22-2024-03-25', 'UTC');
    expect(m).toHaveLength(2);
    const onStep = vi.fn();
    const { container } = render(
      <Popover parsed={m[0] as ParsedTime} matchCount={2} prefs={PREFS} pinned={false} compact onClose={() => {}} onStep={onStep} />,
    );
    const step = container.querySelector('.tzx-step.mini');
    expect(step).toBeTruthy();
    expect(step?.querySelector('.tzx-stepcount[aria-live="polite"]')?.textContent).toBe('Time 1/2');
    expect(step?.textContent).not.toContain('times in selection');
    fireEvent.click(container.querySelector('button[aria-label="Next time"]') as HTMLButtonElement);
    expect(onStep).toHaveBeenCalledWith(1);
  });

  it('shows "25+" and why when not every time is listed', () => {
    const m = parseTimes('10:00 UTC, 11:00 UTC', 'UTC');
    const { container } = render(
      <Popover parsed={m[0] as ParsedTime} matchCount={25} matchesCapped prefs={PREFS} pinned={false} onClose={() => {}} onStep={() => {}} />,
    );
    const step = container.querySelector('.tzx-step') as HTMLElement;
    // Round 7 (QA G7): up to 500 times are listed now, so 25 listed with
    // more in the selection means the text ran past what is read.
    expect(step.getAttribute('title')).toBe('Text past the first 50,000 characters is not read');
    expect(step.querySelector('.tzx-stepcount[aria-live="polite"]')?.textContent).toBe('Time 1 of 25+. Text past the first 50,000 characters is not read');
    expect(stepCountText(0, 25, true)).toBe('1 of 25+');
    expect(stepCountText(4, 7)).toBe('5 of 7');
    expect(moreTimesText(24, true)).toBe('+24 or more times in selection');
  });

  it('the focus hint follows the binding', () => {
    expect(focusHint(undefined)).toBeUndefined();
    expect(focusHint(null)).toBe(UNBOUND_FOCUS_HINT);
    expect(focusHint(shortcutLabel('Alt+Shift+K'))).toBe('Alt+Shift+K to focus');
    const m = parseTimes('10:00 UTC', 'UTC');
    const pinned = render(
      <Popover parsed={m[0] as ParsedTime} matchCount={1} prefs={PREFS} pinned focusShortcut={shortcutLabel('Alt+Shift+K')} onClose={() => {}} />,
    );
    expect(pinned.container.querySelector('.tzx-card')?.hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('reads the browser binding formats for aria-keyshortcuts', () => {
    expect(shortcutLabel('Alt+Shift+K')).toEqual({ display: 'Alt+Shift+K', aria: 'Alt+Shift+K' });
    // Chrome on macOS reports symbols.
    expect(shortcutLabel('⌃⇧K')).toEqual({ display: 'Ctrl+Shift+K', aria: 'Control+Shift+K' });
    expect(shortcutLabel('⌘⇧Y')).toEqual({ display: 'Command+Shift+Y', aria: 'Meta+Shift+Y' });
    // Firefox reports the manifest names.
    expect(shortcutLabel('MacCtrl+Shift+K')).toEqual({ display: 'Ctrl+Shift+K', aria: 'Control+Shift+K' });
    expect(shortcutLabel('Ctrl+Alt+P')).toEqual({ display: 'Ctrl+Alt+P', aria: 'Control+Alt+P' });
    expect(shortcutLabel('')).toBeNull();
    expect(shortcutLabel(undefined)).toBeNull();
  });
});
