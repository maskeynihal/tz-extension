import type { Preferences } from '../types';
import { isValidZone } from './tz';

/**
 * The project's website. The world clock lives there rather than in the
 * extension: one copy of a full-page app to maintain, and a link the user can
 * keep open in a tab, bookmark or share. The extension's popup opens these.
 */
export const SITE_ORIGIN = 'https://tz.nihal.com.np';

/** The full-page world clock. */
export const SITE_CLOCK_URL = `${SITE_ORIGIN}/clock`;

/** The online converter, the same engine the popup runs. */
export const SITE_CONVERTER_URL = `${SITE_ORIGIN}/app`;

/*
 * Handing the user's zones to the website clock
 * ---------------------------------------------
 * The clock used to be an extension page, so it read the same chrome.storage
 * the popup writes. On the website it reads the site origin's localStorage
 * instead, which starts out empty: a user with five zones configured in the
 * extension would click the clock button and get the website's defaults.
 *
 * So the popup hands the preferences over in the link it opens, in the URL
 * *fragment*: fragments are never sent to the server, which is the whole
 * point here — the project promises that nothing about the user's zones
 * leaves their device, and a query string would put them in the request line
 * (and in server and proxy logs). The site entry adopts what it finds and
 * then removes the fragment from the address bar (see site/clock.ts), so the
 * link in the tab is a plain /clock again rather than a frozen snapshot of
 * one moment's settings.
 *
 * Only what the board needs travels, and nothing identifying: the home zone,
 * the target zones and the 12/24-hour clock. Deliberately left out:
 *  - theme: the site has its own control and follows the OS; a visual
 *    preference is not what the user asked to carry over, and silently
 *    repainting the website is a worse surprise than a mismatched theme.
 *  - custom formats, disabled formats, the parser's settings: the clock does
 *    not read any of them, and they are the largest and most personal part of
 *    the preferences. A link should never carry them.
 *
 * Nothing in the fragment is trusted: the site re-validates every zone
 * through isValidZone and then runs the merged result through
 * storage.sanitize, the same clamp a stored blob goes through.
 */

/** Fragment parameter holding the handoff payload. */
export const CLOCK_HANDOFF_PARAM = 'prefs';

/** Payload shape version, so an older site build ignores a newer payload. */
export const CLOCK_HANDOFF_VERSION = 1;

/**
 * Longest fragment the site will even look at. Well above a full payload
 * (about 40 bytes per zone), and a bound on the work a hostile link can ask
 * for before anything is parsed.
 */
export const MAX_HANDOFF_FRAGMENT = 4096;

/** Most target zones carried over; the lists the UI offers are far shorter. */
export const MAX_HANDOFF_ZONES = 32;

/** The preferences the clock link carries, after validation. */
export interface ClockHandoff {
  readonly homeZone?: string;
  readonly targetZones?: readonly string[];
  readonly hour12?: boolean;
}

/** What goes on the wire: short keys, because this is a URL. */
interface HandoffPayload {
  readonly v: number;
  readonly home?: string;
  readonly zones?: readonly string[];
  readonly h12?: boolean;
}

/**
 * The world clock link for these preferences: the site URL plus a fragment
 * the site adopts. Invalid values are left out rather than sent, so a
 * corrupted local preference cannot travel.
 */
export function clockUrlForPreferences(
  prefs: Pick<Preferences, 'homeZone' | 'targetZones' | 'hour12'>,
): string {
  const zones = prefs.targetZones.filter((z) => typeof z === 'string' && isValidZone(z)).slice(0, MAX_HANDOFF_ZONES);
  const payload: HandoffPayload = {
    v: CLOCK_HANDOFF_VERSION,
    ...(typeof prefs.homeZone === 'string' && isValidZone(prefs.homeZone) ? { home: prefs.homeZone } : {}),
    zones,
    ...(typeof prefs.hour12 === 'boolean' ? { h12: prefs.hour12 } : {}),
  };
  const fragment = `${CLOCK_HANDOFF_PARAM}=${encodeURIComponent(JSON.stringify(payload))}`;
  // A payload that somehow grew past what the site reads would be dropped
  // whole; send the bare URL instead, which is the old behaviour.
  if (fragment.length > MAX_HANDOFF_FRAGMENT) return SITE_CLOCK_URL;
  return `${SITE_CLOCK_URL}#${fragment}`;
}

/**
 * The preferences a clock link carries, or null when it carries none that
 * survive validation. Hostile input is the expected case: this runs on
 * whatever a visitor's address bar holds.
 */
export function readClockHandoff(fragment: string): ClockHandoff | null {
  if (typeof fragment !== 'string' || fragment.length === 0 || fragment.length > MAX_HANDOFF_FRAGMENT) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment).get(CLOCK_HANDOFF_PARAM);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // An unknown version is a payload this build does not understand. Ignoring
  // it beats guessing at half of it.
  if (obj.v !== CLOCK_HANDOFF_VERSION) return null;

  const out: { homeZone?: string; targetZones?: readonly string[]; hour12?: boolean } = {};
  if (typeof obj.home === 'string' && isValidZone(obj.home)) out.homeZone = obj.home;
  if (Array.isArray(obj.zones)) {
    const zones = obj.zones.filter((z): z is string => typeof z === 'string' && isValidZone(z)).slice(0, MAX_HANDOFF_ZONES);
    // An explicitly empty list is a real setting (the user cleared it) and is
    // adopted. A list where every entry was garbage is corruption, not
    // intent, so the field is dropped rather than used to wipe the list.
    if (zones.length > 0 || obj.zones.length === 0) out.targetZones = zones;
  }
  if (typeof obj.h12 === 'boolean') out.hour12 = obj.h12;
  return out.homeZone === undefined && out.targetZones === undefined && out.hour12 === undefined ? null : out;
}

/**
 * The same fragment with the handoff parameter taken out, or null when it
 * held none (then the address bar is left exactly as it was: the fragment may
 * be someone else's anchor). An empty string means "no fragment left".
 */
export function stripClockHandoff(fragment: string): string | null {
  if (typeof fragment !== 'string' || fragment.length === 0) return null;
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }
  if (!params.has(CLOCK_HANDOFF_PARAM)) return null;
  params.delete(CLOCK_HANDOFF_PARAM);
  const rest = params.toString();
  return rest.length > 0 ? `#${rest}` : '';
}
