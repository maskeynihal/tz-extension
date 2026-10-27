import { fromZonedTime } from 'date-fns-tz';
import type { ParsedTime, ParseKind } from '../types';
import { parseEpoch } from './epoch';

/**
 * Common timezone abbreviations -> fixed offset in minutes.
 * These are inherently ambiguous (e.g. "CST" = US Central or China Standard).
 * We resolve to the most common Anglophone-web interpretation and label the
 * result as carrying an explicit (if approximate) offset. DST-specific
 * abbreviations (PDT/EDT) map to their daylight offset.
 */
const ABBREV_OFFSETS: Readonly<Record<string, number>> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60, // US Central (ambiguous with China +8 / Cuba)
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
  BST: 1 * 60, // British Summer (ambiguous with Bangladesh)
  CET: 1 * 60,
  CEST: 2 * 60,
  IST: 5 * 60 + 30, // India (ambiguous with Israel/Irish)
  JST: 9 * 60,
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

function offsetMinutesToIso(mins: number): string {
  const sign = mins < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `${sign}${pad(h)}:${pad(m)}`;
}

/** Build a ParsedTime from an instant known to be absolute (had a zone/offset). */
function zoned(
  epochMs: number,
  matchedText: string,
  sourceZone: string,
  assumedZone: string,
  kind: ParseKind,
): ParsedTime {
  return { epochMs, matchedText, sourceZone, assumedZone, assumed: false, kind };
}

/** Build a ParsedTime for a value that had NO zone, assumed in `assumedZone`. */
function assumedIn(
  isoLocal: string,
  matchedText: string,
  assumedZone: string,
  kind: ParseKind,
): ParsedTime | null {
  try {
    const d = fromZonedTime(isoLocal, assumedZone);
    const epochMs = d.getTime();
    if (!Number.isFinite(epochMs)) return null;
    return {
      epochMs,
      matchedText,
      sourceZone: null,
      assumedZone,
      assumed: true,
      kind,
    };
  } catch {
    return null;
  }
}

// --- Regex building blocks -------------------------------------------------

const RE_ISO =
  /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?/;

const RE_DATE_SLASH =
  /\b(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\b/;

// "Jan 2 2024 3:00 PM", "2 Jan 2024 15:00", "January 2, 2024 3:00pm"
// Two orders: [day] Month [day] year. Exactly one of the two day positions is
// present; the month name disambiguates. The year is anchored to 4 digits so a
// day number cannot absorb part of the year.
const RE_RFC =
  /\b(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:,)?\s+)?(\d{4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?)?(?:[ \t]+([A-Za-z]{2,5}|[+-]\d{2}:?\d{2}))?/;

// bare time: "3pm", "15:04", "3:30 PM UTC", "9:00 +05:45"
// am/pm may hug the number ("3pm") or follow a space ("3 pm"); an optional
// trailing zone token is separated by whitespace. Using [ \t]* for the am/pm
// separator and requiring [ \t]+ before the zone keeps both captures reachable.
const RE_TIME =
  /\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?(?:[ \t]+([A-Za-z]{2,5}|[+-]\d{2}:?\d{2}))?\b/;

function normalizeOffsetToken(tok: string): string | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tok);
  if (!m) return null;
  return `${m[1]}${m[2]}:${m[3]}`;
}

function resolveZoneToken(tok: string | undefined): { offsetIso: string; label: string } | null {
  if (!tok) return null;
  const off = normalizeOffsetToken(tok);
  if (off) return { offsetIso: off, label: off };
  const upper = tok.toUpperCase();
  if (upper in ABBREV_OFFSETS) {
    const mins = ABBREV_OFFSETS[upper] as number;
    return { offsetIso: offsetMinutesToIso(mins), label: upper };
  }
  return null;
}

function to24h(hour: number, ampm: string | undefined): number | null {
  if (hour < 0 || hour > 23) return null;
  if (!ampm) return hour;
  const isPm = ampm.toLowerCase() === 'pm';
  if (hour < 1 || hour > 12) return null; // 13pm invalid
  if (isPm) return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour; // 12am -> 00
}

/**
 * Parse a free-text string into recognized times. Returns all matches found,
 * in document order. The caller typically shows the first.
 *
 * @param text       The selected text.
 * @param assumedZone Zone to assume for values with no explicit zone/offset.
 */
export function parseTimes(text: string, assumedZone: string): ParsedTime[] {
  const results: ParsedTime[] = [];
  const src = text.trim();
  if (src.length === 0) return results;

  // 1) Epoch: a lone 10- or 13-digit integer (optionally the whole selection).
  const epochMatch = /\b(-?\d{10,13})\b/.exec(src);
  if (epochMatch && epochMatch[1]) {
    const ep = parseEpoch(epochMatch[1]);
    if (ep) {
      results.push({
        epochMs: ep.epochMs,
        matchedText: epochMatch[1],
        sourceZone: 'UTC',
        assumedZone,
        assumed: false,
        kind: ep.unit === 'seconds' ? 'epoch-seconds' : 'epoch-millis',
      });
    }
  }

  // 2) ISO-8601.
  const iso = RE_ISO.exec(src);
  if (iso) {
    const [, y, mo, d, h, mi, s, zone] = iso;
    const sec = s ?? '00';
    const base = `${y}-${mo}-${d}T${h}:${mi}:${sec}`;
    if (zone) {
      const off = zone === 'Z' ? '+00:00' : normalizeOffsetToken(zone.replace(':', '').replace(/(\d{2})(\d{2})$/, '$1:$2')) ?? '+00:00';
      const epochMs = Date.parse(`${base}${off}`);
      if (Number.isFinite(epochMs)) {
        results.push(zoned(epochMs, iso[0], off === '+00:00' && zone === 'Z' ? 'UTC' : off, assumedZone, 'iso'));
      }
    } else {
      const r = assumedIn(base, iso[0], assumedZone, 'iso-no-tz');
      if (r) results.push(r);
    }
  }

  // 3) yyyy/mm/dd hh:mm (no zone).
  const slash = RE_DATE_SLASH.exec(src);
  if (slash) {
    const [, y, mo, d, h, mi, s] = slash;
    const base = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}`;
    const r = assumedIn(base, slash[0], assumedZone, 'datetime-no-tz');
    if (r) results.push(r);
  }

  // 4) RFC-like "Jan 2 2024 3:00 PM TZ".
  const rfc = RE_RFC.exec(src);
  if (rfc) {
    const dayA = rfc[1];
    const monTok = rfc[2];
    const dayB = rfc[3];
    const year = rfc[4];
    const hh = rfc[5];
    const mm = rfc[6];
    const ss = rfc[7];
    const ampm = rfc[8];
    const zoneTok = rfc[9];
    const monKey = (monTok ?? '').toLowerCase();
    if (monKey in MONTHS && year) {
      const month = MONTHS[monKey] as number;
      const day = Number(dayA ?? dayB);
      if (day >= 1 && day <= 31) {
        const hour = hh !== undefined ? to24h(Number(hh), ampm) : 0;
        if (hour !== null) {
          const base = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(Number(mm ?? 0))}:${pad(Number(ss ?? 0))}`;
          const zr = resolveZoneToken(zoneTok);
          if (zr) {
            const epochMs = Date.parse(`${base}${zr.offsetIso}`);
            if (Number.isFinite(epochMs)) results.push(zoned(epochMs, rfc[0], zr.label, assumedZone, 'rfc-like'));
          } else {
            const r = assumedIn(base, rfc[0], assumedZone, 'rfc-like');
            if (r) results.push(r);
          }
        }
      }
    }
  }

  // 5) Bare time-of-day, only if we have nothing better yet (avoid matching
  //    the day/second fields of an already-parsed datetime).
  if (results.length === 0) {
    const t = RE_TIME.exec(src);
    if (t && t[1] !== undefined) {
      const hour = to24h(Number(t[1]), t[4]);
      const min = t[2] !== undefined ? Number(t[2]) : 0;
      const sec = t[3] !== undefined ? Number(t[3]) : 0;
      // Require either an am/pm marker, a colon, or a zone token; a lone small
      // integer like "5" is not a time.
      const hasSignal = Boolean(t[4] || t[2] !== undefined || t[5]);
      if (hour !== null && min >= 0 && min < 60 && sec >= 0 && sec < 60 && hasSignal) {
        // Anchor to "today" in the assumed zone.
        const now = new Date();
        const yr = now.getFullYear();
        const mo = pad(now.getMonth() + 1);
        const dy = pad(now.getDate());
        const base = `${yr}-${mo}-${dy}T${pad(hour)}:${pad(min)}:${pad(sec)}`;
        const zr = resolveZoneToken(t[5]);
        if (zr) {
          const epochMs = Date.parse(`${base}${zr.offsetIso}`);
          if (Number.isFinite(epochMs)) results.push(zoned(epochMs, t[0].trim(), zr.label, assumedZone, 'offset'));
        } else {
          const r = assumedIn(base, t[0].trim(), assumedZone, 'time-of-day');
          if (r) results.push(r);
        }
      }
    }
  }

  // De-duplicate by (epochMs, matchedText).
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.epochMs}:${r.matchedText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
