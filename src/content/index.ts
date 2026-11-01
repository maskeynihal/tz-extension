import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { parseTimes, type ParseOptions } from '../lib/parse';
import { readTimes, MAX_READ_CHARS } from '../lib/read-times';
import { loadPreferences, savePreferences, onPreferencesChanged } from '../lib/storage';
import { resolveTheme } from '../lib/theme';
import {
  fromThisExtension,
  isConvertSelectionMessage,
  MAX_MESSAGE_TEXT,
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
import {
  isFocusCardMessage,
  isShortcutReply,
  shortcutLabel,
  type GetShortcutMessage,
  type ShortcutLabel,
} from '../background/commands';

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

/** Every current preference that affects matching, for the parser. */
function parseOptions(): ParseOptions {
  return {
    assumedZone: prefs.homeZone,
    dateOnlyPolicy: prefs.dateOnlyPolicy,
    customFormats: prefs.customFormats,
    disabledFormats: prefs.disabledFormats,
    numericDateOrder: prefs.numericDateOrder,
  };
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

/** The times of a card's text, for the card. */
export interface Reading {
  /** Every time found, in reading order (by `sourceIndex`). */
  readonly matches: ParsedTime[];
  /** Where the card opens in `matches`: the best match, or the visible one nearest the pointer. */
  readonly open: number;
  /** True when the selection has more times than `matches` lists. */
  readonly capped: boolean;
}

function sameMatch(a: ParsedTime, b: ParsedTime): boolean {
  return a.sourceIndex === b.sourceIndex && a.matchedText === b.matchedText;
}

/**
 * Re-read a card's text (the user changed how it should be read, here or in
 * Settings) and pick the match to show: the one shown before when it is
 * still there (same place, same text; else same place), else the best one.
 */
function reparse(
  src: CardText,
  shown: ParsedTime | null,
): { parsed: ParsedTime; count: number; matches: ParsedTime[]; index: number; capped: boolean } | null {
  const again = readCard(src);
  if (again.matches.length === 0) return null;
  let i = -1;
  if (shown && shown.sourceIndex !== undefined) {
    i = again.matches.findIndex((p) => sameMatch(p, shown));
    if (i < 0) i = again.matches.findIndex((p) => p.sourceIndex === shown.sourceIndex);
  }
  if (i < 0) i = again.open;
  return {
    parsed: again.matches[i] as ParsedTime,
    count: again.matches.length,
    matches: again.matches,
    index: i,
    capped: again.capped,
  };
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
  /** Document-space anchor (page coords, not viewport) where it was placed. */
  pageX: number;
  pageY: number;
  /** Highlight slot index (color + number) this pin owns. */
  readonly slot: number;
  /** The page range of the time it shows, so its mark can be restored or cleared (null when not found). */
  range: Range | null;
  /** Its selection: the text and where it is on the page. */
  readonly src: CardText;
  /** Every time in the selection, in reading order; it shows `index`. */
  matches: ParsedTime[];
  parsed: ParsedTime;
  count: number;
  /** True when the selection has more times than `count`. */
  capped: boolean;
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
 * The one place of `token` in a selection range, when the selection's text
 * holds it exactly once and one text node has all of it. Null otherwise: a
 * mark on the wrong copy, or on the whole selection, is worse than none.
 */
function uniqueTokenRange(range: Range, selText: string, token: string): Range | null {
  if (!token) return null;
  const first = selText.indexOf(token);
  if (first < 0 || selText.indexOf(token, first + 1) >= 0) return null;
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!root) return null;
  const nodes: Text[] =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? [range.commonAncestorContainer as Text] : [];
  if (nodes.length === 0) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        range.intersectsNode(n) && (n as Text).data.includes(token) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const hit = walker.nextNode() as Text | null;
    if (hit) nodes.push(hit);
  }
  const hit = nodes[0];
  if (!hit) return null;
  const from = hit === range.startContainer ? range.startOffset : 0;
  const idx = hit.data.indexOf(token, from);
  const to = hit === range.endContainer ? range.endOffset : hit.data.length;
  if (idx < 0 || idx + token.length > to) return null;
  try {
    const r = document.createRange();
    r.setStart(hit, idx);
    r.setEnd(hit, idx + token.length);
    return r;
  } catch {
    return null;
  }
}

/** A character's place in the page: a text node and an offset in it. */
export interface TextPos {
  readonly node: Text;
  readonly offset: number;
}

const WS = /\s/;

/** True for a text node the selection's string leaves out (scripts, styles, display: none). */
function hiddenText(node: Text): boolean {
  const el = node.parentElement;
  if (!el) return false;
  if (el.closest('script, style, noscript, template')) return true;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? !check.call(el) : false;
}

/** Same character, ignoring case (text-transform can change it in the string). */
function sameChar(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * How an element's edge separates the text on either side of it: 'out'
 * for an element out of the line (absolute, fixed or floated), whose text
 * sits elsewhere on the page; 'box' for one laid out as its own box in the
 * line (inline-block, flex or grid item, table cell...); null for plain
 * inline text.
 */
type Edge = 'out' | 'box' | null;

function edgeOf(el: Element, cache: Map<Element, Edge>): Edge {
  const known = cache.get(el);
  if (known !== undefined) return known;
  let edge: Edge = null;
  try {
    const cs = getComputedStyle(el);
    const display = cs.display;
    const inline = display === '' || display === 'inline' || display === 'contents' || display.startsWith('ruby');
    if (cs.position === 'absolute' || cs.position === 'fixed' || (cs.cssFloat !== '' && cs.cssFloat !== 'none')) {
      edge = 'out';
    } else if (!inline) edge = 'box';
  } catch {
    edge = null;
  }
  cache.set(el, edge);
  return edge;
}

/** The strongest element edge (see Edge) between two text nodes. */
function edgeBetween(a: Text, b: Text, cache: Map<Element, Edge>): Edge {
  const upA: Element[] = [];
  for (let el = a.parentElement; el; el = el.parentElement) upA.push(el);
  const onA = new Set<Element>(upA);
  let common: Element | null = null;
  let found: Edge = null;
  const note = (e: Edge): void => {
    if (e === 'out' || (e === 'box' && found === null)) found = e;
  };
  for (let el = b.parentElement; el; el = el.parentElement) {
    if (onA.has(el)) {
      common = el;
      break;
    }
    note(edgeOf(el, cache));
  }
  for (const el of upA) {
    if (el === common) break;
    note(edgeOf(el, cache));
  }
  return found;
}

/** What mapSelection learns about a selection's string. */
export interface SelectionMap {
  /**
   * Where each character of the string is on the page, or null for one the
   * page's text does not have (a line break the browser added between
   * blocks). Characters at or past the walk's limit are not mapped.
   */
  readonly map: Array<TextPos | null>;
  /**
   * Places where the string runs two characters together that the page
   * keeps apart, by the index of the second character, ascending. `apart`
   * is true when the two are not next to each other on the page: the page
   * has whitespace between them that the string dropped (as it does around
   * positioned elements), or an element out of the line starts or ends
   * between them. Else an edge of an inline-block (or other box in the
   * line) lies between them.
   */
  readonly breaks: ReadonlyArray<{ readonly at: number; readonly apart: boolean }>;
}

/**
 * Line the selection's `toString()` up with the page (see SelectionMap),
 * for its first `limit` characters only: past that nothing is read, so a
 * select-all on a huge page costs no more than a selection of `limit`
 * characters.
 *
 * The selection's string collapses whitespace runs and adds breaks; the
 * page's text nodes keep their own whitespace and may hold text the string
 * leaves out. So the two are lined up character by character: whitespace
 * against any whitespace run, other characters by value (ignoring case),
 * skipping over page text the string does not show.
 */
export function mapSelection(range: Range, selText: string, limit = selText.length): SelectionMap {
  const len = Math.max(0, Math.min(selText.length, limit));
  const out: Array<TextPos | null> = new Array<TextPos | null>(len).fill(null);
  const breaks: Array<{ at: number; apart: boolean }> = [];
  const edges = new Map<Element, Edge>();
  // The page's characters, read node by node as the walk needs them: `raw`
  // holds their text, and segment s starts at raw index segAt[s], at offset
  // segFrom[s] of segNode[s].
  let raw = '';
  const segNode: Text[] = [];
  const segAt: number[] = [];
  const segFrom: number[] = [];
  const root = range.commonAncestorContainer;
  const walker =
    root.nodeType === Node.TEXT_NODE
      ? null
      : document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        });
  let single: Text | null = root.nodeType === Node.TEXT_NODE ? (root as Text) : null;
  /** Read the next page node in; false when there is none. */
  const more = (): boolean => {
    for (;;) {
      let node: Text | null;
      if (walker) node = walker.nextNode() as Text | null;
      else {
        node = single;
        single = null;
      }
      if (!node) return false;
      if (hiddenText(node)) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : node.data.length;
      if (to <= from) continue;
      segNode.push(node);
      segAt.push(raw.length);
      segFrom.push(from);
      raw += node.data.slice(from, to);
      return true;
    }
  };
  /** True when raw index `k` is read in (reading more as needed). */
  const has = (k: number): boolean => {
    while (k >= raw.length) if (!more()) return false;
    return true;
  };
  let seg = 0;
  const posAt = (k: number): TextPos => {
    // Segments are found in order mostly; search from the last one either way.
    while (seg + 1 < segAt.length && (segAt[seg + 1] as number) <= k) seg++;
    while (seg > 0 && (segAt[seg] as number) > k) seg--;
    return { node: segNode[seg] as Text, offset: (segFrom[seg] as number) + k - (segAt[seg] as number) };
  };
  /** The next non-whitespace character of the page from `k` on. */
  const solidFrom = (k: number): number => {
    let i = k;
    while (has(i) && WS.test(raw[i] as string)) i++;
    return i;
  };
  /** The next non-whitespace character of the string from `i` on. */
  const nextSolid = (i: number): number => {
    let k = i;
    while (k < selText.length && WS.test(selText[k] as string)) k++;
    return k;
  };
  const LOOKAHEAD = 512;
  /** Raw index of the last string character placed, and its index in the string. */
  let lastK = -1;
  let lastI = -2;
  const place = (i: number, k: number): void => {
    out[i] = posAt(k);
    if (lastI === i - 1 && lastK >= 0 && !WS.test(selText[i] as string) && !WS.test(selText[lastI] as string)) {
      const between = raw.slice(lastK + 1, k);
      const a = out[lastI] as TextPos;
      const b = out[i] as TextPos;
      const edge = a.node === b.node ? null : edgeBetween(a.node, b.node, edges);
      if (WS.test(between) || edge === 'out') breaks.push({ at: i, apart: true });
      else if (edge === 'box') breaks.push({ at: i, apart: false });
    }
    lastK = k;
    lastI = i;
  };
  let j = 0;
  for (let i = 0; i < len && has(j); i++) {
    const c = selText[i] as string;
    if (WS.test(c)) {
      if (WS.test(raw[j] as string)) place(i, j++);
      continue;
    }
    j = solidFrom(j);
    if (!has(j)) break;
    if (sameChar(raw[j] as string, c)) {
      place(i, j++);
      continue;
    }
    // Page text the string leaves out: find this character further on,
    // followed by the string's next character too, so a stray match does
    // not throw the rest off.
    const follow = selText[nextSolid(i + 1)];
    has(j + LOOKAHEAD);
    for (let k = j + 1; k < raw.length && k < j + LOOKAHEAD; k++) {
      if (!sameChar(raw[k] as string, c)) continue;
      const n = solidFrom(k + 1);
      if (follow !== undefined && (!has(n) || !sameChar(raw[n] as string, follow))) continue;
      place(i, k);
      j = k + 1;
      break;
    }
  }
  return { map: out, breaks };
}

/** Where each character of `selText` is on the page (see mapSelection). */
export function mapSelectionText(range: Range, selText: string, limit = selText.length): Array<TextPos | null> {
  return mapSelection(range, selText, limit).map;
}

/** Text without whitespace, in lower case: how the string and the page are compared. */
const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

/**
 * The page range of `selText.slice(start, end)`, through `map` (see
 * mapSelectionText). Null when its ends are not in the page or the range's
 * text is not that text (whitespace and case aside: text-transform changes
 * the case in the string, not in the page).
 */
export function spanRange(
  selText: string,
  map: ReadonlyArray<TextPos | null>,
  start: number,
  end: number,
): Range | null {
  if (start < 0 || end > selText.length || end <= start) return null;
  let a: TextPos | null = null;
  for (let i = start; i < end && !a; i++) a = map[i] ?? null;
  let b: TextPos | null = null;
  for (let i = end - 1; i >= start && !b; i--) b = map[i] ?? null;
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset + 1);
    return squash(r.toString()) === squash(selText.slice(start, end)) ? r : null;
  } catch {
    return null;
  }
}

/** What a card needs to find its matches on the page. */
interface MarkSource {
  /** The page selection the card was made from (null for form fields and menu text). */
  readonly selRange: Range | null;
  /** The selection's `toString()`, untrimmed (null when there is no range). */
  readonly selText: string | null;
  /** Where the parsed (trimmed) text starts in `selText`. */
  readonly selLead: number;
  /** mapSelection of the above, built on first use. */
  selMap?: SelectionMap;
}

/** A card's text and where it came from. */
interface CardText extends MarkSource {
  /** The text given to the parser: the selection's string, trimmed. */
  readonly text: string;
  /** Where the pointer was when the selection was made (viewport), to open on the time nearest it. */
  readonly point?: { readonly x: number; readonly y: number } | null;
}

/** The selection's map, built once (see mapSelection), up to what a card reads. */
function selectionMap(src: MarkSource): SelectionMap | null {
  if (!src.selRange || src.selText === null) return null;
  src.selMap ??= mapSelection(src.selRange, src.selText, src.selLead + MAX_READ_CHARS);
  return src.selMap;
}

/**
 * The page range of one match: its `sourceIndex` in the parsed text, mapped
 * through the selection's string to the page. When that fails, its text's
 * only place in the selection, if it has exactly one; else null (no mark).
 */
function matchRange(src: MarkSource, p: ParsedTime): Range | null {
  const range = src.selRange;
  const sm = selectionMap(src);
  if (!range || !sm || src.selText === null) return null;
  if (p.sourceIndex !== undefined) {
    const start = src.selLead + p.sourceIndex;
    const r = spanRange(src.selText, sm.map, start, start + p.matchedText.length);
    if (r) return r;
  }
  return uniqueTokenRange(range, src.selText, p.matchedText);
}

/** A rect in viewport coordinates. */
type Box = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

/** A range's line boxes, or null when the browser cannot say. */
function rangeBoxes(r: Range): Box[] | null {
  if (typeof r.getClientRects === 'function') return Array.from(r.getClientRects());
  if (typeof r.getBoundingClientRect === 'function') return [r.getBoundingClientRect()];
  return null;
}

/** What visibleBoxes learned about elements, so each is styled once per read. */
interface SeenCache {
  /** Per element: it hides what is in it (clipped to nothing, or opacity 0). */
  readonly hides: Map<Element, boolean>;
  /** Per element: its own text is drawn in a fully transparent colour. */
  readonly clear: Map<Element, boolean>;
  /** Per element: how it and the elements it is in, up to its scroll container, are positioned. */
  readonly placed: Map<Element, Placed>;
  /** The page's direction, read once per read: 'rtl' scrolls to the left. */
  rtl?: boolean;
}

/** How text is positioned: in a `position: fixed` box, an `absolute` one, or neither. */
type Placed = 'fixed' | 'absolute' | null;

function seenCache(): SeenCache {
  return { hides: new Map(), clear: new Map(), placed: new Map() };
}

/** `fixed` over `absolute` over neither. */
function morePlaced(a: Placed, b: Placed): Placed {
  return a === 'fixed' || b === 'fixed' ? 'fixed' : (a ?? b);
}

/** True for an element whose content scrolls or is clipped (a scroll container). */
function scrolls(cs: CSSStyleDeclaration): boolean {
  return /^(auto|scroll|hidden|overlay)$/.test(cs.overflowX || cs.overflow) || /^(auto|scroll|hidden|overlay)$/.test(cs.overflowY || cs.overflow);
}

/**
 * Whether the text directly in `el` is in a box taken out of the flow
 * (`position: absolute` or `fixed`) below its nearest scroll container:
 * `el` itself or an element it is in, up to (not with) the first one whose
 * content scrolls or is clipped. That is how off-page text is built. Text
 * in a scroll container is placed by its scrolling, which can be negative
 * (a `column-reverse` pane scrolled up, an RTL pane scrolled sideways).
 */
function placedText(el: Element | null, cache: SeenCache): Placed {
  if (!el || el === document.body || el === document.documentElement) return null;
  const known = cache.placed.get(el);
  if (known !== undefined) return known;
  let got: Placed = null;
  try {
    const cs = getComputedStyle(el);
    if (!scrolls(cs)) {
      const here: Placed = cs.position === 'fixed' ? 'fixed' : cs.position === 'absolute' ? 'absolute' : null;
      got = morePlaced(here, placedText(el.parentElement, cache));
    }
  } catch {
    got = null;
  }
  cache.placed.set(el, got);
  return got;
}

/** True when the page scrolls to the left (`direction: rtl` on the root). */
function pageRtl(cache: SeenCache): boolean {
  if (cache.rtl === undefined) {
    try {
      cache.rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    } catch {
      cache.rtl = false;
    }
  }
  return cache.rtl;
}

/**
 * A computed colour with nothing to show: `transparent`, or an alpha of 0
 * (`rgba(r, g, b, 0)`, `rgb(r g b / 0)`), never a colour channel of 0.
 * Exported for tests.
 */
export const NO_INK = /^(transparent|rgba?\(\s*[^,/()]+,[^,/()]+,[^,/()]+,\s*0(\.0+)?%?\s*\)|[a-z-]+\([^/()]*\/\s*0(\.0+)?%?\s*\))$/i;

/**
 * True when `el` or an element it is in hides its content: clipped to
 * nothing (the screen-reader-only patterns `clip: rect(0 0 0 0)`,
 * `clip-path: inset(50%)`, a 1×1 box with overflow hidden), or with
 * `opacity: 0`.
 */
function clippedAway(el: Element | null, cache: SeenCache): boolean {
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    let hides = cache.hides.get(e);
    if (hides === undefined) {
      hides = false;
      try {
        const cs = getComputedStyle(e);
        const clip = cs.clip || '';
        const clipPath = cs.getPropertyValue('clip-path') || '';
        const opacity = parseFloat(cs.opacity);
        if (Number.isFinite(opacity) && opacity <= 0) hides = true;
        else if (/^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(clip.trim())) hides = true;
        else if (/^inset\(\s*(50|[5-9]\d|100)(\.\d+)?%/.test(clipPath.trim())) hides = true;
        else if (cs.overflow !== '' && cs.overflow !== 'visible') {
          const b = e.getBoundingClientRect();
          hides = b.width <= 1 && b.height <= 1;
        }
      } catch {
        hides = false;
      }
      cache.hides.set(e, hides);
    }
    if (hides) return true;
  }
  return false;
}

/**
 * True when the text directly in `el` is drawn in a fully transparent
 * colour (`color` or `-webkit-text-fill-color`). Not when a background
 * shows through it (`background-clip: text`, the gradient-text pattern),
 * on it or an element it is in.
 */
function inkless(el: Element | null, cache: SeenCache): boolean {
  if (!el) return false;
  const known = cache.clear.get(el);
  if (known !== undefined) return known;
  let clear = false;
  try {
    const cs = getComputedStyle(el);
    const fill = cs.getPropertyValue('-webkit-text-fill-color').trim();
    const ink = fill && fill !== 'currentcolor' && fill !== 'currentColor' ? fill : cs.color.trim();
    if (NO_INK.test(ink)) {
      clear = true;
      for (let e: Element | null = el; e && clear; e = e.parentElement) {
        const s = e === el ? cs : getComputedStyle(e);
        const bc = `${s.getPropertyValue('background-clip')} ${s.getPropertyValue('-webkit-background-clip')}`;
        if (/\btext\b/.test(bc)) clear = false;
      }
    }
  } catch {
    clear = false;
  }
  cache.clear.set(el, clear);
  return clear;
}

/**
 * Whether a box of positioned text (see placedText) is moved off the page:
 * above its top, or past the side it cannot scroll to (the left on a
 * left-to-right page, the right on a right-to-left one). Measured against
 * the window's scroll only; text in a `fixed` box against the viewport.
 */
function offPage(b: Box, placed: Exclude<Placed, null>, cache: SeenCache): boolean {
  const sx = placed === 'fixed' ? 0 : window.scrollX;
  const sy = placed === 'fixed' ? 0 : window.scrollY;
  if (b.bottom + sy <= 0) return true;
  if (!pageRtl(cache)) return b.right + sx <= 0;
  const edge = placed === 'fixed' ? window.innerWidth : document.documentElement.clientWidth || window.innerWidth;
  return b.left + sx >= edge;
}

/**
 * The line boxes of a match the user can see, or null when the browser
 * cannot tell. Empty for text with no visible box: every box empty,
 * positioned text moved off the page (as `left: -9999px` or a `fixed`
 * `top: -500px` box does, see offPage), clipped to nothing
 * (screen-reader-only text), with `opacity: 0`, or in a transparent
 * colour. Any other box is kept wherever it is: it can be text scrolled
 * away inside a pane or a code block, either way (a `column-reverse` chat
 * pane scrolled up, a right-to-left page or pane scrolled sideways).
 */
function visibleBoxes(r: Range, cache: SeenCache): Box[] | null {
  const boxes = rangeBoxes(r);
  if (!boxes) return null;
  const node = r.startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  let shown = boxes.filter((b) => b.width > 0 && b.height > 0);
  if (shown.length === 0) return [];
  const placed = placedText(el, cache);
  if (placed) shown = shown.filter((b) => !offPage(b, placed, cache));
  if (shown.length === 0) return [];
  return clippedAway(el, cache) || inkless(el, cache) ? [] : shown;
}

/** True when a box is at least partly in the viewport. */
function onScreen(b: Box): boolean {
  return b.bottom > 0 && b.right > 0 && b.top < window.innerHeight && b.left < window.innerWidth;
}

/** How far a point is from a box (0 inside it). */
function distance(b: Box, x: number, y: number): number {
  const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
  const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
  return Math.hypot(dx, dy);
}

/** How far back a cut match is read again, so look-behinds see real context. */
const CUT_CONTEXT = 40;

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/**
 * Whether the parser reads a space where the selection's string runs the
 * text of two inline-blocks (or other boxes in the line) together, by the
 * characters on either side: 'space' where a letter meets a letter or a
 * digit ("UTCend", "UTC3 days"); 'maybe' between two digits (a date box
 * then a time box, but also one box per digit); null next to punctuation
 * ("10" | ":" | "30").
 */
function boxEdgeSpace(a: string, b: string): 'space' | 'maybe' | null {
  const la = LETTER.test(a);
  const lb = LETTER.test(b);
  const da = DIGIT.test(a);
  const db = DIGIT.test(b);
  if ((la && (lb || db)) || (da && lb)) return 'space';
  return da && db ? 'maybe' : null;
}

/**
 * `text` with a space put in before each break's index (ascending), where
 * each space then is in the result (`at`), and which breaks are between
 * text that is apart on the page.
 */
function spaced(
  text: string,
  breaks: ReadonlyArray<{ readonly t: number; readonly apart: boolean }>,
): { apart: boolean[]; at: number[]; parsedText: string } {
  const at = breaks.map((b, k) => b.t + k);
  const apart = breaks.map((b) => b.apart);
  if (breaks.length === 0) return { apart, at, parsedText: text };
  const parts: string[] = [];
  let from = 0;
  for (const b of breaks) {
    parts.push(text.slice(from, b.t));
    from = b.t;
  }
  parts.push(text.slice(from));
  return { apart, at, parsedText: parts.join(' ') };
}

/**
 * Every time in a card's text, in reading order (see readTimes), as the page
 * shows it:
 * - Where the selection's string runs together text the page keeps apart
 *   (SelectionMap.breaks), the parser reads a space there; at an
 *   inline-block's edge only as boxEdgeSpace says. A time that
 *   still runs across a place where the two sides are not next to each
 *   other on the page is cut there when the part before is a time by
 *   itself, else dropped. One across the edge of an inline-block (a date
 *   and a time in boxes side by side) is read whole.
 * - Times in text the user cannot see (off-screen or screen-reader-only)
 *   are dropped.
 * - It opens on the best match; when that is off screen and another one is
 *   on screen, on the visible one nearest the pointer (or the selection's
 *   end) instead.
 */
function readCard(src: CardText): Reading {
  const opts = parseOptions();
  const sm = selectionMap(src);
  if (!sm || src.selText === null) {
    const r = readTimes(src.text, opts);
    return { matches: [...r.matches], open: r.best, capped: r.capped };
  }
  // Breaks in the trimmed text that get a space: every one where the two
  // sides are apart; at an inline-block's edge, only where a letter meets
  // a letter or digit ("UTC" | "3 days"). Two digits there ("2024-08-13" |
  // "07:00", or one box per digit of "10:30") get one only when that
  // reading finds more times; punctuation never does.
  const hard: Array<{ t: number; apart: boolean }> = [];
  const soft: number[] = [];
  for (const b of sm.breaks) {
    const t = b.at - src.selLead;
    if (t <= 0 || t >= src.text.length) continue;
    if (b.apart) {
      hard.push({ t, apart: true });
      continue;
    }
    const kind = boxEdgeSpace(src.text[t - 1] as string, src.text[t] as string);
    if (kind === 'space') hard.push({ t, apart: false });
    else if (kind === 'maybe') soft.push(t);
  }
  let { apart, at, parsedText } = spaced(src.text, hard);
  let got = readTimes(parsedText, opts);
  if (soft.length > 0) {
    const all = [...hard, ...soft.map((t) => ({ t, apart: false }))].sort((a, b) => a.t - b.t);
    const alt = spaced(src.text, all);
    const altGot = readTimes(alt.parsedText, opts);
    if (altGot.matches.length > got.matches.length) {
      ({ apart, at, parsedText } = alt);
      got = altGot;
    }
  }
  const best = got.matches[got.best];
  /** How many spaces went in before index `q` of the parsed text. */
  const before = (q: number): number => {
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((at[mid] as number) < q) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const kept: Array<{ p: ParsedTime; best: boolean; boxes: Box[] | null }> = [];
  const clips = seenCache();
  for (const found of got.matches) {
    const q = found.sourceIndex ?? 0;
    const end = q + found.matchedText.length;
    const k = before(q);
    // The first break it runs across where the two sides are apart.
    let cut = -1;
    for (let n = k; n < at.length && (at[n] as number) < end && cut < 0; n++) if (apart[n]) cut = at[n] as number;
    let p: ParsedTime | null = found;
    if (cut >= 0) {
      // Runs across text that is not next to it: keep the part before, if that is a time.
      const ctx = Math.max(0, q - CUT_CONTEXT);
      p = parseTimes(parsedText.slice(ctx, cut), opts).find((h) => (h.sourceIndex ?? 0) + ctx === q) ?? null;
    }
    if (!p) continue;
    // Its text as the selection has it: without the spaces put in (one read
    // across an inline-block's edge has some).
    const pe = q + p.matchedText.length;
    const ke = before(pe);
    p = { ...p, sourceIndex: q - k, matchedText: ke > k ? src.text.slice(q - k, pe - ke) : p.matchedText };
    const r = matchRange(src, p);
    const boxes = r ? visibleBoxes(r, clips) : null;
    if (boxes && boxes.length === 0) continue;
    kept.push({ p, best: found === best, boxes });
  }
  const matches = kept.map((m) => m.p);
  let open = Math.max(0, kept.findIndex((m) => m.best));
  const shown = kept[open];
  const offScreen = !shown || (shown.boxes !== null && !shown.boxes.some(onScreen));
  if (offScreen && kept.length > 1) {
    const pt = src.point ?? selectionEnd(src.selRange);
    let nearest = -1;
    let d = Infinity;
    kept.forEach((m, i) => {
      for (const b of m.boxes ?? []) {
        if (!onScreen(b)) continue;
        const e = pt ? distance(b, pt.x, pt.y) : b.top;
        if (e < d) {
          d = e;
          nearest = i;
        }
      }
    });
    if (nearest >= 0) open = nearest;
  }
  return { matches, open, capped: got.capped };
}

/**
 * Where a selection ends on screen, or null. Measured at its end point
 * only: the boxes of a whole select-all would cost a layout of every line.
 */
function selectionEnd(range: Range | null): { x: number; y: number } | null {
  if (!range) return null;
  try {
    const r = document.createRange();
    r.setStart(range.endContainer, range.endOffset);
    r.collapse(true);
    const b = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null;
    return b && (b.top || b.left || b.height) ? { x: b.left, y: b.bottom } : null;
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
function setLiveHighlight(src: MarkSource, p: ParsedTime): void {
  try {
    liveRange = matchRange(src, p)?.cloneRange() ?? null;
  } catch {
    liveRange = null;
  }
  if (!liveRange || !prefs.keepSelection) return;
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
function refitFixed(hostEl: HTMLDivElement, anchor: DOMRect): void {
  // A card re-anchored next to another match refits to that one, also from
  // the observers of an earlier anchor.
  fixedAnchors.set(hostEl, anchor);
  const fit = (): void => {
    // Once the user drags the card, its position is theirs.
    if (!hostEl.isConnected || hostEl.dataset.tzxDragged === '1') return;
    const rect = fixedAnchors.get(hostEl) ?? anchor;
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

/** The rect each viewport-anchored card is placed next to now. */
const fixedAnchors = new WeakMap<HTMLElement, DOMRect>();

/** Place a pinned card at a document-space point (scrolls with the page). */
function positionAbsolute(hostEl: HTMLDivElement, pageX: number, pageY: number, w = CARD_MAX_W): void {
  // Clamp horizontally within the document width so it never overflows off-screen.
  applyBox(hostEl, 'absolute', pageY, clampPageLeft(pageX, w));
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

/** Scroll events before this time come from our own scrolling (see revealMatch). */
let ownScrollUntil = 0;
/** How long scroll events after our own scroll are taken as ours. */
export const OWN_SCROLL_MS = 250;

/** Where our own scroll left the window (a user's scroll moves it on from there). */
let ownScrollAt: { x: number; y: number } | null = null;

function onScroll(e?: Event): void {
  // Our own scroll to a match keeps the card: the window's scroll event
  // while it is still where we put it, or a scrolled box's, shortly after.
  if (Date.now() < ownScrollUntil) {
    const t = e?.target;
    const ofWindow = !t || t === document || t === document.documentElement || t === document.body;
    if (!ofWindow || (ownScrollAt && window.scrollX === ownScrollAt.x && window.scrollY === ownScrollAt.y)) return;
  }
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
  if (e.key !== 'Escape') return;
  if (fromOurUi(e)) {
    if (dockHost && e.target instanceof Node && dockHost.contains(e.target)) return;
    const origin = e.composedPath()[0];
    if (isTextField(origin) && !isIdleZoneSearch(origin)) return;
  }
  dismissTransient(true);
}

/**
 * The "focus the card" command (the browser's key binding, forwarded by the
 * worker): while the transient card is open, move focus into it, or, when
 * focus is already in it, back to the page element that had it. False when
 * there is no card. Page keys are never intercepted for this.
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
interface TransientState extends CardText {
  /** What the card is placed next to: the selection, or the shown match after a scroll to it. */
  rect: DOMRect;
  pageX: number;
  pageY: number;
  /** Every match in the selection, in reading order; the card shows `index`. */
  matches: ParsedTime[];
  index: number;
  parsed: ParsedTime;
  count: number;
  /** True when the selection has more times than `matches` lists. */
  capped: boolean;
  compact: boolean;
}
let tState: TransientState | null = null;

/** Mark the shown match of the transient card on the page (when its text can be found). */
function markShownMatch(st: TransientState): void {
  clearLiveHighlight();
  if (!st.selRange) return;
  setLiveHighlight(st, st.parsed);
}

/** Take a fresh parse of the transient card's text and show its `index`-th match. */
function takeReparse(st: TransientState, again: NonNullable<ReturnType<typeof reparse>>): void {
  st.matches = again.matches;
  st.index = again.index;
  st.parsed = again.parsed;
  st.count = again.count;
  st.capped = again.capped;
  markShownMatch(st);
  paintTransient();
}

/** Room left between a time scrolled into view and the screen's edge, in px. */
export const REVEAL_MARGIN = 48;

/**
 * After a step: when the shown match is off screen, scroll it into view
 * (nearest edge, REVEAL_MARGIN from it) and put the card next to it. That scroll does not close
 * the card, as a user's scroll does. A match on screen but under the card
 * moves the card only.
 */
function revealMatch(st: TransientState): void {
  const hostEl = tHost;
  const r = liveRange;
  if (!hostEl || !r || typeof r.getBoundingClientRect !== 'function') return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let box = r.getBoundingClientRect();
  if (!box.width && !box.height) return;
  const inView = box.top >= 0 && box.bottom <= vh && box.left >= 0 && box.right <= vw;
  if (inView) {
    // On screen but under the card (a long selection): move the card.
    const c = hostEl.getBoundingClientRect();
    const covered = c.left < box.right && c.right > box.left && c.top < box.bottom && c.bottom > box.top;
    if (covered) anchorTo(st, hostEl, box);
    return;
  }
  ownScrollUntil = Date.now() + OWN_SCROLL_MS;
  const el = r.startContainer.nodeType === Node.TEXT_NODE ? r.startContainer.parentElement : (r.startContainer as Element);
  try {
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
    }
  } catch {
    /* not scrollable */
  }
  box = r.getBoundingClientRect();
  // Leave some room between the time and the screen's edge (scrollIntoView
  // puts it flush), and bring the line itself in when a block taller than
  // the screen left it outside.
  const room = Math.min(REVEAL_MARGIN, Math.max(0, (vh - box.height) / 2));
  const dy = box.top < room ? box.top - room : box.bottom > vh - room ? box.bottom - (vh - room) : 0;
  if (dy) {
    try {
      window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
    } catch {
      /* no window scroll */
    }
    box = r.getBoundingClientRect();
  }
  ownScrollAt = { x: window.scrollX, y: window.scrollY };
  anchorTo(st, hostEl, box);
}

/** Put the transient card next to `box` (the shown match), unless the user dragged it. */
function anchorTo(st: TransientState, hostEl: HTMLDivElement, box: DOMRect): void {
  st.rect = box;
  st.pageX = box.left + window.scrollX;
  st.pageY = box.bottom + MARGIN + window.scrollY;
  // Once the user drags the card, its position is theirs.
  if (hostEl.dataset.tzxDragged === '1') return;
  positionFixed(hostEl, box);
  refitFixed(hostEl, box);
}

/** The browser's binding for the focus command (undefined until the worker says). */
let focusKey: ShortcutLabel | null | undefined;

/** Ask the worker what the focus command is bound to; repaint the card when that changed. */
function refreshFocusKey(): void {
  const msg: GetShortcutMessage = { type: 'tzx/get-shortcut' };
  try {
    void Promise.resolve(chrome.runtime.sendMessage(msg))
      .then((reply: unknown) => {
        if (!isShortcutReply(reply)) return;
        const next = shortcutLabel(reply.shortcut);
        if (next?.aria === focusKey?.aria && (next === null) === (focusKey === null)) return;
        focusKey = next;
        paintTransient();
      })
      .catch(() => undefined);
  } catch {
    /* extension context gone */
  }
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
      matchesCapped: st.capped,
      focusShortcut: focusKey,
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
          capped: st.capped,
          index: st.index,
          matches: st.matches,
          src: pinTextOf(st),
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
        revealMatch(st);
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
        const again = reparse(st, st.parsed);
        if (again) takeReparse(st, again);
      },
      onDateOrder: (order: NumericDateOrder) => {
        patchPrefs({ numericDateOrder: order });
        const again = reparse(st, st.parsed);
        if (again) takeReparse(st, again);
      },
    }),
  );
}

/** A selection to show a card for: its text, where that is on the page, and the box it is in. */
interface CardSource extends CardText {
  readonly rect: DOMRect;
}

/** Just the selection of a card, with its map (see selectionMap). */
function cardTextOf(c: CardText): CardText {
  return { text: c.text, selRange: c.selRange, selText: c.selText, selLead: c.selLead, selMap: c.selMap };
}

/**
 * What a pin keeps of its card's selection: the text and its range, not
 * the map, which can hold an entry for each of tens of thousands of
 * characters for the pin's whole life (see pinMatchRange).
 */
function pinTextOf(c: CardText): CardText {
  return { text: c.text, selRange: c.selRange, selText: c.selText, selLead: c.selLead };
}

/** For tests: whether each pinned card holds a selection map. */
export function pinsHoldMaps(): boolean[] {
  return Array.from(pins, (p) => p.src.selMap !== undefined);
}

/** True when a box is wholly in the viewport. */
function whollyOnScreen(b: Box): boolean {
  return b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth;
}

function renderTransient(src: CardSource, reading: Reading): void {
  teardownTransient();
  const { rect } = src;
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

    // Opens on the best match (or the visible one nearest the pointer); the
    // stepper counts in reading order.
    const index = reading.open;
    // Capture a document-space point for the pin, from the current scroll.
    tState = {
      ...cardTextOf(src),
      rect,
      pageX: rect.left + window.scrollX,
      pageY: rect.bottom + MARGIN + window.scrollY,
      matches: reading.matches,
      index,
      parsed: reading.matches[index] as ParsedTime,
      count: reading.matches.length,
      capped: reading.capped,
      compact: opensCompact(),
    };
    markShownMatch(tState);
    tRoot = createRoot(mount);
    paintTransient();
    // A selection running off screen: open next to the time shown, when
    // that is on screen, not next to the selection's far edge.
    const shown = liveRange && typeof liveRange.getBoundingClientRect === 'function' ? liveRange.getBoundingClientRect() : null;
    if (shown && (shown.width || shown.height) && whollyOnScreen(shown) && !whollyOnScreen(rect)) {
      anchorTo(tState, tHost, shown);
    } else {
      refitFixed(tHost, rect);
    }
    document.addEventListener('scroll', onScroll, true);
    // The binding may have changed in the browser's settings since.
    refreshFocusKey();
  } catch {
    teardownTransient();
  }
}

// --- Pin lifecycle --------------------------------------------------------

/** Everything needed to (re)create a pinned card, e.g. for "Close all" → Undo. */
interface PinSpec {
  readonly parsed: ParsedTime;
  readonly count: number;
  /** True when the selection has more times than `count`. */
  readonly capped?: boolean;
  /** Which match of the selection it shows (default 0). */
  readonly index?: number;
  /** Every time in the selection, in reading order (default: just `parsed`). */
  readonly matches?: readonly ParsedTime[];
  /** Its selection: the text and where it is on the page. */
  readonly src: CardText;
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

/**
 * Left edge a pinned card `w` px wide gets for a page x (kept inside the
 * document width; the widest card when its width is not known).
 */
function clampPageLeft(pageX: number, w = CARD_MAX_W): number {
  const docW = document.documentElement.scrollWidth;
  return Math.max(MARGIN, Math.min(pageX, docW - w - MARGIN));
}

/** Where a card is now, in page coordinates (after any drag, float or clamp). */
function currentPagePos(pin: Pin): { x: number; y: number } {
  const left = parseFloat(pin.host.style.getPropertyValue('left')) || 0;
  const top = parseFloat(pin.host.style.getPropertyValue('top')) || 0;
  return pin.placement === 'floating' ? { x: left + window.scrollX, y: top + window.scrollY } : { x: left, y: top };
}

/** A rectangle in page coordinates. */
interface PageRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A card's size, or the usual size while it cannot be measured. */
function cardSize(host: HTMLElement): { w: number; h: number } {
  const r = host.getBoundingClientRect();
  return { w: r.width || CARD_MAX_W, h: r.height || EST_HEIGHT };
}

/** Where a pinned card is on the page now. */
function pinBox(p: Pin): PageRect {
  const at = currentPagePos(p);
  const { w, h } = cardSize(p.host);
  return { left: at.x, top: at.y, right: at.x + w, bottom: at.y + h };
}

/** Where a page range is, in page coordinates; null when it is gone or has no box. */
function rangeBox(range: Range | null): PageRect | null {
  if (!range || range.collapsed || !range.startContainer.isConnected) return null;
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const r = selectionRect(range);
  if (!r.width && !r.height) return null;
  const sx = window.scrollX;
  const sy = window.scrollY;
  return { left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy };
}

function overlapsPage(a: PageRect, b: PageRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** A card's top-left corner on the page. */
type PagePoint = { x: number; y: number };

/**
 * Where to pin `pin` on the page. No other card moves for it. A spot is
 * free when the card there covers no pinned card among `others`, none of
 * their text, and not its own text. The first free spot of:
 * 1. right below its text;
 * 2. to the right of its text, when the screen has room for it there;
 * 3. the free spot nearest to "below its text", on screen across, among
 *    the spots lined up with the edges of what is in the way and of the
 *    screen (so the search grows outward from below its text);
 * 4. directly below the lowest card in the way of "below its text",
 *    stacking down the page as far as it takes.
 * Steps 1 to 3 look for a spot wholly on screen first, then for any spot;
 * when its text is scrolled off screen, for any spot only (so the card
 * goes back by its text). Spots right of other cards count up to the
 * screen's edge, at the card's own width.
 * `fallback` stands in for "below its text" when the text is gone.
 * Floating cards are left out: they stay on screen wherever the page is.
 */
function pinSpot(pin: Pin, others: Iterable<Pin>, fallback: PagePoint): PagePoint {
  const { w, h } = cardSize(pin.host);
  const own = rangeBox(pin.range);
  const blocked: PageRect[] = [];
  if (own) blocked.push(own);
  for (const o of others) {
    if (o === pin || o.placement !== 'pinned') continue;
    blocked.push(pinBox(o));
    const text = rangeBox(o.range);
    if (text) blocked.push(text);
  }
  const boxAt = (x: number, y: number): PageRect => ({ left: x, top: y, right: x + w, bottom: y + h });
  const free = (x: number, y: number): boolean => {
    const box = boxAt(x, y);
    return !blocked.some((b) => overlapsPage(box, b));
  };
  const sx = window.scrollX;
  const sy = window.scrollY;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const whollyShown = (x: number, y: number): boolean => x >= sx && y >= sy && x + w <= sx + vw && y + h <= sy + vh;
  // Searched spots stay on screen across (or at its left edge, for a card
  // wider than the screen): one off to the side cannot be seen by scrolling
  // down, and widens the page.
  const across = (x: number): boolean => x >= sx && x <= Math.max(sx + MARGIN, sx + vw - w);
  // Kept inside the page at the card's own width, so the columns right of
  // other cards count up to the screen's edge.
  const clampLeft = (x: number): number => clampPageLeft(x, w);
  const inPage = (x: number, y: number): boolean => y >= MARGIN && clampLeft(x) === x && across(x);

  const below = { x: clampLeft(own ? own.left : fallback.x), y: Math.max(MARGIN, own ? own.bottom + MARGIN : fallback.y) };
  const right = own ? { x: own.right + MARGIN, y: Math.max(MARGIN, own.top) } : null;
  const roomRight = !!right && right.x + w <= sx + vw - MARGIN && clampLeft(right.x) === right.x;
  // Its text scrolled away ("Pin all to page" after scrolling): by its text
  // first, wherever that is, before any spot on screen.
  const textAway = !!own && (own.bottom <= sy || own.top >= sy + vh || own.right <= sx || own.left >= sx + vw);

  const xs = new Set<number>([below.x, MARGIN, sx + MARGIN, sx + vw - w - MARGIN]);
  const ys = new Set<number>([below.y, sy + MARGIN, sy + vh - h - MARGIN]);
  if (own) {
    xs.add(own.right + MARGIN);
    xs.add(own.left - w - MARGIN);
    ys.add(own.top);
    ys.add(own.top - h - MARGIN);
  }
  for (const b of blocked) {
    xs.add(b.left);
    xs.add(b.right + MARGIN);
    xs.add(b.left - w - MARGIN);
    ys.add(b.bottom + MARGIN);
    ys.add(b.top - h - MARGIN);
  }
  const spots: Array<{ x: number; y: number; d: number }> = [];
  for (const y of ys) {
    for (const x of xs) {
      if (inPage(x, y)) spots.push({ x, y, d: Math.hypot(x - below.x, y - below.y) });
    }
  }
  spots.sort((a, b) => a.d - b.d);

  for (const shownOnly of textAway ? [false] : [true, false]) {
    const ok = (x: number, y: number): boolean => free(x, y) && (!shownOnly || whollyShown(x, y));
    if (ok(below.x, below.y)) return below;
    if (right && roomRight && ok(right.x, right.y)) return right;
    const near = spots.find((s) => ok(s.x, s.y));
    if (near) return { x: near.x, y: near.y };
  }
  // Nothing free anywhere searched: stack below what is in the way.
  let y = below.y;
  for (let guard = 0; guard <= blocked.length; guard++) {
    const box = boxAt(below.x, y);
    const hit = blocked.filter((b) => overlapsPage(box, b));
    if (hit.length === 0) break;
    y = Math.max(...hit.map((b) => b.bottom)) + MARGIN;
  }
  return { x: below.x, y };
}

/** Put a pinned card at the spot pinSpot gives, among every other card. */
function placePin(pin: Pin, fallback: PagePoint, others: Iterable<Pin> = pins): void {
  const at = pinSpot(pin, others, fallback);
  movePin(pin, at);
}

function movePin(pin: Pin, at: PagePoint): void {
  positionAbsolute(pin.host, at.x, at.y, cardSize(pin.host).w);
  pin.pageX = at.x;
  pin.pageY = at.y;
}

/**
 * Scroll the page so a pinned card just placed is wholly in view (the
 * least scroll that does it), so it does not vanish on the click that
 * placed it. The scroll is ours: it dismisses nothing (see onScroll).
 */
function bringPinIntoView(pin: Pin): void {
  const r = pin.host.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const inView = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  if (inView || typeof pin.host.scrollIntoView !== 'function') return;
  ownScrollUntil = Date.now() + OWN_SCROLL_MS;
  try {
    pin.host.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  } catch {
    /* not scrollable */
  }
  ownScrollAt = { x: window.scrollX, y: window.scrollY };
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
 * next to its source text when that text is still on the page (see pinSpot:
 * clear of the cards in `others`, by default every other card, which stay
 * where they are), else where it is now, in page coordinates.
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
    // Measured as it will be once pinned (the "floating" tag goes).
    pin.placement = placement;
    renderNow(pin);
    placePin(pin, anchor, others ?? pins);
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
    const px = spec.pageX;
    const py = spec.pageY;
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
      src: spec.src,
      matches: spec.matches ? [...spec.matches] : [spec.parsed],
      parsed: spec.parsed,
      count: spec.count,
      capped: spec.capped ?? false,
      index: spec.index ?? 0,
      compact: spec.compact,
      placement,
      fullWidth: spec.fullWidth ?? null,
      render: () => {
        root.render(
          createElement(Popover, {
            parsed: pin.parsed,
            matchCount: pin.count,
            matchesCapped: pin.capped,
            matchIndex: pin.index,
            prefs,
            pinned: true,
            placement: pin.placement,
            compact: pin.compact,
            pinNumber: slot + 1,
            pinDot: color.dot,
            onStep: pin.matches.length > 1 || pin.capped ? (delta: number) => stepPin(pin, delta) : undefined,
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
              if (pin.placement === 'pinned') bringPinIntoView(pin);
              refreshDock();
            },
            onDragStart: (e) => startDrag(host, e, pin.placement === 'floating'),
            onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
              patchPrefs({ dateOnlyPolicy: policy });
              rereadPin(pin);
            },
            onDateOrder: (order: NumericDateOrder) => {
              patchPrefs({ numericDateOrder: order });
              rereadPin(pin);
            },
          }),
        );
      },
    };
    pins.add(pin);
    if (spec.box) pin.render();
    else {
      // Measure it first: where it can go depends on its size.
      renderNow(pin);
      placePin(pin, { x: px, y: py });
    }

    if (!restore) {
      // The value is pinned in its own slot; drop the transient card and its
      // live amber highlight (the pin's colored highlight has taken over).
      clearLiveHighlight();
      teardownTransient();
      closedPins = null;
    }
    refreshDock();
    if (!restore && !spec.box) bringPinIntoView(pin);
    return pin;
  } catch {
    /* restricted page — ignore */
    return null;
  }
}

/**
 * The page range of a pin's match. A pin keeps no selection map (one entry
 * per character of what was read, see mapSelection): it maps its selection
 * again, only up to the match, each time it needs one.
 */
function pinMatchRange(src: MarkSource, p: ParsedTime): Range | null {
  if (src.selMap || !src.selRange || src.selText === null) return matchRange(src, p);
  const end = src.selLead + (p.sourceIndex ?? 0) + p.matchedText.length;
  const selMap = mapSelection(src.selRange, src.selText, Math.min(src.selText.length, end + 1));
  return matchRange({ selRange: src.selRange, selText: src.selText, selLead: src.selLead, selMap }, p);
}

/** Move a pin's mark to the time it shows now. */
function markPin(pin: Pin): void {
  clearPinHighlight(pin.slot);
  let range: Range | null = null;
  try {
    range = pinMatchRange(pin.src, pin.parsed)?.cloneRange() ?? null;
  } catch {
    range = null;
  }
  pin.range = range;
  setPinHighlight(pin.slot, range);
}

/**
 * Where a stepped pin goes when it covers its own new mark (`mark`): a spot
 * wholly on screen right by the mark (just above it, just below it, or
 * beside it, slid along the mark's edge to stay on screen), over neither
 * the mark nor another pinned card; the one nearest to where the card is.
 * Null when there is none: the card then stays where it is.
 */
function stepSpot(pin: Pin, mark: PageRect): PagePoint | null {
  const { w, h } = cardSize(pin.host);
  const sx = window.scrollX;
  const sy = window.scrollY;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const blocked: PageRect[] = [mark];
  for (const o of pins) if (o !== pin && o.placement === 'pinned') blocked.push(pinBox(o));
  const intoX = (x: number): number => Math.max(sx + MARGIN, Math.min(x, sx + vw - w - MARGIN));
  const intoY = (y: number): number => Math.max(sy + MARGIN, Math.min(y, sy + vh - h - MARGIN));
  const spots: PagePoint[] = [
    { x: intoX(mark.left), y: mark.top - h - MARGIN },
    { x: intoX(mark.left), y: mark.bottom + MARGIN },
    { x: mark.right + MARGIN, y: intoY(mark.top) },
    { x: mark.left - w - MARGIN, y: intoY(mark.top) },
  ];
  const now = currentPagePos(pin);
  const fits = (s: PagePoint): boolean => {
    const box = { left: s.x, top: s.y, right: s.x + w, bottom: s.y + h };
    const shown = box.left >= sx && box.top >= sy && box.right <= sx + vw && box.bottom <= sy + vh;
    return shown && clampPageLeft(s.x, w) === s.x && !blocked.some((b) => overlapsPage(box, b));
  };
  const ok = spots.filter(fits);
  ok.sort((a, b) => Math.hypot(a.x - now.x, a.y - now.y) - Math.hypot(b.x - now.x, b.y - now.y));
  return ok[0] ?? null;
}

/**
 * Show the previous (-1) or next (+1) time of a pin's selection, wrapping
 * around, and move its mark there. The card stays where it is, unless it
 * would cover that time itself: then a pinned card moves to a spot on
 * screen by the mark (see stepSpot), or stays put (partly over its mark)
 * when there is none, rather than jump off screen.
 * (It may still cover another pin's time; cards sit next to text.)
 */
function stepPin(pin: Pin, delta: number): void {
  const n = pin.matches.length;
  if (n < 2) return;
  pin.index = (((pin.index + delta) % n) + n) % n;
  pin.parsed = pin.matches[pin.index] as ParsedTime;
  markPin(pin);
  pin.render();
  if (pin.placement !== 'pinned') return;
  const mine = rangeBox(pin.range);
  if (!mine || !overlapsPage(pinBox(pin), mine)) return;
  const at = stepSpot(pin, mine);
  if (at) movePin(pin, at);
}

/** Read a pin's text again with the current settings, keeping the match it shows when it is still there. */
function rereadPin(pin: Pin): void {
  const again = reparse(pin.src, pin.parsed);
  // Reading built the selection's map; the pin does not keep it (see pinMatchRange).
  pin.src.selMap = undefined;
  if (again) {
    const moved = !sameMatch(again.parsed, pin.parsed);
    pin.parsed = again.parsed;
    pin.matches = again.matches;
    pin.count = again.count;
    pin.capped = again.capped;
    pin.index = again.index;
    if (moved && pin.src.selRange) markPin(pin);
  }
  pin.render();
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
    capped: pin.capped,
    index: pin.index,
    matches: pin.matches,
    src: pin.src,
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

/**
 * Cards in the order their text comes in the page; cards whose text is
 * gone keep their order, after the others.
 */
function inReadingOrder(list: readonly Pin[]): Pin[] {
  const at = (p: Pin): Range | null => (p.range && p.range.startContainer.isConnected ? p.range : null);
  return [...list].sort((a, b) => {
    const ra = at(a);
    const rb = at(b);
    if (!ra || !rb) return ra ? -1 : rb ? 1 : 0;
    try {
      return ra.compareBoundaryPoints(Range.START_TO_START, rb);
    } catch {
      return 0;
    }
  });
}

function togglePlacementAll(): void {
  const list = Array.from(pins);
  const allFloating = list.every((p) => p.placement === 'floating');
  if (allFloating) {
    // Each card goes back next to its own source, in reading order, one by
    // one by the same rule as a new pin: clear of the cards already put back
    // in this pass (the others still float).
    const placed: Pin[] = [];
    for (const pin of inReadingOrder(list)) {
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
function showForSelection(src: CardSource, fromMenu = false, truncated = false): void {
  const reading = readCard(src);
  if (reading.matches.length === 0) {
    // Menu text without a live selection arrives cut to MAX_MESSAGE_TEXT.
    if (fromMenu) renderNoMatch(src.rect, src.text, truncated ? MAX_MESSAGE_TEXT : MAX_READ_CHARS);
    else teardownTransient();
    return;
  }
  renderTransient(src, reading);
}

/** A card source with no page range (form fields, menu text). */
function plainSource(rect: DOMRect, text: string): CardSource {
  return { rect, text, selRange: null, selText: null, selLead: 0 };
}

/** The "no time recognized" card; `checked` is how many characters of the text were read. */
function renderNoMatch(rect: DOMRect, text: string, checked: number): void {
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
        truncated: checked < MAX_READ_CHARS || text.length > checked,
        checkedChars: checked,
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
function readSelection(): CardSource | null {
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
        return plainSource(active.getBoundingClientRect(), text);
      }
    }
    return null;
  }

  // Normal DOM / contenteditable selection.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  // The parser reads the trimmed string; marks map its indices back through
  // the untrimmed one (see mapSelectionText).
  const selText = sel.toString();
  const text = selText.trim();
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
  // A selection the mouse just made opens on the time nearest the pointer
  // when its best one is off screen (keyboard selections: nearest their end).
  const point = lastPointer && Date.now() - lastPointer.at < POINTER_FRESH_MS ? lastPointer : null;
  return {
    text,
    rect,
    selRange: range.cloneRange(),
    selText,
    selLead: selText.length - selText.trimStart().length,
    point: point ? { x: point.x, y: point.y } : null,
  };
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
    showForSelection(got);
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
    showForSelection(got, true);
    return;
  }
  const text = menuText.trim();
  if (text.length === 0) return;
  shownKey = null;
  showForSelection(plainSource(fallbackRect(), text), true, truncated);
}

/** Where the last mouse selection ended (viewport), and when. */
let lastPointer: { x: number; y: number; at: number } | null = null;
/** How long after the mouse is released its place still stands for the selection's end. */
const POINTER_FRESH_MS = 1000;

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
  lastPointer = { x: e.clientX, y: e.clientY, at: Date.now() };
  handleSelectionChange();
}

/** Keys that extend a selection when held with Shift. */
const SELECT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** Set while the user is extending a selection from the keyboard. */
let keyboardSelecting = false;

function onKeyDownSelect(e: KeyboardEvent): void {
  if (e.shiftKey && SELECT_KEYS.has(e.key)) {
    keyboardSelecting = true;
    lastPointer = null;
    return;
  }
  // Moving the caret without Shift collapses the selection: the next one is a
  // fresh gesture, even if it selects the same text again.
  if (!e.shiftKey && SELECT_KEYS.has(e.key)) dismissedKey = null;
  // Select all (Cmd/Ctrl+A). Use the physical key so non-Latin layouts work,
  // and keydown because macOS does not send keyup for keys held with Cmd. The
  // selection changes after this event, so read it on the next tick.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'KeyA') {
    lastPointer = null;
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
  if (!fromThisExtension(sender)) return undefined;
  if (isFocusCardMessage(msg)) {
    // Every frame of the tab gets the command; only the one with a card answers.
    if (toggleCardFocus()) sendResponse({ ok: true });
    return undefined;
  }
  if (!isConvertSelectionMessage(msg)) return undefined;
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

/** Settings that change which times a card's text holds, or how they read. */
const READING_KEYS = ['homeZone', 'dateOnlyPolicy', 'numericDateOrder', 'customFormats', 'disabledFormats'] as const;
/** Settings that change only how a card shows its time. */
const DISPLAY_KEYS = ['hour12', 'targetZones', 'theme'] as const;

function changed(a: Preferences, b: Preferences, keys: ReadonlyArray<keyof Preferences>): boolean {
  return keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * Settings changed (in another tab, or Settings): open cards read their text
 * again when the change affects that, keeping the match they show when it
 * is still there, and repaint. A change made from a card here already
 * updated `prefs`, so it arrives with nothing changed.
 */
function followSettings(before: Preferences, now: Preferences): void {
  const reread = changed(before, now, READING_KEYS);
  if (!reread && !changed(before, now, DISPLAY_KEYS)) return;
  const st = tState;
  if (st && tHost) {
    applyHostTheme(tHost);
    const again = reread ? reparse(st, st.parsed) : null;
    if (again) takeReparse(st, again);
    else paintTransient();
  }
  for (const pin of pins) {
    applyHostTheme(pin.host);
    if (reread) rereadPin(pin);
    else pin.render();
  }
  if (dockHost) applyHostTheme(dockHost);
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
    const before = prefs;
    prefs = p;
    prefsLoaded = true;
    if (!p.selectToConvert) window.clearTimeout(debounceTimer);
    if (p.keepSelection !== before.keepSelection) syncHighlights();
    followSettings(before, p);
  });
  // The focus key is asked for when a card opens (see renderTransient), so
  // a page load does not wake the service worker.

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
