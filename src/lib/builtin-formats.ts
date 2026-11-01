import type { NumericDateOrder, ParsedTime } from '../types';
import { parseEpoch } from './epoch';
import type { MatchContext, MatchResult } from './custom-formats';
import { fixedZoneId, resolveZone } from './tz';
import {
  buildParsed,
  dateOnlyTime,
  expandYear,
  isoWeekDate,
  isRealDate,
  isWeekdayName,
  monthFromLocalName,
  monthFromName,
  ordinalDate,
  resolveZoneToken,
  to24h,
  todayIn,
  type ResolvedZone,
  type WallClock,
} from './time-tokens';

/** What the built-in matchers get: the shared context plus the day/month order. */
export interface BuiltinMatchContext extends MatchContext {
  /**
   * How to read a numeric date whose day and month could swap (03/04/2024).
   * Default 'dmy'. The result carries the other reading in `dateOrder`.
   */
  readonly numericDateOrder?: NumericDateOrder;
}

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
  readonly match: (src: string, ctx: BuiltinMatchContext) => MatchResult[];
}

const MAX_MATCHES = 25;

/** Returned by a converter: the shape matched but the values are impossible. */
const VETO = 'veto' as const;

/** A converter's result: the value, and optionally where it starts and how long it is. */
type Converted = { parsed: ParsedTime; length?: number; start?: number };

/**
 * Run a global regex over `src` and convert each match. A match whose values
 * turn out invalid is skipped one character at a time so a valid match that
 * starts inside it is still found. `start` lets a converter drop a leading
 * part of the match (a word that turned out not to be a weekday).
 */
function scan(
  regex: RegExp,
  src: string,
  convert: (m: RegExpExecArray) => Converted | typeof VETO | null,
): MatchResult[] {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const out: MatchResult[] = [];
  let guard = 0;
  let m: RegExpExecArray | null;
  // Each failed attempt advances at least one character, so src.length bounds the loop.
  while (out.length < MAX_MATCHES && guard++ <= src.length + 1 && (m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const got = convert(m);
    if (got === VETO) {
      out.push({ veto: true, index: m.index, length: m[0].length });
      re.lastIndex = m.index + m[0].length;
    } else if (got) {
      const start = got.start ?? 0;
      out.push({ parsed: got.parsed, index: m.index + start, length: got.length ?? m[0].length - start });
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

/** Wall-clock time for a date without one, per the date-only policy, in the value's zone. */
function dateOnlyAt(ctx: MatchContext, zone: ResolvedZone | null): { h: number; mi: number; s: number } {
  if (!zone) return dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone);
  return dateOnlyTime(ctx.dateOnlyPolicy, typeof zone.today === 'number' ? fixedZoneId(zone.today) : zone.today);
}

// --- Regexes ---------------------------------------------------------------

/** Letters, including the Latin-1 accented ones (ä, é, ì, ç...). */
const L = 'A-Za-zÀ-ÿ';
/** A zone after a time: Z, ±hh:mm, GMT±h[:mm] / UTC±h[:mm], or an abbreviation. */
const ZONE = String.raw`Z|[+-]\d{2}:?\d{2}|(?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\d{1,2}(?::?\d{2})?|[A-Za-z]{2,5}`;
/** am/pm, also written "a.m." / "P.M.". */
const AMPM = String.raw`[AaPp]\.?[Mm]\.?(?![A-Za-z])`;
/**
 * Between a date and its time: a comma or spaces, then optionally a
 * connector word: "at", "um", "à", "às", "kl.", "a las", "om", "alle", "ob", "klo".
 */
const CONNECTOR = String.raw`(?:\s*,\s*|\s+)(?:(?:at|um|à|às|kl\.?|a[ \t]+las|om|alle|ob|klo)[ \t]+)?`;

/**
 * A time inside a date: "15:04", "3:04:05 PM", "05.06.07.000000888 AM",
 * "5:06:07 o'clock AM", "05:06 Uhr", "5:06:07.PD" (Albanian am), "上午5:06",
 * "5 h 06" (French) or "3pm". `dot` also allows "5.06" with dots.
 * Groups: cap/h/tsep/mi/s/f/ap for the clock form, h3/mi3 for "5 h 06",
 * h2/ap2 for an hour with am/pm.
 */
function timeFragment(dot: boolean): string {
  const sep = dot ? '[:.]' : ':';
  return (
    String.raw`(?:(?:(?<cap>上午|下午|午前|午後)[ \t]*)?(?<h>\d{1,2})(?<tsep>${sep})(?<mi>\d{2})(?:\k<tsep>(?<s>\d{2})(?:[.,](?<f>\d{1,9}))?)?` +
    String.raw`(?:[ \t]+(?:o['’]clock|Uhr))?(?<ap>[ \t]*${AMPM}|\.(?:${AMPM}|[PpMm][Dd](?![A-Za-z])))?` +
    String.raw`|(?<h3>\d{1,2})[ \t]?h[ \t]?(?<mi3>\d{2})` +
    String.raw`|(?<h2>\d{1,2})[ \t]*(?<ap2>${AMPM}))(?!\d)`
  );
}

/** Trailing zone, bare or parenthesized (" UTC", " (GMT+1)"), and am/pm after it (" CET AM"). */
const ZONE_TAIL = String.raw`(?:[ \t]+\(?(?<zone>${ZONE})\)?(?![\w+-])(?:[ \t]+(?<apz>${AMPM}))?)?`;

const RE_EPOCH_S = /(?<![\w.-])(-?\d{10,11})(?![\w]|\.\d)/;
const RE_EPOCH_MS = /(?<![\w.-])(-?\d{12,13})(?![\w]|\.\d)/;

// Date is required; the time portion is optional. A bare calendar date
// ("2024-01-02") follows the date-only policy. When a time is present a
// zone/offset may follow it, glued on ("Z", "+05:45", "+01") or as a separate
// word ("UTC", "GMT+1"), then a bracketed IANA zone ("[Europe/Paris]"). A
// date alone may carry an offset ("1999-03-22+01:00") or an era ("AD").
const RE_ISO = new RegExp(
  String.raw`\b(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?:[T ](?<h>\d{2}):(?<mi>\d{2})(?::(?<s>\d{2})(?:[.,](?<f>\d{1,9}))?)?` +
    String.raw`(?:\s*(?<glued>Z|[+-]\d{2}:?\d{2})(?![\w:])|(?<short>[+-]\d{2})(?![\w:])|[ \t]+(?<word>(?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\d{1,2}(?::?\d{2})?|[A-Za-z]{2,5})(?![\w+-]))?` +
    String.raw`(?<br>\[(?<brz>[A-Za-z][\w+-]*(?:\/[\w+-]+){0,2})\])?` +
    String.raw`|(?<dz>Z|[+-]\d{2}:\d{2})(?![\w:])|[ \t]+(?<era>AD|BC|CE|BCE)(?!\w))?(?!\d)`,
);

// ISO 8601 ordinal date: year and day of the year, "1999-081", "1999-081+01:00".
const RE_ORDINAL = /(?<![\w.+:/-])(?<y>(?:19|20)\d{2})-(?<doy>\d{3})(?<off>Z|[+-]\d{2}:?\d{2})?(?![\w/-]|[.,:+]\d)/;

// ISO 8601 week date: "1999-W13-2", "1999W132", "2024-W01".
const RE_WEEK = /(?<![\w.+:/-])(?<y>\d{4})(?:-W(?<w>\d{2})(?:-(?<dw>[1-7]))?|W(?<w2>\d{2})(?<dw2>[1-7])?)(?![\w/-]|[.,:]\d)/;

// Compact year-month-day: "19990322", "19990322+0100". The whole token only.
const RE_COMPACT = /(?<![\w.+:/-])(?<y>(?:19|20)\d{2})(?<mo>\d{2})(?<d>\d{2})(?<off>Z|[+-]\d{2}:?\d{2})?(?![\w]|[.,:]\d|[+-]\d)/;

const RE_DATE_SLASH = new RegExp(
  String.raw`\b(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\b(?:[ \t]+((?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5})(?![\w+-]))?`,
);

/**
 * A numeric date: three numbers with one separator ("/", "-", "." or ". "),
 * optionally ending in a dot ("1999.03.22.", "22.3.99."). Never next to a
 * letter, digit, dot or slash, so version numbers and IP addresses
 * ("v1.2.3", "10.0.0.12") do not start or end one.
 */
const NUM_DATE = String.raw`(?<![\w./:+-])(?<a>\d{1,4})(?<sep>[/-]|\.[ ]?)(?<b>\d{1,2})\k<sep>(?<c>\d{1,4})(?<tdot>(?<=\.[ ]?\d{1,4})\.)?(?![\w/-]|[.:]\d)`;

// "22/03/1999", "3/22/99 5:06 AM", "22.03.1999 um 05:06 MEZ", "1999.03.22. 5:06:07".
const RE_NUMERIC = new RegExp(String.raw`${NUM_DATE}(?:${CONNECTOR}${timeFragment(true)}${ZONE_TAIL})?`);
// Time first: "05:06 22/03/99", "05:06:07 22-03-1999".
const RE_NUMERIC_TIME_FIRST = new RegExp(String.raw`(?<![\w.:])${timeFragment(true)}[ \t]+${NUM_DATE}`);

// Month first, optionally led by a weekday:
//   "Wednesday, October 28, 2026, 04:24:09 UTC", "Wed, Oct 28 2026 4:24 AM GMT+5:30",
//   "Jan 5, 2024 at 3pm", "Mar.22.1999", "March 22, 1999 5:06:07 o'clock AM CET".
const RE_LONG = new RegExp(
  String.raw`(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?\b(?<mon>[A-Za-z]{3,9})(?:\.?\s+|\.(?=\d))(?<day>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+|\.)(?<year>\d{4})(?!\w)(?:${CONNECTOR}${timeFragment(false)})?${ZONE_TAIL}`,
);

// Day first, in English, German, French, Spanish, Italian, Portuguese or
// Dutch, optionally led by a weekday: "2 Jan 2024 15:00", "02-Jan-2024",
// "Montag, 22. März 1999 05:06 Uhr MEZ", "lundi 22 mars 1999 5 h 06 CET",
// "22/Mar/99 5:06 AM". Month-first dates belong to RE_LONG, so switching
// either one off really switches that order off. A leading word that is not
// a weekday is dropped from the match.
const RE_DAY_MONTH = new RegExp(
  String.raw`(?:(?<![${L}])(?<wd>[${L}]{2,13}(?:-[${L}]{4,5})?)\.?,?[ \t]+)?\b(?<day>\d{1,2})(?:st|nd|rd|th)?(?:\.?\s+|-|\/)(?<mon>[${L}]{3,10})\.?,?(?:(?:\s+|-|\/)(?<year>\d{4})|[-/](?<yy>\d{2}))(?!\w)(?:${CONNECTOR}${timeFragment(true)})?${ZONE_TAIL}`,
);

// The Unix `date` command: "Mon Mar 22 05:06:07 CET 1999".
const RE_UNIX = new RegExp(
  String.raw`\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[ \t]+(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+(?<day>\d{1,2})[ \t]+(?<h>\d{1,2}):(?<mi>\d{2}):(?<s>\d{2})(?:[ \t]+(?<zone>${ZONE}))?[ \t]+(?<year>\d{4})(?!\w)`,
);

// Chinese / Japanese: "1999年3月22日", "1999年3月22日 星期一 上午05时06分07秒 CET",
// "1999年3月22日 5時06分07秒". (\b does not work next to CJK characters.)
const RE_CJK = new RegExp(
  String.raw`(?<!\d)(?<year>\d{4}|\d{2})年(?<mo>\d{1,2})月(?<day>\d{1,2})日` +
    String.raw`(?:[ \t]*(?:(?:星期|週|周)[一二三四五六日天]|[月火水木金土日]曜日|[(（][月火水木金土日][)）]))?` +
    String.raw`(?:[ \t]*(?<ap>上午|下午|午前|午後)?[ \t]*(?<h>\d{1,2})(?:[时時点](?:(?<mi>\d{1,2})分(?:(?<s>\d{1,2})秒)?)?|:(?<mi2>\d{2})(?::(?<s2>\d{2}))?)` +
    String.raw`(?:[ \t]+\(?(?<zone>${ZONE})\)?(?![\w+-]))?)?`,
);

// Bare time: "3pm", "15:04", "3:30 p.m. UTC", "9:00 +05:45". Never starts
// inside a number or another time ("10:30:15" must not yield "15").
const RE_TIME = new RegExp(
  String.raw`(?<![\d:.])(?<!(?:^|[^\d:])\d{1,3},)\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[ \t]*(${AMPM}))?(?:[ \t]+(${ZONE})(?![\w+-]))?(?![\w:])`,
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
  // Only real connector words count, so "2024-01-02, see at 10:00" keeps 10:00.
  const tail = String.raw`[T,]?\s*(?:(?:at|on|um|à|a|las|les|le|el|om|alle|kl\.?|ob|o|klo|-)\s+){0,2}$`;

  const numeric = new RegExp(String.raw`(?<![\w.:/-])(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})\.?${tail}`, 'i').exec(before);
  if (numeric) {
    const [a, b, c] = [numeric[1] ?? '', numeric[2] ?? '', numeric[3] ?? ''];
    const n = [Number(a), Number(b), Number(c)];
    if (a.length === 4 && n[1]! <= 12 && n[2]! <= 31 && n[1]! >= 1 && n[2]! >= 1) return true; // Y-M-D
    // D-M-YYYY / M-D-YYYY: with a four-digit year the shape alone says
    // "date", even when the values are impossible (32/12/2024).
    if (c.length === 4 && a.length <= 2 && b.length <= 2) return true;
    if (c.length === 2 && a.length <= 2) {
      const [x, y] = [n[0]!, n[1]!];
      if (x >= 1 && y >= 1 && x <= 31 && y <= 31 && (x <= 12 || y <= 12)) return true; // D-M-YY or M-D-YY
    }
  }
  const dayMon = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\.?(?:\s+|-)([${L}]{3,10})\.?,?(?:(?:\s+|-)\d{2,4})?,?${tail}`, 'i').exec(before);
  if (dayMon && isMonthWord(dayMon[2]) && Number(dayMon[1]) <= 31) return true;
  const monDay = new RegExp(String.raw`\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+\d{4})?,?${tail}`, 'i').exec(before);
  if (monDay && isMonthWord(monDay[1]) && Number(monDay[2]) <= 31) return true;
  return false;
}

/**
 * A month name as it appears in a date: capitalized ("May", "Mar", "März") or
 * all caps. Lower-case "may"/"mar" in running text are ordinary words.
 */
function isMonthWord(w: string | undefined): boolean {
  return Boolean(w && /^[A-ZÀ-Þ]/.test(w) && monthFromLocalName(w) !== undefined);
}

/** An offset-looking zone ("+15:00", "UTC+15", "GMT+5:99") that is not a real offset. */
function badOffset(tok: string | undefined): boolean {
  return Boolean(tok && /^(?:[+-]|GMT[+-]|UTC[+-])/i.test(tok) && resolveZoneToken(tok) === null);
}

/** "AM", " p.m.", ".PD" -> an am/pm marker to24h understands (Albanian PD = am, MD = pm). */
function apToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/^[\s.]+/, '');
  if (/^pd$/i.test(t)) return 'am';
  if (/^md$/i.test(t)) return 'pm';
  return t;
}

type Clock = { h: number; mi: number; s: number; ms?: number };

/**
 * Wall-clock time from timeFragment() groups (plus `apz`, am/pm after the
 * zone). undefined when there is no time; null when it is invalid (13pm, or
 * two am/pm markers).
 */
function timeFromGroups(g: Record<string, string | undefined>): Clock | null | undefined {
  const apz = apToken(g.apz);
  if (g.h !== undefined) {
    let ap = apToken(g.ap);
    if (g.cap) {
      if (ap) return null;
      ap = g.cap === '上午' || g.cap === '午前' ? 'am' : 'pm';
    }
    if (apz) {
      if (ap) return null;
      ap = apz;
    }
    const h = to24h(Number(g.h), ap);
    return h === null ? null : { h, mi: Number(g.mi ?? 0), s: Number(g.s ?? 0), ms: fractionMs(g.f) };
  }
  if (g.h3 !== undefined) {
    const h = to24h(Number(g.h3), apz);
    return h === null ? null : { h, mi: Number(g.mi3 ?? 0), s: 0 };
  }
  if (g.h2 !== undefined) {
    if (apz) return null;
    const h = to24h(Number(g.h2), g.ap2);
    return h === null ? null : { h, mi: 0, s: 0 };
  }
  return undefined;
}

/**
 * Read the three numbers of a numeric date. null: not a date (let other
 * formats try); 'bad': clearly a date (four-digit year) but impossible.
 */
function numericDate(
  g: Record<string, string | undefined>,
  order: NumericDateOrder,
): { y: number; mo: number; d: number; ambiguous: boolean; order: NumericDateOrder } | 'bad' | null {
  const [a, b, c, sep] = [g.a ?? '', g.b ?? '', g.c ?? '', g.sep ?? ''];
  const [A, B, C] = [Number(a), Number(b), Number(c)];
  // "1.2.30", "1-2-30": two one-digit parts and a short year are more often a
  // version or a code than a date. Slashes ("1/2/30") stay dates.
  const dotOrDash = sep !== '/';

  // Year first: yyyy-M-d, yy/MM/dd (when the first part cannot be a day).
  if ((a.length === 4 || (a.length === 2 && A > 31)) && c.length <= 2) {
    if (a.length === 2 && dotOrDash && b.length === 1 && c.length === 1) return null;
    const y = a.length === 4 ? A : expandYear(a);
    let [mo, d] = [B, C];
    // yyyy.d.M ("1999.22.3"): only with dots, and only when the month cannot be first.
    if (B > 12 && C <= 12 && sep.startsWith('.')) [mo, d] = [C, B];
    if (isRealDate(y, mo, d)) return { y, mo, d, ambiguous: false, order: 'dmy' };
    return a.length === 4 ? 'bad' : null;
  }
  // Year last: d/M/y or M/d/y.
  if (a.length <= 2 && b.length <= 2 && (c.length === 4 || c.length === 2)) {
    if (c.length === 2 && dotOrDash && a.length === 1 && b.length === 1) return null;
    const y = c.length === 4 ? C : expandYear(c);
    const strong = c.length === 4;
    let chosen: NumericDateOrder;
    let ambiguous = false;
    if (A > 12 && B <= 12) chosen = 'dmy';
    else if (B > 12 && A <= 12) chosen = 'mdy';
    else if (A <= 12 && B <= 12) {
      chosen = order;
      ambiguous = A !== B;
    } else return strong ? 'bad' : null;
    const [mo, d] = chosen === 'dmy' ? [B, A] : [A, B];
    if (!isRealDate(y, mo, d)) return strong ? 'bad' : null;
    return { y, mo, d, ambiguous, order: chosen };
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
  monthOf: (name: string | undefined) => number | undefined,
): BuiltinFormat['match'] {
  return (src, ctx) =>
    scan(regex, src, (m) => {
      const g = (m.groups ?? {}) as Record<string, string | undefined>;
      // "on 22 March 1999": the leading word is not part of the date.
      const start = g.wd !== undefined && !isWeekdayName(g.wd) ? (/^\S+[ \t]+/.exec(m[0])?.[0].length ?? 0) : 0;
      const month = monthOf(g.mon);
      const year = g.year ? Number(g.year) : g.yy ? expandYear(g.yy) : undefined;
      if (month === undefined || year === undefined || !g.day) return null;
      if (badOffset(g.zone)) return VETO;
      const zone = resolveZoneToken(g.zone);
      let text = trimUnresolvedZone(m[0].slice(start), g.zone, zone !== null);
      const t = timeFromGroups(zone ? g : { ...g, apz: undefined });
      if (t === null) return null;
      const dateOnly = t === undefined;
      // "Jan 1, 1970 UTC AM": an am/pm with no time is not part of the date.
      if (dateOnly && zone && g.apz) text = trimUnresolvedZone(text, g.apz, false);
      const clock = t ?? dateOnlyAt(ctx, zone);
      const parsed = buildParsed({ y: year, mo: month, d: Number(g.day), ...clock }, zone, ctx.assumedZone, {
        matchedText: text,
        kind,
        formatId: id,
        formatLabel: label,
        dateOnly,
      });
      if (!parsed) return dateOnly ? null : VETO;
      return { parsed, length: text.length, start };
    });
}

const NUMERIC_LABEL = 'Numeric date';

/** Numeric dates, date first or time first. */
function numericMatcher(src: string, ctx: BuiltinMatchContext): MatchResult[] {
  const order = ctx.numericDateOrder ?? 'dmy';
  const convert = (m: RegExpExecArray): Converted | typeof VETO | null => {
    const g = (m.groups ?? {}) as Record<string, string | undefined>;
    const date = numericDate(g, order);
    if (date === null) return null;
    if (date === 'bad') return VETO;
    if (badOffset(g.zone)) return VETO;
    const zone = resolveZoneToken(g.zone);
    const text = trimUnresolvedZone(m[0], g.zone, zone !== null);
    const t = timeFromGroups(zone ? g : { ...g, apz: undefined });
    // "22/03/1999 25:00": a date and an impossible time; neither is read.
    if (t === null) return VETO;
    const dateOnly = t === undefined;
    const clock = t ?? dateOnlyAt(ctx, zone);
    const meta = {
      matchedText: text,
      kind: dateOnly ? ('date-no-tz' as const) : ('datetime-no-tz' as const),
      formatId: 'numeric-date',
      formatLabel: NUMERIC_LABEL,
      dateOnly,
    };
    const wall: WallClock = { y: date.y, mo: date.mo, d: date.d, ...clock };
    const parsed = buildParsed(wall, zone, ctx.assumedZone, meta);
    if (!parsed) return VETO;
    if (!date.ambiguous) return { parsed, length: text.length };
    const alt = buildParsed({ ...wall, mo: date.d, d: date.mo }, zone, ctx.assumedZone, meta);
    if (!alt) return { parsed, length: text.length };
    const other: NumericDateOrder = date.order === 'dmy' ? 'mdy' : 'dmy';
    return {
      parsed: { ...parsed, dateOrder: { order: date.order, alternate: { epochMs: alt.epochMs, order: other } } },
      length: text.length,
    };
  };
  return [...scan(RE_NUMERIC, src, convert), ...scan(RE_NUMERIC_TIME_FIRST, src, convert)];
}

/** A date with an optional glued offset (ordinal, week and compact dates). */
function dateWithOffset(
  ymd: { y: number; mo: number; d: number },
  offTok: string | undefined,
  text: string,
  ctx: MatchContext,
  id: string,
  label: string,
): Converted | typeof VETO | null {
  if (badOffset(offTok)) return VETO;
  const zone = resolveZoneToken(offTok);
  const parsed = buildParsed({ ...ymd, ...dateOnlyAt(ctx, zone) }, zone, ctx.assumedZone, {
    matchedText: text,
    kind: zone ? 'iso' : 'date-no-tz',
    formatId: id,
    formatLabel: label,
    dateOnly: true,
  });
  return parsed ? { parsed } : null;
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
      'YYYY-MM-DD with an optional time, fraction (. or ,) and zone (Z, ±hh:mm, ±hh, UTC, EST, GMT+1, [Europe/Paris]). A date alone may carry an offset or "AD". Without a zone the time is read in your home zone.',
    examples: [
      '2024-01-02T15:04:05Z',
      '2024-01-02 15:04 UTC',
      '2024-01-02',
      '1999-03-22T05:06:07,000[Europe/Paris]',
      '1999-03-22T05:06:07+01',
      '1999-03-22+01:00',
    ],
    regex: RE_ISO,
    match: (src, ctx) =>
      scan(RE_ISO, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        if (g.era === 'BC' || g.era === 'BCE') return VETO;
        const offTok = g.glued ?? (g.short ? `${g.short}:00` : undefined) ?? g.dz;
        const zoneTok = offTok ?? g.word;
        const dateOnly = g.h === undefined;
        // An unknown zone word is not part of the timestamp: read the time
        // without it rather than dropping the match. A full ISO timestamp
        // with an impossible offset is not a date and a separate time;
        // refuse the whole thing.
        if (badOffset(zoneTok)) return VETO;
        let zone: ResolvedZone | null = zoneTok ? resolveZoneToken(zoneTok) : null;
        let text = m[0];
        if (g.br) {
          // "[Europe/Paris]": the zone, unless an explicit offset already says it.
          const iana = g.brz && resolveZone(g.brz)?.kind === 'iana' ? g.brz : null;
          if (!iana) text = text.slice(0, text.length - g.br.length);
          else if (!zone && !g.word) zone = { iana, label: iana, today: iana };
        }
        if (g.word && !offTok && !resolveZoneToken(g.word)) text = trimUnresolvedZone(text, g.word, false);
        const t = dateOnly ? dateOnlyAt(ctx, zone) : { h: Number(g.h), mi: Number(g.mi), s: Number(g.s ?? 0) };
        const parsed = buildParsed(
          { y: Number(g.y), mo: Number(g.mo), d: Number(g.d), ...t, ms: dateOnly ? undefined : fractionMs(g.f) },
          zone,
          ctx.assumedZone,
          {
            matchedText: text,
            kind: dateOnly && !zone ? 'date-no-tz' : zone ? 'iso' : 'iso-no-tz',
            formatId: 'iso-8601',
            formatLabel: 'ISO 8601',
            dateOnly,
          },
        );
        // "2024-13-01 10:00": the shape is unmistakable, so do not let the
        // trailing time escape as today's 10:00.
        if (!parsed) return dateOnly ? null : VETO;
        return { parsed, length: text.length };
      }),
  },
  {
    id: 'iso-ordinal',
    label: 'ISO 8601 ordinal date',
    description: 'Year and day of the year (001–366), with an optional offset: 1999-081 is 22 March 1999.',
    examples: ['1999-081', '1999-081+01:00'],
    regex: RE_ORDINAL,
    match: (src, ctx) =>
      scan(RE_ORDINAL, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const ymd = ordinalDate(Number(g.y), Number(g.doy));
        return ymd ? dateWithOffset(ymd, g.off, m[0], ctx, 'iso-ordinal', 'ISO 8601 ordinal date') : null;
      }),
  },
  {
    id: 'iso-week',
    label: 'ISO 8601 week date',
    description: 'Year, ISO week and weekday (1 = Monday): 1999-W13-2 or 1999W132 is Tuesday 30 March 1999. Without a weekday, the Monday.',
    examples: ['1999-W13-2', '1999W132', '2024-W01'],
    regex: RE_WEEK,
    match: (src, ctx) =>
      scan(RE_WEEK, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const ymd = isoWeekDate(Number(g.y), Number(g.w ?? g.w2), Number(g.dw ?? g.dw2 ?? 1));
        return ymd ? dateWithOffset(ymd, undefined, m[0], ctx, 'iso-week', 'ISO 8601 week date') : null;
      }),
  },
  {
    id: 'compact-date',
    label: 'Compact date',
    description: 'Eight digits, YYYYMMDD (years 1900–2099), with an optional offset: 19990322, 19990322+0100.',
    examples: ['19990322', '19990322+0100'],
    regex: RE_COMPACT,
    match: (src, ctx) =>
      scan(RE_COMPACT, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const ymd = { y: Number(g.y), mo: Number(g.mo), d: Number(g.d) };
        if (!isRealDate(ymd.y, ymd.mo, ymd.d)) return null;
        return dateWithOffset(ymd, g.off, m[0], ctx, 'compact-date', 'Compact date');
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
        if (badOffset(zoneTok)) return VETO;
        const zone = resolveZoneToken(zoneTok);
        const text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        const parsed = buildParsed(
          { y: Number(y), mo: Number(mo), d: Number(d), h: Number(h), mi: Number(mi), s: Number(s ?? 0) },
          zone,
          ctx.assumedZone,
          { matchedText: text, kind: 'datetime-no-tz', formatId: 'ymd-slash', formatLabel: 'Year/month/day with time' },
        );
        return parsed ? { parsed, length: text.length } : VETO;
      }),
  },
  {
    id: 'numeric-date',
    label: NUMERIC_LABEL,
    description:
      'Day, month and year as numbers with / . or - (22/03/1999, 3/22/99, 22.3.99, 1999.03.22., 99. 3. 22), with an optional time (5:06, 05.06.07, 5:06 AM, 5 h 06, Uhr) and zone, or a time first (05:06 22/03/99). When the day and month could swap (03/04/2024), your day/month order setting decides.',
    examples: ['22/03/1999 05:06', '03/22/99 5:06 AM', '22.03.1999 um 05:06 MEZ', '1999.03.22. 5:06:07', '05:06 22/03/99', '22-3-99'],
    regex: RE_NUMERIC,
    match: numericMatcher,
  },
  {
    id: 'unix-date',
    label: 'Unix date command',
    description: 'The output of the Unix date command: weekday, month, day, time, zone and year.',
    examples: ['Mon Mar 22 05:06:07 CET 1999', 'Tue Jan  2 15:04:05 UTC 2024'],
    regex: RE_UNIX,
    match: (src, ctx) =>
      scan(RE_UNIX, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const month = monthFromName(g.mon);
        if (month === undefined) return null;
        if (badOffset(g.zone)) return VETO;
        const zone = resolveZoneToken(g.zone);
        const parsed = buildParsed(
          { y: Number(g.year), mo: month, d: Number(g.day), h: Number(g.h), mi: Number(g.mi), s: Number(g.s) },
          zone,
          ctx.assumedZone,
          { matchedText: m[0], kind: 'rfc-like', formatId: 'unix-date', formatLabel: 'Unix date command' },
        );
        return parsed ? { parsed } : VETO;
      }),
  },
  {
    id: 'long-form',
    label: 'Written date (month first)',
    description: 'An optional weekday, then month name, day and year, with an optional time and zone.',
    examples: [
      'Wednesday, October 28, 2026, 04:24:09 UTC',
      'Oct 28 2026 4:24 PM',
      'Jan 5, 2024 at 3pm EST',
      'Jan 1, 1970 (UTC)',
      'Mar.22.1999',
      "Monday, March 22, 1999 5:06:07 o'clock AM CET",
    ],
    regex: RE_LONG,
    match: writtenMatcher(RE_LONG, 'long-form', 'long-form', 'Written date (month first)', monthFromName),
  },
  {
    id: 'day-month-name',
    label: 'Written date (day first)',
    description:
      'An optional weekday, then day, month name and year, with an optional time and zone. Month and weekday names in English, German, French, Spanish, Italian, Portuguese and Dutch.',
    examples: [
      '2 Jan 2024 15:00',
      '28 February 2024',
      '02-Jan-2024 15:04',
      '5th May 2025 9:30 p.m. CET',
      'Montag, 22. März 1999 05:06 Uhr MEZ',
      'lundi 22 mars 1999 5 h 06 CET',
      '22-Mar-99 05.06.07.000000888 AM',
    ],
    regex: RE_DAY_MONTH,
    match: writtenMatcher(RE_DAY_MONTH, 'rfc-like', 'day-month-name', 'Written date (day first)', monthFromLocalName),
  },
  {
    id: 'cjk-date',
    label: 'Chinese/Japanese date',
    description: 'Year 年 month 月 day 日, with an optional weekday (星期一, 月曜日), time (上午05时06分07秒, 5時06分) and zone.',
    examples: ['1999年3月22日', '1999年3月22日 星期一 上午05时06分07秒 CET', '1999年3月22日 5時06分07秒'],
    regex: RE_CJK,
    match: (src, ctx) =>
      scan(RE_CJK, src, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const y = g.year!.length === 2 ? expandYear(g.year!) : Number(g.year);
        if (badOffset(g.zone)) return VETO;
        const zone = resolveZoneToken(g.zone);
        const text = trimUnresolvedZone(m[0], g.zone, zone !== null);
        const dateOnly = g.h === undefined;
        let clock: { h: number; mi: number; s: number };
        if (dateOnly) clock = dateOnlyAt(ctx, zone);
        else {
          const ap = g.ap ? (g.ap === '上午' || g.ap === '午前' ? 'am' : 'pm') : undefined;
          const h = to24h(Number(g.h), ap);
          if (h === null) return VETO;
          clock = { h, mi: Number(g.mi ?? g.mi2 ?? 0), s: Number(g.s ?? g.s2 ?? 0) };
        }
        const parsed = buildParsed({ y, mo: Number(g.mo), d: Number(g.day), ...clock }, zone, ctx.assumedZone, {
          matchedText: text,
          kind: dateOnly ? 'date-no-tz' : 'datetime-no-tz',
          formatId: 'cjk-date',
          formatLabel: 'Chinese/Japanese date',
          dateOnly,
        });
        if (!parsed) return dateOnly ? null : VETO;
        return { parsed, length: text.length };
      }),
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
        // "10:00 +15:00": refuse the whole span so "15:00" is not read next.
        if (badOffset(zoneTok)) return VETO;
        const zone = resolveZoneToken(zoneTok);
        // Need an am/pm marker, a colon, or a real zone; "5" alone is not a
        // time. A bare number before a two-letter name ("3 CT scans",
        // "Apollo 11 MT") is a count, not a time.
        const strongZone = zone !== null && (zoneTok?.length ?? 0) >= 3;
        if (!(ampm || miTok !== undefined || strongZone)) return null;
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
