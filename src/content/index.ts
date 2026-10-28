import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { parseTimes } from '../lib/parse';
import { loadPreferences, savePreferences, onPreferencesChanged } from '../lib/storage';
import { DEFAULT_PREFERENCES, type DateOnlyPolicy, type ParsedTime, type Preferences } from '../types';
import { Popover } from './Popover';

const TRANSIENT_HOST_ID = 'tz-extension-popover-host';
const PIN_HOST_CLASS = 'tz-extension-pin-host';
const DEBOUNCE_MS = 200;
const CARD_MAX_W = 360;
const MARGIN = 8;
const EST_HEIGHT = 200;

let prefs: Preferences = DEFAULT_PREFERENCES;
let debounceTimer: number | undefined;

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
}
const pins = new Set<Pin>();

// --- Selection highlight --------------------------------------------------
// Draw a persistent highlight on the matched range using the CSS Custom
// Highlight API, so the text stays visibly marked even after the native
// selection is lost (clicking the popover, focus change). No-op where the API
// or a static stylesheet injection is unavailable.
const HIGHLIGHT_NAME = 'tz-extension-match';
let highlightStyleInjected = false;
let highlightRange: Range | null = null;

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

function ensureHighlightStyle(): void {
  if (highlightStyleInjected) return;
  try {
    const style = document.createElement('style');
    style.id = 'tz-extension-highlight-style';
    // Strong amber marker so it reads on any background once the native
    // selection is collapsed.
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.85); color: #1a1a1a; }`;
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

function setHighlight(range: Range, token: string): void {
  if (!prefs.keepSelection) return;
  const reg = highlightRegistry();
  const Ctor = HighlightCtor();
  if (!reg || !Ctor) return;
  try {
    ensureHighlightStyle();
    highlightRange = narrowRangeToToken(range, token).cloneRange();
    reg.set(HIGHLIGHT_NAME, new Ctor(highlightRange));
    // Collapse the native selection so our amber marker is the visible one.
    // Deferred so the current mouseup/selection event finishes first.
    window.setTimeout(() => {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    }, 0);
  } catch {
    highlightRange = null;
  }
}

function clearHighlight(): void {
  const reg = highlightRegistry();
  if (reg) {
    try {
      reg.delete(HIGHLIGHT_NAME);
    } catch {
      /* ignore */
    }
  }
  highlightRange = null;
}

void loadPreferences().then((p) => {
  prefs = p;
});
onPreferencesChanged((p) => {
  prefs = p;
});

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

/** User-facing dismissal: also clears the match highlight. */
function dismissTransient(): void {
  clearHighlight();
  teardownTransient();
}

function onScroll(): void {
  // Only the transient card is viewport-anchored; pinned cards scroll naturally.
  dismissTransient();
}

function onDocMouseDown(e: MouseEvent): void {
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
          const again = parseTimes(srcText, {
            assumedZone: prefs.homeZone,
            dateOnlyPolicy: policy,
            customFormats: prefs.customFormats,
          });
          if (again[0]) renderTransient(rect, again[0], again.length, srcText);
        },
      }),
    );
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
    const host = document.createElement('div');
    host.className = PIN_HOST_CLASS;
    const shadow = host.attachShadow({ mode: 'open' });
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    document.body.appendChild(host);
    positionAbsolute(host, pageX, pageY);

    const root = createRoot(mount);
    const pin: Pin = { host, root, pageX, pageY };
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
          onClose: () => removePin(pin),
          onToggleCompact: () => {
            isCompact = !isCompact;
            renderPin(p, count);
          },
          onDragStart: (e) => startDrag(host, e, false),
          onDateOnlyPolicy: (policy: DateOnlyPolicy) => {
            prefs = { ...prefs, dateOnlyPolicy: policy };
            void savePreferences(prefs);
            const again = parseTimes(srcText, {
              assumedZone: prefs.homeZone,
              dateOnlyPolicy: policy,
              customFormats: prefs.customFormats,
            });
            if (again[0]) renderPin(again[0], again.length);
          },
        }),
      );
    };
    renderPin(parsed, matchCount);

    // The value is pinned; drop the transient card but KEEP the match highlight
    // so the pinned value stays visibly marked on the page.
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
  // The highlight marks the pinned value; once no pin (and no transient) holds
  // it, drop the mark so the page returns to normal.
  if (pins.size === 0 && !tHost) clearHighlight();
}

// --- Selection handling ---------------------------------------------------

function showForSelection(rect: DOMRect, text: string, range: Range | null): void {
  const matches = parseTimes(text, {
    assumedZone: prefs.homeZone,
    dateOnlyPolicy: prefs.dateOnlyPolicy,
    customFormats: prefs.customFormats,
  });
  const parsed = matches[0];
  if (!parsed) {
    teardownTransient();
    return;
  }
  if (range) setHighlight(range, parsed.matchedText);
  renderTransient(rect, parsed, matches.length, text);
}

/** Read the active selection from the page OR from an input/textarea. */
function readSelection(): { text: string; rect: DOMRect; range: Range | null } | null {
  const active = document.activeElement;

  // <input> / <textarea>: use selectionStart/End and a mirror rect.
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
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
  debounceTimer = window.setTimeout(() => {
    const got = readSelection();
    if (!got) return;
    showForSelection(got.rect, got.text, got.range);
  }, DEBOUNCE_MS);
}

document.addEventListener('mouseup', handleSelectionChange);
document.addEventListener('keyup', (e) => {
  if (e.shiftKey || e.key === 'Escape') handleSelectionChange();
});
document.addEventListener('mousedown', onDocMouseDown, true);
document.addEventListener('keydown', onKeyDown, true);
