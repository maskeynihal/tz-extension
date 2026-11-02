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
  japaneseEraYear,
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

/** Raw matches (vetoes included) one regex of a built-in format yields per parse. */
const MAX_MATCHES = 25;

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

/** Returned by a converter: the shape matched but the values are impossible. */
const VETO = 'veto' as const;

/** A converter's result: the value, and optionally where it starts and how long it is. */
type Converted = { parsed: ParsedTime; length?: number; start?: number };

/** A veto that claims more text than the regex matched (a verse range "1:16-2:10"). */
type SizedVeto = { veto: number };

/**
 * Run a global regex over `src` and convert each match. A match whose values
 * turn out invalid is skipped one character at a time so a valid match that
 * starts inside it is still found. `start` lets a converter drop a leading
 * part of the match (a word that turned out not to be a weekday).
 */
function scan(
  regex: RegExp,
  src: string,
  ctx: BuiltinMatchContext,
  convert: (m: RegExpExecArray) => Converted | typeof VETO | SizedVeto | null,
): MatchResult[] {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const out: MatchResult[] = [];
  let guard = 0;
  let m: RegExpExecArray | null;
  // Each failed attempt advances at least one character, so src.length bounds the loop.
  const cap = ctx.maxMatches ?? MAX_MATCHES;
  while (out.length < cap && guard++ <= src.length + 1 && (m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const got = convert(m);
    if (got === VETO || (got && 'veto' in got)) {
      const length = got === VETO ? m[0].length : got.veto;
      out.push({ veto: true, index: m.index, length });
      re.lastIndex = m.index + length;
    } else if (got) {
      const start = got.start ?? 0;
      out.push({ parsed: got.parsed, index: m.index + start, length: got.length ?? m[0].length - start });
    } else {
      re.lastIndex = m.index + 1;
    }
  }
  // Stopped at the cap: the next search would have started at lastIndex.
  if (out.length >= cap) ctx.onCapped?.(re.lastIndex);
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

/** Inside "[...]": an IANA-looking zone name ("Europe/Paris", "UTC"); checked with resolveZone. */
const BRACKET_ZONE = String.raw`[A-Za-z][\w+-]*(?:\/[\w+-]+){0,2}`;
/**
 * A bare IANA zone name after a time ("10:00 Europe/Paris"). Only the IANA
 * regions count, so "3pm ET/PT" still reads the abbreviation ET.
 */
const BARE_IANA = String.raw`(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z][\w+-]*(?:\/[A-Za-z][\w+-]*)?(?![\w/+-])`;

const RE_EPOCH_S = /(?<![\w.-])(-?\d{10,11})(?![\w]|\.\d)/;
const RE_EPOCH_MS = /(?<![\w.-])(-?\d{12,13})(?![\w]|\.\d)/;

// Date is required; the time portion is optional. A bare calendar date
// ("2024-01-02") follows the date-only policy. When a time is present a
// zone/offset may follow it, glued on ("Z", "+05:45", "+01") or as a separate
// word ("UTC", "GMT+1"), then a bracketed IANA zone ("[Europe/Paris]"). A
// date alone may carry an offset ("1999-03-22+01:00") or an era ("AD").
const RE_ISO = new RegExp(
  String.raw`\b(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})(?:[T ](?<h>\d{2}):(?<mi>\d{2})(?::(?<s>\d{2})(?:[.,](?<f>\d{1,9}))?)?` +
    String.raw`(?:\s*(?<glued>Z|[+-]\d{2}:?\d{2})(?![\w:])|(?<short>[+-]\d{2})(?![\w:])` +
    String.raw`|(?<sp>[ \t](?:\[(?<sbrz>${BRACKET_ZONE})\]|(?<bare>${BARE_IANA})))` +
    String.raw`|[ \t]+(?<word>(?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\d{1,2}(?::?\d{2})?|[A-Za-z]{2,5})(?![\w+-]))?` +
    String.raw`(?<br>\[(?<brz>${BRACKET_ZONE})\])?` +
    String.raw`|(?<dz>Z|[+-]\d{2}:\d{2})(?![\w:])|[ \t]+(?<era>AD|BC|CE|BCE)(?!\w))?(?!\d)`,
);

// ISO 8601 ordinal date: year and day of the year, "1999-081", "1999-081+01:00",
// optionally with a time after a "T": "2024-123T10:00Z".
const RE_ORDINAL =
  /(?<![\w.+:/-])(?<y>(?:19|20)\d{2})-(?<doy>\d{3})(?:T(?<h>\d{2}):(?<mi>\d{2})(?::(?<s>\d{2})(?:[.,](?<f>\d{1,9}))?)?)?(?<off>Z|[+-]\d{2}:?\d{2})?(?![\w/-]|[.,:+]\d)/;

// ISO 8601 week date: "1999-W13-2", "1999W132", "2024-W01".
const RE_WEEK = /(?<![\w.+:/-])(?<y>\d{4})(?:-W(?<w>\d{2})(?:-(?<dw>[1-7]))?|W(?<w2>\d{2})(?<dw2>[1-7])?)(?![\w/-]|[.,:]\d)/;

// Compact year-month-day: "19990322", "19990322+0100". The whole token only.
const RE_COMPACT = /(?<![\w.+:/-])(?<y>(?:19|20)\d{2})(?<mo>\d{2})(?<d>\d{2})(?<off>Z|[+-]\d{2}:?\d{2})?(?![\w]|[.,:]\d|[+-]\d)/;

/**
 * A label that makes the number after it an identifier, at the end of the
 * text before a match, on the same line: "PR 2024-123", "Invoice No. 2024-001",
 * "ID: 2024-001", "#2024-123", "Order #20240115".
 */
function idLabel(words: string): RegExp {
  return new RegExp(String.raw`(?:(?<![${L}\d_])(?:${words})\.?|#)[ \t:#]*$`, 'i');
}
/** Labels that make "2024-123" an id rather than an ordinal date. */
const ORDINAL_ID_BEFORE = idLabel(
  'pr|id|ticket|invoice|inv|ref|order|issue|bug|case|req|no|number|sku|build|job|run|release',
);
/** Labels that make "20240115" or "2024W012" a product code or id rather than a date. */
const CODE_ID_BEFORE = idLabel('order|sku|id|model|part|item|ref|no|build|lot|serial|product|ext');

/** True when `re` matches the text just before `index` (same line only). */
function labelledBefore(src: string, index: number, re: RegExp): boolean {
  const before = src.slice(Math.max(0, index - 40), index);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  return re.test(line);
}

const RE_DATE_SLASH = new RegExp(
  String.raw`\b(\d{4})\/(\d{2})\/(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\b(?:[ \t]+((?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5})(?![\w+-]))?`,
);

/**
 * A numeric date: three numbers with one separator ("/", "-", "." or ". "),
 * optionally ending in a dot ("1999.03.22.", "22.3.99."). Never next to a
 * letter, digit, dot or slash, so version numbers and IP addresses
 * ("v1.2.3", "10.0.0.12") do not start or end one.
 */
const NUM_DATE = String.raw`(?<![\w./:+-])(?<a>\d{1,4})(?<sep>[/-]|\.[ ]?)(?<b>\d{1,2})\k<sep>(?<c>\d{1,4})(?<tdot>(?<=\.[ ]?\d{1,4})\.)?(?![\w/%-]|[.:]\d)`;

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
// A Japanese era year ("平成11年", "令和元年") is converted, not read as 2011.
const RE_CJK = new RegExp(
  String.raw`(?:(?<era>明治|大正|昭和|平成|令和)[ \t]?(?<eraYear>\d{1,2}|元)|(?<!\d)(?<year>\d{4}|\d{2}))年(?<mo>\d{1,2})月(?<day>\d{1,2})日` +
    String.raw`(?:[ \t]*(?:(?:星期|週|周)[一二三四五六日天]|[月火水木金土日]曜日|[(（][月火水木金土日][)）]))?` +
    String.raw`(?:[ \t]*(?<ap>上午|下午|午前|午後)?[ \t]*(?<h>\d{1,2})(?:[时時点](?:(?<mi>\d{1,2})分(?:(?<s>\d{1,2})秒)?)?|:(?<mi2>\d{2})(?::(?<s2>\d{2}))?)` +
    String.raw`(?:[ \t]+\(?(?<zone>${ZONE})\)?(?![\w+-]))?)?`,
);

// Bare time: "3pm", "15:04", "3:30 p.m. UTC", "9:00 +05:45". Never starts
// inside a number or another time ("10:30:15" must not yield "15").
// An IANA zone one space after the time ("10:00 Europe/Paris", "10:00 [Asia/Tokyo]") is read
// too, and so is a glued Zulu "Z" ("10:00Z", "23:59:60Z").
// Groups: 1 hour, 2 minutes, 3 seconds, 4 am/pm, 5 bracketed zone, 6 bare IANA zone, 7 zone token.
const RE_TIME = new RegExp(
  String.raw`(?<![\d:.])(?<!(?:^|[^\d:])\d{1,3},)\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(?:[ \t]*(${AMPM}))?` +
    String.raw`(?:[ \t](?:\[(${BRACKET_ZONE})\]|(${BARE_IANA}))|(?:[ \t]+|(?=Z(?![\w+-])))(${ZONE})(?![\w+-]))?(?![\w:])`,
);

/**
 * Scripture references look like times: "Romans 8:28", "Surah 2:255",
 * "verse 3:16". Book names (and "verse", "chapter", "ch.") just before
 * a bare H:MM make it chapter:verse. A list rather than "any capitalized
 * word": "Standup 9:00" and "Lunch 12:30" are times. Book names that are
 * common schedule words (Job, Acts, Numbers, Song) are left out, and books
 * that are also given names are in NAME_BOOK below. "v." is handled by
 * VERSE_ABBR_BEFORE.
 */
const SCRIPTURE_BEFORE = new RegExp(
  String.raw`(?:^|[^${L}])(?:(?:Genesis|Exodus|Leviticus|Deuteronomy|Judges|Kings|Chronicles|Nehemiah|Psalms?|Proverbs|Ecclesiastes|Lamentations|Ezekiel|Hosea|Obadiah|Nahum|Habakkuk|Zephaniah|Haggai|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Hebrews|Revelation|Gen|Exod|Deut|Rom|Cor|Gal|Eph|Heb|Rev|Ps|Prov|Jer|Ezek|Surah|Sura|Quran|Qur['’]an)\.?|[Vv]erses?|[Cc]hapter|[Cc]h\.)[ \t]+$`,
);

/**
 * Verbs that introduce a citation: "See John 3:16", "Read Mark 4:39",
 * "Please see John 3:16", "Quoting Luke 6:31", "cf. Luke 2:11". Capitalised, at the start of a
 * line or sentence (see CITE_START), except "cf.", which is only ever a
 * citation. A lowercase "see" mid-sentence is chat: "I'll see John 3:47 today".
 */
const CITE_VERB = String.raw`(?:Please[ \t]+(?:see|read|compare)|See|Read|Compare|Quot(?:e|ed|es|ing)|Cf\.|cf\.)`;
/** Before a citation verb: the line start, ". ", "; ", ": ", "! ", "? " or an opening bracket or quote. */
const CITE_START = /(?:^|[.;:!?][ \t]+|[([{"'“‘«][ \t]*)[\s*>•–—-]*$/;

/**
 * "v. 3:16" and "vv. 3:16" mean verse when the abbreviation sits directly
 * before the number. After a capitalised word it means versus: "Liverpool
 * v. 3:00" is a time, unless that word is a citation verb ("See v. 3:16").
 * Group: word (the word before "v.", if any).
 */
const VERSE_ABBR_BEFORE = new RegExp(
  String.raw`(?:^|[^${L}])(?:(?<word>[${L}]+\.?)[ \t]+)?[Vv]v?\.[ \t]+$`,
);

/**
 * Books that are also given names: "Call John 3:30" and "Lunch with Peter
 * 12:30" are times. They mean chapter:verse only with scripture context: a
 * book number ("1 John 3:16", "2 Peter 1:5"), "verse"/"chapter"/"ch."
 * before the name, or a verse range or list right after (VERSE_AFTER).
 * Weaker context, the name opening the line or following a citation verb
 * ("John 3:16", "See John 3:16"), is a verse only when nothing says time:
 * see weakVerse. Groups: lead (text before), num, ctx, cite.
 */
const NAME_BOOK = 'Joshua|Samuel|Ruth|Ezra|Esther|Isaiah|Isa|Jeremiah|Daniel|Joel|Amos|Jonah|Micah|Zechariah|Malachi|Matthew|Matt|Mark|Luke|John|Timothy|Titus|Philemon|Phil|James|Peter|Jude';
const NAME_BOOK_BEFORE = new RegExp(
  String.raw`(?<lead>^|[^${L}\d])(?<cite>${CITE_VERB}[ \t]+)?(?<num>(?:[1-3]|I{1,3}|First|Second|Third)[ \t]+)?(?<ctx>(?:[Vv]erses?|[Cc]hapter|[Cc]h\.)[ \t]+)?(?:${NAME_BOOK})\.?[ \t]+$`,
);
/** "3:16-18", "3:16–18", "3:16,18": a verse range or list, not a time range. */
const VERSE_AFTER = /^(?:[-–—]|,(?=\d))\d{1,3}(?![\d:])/;
/** "9:17-9:45", "9:17 – 9:45": a range to another H:MM (a time range or a chapter range). */
const TIME_RANGE_AFTER = /^[ \t]*[-–—][ \t]*(?<h>\d{1,2}):(?<mi>\d{2})(?![\d:])/;
/** "Mark 3:47 meeting", "Peter 4:12 joined": a schedule or chat word after the time. */
const TIME_WORD_AFTER =
  /^[ \t]+(?:meeting|meet|call|calls|standup|stand-up|sync|joined|joins|left|leaves|said|wrote|replied|lunch|dinner|breakfast|demo|review|today|tonight|tomorrow|yesterday|am|pm|a\.m\.|p\.m\.|start|starts|end|ends|deadline|dentist|appointment|interview|online|offline|here)(?![\p{L}\p{N}])/u;

/**
 * A given-name book with only weak scripture context (it opens the line, or
 * follows a citation verb). A zero-padded hour ("John 09:41"), an hour of 13
 * or more without a citation verb ("Peter 14:07"; "See John 15:13" is a
 * verse), a time range ("Daniel 9:17-9:45": the end is zero-padded or on
 * whole five minutes), a schedule word after ("Mark 3:47 meeting", also
 * "Read John 3:16 today") or whole five minutes ("Ruth 9:00") say time.
 */
function weakVerse(hour: string, minutes: string, after: string, cited: boolean): boolean {
  if (/^0\d/.test(hour)) return false;
  if (Number(hour) >= 13 && !cited) return false;
  const range = TIME_RANGE_AFTER.exec(after);
  if (range) {
    // "Matthew 5:17-7:12" is a chapter range; "Daniel 9:17-9:45" a time range.
    const { h = '', mi = '' } = range.groups ?? {};
    if (/^0\d/.test(h) || Number(mi) % 5 === 0) return false;
  } else if (TIME_WORD_AFTER.test(after)) return false;
  return Number(minutes) % 5 !== 0;
}

/** True when H:MM, with `line` before it and `after` after it, is chapter:verse. */
function scriptureBefore(line: string, hour: string, minutes: string, after: string): boolean {
  if (SCRIPTURE_BEFORE.test(line)) return true;
  const v = VERSE_ABBR_BEFORE.exec(line);
  if (v) {
    const word = v.groups?.word;
    if (!word || !/^[A-Z]/.test(word) || new RegExp(String.raw`^${CITE_VERB}$`).test(word)) return true;
  }
  const m = NAME_BOOK_BEFORE.exec(line);
  if (!m) return false;
  const g = m.groups ?? {};
  // There is no verse 0 and no chapter 09: ":00" minutes or a zero-padded
  // hour is a time even after a book number ("1 John 10:00-11:30",
  // "1 Samuel 9:00-9:45", "1 John 09:41").
  if (minutes === '00' || /^0\d/.test(hour)) return false;
  // A book number or "verse"/"chapter" settles it: "2 Peter 1:16-2:10".
  if (g.num || g.ctx) return true;
  if (VERSE_AFTER.test(after)) return true;
  const before = line.slice(0, m.index + (g.lead ?? '').length);
  const opensLine = /^[\s"'“‘«([*>•–—-]*$/.test(before);
  const cited = !!g.cite && CITE_START.test(before);
  return (opensLine || cited) && weakVerse(hour, minutes, after, cited);
}

/** "odds of 1:30", "1:30 odds", "aspect ratio 4:30": a ratio, not a time. */
const RATIO_WORD = 'odds|ratios?|scale|aspect|split|mix|proportions?';
const RATIO_BEFORE = new RegExp(String.raw`(?<![${L}])(?:${RATIO_WORD})(?:[ \t]+(?:of|is|was|=))?[ \t:=]*$`, 'i');
const RATIO_AFTER = new RegExp(String.raw`^[ \t]*(?:${RATIO_WORD})(?![${L}])`, 'i');

// Connector between the date and the time: "T", ",", "at", "um", "à", "a las".
// Only real connector words count, so "2024-01-02, see at 10:00" keeps 10:00.
const DATE_TAIL = String.raw`[T,]?\s*(?:(?:at|on|um|à|a|las|les|le|el|om|alle|kl\.?|ob|o|klo|-)\s+){0,2}$`;
const DATE_BEFORE_NUMERIC = new RegExp(String.raw`(?<![\w.:/-])(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})\.?${DATE_TAIL}`, 'i');
const DATE_BEFORE_DAY_MONTH = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\.?(?:\s+|-)([${L}]{3,10})\.?,?(?:(?:\s+|-)\d{2,4})?,?${DATE_TAIL}`,
  'i',
);
const DATE_BEFORE_MONTH_DAY = new RegExp(String.raw`\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+\d{4})?,?${DATE_TAIL}`, 'i');

/**
 * True when the text just before `index` ends in a date that no enabled
 * format read ("31/12/2024 ", "24.12.2024 um ", "Dec 31 at ", "2 Jan "). A
 * bare time there belongs to that date, and reading it as "today" would be a
 * confident, wrong answer. Only plausible dates count, so version numbers,
 * IP addresses and words that are not months do not block a time.
 */
function dateLikeBefore(src: string, index: number): boolean {
  const before = src.slice(Math.max(0, index - 40), index);
  const numeric = DATE_BEFORE_NUMERIC.exec(before);
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
  const dayMon = DATE_BEFORE_DAY_MONTH.exec(before);
  if (dayMon && isMonthWord(dayMon[2]) && Number(dayMon[1]) <= 31) return true;
  const monDay = DATE_BEFORE_MONTH_DAY.exec(before);
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
  return Boolean(tok && /^(?:[+\-\u2212]|(?:GMT|UTC)[+\-\u2212\u2013])/i.test(tok) && resolveZoneToken(tok) === null);
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
 * to24h, plus ISO 8601's "24:00" (end of the day) on a 24-hour clock.
 * buildParsed accepts hour 24 only with zero minutes and seconds.
 */
function clockHour(hour: number, ap: string | undefined): number | null {
  return hour === 24 && !ap ? 24 : to24h(hour, ap);
}

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
    const h = clockHour(Number(g.h), ap);
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
 * `timed`: a time of day is attached ("22.03.99 10:00", "05:06 22-03-99"),
 * which settles that the numbers are a date.
 */
function numericDate(
  g: Record<string, string | undefined>,
  order: NumericDateOrder,
  timed: boolean,
  nowMs: number,
): { y: number; mo: number; d: number; ambiguous: boolean; order: NumericDateOrder } | 'bad' | null {
  const [a, b, c, sep] = [g.a ?? '', g.b ?? '', g.c ?? '', g.sep ?? ''];
  const [A, B, C] = [Number(a), Number(b), Number(c)];
  // "1.2.30", "1-2-30": two one-digit parts and a short year are more often a
  // version or a code than a date. Slashes ("1/2/30") stay dates, and so
  // does any of them with a time ("3.4.24 10:00").
  const dotOrDash = sep !== '/';
  const yearFirst = (a.length === 4 || (a.length === 2 && A > 31)) && c.length <= 2;
  if (!timed) {
    // "10.30.15": dotted dates are day-first wherever they are used, so with
    // a two-digit year a middle part that cannot be a month makes it a time
    // (H.MM.SS) or a code, not a date. "12.03.24" stays a date.
    if (sep.startsWith('.') && !yearFirst && c.length === 2 && B > 12) return null;
    // "01-23-45", "ext 01-23-45": a dash date whose two-digit year is more
    // than ten years ahead is a phone extension or a code ("22-03-24" and
    // "22-03-99" stay dates). Code words are checked by the caller.
    const yy = yearFirst ? a : c;
    if (sep === '-' && yy.length === 2 && expandYear(yy) > new Date(nowMs).getUTCFullYear() + 10) return null;
  }

  // Year first: yyyy-M-d, yy/MM/dd (when the first part cannot be a day).
  if (yearFirst) {
    if (!timed && a.length === 2 && dotOrDash && b.length === 1 && c.length === 1) return null;
    const y = a.length === 4 ? A : expandYear(a);
    let [mo, d] = [B, C];
    // yyyy.d.M ("1999.22.3"): only with dots, and only when the month cannot be first.
    if (B > 12 && C <= 12 && sep.startsWith('.')) [mo, d] = [C, B];
    if (isRealDate(y, mo, d)) return { y, mo, d, ambiguous: false, order: 'dmy' };
    return a.length === 4 ? 'bad' : null;
  }
  // Year last: d/M/y or M/d/y.
  if (a.length <= 2 && b.length <= 2 && (c.length === 4 || c.length === 2)) {
    if (!timed && c.length === 2 && dotOrDash && a.length === 1 && b.length === 1) return null;
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
    scan(regex, src, ctx, (m) => {
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
    scan(regex, src, ctx, (m) => {
      const g = (m.groups ?? {}) as Record<string, string | undefined>;
      // "on 22 March 1999": the leading word is not part of the date. Nor is
      // a weekday abbreviation that is also a month ("Mar", Spanish martes):
      // in "Mar 3 Mar 2024" it is the month of a date written twice.
      const weekday = g.wd !== undefined && isWeekdayName(g.wd) && monthFromLocalName(g.wd) === undefined;
      const start = g.wd !== undefined && !weekday ? (/^\S+[ \t]+/.exec(m[0])?.[0].length ?? 0) : 0;
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
    const timed = g.h !== undefined || g.h2 !== undefined || g.h3 !== undefined;
    // "lot 11-12-13", "ext 12-03-24": a dash triple after a code word is the code.
    if (!timed && g.sep === '-' && (g.c ?? '').length <= 2 && labelledBefore(src, m.index, CODE_ID_BEFORE)) return null;
    const date = numericDate(g, order, timed, ctx.nowMs ?? Date.now());
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
      parsed: {
        ...parsed,
        dateOrder: {
          order: date.order,
          // As written, in the source's wall clock: never converted to a zone.
          date: { y: date.y, mo: date.mo, d: date.d },
          alternate: { epochMs: alt.epochMs, order: other, date: { y: date.y, mo: date.d, d: date.mo } },
        },
      },
      length: text.length,
    };
  };
  return [...scan(RE_NUMERIC, src, ctx, convert), ...scan(RE_NUMERIC_TIME_FIRST, src, ctx, convert)];
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
      'YYYY-MM-DD with an optional time, fraction (. or ,) and zone (Z, ±hh:mm, ±hh, UTC, EST, GMT+1, [Europe/Paris], or Europe/Paris after a space). A date alone may carry an offset or "AD". 24:00 is the end of the day. Without a zone the time is read in your home zone.',
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
      scan(RE_ISO, src, ctx, (m) => {
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
        // "2024-03-22-001": a date followed by "-digits" is an id, but
        // "2024-03-22-2024-03-25" is a range of two dates.
        const rest = src.slice(m.index + m[0].length);
        if (dateOnly && /^-\d/.test(rest) && !/^-\d{4}-\d{2}-\d{2}(?!\d)/.test(rest)) return VETO;
        let zone: ResolvedZone | null = zoneTok ? resolveZoneToken(zoneTok) : null;
        let text = m[0];
        if (g.sp) {
          // "2024-03-10 02:30 [America/New_York]", "... America/New_York":
          // a real IANA zone one space after the time. Anything after it
          // (a second bracket) is not part of the timestamp.
          const name = g.sbrz ?? g.bare ?? '';
          const end = m[0].length - (g.br?.length ?? 0);
          if (resolveZone(name)?.kind === 'iana') {
            zone = { iana: name, label: name, today: name };
            text = m[0].slice(0, end);
          } else text = m[0].slice(0, end - g.sp.length);
        } else if (g.br) {
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
      scan(RE_ORDINAL, src, ctx, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const ymd = ordinalDate(Number(g.y), Number(g.doy));
        if (!ymd) return null;
        if (g.h === undefined) {
          // "PR 2024-123", "Invoice No. 2024-001": an id, not day 123 of 2024.
          if (labelledBefore(src, m.index, ORDINAL_ID_BEFORE)) return null;
          return dateWithOffset(ymd, g.off, m[0], ctx, 'iso-ordinal', 'ISO 8601 ordinal date');
        }
        // "2024-123T10:00Z": with a time it is a full ISO timestamp.
        if (badOffset(g.off)) return VETO;
        const zone = resolveZoneToken(g.off);
        const parsed = buildParsed(
          { ...ymd, h: Number(g.h), mi: Number(g.mi), s: Number(g.s ?? 0), ms: fractionMs(g.f) },
          zone,
          ctx.assumedZone,
          { matchedText: m[0], kind: zone ? 'iso' : 'iso-no-tz', formatId: 'iso-ordinal', formatLabel: 'ISO 8601 ordinal date' },
        );
        return parsed ? { parsed } : VETO;
      }),
  },
  {
    id: 'iso-week',
    label: 'ISO 8601 week date',
    description:
      'Year, ISO week and weekday (1 = Monday): 1999-W13-2 or 1999W132 is Tuesday 30 March 1999. Without a weekday (2024-W01, hyphenated form only), the Monday.',
    examples: ['1999-W13-2', '1999W132', '2024-W01'],
    regex: RE_WEEK,
    match: (src, ctx) =>
      scan(RE_WEEK, src, ctx, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        // "SKU 2024W012", "Order #2024-W01": a product code or an id.
        if (labelledBefore(src, m.index, CODE_ID_BEFORE)) return null;
        // "2020W10", "2024W01": without the hyphen, only a full week date
        // with its weekday ("1999W132") is clearly a date.
        if (g.w2 !== undefined && g.dw2 === undefined) return null;
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
      scan(RE_COMPACT, src, ctx, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        const ymd = { y: Number(g.y), mo: Number(g.mo), d: Number(g.d) };
        if (!isRealDate(ymd.y, ymd.mo, ymd.d)) return null;
        // "Order #20240115", "SKU 20240115": an id that happens to look like a date.
        if (labelledBefore(src, m.index, CODE_ID_BEFORE)) return null;
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
      scan(RE_DATE_SLASH, src, ctx, (m) => {
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
      scan(RE_UNIX, src, ctx, (m) => {
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
    description:
      'Year 年 month 月 day 日, with an optional weekday (星期一, 月曜日), time (上午05时06分07秒, 5時06分) and zone. A Japanese era year (平成11年, 令和元年) is converted.',
    examples: ['1999年3月22日', '1999年3月22日 星期一 上午05时06分07秒 CET', '1999年3月22日 5時06分07秒', '平成11年3月22日'],
    regex: RE_CJK,
    match: (src, ctx) =>
      scan(RE_CJK, src, ctx, (m) => {
        const g = (m.groups ?? {}) as Record<string, string | undefined>;
        let y: number;
        if (g.era !== undefined) {
          // 昭和64年1月8日 does not exist (it is 平成元年): refuse the whole span.
          const era = japaneseEraYear(g.era, g.eraYear ?? '', Number(g.mo), Number(g.day));
          if (era === null) return VETO;
          y = era;
        } else y = g.year!.length === 2 ? expandYear(g.year!) : Number(g.year);
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
      'A time with a colon, am/pm or a zone (also Europe/Paris), taken as today. Ignored when it follows a date no format recognized, and a lone number like "5", a verse ("John 3:16"), a ratio ("1:30 odds") or a lap time ("1:23.456") is ignored.',
    examples: ['3pm', '15:30', '11:00 p.m.', '9:00 UTC', '9:00 GMT+5:30', '3 PM ET', '3:30 PM +05:45'],
    regex: RE_TIME,
    match: (src, ctx) =>
      scan(RE_TIME, src, ctx, (m) => {
        const [, hTok, miTok, sTok, ampm, brTok, bareTok, zoneTok] = m;
        if (dateLikeBefore(src, m.index)) return null;
        // "10:00 +15:00": refuse the whole span so "15:00" is not read next.
        if (badOffset(zoneTok)) return VETO;
        // "10:00 Europe/Paris", "10:00 [Asia/Tokyo]": only a real IANA zone counts.
        const ianaTok = brTok ?? bareTok;
        const iana = ianaTok !== undefined && resolveZone(ianaTok)?.kind === 'iana' ? ianaTok : null;
        const zone: ResolvedZone | null = iana ? { iana, label: iana, today: iana } : resolveZoneToken(zoneTok);
        // A bare H:MM (no seconds, am/pm or zone) can be many things that are not a time of day.
        if (miTok !== undefined && sTok === undefined && !ampm && !zone) {
          const end = m.index + (hTok ?? '').length + 1 + miTok.length; // just after "H:MM"
          // "Lap 1:23.456", "split 0:59.87": minutes, seconds and a fraction is a duration.
          if (/^\.\d/.test(src.slice(end))) return VETO;
          const before = src.slice(Math.max(0, m.index - 40), m.index);
          const line = before.slice(before.lastIndexOf('\n') + 1);
          // "Romans 8:28", "1 John 3:16", "odds of 1:30", "1:30 odds".
          const after = src.slice(end, end + 20);
          if (scriptureBefore(line, hTok ?? '', miTok, after)) {
            // "2 Peter 1:16-2:10": the verse range claims its end too.
            const range = TIME_RANGE_AFTER.exec(after);
            return range ? { veto: end - m.index + range[0].length } : null;
          }
          if (RATIO_BEFORE.test(line) || RATIO_AFTER.test(after)) return null;
        }
        // Need an am/pm marker, a colon, or a real zone; "5" alone is not a
        // time. A bare number before a two-letter name ("3 CT scans",
        // "Apollo 11 MT") is a count, not a time.
        const strongZone = zone !== null && (zoneTok?.length ?? 0) >= 3;
        if (!(ampm || miTok !== undefined || strongZone)) return null;
        // "24:00" is the end of today (tomorrow 00:00); buildParsed checks the minutes.
        const hour = clockHour(Number(hTok), ampm);
        if (hour === null) return null;
        let text = trimUnresolvedZone(m[0], zoneTok, zone !== null);
        if (ianaTok !== undefined && !iana) {
          const tok = brTok !== undefined ? `[${brTok}]` : ianaTok;
          text = text.slice(0, text.length - tok.length).trimEnd();
        }
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
        // An impossible time ("24:30", "10:59:60") refuses its whole span, so
        // the offset after it ("+05:45") is not read as a time on its own.
        return parsed ? { parsed, length: text.length } : VETO;
      }),
  },
];

export const BUILTIN_FORMAT_IDS: readonly string[] = BUILTIN_FORMATS.map((f) => f.id);
