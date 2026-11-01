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
import {
  DEFAULT_PREFERENCES,
  type DateOnlyPolicy,
  type NumericDateOrder,
  type ParsedTime,
  type Preferences,
} from '../types';
import { NoMatchCard, Popover } from './Popover';
import { PinDock } from './PinDock';

const TRANSIENT_HOST_ID = 'tz-extension-popover-host';
const PIN_HOST_CLASS = 'tz-extension-pin-host';
const DOCK_HOST_ID = 'tz-extension-pin-dock';
const DEBOUNCE_MS = 200;
const CARD_MAX_W = 360;
const MARGIN = 8;
const EST_HEIGHT = 200;
/** Cards sit one level below the dock, so the dock is never covered. */
const CARD_Z = '2147483646';
const DOCK_Z = '2147483647';

let prefs: Preferences = DEFAULT_PREFERENCES;
/** Until stored prefs arrive we do not know whether select-to-convert is on. */
let prefsLoaded = false;
/** Resolves once stored prefs are in `prefs` (menu clicks wait for it). */
let prefsReady: Promise<void> = Promise.resolve();
let debounceTimer: number | undefined;
/** Where the last right-click happened (viewport coords), to anchor menu cards. */
let lastContextPoint: { x: number; y: number } | null = null;

/** Parse with every current preference that affects matching. */
function parseWithPrefs(text: string): ParsedTime[] {
  return parseTimes(text, {
    assumedZone: prefs.homeZone,
    dateOnlyPolicy: prefs.dateOnlyPolicy,
    customFormats: prefs.customFormats,
    disabledFormats: prefs.disabledFormats,
    numericDateOrder: prefs.numericDateOrder,
  });
}

/** Card writes run one after another, so two quick changes cannot overwrite each other. */
let prefsWrite: Promise<void> = Promise.resolve();

/**
 * Save a preference change made from a card. The in-memory copy updates now;
 * the write merges the patch into the preferences read from storage right
 * before it, so a change made meanwhile elsewhere (Settings, another tab) is
 * not overwritten with this tab's possibly stale copy.
 */
function patchPrefs(patch: Partial<Preferences>): Promise<void> {
  prefs = { ...prefs, ...patch };
  prefsWrite = prefsWrite
    .then(async () => {
      const stored = await loadPreferences();
      // loadPreferences answers the shared defaults object when storage
      // cannot be read; merging into that would reset every other setting.
      const base = stored === DEFAULT_PREFERENCES ? prefs : stored;
      await savePreferences({ ...base, ...patch });
    })
    .catch(() => undefined);
  return prefsWrite;
}

/** Size a new card opens at, per the "card size on open" setting. */
function opensCompact(): boolean {
  const size = prefs.cardSize === 'last' ? prefs.lastCardSize : prefs.cardSize;
  return size === 'compact';
}

/** Quiet time before a size toggle is saved (a burst of toggles writes once). */
export const REMEMBER_SIZE_MS = 500;
let sizeTimer: number | undefined;

/**
 * Remember the size the user just switched a card to, for "Last used". Only
 * that setting reads it, so nothing is written otherwise; toggles are
 * debounced so sync storage sees one write per burst.
 */
function rememberSize(compact: boolean): void {
  if (prefs.cardSize !== 'last') return;
  const size = compact ? 'compact' : 'full';
  window.clearTimeout(sizeTimer);
  sizeTimer = window.setTimeout(() => {
    sizeTimer = undefined;
    if (prefs.cardSize === 'last' && prefs.lastCardSize !== size) void patchPrefs({ lastCardSize: size });
  }, REMEMBER_SIZE_MS);
}

/**
 * Re-read a card's text after the user changed how it should be read (the
 * date-only time or the day/month order), and return the new best match.
 */
function reparse(srcText: string): { parsed: ParsedTime; count: number } | null {
  const again = parseWithPrefs(srcText);
  return again[0] ? { parsed: again[0], count: again.length } : null;
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
  /** Document-space anchor (page coords, not viewport) where it was first placed. */
  readonly pageX: number;
  readonly pageY: number;
  /** Highlight slot index (color + number) this pin owns. */
  readonly slot: number;
  /** The highlighted range for this pin, so it can be restored/cleared. */
  readonly range: Range | null;
  readonly srcText: string;
  parsed: ParsedTime;
  count: number;
  compact: boolean;
  /** Pinned to the page (scrolls with it) or floating on screen. */
  placement: 'pinned' | 'floating';
  render(): void;
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

/**
 * Remember the matched text's range (pins mark it in their color) and, when
 * "highlight the matched text" is on, mark it now. The page's own selection
 * is never touched, so the user can still copy exactly what they selected,
 * short or long.
 */
function setLiveHighlight(range: Range, token: string): void {
  try {
    liveRange = narrowRangeToToken(range, token).cloneRange();
  } catch {
    liveRange = null;
    return;
  }
  if (!prefs.keepSelection) return;
  const reg = highlightRegistry();
  const Ctor = HighlightCtor();
  if (!reg || !Ctor) return;
  try {
    ensureHighlightStyle();
    reg.set(LIVE_HL, new Ctor(liveRange));
  } catch {
    /* highlights unavailable */
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

/**
 * Mark a pin's text in its slot color. Like the live mark, only when "also
 * mark the matched text" is on; the pin keeps its range either way, so the
 * mark can come back when the setting is turned on.
 */
function setPinHighlight(slot: number, range: Range | null): void {
  if (!prefs.keepSelection) return;
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

/**
 * Bring every mark in line with the "also mark the matched text" setting:
 * paint the live and pin marks when it is on, remove them when it is off.
 * Runs when the setting changes, so open cards follow it right away.
 */
function syncHighlights(): void {
  const reg = highlightRegistry();
  if (!prefs.keepSelection) {
    try {
      reg?.delete(LIVE_HL);
    } catch {
      /* ignore */
    }
    for (const pin of pins) clearPinHighlight(pin.slot);
    return;
  }
  const Ctor = HighlightCtor();
  if (reg && Ctor && liveRange && tHost) {
    try {
      ensureHighlightStyle();
      reg.set(LIVE_HL, new Ctor(liveRange));
    } catch {
      /* highlights unavailable */
    }
  }
  for (const pin of pins) setPinHighlight(pin.slot, pin.range);
}

// --- Positioning ----------------------------------------------------------

/**
 * The box of a whole selection: the union of its line boxes, so a card
 * anchored below it clears every selected line (a selection that wraps onto
 * a second line ends at that line's bottom, not the first one's).
 */
export function selectionRect(range: Range): DOMRect {
  const box = range.getBoundingClientRect();
  const lines = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  const parts = [box, ...lines].filter((r) => r.width > 0 || r.height > 0);
  if (parts.length === 0) return box;
  const left = Math.min(...parts.map((r) => r.left));
  const top = Math.min(...parts.map((r) => r.top));
  const right = Math.max(...parts.map((r) => r.right));
  const bottom = Math.max(...parts.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** A floating card's viewport box. */
export interface CardBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}
/** A viewport rectangle (the dock's). */
export interface ViewRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}
/** Step between cascaded floating cards, both ways. */
export const FLOAT_STEP = 32;
/**
 * The top-left square of a card (its grip and number) that no card painted
 * above it may cover, so every card's header can still be grabbed.
 */
export const FLOAT_CORNER = 24;

interface FitView {
  readonly width: number;
  readonly height: number;
}

/**
 * Where a floating card of `card`'s size goes, as close to `card.top/left`
 * as possible. Cards in `below` are painted under it: it must not cover
 * their top-left corner. Cards in `above` are painted over it: they must not
 * cover its corner. It stays on screen and clear of the dock. Tries, in
 * order: the wanted spot; a cascade from it (down-right, down-left, up-right,
 * FLOAT_STEP a step); columns from the top left; and as a last resort a
 * FLOAT_CORNER step down-right of the last card below (wrapping on screen).
 */
export function fitFloating(
  card: CardBox,
  below: readonly CardBox[],
  above: readonly CardBox[],
  view: FitView,
  dock: ViewRect | null,
): { top: number; left: number } {
  const w = card.width;
  const h = card.height;
  const maxL = Math.max(MARGIN, view.width - w - MARGIN);
  const maxT = Math.max(MARGIN, view.height - h - MARGIN);
  const clampL = (x: number): number => Math.min(Math.max(MARGIN, x), maxL);
  const clampT = (y: number): number => Math.min(Math.max(MARGIN, y), maxT);
  const hits = (a: ViewRect, b: ViewRect): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const rect = (top: number, left: number, width: number, height: number): ViewRect => ({
    top,
    left,
    right: left + width,
    bottom: top + height,
  });
  const corner = (b: { top: number; left: number }): ViewRect => rect(b.top, b.left, FLOAT_CORNER, FLOAT_CORNER);
  const ok = (top: number, left: number): boolean => {
    const me = rect(top, left, w, h);
    if (dock && hits(me, dock)) return false;
    for (const b of below) if (hits(me, corner(b))) return false;
    const mine = corner({ top, left });
    for (const a of above) if (hits(mine, rect(a.top, a.left, a.width, a.height))) return false;
    return true;
  };
  const fits = (top: number, left: number): boolean => top >= MARGIN && top <= maxT && left >= MARGIN && left <= maxL;

  const start = { top: clampT(card.top), left: clampL(card.left) };
  // Out of the dock's way, straight up, when it would sit on it.
  if (dock && hits(rect(start.top, start.left, w, h), dock) && dock.top - MARGIN - h >= MARGIN) {
    start.top = dock.top - MARGIN - h;
  }
  if (ok(start.top, start.left)) return start;

  for (const [dx, dy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
  ] as const) {
    for (let k = 1; ; k++) {
      const top = start.top + dy * k * FLOAT_STEP;
      const left = start.left + dx * k * FLOAT_STEP;
      if (!fits(top, left)) break;
      if (ok(top, left)) return { top, left };
    }
  }
  for (let left = MARGIN; left <= maxL; left += FLOAT_STEP) {
    for (let top = MARGIN; top <= maxT; top += FLOAT_STEP) {
      if (ok(top, left)) return { top, left };
    }
  }
  // No spot leaves every corner free (very many cards on a small screen):
  // step off the last card below, so at least that one is not hidden.
  const last = below[below.length - 1];
  if (!last) return start;
  let top = last.top + FLOAT_CORNER;
  let left = last.left + FLOAT_CORNER;
  if (top > maxT) top = MARGIN;
  if (left > maxL) left = MARGIN;
  return { top, left };
}

/**
 * Lay out floating cards given in painting order (later ones on top), each
 * as close as it can stay to where it wants to be, so that none hides
 * another's header. See fitFloating.
 */
export function layoutFloating(
  cards: readonly CardBox[],
  view: FitView,
  dock: ViewRect | null,
): Array<{ top: number; left: number }> {
  const placed: CardBox[] = [];
  return cards.map((card) => {
    const at = fitFloating(card, placed, [], view, dock);
    placed.push({ ...at, width: card.width, height: card.height });
    return at;
  });
}

/** The dock's viewport rect, when it is on the page. */
function dockRect(): ViewRect | null {
  if (!dockHost || !dockHost.isConnected) return null;
  const d = dockHost.getBoundingClientRect();
  return d.width && d.height ? d : null;
}

/**
 * Move a fixed (viewport) box of size w×h up out of the dock's way, when it
 * would overlap the dock and there is room above it.
 */
function avoidDock(box: { top: number; left: number }, w: number, h: number): { top: number; left: number } {
  if (!dockHost || !dockHost.isConnected) return box;
  const d = dockHost.getBoundingClientRect();
  if (!d.width || !d.height) return box;
  const overlaps = box.left < d.right && box.left + w > d.left && box.top < d.bottom && box.top + h > d.top;
  if (!overlaps) return box;
  const above = d.top - MARGIN - h;
  return above >= MARGIN ? { top: above, left: box.left } : box;
}

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
    const r = hostEl.getBoundingClientRect();
    top = avoidDock({ top, left: r.left }, r.width, h).top;
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
  applyBox(hostEl, 'absolute', pageY, clampPageLeft(pageX));
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
  hostEl.style.setProperty('z-index', CARD_Z, 'important');
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
  // Only drag from the header itself, not its buttons.
  const t = ('nativeEvent' in startEvent ? startEvent.nativeEvent : startEvent).composedPath?.()[0];
  if (t instanceof Element && t.closest('button, input, select')) return;
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
  tState = null;
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
    if (!(e.target instanceof Node && inOurUi(e.target))) dismissedKey = null;
  }
  // Clicking outside the transient card dismisses it. Pinned cards are ignored
  // (each manages its own close button).
  if (tHost && e.target instanceof Node && !tHost.contains(e.target)) {
    dismissTransient();
  }
}

/** True when a key event started inside one of our cards or the dock. */
function fromOurUi(e: Event): boolean {
  return e.target instanceof Node && inOurUi(e.target);
}

/** True for an element the user types into (text inputs, textareas, contenteditable). */
function isTextField(el: EventTarget | undefined): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * A card's zone search with nothing to clear or close: empty, list shut. The
 * picker leaves that Escape alone, so it should close the card.
 */
function isIdleZoneSearch(el: EventTarget | undefined): boolean {
  return (
    el instanceof HTMLInputElement &&
    el.getAttribute('role') === 'combobox' &&
    el.value === '' &&
    el.getAttribute('aria-expanded') !== 'true'
  );
}

/**
 * Escape closes the transient card. This runs in the capture phase, before
 * any page handler: the card takes focus when it opens, so the usual Escape
 * starts inside our shadow root and then bubbles through the page's `body`,
 * where a page listener could stop it. Left alone here (for the bubble phase
 * below): an Escape in a text field of ours that has something to clear (the
 * zone search clears or closes its list first), and one inside the dock,
 * which uses it to fold its labels.
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (fromOurUi(e)) {
    if (dockHost && e.target instanceof Node && dockHost.contains(e.target)) return;
    const origin = e.composedPath()[0];
    if (isTextField(origin) && !isIdleZoneSearch(origin)) return;
  }
  dismissTransient();
}

/**
 * Escape from inside the dock (or a text field of ours) that nothing there
 * handled closes the card.
 */
function onKeyDownBubble(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !fromOurUi(e)) return;
  dismissTransient();
}

/** The transient card's content, kept so it can re-render in place. */
interface TransientState {
  readonly rect: DOMRect;
  readonly srcText: string;
  readonly pageX: number;
  readonly pageY: number;
  parsed: ParsedTime;
  count: number;
  compact: boolean;
}
let tState: TransientState | null = null;

function paintTransient(): void {
  const st = tState;
  const hostEl = tHost;
  if (!st || !tRoot || !hostEl) return;
  tRoot.render(
    createElement(Popover, {
      parsed: st.parsed,
      matchCount: st.count,
      prefs,
      pinned: false,
      compact: st.compact,
      onPin: () =>
        createPin({
          parsed: st.parsed,
          count: st.count,
          srcText: st.srcText,
          pageX: st.pageX,
          pageY: st.pageY,
          compact: st.compact,
          range: liveRange ? liveRange.cloneRange() : null,
        }),
      onToggleCompact: () => {
        st.compact = !st.compact;
        rememberSize(st.compact);
        paintTransient();
      },
      onClose: dismissTransient,
      onDragStart: (e) => startDrag(hostEl, e, true),
      onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
        // Persist as the global default, then re-read this value with it.
        patchPrefs({ dateOnlyPolicy: policy });
        const again = reparse(st.srcText);
        if (!again) return;
        st.parsed = again.parsed;
        st.count = again.count;
        paintTransient();
      },
      onDateOrder: (order: NumericDateOrder) => {
        patchPrefs({ numericDateOrder: order });
        const again = reparse(st.srcText);
        if (!again) return;
        st.parsed = again.parsed;
        st.count = again.count;
        paintTransient();
      },
    }),
  );
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
    tState = {
      rect,
      srcText,
      pageX: rect.left + window.scrollX,
      pageY: rect.bottom + MARGIN + window.scrollY,
      parsed,
      count: matchCount,
      compact: opensCompact(),
    };
    tRoot = createRoot(mount);
    paintTransient();
    refitFixed(tHost, rect);
    document.addEventListener('scroll', onScroll, true);
  } catch {
    teardownTransient();
  }
}

// --- Pin lifecycle --------------------------------------------------------

/** Everything needed to (re)create a pinned card, e.g. for "Close all" → Undo. */
interface PinSpec {
  readonly parsed: ParsedTime;
  readonly count: number;
  readonly srcText: string;
  readonly pageX: number;
  readonly pageY: number;
  readonly compact: boolean;
  readonly range: Range | null;
  readonly placement?: 'pinned' | 'floating';
  /** Exact host position to restore (viewport for floating, page for pinned). */
  readonly box?: { readonly top: number; readonly left: number };
  /** Width the card was fixed at (see lockWidth), to restore. */
  readonly width?: string;
  /** Highlight slot (number and color) to take back, when it is free. */
  readonly slot?: number;
}

/** Left edge a pinned card gets for a page x (kept inside the document width). */
function clampPageLeft(pageX: number): number {
  const docW = document.documentElement.scrollWidth;
  return Math.max(MARGIN, Math.min(pageX, docW - CARD_MAX_W - MARGIN));
}

/** Where a card is now, in page coordinates (after any drag, float or clamp). */
function currentPagePos(pin: Pin): { x: number; y: number } {
  const left = parseFloat(pin.host.style.getPropertyValue('left')) || 0;
  const top = parseFloat(pin.host.style.getPropertyValue('top')) || 0;
  return pin.placement === 'floating' ? { x: left + window.scrollX, y: top + window.scrollY } : { x: left, y: top };
}

/**
 * Step a page point down-right until no other card sits within 48 px of it,
 * so a new or re-pinned card never lands on top of another one. Compares
 * against where the other cards are now, not where they were first placed.
 */
function cascadeFrom(pageX: number, pageY: number, skip?: Pin): { x: number; y: number } {
  let px = pageX;
  let py = pageY;
  const tooClose = (): boolean => {
    const left = clampPageLeft(px);
    for (const p of pins) {
      if (p === skip) continue;
      const at = currentPagePos(p);
      if (Math.abs(at.x - left) < 48 && Math.abs(at.y - py) < 48) return true;
    }
    return false;
  };
  for (let guard = 0; tooClose() && guard < 12; guard++) {
    px += 36;
    py += 36;
  }
  return { x: px, y: py };
}

/**
 * Page point just below a pin's source text, if the text is still on the
 * page. Null when the page removed or emptied it.
 */
function sourceAnchor(range: Range | null): { x: number; y: number } | null {
  if (!range || range.collapsed || !range.startContainer.isConnected) return null;
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const r = selectionRect(range);
  if (!r.width && !r.height) return null;
  return { x: r.left + window.scrollX, y: r.bottom + MARGIN + window.scrollY };
}

/** A px value we set on a host's style, or `fallback` when it is not set. */
function styleNum(el: HTMLElement, prop: 'top' | 'left', fallback: number): number {
  const v = parseFloat(el.style.getPropertyValue(prop));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Fix a card's width at what it is now, so it keeps it when it moves between
 * pinned and floating (the "floating" tag must not make it wider).
 */
function lockWidth(host: HTMLElement): void {
  const w = host.getBoundingClientRect().width;
  if (w > 0) host.style.setProperty('width', `${Math.ceil(w)}px`, 'important');
}

/** Let a card size to its content again (it changed size: compact ↔ full). */
function unlockWidth(host: HTMLElement): void {
  host.style.removeProperty('width');
}

/** Viewport box of a card, clamped so the whole card is on screen. */
function clampToViewport(host: HTMLElement): { top: number; left: number } {
  const r = host.getBoundingClientRect();
  const w = r.width || CARD_MAX_W;
  const h = r.height || EST_HEIGHT;
  const top = Math.min(Math.max(MARGIN, r.top), Math.max(MARGIN, window.innerHeight - h - MARGIN));
  const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - w - MARGIN));
  return avoidDock({ top, left }, w, h);
}

/**
 * Pin ↔ float. Floating keeps the card where it is on screen (brought into
 * view). Pinning puts it back next to its source text when that text is
 * still on the page, else where it is now, in page coordinates.
 */
function setPlacement(pin: Pin, placement: 'pinned' | 'floating'): void {
  if (pin.placement === placement) return;
  lockWidth(pin.host);
  if (placement === 'floating') {
    const { top, left } = clampToViewport(pin.host);
    const r = pin.host.getBoundingClientRect();
    const size = { width: r.width || CARD_MAX_W, height: r.height || EST_HEIGHT };
    // Keep clear of the other floating cards' headers (painted in page order).
    const list = Array.from(pins);
    const i = list.indexOf(pin);
    const boxOf = (p: Pin): CardBox => {
      const b = p.host.getBoundingClientRect();
      return {
        top: styleNum(p.host, 'top', b.top),
        left: styleNum(p.host, 'left', b.left),
        width: b.width || CARD_MAX_W,
        height: b.height || EST_HEIGHT,
      };
    };
    const floating = (p: Pin): boolean => p !== pin && p.placement === 'floating';
    const at = fitFloating(
      { top, left, ...size },
      list.slice(0, i).filter(floating).map(boxOf),
      list.slice(i + 1).filter(floating).map(boxOf),
      { width: window.innerWidth, height: window.innerHeight },
      dockRect(),
    );
    applyBox(pin.host, 'fixed', at.top, at.left);
  } else {
    const anchor = sourceAnchor(pin.range);
    if (anchor) {
      const at = cascadeFrom(anchor.x, anchor.y, pin);
      positionAbsolute(pin.host, at.x, at.y);
    } else {
      const r = pin.host.getBoundingClientRect();
      applyBox(pin.host, 'absolute', r.top + window.scrollY, r.left + window.scrollX);
    }
  }
  pin.placement = placement;
  pin.render();
}

/**
 * Create a pinned card. `restore` is set by Undo: the card comes back with its
 * own slot, and the transient card the user may have opened since stays.
 */
function createPin(spec: PinSpec, restore = false): Pin | null {
  try {
    // Allocate this pin's own highlight slot and mark its text in that color,
    // so the selected text stays tied to the card.
    let slot: number;
    if (spec.slot !== undefined && !usedSlots.has(spec.slot)) {
      slot = spec.slot;
      usedSlots.add(slot);
    } else {
      slot = nextSlot();
    }
    const range = spec.range;
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
    let px = spec.pageX;
    let py = spec.pageY;
    if (!spec.box) ({ x: px, y: py } = cascadeFrom(px, py));
    const placement = spec.placement ?? 'pinned';
    if (spec.box) applyBox(host, placement === 'floating' ? 'fixed' : 'absolute', spec.box.top, spec.box.left);
    else positionAbsolute(host, px, py);
    if (spec.width) host.style.setProperty('width', spec.width, 'important');

    const root = createRoot(mount);
    const pin: Pin = {
      host,
      root,
      pageX: px,
      pageY: py,
      slot,
      range,
      srcText: spec.srcText,
      parsed: spec.parsed,
      count: spec.count,
      compact: spec.compact,
      placement,
      render: () => {
        root.render(
          createElement(Popover, {
            parsed: pin.parsed,
            matchCount: pin.count,
            prefs,
            pinned: true,
            placement: pin.placement,
            compact: pin.compact,
            pinNumber: slot + 1,
            pinDot: color.dot,
            onClose: () => {
              removePin(pin);
              refreshDock();
            },
            onToggleCompact: () => {
              pin.compact = !pin.compact;
              rememberSize(pin.compact);
              unlockWidth(host);
              pin.render();
              refreshDock();
            },
            onTogglePlacement: () => {
              setPlacement(pin, pin.placement === 'pinned' ? 'floating' : 'pinned');
              refreshDock();
            },
            onDragStart: (e) => startDrag(host, e, pin.placement === 'floating'),
            onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
              patchPrefs({ dateOnlyPolicy: policy });
              const again = reparse(pin.srcText);
              if (!again) return;
              pin.parsed = again.parsed;
              pin.count = again.count;
              pin.render();
            },
            onDateOrder: (order: NumericDateOrder) => {
              patchPrefs({ numericDateOrder: order });
              const again = reparse(pin.srcText);
              if (!again) return;
              pin.parsed = again.parsed;
              pin.count = again.count;
              pin.render();
            },
          }),
        );
      },
    };
    pins.add(pin);
    pin.render();

    if (!restore) {
      // The value is pinned in its own slot; drop the transient card and its
      // live amber highlight (the pin's colored highlight has taken over).
      clearLiveHighlight();
      teardownTransient();
      closedPins = null;
    }
    refreshDock();
    return pin;
  } catch {
    /* restricted page — ignore */
    return null;
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

// --- Pin dock: bulk actions for every pinned card --------------------------

let dockHost: HTMLDivElement | null = null;
let dockRoot: Root | null = null;
/** Cards closed by "Close all", kept until the undo offer ends. */
let closedPins: PinSpec[] | null = null;

function specOf(pin: Pin): PinSpec {
  // The box we set (viewport for floating, page for pinned); the measured
  // rect only when a style is missing.
  const top = parseFloat(pin.host.style.getPropertyValue('top'));
  const left = parseFloat(pin.host.style.getPropertyValue('left'));
  const r = pin.host.getBoundingClientRect();
  const measured =
    pin.placement === 'floating'
      ? { top: r.top, left: r.left }
      : { top: r.top + window.scrollY, left: r.left + window.scrollX };
  return {
    parsed: pin.parsed,
    count: pin.count,
    srcText: pin.srcText,
    pageX: pin.pageX,
    pageY: pin.pageY,
    compact: pin.compact,
    range: pin.range,
    placement: pin.placement,
    slot: pin.slot,
    box: Number.isFinite(top) && Number.isFinite(left) ? { top, left } : measured,
    width: pin.host.style.getPropertyValue('width') || undefined,
  };
}

function setAllCompact(compact: boolean): void {
  for (const pin of pins) {
    if (pin.compact === compact) continue;
    pin.compact = compact;
    unlockWidth(pin.host);
    pin.render();
  }
  rememberSize(compact);
  refreshDock();
}

function togglePlacementAll(): void {
  const list = Array.from(pins);
  const allFloating = list.every((p) => p.placement === 'floating');
  if (allFloating) {
    for (const pin of list) setPlacement(pin, 'pinned');
    refreshDock();
    return;
  }
  // Every card floats. Cards on screen want to stay where they are; the ones
  // scrolled away gather near the top right. Then lay them all out (in page
  // order, later ones painted on top) so no card hides another's header.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let gathered = 0;
  const wanted: CardBox[] = list.map((pin) => {
    const r = pin.host.getBoundingClientRect();
    const width = r.width || CARD_MAX_W;
    const height = r.height || EST_HEIGHT;
    const offscreen = r.bottom < 0 || r.top > vh;
    if (pin.placement === 'pinned' && offscreen) {
      const top = 64 + gathered * FLOAT_STEP;
      const left = vw - width - 24 - gathered * FLOAT_STEP;
      gathered += 1;
      return { top, left, width, height };
    }
    return { top: r.top, left: r.left, width, height };
  });
  const at = layoutFloating(wanted, { width: vw, height: vh }, dockRect());
  list.forEach((pin, i) => {
    const box = at[i];
    if (!box) return;
    lockWidth(pin.host);
    applyBox(pin.host, 'fixed', box.top, box.left);
    if (pin.placement !== 'floating') {
      pin.placement = 'floating';
      pin.render();
    }
  });
  refreshDock();
}

function closeAllPins(): void {
  const list = Array.from(pins);
  if (list.length === 0) return;
  closedPins = list.map(specOf);
  for (const pin of list) removePin(pin);
  refreshDock();
}

function undoCloseAll(): void {
  const specs = closedPins;
  closedPins = null;
  if (!specs) return;
  // Lowest slots first, so a slot taken meanwhile falls to the next free one
  // without bumping a card that could have kept its own.
  const ordered = [...specs].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  for (const spec of ordered) createPin(spec, true);
  refreshDock();
}

function dismissUndo(): void {
  closedPins = null;
  refreshDock();
}

/** Show, update or remove the dock to match the pinned cards. */
function refreshDock(): void {
  const count = pins.size;
  if (count === 0 && !closedPins) {
    if (dockRoot) {
      try {
        dockRoot.unmount();
      } catch {
        /* gone */
      }
    }
    dockHost?.remove();
    dockHost = null;
    dockRoot = null;
    return;
  }
  try {
    if (!dockHost || !dockHost.isConnected) {
      dockHost = document.createElement('div');
      dockHost.id = DOCK_HOST_ID;
      const shadow = dockHost.attachShadow({ mode: 'open' });
      const mount = document.createElement('div');
      shadow.appendChild(mount);
      document.body.appendChild(dockHost);
      for (const [k, v] of Object.entries({
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        left: 'auto',
        top: 'auto',
        margin: '0',
        padding: '0',
        'z-index': DOCK_Z,
      })) {
        dockHost.style.setProperty(k, v, 'important');
      }
      dockRoot = createRoot(mount);
    }
    applyHostTheme(dockHost);
    const list = Array.from(pins);
    dockRoot?.render(
      createElement(PinDock, {
        count,
        compactCount: list.filter((p) => p.compact).length,
        floatingCount: list.filter((p) => p.placement === 'floating').length,
        closed: closedPins ? closedPins.length : null,
        onMinimizeAll: () => setAllCompact(true),
        onExpandAll: () => setAllCompact(false),
        onTogglePlacementAll: togglePlacementAll,
        onCloseAll: closeAllPins,
        onUndo: undoCloseAll,
        onDismissUndo: dismissUndo,
      }),
    );
  } catch {
    /* restricted page */
  }
}

/** True when the node is inside one of our own cards, pins or the dock. */
function inOurUi(node: Node): boolean {
  if (tHost?.contains(node) || dockHost?.contains(node)) return true;
  for (const p of pins) if (p.host.contains(node)) return true;
  return false;
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
  // Typing in a card's own search box is not a page selection. Focus on a
  // card itself (it takes focus when it opens) still reads the page selection.
  if (active && inOurUi(active)) {
    const inner = active.shadowRoot?.activeElement;
    if (!inner || inner.closest('input, textarea, select, [contenteditable="true"]')) return null;
  }

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

  // Ignore selections inside our own cards and the dock.
  if (sel.anchorNode && inOurUi(sel.anchorNode)) return null;

  let rect: DOMRect;
  let range: Range | null = null;
  try {
    range = sel.getRangeAt(0);
    rect = selectionRect(range);
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
    syncHighlights();
  });
  const unsubscribe = onPreferencesChanged((p) => {
    const marked = prefs.keepSelection;
    prefs = p;
    prefsLoaded = true;
    if (!p.selectToConvert) window.clearTimeout(debounceTimer);
    if (p.keepSelection !== marked) syncHighlights();
  });

  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('keydown', onKeyDownSelect, true);
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keydown', onKeyDownBubble);
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
      document.removeEventListener('keydown', onKeyDownBubble);
      document.removeEventListener('contextmenu', onContextMenu, true);
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch {
        /* context already invalidated */
      }
      window.clearTimeout(debounceTimer);
      // A retired copy must not write a size it remembered for later.
      window.clearTimeout(sizeTimer);
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
