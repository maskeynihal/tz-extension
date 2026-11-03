import { ACCESS_DISMISSED_KEY, loadAccessDismissed } from '../popup/access-dismissal';

/**
 * Telling the user that site access is missing, without waiting for them to
 * open the popup.
 *
 * A page cannot ask for itself: without host access the content script never
 * loads there, so nothing on the page sees the selection. Only an extension
 * page can call `permissions.request`, and only from a click. So the worker
 * does the two things it can do on its own:
 *  - on a fresh install with access withheld (every sideloaded Firefox
 *    add-on: it gets no install prompt, so no host permission), open the
 *    settings page, whose banner holds the one-click grant;
 *  - while access is withheld, mark the toolbar icon, so an extension that
 *    reads nothing does not just look broken.
 * The badge follows the banner's "Don't show again": a user who allowed a few
 * sites on purpose and said so is not nagged from the toolbar either.
 */

const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/** Where the settings page keeps the banner (Options renders `#access`). */
export const ACCESS_SECTION = 'access';

const BADGE_TEXT = '!';
const BADGE_COLOR = '#d97706';
const DEFAULT_TITLE = 'TZ Converter';
const WITHHELD_TITLE = 'TZ Converter — allow site access to convert times on pages';

/** True when every site is granted; null when the browser would not say. */
export async function hasAllSites(): Promise<boolean | null> {
  try {
    if (typeof chrome.permissions?.contains !== 'function') return null;
    return await chrome.permissions.contains(ALL_URLS);
  } catch {
    return null;
  }
}

/** Mark the toolbar icon while access is withheld and not dismissed; clear it otherwise. */
export async function refreshAccessBadge(): Promise<void> {
  const action = chrome.action;
  if (typeof action?.setBadgeText !== 'function') return;
  const all = await hasAllSites();
  // Unknown is not withheld: say nothing rather than nag.
  const flag = all === false && !(await loadAccessDismissed());
  try {
    await action.setBadgeText({ text: flag ? BADGE_TEXT : '' });
    if (flag) await action.setBadgeBackgroundColor?.({ color: BADGE_COLOR });
    await action.setTitle?.({ title: flag ? WITHHELD_TITLE : DEFAULT_TITLE });
  } catch {
    /* badge unavailable in this context */
  }
}

/**
 * On a first install only: an update or a browser restart must not reopen a
 * tab the user already saw and chose to ignore.
 */
export async function openGrantPageIfWithheld(reason: string | undefined): Promise<void> {
  if (reason !== 'install') return;
  if ((await hasAllSites()) !== false) return;
  const page = chrome.runtime.getManifest().options_page;
  if (!page || typeof chrome.tabs?.create !== 'function') return;
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`${page}#${ACCESS_SECTION}`) });
  } catch {
    /* no tab to open; the badge still says it */
  }
}

/** Keep the badge true to grants, revokes and the banner's dismissal. */
export function watchAccess(): void {
  chrome.permissions?.onAdded?.addListener(() => void refreshAccessBadge());
  chrome.permissions?.onRemoved?.addListener(() => void refreshAccessBadge());
  chrome.storage?.onChanged?.addListener((changes) => {
    if (ACCESS_DISMISSED_KEY in changes) void refreshAccessBadge();
  });
}
