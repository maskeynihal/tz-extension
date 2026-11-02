import { loadPreferences, savePreferences } from '../lib/storage';
import {
  MAX_MESSAGE_TEXT,
  fromThisExtension,
  isOpenOptionsMessage,
  type Ack,
  type ConvertSelectionMessage,
} from '../lib/messages';
import { FOCUS_COMMAND, isGetShortcutMessage, type FocusCardMessage, type ShortcutReply } from './commands';

export const MENU_ID = 'tzx-convert-selection';
const MENU_TITLE = 'Convert “%s” with TZ Converter';

/**
 * (Re)create the right-click menu item. Chrome keeps menus across worker
 * restarts but not across browser updates in every case, and Firefox event
 * pages may lose them, so this runs on install, update and browser startup.
 * removeAll first makes it idempotent (create with a duplicate id errors).
 */
function registerMenus(): void {
  if (typeof chrome.contextMenus === 'undefined') return;
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create(
        { id: MENU_ID, title: MENU_TITLE, contexts: ['selection'] },
        () => void chrome.runtime.lastError,
      );
    });
  } catch {
    /* menus unavailable in this context */
  }
}

// On install/update, normalize any stored preferences (seeds defaults when empty).
chrome.runtime.onInstalled.addListener(() => {
  registerMenus();
  void (async () => {
    try {
      const prefs = await loadPreferences();
      await savePreferences(prefs);
    } catch {
      /* storage may be unavailable in some contexts; defaults apply at read time */
    }
  })();
});

chrome.runtime.onStartup?.addListener(registerMenus);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function trySend(tabId: number, frameId: number, msg: ConvertSelectionMessage): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as Ack | undefined;
    return Boolean(res && res.ok);
  } catch {
    // "Receiving end does not exist": no content script in that frame.
    return false;
  }
}

/** The content-script files from our own manifest (hashed names at build time). */
function contentScriptFiles(): string[] {
  try {
    const cs = chrome.runtime.getManifest().content_scripts ?? [];
    return cs.flatMap((c) => c.js ?? []);
  } catch {
    return [];
  }
}

/**
 * Inject the content script into a frame that does not have it: tabs opened
 * before the extension was installed or updated, or (Firefox) sites the user
 * has not granted access to. The menu click grants activeTab for this tab.
 */
async function inject(tabId: number, frameId: number): Promise<boolean> {
  const files = contentScriptFiles();
  if (files.length === 0 || typeof chrome.scripting === 'undefined') return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files });
    return true;
  } catch {
    // Restricted page (browser UI, web store) or no access to this frame.
    return false;
  }
}

/** The injected loader imports the module asynchronously; wait for its listener. */
async function sendWithRetry(tabId: number, frameId: number, msg: ConvertSelectionMessage): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    if (await trySend(tabId, frameId, msg)) return true;
    await sleep(100);
  }
  return false;
}

async function convertInTab(tabId: number, frameId: number, text: string): Promise<void> {
  const msg: ConvertSelectionMessage = {
    type: 'tzx/convert-selection',
    text: text.slice(0, MAX_MESSAGE_TEXT),
    truncated: text.length > MAX_MESSAGE_TEXT,
  };
  if (await trySend(tabId, frameId, msg)) return;
  if ((await inject(tabId, frameId)) && (await sendWithRetry(tabId, frameId, msg))) return;
  // A selection inside a frame we cannot reach: show the card in the top page.
  if (frameId !== 0) {
    if (await trySend(tabId, 0, msg)) return;
    if (await inject(tabId, 0)) await sendWithRetry(tabId, 0, msg);
  }
}

// Browsers offer no API to click a native menu item, so the e2e suite calls
// the same function the click handler uses. Only extension pages and this
// worker can reach the worker's global scope.
(globalThis as unknown as { tzxConvertInTab?: typeof convertInTab }).tzxConvertInTab = convertInTab;

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || tab.id < 0) return;
  void convertInTab(tab.id, info.frameId ?? 0, info.selectionText ?? '');
});

/*
 * Which tabs a fresh grant applies to
 * -----------------------------------
 * executeScript is not bound by the manifest's match patterns, so passing it
 * every open tab hands it pages the content script would never have run on:
 * the extension's own options page, chrome:// tabs, about:blank, data: URLs.
 * Chrome rejects all of those ("Cannot access contents of the page", "Cannot
 * access a chrome:// URL") and nothing is injected, so this was never a
 * security hole — but it is a round trip per tab for a call that cannot
 * succeed, and relying on another browser refusing the same way is not worth
 * it when the manifest already says which URLs we run on. So the patterns are
 * read back out of the manifest and matched here.
 */

/** Schemes `<all_urls>` covers (MV3). Never chrome-extension: or chrome:. */
const ALL_URLS_SCHEMES = ['http', 'https', 'file', 'ftp'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One match pattern as a regular expression, or null when unparseable. */
function patternToRegExp(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') return new RegExp(`^(?:${ALL_URLS_SCHEMES.join('|')}):`, 'i');
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!m) return null;
  const [, scheme = '', host = '', path = ''] = m;
  const schemeRe = scheme === '*' ? '(?:http|https)' : escapeRe(scheme);
  // "*" = any host; "*.example.com" = that domain or any subdomain.
  const hostRe =
    host === '*'
      ? '[^/]+'
      : host.startsWith('*.')
        ? `(?:[^/]+\\.)?${escapeRe(host.slice(2))}`
        : escapeRe(host);
  const pathRe = escapeRe(path).replace(/\\\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
}

let csMatchers: readonly RegExp[] | null = null;

/** The manifest content script's match patterns, compiled once. */
function contentScriptMatchers(): readonly RegExp[] {
  if (csMatchers) return csMatchers;
  let patterns: string[] = [];
  try {
    patterns = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.matches ?? []);
  } catch {
    patterns = [];
  }
  const compiled = patterns.map(patternToRegExp).filter((r): r is RegExp => r !== null);
  // An unreadable manifest must not silently stop every injection; fall back
  // to what this manifest declares, which is every ordinary web page.
  csMatchers = compiled.length > 0 ? compiled : [patternToRegExp('<all_urls>') as RegExp];
  return csMatchers;
}

/** True when the manifest's content script would have run on this URL. */
function wouldRunOn(url: string | undefined): boolean {
  if (!url) return false;
  return contentScriptMatchers().some((re) => re.test(url));
}

/** Run `fn` over `items`, `limit` of them in flight at once. */
async function inParallel<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** How many executeScript calls are in flight at once (a session can hold hundreds of tabs). */
const INJECT_CONCURRENCY = 8;

/**
 * A fresh all-sites grant reaches only future navigations: manifest content
 * scripts are not applied retroactively, so every tab the user already has
 * open stays dead until it is reloaded. Inject into each one instead. The
 * content script keeps a single live copy per page (see its INSTANCE_KEY
 * guard), so landing on a tab that already runs it is a no-op.
 *
 * `covers`, when given, are the origin patterns the grant just added: only
 * tabs inside them need anything, since every other tab either already had
 * the script or still has no access. Without it (a browser that reports no
 * origins) every tab the content script matches is tried.
 */
async function injectIntoOpenTabs(covers?: readonly RegExp[]): Promise<void> {
  if (contentScriptFiles().length === 0 || typeof chrome.tabs?.query !== 'function') return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const targets = tabs.filter((tab) => {
    if (tab.id === undefined || tab.id < 0) return false;
    // Without host access to a tab the browser withholds its URL; such a tab
    // could not be injected into either.
    const url = tab.url ?? tab.pendingUrl;
    if (!wouldRunOn(url)) return false;
    return !covers || covers.some((re) => re.test(url as string));
  });
  // inject() swallows restricted pages (browser UI, the web store) itself.
  await inParallel(targets, INJECT_CONCURRENCY, (tab) => inject(tab.id as number, 0));
}

// Exposed for the e2e suite, which cannot drive a permission prompt.
(globalThis as unknown as { tzxInjectIntoOpenTabs?: typeof injectIntoOpenTabs }).tzxInjectIntoOpenTabs =
  injectIntoOpenTabs;

/**
 * Only a grant that widens *host* access can bring a tab to life. Any other
 * optional permission (a named one, now or in some later feature) leaves
 * every page exactly as it was, so walking the whole tab list for it is pure
 * waste. A browser that reports no detail at all still gets the full walk.
 */
chrome.permissions?.onAdded?.addListener((added?: chrome.permissions.Permissions) => {
  if (added && typeof added === 'object') {
    const origins = Array.isArray(added.origins) ? added.origins : [];
    if (origins.length === 0) return;
    const covers = origins.map(patternToRegExp).filter((r): r is RegExp => r !== null);
    // Unparseable patterns: fall back to every tab we match rather than none.
    void injectIntoOpenTabs(covers.length === origins.length ? covers : undefined);
    return;
  }
  void injectIntoOpenTabs();
});

/** Open settings; with a section, open a tab scrolled to it (openOptionsPage takes no anchor). */
function openSettings(section: string | undefined): void {
  const page = chrome.runtime.getManifest().options_page;
  if (section && page && typeof chrome.tabs?.create === 'function') {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`${page}#${encodeURIComponent(section)}`) });
    return;
  }
  void chrome.runtime.openOptionsPage();
}

/** What the focus command is bound to now ('' when unbound or unreadable). */
async function focusShortcut(): Promise<string> {
  try {
    if (typeof chrome.commands?.getAll !== 'function') return '';
    const all = await chrome.commands.getAll();
    return all.find((c) => c.name === FOCUS_COMMAND)?.shortcut ?? '';
  } catch {
    return '';
  }
}

/**
 * The focus command: tell the tab's content scripts to move focus into the
 * open card or back. Every frame gets it; only the one showing a card acts.
 */
async function focusCardInTab(tabId: number | undefined): Promise<void> {
  let id = tabId;
  if (id === undefined || id < 0) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      id = tab?.id;
    } catch {
      return;
    }
  }
  if (id === undefined || id < 0) return;
  const msg: FocusCardMessage = { type: 'tzx/focus-card' };
  try {
    await chrome.tabs.sendMessage(id, msg);
  } catch {
    /* no content script (browser page, web store): nothing to focus */
  }
}

// The e2e suite cannot press a browser-level command; it calls this instead.
(globalThis as unknown as { tzxFocusCard?: typeof focusCardInTab }).tzxFocusCard = focusCardInTab;

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== FOCUS_COMMAND) return;
  void focusCardInTab(tab?.id);
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!fromThisExtension(sender)) return;
  if (isGetShortcutMessage(msg)) {
    void focusShortcut().then((shortcut) => sendResponse({ shortcut } satisfies ShortcutReply));
    return true;
  }
  if (!isOpenOptionsMessage(msg)) return;
  try {
    openSettings(msg.section === 'formats' ? 'formats' : undefined);
    sendResponse({ ok: true } satisfies Ack);
  } catch {
    sendResponse({ ok: false } satisfies Ack);
  }
});
