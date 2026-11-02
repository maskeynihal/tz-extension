import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { loadPreferences, onPreferencesChanged, sanitize, savePreferences } from './storage';

/** How long a write waits for its echo before it is no longer expected. */
export const ECHO_TTL_MS = 10_000;

export interface SyncedPreferences {
  readonly prefs: Preferences;
  /** True once the stored preferences have been read. */
  readonly loaded: boolean;
  /** Why the last save failed, or null. */
  readonly saveError: string | null;
  /** Show `next` now and save it. On a failed save, go back to what is stored. */
  readonly update: (next: Preferences) => void;
}

/**
 * Preferences kept in step with storage, for pages that edit them (Settings,
 * the toolbar popup).
 *
 * Our own writes echo back through storage.onChanged, often late. Applying a
 * late echo would put an older value back on screen: two quick reorders show
 * the second, then jump back to the first. So the writes that have not echoed
 * yet are kept in order, and exactly those echoes are skipped. Anything else
 * is a change made elsewhere (another page, the in-page card, another device)
 * and is applied. Entries expire in case the browser drops an echo.
 */
export function useSyncedPreferences(): SyncedPreferences {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inFlight = useRef<Array<{ key: string; at: number }>>([]);
  const prefsKey = useRef<string>('');

  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (alive) {
        prefsKey.current = JSON.stringify(p);
        setPrefs(p);
        setLoaded(true);
      }
    });
    const unsub = onPreferencesChanged((p) => {
      if (!alive) return;
      const key = JSON.stringify(p);
      const now = Date.now();
      inFlight.current = inFlight.current.filter((w) => now - w.at < ECHO_TTL_MS);
      const i = inFlight.current.findIndex((w) => w.key === key);
      if (i >= 0) {
        inFlight.current.splice(0, i + 1);
        // Our own write landed last: if something else was shown meanwhile,
        // storage now holds ours, so show it.
        if (inFlight.current.length === 0 && key !== prefsKey.current) {
          prefsKey.current = key;
          setPrefs(p);
        }
        return;
      }
      prefsKey.current = key;
      setPrefs(p);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  function update(next: Preferences): void {
    const key = JSON.stringify(sanitize(next));
    setPrefs(next);
    // The browser only reports real changes, so an unchanged write never echoes.
    if (key !== prefsKey.current) inFlight.current.push({ key, at: Date.now() });
    prefsKey.current = key;
    void savePreferences(next).then((r) => {
      if (r.ok) {
        setSaveError(null);
        return;
      }
      // Not saved: say why, and go back to what is actually stored so the
      // page never claims a setting that the extension is not using.
      setSaveError(r.error);
      inFlight.current = inFlight.current.filter((w) => w.key !== key);
      void loadPreferences().then((p) => {
        prefsKey.current = JSON.stringify(p);
        setPrefs(p);
      });
    });
  }

  return { prefs, loaded, saveError, update };
}
