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
  while (out.length < MAX_MATCHES && guard++ < 500 && (m = re.exec(src)) !== null) {
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

const RE_EPOCH_S = /(?<![\w.-])(-?\d{10,11})(?![\w]|\.\d)/;
const RE_EPOCH_MS = /(?<![\w.-])(-?\d{12,13})(?![\w]|\.\d)/;

// Date is required; the time portion is optional. A bare calendar date
// ("2024-01-02") follows the date-only policy. When a time is present a
// zone/offset may follow it.
const RE_ISO =
  /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?(?![\d])/;

const RE_DATE_SLASH = /\b(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\b/;

// Long human form, optionally led by a weekday:
//   "Wednesday, October 28, 2026, 04:24:09 UTC"
//   "Wed, Oct 28 2026 4:24 AM GMT+5:30"
const RE_LONG =
  /(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?)?(?:[ \t]+\(?(Z|[A-Za-z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2})\)?)?/;

// "2 Jan 2024 15:00", "Jan 2024" is not enough: a day is required on one side.
const RE_DAY_MONTH =
  /\b(?:(\d{1,2})\s+)?([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:,)?\s+)?(\d{4})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?)?(?:[ \t]+\(?([A-Za-z]{2,5}|[+-]\d{2}:?\d{2})\)?)?/;

// Bare time: "3pm", "15:04", "3:30 PM UTC", "9:00 +05:45".
const RE_TIME =
  /\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?(?:[ \t]+([A-Za-z]{2,5}|[+-]\d{2}:?\d{2}))?\b/;

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
    description: 'YYYY-MM-DD with an optional time, fraction and Z or ±hh:mm offset. Without an offset the time is read in your home zone.',
    examples: ['2024-01-02T15:04:05Z', '2024-01-02 15:04', '2024-01-02'],
    regex: RE_ISO,
    match: (src, ctx) =>
      scan(RE_ISO, src, (m) => {
        const [, y, mo, d, h, mi, s, frac, zoneTok] = m;
        const dateOnly = h === undefined;
        const zone = zoneTok ? resolveZoneToken(zoneTok) : null;
        if (zoneTok && !zone) return null;
        const t = dateOnly ? dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone) : { h: Number(h), mi: Number(mi), s: Number(s ?? 0) };
        const parsed = buildParsed(
          { y: Number(y), mo: Number(mo), d: Number(d), ...t, ms: dateOnly ? undefined : fractionMs(frac) },
          zone,
          ctx.assumedZone,
          {
            matchedText: m[0],
            kind: dateOnly ? 'date-no-tz' : zone ? 'iso' : 'iso-no-tz',
            formatId: 'iso-8601',
            formatLabel: 'ISO 8601',
            dateOnly,
          },
        );
        return parsed ? { parsed } : null;
      }),
  },
  {
    id: 'ymd-slash',
    label: 'Year/month/day with time',
    description: 'YYYY/MM/DD HH:mm with optional seconds, read in your home zone.',
    examples: ['2024/01/02 15:04'],
    regex: RE_DATE_SLASH,
    match: (src, ctx) =>
      scan(RE_DATE_SLASH, src, (m) => {
        const [, y, mo, d, h, mi, s] = m;
        const parsed = buildParsed(
          { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi), s: Number(s ?? 0) },
          null,
          ctx.assumedZone,
          { matchedText: m[0], kind: 'datetime-no-tz', formatId: 'ymd-slash', formatLabel: 'Year/month/day with time' },
        );
        return parsed ? { parsed } : null;
      }),
  },
  {
    id: 'long-form',
    label: 'Written date (month first)',
    description: 'An optional weekday, then month name, day and year, with an optional time and zone.',
    examples: ['Wednesday, October 28, 2026, 04:24:09 UTC', 'Oct 28 2026 4:24 PM', 'Jan 1, 1970 (UTC)'],
    regex: RE_LONG,
    match: (src, ctx) =>
      scan(RE_LONG, src, (m) => {
        const [, monTok, dayTok, year, hh, mm, ss, ampm, zoneTok] = m;
        const month = monthFromName(monTok);
        if (month === undefined || !year || !dayTok) return null;
        const zone = resolveZoneToken(zoneTok);
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const dateOnly = hh === undefined;
        let t: { h: number; mi: number; s: number };
        if (dateOnly) {
          t = dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone);
        } else {
          const hour = to24h(Number(hh), ampm);
          if (hour === null) return null;
          t = { h: hour, mi: Number(mm ?? 0), s: Number(ss ?? 0) };
        }
        const parsed = buildParsed({ y: Number(year), mo: month, d: Number(dayTok), ...t }, zone, ctx.assumedZone, {
          matchedText: text,
          kind: 'long-form',
          formatId: 'long-form',
          formatLabel: 'Written date (month first)',
          dateOnly,
        });
        return parsed ? { parsed, length: text.length } : null;
      }),
  },
  {
    id: 'day-month-name',
    label: 'Written date (day first)',
    description: 'Day, month name and year (or month, day, year) with an optional time and zone.',
    examples: ['2 Jan 2024 15:00', '28 February 2024', 'Jan 2 2024 3:00 PM UTC'],
    regex: RE_DAY_MONTH,
    match: (src, ctx) =>
      scan(RE_DAY_MONTH, src, (m) => {
        const [, dayA, monTok, dayB, year, hh, mm, ss, ampm, zoneTok] = m;
        const month = monthFromName(monTok);
        const dayTok = dayA ?? dayB;
        if (month === undefined || !year || !dayTok) return null;
        const zone = resolveZoneToken(zoneTok);
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const dateOnly = hh === undefined;
        let t: { h: number; mi: number; s: number };
        if (dateOnly) {
          t = dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone);
        } else {
          const h24 = to24h(Number(hh), ampm);
          if (h24 === null) return null;
          t = { h: h24, mi: Number(mm ?? 0), s: Number(ss ?? 0) };
        }
        const parsed = buildParsed({ y: Number(year), mo: month, d: Number(dayTok), ...t }, zone, ctx.assumedZone, {
          matchedText: text,
          kind: 'rfc-like',
          formatId: 'day-month-name',
          formatLabel: 'Written date (day first)',
          dateOnly,
        });
        return parsed ? { parsed, length: text.length } : null;
      }),
  },
  {
    id: 'time-of-day',
    label: 'Time of day',
    description: 'A time with a colon, am/pm or a zone, taken as today. A lone number like "5" is ignored.',
    examples: ['3pm', '15:30', '9:00 UTC', '3:30 PM +05:45'],
    regex: RE_TIME,
    match: (src, ctx) =>
      scan(RE_TIME, src, (m) => {
        const [, hTok, miTok, sTok, ampm, zoneTok] = m;
        const zone = resolveZoneToken(zoneTok);
        // Need an am/pm marker, a colon, or a real zone; "5" alone is not a time.
        if (!(ampm || miTok !== undefined || zone)) return null;
        const hour = to24h(Number(hTok), ampm);
        if (hour === null) return null;
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const today = todayIn(zone ? zone.minutes : ctx.assumedZone, ctx.nowMs);
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
