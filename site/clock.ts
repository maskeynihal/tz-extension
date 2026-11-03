// Website entry for the world clock (clock.html). Same React app as the
// extension page; the only difference is that settings live in this site's
// localStorage, which the website has to opt in to explicitly.
import { enableWebStorageBackend, loadPreferences, sanitize, savePreferences } from '../src/lib/storage';
import { readClockHandoff, stripClockHandoff } from '../src/lib/site';
import { mountClock } from '../src/clock/mount';

enableWebStorageBackend();

/**
 * Adopt the zones the extension's popup handed over in the URL fragment (see
 * the handoff notes in src/lib/site.ts), before anything renders, so the
 * board comes up on the user's zones rather than flashing the site defaults.
 *
 * The fields the link carries win over what this origin had saved: the user
 * pressed the clock button in the extension, so the extension's current
 * settings are the intent at that moment. Everything the link does not carry
 * (theme, and the converter's own settings) is left alone. The merged result
 * goes through the same sanitize a stored blob does, so a link can only ever
 * produce preferences the app could have saved itself.
 *
 * Then the parameter comes out of the address bar. Nothing was sent to the
 * server — fragments never are — and a copied link should be the live clock,
 * not a snapshot of one moment's settings. Clearing it also means a reload
 * does not re-apply zones the user has since changed here.
 */
async function adoptHandoff(): Promise<void> {
  if (typeof location === 'undefined') return;
  const hash = location.hash;
  const handoff = readClockHandoff(hash);
  const rest = stripClockHandoff(hash);
  if (rest !== null && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}${rest}`);
    } catch {
      /* some embeddings refuse replaceState; the fragment is harmless */
    }
  }
  if (!handoff) return;
  const current = await loadPreferences();
  await savePreferences(sanitize({ ...current, ...handoff }));
}

// Mount either way: a failed handoff must still leave a working clock.
void adoptHandoff().then(mountClock, mountClock);
