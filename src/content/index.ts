import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { parseTimes } from '../lib/parse';
import { loadPreferences, onPreferencesChanged } from '../lib/storage';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../types';
import { Popover } from './Popover';

const TRANSIENT_HOST_ID = 'tz-extension-popover-host';
const PIN_HOST_CLASS = 'tz-extension-pin-host';
const DEBOUNCE_MS = 200;
const CARD_MAX_W = 340;
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

function onScroll(): void {
  // Only the transient card is viewport-anchored; pinned cards scroll naturally.
  teardownTransient();
}

function onDocMouseDown(e: MouseEvent): void {
  // Clicking outside the transient card dismisses it. Pinned cards are ignored
  // (each manages its own close button).
  if (tHost && e.target instanceof Node && !tHost.contains(e.target)) {
    teardownTransient();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') teardownTransient();
}

function renderTransient(rect: DOMRect, parsed: ParsedTime, matchCount: number): void {
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

    tRoot = createRoot(mount);
    tRoot.render(
      createElement(Popover, {
        parsed,
        matchCount,
        prefs,
        pinned: false,
        onPin: () => pinCard(parsed, matchCount, pageX, pageY),
        onClose: teardownTransient,
      }),
    );
    document.addEventListener('scroll', onScroll, true);
  } catch {
    teardownTransient();
  }
}

// --- Pin lifecycle --------------------------------------------------------

function pinCard(parsed: ParsedTime, matchCount: number, pageX: number, pageY: number): void {
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

    root.render(
      createElement(Popover, {
        parsed,
        matchCount,
        prefs,
        pinned: true,
        onClose: () => removePin(pin),
      }),
    );

    // The transient card has served its purpose; the pin replaces it in place.
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
}

// --- Selection handling ---------------------------------------------------

function showForSelection(rect: DOMRect, text: string): void {
  const matches = parseTimes(text, prefs.homeZone);
  const parsed = matches[0];
  if (!parsed) {
    teardownTransient();
    return;
  }
  renderTransient(rect, parsed, matches.length);
}

function handleSelectionChange(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length === 0) return;

    // Ignore selections inside the transient card or any pinned card.
    if (sel.anchorNode) {
      if (tHost && tHost.contains(sel.anchorNode)) return;
      for (const pin of pins) {
        if (pin.host.contains(sel.anchorNode)) return;
      }
    }

    let rect: DOMRect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    if (rect.width === 0 && rect.height === 0) return;
    showForSelection(rect, text);
  }, DEBOUNCE_MS);
}

document.addEventListener('mouseup', handleSelectionChange);
document.addEventListener('keyup', (e) => {
  if (e.shiftKey || e.key === 'Escape') handleSelectionChange();
});
document.addEventListener('mousedown', onDocMouseDown, true);
document.addEventListener('keydown', onKeyDown, true);
