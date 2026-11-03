/**
 * Whether the user has told the site-access banner to stop asking.
 *
 * Kept in its own storage item rather than in `Preferences`: it is not a
 * setting the rest of the extension reads, and the preferences item is
 * already split in two for cross-version sync (see src/lib/storage.ts), where
 * every added field costs bytes against the 8 KB per-item sync limit. Sync
 * storage when available, so dismissing it on one device dismisses it on the
 * others — the browser's site-access setting is per device, but "stop telling
 * me" is about the person, not the machine.
 */
export const ACCESS_DISMISSED_KEY = 'tz-extension-access-banner';

interface Area {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** sync, else local, else nothing (the website build and jsdom). */
function area(): Area | undefined {
  try {
    if (typeof chrome === 'undefined' || typeof chrome.storage === 'undefined') return undefined;
    const a = (chrome.storage.sync ?? chrome.storage.local) as unknown as Area | undefined;
    return a && typeof a.get === 'function' && typeof a.set === 'function' ? a : undefined;
  } catch {
    return undefined;
  }
}

/** True when the banner has been dismissed. Never throws; false when unreadable. */
export async function loadAccessDismissed(): Promise<boolean> {
  const a = area();
  if (!a) return false;
  try {
    const got = await a.get(ACCESS_DISMISSED_KEY);
    const v = got?.[ACCESS_DISMISSED_KEY];
    return typeof v === 'object' && v !== null && (v as { dismissed?: unknown }).dismissed === true;
  } catch {
    return false;
  }
}

/** Remember the answer. Never throws: a failed write only costs the dismissal. */
export async function saveAccessDismissed(dismissed: boolean): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [ACCESS_DISMISSED_KEY]: { dismissed } });
  } catch {
    /* nothing else to do: the banner reappears next time */
  }
}
