import { loadPreferences, savePreferences } from '../lib/storage';

// On install/update, normalize any stored preferences (seeds defaults when empty).
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      const prefs = await loadPreferences();
      await savePreferences(prefs);
    } catch {
      /* storage may be unavailable in some contexts; defaults apply at read time */
    }
  })();
});
