/** Calendar and clock fields as written, in some zone. `mo` is 1-12. */
export interface WallFields {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
}

/**
 * The instant a written wall-clock time names in a zone.
 * - `wallClock: 'gap'`: the clocks jumped forward over this time (it never
 *   happened). It is read with the offset in force just before the jump, so
 *   02:30 on a spring-forward night becomes 03:30 in the new offset. This is
 *   what java.time, Temporal ("compatible") and most calendars do.
 * - `wallClock: 'ambiguous'`: the clocks fell back and this time happened
 *   twice. The earlier of the two instants is used (again like java.time and
 *   Temporal "compatible").
 */
export interface WallInstant {
  readonly epochMs: number;
  readonly wallClock?: 'gap' | 'ambiguous';
}

const DAY_MS = 86_400_000;

/** The fields read as if they were UTC, in ms. Handles years below 100. */
function fieldsAsUtc(w: WallFields): number {
  const d = new Date(Date.UTC(2000, w.mo - 1, w.d, w.h, w.mi, w.s));
  d.setUTCFullYear(w.y);
  return d.getTime();
}

const FIXED = /^(?:UTC|GMT)?([+-])(\d{2}):?(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        era: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null;
    }
    if (formatters.size > 500) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Offset of `tz` from UTC at an instant, in ms (seconds precision, so local
 * mean time offsets such as +05:41:16 stay exact). NaN when the zone is
 * unknown. Read from Intl: date-fns-tz's getTimezoneOffset misreports the
 * hour after a fall-back transition.
 */
function offsetAt(tz: string, ms: number): number {
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Z') return 0;
  const fixed = FIXED.exec(tz);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3])) * 60_000;
  const f = formatter(tz);
  if (!f) return NaN;
  const whole = Math.floor(ms / 1000) * 1000;
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(whole))) parts[p.type] = p.value;
  const year = parts.era === 'BC' || parts.era === 'B' ? 1 - Number(parts.year) : Number(parts.year);
  const wall = fieldsAsUtc({
    y: year,
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
  });
  return wall - whole;
}

/**
 * Resolve wall-clock fields in `tz` (an IANA name or an offset such as
 * "+05:45" or "UTC") to an instant, handling DST gaps and overlaps. Returns
 * null when the zone is unknown or the fields don't give a finite instant.
 */
export function wallFieldsToInstant(w: WallFields, tz: string): WallInstant | null {
  const local = fieldsAsUtc(w);
  if (!Number.isFinite(local)) return null;
  // Offsets a day either side bracket any single transition near this time.
  const before = offsetAt(tz, local - DAY_MS);
  const after = offsetAt(tz, local + DAY_MS);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const valid = Array.from(new Set([before, after]))
    .map((off) => local - off)
    .filter((t) => offsetAt(tz, t) === local - t)
    .sort((a, b) => a - b);
  if (valid.length > 1) return { epochMs: valid[0] as number, wallClock: 'ambiguous' };
  if (valid.length === 1) return { epochMs: valid[0] as number };
  // No offset fits: the time is in a gap. Use the offset from before the jump.
  // (Also covers the rare zone that changed offset twice within two days:
  // fall back to the offset at the written time read as UTC.)
  if (before !== after) return { epochMs: local - before, wallClock: 'gap' };
  const here = offsetAt(tz, local);
  return Number.isFinite(here) ? { epochMs: local - here } : null;
}

/** Offset of `tz` from UTC at an instant, in whole minutes toward zero (NaN when unknown). */
export function offsetMinutes(tz: string, ms: number): number {
  const off = offsetAt(tz, ms);
  return Number.isFinite(off) ? Math.trunc(off / 60_000) : NaN;
}

/** Wall-clock fields of an instant in `tz`, plus the weekday (0 = Sunday). Null when the zone is unknown. */
export function wallFieldsAt(ms: number, tz: string): (WallFields & { readonly weekday: number }) | null {
  const off = offsetAt(tz, ms);
  if (!Number.isFinite(off)) return null;
  // The instant shifted by the offset, read with UTC getters: no host zone involved.
  const d = new Date(Math.floor(ms / 1000) * 1000 + off);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/**
 * English locales tried for a zone's short name. en-US knows the North
 * American names (EDT, PST, HST); en-GB the European ones (BST, CET, CEST);
 * en-AU the Australian and New Zealand ones (AEDT, LHST, NZDT); en-IN IST.
 * Every one of them falls back to "GMT+5:45"-style names.
 */
const ABBR_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN'] as const;
const abbrFormatters = new Map<string, Intl.DateTimeFormat | null>();

function abbrIn(locale: string, tz: string, ms: number): string {
  const key = `${locale}|${tz}`;
  let f = abbrFormatters.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' });
    } catch {
      f = null;
    }
    if (abbrFormatters.size > 2000) abbrFormatters.clear();
    abbrFormatters.set(key, f);
  }
  return f?.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * The short name of `tz` at an instant: a letter abbreviation when any of
 * ABBR_LOCALES has one ("EDT", "BST", "AEDT"), else the GMT-offset form
 * ("GMT+5:45"). Empty when the zone is unknown.
 */
export function zoneAbbreviation(ms: number, tz: string): string {
  let fallback = '';
  for (const locale of ABBR_LOCALES) {
    const name = abbrIn(locale, tz, ms);
    if (/^[A-Z]{2,5}$/.test(name)) return name;
    fallback ||= name;
  }
  return fallback;
}

/** Parse "YYYY-MM-DDTHH:mm[:ss]" into fields; null when it isn't that shape. */
export function parseWallIso(iso: string): WallFields | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!m) return null;
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]!, s: m[6] ? +m[6] : 0 };
}
