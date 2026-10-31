import { loadPreferences, savePreferences } from '../lib/storage';
import {
  MAX_MESSAGE_TEXT,
  fromThisExtension,
  isOpenOptionsMessage,
  type Ack,
  type ConvertSelectionMessage,
} from '../lib/messages';

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

/** Open settings; with a section, open a tab scrolled to it (openOptionsPage takes no anchor). */
function openSettings(section: string | undefined): void {
  const page = chrome.runtime.getManifest().options_page;
  if (section && page && typeof chrome.tabs?.create === 'function') {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`${page}#${encodeURIComponent(section)}`) });
    return;
  }
  void chrome.runtime.openOptionsPage();
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!fromThisExtension(sender) || !isOpenOptionsMessage(msg)) return;
  try {
    openSettings(msg.section === 'formats' ? 'formats' : undefined);
    sendResponse({ ok: true } satisfies Ack);
  } catch {
    sendResponse({ ok: false } satisfies Ack);
  }
});
