import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
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
 * date-only time or the day/month order), and return the match the card
 * shows (the `index`-th, or the last one when there are fewer now).
 */
function reparse(
  srcText: string,
  index = 0,
): { parsed: ParsedTime; count: number; matches: ParsedTime[]; index: number } | null {
  const again = parseWithPrefs(srcText);
  if (again.length === 0) return null;
  const i = Math.min(Math.max(0, index), again.length - 1);
  return { parsed: again[i] as ParsedTime, count: again.length, matches: again, index: i };
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
  /** Which match of its selection it shows (0 for the first). */
  index: number;
  compact: boolean;
  /** Pinned to the page (scrolls with it) or floating on screen. */
  placement: 'pinned' | 'floating';
  /**
   * The width the card had at full size (e.g. "245px"), so expanding it from
   * compact gives back that size. Null until known.
   */
  fullWidth: string | null;
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

/**
 * Where each match of `parseTimes` sits in `text`, as [start, end), or null
 * when it cannot be found. The parser lists the most specific match first
 * and the rest in text order, and matches never overlap: so the first one
 * is its text's first occurrence, and each of the rest is the next
 * occurrence after the one before it that does not overlap the first.
 */
export function matchSpans(text: string, matches: readonly ParsedTime[]): Array<[number, number] | null> {
  const out: Array<[number, number] | null> = [];
  const lead = matches[0]?.matchedText ?? '';
  const leadAt = lead ? text.indexOf(lead) : -1;
  const leadSpan: [number, number] | null = leadAt >= 0 ? [leadAt, leadAt + lead.length] : null;
  out.push(leadSpan);
  let pos = 0;
  for (let i = 1; i < matches.length; i++) {
    const token = (matches[i] as ParsedTime).matchedText;
    let at = token ? text.indexOf(token, pos) : -1;
    while (at >= 0 && leadSpan && at < leadSpan[1] && at + token.length > leadSpan[0]) {
      at = text.indexOf(token, leadSpan[1]);
    }
    if (at < 0) {
      out.push(null);
      continue;
    }
    out.push([at, at + token.length]);
    pos = at + token.length;
  }
  return out;
}

/**
 * The range of the `index`-th match inside a selection range: the
 * selection's text nodes are read in order and the match located with
 * matchSpans, so the second "10:00" of a selection marks the second one.
 * Null when the text cannot be lined up with the matches (the page's text
 * differs from the selection's, e.g. collapsed whitespace).
 */
export function matchRange(range: Range, matches: readonly ParsedTime[], index: number): Range | null {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root || index < 0 || index >= matches.length) return null;
  const parts: { node: Text; from: number; at: number }[] = [];
  let text = '';
  const add = (node: Text): void => {
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from) return;
    parts.push({ node, from, at: text.length });
    text += node.data.slice(from, to);
  };
  if (root.nodeType === Node.TEXT_NODE) add(root as Text);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) add(n as Text);
  }
  const span = matchSpans(text, matches)[index];
  if (!span) return null;
  const [start, end] = span;
  /** Text node and offset for a position in `text` (an end position stays in the node it ends). */
  const locate = (p: number, isEnd: boolean): { node: Text; offset: number } | null => {
    for (let k = parts.length - 1; k >= 0; k--) {
      const part = parts[k] as { node: Text; from: number; at: number };
      if (isEnd ? p > part.at : p >= part.at) return { node: part.node, offset: part.from + p - part.at };
    }
    return null;
  };
  const a = locate(start, false);
  const b = locate(end, true);
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  } catch {
    return null;
  }
}

/** The live (transient) popover's highlight on its selected token. */
let liveRange: Range | null = null;

/**
 * Remember the shown match's range (pins mark it in their color) and, when
 * "highlight the matched text" is on, mark it now. The page's own selection
 * is never touched, so the user can still copy exactly what they selected,
 * short or long.
 */
function setLiveHighlight(range: Range, matches: readonly ParsedTime[], index: number): void {
  try {
    const token = matches[index]?.matchedText ?? '';
    liveRange = (matchRange(range, matches, index) ?? narrowRangeToToken(range, token)).cloneRange();
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
  /**
   * Height of its header row (grip, number and buttons), from the card's top
   * edge. FLOAT_HEADER when not given.
   */
  readonly header?: number;
}
/** A viewport rectangle (the dock's). */
export interface ViewRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}
/** Step between cards the page still gathers near the top right. */
export const FLOAT_STEP = 32;
/**
 * Height of a card's header row (grip, number and every header button) when
 * it cannot be measured. No card painted above a card may cover any of it.
 */
export const FLOAT_HEADER = 40;
/** Gap between the steps of a staircase of cards. */
const STAIR_GAP = 2;
/** Spacing of the grid of spots the layout tries, in px. */
const FIT_GRID = 16;

interface FitView {
  readonly width: number;
  readonly height: number;
}

type Spot = { top: number; left: number };

/** Height of a card's header row (never more than the card). */
function headOf(b: CardBox): number {
  return Math.max(0, Math.min(b.height, b.header ?? FLOAT_HEADER));
}
function boxRect(top: number, left: number, width: number, height: number): ViewRect {
  return { top, left, right: left + width, bottom: top + height };
}
function overlaps(a: ViewRect, b: ViewRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * How strictly a card keeps out of the dock: wholly, or (when there is no
 * room for that) only with its header, so the dock covers part of its body.
 */
type DockRule = 'card' | 'header';

/**
 * The spot for `card` nearest to where it wants to be, among the wanted spot,
 * a FIT_GRID grid and the edges of the other cards, such that: it is on
 * screen; it covers no header of a card in `below` (painted under it); no
 * card in `above` (painted over it) covers its own header; and it keeps out
 * of the dock per `rule`. Null when there is no such spot.
 */
function nearestSpot(
  card: CardBox,
  below: readonly CardBox[],
  above: readonly CardBox[],
  view: FitView,
  dock: ViewRect | null,
  rule: DockRule,
): Spot | null {
  const w = card.width;
  const h = card.height;
  const head = headOf(card);
  const maxL = Math.max(MARGIN, view.width - w - MARGIN);
  const maxT = Math.max(MARGIN, view.height - h - MARGIN);
  const clampL = (x: number): number => Math.min(Math.max(MARGIN, x), maxL);
  const clampT = (y: number): number => Math.min(Math.max(MARGIN, y), maxT);
  const heads = below.map((b) => boxRect(b.top, b.left, b.width, headOf(b)));
  const tops = above.map((a) => boxRect(a.top, a.left, a.width, a.height));
  const ok = (top: number, left: number): boolean => {
    const me = boxRect(top, left, w, h);
    const myHead = boxRect(top, left, w, head);
    if (dock && overlaps(rule === 'card' ? me : myHead, dock)) return false;
    for (const b of heads) if (overlaps(me, b)) return false;
    for (const a of tops) if (overlaps(myHead, a)) return false;
    return true;
  };

  const start = { top: clampT(card.top), left: clampL(card.left) };
  if (ok(start.top, start.left)) return start;

  const ys = new Set<number>([start.top, MARGIN, maxT]);
  const xs = new Set<number>([start.left, MARGIN, maxL]);
  for (let y = MARGIN; y <= maxT; y += FIT_GRID) ys.add(y);
  for (let x = MARGIN; x <= maxL; x += FIT_GRID) xs.add(x);
  for (const b of below) {
    ys.add(b.top + headOf(b) + STAIR_GAP); // just under its header
    ys.add(b.top - h - STAIR_GAP); // just above it
    xs.add(b.left);
    xs.add(b.left + b.width + MARGIN); // beside it, either side
    xs.add(b.left - w - MARGIN);
  }
  for (const a of above) {
    ys.add(a.top + a.height + STAIR_GAP);
    xs.add(a.left + a.width + MARGIN);
    xs.add(a.left - w - MARGIN);
  }
  if (dock) {
    ys.add(dock.top - MARGIN - (rule === 'card' ? h : head));
    xs.add(dock.left - MARGIN - w);
  }
  const ysOk = [...ys].filter((y) => y >= MARGIN && y <= maxT);
  const xsOk = [...xs].filter((x) => x >= MARGIN && x <= maxL);
  let best: Spot | null = null;
  let bestD = Infinity;
  for (const top of ysOk) {
    const dy = top - start.top;
    for (const left of xsOk) {
      const dx = left - start.left;
      const d = dx * dx + dy * dy;
      if (d < bestD && ok(top, left)) {
        best = { top, left };
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * When the screen has no room for every card with its header clear of the
 * others: a staircase in columns, each card one header height below the one
 * before, so bodies overlap but headers do not. Columns sit side by side
 * without overlapping; when there are not enough of them, the steps shrink
 * evenly (the only case where headers can overlap). Headers stay clear of
 * the dock; bodies may run under it.
 */
function staircase(cards: readonly CardBox[], view: FitView, dock: ViewRect | null): Spot[] {
  const n = cards.length;
  if (n === 0) return [];
  const wMax = Math.max(...cards.map((c) => c.width));
  const hMax = Math.max(...cards.map((c) => c.height));
  const headMax = Math.max(...cards.map(headOf));
  let lastTop = view.height - MARGIN - hMax;
  if (dock) lastTop = Math.min(lastTop, dock.top - MARGIN - headMax);
  const span = Math.max(0, lastTop - MARGIN);
  const step = headMax + STAIR_GAP;
  const cap = Math.floor(span / step) + 1;
  const cols = Math.max(1, Math.floor((view.width - MARGIN) / (wMax + MARGIN)));
  const roomy = n <= cols * cap;
  const perCol = roomy ? cap : Math.ceil(n / cols);
  const used = roomy ? step : perCol > 1 ? span / (perCol - 1) : 0;
  return cards.map((_, k) => ({
    top: Math.round(MARGIN + (k % perCol) * used),
    left: MARGIN + Math.floor(k / perCol) * (wMax + MARGIN),
  }));
}

/**
 * Where a floating card of `card`'s size goes, as close to `card.top/left`
 * as possible. Cards in `below` are painted under it: it must not cover
 * their header row. Cards in `above` are painted over it: they must not
 * cover its header row. It stays on screen and clear of the dock (only its
 * header, when nothing else fits). As a last resort it goes one header
 * height below the last card below.
 */
export function fitFloating(
  card: CardBox,
  below: readonly CardBox[],
  above: readonly CardBox[],
  view: FitView,
  dock: ViewRect | null,
): Spot {
  const at =
    nearestSpot(card, below, above, view, dock, 'card') ?? nearestSpot(card, below, above, view, dock, 'header');
  if (at) return at;
  const maxL = Math.max(MARGIN, view.width - card.width - MARGIN);
  const maxT = Math.max(MARGIN, view.height - card.height - MARGIN);
  const last = below[below.length - 1];
  if (!last) return { top: Math.min(Math.max(MARGIN, card.top), maxT), left: Math.min(Math.max(MARGIN, card.left), maxL) };
  return {
    top: Math.min(last.top + headOf(last) + STAIR_GAP, maxT),
    left: Math.min(Math.max(MARGIN, last.left), maxL),
  };
}

/**
 * Lay out floating cards given in painting order (later ones on top) so that
 * no card covers the header row of a card under it, every card is wholly on
 * screen, and each stays as close as it can to where it wants to be. When
 * that leaves no room for some card, the cards form a staircase instead.
 */
export function layoutFloating(cards: readonly CardBox[], view: FitView, dock: ViewRect | null): Spot[] {
  // First every card clear of the dock; then, if that runs out of room,
  // cards that do not fit otherwise may put their body under it.
  for (const relaxed of [false, true]) {
    const placed: CardBox[] = [];
    for (const card of cards) {
      const at =
        nearestSpot(card, placed, [], view, dock, 'card') ??
        (relaxed ? nearestSpot(card, placed, [], view, dock, 'header') : null);
      if (!at) break;
      placed.push({ ...card, ...at });
    }
    if (placed.length === cards.length) return placed.map(({ top, left }) => ({ top, left }));
  }
  return staircase(cards, view, dock);
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
  returnFocus = null;
  document.removeEventListener('scroll', onScroll, true);
}

/**
 * The page element that had focus before the transient card took it, to
 * give focus back to when the user closes the card from the keyboard.
 */
let returnFocus: HTMLElement | null = null;

/** The page element (not ours, not body) that has focus now. */
function pageFocus(): HTMLElement | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body || a === document.documentElement) return null;
  return inOurUi(a) ? null : a;
}

/** Focus entering the transient card from the page: remember where from. */
function onTransientFocusIn(e: FocusEvent): void {
  const from = e.relatedTarget;
  if (from instanceof HTMLElement && from !== document.body && !inOurUi(from)) returnFocus = from;
}

/** A new transient host: note the page focus now, and follow focus moving into it. */
function watchFocus(host: HTMLElement): void {
  returnFocus = pageFocus();
  host.addEventListener('focusin', onTransientFocusIn);
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

/**
 * User-facing dismissal: also clears the live (transient) highlight. With
 * `giveFocusBack` (Escape or the close button) and focus inside the card,
 * focus returns to the page element that had it before the card took it,
 * when that element is still there and can take focus; else it stays on
 * the body, and the page does not scroll either way.
 */
function dismissTransient(giveFocusBack = false): void {
  const host = tHost;
  const active = document.activeElement;
  const focusInCard = !!host && !!active && (active === host || host.contains(active));
  const back = returnFocus;
  if (tHost && shownKey) dismissedKey = shownKey;
  clearLiveHighlight();
  teardownTransient();
  if (!giveFocusBack || !focusInCard || !back || !back.isConnected) return;
  try {
    back.focus({ preventScroll: true });
  } catch {
    /* not focusable: focus stays on the body */
  }
}

function onScroll(): void {
  // Only the transient card is viewport-anchored; pinned cards scroll naturally.
  dismissTransient();
}

/**
 * True while a mouse press that started in one of our cards (or the dock) is
 * down: its mouseup is a click on our UI, not the end of a page selection.
 */
let pressInOurUi = false;

function onDocMouseDown(e: MouseEvent): void {
  pressInOurUi = fromOurUi(e);
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
  if (isFocusShortcut(e)) {
    if (toggleCardFocus()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (e.key !== 'Escape') return;
  if (fromOurUi(e)) {
    if (dockHost && e.target instanceof Node && dockHost.contains(e.target)) return;
    const origin = e.composedPath()[0];
    if (isTextField(origin) && !isIdleZoneSearch(origin)) return;
  }
  dismissTransient(true);
}

/**
 * Alt+Shift+T (Option+Shift+T): the physical T key, so other layouts and
 * macOS, where Option changes `key`, work too.
 */
function isFocusShortcut(e: KeyboardEvent): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT' && !e.repeat;
}

/**
 * While the transient card is open, move focus into it, or, when focus is
 * already in it, back to the page element that had it. False when there is
 * no card (the keys are then left to the page).
 */
function toggleCardFocus(): boolean {
  const host = tHost;
  if (!host || !host.isConnected) return false;
  const active = document.activeElement;
  if (active === host || (active instanceof Node && host.contains(active))) {
    const back = returnFocus;
    if (back && back.isConnected) {
      try {
        back.focus({ preventScroll: true });
      } catch {
        /* not focusable */
      }
    } else if (active instanceof HTMLElement) {
      active.blur();
    }
    return true;
  }
  const from = pageFocus();
  const cardEl = host.shadowRoot?.querySelector<HTMLElement>('.tzx-card');
  if (!cardEl) return false;
  if (from) returnFocus = from;
  cardEl.focus({ preventScroll: true });
  return true;
}

/**
 * Escape from inside the dock (or a text field of ours) that nothing there
 * handled closes the card.
 */
function onKeyDownBubble(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !fromOurUi(e)) return;
  dismissTransient(true);
}

/** The transient card's content, kept so it can re-render in place. */
interface TransientState {
  readonly rect: DOMRect;
  readonly srcText: string;
  readonly pageX: number;
  readonly pageY: number;
  /** The page selection the card was made from (null for form fields and menu text). */
  readonly selRange: Range | null;
  /** Every match in the selection, in text order; the card shows `index`. */
  matches: ParsedTime[];
  index: number;
  parsed: ParsedTime;
  count: number;
  compact: boolean;
}
let tState: TransientState | null = null;

/** Mark the shown match of the transient card on the page (when its text can be found). */
function markShownMatch(st: TransientState): void {
  if (!st.selRange) return;
  clearLiveHighlight();
  setLiveHighlight(st.selRange, st.matches, st.index);
}

/** Take a fresh parse of the transient card's text and show its `index`-th match. */
function takeReparse(st: TransientState, again: NonNullable<ReturnType<typeof reparse>>): void {
  st.matches = again.matches;
  st.index = again.index;
  st.parsed = again.parsed;
  st.count = again.count;
  markShownMatch(st);
  paintTransient();
}

function paintTransient(): void {
  const st = tState;
  const hostEl = tHost;
  if (!st || !tRoot || !hostEl) return;
  tRoot.render(
    createElement(Popover, {
      parsed: st.parsed,
      matchCount: st.count,
      matchIndex: st.index,
      prefs,
      pinned: false,
      compact: st.compact,
      onPin: () => {
        // The selection stays on the page after pinning; its mouseup (or a
        // later key release) must not open this card again over the pin.
        if (shownKey) dismissedKey = shownKey;
        createPin({
          parsed: st.parsed,
          count: st.count,
          index: st.index,
          srcText: st.srcText,
          pageX: st.pageX,
          pageY: st.pageY,
          compact: st.compact,
          range: liveRange ? liveRange.cloneRange() : null,
        });
      },
      onStep: (delta: number) => {
        // Wraps around, so the buttons never go disabled under the focus.
        const n = st.matches.length;
        if (n < 2) return;
        st.index = (((st.index + delta) % n) + n) % n;
        st.parsed = st.matches[st.index] as ParsedTime;
        markShownMatch(st);
        paintTransient();
      },
      onToggleCompact: () => {
        st.compact = !st.compact;
        rememberSize(st.compact);
        paintTransient();
      },
      onClose: () => dismissTransient(true),
      onDragStart: (e) => startDrag(hostEl, e, true),
      onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
        // Persist as the global default, then re-read this value with it.
        patchPrefs({ dateOnlyPolicy: policy });
        const again = reparse(st.srcText, st.index);
        if (again) takeReparse(st, again);
      },
      onDateOrder: (order: NumericDateOrder) => {
        patchPrefs({ numericDateOrder: order });
        const again = reparse(st.srcText, st.index);
        if (again) takeReparse(st, again);
      },
    }),
  );
}

function renderTransient(
  rect: DOMRect,
  matches: ParsedTime[],
  srcText: string,
  selRange: Range | null,
): void {
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
    watchFocus(tHost);

    // Capture a document-space point for the pin, from the current scroll.
    tState = {
      rect,
      srcText,
      pageX: rect.left + window.scrollX,
      pageY: rect.bottom + MARGIN + window.scrollY,
      selRange: selRange ? selRange.cloneRange() : null,
      matches,
      index: 0,
      parsed: matches[0] as ParsedTime,
      count: matches.length,
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
  /** Which match of the selection it shows (default 0). */
  readonly index?: number;
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
  /** Width it had at full size (see setCompact), to restore. */
  readonly fullWidth?: string | null;
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
 * Step a page point down-right until none of `others` sits within 48 px of
 * it, so a new or re-pinned card never lands on top of another one. Compares
 * against where those cards are now, not where they were first placed.
 */
function cascadeFrom(pageX: number, pageY: number, others: Iterable<Pin>): { x: number; y: number } {
  let px = pageX;
  let py = pageY;
  const tooClose = (): boolean => {
    const left = clampPageLeft(px);
    for (const p of others) {
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
 * pinned and floating (the "floating" tag must not make it wider). At full
 * size, that is also the width it gets back after being compact.
 */
function lockWidth(pin: Pin): void {
  const w = pin.host.getBoundingClientRect().width;
  if (w <= 0) return;
  const px = `${Math.ceil(w)}px`;
  pin.host.style.setProperty('width', px, 'important');
  if (!pin.compact) pin.fullWidth = px;
}

/**
 * Switch a card between compact and full. Compact sizes to its content;
 * full gets back the width it had at full size (so "Expand" restores the
 * card as it was), or sizes to its content when that is not known.
 */
function setCompact(pin: Pin, compact: boolean): void {
  if (pin.compact === compact) return;
  if (compact) {
    const locked = pin.host.style.getPropertyValue('width');
    const w = pin.host.getBoundingClientRect().width;
    const full = locked || (w > 0 ? `${Math.ceil(w)}px` : '');
    if (full) pin.fullWidth = full;
    pin.host.style.removeProperty('width');
  } else if (pin.fullWidth) {
    pin.host.style.setProperty('width', pin.fullWidth, 'important');
  } else {
    pin.host.style.removeProperty('width');
  }
  pin.compact = compact;
  pin.render();
}

/** Render a card now, so it can be measured in its new state right away. */
function renderNow(pin: Pin): void {
  flushSync(() => pin.render());
}

/** Height of a card's header row, from the card's top edge (FLOAT_HEADER when it cannot be measured). */
function headerHeight(host: HTMLElement): number {
  const head = host.shadowRoot?.querySelector('.tzx-head')?.getBoundingClientRect();
  const r = host.getBoundingClientRect();
  if (!head || !head.height) return FLOAT_HEADER;
  return Math.ceil(head.bottom - r.top);
}

/** A card's viewport box as laid out: the position we set, the measured size. */
function floatBox(host: HTMLElement): CardBox {
  const b = host.getBoundingClientRect();
  return {
    top: styleNum(host, 'top', b.top),
    left: styleNum(host, 'left', b.left),
    width: b.width || CARD_MAX_W,
    height: b.height || EST_HEIGHT,
    header: headerHeight(host),
  };
}

/**
 * Turn a card into a floating one where it is on screen now, at its current
 * width, and render it at once: the "floating" look can change its height,
 * and the layout needs the height it has once it floats.
 */
function floatInPlace(pin: Pin): { top: number; left: number } {
  const r = pin.host.getBoundingClientRect();
  lockWidth(pin);
  applyBox(pin.host, 'fixed', r.top, r.left);
  pin.placement = 'floating';
  renderNow(pin);
  return { top: r.top, left: r.left };
}

/**
 * Pin ↔ float. Floating keeps the card where it is on screen (brought into
 * view, clear of the other floating cards' headers). Pinning puts it back
 * next to its source text when that text is still on the page (stepping off
 * the cards in `others`, by default every other card), else where it is now,
 * in page coordinates.
 */
function setPlacement(pin: Pin, placement: 'pinned' | 'floating', others?: Iterable<Pin>): void {
  if (pin.placement === placement) return;
  if (placement === 'floating') {
    const wanted = floatInPlace(pin);
    // Painted in page order: earlier cards are under this one, later ones over it.
    const list = Array.from(pins);
    const i = list.indexOf(pin);
    const floating = (p: Pin): boolean => p !== pin && p.placement === 'floating';
    const at = fitFloating(
      { ...floatBox(pin.host), ...wanted },
      list.slice(0, i).filter(floating).map((p) => floatBox(p.host)),
      list.slice(i + 1).filter(floating).map((p) => floatBox(p.host)),
      { width: window.innerWidth, height: window.innerHeight },
      dockRect(),
    );
    applyBox(pin.host, 'fixed', at.top, at.left);
    return;
  }
  lockWidth(pin);
  const anchor = sourceAnchor(pin.range);
  if (anchor) {
    const at = cascadeFrom(anchor.x, anchor.y, others ?? Array.from(pins).filter((p) => p !== pin));
    positionAbsolute(pin.host, at.x, at.y);
  } else {
    const r = pin.host.getBoundingClientRect();
    applyBox(pin.host, 'absolute', r.top + window.scrollY, r.left + window.scrollX);
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
    if (!spec.box) ({ x: px, y: py } = cascadeFrom(px, py, pins));
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
      index: spec.index ?? 0,
      compact: spec.compact,
      placement,
      fullWidth: spec.fullWidth ?? null,
      render: () => {
        root.render(
          createElement(Popover, {
            parsed: pin.parsed,
            matchCount: pin.count,
            matchIndex: pin.index,
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
              setCompact(pin, !pin.compact);
              rememberSize(pin.compact);
              refreshDock();
            },
            onTogglePlacement: () => {
              setPlacement(pin, pin.placement === 'pinned' ? 'floating' : 'pinned');
              refreshDock();
            },
            onDragStart: (e) => startDrag(host, e, pin.placement === 'floating'),
            onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
              patchPrefs({ dateOnlyPolicy: policy });
              const again = reparse(pin.srcText, pin.index);
              if (!again) return;
              pin.parsed = again.parsed;
              pin.count = again.count;
              pin.index = again.index;
              pin.render();
            },
            onDateOrder: (order: NumericDateOrder) => {
              patchPrefs({ numericDateOrder: order });
              const again = reparse(pin.srcText, pin.index);
              if (!again) return;
              pin.parsed = again.parsed;
              pin.count = again.count;
              pin.index = again.index;
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
    index: pin.index,
    srcText: pin.srcText,
    pageX: pin.pageX,
    pageY: pin.pageY,
    compact: pin.compact,
    range: pin.range,
    placement: pin.placement,
    slot: pin.slot,
    box: Number.isFinite(top) && Number.isFinite(left) ? { top, left } : measured,
    width: pin.host.style.getPropertyValue('width') || undefined,
    fullWidth: pin.fullWidth,
  };
}

function setAllCompact(compact: boolean): void {
  for (const pin of pins) setCompact(pin, compact);
  rememberSize(compact);
  refreshDock();
}

function togglePlacementAll(): void {
  const list = Array.from(pins);
  const allFloating = list.every((p) => p.placement === 'floating');
  if (allFloating) {
    // Each card goes back next to its own source, stepping off only the
    // cards already put back in this pass (at their new spots), not off
    // where the others still float.
    const placed: Pin[] = [];
    for (const pin of list) {
      setPlacement(pin, 'pinned', placed);
      placed.push(pin);
    }
    refreshDock();
    return;
  }
  // Every card floats. Cards on screen want to stay where they are; the ones
  // scrolled away gather near the top right.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let gathered = 0;
  const wanted = list.map((pin) => {
    const r = pin.host.getBoundingClientRect();
    const width = r.width || CARD_MAX_W;
    const offscreen = r.bottom < 0 || r.top > vh;
    if (pin.placement === 'pinned' && offscreen) {
      const at = { top: 64 + gathered * FLOAT_STEP, left: vw - width - 24 - gathered * FLOAT_STEP };
      gathered += 1;
      return at;
    }
    return { top: r.top, left: r.left };
  });
  // Float them first, so the layout uses the size each has once floating.
  for (const pin of list) {
    if (pin.placement !== 'floating') floatInPlace(pin);
    else lockWidth(pin);
  }
  // Lay them all out in page order (later ones painted on top), so no card
  // covers another's header row.
  const boxes: CardBox[] = list.map((pin, i) => ({ ...floatBox(pin.host), ...wanted[i] }));
  const at = layoutFloating(boxes, { width: vw, height: vh }, dockRect());
  list.forEach((pin, i) => {
    const box = at[i];
    if (box) applyBox(pin.host, 'fixed', box.top, box.left);
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
  if (matches.length === 0) {
    if (fromMenu) renderNoMatch(rect, text, truncated || text.length > SCAN_LIMIT);
    else teardownTransient();
    return;
  }
  if (range) setLiveHighlight(range, matches, 0);
  renderTransient(rect, matches, text, range);
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
    watchFocus(tHost);
    const hostEl = tHost;
    tRoot = createRoot(mount);
    tRoot.render(
      createElement(NoMatchCard, {
        text,
        truncated,
        onClose: () => dismissTransient(true),
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
  // A click on a card or the dock (Pin, Compact, a zone's ×...) is not a new
  // page selection: reading the kept selection after it would bring the
  // transient card back over the new pin. What counts is where the press
  // started: a drag-selection of page text that ends over a card is still a
  // page selection.
  const ours = pressInOurUi;
  pressInOurUi = false;
  if (ours) return;
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
  // Keys pressed in a card or the dock (Shift+Tab through its buttons, a
  // selection in its zone search) never select page text.
  if (fromOurUi(e)) {
    keyboardSelecting = false;
    return;
  }
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
