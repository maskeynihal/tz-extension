import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { compileTokenFormat } from '../src/lib/custom-formats';
import { resolveZoneToken } from '../src/lib/time-tokens';
import { ZONE_ABBREVIATIONS } from '../src/lib/tz';
import type { CustomFormat, NumericDateOrder } from '../src/types';

/** Round-5 parser fixes: sourceIndex, citation verbs, verse ranges, abbreviations, Java tokens. */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const at = (text: string, order: NumericDateOrder = 'dmy', customFormats: CustomFormat[] = []) =>
  parseTimes(text, { assumedZone: 'UTC', numericDateOrder: order, nowMs: NOW, customFormats });
const texts = (text: string) => at(text).map((p) => p.matchedText);
const iso = (ms: number) => new Date(ms).toISOString();

const custom = (pattern: string, id = 'c1'): CustomFormat => ({ id, label: pattern, pattern, advanced: false, enabled: true });

describe('sourceIndex', () => {
  // A spread of the review corpus and the Talend examples.
  const corpus = [
    '2024-01-02T15:04:05Z',
    '2024-01-02 15:04 UTC',
    'Starts 9:00, deadline 2024-01-02T15:00Z',
    'Standup 9:00, demo 16:30',
    '1700000000',
    'id 1700000000 at 10:00',
    '1999-03-22T05:06:07,000[Europe/Paris]',
    '2024-01-02 Meeting',
    '2024-03-10 02:30 [America/New_York] [x]',
    '22.03.1999 um 05:06 MEZ',
    '05:06 22/03/99',
    '3/22/99 5:06 AM',
    'Wednesday, October 28, 2026, 04:24:09 UTC',
    'on 22 March 1999',
    'Montag, 22. März 1999 05:06 Uhr MEZ',
    'lundi 22 mars 1999 5 h 06 CET',
    'Mon Mar 22 05:06:07 CET 1999',
    '1999年3月22日 星期一 上午05时06分07秒 CET',
    '平成11年3月22日',
    'Jan 1, 1970 UTC AM',
    '9:00 GMT+5:30 and 10:00 Europe/Paris',
    '10:00 Meeting room 3pm',
    'Daniel 9:17-9:45',
    '10:00 UTC−05:00',
    'UTC−5 10:00 −0500',
    'Logged 19990322+0100 done.',
    'Logged 1999-081+01:00 done.',
    'Logged 1999W132 done.',
    'Logged 22.3.99 5.06 done.',
    "Logged Monday, March 22, 1999 5:06:07 o'clock AM CET done.",
    'Logged Mon, 22 Mar 1999 05:06:07 +0100 done.',
    'Logged 99. 3. 22 done.',
    'Logged 99-3-22 上午5:06 done.',
    'Logged 22-Mar-99 05.06.07.000000888 AM done.',
  ];
  const variants = (t: string) => [t, `  \n\t${t}  `, ` \u00a0${t}`, t.replace(/-/g, '\u2212'), `\n ${t.replace(/-/g, '\u2212')}`];

  it('every result points at its matched text in the untrimmed input', () => {
    let checked = 0;
    for (const base of corpus) {
      for (const t of variants(base)) {
        for (const order of ['dmy', 'mdy'] as const) {
          for (const p of at(t, order)) {
            expect(typeof p.sourceIndex, t).toBe('number');
            expect(t.slice(p.sourceIndex!, p.sourceIndex! + p.matchedText.length), t).toBe(p.matchedText);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('counts leading whitespace and keeps U+2212 in the matched text', () => {
    const [p] = at('   \n10:00 UTC\u221205:00');
    expect(p?.matchedText).toBe('10:00 UTC\u221205:00');
    expect(p?.sourceIndex).toBe(4);
  });

  it('results stay best-first; sourceIndex gives reading order', () => {
    const r = at('Starts 9:00, deadline 2024-01-02T15:00Z');
    expect(r.map((p) => p.matchedText)).toEqual(['2024-01-02T15:00Z', '9:00']);
    expect(r.map((p) => p.sourceIndex)).toEqual([22, 7]);
  });

  it('is set on custom-format results', () => {
    const t = '  Logged 15~07~2024 10:30 done';
    const [p] = at(t, 'dmy', [custom('DD~MM~YYYY HH:mm')]);
    expect(p?.formatId).toBe('c1');
    expect(p?.sourceIndex).toBe(9);
    expect(t.slice(p!.sourceIndex!, p!.sourceIndex! + p!.matchedText.length)).toBe(p!.matchedText);
  });

  it('is set on custom-format results read from text with U+2212', () => {
    const t = ' x 10:00 UTC\u22125';
    const [p] = at(t, 'dmy', [custom('HH:mm TZ')]);
    expect(p?.matchedText).toBe('10:00 UTC\u22125');
    expect(t.slice(p!.sourceIndex!, p!.sourceIndex! + p!.matchedText.length)).toBe(p!.matchedText);
  });
});

describe('citation verbs (review #3)', () => {
  it.each([
    ['see John 9:41 tomorrow', ['9:41']],
    ["I'll see John 3:47 today", ['3:47']],
    ['We will see Mark 4:12', ['4:12']],
    ['He said see John 3:16', ['3:16']],
    ['We will See John 3:16', ['3:16']],
    // a schedule word after still says time, after a verb too
    ['Read John 3:16 today', ['3:16']],
    ['Read John 3:16 tomorrow', ['3:16']],
    ['See Peter 3:47 meeting', ['3:47']],
  ])('%s is a time', (text, want) => {
    expect(texts(text)).toEqual(want);
  });

  it.each([
    'See John 3:16',
    'Please see John 3:16.',
    'Read Mark 4:39',
    'Compare Luke 2:11',
    'cf. Luke 2:11',
    'Cf. Luke 2:11',
    'Quoted John 3:16',
    'Notes. See John 3:16',
    'Notes; See John 3:16',
    'Notes: See John 3:16',
    '(See John 3:16)',
    '“See John 3:16”',
  ])('%s is a verse', (text) => {
    expect(at(text)).toEqual([]);
  });
});

describe('book numbers, chapter ranges and hours of 13 or more (review #4)', () => {
  it.each([
    '2 Peter 1:16-2:10',
    '2 Peter 1:17-1:45',
    'Matthew 5:17-7:12',
    '1 John 09:41',
    'chapter John 3:31-4:30',
    // hour ≥ 13 after a citation verb
    'See John 15:13',
    'Read John 14:07',
  ])('%s is a verse (both halves of a range)', (text) => {
    expect(at(text)).toEqual([]);
  });

  it.each([
    ['John 15:13', ['15:13']],
    ['Peter 14:07 joined the call', ['14:07']],
    // a time range: the end is on whole five minutes or zero-padded
    ['Daniel 9:17-9:45', ['9:17', '9:45']],
    ['See Daniel 9:17-9:45', ['9:17', '9:45']],
    ['John 3:31–4:30', ['3:31', '4:30']],
    ['Mark 3:17-04:12', ['3:17', '04:12']],
  ])('%s is a time', (text, want) => {
    expect(texts(text)).toEqual(want);
  });

  it('other books keep reading ranges as verses', () => {
    expect(at('Romans 8:28-9:3')).toEqual([]);
    expect(at('Romans 8:28-9:13')).toEqual([]);
  });
});

describe('zone abbreviations the zone search offers (QA N5)', () => {
  it('reads CHADT and CHAST', () => {
    const [d] = at('2024-07-15 12:00 CHADT');
    expect(d?.matchedText).toBe('2024-07-15 12:00 CHADT');
    expect(iso(d!.epochMs)).toBe('2024-07-14T22:15:00.000Z');
    const [s] = at('2024-07-15 12:00 CHAST');
    expect(iso(s!.epochMs)).toBe('2024-07-14T23:15:00.000Z');
    expect(texts('Call at 9:00 CHADT')).toEqual(['9:00 CHADT']);
  });

  /** Region-suffixed codes cannot appear in text as written. */
  const REGION_SUFFIXED = ['IST-IE', 'CST-CN'];
  /** Everyday words, left unread on purpose ("12:30 eat", "3pm Art class"). */
  const WORDLIKE = ['WET', 'WEST', 'CAT', 'EAT', 'ART'];

  it('lists exactly the codes it skips', () => {
    const codes = ZONE_ABBREVIATIONS.map((a) => a.code);
    for (const c of [...REGION_SUFFIXED, ...WORDLIKE]) expect(codes).toContain(c);
    for (const c of WORDLIKE) expect(resolveZoneToken(c)).toBeNull();
  });

  it.each(ZONE_ABBREVIATIONS.filter((a) => !REGION_SUFFIXED.includes(a.code) && !WORDLIKE.includes(a.code)).map((a) => [a.code, a] as const))(
    '%s is read with its offset',
    (code, a) => {
      const text = `2024-07-15 12:00 ${code}`;
      const [p] = at(text);
      expect(p?.matchedText).toBe(text);
      expect(p?.assumed).toBe(false);
      if (a.minutes !== undefined) {
        expect(p!.epochMs).toBe(Date.UTC(2024, 6, 15, 12) - a.minutes * 60_000);
      } else {
        const [ref] = at(`2024-07-15 12:00 [${a.iana}]`);
        expect(p!.epochMs).toBe(ref!.epochMs);
      }
    },
  );
});

describe('Java/Talend tokens in custom formats (QA N11)', () => {
  it.each([
    ['yyyy~MM~dd HH:mm', 'Logged 2024~07~15 10:30 done', '2024~07~15 10:30'],
    ['dd~MM~yyyy HH:mm', 'Logged 15~07~2024 10:30 done', '15~07~2024 10:30'],
    ["yyyy-MM-dd'T'HH:mm", 'Logged 2024-07-15T10:30 done', '2024-07-15T10:30'],
    ['d/M/yy HH:mm', 'Logged 15/7/24 10:30 done', '15/7/24 10:30'],
  ])('%s is accepted', (pattern, text, matched) => {
    const c = compileTokenFormat(pattern);
    expect(c.ok).toBe(true);
    expect(c.ok && c.warnings).toEqual([]);
    const [p] = at(text, 'dmy', [custom(pattern)]);
    expect(p?.formatId).toBe('c1');
    expect(p?.matchedText).toBe(matched);
    expect(iso(p!.epochMs)).toBe('2024-07-15T10:30:00.000Z');
  });

  it("reads quoted literals, with '' as one quote", () => {
    const [p] = at("Back 10:30 o'clock", 'dmy', [custom("HH:mm 'o''clock'")]);
    expect(p?.matchedText).toBe("10:30 o'clock");
    const [q] = at('15.07.2024 at 10:30', 'dmy', [custom("dd.MM.yyyy 'at' HH:mm")]);
    expect(q?.formatId).toBe('c1');
    expect(q?.matchedText).toBe('15.07.2024 at 10:30');
  });

  it('keeps an unclosed apostrophe as a literal', () => {
    expect(compileTokenFormat("HH:mm o'clock").ok).toBe(true);
    const [p] = at("Back 10:30 o'clock", 'dmy', [custom("HH:mm o'clock")]);
    expect(p?.matchedText).toBe("10:30 o'clock");
  });

  it('names the clash when an alias repeats a field', () => {
    const r = compileTokenFormat('yyyy-MM-dd YYYY');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/"YYYY" repeats the year \(already set by "yyyy"\)/);
  });
});
