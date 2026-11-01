import { fromZonedTime } from 'date-fns-tz';
import type { DateOnlyPolicy, ParsedTime, ParseKind } from '../types';
import { resolveZone } from './tz';

/** The date-fns-tz / Intl argument for any zone id (IANA, UTC±hh:mm, abbr:XXX). */
function tzArg(zone: string): string {
  return resolveZone(zone)?.tz ?? zone;
}

/**
 * Shared building blocks for the built-in and custom format matchers: month
 * names, zone-token resolution, 12/24-hour handling, calendar validation, and
 * turning wall-clock fields into an absolute instant.
 */

/**
 * Common timezone abbreviations -> fixed offset in minutes.
 * These are inherently ambiguous (e.g. "CST" = US Central or China Standard).
 * We resolve to the most common Anglophone-web interpretation and label the
 * result as carrying an explicit (if approximate) offset. DST-specific
 * abbreviations (PDT/EDT) map to their daylight offset.
 */
export const ABBREV_OFFSETS: Readonly<Record<string, number>> = {
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
  // North America (beyond the contiguous US)
  AKST: -9 * 60,
  AKDT: -8 * 60,
  HST: -10 * 60,
  AST: -4 * 60, // Atlantic (ambiguous with Arabia +3)
  ADT: -3 * 60,
  NST: -(3 * 60 + 30),
  NDT: -(2 * 60 + 30),
  // South America
  BRT: -3 * 60,
  // Europe / Africa. (WET, WEST, CAT, EAT and ART are left out: they are
  // everyday words, and reading "12:30 eat" as East Africa Time is worse than
  // not knowing the abbreviation.)
  EET: 2 * 60,
  EEST: 3 * 60,
  MSK: 3 * 60,
  WAT: 1 * 60,
  SAST: 2 * 60,
  // Asia / Pacific
  GST: 4 * 60, // Gulf (ambiguous with South Georgia)
  PKT: 5 * 60,
  NPT: 5 * 60 + 45,
  ICT: 7 * 60,
  WIB: 7 * 60,
  SGT: 8 * 60,
  HKT: 8 * 60,
  PHT: 8 * 60,
  AWST: 8 * 60,
  KST: 9 * 60,
  ACST: 9 * 60 + 30,
  ACDT: 10 * 60 + 30,
  AEST: 10 * 60,
  AEDT: 11 * 60,
  NZST: 12 * 60,
  NZDT: 13 * 60,
};

export const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

/** Month number for an English month name or abbreviation ("Jan", "Sept."), or undefined. */
export function monthFromName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  return MONTHS[name.replace(/\.$/, '').toLowerCase()];
}

/**
 * US generic zone names ("3 PM ET") follow daylight saving, so they map to a
 * real zone rather than a fixed offset.
 */
export const GENERIC_ZONES: Readonly<Record<string, string>> = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles',
};

/** A zone read from text: a fixed offset, or an IANA zone for DST-aware names. */
export interface ResolvedZone {
  /** "+05:45"; absent for an IANA zone. */
  readonly offsetIso?: string;
  /** IANA id for DST-aware names (ET, PT...). */
  readonly iana?: string;
  /** How the popover labels the source zone. */
  readonly label: string;
  /** Minutes east of UTC for fixed offsets, or the IANA id: what todayIn() takes. */
  readonly today: string | number;
}

export function offsetMinutesToIso(mins: number): string {
  const sign = mins < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `${sign}${pad(h)}:${pad(m)}`;
}

/** "+0545" / "+05:45" -> "+05:45"; anything else -> null. */
export function normalizeOffsetToken(tok: string): string | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tok);
  if (!m) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 14 || mi > 59) return null;
  return `${m[1]}${m[2]}:${m[3]}`;
}

/** Minutes east of UTC for a normalized "+hh:mm" offset. */
function offsetIsoToMinutes(iso: string): number {
  const sign = iso.startsWith('-') ? -1 : 1;
  const [h = '0', m = '0'] = iso.slice(1).split(':');
  return sign * (Number(h) * 60 + Number(m));
}

/**
 * Resolve a zone token ("Z", "UTC", "EST", "+05:45", "GMT+5:30", "UTC-8",
 * "ET") to a zone. Returns null for tokens we do not recognize.
 *
 * Letter abbreviations must be written in capitals (UTC and GMT in any case):
 * text is full of short words, and "3pm Art class" is not Argentina time.
 */
export function resolveZoneToken(tok: string | undefined): ResolvedZone | null {
  if (!tok) return null;
  if (tok === 'Z' || tok === 'z') return { offsetIso: '+00:00', label: 'UTC', today: 0 };
  const off = normalizeOffsetToken(tok);
  if (off) return { offsetIso: off, label: off, today: offsetIsoToMinutes(off) };

  // "GMT+5:30", "UTC-8", "GMT+1" — a base abbrev with a signed offset suffix.
  const based = /^(GMT|UTC)([+-]\d{1,2})(?::?(\d{2}))?$/i.exec(tok);
  if (based && based[1] && based[2]) {
    const h = Number(based[2]);
    const m = based[3] ? Number(based[3]) : 0;
    if (Math.abs(h) > 14 || m > 59) return null;
    const mins = h * 60 + (based[2].startsWith('-') ? -m : m);
    return {
      offsetIso: offsetMinutesToIso(mins),
      label: `${based[1].toUpperCase()}${based[2]}${based[3] ? `:${based[3]}` : ''}`,
      today: mins,
    };
  }

  const upper = tok.toUpperCase();
  if (upper === 'UTC' || upper === 'GMT' || upper === 'UT') return { offsetIso: '+00:00', label: upper, today: 0 };
  if (tok !== upper) return null;
  if (upper in GENERIC_ZONES) {
    const iana = GENERIC_ZONES[upper] as string;
    return { iana, label: `${upper} (${iana})`, today: iana };
  }
  if (upper in ABBREV_OFFSETS) {
    const mins = ABBREV_OFFSETS[upper] as number;
    return { offsetIso: offsetMinutesToIso(mins), label: upper, today: mins };
  }
  return null;
}

/** Convert an hour plus optional am/pm marker to 0-23, or null when invalid (e.g. 13pm). */
export function to24h(hour: number, ampm: string | undefined): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!ampm) return hour;
  const isPm = ampm.trim().toLowerCase().startsWith('p');
  if (hour < 1 || hour > 12) return null;
  if (isPm) return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

/** True when y-m-d is a real calendar date (rejects 31 Feb, 31 Apr, ...). */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= dim;
}

/** Calendar date "now" in a zone (or at a fixed UTC offset in minutes). */
export function todayIn(zone: string | number, nowMs: number = Date.now()): { y: number; mo: number; d: number } {
  if (typeof zone === 'number') {
    const t = new Date(nowMs + zone * 60_000);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const fixed = resolveZone(zone)?.minutes;
  if (fixed !== undefined) return todayIn(fixed, nowMs);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tzArg(zone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) return { y, mo, d };
  } catch {
    /* fall through to UTC */
  }
  const t = new Date(nowMs);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Wall-clock components for a date with no time, per the date-only policy. */
export function dateOnlyTime(policy: DateOnlyPolicy, assumedZone: string): { h: number; mi: number; s: number } {
  if (policy === 'now') {
    try {
      const fixed = resolveZone(assumedZone)?.minutes;
      if (fixed !== undefined) {
        const t = new Date(Date.now() + fixed * 60_000);
        return { h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() };
      }
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tzArg(assumedZone),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
      // Some engines render midnight as "24".
      return { h: get('hour') % 24, mi: get('minute'), s: get('second') };
    } catch {
      return { h: 0, mi: 0, s: 0 };
    }
  }
  return { h: 0, mi: 0, s: 0 };
}

/** Wall-clock fields, already validated by the caller. */
export interface WallClock {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
  readonly ms?: number;
}

/** How a matcher identifies itself on the result. */
export interface MatchMeta {
  readonly matchedText: string;
  readonly kind: ParseKind;
  readonly formatId: string;
  readonly formatLabel: string;
  readonly dateOnly?: boolean;
  readonly timeOnly?: boolean;
}

function isoLocal(w: WallClock): string {
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

/**
 * Build a ParsedTime from wall-clock fields. With a zone token the instant is
 * absolute; without one it is interpreted in `assumedZone`. Returns null when
 * the instant cannot be computed.
 */
export function buildParsed(
  w: WallClock,
  zone: ResolvedZone | null,
  assumedZone: string,
  meta: MatchMeta,
): ParsedTime | null {
  if (w.y < 0 || w.y > 9999) return null;
  if (!isRealDate(w.y, w.mo, w.d)) return null;
  if (w.h < 0 || w.h > 23 || w.mi < 0 || w.mi > 59 || w.s < 0 || w.s > 59) return null;
  const extraMs = w.ms !== undefined && Number.isFinite(w.ms) ? w.ms : 0;
  let epochMs: number;
  try {
    if (zone?.offsetIso) epochMs = Date.parse(`${isoLocal(w)}${zone.offsetIso}`);
    else epochMs = fromZonedTime(isoLocal(w), zone?.iana ?? tzArg(assumedZone)).getTime();
  } catch {
    return null;
  }
  if (!Number.isFinite(epochMs)) return null;
  const base: ParsedTime = {
    epochMs: epochMs + extraMs,
    matchedText: meta.matchedText,
    sourceZone: zone ? zone.label : null,
    assumedZone,
    assumed: zone === null,
    kind: meta.kind,
    formatId: meta.formatId,
    formatLabel: meta.formatLabel,
  };
  if (meta.dateOnly) return { ...base, dateOnly: true };
  if (meta.timeOnly) return { ...base, timeOnly: true };
  return base;
}
