import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { compileTokenFormat, matchCustomFormat } from '../src/lib/custom-formats';
import { normalizeForMatching, normalizeSpaces } from '../src/lib/time-tokens';
import type { CustomFormat, ParsedTime } from '../src/types';

/** Round-6 parser fixes: odd spaces, book numbers, custom-format compatibility, Java letters. */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const at = (text: string, customFormats: CustomFormat[] = [], assumedZone = 'Asia/Tokyo') =>
  parseTimes(text, { assumedZone, numericDateOrder: 'dmy', nowMs: NOW, customFormats });
const texts = (text: string) => at(text, [], 'UTC').map((p) => p.matchedText);
const iso = (ms: number) => new Date(ms).toISOString();
const custom = (pattern: string, id = 'c1'): CustomFormat => ({ id, label: pattern, pattern, advanced: false, enabled: true });

/** The match is the text at its sourceIndex, character for character. */
function expectSourced(text: string, p: ParsedTime | undefined): void {
  expect(p).toBeDefined();
  const i = p!.sourceIndex ?? -1;
  expect(text.slice(i, i + p!.matchedText.length)).toBe(p!.matchedText);
}

describe('no-break and thin spaces read as spaces (QA F1)', () => {
  const NBSP = '\u00A0';
  const NNBSP = '\u202F';
  it.each([
    [`2024-10-02 13:30${NBSP}UTC`, '2024-10-02T13:30:00.000Z'],
    [`2024-10-02${NBSP}13:30${NBSP}UTC`, '2024-10-02T13:30:00.000Z'],
    [`Oct 2, 2024, 1:30${NNBSP}PM UTC`, '2024-10-02T13:30:00.000Z'],
    [`Oct 2, 2024, 1:30${NNBSP}PM${NBSP}UTC`, '2024-10-02T13:30:00.000Z'],
    [`12:30 PM${NBSP}UTC`, '2026-11-01T12:30:00.000Z'],
    [`12:30${NBSP}EST`, '2026-11-01T17:30:00.000Z'],
    [`12:30\u2009UTC`, '2026-11-01T12:30:00.000Z'],
    [`12:30\u2007UTC`, '2026-11-01T12:30:00.000Z'],
    [`12:30\u200AUTC`, '2026-11-01T12:30:00.000Z'],
    [`3:30${NNBSP}p.m. UTC`, '2026-11-01T15:30:00.000Z'],
  ])('%j', (text, want) => {
    const [p] = at(text);
    expect(p).toBeDefined();
    expect(iso(p!.epochMs)).toBe(want);
    expect(p!.assumed).toBeFalsy();
    // The match keeps the page's own characters and position.
    expect(p!.matchedText).toBe(text);
    expect(p!.sourceIndex).toBe(0);
  });

  it('gives the same answer as a plain space, keeping the original characters', () => {
    const plain = 'Meeting on Oct 2, 2024, 1:30 PM UTC then 12:30 EST.';
    const odd = 'Meeting on Oct\u00A02, 2024,\u00A01:30\u202FPM\u00A0UTC then 12:30\u2009EST.';
    const a = at(plain);
    const b = at(odd);
    expect(b.map((p) => p.epochMs)).toEqual(a.map((p) => p.epochMs));
    expect(b.map((p) => p.sourceIndex)).toEqual(a.map((p) => p.sourceIndex));
    for (const p of b) expectSourced(odd, p);
    expect(b[0]!.matchedText).toBe('Oct\u00A02, 2024,\u00A01:30\u202FPM\u00A0UTC');
  });

  it('keeps sourceIndex counted from the untrimmed text', () => {
    const text = '\u00A0 Due\u00A02024-10-02 13:30\u00A0UTC';
    const [p] = at(text);
    expectSourced(text, p);
    expect(p!.sourceIndex).toBe(6);
  });

  it('works in custom formats', () => {
    const text = 'Run 02.10.2024\u00A013:30\u00A0UTC done';
    const [p] = at(text, [custom('DD.MM.YYYY HH:mm TZ')]);
    expect(p?.formatId).toBe('c1');
    expect(iso(p!.epochMs)).toBe('2024-10-02T13:30:00.000Z');
    expect(p!.matchedText).toBe('02.10.2024\u00A013:30\u00A0UTC');
    expectSourced(text, p);
    const [q] = matchCustomFormat('9:30\u202FPM', custom('h:mm A'), { assumedZone: 'UTC', dateOnlyPolicy: 'midnight', nowMs: NOW });
    expect(q?.parsed.matchedText).toBe('9:30\u202FPM');
    expect(iso(q!.parsed.epochMs)).toBe('2026-11-01T21:30:00.000Z');
  });

  it('replaces one character for one', () => {
    const s = 'a\u00A0b\u202Fc\u2009d\u2007e\u200Af\u3000g \u2212 h';
    expect(normalizeSpaces(s)).toBe('a b c d e f g \u2212 h');
    expect(normalizeForMatching(s)).toBe('a b c d e f g - h');
    expect(normalizeForMatching(s).length).toBe(s.length);
    // A zero-width space is not a space: "13\u200B:45" stays unread.
    expect(normalizeSpaces('13\u200B:45')).toBe('13\u200B:45');
  });
});

describe('a book number does not outrank :00 or a zero-padded hour (review #6)', () => {
  it.each([
    ['1 John 10:00-11:30', ['10:00', '11:30']],
    ['Shift 1 John 10:00-11:00', ['10:00', '11:00']],
    ['1 John 09:00-10:00', ['09:00', '10:00']],
    ['Room 2 Peter 10:00-11:00', ['10:00', '11:00']],
    ['1 Samuel 9:00-9:45', ['9:00', '9:45']],
    // There is no chapter 09. (parser-r5 listed this as a verse in round 5.)
    ['1 John 09:41', ['09:41']],
  ])('%s gives the times', (text, want) => {
    expect(texts(text)).toEqual(want);
  });

  it.each(['1 John 3:16', '2 Peter 1:16-2:10', '2 Peter 1:17-1:45', 'See 1 John 4:19', '1 John 3:16 meeting'])(
    '%s stays a verse',
    (text) => {
      expect(texts(text)).toEqual([]);
    },
  );
});

describe('lower-case zone abbreviations stay unread (QA F11)', () => {
  // On purpose: "est", "cat", "wat", "art" and "chadt"-like strings are
  // everyday words or typos far more often than zones. Capitals or UTC/GMT
  // in any case are read.
  it.each(['2024-07-15 12:00 chadt', '2024-07-15 12:00 est', '9:00 est', '3pm cat'])('%s does not read the zone', (text) => {
    const [p] = at(text, [], 'UTC');
    expect(p).toBeDefined();
    expect(p!.assumed).toBe(true);
    expect(p!.matchedText).not.toMatch(/chadt|est|cat/);
  });

  it('capitals are read', () => {
    const [p] = at('2024-07-15 12:00 CHADT', [], 'UTC');
    expect(iso(p!.epochMs)).toBe('2024-07-14T22:15:00.000Z');
    const [q] = at('2024-07-15 12:00 utc', [], 'Asia/Tokyo');
    expect(q!.assumed).toBeFalsy();
  });
});

describe('custom formats saved before the Java spellings read as before (review #2)', () => {
  const ctx = { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' as const, nowMs: NOW };
  const run = (pattern: string, text: string) => matchCustomFormat(text, custom(pattern), ctx).map((c) => c.parsed.matchedText);

  // The review's cf.mjs list: every pattern that compiled in the base, with
  // what the base matched in the sample (cf.log).
  it.each([
    ['HH:mm today', 'at 10:30 today', ['10:30 today'], true],
    ['HH:mm [UTC] today', 'at 10:30 UTC today', ['10:30 UTC today'], true],
    ['den DD.MM.YYYY HH:mm', 'den 22.03.1999 05:06', ['den 22.03.1999 05:06'], true],
    ['YYYY-MM-DD HH:mm UTC', '2024-01-02 10:00 UTC', ['2024-01-02 10:00 UTC'], true],
    ["MMM D 'YY", "Jan 5 '24", ["Jan 5 '24"], false],
    ["MMM D 'YY HH:mm", "Jan 5 '24 10:00", ["Jan 5 '24 10:00"], false],
    ["D MMM 'YY, h:mm A o'clock", "5 Jan '24, 9:30 PM o'clock", ["5 Jan '24, 9:30 PM o'clock"], true],
    ["HH:mm [o'clock]", "10:30 o'clock", ["10:30 o'clock"], false],
    ["HH:mm o'clock", "10:30 o'clock", ["10:30 o'clock"], true],
    // Round 7 (QA G8): dddd is moment's weekday name. The base matched the
    // letters "dddd" literally, so this pattern never read a real date.
    ['dddd D MMM YYYY', 'Monday 5 Jan 2024', ['Monday 5 Jan 2024'], false],
    ['MM/DD/YYYY HH:mm daily', '01/05/2024 10:00 daily', ['01/05/2024 10:00 daily'], true],
    ['HH:mm [GMT]', '10:00 GMT', ['10:00 GMT'], false],
    ['YYYY-MM-DD HH:mm (yyyy)', '2024-01-02 10:00 (yyyy)', ['2024-01-02 10:00 (yyyy)'], true],
    // Quotes around no letters are matched as written.
    ["'(.*)+$' HH:mm", '(.*)+$ 10:00', [], false],
    ["'(.*)+$' HH:mm", "'(.*)+$' 10:00", ["'(.*)+$' 10:00"], false],
    // Round 7 (QA G9): '' is Java's one quote, and two quotes still read.
    ["''HH:mm''", "'10:00'", ["'10:00'"], false],
    ["''HH:mm''", "''10:00''", ["''10:00''"], false],
  ])('%s', (pattern, text, want, warns) => {
    const c = compileTokenFormat(pattern);
    expect(c.ok).toBe(true);
    expect(c.ok && c.warnings.length > 0).toBe(warns);
    expect(run(pattern, text)).toEqual(want);
  });

  it('still refuses what the base refused, and names a clash', () => {
    expect(compileTokenFormat('DD.MM.YYYY HH:mm Uhr').ok).toBe(false);
    expect(compileTokenFormat('HH:mm GMT').ok).toBe(false);
    const r = compileTokenFormat('yyyy-MM-dd YYYY');
    expect(!r.ok && r.error).toMatch(/"YYYY" repeats the year \(already set by "yyyy"\)/);
  });

  it('a quoted word is literal (Java), so its quotes are not matched', () => {
    // The one change from the base: it matched the quotes themselves.
    expect(run("'at' HH:mm", 'at 10:00')).toEqual(['at 10:00']);
    expect(run("HH 'h' mm", '10 h 30')).toEqual(['10 h 30']);
    expect(run("HH:mm 'o''clock'", "10:30 o'clock")).toEqual(["10:30 o'clock"]);
  });

  it('a lower-case Java letter touched only by tokens is a token', () => {
    expect(run('yyyyMMddHHmm', '202407151030')).toEqual(['202407151030']);
    expect(run('yyyy-MM-ddTHH:mm', '2024-07-15T10:30')).toEqual(['2024-07-15T10:30']);
  });
});

describe('more Java/Talend letters (QA F10)', () => {
  const ctx = { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' as const, nowMs: NOW };
  const first = (pattern: string, text: string) => matchCustomFormat(text, custom(pattern), ctx)[0]?.parsed;

  it.each([
    ['yyyy/MM/dd hh:mm a', '2024/07/15 09:30 PM', '2024-07-15T21:30:00.000Z'],
    ['hh:mm a', '09:30 am', '2026-11-01T09:30:00.000Z'],
    ['EEE, dd MMM yyyy HH:mm:ss', 'Mon, 15 Jul 2024 10:30:05', '2024-07-15T10:30:05.000Z'],
    ['EEEE, dd MMMM yyyy HH:mm', 'Monday, 15 July 2024 10:30', '2024-07-15T10:30:00.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ss.SSSXXX", '2024-07-15T10:30:05.250+05:45', '2024-07-15T04:45:05.250Z'],
    ["yyyy-MM-dd'T'HH:mm:ssXXX", '2024-07-15T10:30:05Z', '2024-07-15T10:30:05.000Z'],
    ["yyyy-MM-dd'T'HH:mmXX", '2024-07-15T10:30-0500', '2024-07-15T15:30:00.000Z'],
    ["yyyy-MM-dd'T'HH:mmX", '2024-07-15T10:30+02', '2024-07-15T08:30:00.000Z'],
    ['dd MMM yyyy HH:mm z', '15 Jul 2024 10:30 EST', '2024-07-15T15:30:00.000Z'],
    ['dd MMM yyyy HH:mm zzz', '15 Jul 2024 10:30 UTC', '2024-07-15T10:30:00.000Z'],
  ])('%s reads %s', (pattern, text, want) => {
    const c = compileTokenFormat(pattern);
    expect(c.ok).toBe(true);
    expect(c.ok && c.warnings).toEqual([]);
    const p = first(pattern, text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
  });

  it('EEE must be a weekday name', () => {
    expect(first('EEE, dd MMM yyyy HH:mm', 'Foo, 15 Jul 2024 10:30')).toBeUndefined();
  });

  it('the letters stay literal inside words, and "a.m." stays literal', () => {
    // "Uhrzeit" has a z touched by letters; "a.m." is written out.
    const c = compileTokenFormat('HH:mm a.m.');
    expect(c.ok).toBe(true);
    expect(first('HH:mm a.m.', '10:30 a.m.')?.matchedText).toBe('10:30 a.m.');
    expect(compileTokenFormat('HH:mm [Uhr]zeit').ok).toBe(true);
  });

  it('a and A, or z and TZ, set the same field: the older literal reading is kept', () => {
    // Read the new way these repeat a field; the base read the lower-case
    // letter literally, so the pattern compiles that way, with the warning.
    for (const pattern of ['hh:mm a A', 'HH:mm z TZ']) {
      const c = compileTokenFormat(pattern);
      expect(c.ok).toBe(true);
      expect(c.ok && c.warnings.join(' ')).toMatch(/matched literally/);
    }
    expect(first('hh:mm a A', '09:30 a PM')?.matchedText).toBe('09:30 a PM');
  });
});
