/**
 * The keyboard command that moves focus into the open conversion card and
 * back, and the messages the worker and the content script exchange for it.
 * The browser owns the key binding (manifest `commands`, rebindable in its
 * shortcut settings), so the content script never intercepts page keys.
 * Pure module: safe to import from the worker and the content script.
 */

/** The manifest `commands` key. */
export const FOCUS_COMMAND = 'focus-card';
/** Its description, shown in the browser's shortcut settings. */
export const FOCUS_COMMAND_DESCRIPTION = 'Move focus to the open conversion card and back';
/**
 * Suggested keys. Alt+Shift+T is Chrome's "focus toolbar" (Windows, Linux,
 * ChromeOS); Chrome and ChromeOS also take Alt+Shift+A/B/I/L/M/N/S. K is
 * free in Chrome, ChromeOS and Firefox. On macOS, Option+Shift+K types a
 * character, so the Mac default is Control+Shift+K.
 */
export const FOCUS_SUGGESTED_KEY = { default: 'Alt+Shift+K', mac: 'MacCtrl+Shift+K' } as const;

/** Worker -> content: toggle focus between the open card and the page. */
export interface FocusCardMessage {
  readonly type: 'tzx/focus-card';
}

/** Content -> worker: what is the focus command bound to? */
export interface GetShortcutMessage {
  readonly type: 'tzx/get-shortcut';
}

/** The worker's answer: the binding as the browser reports it ('' when unbound). */
export interface ShortcutReply {
  readonly shortcut: string;
}

export function isFocusCardMessage(m: unknown): m is FocusCardMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'tzx/focus-card';
}

export function isGetShortcutMessage(m: unknown): m is GetShortcutMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>).type === 'tzx/get-shortcut';
}

export function isShortcutReply(m: unknown): m is ShortcutReply {
  return typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).shortcut === 'string';
}

/** A binding for the card: as shown to people, and as `aria-keyshortcuts` wants it. */
export interface ShortcutLabel {
  readonly display: string;
  readonly aria: string;
}

const MAC_SYMBOLS: Readonly<Record<string, string>> = { '⌃': 'Control', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Meta' };
const ARIA_NAMES: Readonly<Record<string, string>> = {
  ctrl: 'Control',
  macctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  command: 'Meta',
  cmd: 'Meta',
  meta: 'Meta',
};
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: 'Command',
};

/**
 * Read a binding as `chrome.commands.getAll` reports it: "Alt+Shift+K" on
 * Windows and Linux, "⌃⇧K" from Chrome on macOS, "MacCtrl+Shift+K" or
 * "Ctrl+Shift+K" from Firefox. Null when unbound or unreadable.
 */
export function shortcutLabel(raw: string | null | undefined): ShortcutLabel | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let parts: string[];
  if (!s.includes('+') && [...s].some((c) => c in MAC_SYMBOLS)) {
    const chars = [...s];
    parts = chars.filter((c) => c in MAC_SYMBOLS).map((c) => MAC_SYMBOLS[c] as string);
    const key = chars.filter((c) => !(c in MAC_SYMBOLS)).join('');
    if (!key) return null;
    parts.push(key);
  } else {
    parts = s
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ARIA_NAMES[p.toLowerCase()] ?? p);
  }
  if (parts.length === 0) return null;
  return {
    aria: parts.join('+'),
    display: parts.map((p) => DISPLAY_NAMES[p] ?? p).join('+'),
  };
}
