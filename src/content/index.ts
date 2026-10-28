import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { parseTimes } from '../lib/parse';
import { loadPreferences, onPreferencesChanged } from '../lib/storage';
import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { Popover } from './Popover';

const HOST_ID = 'tz-extension-popover-host';
const DEBOUNCE_MS = 200;

let prefs: Preferences = DEFAULT_PREFERENCES;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let debounceTimer: number | undefined;

void loadPreferences().then((p) => {
  prefs = p;
});
onPreferencesChanged((p) => {
  prefs = p;
});

function teardown(): void {
  if (root) {
    root.unmount();
    root = null;
  }
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
  }
  host = null;
  document.removeEventListener('scroll', onScroll, true);
}

function onScroll(): void {
  teardown();
}

function onDocMouseDown(e: MouseEvent): void {
  if (host && e.target instanceof Node && !host.contains(e.target)) {
    teardown();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') teardown();
}

/** Position the host near a rect, flipping/clamping to stay in the viewport. */
function position(hostEl: HTMLDivElement, rect: DOMRect): void {
  const margin = 8;
  const maxW = 320;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer below the selection; flip above if not enough room.
  const estHeight = 180;
  let top = rect.bottom + margin;
  if (top + estHeight > vh && rect.top - margin - estHeight > 0) {
    top = Math.max(margin, rect.top - margin - estHeight);
  }
  top = Math.min(top, Math.max(margin, vh - estHeight - margin));

  let left = rect.left;
  if (left + maxW + margin > vw) {
    left = Math.max(margin, vw - maxW - margin);
  }
  left = Math.max(margin, left);

  hostEl.style.setProperty('position', 'fixed', 'important');
  hostEl.style.setProperty('top', `${top}px`, 'important');
  hostEl.style.setProperty('left', `${left}px`, 'important');
  hostEl.style.setProperty('margin', '0', 'important');
  hostEl.style.setProperty('padding', '0', 'important');
  hostEl.style.setProperty('z-index', '2147483647', 'important');
}

function showPopover(rect: DOMRect, text: string): void {
  const matches = parseTimes(text, prefs.homeZone);
  if (matches.length === 0) {
    teardown();
    return;
  }
  const parsed = matches[0];
  if (!parsed) {
    teardown();
    return;
  }

  teardown();

  try {
    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    document.body.appendChild(host);
    position(host, rect);

    root = createRoot(mount);
    root.render(
      createElement(Popover, {
        parsed,
        matchCount: matches.length,
        prefs,
        onClose: teardown,
      }),
    );

    document.addEventListener('scroll', onScroll, true);
  } catch {
    // Restricted page or DOM unavailable — fail silently.
    teardown();
  }
}

function handleSelectionChange(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return;
    }
    const text = sel.toString().trim();
    if (text.length === 0) {
      return;
    }
    // Avoid reacting to a selection inside our own popover.
    if (host && sel.anchorNode && host.contains(sel.anchorNode)) {
      return;
    }
    let rect: DOMRect;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      return;
    }
    if (rect.width === 0 && rect.height === 0) {
      return;
    }
    showPopover(rect, text);
  }, DEBOUNCE_MS);
}

document.addEventListener('mouseup', handleSelectionChange);
document.addEventListener('keyup', (e) => {
  // React to keyboard selection (shift+arrows) but not to typing in inputs.
  if (e.shiftKey || e.key === 'Escape') handleSelectionChange();
});
document.addEventListener('mousedown', onDocMouseDown, true);
document.addEventListener('keydown', onKeyDown, true);
