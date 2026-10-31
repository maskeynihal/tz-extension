import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { isValidZone } from './tz';
import { BUILTIN_FORMAT_IDS } from './builtin-formats';
import { MAX_ADVANCED_PATTERN } from './custom-formats';

const KEY = 'tz-extension-prefs';

type StorageArea = chrome.storage.StorageArea | undefined;

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.storage !== 'undefined' &&
    (typeof chrome.storage.sync !== 'undefined' ||
      typeof chrome.storage.local !== 'undefined')
  );
}

function area(): StorageArea {
  if (!hasChromeStorage()) return undefined;
  return chrome.storage.sync ?? chrome.storage.local;
}

export const MAX_CUSTOM_FORMATS = 30;
export const MAX_LABEL = 60;

/** A fresh, collision-resistant custom-format id. */
export function newFormatId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `fmt-${rand}`;
}

/** chrome.storage.sync allows 8,192 bytes per item (key + JSON value). */
export const SYNC_ITEM_LIMIT = 8192;

/** Bytes these preferences take as one sync item, counted as UTF-8 to be safe. */
export function syncItemBytes(prefs: Preferences): number {
  return new TextEncoder().encode(KEY + JSON.stringify(sanitize(prefs))).length;
}

/** Outcome of a save, so settings UIs can tell the user when it did not stick. */
export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Clamp any persisted blob back into a valid Preferences object. */
export function sanitize(input: unknown): Preferences {
  const base = DEFAULT_PREFERENCES;
  if (typeof input !== 'object' || input === null) return base;
  const obj = input as Record<string, unknown>;

  const homeZone =
    typeof obj.homeZone === 'string' && isValidZone(obj.homeZone)
      ? obj.homeZone
      : base.homeZone;

  let targetZones = base.targetZones;
  if (Array.isArray(obj.targetZones)) {
    const valid = obj.targetZones.filter(
      (z): z is string => typeof z === 'string' && isValidZone(z),
    );
    // De-dup, keep order. An explicitly empty array is respected (the user
    // cleared the list); only an absent/non-array field falls back to defaults.
    targetZones = Array.from(new Set(valid));
  }

  const hour12 = typeof obj.hour12 === 'boolean' ? obj.hour12 : base.hour12;

  const dateOnlyPolicy =
    obj.dateOnlyPolicy === 'now' || obj.dateOnlyPolicy === 'midnight'
      ? obj.dateOnlyPolicy
      : base.dateOnlyPolicy;

  const keepSelection =
    typeof obj.keepSelection === 'boolean' ? obj.keepSelection : base.keepSelection;

  const theme =
    obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system'
      ? obj.theme
      : base.theme;

  let customFormats = base.customFormats;
  if (Array.isArray(obj.customFormats)) {
    const ids = new Set<string>();
    customFormats = obj.customFormats
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => {
        let id = typeof f.id === 'string' && f.id ? f.id.slice(0, 40) : newFormatId();
        // Ids key edits and deletes, so they must be unique.
        while (ids.has(id)) id = newFormatId();
        ids.add(id);
        return {
          id,
          label: typeof f.label === 'string' ? f.label.slice(0, MAX_LABEL) : 'Custom',
          pattern: typeof f.pattern === 'string' ? f.pattern.slice(0, MAX_ADVANCED_PATTERN) : '',
          advanced: typeof f.advanced === 'boolean' ? f.advanced : false,
          enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
        };
      })
      .filter((f) => f.pattern.length > 0)
      .slice(0, MAX_CUSTOM_FORMATS);
  }

  let disabledFormats = base.disabledFormats;
  if (Array.isArray(obj.disabledFormats)) {
    disabledFormats = Array.from(
      new Set(
        obj.disabledFormats.filter(
          (id): id is string => typeof id === 'string' && BUILTIN_FORMAT_IDS.includes(id),
        ),
      ),
    );
  }

  const selectToConvert =
    typeof obj.selectToConvert === 'boolean' ? obj.selectToConvert : base.selectToConvert;

  return {
    homeZone,
    targetZones,
    hour12,
    dateOnlyPolicy,
    keepSelection,
    theme,
    customFormats,
    disabledFormats,
    selectToConvert,
  };
}

export async function loadPreferences(): Promise<Preferences> {
  const a = area();
  if (!a) return DEFAULT_PREFERENCES;
  try {
    const got = await a.get(KEY);
    return sanitize(got?.[KEY]);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Persist preferences. Never throws: a failure (sync quota, restricted
 * context) resolves to `{ ok: false, error }` and the caller keeps its
 * in-memory copy.
 */
export async function savePreferences(prefs: Preferences): Promise<SaveResult> {
  const a = area();
  if (!a) return { ok: true };
  try {
    await a.set({ [KEY]: sanitize(prefs) });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/quota/i.test(msg)) {
      return {
        ok: false,
        error:
          'Settings are too large for browser sync storage. Remove some custom formats or shorten their labels, then try again.',
      };
    }
    return { ok: false, error: `Could not save settings: ${msg}` };
  }
}

/** Subscribe to external changes (other tabs/windows). Returns an unsubscribe fn. */
export function onPreferencesChanged(cb: (prefs: Preferences) => void): () => void {
  if (!hasChromeStorage() || typeof chrome.storage.onChanged === 'undefined') {
    return () => {};
  }
  const listener = (
    changes: { [k: string]: chrome.storage.StorageChange },
    _areaName: string,
  ): void => {
    if (KEY in changes) {
      cb(sanitize(changes[KEY]?.newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
