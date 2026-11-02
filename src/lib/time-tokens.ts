import type { DateOnlyPolicy, ParsedTime, ParseKind } from '../types';
import { resolveZone } from './tz';
import { wallFieldsToInstant } from './wallclock';

/** The Intl time zone argument for any zone id (IANA, UTC±hh:mm, abbr:XXX). */
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
  // German names for the European zones (MEZ = Mitteleuropäische Zeit).
  MEZ: 1 * 60,
  MESZ: 2 * 60,
  WEZ: 0,
  WESZ: 1 * 60,
  OEZ: 2 * 60,
  OESZ: 3 * 60,
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
  CHAST: 12 * 60 + 45,
  CHADT: 13 * 60 + 45,
  BDT: 6 * 60, // Bangladesh (the zone list's BDT)
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

/** Lower-case, accent-free form of a word, without a trailing dot: "März." -> "marz". */
export function normalizeWord(w: string): string {
  return w
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

/**
 * Month names and abbreviations in German, French, Spanish, Italian,
 * Portuguese and Dutch, keyed by normalizeWord() (English is in MONTHS).
 */
const LOCAL_MONTHS: Readonly<Record<string, number>> = {
  // German
  januar: 1, janner: 1, februar: 2, marz: 3, mrz: 3, mai: 5, juni: 6, juli: 7,
  oktober: 10, okt: 10, dezember: 12, dez: 12,
  // French
  janvier: 1, janv: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, avril: 4, avr: 4, juin: 6,
  juillet: 7, juil: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  // Spanish
  enero: 1, ene: 1, febrero: 2, marzo: 3, abril: 4, abr: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, ago: 8, septiembre: 9, setiembre: 9, set: 9, octubre: 10, noviembre: 11,
  diciembre: 12, dic: 12,
  // Italian
  gennaio: 1, gen: 1, febbraio: 2, aprile: 4, maggio: 5, mag: 5, giugno: 6, giu: 6,
  luglio: 7, lug: 7, settembre: 9, ottobre: 10, ott: 10, dicembre: 12,
  // Portuguese
  janeiro: 1, fevereiro: 2, marco: 3, maio: 5, junho: 6, julho: 7, setembro: 9,
  outubro: 10, out: 10, novembro: 11, dezembro: 12,
  // Dutch
  januari: 1, februari: 2, maart: 3, mrt: 3, mei: 5, augustus: 8,
};

/** Abbreviations that are also everyday English words: only a capitalized form counts. */
const WORDLIKE_MONTHS = new Set(['set', 'out', 'ago', 'gen', 'mag', 'lug']);

/**
 * Month number for a month name in English, German, French, Spanish,
 * Italian, Portuguese or Dutch, ignoring case and accents ("März", "marz",
 * "Mrz.", "févr", "março"). Abbreviations that are English words ("set",
 * "out") count only when capitalized.
 */
export function monthFromLocalName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const key = normalizeWord(name);
  const n = MONTHS[key] ?? LOCAL_MONTHS[key];
  if (n === undefined) return undefined;
  if (WORDLIKE_MONTHS.has(key) && !/^[A-ZÀ-Þ]/.test(name)) return undefined;
  return n;
}

/** Weekday names (1 = Monday) in the same languages, keyed by normalizeWord(). */
const WEEKDAYS: Readonly<Record<string, number>> = {
  // English
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4,
  thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
  // German
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6, sonntag: 7,
  // French
  lundi: 1, lun: 1, mardi: 2, mercredi: 3, mer: 3, jeudi: 4, jeu: 4, vendredi: 5, ven: 5,
  samedi: 6, sam: 6, dimanche: 7, dim: 7,
  // Spanish
  lunes: 1, martes: 2, miercoles: 3, mie: 3, jueves: 4, jue: 4, viernes: 5, vie: 5, sabado: 6,
  sab: 6, domingo: 7, dom: 7,
  // Italian
  lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, gio: 4, venerdi: 5, domenica: 7,
  // Portuguese
  'segunda-feira': 1, segunda: 1, seg: 1, 'terca-feira': 2, terca: 2, ter: 2, 'quarta-feira': 3,
  quarta: 3, qua: 3, 'quinta-feira': 4, quinta: 4, qui: 4, 'sexta-feira': 5, sexta: 5, sex: 5,
  // Dutch
  maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7,
  // Shared abbreviations
  mar: 2,
};

/** True for a weekday name or abbreviation in any of the supported languages. */
export function isWeekdayName(name: string | undefined): boolean {
  return Boolean(name && WEEKDAYS[normalizeWord(name)] !== undefined);
}

/** Two-digit year: 70–99 -> 19xx, otherwise 20xx. */
export function expandYear(yy: string): number {
  const n = Number(yy);
  if (yy.length !== 2) return n;
  return n >= 70 ? 1900 + n : 2000 + n;
}

/** Japanese eras since 1868: name, Gregorian year of year 1, and the first day [y, m, d]. */
const JAPANESE_ERAS: Readonly<Record<string, { readonly first: number; readonly start: readonly [number, number, number] }>> = {
  明治: { first: 1868, start: [1868, 1, 1] },
  大正: { first: 1912, start: [1912, 7, 30] },
  昭和: { first: 1926, start: [1926, 12, 25] },
  平成: { first: 1989, start: [1989, 1, 8] },
  令和: { first: 2019, start: [2019, 5, 1] },
};
const ERA_ORDER = ['明治', '大正', '昭和', '平成', '令和'];

/**
 * Gregorian year of a Japanese era date ("平成11年3月22日" -> 1999; 元年 is
 * year 1), or null when the date falls outside that era (昭和64年1月8日 is
 * already 平成). Meiji dates before the 1873 calendar reform are taken as
 * Gregorian.
 */
export function japaneseEraYear(era: string, eraYear: string, mo: number, d: number): number | null {
  const e = JAPANESE_ERAS[era];
  if (!e) return null;
  const n = eraYear === '元' ? 1 : Number(eraYear);
  if (!Number.isInteger(n) || n < 1) return null;
  const y = e.first + n - 1;
  const key = y * 10_000 + mo * 100 + d;
  const [sy, sm, sd] = e.start;
  if (key < sy * 10_000 + sm * 100 + sd) return null;
  const next = JAPANESE_ERAS[ERA_ORDER[ERA_ORDER.indexOf(era) + 1] ?? ''];
  if (next) {
    const [ny, nm, nd] = next.start;
    if (key >= ny * 10_000 + nm * 100 + nd) return null;
  }
  return y;
}

/** Calendar date of an ISO 8601 ordinal date (1999-081), or null when out of range. */
export function ordinalDate(year: number, dayOfYear: number): { y: number; mo: number; d: number } | null {
  const days = isRealDate(year, 2, 29) ? 366 : 365;
  if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > days) return null;
  const t = new Date(Date.UTC(year, 0, dayOfYear));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Monday of ISO week 1 (the week holding 4 January), as UTC ms. */
function isoWeekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  return jan4 - dow * 86_400_000;
}

/**
 * Calendar date of an ISO 8601 week date (1999-W13-2: Tuesday of week 13),
 * or null when the week does not exist in that year. Weeks start on Monday
 * (day 1) and week 1 is the week with the year's first Thursday.
 */
export function isoWeekDate(year: number, week: number, day: number): { y: number; mo: number; d: number } | null {
  if (!Number.isInteger(week) || !Number.isInteger(day) || day < 1 || day > 7 || week < 1) return null;
  const start = isoWeekOneMonday(year);
  const weeks = Math.round((isoWeekOneMonday(year + 1) - start) / (7 * 86_400_000));
  if (week > weeks) return null;
  const t = new Date(start + ((week - 1) * 7 + (day - 1)) * 86_400_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
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
  AKT: 'America/Anchorage',
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

/**
 * Replace the typographic minus signs an offset may be written with by an
 * ASCII hyphen-minus: U+2212 ("UTC−05:00", "10:00 −0500") anywhere, and an
 * en dash only straight after GMT/UTC ("GMT–5"), since an en dash elsewhere
 * is a range ("10:00–11:00"). Each replaced character is one UTF-16 unit, as
 * is "-", so indexes and lengths in the result match the original text.
 */
export function normalizeSigns(text: string): string {
  if (!/[\u2212\u2013]/.test(text)) return text;
  return text.replace(/\u2212/g, '-').replace(/(?<=(?:GMT|UTC))\u2013(?=\d)/gi, '-');
}

/**
 * Spaces other than U+0020 that pages and formatters put between a time and
 * its zone or AM/PM: no-break (U+00A0, "13:30&nbsp;UTC"), narrow no-break
 * (U+202F, which CLDR 42+ puts before AM/PM: "1:30 PM"), the U+2000–U+200A
 * spaces (thin U+2009, figure U+2007, hair U+200A...), U+205F and the
 * ideographic space U+3000.
 */
const ODD_SPACE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;
const ODD_SPACES = new RegExp(ODD_SPACE.source, 'g');

/**
 * Replace the spaces in ODD_SPACE by U+0020, so formats that read `[ \t]`
 * see them as spaces. One UTF-16 unit for one, so indexes and lengths in the
 * result match the original text (as in normalizeSigns).
 */
export function normalizeSpaces(text: string): string {
  return ODD_SPACE.test(text) ? text.replace(ODD_SPACES, ' ') : text;
}

/** What every format reads: ASCII minus signs and plain spaces, same length as `text`. */
export function normalizeForMatching(text: string): string {
  return normalizeSpaces(normalizeSigns(text));
}

/** "+0545" / "+05:45" -> "+05:45"; anything else -> null. */
export function normalizeOffsetToken(tok: string): string | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(normalizeSigns(tok));
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
export function resolveZoneToken(raw: string | undefined): ResolvedZone | null {
  if (!raw) return null;
  // "UTC−5" (U+2212) and "GMT–5" (en dash) read like "UTC-5".
  const tok = normalizeSigns(raw);
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

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * One year/month/day formatter per zone. Creating an Intl.DateTimeFormat
 * costs far more than using one, and every bare time ("10:00") asks for
 * today's date. Throws for an unknown zone, as the constructor does.
 */
function dateFormatter(zone: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tzArg(zone), year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dateFormatters.size > 200) dateFormatters.clear();
    dateFormatters.set(zone, f);
  }
  return f;
}

let lastToday: { zone: string; second: number; date: { y: number; mo: number; d: number } } | null = null;

/** Calendar date "now" in a zone (or at a fixed UTC offset in minutes). */
export function todayIn(zone: string | number, nowMs: number = Date.now()): { y: number; mo: number; d: number } {
  if (typeof zone === 'number') {
    const t = new Date(nowMs + zone * 60_000);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const fixed = resolveZone(zone)?.minutes;
  if (fixed !== undefined) return todayIn(fixed, nowMs);
  // A parse asks this for every bare time; the date only changes at midnight.
  const second = Math.floor(nowMs / 1000);
  if (lastToday && lastToday.zone === zone && lastToday.second === second) return { ...lastToday.date };
  try {
    const parts = dateFormatter(zone).formatToParts(new Date(nowMs));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
      lastToday = { zone, second, date: { y, mo, d } };
      return { y, mo, d };
    }
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
 * The earliest year a written date may have. A page never means year 0 or
 * 999 by "0000-01-01"; Date would also render such years with nonsense
 * offsets. Epoch values have their own bounds (epoch.ts).
 */
export const MIN_YEAR = 1000;

/**
 * Fold the two ISO 8601 clock values JS has no direct form for:
 * - 24:00[:00] is the end of the day, i.e. 00:00 of the next one (only with
 *   minutes, seconds and fraction all zero);
 * - a leap second, :60, reads as :59.999 so the date and minute stay as
 *   written. Whether :60 can be real depends on the zone, so buildParsed
 *   checks it (`leap`) once the instant is known.
 * Returns null when the fields are not a valid clock time.
 */
function normalizeClock(w: WallClock): { fields: WallClock; extraMs: number; leap?: true } | null {
  const extraMs = w.ms !== undefined && Number.isFinite(w.ms) ? w.ms : 0;
  if (w.h < 0 || w.h > 24 || w.mi < 0 || w.mi > 59 || w.s < 0 || w.s > 60) return null;
  if (w.h === 24) {
    if (w.mi !== 0 || w.s !== 0 || extraMs !== 0) return null;
    const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
    return {
      fields: { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate(), h: 0, mi: 0, s: 0 },
      extraMs: 0,
    };
  }
  if (w.s === 60) {
    return { fields: { ...w, s: 59 }, extraMs: 999, leap: true };
  }
  return { fields: w, extraMs };
}

/**
 * Build a ParsedTime from wall-clock fields. With a fixed-offset zone token
 * the instant is absolute; with an IANA zone token (ET, [Europe/Paris]) or
 * none (read in `assumedZone`) it follows that zone's daylight saving: a time
 * in a spring-forward gap or a fall-back overlap is resolved like java.time
 * and Temporal ("compatible") and flagged in `wallClock`. Returns null when
 * the fields are invalid or the instant cannot be computed.
 */
export function buildParsed(
  w: WallClock,
  zone: ResolvedZone | null,
  assumedZone: string,
  meta: MatchMeta,
): ParsedTime | null {
  if (w.y < MIN_YEAR || w.y > 9999) return null;
  if (!isRealDate(w.y, w.mo, w.d)) return null;
  const clock = normalizeClock(w);
  if (!clock) return null;
  const f = clock.fields;
  let epochMs: number;
  let wallClock: 'gap' | 'ambiguous' | undefined;
  if (zone?.offsetIso) epochMs = Date.parse(`${isoLocal(f)}${zone.offsetIso}`);
  else {
    const hit = wallFieldsToInstant(f, zone?.iana ?? tzArg(assumedZone));
    if (!hit) return null;
    epochMs = hit.epochMs;
    // A date-only value's time came from the date-only policy, not the
    // page, so there is no written time to warn about.
    if (!meta.dateOnly) wallClock = hit.wallClock;
  }
  if (!Number.isFinite(epochMs)) return null;
  // Leap seconds are inserted at 23:59:60 UTC, so ":60" is real only when
  // the written :59 second is the last second of a UTC day ("23:59:60Z",
  // "05:44:60 +05:45"); "10:59:60" in UTC is not a time.
  if (clock.leap && (epochMs + 1000) % 86_400_000 !== 0) return null;
  const base: ParsedTime = {
    ...(wallClock ? { wallClock } : {}),
    epochMs: epochMs + clock.extraMs,
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
