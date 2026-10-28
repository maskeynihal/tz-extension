import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { isValidZone } from './tz';

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
    customFormats = obj.customFormats
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => ({
        id: typeof f.id === 'string' && f.id ? f.id : `fmt-${Math.random().toString(36).slice(2, 9)}`,
        label: typeof f.label === 'string' ? f.label.slice(0, 80) : 'Custom',
        pattern: typeof f.pattern === 'string' ? f.pattern.slice(0, 300) : '',
        advanced: typeof f.advanced === 'boolean' ? f.advanced : false,
        enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
      }))
      .filter((f) => f.pattern.length > 0)
      .slice(0, 50);
  }

  return { homeZone, targetZones, hour12, dateOnlyPolicy, keepSelection, theme, customFormats };
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

export async function savePreferences(prefs: Preferences): Promise<void> {
  const a = area();
  if (!a) return;
  try {
    await a.set({ [KEY]: sanitize(prefs) });
  } catch {
    /* restricted page / quota — no-op, UI keeps in-memory copy */
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
