import type { ParsedTime } from '../types';
import { parseEpoch } from './epoch';
import type { Candidate, MatchContext } from './custom-formats';
import {
  buildParsed,
  dateOnlyTime,
  monthFromName,
  resolveZoneToken,
  to24h,
  todayIn,
} from './time-tokens';

/**
 * The formats the extension recognizes out of the box. Each entry is listed
 * on the settings page (where it can be switched off) and runs as one matcher
 * in parseTimes. Array order is the tie-break priority when two formats match
 * the same text with the same length.
 */
export interface BuiltinFormat {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly examples: readonly string[];
  /** The regular expression, shown on the settings page. */
  readonly regex: RegExp;
  readonly match: (src: string, ctx: MatchContext) => Candidate[];
}

const MAX_MATCHES = 25;

/**
 * Run a global regex over `src` and convert each match. A match whose values
 * turn out invalid is skipped one character at a time so a valid match that
 * starts inside it is still found.
 */
function scan(
  regex: RegExp,
  src: string,
  convert: (m: RegExpExecArray) => { parsed: ParsedTime; length?: number } | null,
): Candidate[] {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const out: Candidate[] = [];
  let guard = 0;
  let m: RegExpExecArray | null;
  // Each failed attempt advances at least one character, so src.length bounds the loop.
  while (out.length < MAX_MATCHES && guard++ <= src.length + 1 && (m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const got = convert(m);
    if (got) {
      out.push({ parsed: got.parsed, index: m.index, length: got.length ?? m[0].length });
    } else {
      re.lastIndex = m.index + 1;
    }
  }
  return out;
}

/**
 * When a trailing zone token did not resolve (e.g. "Meeting" read as a zone),
 * drop it from the matched text so the highlight covers only the date.
 */
function trimUnresolvedZone(text: string, zoneTok: string | undefined, resolved: boolean): string {
  if (!zoneTok || resolved) return text.trim();
  const at = text.lastIndexOf(zoneTok);
  if (at <= 0) return text.trim();
  return text.slice(0, at).replace(/[\s(]+$/, '');
}

function fractionMs(frac: string | undefined): number | undefined {
  if (!frac) return undefined;
  return Number(frac.slice(0, 3).padEnd(3, '0'));
}

// --- Regexes ---------------------------------------------------------------

/** A zone after a time: Z, ±hh:mm, GMT±h[:mm] / UTC±h[:mm], or an abbreviation. */
const ZONE = String.raw`Z|[+-]\d{2}:?\d{2}|(?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|[A-Za-z]{2,5}`;
/** am/pm, also written "a.m." / "P.M.". */
const AMPM = String.raw`[AaPp]\.?[Mm]\.?`;
/**
 * A time inside a written date: "15:04", "3:04:05 PM", or "3pm". Named groups
 * h/mi/s/ap for the colon form, h2/ap2 for the hour-and-am/pm form.
 */
const TIME_PART = String.raw`(?:(?<h>\d{1,2}):(?<mi>\d{2})(?::(?<s>\d{2}))?(?:[ \t]*(?<ap>${AMPM}))?|(?<h2>\d{1,2})[ \t]*(?<ap2>${AMPM}))`;
/** Trailing zone, bare or parenthesized: " UTC", " (GMT+1)". */
const ZONE_PART = String.raw`(?:[ \t]+\(?(?<zone>${ZONE})\)?(?![\w+-]))?`;

const RE_EPOCH_S = /(?<![\w.-])(-?\d{10,11})(?![\w]|\.\d)/;
const RE_EPOCH_MS = /(?<![\w.-])(-?\d{12,13})(?![\w]|\.\d)/;

// Date is required; the time portion is optional. A bare calendar date
// ("2024-01-02") follows the date-only policy. When a time is present a
// zone/offset may follow it, glued on ("Z", "+05:45") or as a separate word
// ("UTC", "GMT+1").
const RE_ISO = new RegExp(
  String.raw`\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2})(?![\w:])|[ \t]+((?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|[A-Za-z]{2,5})(?![\w+-]))?)?(?![\d])`,
);

const RE_DATE_SLASH = new RegExp(
  String.raw`\b(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\b(?:[ \t]+((?:GMT|UTC)[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5})(?![\w+-]))?`,
);

// Month first, optionally led by a weekday:
//   "Wednesday, October 28, 2026, 04:24:09 UTC", "Wed, Oct 28 2026 4:24 AM GMT+5:30",
//   "Jan 5, 2024 at 3pm".
const RE_LONG = new RegExp(
  String.raw`(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?\b(?<mon>[A-Za-z]{3,9})\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})(?!\w)(?:,?\s+(?:at\s+)?${TIME_PART})?${ZONE_PART}`,
);

// Day first: "2 Jan 2024 15:00", "28 February, 2024", "02-Jan-2024 15:04".
// Month-first dates belong to RE_LONG, so switching either one off really
// switches that order off.
const RE_DAY_MONTH = new RegExp(
  String.raw`\b(?<day>\d{1,2})(?:st|nd|rd|th)?(?:\s+|-)(?<mon>[A-Za-z]{3,9})\.?,?(?:\s+|-)(?<year>\d{4})(?!\w)(?:,?\s+(?:at\s+)?${TIME_PART})?${ZONE_PART}`,
);

// Bare time: "3pm", "15:04", "3:30 p.m. UTC", "9:00 +05:45". Never starts
// inside a number or another time ("10:30:15" must not yield "15").
const RE_TIME = new RegExp(
  String.raw`(?<![\d:.,])\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[ \t]*(${AMPM}))?(?:[ \t]+(${ZONE})(?![\w+-]))?(?![\w:])`,
);

/**
 * True when the text just before `index` ends in a date that no enabled
 * format read ("31/12/2024 ", "24.12.2024 um ", "Dec 31 at ", "2 Jan "). A
 * bare time there belongs to that date, and reading it as "today" would be a
 * confident, wrong answer. Only plausible dates count, so version numbers,
 * IP addresses and words that are not months do not block a time.
 */
function dateLikeBefore(src: string, index: number): boolean {
  const before = src.slice(Math.max(0, index - 40), index);
  // Connector between the date and the time: "T", ",", "at", "um", "à", "a las".
  const tail = String.raw`[T,]?\s*(?:[^\s\d]{1,4}\.?\s+){0,2}$`;

  const numeric = new RegExp(String.raw`(?<![\w.:/-])(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})${tail}`).exec(before);
  if (numeric) {
    const [a, b, c] = [numeric[1] ?? '', numeric[2] ?? '', numeric[3] ?? ''];
    const n = [Number(a), Number(b), Number(c)];
    if (a.length === 4 && n[1]! <= 12 && n[2]! <= 31 && n[1]! >= 1 && n[2]! >= 1) return true; // Y-M-D
    if ((c.length === 4 || c.length === 2) && a.length <= 2) {
      const [x, y] = [n[0]!, n[1]!];
      if (x >= 1 && y >= 1 && x <= 31 && y <= 31 && (x <= 12 || y <= 12)) return true; // D-M-Y or M-D-Y
    }
  }
  const dayMon = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+|-)([A-Za-z]{3,9})\.?,?(?:(?:\s+|-)\d{2,4})?,?${tail}`).exec(before);
  if (dayMon && monthFromName(dayMon[2]) !== undefined && Number(dayMon[1]) <= 31) return true;
  const monDay = new RegExp(String.raw`\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+\d{4})?,?${tail}`).exec(before);
  if (monDay && monthFromName(monDay[1]) !== undefined && Number(monDay[2]) <= 31) return true;
  return false;
}

/** An offset-looking zone ("+15:00", "UTC+15", "GMT+5:99") that is not a real offset. */
function badOffset(tok: string | undefined): boolean {
  return Boolean(tok && /^(?:[+-]|GMT[+-]|UTC[+-])/i.test(tok) && resolveZoneToken(tok) === null);
}

/** Wall-clock time from a TIME_PART match, or null when it is invalid (13pm). */
function timeFromGroups(g: Record<string, string | undefined>): { h: number; mi: number; s: number } | null {
  if (g.h !== undefined) {
    const h = to24h(Number(g.h), g.ap);
    return h === null ? null : { h, mi: Number(g.mi ?? 0), s: Number(g.s ?? 0) };
  }
  if (g.h2 !== undefined) {
    const h = to24h(Number(g.h2), g.ap2);
    return h === null ? null : { h, mi: 0, s: 0 };
  }
  return null;
}

// --- Matchers --------------------------------------------------------------

function epochMatcher(id: string, label: string, unit: 'seconds' | 'milliseconds', regex: RegExp): BuiltinFormat['match'] {
  return (src, ctx) =>
    scan(regex, src, (m) => {
      const raw = m[1] ?? '';
      const ep = parseEpoch(raw, unit);
      if (!ep) return null;
      return {
        parsed: {
          epochMs: ep.epochMs,
          matchedText: raw,
          sourceZone: 'UTC',
          assumedZone: ctx.assumedZone,
          assumed: false,
          kind: unit === 'seconds' ? 'epoch-seconds' : 'epoch-millis',
          formatId: id,
          formatLabel: label,
        },
      };
    });
}

/** Written dates (month-first or day-first) share one converter. */
function writtenMatcher(
  regex: RegExp,
  kind: ParsedTime['kind'],
  id: string,
  label: string,
): BuiltinFormat['match'] {
  return (src, ctx) =>
    scan(regex, src, (m) => {
      const g = (m.groups ?? {}) as Record<string, string | undefined>;
      const month = monthFromName(g.mon);
      if (month === undefined || !g.year || !g.day) return null;
      if (badOffset(g.zone)) return null;
      const zone = resolveZoneToken(g.zone);
      const text = trimUnresolvedZone(m[0], g.zone, zone !== null);
      const dateOnly = g.h === undefined && g.h2 === undefined;
      const t = dateOnly ? dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone) : timeFromGroups(g);
      if (!t) return null;
      const parsed = buildParsed({ y: Number(g.year), mo: month, d: Number(g.day), ...t }, zone, ctx.assumedZone, {
        matchedText: text,
        kind,
        formatId: id,
        formatLabel: label,
        dateOnly,
      });
      return parsed ? { parsed, length: text.length } : null;
    });
}

export const BUILTIN_FORMATS: readonly BuiltinFormat[] = [
  {
    id: 'epoch-seconds',
    label: 'Unix epoch (seconds)',
    description: 'A 10- or 11-digit number, read as seconds since 1970-01-01 UTC.',
    examples: ['1700000000'],
    regex: RE_EPOCH_S,
    match: epochMatcher('epoch-seconds', 'Unix epoch (seconds)', 'seconds', RE_EPOCH_S),
  },
  {
    id: 'epoch-millis',
    label: 'Unix epoch (milliseconds)',
    description: 'A 12- or 13-digit number, read as milliseconds since 1970-01-01 UTC.',
    examples: ['1700000000000'],
    regex: RE_EPOCH_MS,
    match: epochMatcher('epoch-millis', 'Unix epoch (milliseconds)', 'milliseconds', RE_EPOCH_MS),
  },
  {
    id: 'iso-8601',
    label: 'ISO 8601',
    description:
      'YYYY-MM-DD with an optional time, fraction and zone (Z, ±hh:mm, UTC, EST, GMT+1). Without a zone the time is read in your home zone.',
    examples: ['2024-01-02T15:04:05Z', '2024-01-02 15:04 UTC', '2024-01-02'],
    regex: RE_ISO,
    match: (src, ctx) =>
      scan(RE_ISO, src, (m) => {
        const [, y, mo, d, h, mi, s, frac, glued, word] = m;
        const zoneTok = glued ?? word;
        const dateOnly = h === undefined;
        // An unknown zone word (or an impossible offset) is not part of the
        // timestamp: read the time without it rather than dropping the match.
        if (badOffset(zoneTok)) return null;
        const zone = zoneTok ? resolveZoneToken(zoneTok) : null;
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const t = dateOnly ? dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone) : { h: Number(h), mi: Number(mi), s: Number(s ?? 0) };
        const parsed = buildParsed(
          { y: Number(y), mo: Number(mo), d: Number(d), ...t, ms: dateOnly ? undefined : fractionMs(frac) },
          zone,
          ctx.assumedZone,
          {
            matchedText: text,
            kind: dateOnly ? 'date-no-tz' : zone ? 'iso' : 'iso-no-tz',
            formatId: 'iso-8601',
            formatLabel: 'ISO 8601',
            dateOnly,
          },
        );
        return parsed ? { parsed, length: text.length } : null;
      }),
  },
  {
    id: 'ymd-slash',
    label: 'Year/month/day with time',
    description: 'YYYY/MM/DD HH:mm with optional seconds and zone. Without a zone the time is read in your home zone.',
    examples: ['2024/01/02 15:04', '2024/12/31 10:30:15 UTC'],
    regex: RE_DATE_SLASH,
    match: (src, ctx) =>
      scan(RE_DATE_SLASH, src, (m) => {
        const [, y, mo, d, h, mi, s, zoneTok] = m;
        if (badOffset(zoneTok)) return null;
        const zone = resolveZoneToken(zoneTok);
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const parsed = buildParsed(
          { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi), s: Number(s ?? 0) },
          zone,
          ctx.assumedZone,
          { matchedText: text, kind: 'datetime-no-tz', formatId: 'ymd-slash', formatLabel: 'Year/month/day with time' },
        );
        return parsed ? { parsed, length: text.length } : null;
      }),
  },
  {
    id: 'long-form',
    label: 'Written date (month first)',
    description: 'An optional weekday, then month name, day and year, with an optional time and zone.',
    examples: ['Wednesday, October 28, 2026, 04:24:09 UTC', 'Oct 28 2026 4:24 PM', 'Jan 5, 2024 at 3pm EST', 'Jan 1, 1970 (UTC)'],
    regex: RE_LONG,
    match: writtenMatcher(RE_LONG, 'long-form', 'long-form', 'Written date (month first)'),
  },
  {
    id: 'day-month-name',
    label: 'Written date (day first)',
    description: 'Day, month name and year, with an optional time and zone.',
    examples: ['2 Jan 2024 15:00', '28 February 2024', '02-Jan-2024 15:04', '5th May 2025 9:30 p.m. CET'],
    regex: RE_DAY_MONTH,
    match: writtenMatcher(RE_DAY_MONTH, 'rfc-like', 'day-month-name', 'Written date (day first)'),
  },
  {
    id: 'time-of-day',
    label: 'Time of day',
    description:
      'A time with a colon, am/pm or a zone, taken as today. Ignored when it follows a date no format recognized, and a lone number like "5" is ignored.',
    examples: ['3pm', '15:30', '11:00 p.m.', '9:00 UTC', '9:00 GMT+5:30', '3 PM ET', '3:30 PM +05:45'],
    regex: RE_TIME,
    match: (src, ctx) =>
      scan(RE_TIME, src, (m) => {
        const [, hTok, miTok, sTok, ampm, zoneTok] = m;
        if (dateLikeBefore(src, m.index)) return null;
        if (badOffset(zoneTok)) return null;
        const zone = resolveZoneToken(zoneTok);
        // Need an am/pm marker, a colon, or a real zone; "5" alone is not a time.
        if (!(ampm || miTok !== undefined || zone)) return null;
        const hour = to24h(Number(hTok), ampm);
        if (hour === null) return null;
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const today = todayIn(zone ? zone.today : ctx.assumedZone, ctx.nowMs);
        const parsed = buildParsed(
          { ...today, h: hour, mi: Number(miTok ?? 0), s: Number(sTok ?? 0) },
          zone,
          ctx.assumedZone,
          {
            matchedText: text,
            kind: zone ? 'offset' : 'time-of-day',
            formatId: 'time-of-day',
            formatLabel: 'Time of day',
          },
        );
        return parsed ? { parsed, length: text.length } : null;
      }),
  },
];

export const BUILTIN_FORMAT_IDS: readonly string[] = BUILTIN_FORMATS.map((f) => f.id);
