import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { parseTimes, SCAN_LIMIT } from '../lib/parse';
import { loadPreferences, savePreferences, onPreferencesChanged } from '../lib/storage';
import { resolveTheme } from '../lib/theme';
import {
  fromThisExtension,
  isConvertSelectionMessage,
  type Ack,
  type OpenOptionsMessage,
} from '../lib/messages';
import { DEFAULT_PREFERENCES, type DateOnlyPolicy, type ParsedTime, type Preferences } from '../types';
import { NoMatchCard, Popover } from './Popover';

const TRANSIENT_HOST_ID = 'tz-extension-popover-host';
const PIN_HOST_CLASS = 'tz-extension-pin-host';
const DEBOUNCE_MS = 200;
const CARD_MAX_W = 360;
const MARGIN = 8;
const EST_HEIGHT = 200;

let prefs: Preferences = DEFAULT_PREFERENCES;
/** Until stored prefs arrive we do not know whether select-to-convert is on. */
let prefsLoaded = false;
/** Resolves once stored prefs are in `prefs` (menu clicks wait for it). */
let prefsReady: Promise<void> = Promise.resolve();
let debounceTimer: number | undefined;
/** Where the last right-click happened (viewport coords), to anchor menu cards. */
let lastContextPoint: { x: number; y: number } | null = null;

/** Parse with every current preference that affects matching. */
function parseWithPrefs(text: string, policy: DateOnlyPolicy = prefs.dateOnlyPolicy): ParsedTime[] {
  return parseTimes(text, {
    assumedZone: prefs.homeZone,
    dateOnlyPolicy: policy,
    customFormats: prefs.customFormats,
    disabledFormats: prefs.disabledFormats,
  });
}

/**
 * Tag a popover's shadow host with the resolved theme so the shadow CSS can
 * override the OS `prefers-color-scheme`. For `system` we leave the attribute
 * off and let the media query decide.
 */
function applyHostTheme(hostEl: HTMLElement): void {
  if (prefs.theme === 'light' || prefs.theme === 'dark') {
    hostEl.setAttribute('data-tz-theme', resolveTheme(prefs.theme));
  } else {
    hostEl.removeAttribute('data-tz-theme');
  }
}

// --- Transient popover (one at a time) ------------------------------------
let tHost: HTMLDivElement | null = null;
let tRoot: Root | null = null;

// --- Pinned cards (many, independent) -------------------------------------
interface Pin {
  readonly host: HTMLDivElement;
  readonly root: Root;
  /** Document-space anchor (page coords, not viewport) so it scrolls with content. */
  readonly pageX: number;
  readonly pageY: number;
  /** Highlight slot index (color + number) this pin owns. */
  readonly slot: number;
  /** The highlighted range for this pin, so it can be restored/cleared. */
  readonly range: Range | null;
}
const pins = new Set<Pin>();
/** Which pin slots are currently in use (one highlight color each). */
const usedSlots = new Set<number>();
function nextSlot(): number {
  let i = 0;
  while (usedSlots.has(i)) i++;
  usedSlots.add(i);
  return i;
}

// --- Selection highlights -------------------------------------------------
// Each open card keeps its OWN persistent highlight on its OWN selected text,
// via the CSS Custom Highlight API. The transient popover uses the amber
// "live" slot; pinning promotes that mark to a numbered, colored pin slot so
// several pinned cards can each stay tied to their text. The card header shows
// the matching number + color, so with many pins you can tell which card maps
// to which highlight.
const LIVE_HL = 'tz-extension-match';
// Colored palette for pinned highlights (bg + readable ink). Index = pin number.
const PIN_COLORS: ReadonlyArray<{ bg: string; ink: string; dot: string }> = [
  { bg: 'rgba(250, 204, 21, 0.85)', ink: '#1a1a1a', dot: '#eab308' }, // amber
  { bg: 'rgba(96, 165, 250, 0.80)', ink: '#0b1220', dot: '#3b82f6' }, // blue
  { bg: 'rgba(52, 211, 153, 0.80)', ink: '#06231a', dot: '#10b981' }, // green
  { bg: 'rgba(244, 114, 182, 0.80)', ink: '#2a0a1b', dot: '#ec4899' }, // pink
  { bg: 'rgba(251, 146, 60, 0.85)', ink: '#2a1206', dot: '#f97316' }, // orange
  { bg: 'rgba(167, 139, 250, 0.82)', ink: '#160a2e', dot: '#8b5cf6' }, // violet
];
let highlightStyleInjected = false;

interface HighlightRegistry {
  set(name: string, hl: unknown): void;
  delete(name: string): void;
}
function highlightRegistry(): HighlightRegistry | null {
  const c = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return c && c.highlights ? c.highlights : null;
}
function HighlightCtor(): (new (range: Range) => unknown) | null {
  return (globalThis as unknown as { Highlight?: new (r: Range) => unknown }).Highlight ?? null;
}

/** The color for a given pin slot index (wraps if there are more pins than colors). */
export function pinColor(slot: number): { bg: string; ink: string; dot: string } {
  return PIN_COLORS[slot % PIN_COLORS.length] as { bg: string; ink: string; dot: string };
}

function ensureHighlightStyle(): void {
  if (highlightStyleInjected) return;
  try {
    const style = document.createElement('style');
    style.id = 'tz-extension-highlight-style';
    // Live (transient) slot = amber; one rule per pin slot in its palette color.
    const rules = [`::highlight(${LIVE_HL}) { background-color: rgba(250,204,21,0.85); color: #1a1a1a; }`];
    for (let i = 0; i < PIN_COLORS.length; i++) {
      const c = PIN_COLORS[i] as { bg: string; ink: string };
      rules.push(`::highlight(tz-pin-${i}) { background-color: ${c.bg}; color: ${c.ink}; }`);
    }
    style.textContent = rules.join('\n');
    (document.head ?? document.documentElement).appendChild(style);
    highlightStyleInjected = true;
  } catch {
    /* ignore */
  }
}

/**
 * Narrow a selection range to the matched token. Triple-click selections span
 * a whole block whose text lives across several child text nodes, so we walk
 * the text nodes inside the range and anchor to the first one that contains the
 * token. Falls back to the full range when it cannot be located contiguously.
 */
function narrowRangeToToken(range: Range, token: string): Range {
  if (!token) return range;

  // Fast path: selection is itself a single text node.
  const sc = range.startContainer;
  if (sc.nodeType === Node.TEXT_NODE && typeof (sc as Text).data === 'string') {
    const idx = (sc as Text).data.indexOf(token);
    if (idx >= 0) {
      try {
        const r = document.createRange();
        r.setStart(sc, idx);
        r.setEnd(sc, idx + token.length);
        return r;
      } catch {
        /* fall through */
      }
    }
  }

  // General path: walk text nodes intersecting the range.
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) return range;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      range.intersectsNode(n) && (n as Text).data.includes(token)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  const hit = walker.nextNode() as Text | null;
  if (hit) {
    const idx = hit.data.indexOf(token);
    if (idx >= 0) {
      try {
        const r = document.createRange();
        r.setStart(hit, idx);
        r.setEnd(hit, idx + token.length);
        return r;
      } catch {
        /* fall through */
      }
    }
  }
  return range;
}

/** The live (transient) popover's highlight on its selected token. */
let liveRange: Range | null = null;

function setLiveHighlight(range: Range, token: string): void {
  if (!prefs.keepSelection) return;
  const reg = highlightRegistry();
  const Ctor = HighlightCtor();
  if (!reg || !Ctor) return;
  try {
    ensureHighlightStyle();
    liveRange = narrowRangeToToken(range, token).cloneRange();
    reg.set(LIVE_HL, new Ctor(liveRange));
    // Collapse the native selection so our marker is the visible one.
    window.setTimeout(() => {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    }, 0);
  } catch {
    liveRange = null;
  }
}

function clearLiveHighlight(): void {
  const reg = highlightRegistry();
  if (reg) {
    try {
      reg.delete(LIVE_HL);
    } catch {
      /* ignore */
    }
  }
  liveRange = null;
}

/** Promote the live range into a numbered pin slot's own colored highlight. */
function setPinHighlight(slot: number, range: Range | null): void {
  const reg = highlightRegistry();
  const Ctor = HighlightCtor();
  if (!reg || !Ctor || !range) return;
  try {
    ensureHighlightStyle();
    reg.set(`tz-pin-${slot % PIN_COLORS.length}`, new Ctor(range.cloneRange()));
  } catch {
    /* ignore */
  }
}

function clearPinHighlight(slot: number): void {
  const reg = highlightRegistry();
  if (reg) {
    try {
      reg.delete(`tz-pin-${slot % PIN_COLORS.length}`);
    } catch {
      /* ignore */
    }
  }
}

// --- Positioning ----------------------------------------------------------

/** Clamp a viewport-space (fixed) card near a rect, flipping above if needed. */
function positionFixed(hostEl: HTMLDivElement, rect: DOMRect): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = rect.bottom + MARGIN;
  if (top + EST_HEIGHT > vh && rect.top - MARGIN - EST_HEIGHT > 0) {
    top = Math.max(MARGIN, rect.top - MARGIN - EST_HEIGHT);
  }
  top = Math.min(top, Math.max(MARGIN, vh - EST_HEIGHT - MARGIN));

  let left = rect.left;
  if (left + CARD_MAX_W + MARGIN > vw) {
    left = Math.max(MARGIN, vw - CARD_MAX_W - MARGIN);
  }
  left = Math.max(MARGIN, left);

  applyBox(hostEl, 'fixed', top, left);
}

/**
 * Once the card has rendered, use its real height: flip it above the
 * selection when it would run off the bottom, else clamp it into view. React
 * commits asynchronously and fonts can change the size, so refit whenever the
 * card resizes during its first second.
 */
function refitFixed(hostEl: HTMLDivElement, rect: DOMRect): void {
  const fit = (): void => {
    // Once the user drags the card, its position is theirs.
    if (!hostEl.isConnected || hostEl.dataset.tzxDragged === '1') return;
    const h = hostEl.getBoundingClientRect().height;
    if (!h) return;
    const vh = window.innerHeight;
    let top = rect.bottom + MARGIN;
    if (top + h > vh - MARGIN) {
      const above = rect.top - MARGIN - h;
      top = above >= MARGIN ? above : Math.max(MARGIN, vh - h - MARGIN);
    }
    hostEl.style.setProperty('top', `${top}px`, 'important');
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(fit);
    ro.observe(hostEl);
    window.setTimeout(() => ro.disconnect(), 1000);
  } else {
    window.setTimeout(fit, 50);
  }
}

/** Place a pinned card at a document-space point (scrolls with the page). */
function positionAbsolute(hostEl: HTMLDivElement, pageX: number, pageY: number): void {
  // Clamp horizontally within the document width so it never overflows off-screen.
  const docW = document.documentElement.scrollWidth;
  const left = Math.max(MARGIN, Math.min(pageX, docW - CARD_MAX_W - MARGIN));
  applyBox(hostEl, 'absolute', pageY, left);
}

function applyBox(
  hostEl: HTMLDivElement,
  pos: 'fixed' | 'absolute',
  top: number,
  left: number,
): void {
  hostEl.style.setProperty('position', pos, 'important');
  hostEl.style.setProperty('top', `${top}px`, 'important');
  hostEl.style.setProperty('left', `${left}px`, 'important');
  hostEl.style.setProperty('margin', '0', 'important');
  hostEl.style.setProperty('padding', '0', 'important');
  hostEl.style.setProperty('z-index', '2147483647', 'important');
}

/**
 * Make a host draggable from a pointerdown on the card header. `fixedPos`
 * controls whether offsets are viewport (transient) or document (pinned) space.
 */
function startDrag(
  hostEl: HTMLDivElement,
  startEvent: PointerEvent | React.PointerEvent,
  fixedPos: boolean,
): void {
  const native = 'nativeEvent' in startEvent ? startEvent.nativeEvent : startEvent;
  hostEl.dataset.tzxDragged = '1';
  const rect = hostEl.getBoundingClientRect();
  const grabX = native.clientX - rect.left;
  const grabY = native.clientY - rect.top;

  function onMove(e: PointerEvent): void {
    const vx = e.clientX - grabX;
    const vy = e.clientY - grabY;
    const left = fixedPos ? vx : vx + window.scrollX;
    const top = fixedPos ? vy : vy + window.scrollY;
    applyBox(hostEl, fixedPos ? 'fixed' : 'absolute', Math.max(0, top), Math.max(0, left));
  }
  function onUp(): void {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
  }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
}

// --- Transient lifecycle --------------------------------------------------

function teardownTransient(): void {
  if (tRoot) {
    tRoot.unmount();
    tRoot = null;
  }
  if (tHost && tHost.parentNode) tHost.parentNode.removeChild(tHost);
  tHost = null;
  document.removeEventListener('scroll', onScroll, true);
}

/**
 * The selection whose card the user closed. Clicking or Shift-clicking inside
 * that same selection, or releasing a key, must not bring the card back; a
 * new or changed selection clears it.
 */
let dismissedKey: string | null = null;
/** Key of the selection the open card was made from. */
let shownKey: string | null = null;

function selectionKey(text: string, rect: DOMRect): string {
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}:${text}`;
}

/** User-facing dismissal: also clears the live (transient) highlight. */
function dismissTransient(): void {
  if (tHost && shownKey) dismissedKey = shownKey;
  clearLiveHighlight();
  teardownTransient();
}

function onScroll(): void {
  // Only the transient card is viewport-anchored; pinned cards scroll naturally.
  dismissTransient();
}

function onDocMouseDown(e: MouseEvent): void {
  // A fresh (non-Shift) click starts a new selection gesture: selecting the
  // same text again on purpose should show the card again.
  if (e.button === 0 && !e.shiftKey) {
    const inCard =
      e.target instanceof Node &&
      ((tHost !== null && tHost.contains(e.target)) || Array.from(pins).some((p) => p.host.contains(e.target as Node)));
    if (!inCard) dismissedKey = null;
  }
  // Clicking outside the transient card dismisses it. Pinned cards are ignored
  // (each manages its own close button).
  if (tHost && e.target instanceof Node && !tHost.contains(e.target)) {
    dismissTransient();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') dismissTransient();
}

function renderTransient(rect: DOMRect, parsed: ParsedTime, matchCount: number, srcText: string): void {
  teardownTransient();
  try {
    tHost = document.createElement('div');
    tHost.id = TRANSIENT_HOST_ID;
    const shadow = tHost.attachShadow({ mode: 'open' });
    applyHostTheme(tHost);
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    document.body.appendChild(tHost);
    positionFixed(tHost, rect);

    // Capture a document-space point for the pin, from the current scroll.
    const pageX = rect.left + window.scrollX;
    const pageY = rect.bottom + MARGIN + window.scrollY;
    const hostEl = tHost;

    tRoot = createRoot(mount);
    tRoot.render(
      createElement(Popover, {
        parsed,
        matchCount,
        prefs,
        pinned: false,
        onPin: () => pinCard(parsed, matchCount, pageX, pageY, srcText, false),
        onPinCompact: () => pinCard(parsed, matchCount, pageX, pageY, srcText, true),
        onClose: dismissTransient,
        onDragStart: (e) => startDrag(hostEl, e, true),
        onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
          // Persist as the global default, then re-parse this value with it.
          prefs = { ...prefs, dateOnlyPolicy: policy };
          void savePreferences(prefs);
          const again = parseWithPrefs(srcText, policy);
          if (again[0]) renderTransient(rect, again[0], again.length, srcText);
        },
      }),
    );
    refitFixed(hostEl, rect);
    document.addEventListener('scroll', onScroll, true);
  } catch {
    teardownTransient();
  }
}

// --- Pin lifecycle --------------------------------------------------------

function pinCard(
  parsed: ParsedTime,
  matchCount: number,
  pageX: number,
  pageY: number,
  srcText: string,
  compact: boolean,
): void {
  try {
    // Allocate this pin's own highlight slot and promote the live highlight to
    // it, so the selected text stays marked in the pin's own color.
    const slot = nextSlot();
    const range = liveRange ? liveRange.cloneRange() : null;
    setPinHighlight(slot, range);
    const color = pinColor(slot);

    const host = document.createElement('div');
    host.className = PIN_HOST_CLASS;
    const shadow = host.attachShadow({ mode: 'open' });
    applyHostTheme(host);
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    document.body.appendChild(host);
    // If this pin would land on top of an existing one (values close together
    // on the page), cascade it down-right so every pinned card stays visible.
    let px = pageX;
    let py = pageY;
    let guard = 0;
    const tooClose = (): boolean => {
      for (const p of pins) {
        if (Math.abs(p.pageX - px) < 48 && Math.abs(p.pageY - py) < 48) return true;
      }
      return false;
    };
    while (tooClose() && guard++ < 12) {
      px += 36;
      py += 36;
    }
    positionAbsolute(host, px, py);

    const root = createRoot(mount);
    const pin: Pin = { host, root, pageX: px, pageY: py, slot, range };
    pins.add(pin);

    let isCompact = compact;
    const renderPin = (p: ParsedTime, count: number): void => {
      root.render(
        createElement(Popover, {
          parsed: p,
          matchCount: count,
          prefs,
          pinned: true,
          compact: isCompact,
          pinNumber: slot + 1,
          pinDot: color.dot,
          onClose: () => removePin(pin),
          onToggleCompact: () => {
            isCompact = !isCompact;
            renderPin(p, count);
          },
          onDragStart: (e) => startDrag(host, e, false),
          onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
            prefs = { ...prefs, dateOnlyPolicy: policy };
            void savePreferences(prefs);
            const again = parseWithPrefs(srcText, policy);
            if (again[0]) renderPin(again[0], again.length);
          },
        }),
      );
    };
    renderPin(parsed, matchCount);

    // The value is pinned in its own slot; drop the transient card and its live
    // amber highlight (the pin's colored highlight has taken over).
    clearLiveHighlight();
    teardownTransient();
  } catch {
    /* restricted page — ignore */
  }
}

function removePin(pin: Pin): void {
  try {
    pin.root.unmount();
  } catch {
    /* already gone */
  }
  if (pin.host.parentNode) pin.host.parentNode.removeChild(pin.host);
  pins.delete(pin);
  // Free this pin's highlight slot and clear its colored mark.
  clearPinHighlight(pin.slot);
  usedSlots.delete(pin.slot);
}

// --- Selection handling ---------------------------------------------------

/**
 * Show the converter for a selection. From the right-click menu the user asked
 * explicitly, so an unparseable selection gets a "no time recognized" card
 * instead of silence.
 */
function showForSelection(
  rect: DOMRect,
  text: string,
  range: Range | null,
  fromMenu = false,
  truncated = false,
): void {
  const matches = parseWithPrefs(text);
  const parsed = matches[0];
  if (!parsed) {
    if (fromMenu) renderNoMatch(rect, text, truncated || text.length > SCAN_LIMIT);
    else teardownTransient();
    return;
  }
  if (range) setLiveHighlight(range, parsed.matchedText);
  renderTransient(rect, parsed, matches.length, text);
}

function renderNoMatch(rect: DOMRect, text: string, truncated: boolean): void {
  clearLiveHighlight();
  teardownTransient();
  try {
    tHost = document.createElement('div');
    tHost.id = TRANSIENT_HOST_ID;
    const shadow = tHost.attachShadow({ mode: 'open' });
    applyHostTheme(tHost);
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    document.body.appendChild(tHost);
    positionFixed(tHost, rect);
    const hostEl = tHost;
    tRoot = createRoot(mount);
    tRoot.render(
      createElement(NoMatchCard, {
        text,
        truncated,
        onClose: dismissTransient,
        onDragStart: (e) => startDrag(hostEl, e, true),
        onOpenSettings: () => {
          const msg: OpenOptionsMessage = { type: 'tzx/open-options', section: 'formats' };
          try {
            void chrome.runtime.sendMessage(msg).catch(() => undefined);
          } catch {
            /* extension context gone (updated); nothing to open */
          }
          dismissTransient();
        },
      }),
    );
    refitFixed(hostEl, rect);
    document.addEventListener('scroll', onScroll, true);
  } catch {
    teardownTransient();
  }
}

/** Read the active selection from the page OR from an input/textarea. */
function readSelection(): { text: string; rect: DOMRect; range: Range | null } | null {
  const active = document.activeElement;

  // <input> / <textarea>: use selectionStart/End and a mirror rect.
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    let start = 0;
    let end = 0;
    try {
      // Throws on input types without a text selection (email, number...).
      start = active.selectionStart ?? 0;
      end = active.selectionEnd ?? 0;
    } catch {
      return null;
    }
    if (end > start) {
      const text = active.value.slice(start, end).trim();
      if (text.length > 0) {
        // Form fields have no Range for the CSS highlight; anchor to the box.
        const rect = active.getBoundingClientRect();
        return { text, rect, range: null };
      }
    }
    return null;
  }

  // Normal DOM / contenteditable selection.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length === 0) return null;

  // Ignore selections inside the transient card or any pinned card.
  if (sel.anchorNode) {
    if (tHost && tHost.contains(sel.anchorNode)) return null;
    for (const pin of pins) {
      if (pin.host.contains(sel.anchorNode)) return null;
    }
  }

  let rect: DOMRect;
  let range: Range | null = null;
  try {
    range = sel.getRangeAt(0);
    rect = range.getBoundingClientRect();
  } catch {
    return null;
  }
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, rect, range };
}

function handleSelectionChange(): void {
  window.clearTimeout(debounceTimer);
  // Off (or not yet known): selecting text does nothing; the menu still works.
  if (!prefsLoaded || !prefs.selectToConvert) return;
  debounceTimer = window.setTimeout(() => {
    if (!prefs.selectToConvert) return;
    const got = readSelection();
    if (!got) {
      dismissedKey = null;
      return;
    }
    const key = selectionKey(got.text, got.rect);
    if (key === dismissedKey) return; // the user closed this one
    // Same selection, card already open: nothing to do.
    if (tHost && key === shownKey) return;
    dismissedKey = null;
    shownKey = key;
    showForSelection(got.rect, got.text, got.range);
  }, DEBOUNCE_MS);
}

/** Anchor for a menu card when the live selection is gone (e.g. inside a frame). */
function fallbackRect(): DOMRect {
  if (lastContextPoint) return new DOMRect(lastContextPoint.x, lastContextPoint.y, 0, 0);
  const x = Math.max(MARGIN, window.innerWidth / 2 - CARD_MAX_W / 2);
  return new DOMRect(x, 64, 0, 0);
}

/** Right-click menu: convert the current selection, whatever the toggle says. */
function convertFromMenu(menuText: string, truncated: boolean): void {
  window.clearTimeout(debounceTimer);
  // An explicit request always shows a card, even for a dismissed selection.
  dismissedKey = null;
  const got = readSelection();
  if (got) {
    shownKey = selectionKey(got.text, got.rect);
    showForSelection(got.rect, got.text, got.range, true);
    return;
  }
  const text = menuText.trim();
  if (text.length === 0) return;
  shownKey = null;
  showForSelection(fallbackRect(), text, null, true, truncated);
}

function onMouseUp(e: MouseEvent): void {
  // Right/middle clicks open menus; the menu item handles conversion then.
  if (e.button !== 0) return;
  handleSelectionChange();
}

/** Keys that extend a selection when held with Shift. */
const SELECT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** Set while the user is extending a selection from the keyboard. */
let keyboardSelecting = false;

function onKeyDownSelect(e: KeyboardEvent): void {
  if (e.shiftKey && SELECT_KEYS.has(e.key)) {
    keyboardSelecting = true;
    return;
  }
  // Moving the caret without Shift collapses the selection: the next one is a
  // fresh gesture, even if it selects the same text again.
  if (!e.shiftKey && SELECT_KEYS.has(e.key)) dismissedKey = null;
  // Select all (Cmd/Ctrl+A). Use the physical key so non-Latin layouts work,
  // and keydown because macOS does not send keyup for keys held with Cmd. The
  // selection changes after this event, so read it on the next tick.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyA') {
    dismissedKey = null; // an explicit select-all is a fresh gesture
    window.setTimeout(handleSelectionChange, 0);
    return;
  }
  if (e.key !== 'Shift') keyboardSelecting = false;
}

function onKeyUp(e: KeyboardEvent): void {
  // Shift+Arrow/Home/End, then Shift released (that keyup has shiftKey=false).
  // A plain Shift press (Shift+Tab, Shift+click) is not a selection, and
  // Escape closes cards rather than opening them.
  if ((e.key === 'Shift' && keyboardSelecting) || (e.shiftKey && SELECT_KEYS.has(e.key))) {
    if (e.key === 'Shift') keyboardSelecting = false;
    handleSelectionChange();
  }
}

function onContextMenu(e: MouseEvent): void {
  lastContextPoint = { x: e.clientX, y: e.clientY };
}

function onRuntimeMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: Ack) => void,
): boolean | undefined {
  if (!fromThisExtension(sender) || !isConvertSelectionMessage(msg)) return undefined;
  // A freshly injected copy may still be loading preferences; converting now
  // would use the default zones and ignore the user's formats.
  void prefsReady
    .then(() => {
      convertFromMenu(msg.text, msg.truncated === true);
      sendResponse({ ok: true });
    })
    .catch(() => sendResponse({ ok: false }));
  return true; // respond asynchronously
}

// --- Install (once per page, survives re-injection) ------------------------

interface ContentInstance {
  /** False once this copy's extension context is gone (extension updated). */
  alive(): boolean;
  dispose(): void;
}

const INSTANCE_KEY = '__tzExtensionContent__';

function extensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function install(): ContentInstance {
  prefsReady = loadPreferences().then((p) => {
    prefs = p;
    prefsLoaded = true;
  });
  const unsubscribe = onPreferencesChanged((p) => {
    prefs = p;
    prefsLoaded = true;
    if (!p.selectToConvert) window.clearTimeout(debounceTimer);
  });

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('keydown', onKeyDownSelect, true);
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    /* no runtime messaging (tests / restricted context) */
  }

  return {
    alive: extensionAlive,
    dispose: () => {
      try {
        unsubscribe();
      } catch {
        /* context already invalidated */
      }
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('keydown', onKeyDownSelect, true);
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch {
        /* context already invalidated */
      }
      window.clearTimeout(debounceTimer);
      dismissTransient();
    },
  };
}

// The background may inject this script on demand (right-click in a tab that
// predates install/update). Keep one live copy: skip if a live one exists,
// and retire a copy left behind by a previous version of the extension.
{
  const slot = window as unknown as Record<string, ContentInstance | undefined>;
  const existing = slot[INSTANCE_KEY];
  if (!existing || !existing.alive()) {
    try {
      existing?.dispose();
    } catch {
      /* stale copy already broken */
    }
    slot[INSTANCE_KEY] = install();
  }
}
