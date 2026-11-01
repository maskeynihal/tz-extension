import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { compileTokenFormat, matchCustomFormat, TOKEN_REFERENCE } from '../src/lib/custom-formats';
import type { CustomFormat } from '../src/types';

/** Round-7 custom-format tokens: Java Z (QA G6), ddd/dddd, DDD, SSSSSS (QA G8), '' (QA G9). */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const ctx = { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' as const, nowMs: NOW };
const custom = (pattern: string, id = 'c1'): CustomFormat => ({ id, label: pattern, pattern, advanced: false, enabled: true });
const all = (pattern: string, text: string) => matchCustomFormat(text, custom(pattern), ctx).map((c) => c.parsed);
const first = (pattern: string, text: string) => all(pattern, text)[0];
const iso = (ms: number) => new Date(ms).toISOString();
const error = (pattern: string): string => {
  const c = compileTokenFormat(pattern);
  return c.ok ? '' : c.error;
};

/** Compiles with no warning, and reads `text` whole as `want`. */
function expectReads(pattern: string, text: string, want: string, assumed = false): void {
  const c = compileTokenFormat(pattern);
  expect(c.ok, pattern).toBe(true);
  expect(c.ok && c.warnings, pattern).toEqual([]);
  const p = first(pattern, text);
  expect(p?.matchedText, pattern).toBe(text);
  expect(iso(p!.epochMs)).toBe(want);
  expect(Boolean(p!.assumed)).toBe(assumed);
}

describe('Java Z, the RFC 822 offset (QA G6)', () => {
  it.each([
    ["yyyy-MM-dd'T'HH:mm:ssZ", '2024-03-05T14:05:06+0100', '2024-03-05T13:05:06.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ssZ", '2024-03-05T14:05:06-0530', '2024-03-05T19:35:06.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ssZ", '2024-03-05T14:05:06Z', '2024-03-05T14:05:06.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ssZ", '2024-03-05T14:05:06+0000', '2024-03-05T14:05:06.000Z'],
    ['yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 +0545', '2024-03-05T08:20:00.000Z'],
    ['yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 +05:45', '2024-03-05T08:20:00.000Z'],
    ['YYYY-MM-DD HH:mm:ss Z', '2024-01-02 10:00:00 +0545', '2024-01-02T04:15:00.000Z'],
    ['EEE, dd MMM yyyy HH:mm:ss Z', 'Tue, 05 Mar 2024 14:05:06 -0800', '2024-03-05T22:05:06.000Z'],
    // Touched only by tokens, like the other Java letters.
    ['yyyyMMddHHmmssZ', '20240305140506+0100', '2024-03-05T13:05:06.000Z'],
  ])('%s reads %s', (pattern, text, want) => expectReads(pattern, text, want));

  it('an ISO pattern saved with a literal Z still matches, now read as UTC', () => {
    // Before, Z was a literal letter (with a warning) and the time was read
    // in the home zone; "Z" is UTC, which is what the text says.
    const p = matchCustomFormat('2024-03-05T14:05:06.123Z', custom('YYYY-MM-DDTHH:mm:ss.SSSZ'), {
      ...ctx,
      assumedZone: 'Asia/Tokyo',
    })[0]?.parsed;
    expect(p?.matchedText).toBe('2024-03-05T14:05:06.123Z');
    expect(iso(p!.epochMs)).toBe('2024-03-05T14:05:06.123Z');
    expect(compileTokenFormat('YYYY-MM-DDTHH:mm:ss.SSSZ')).toMatchObject({ ok: true, warnings: [] });
  });

  it('a Z that is only a letter keeps working (compile fallback)', () => {
    // Z next to TZ would set the zone twice: the older literal reading is kept.
    const c = compileTokenFormat('HH:mm TZ (Z)');
    expect(c.ok).toBe(true);
    expect(c.ok && c.warnings.join(' ')).toMatch(/Z is not a token.*use TZ/);
    expect(first('HH:mm TZ (Z)', '14:05 UTC (Z)')?.matchedText).toBe('14:05 UTC (Z)');
    // Touching other letters, Z is literal, as before.
    for (const pattern of ['DD/MM/YYYY ZZ', 'HH:mm Zulu']) {
      const r = compileTokenFormat(pattern);
      expect(r.ok && r.warnings.join(' ')).toMatch(/^Z\b.*matched literally/);
    }
    expect(first('HH:mm Zulu', '14:05 Zulu')?.matchedText).toBe('14:05 Zulu');
    expect(first('DD/MM/YYYY ZZ', '05/03/2024 ZZ')?.matchedText).toBe('05/03/2024 ZZ');
    // Quoted or bracketed, it is text.
    expect(first("HH:mm'Z'", '14:05Z')?.matchedText).toBe('14:05Z');
    expect(first('HH:mm[Z]', '14:05Z')?.assumed).toBe(true);
  });

  it('a value that is not an offset does not match', () => {
    expect(first('yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 +2500')).toBeUndefined();
    expect(first('yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 +01')).toBeUndefined();
    expect(first('yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 EST')).toBeUndefined();
  });
});

describe('moment weekday names ddd and dddd (QA G8)', () => {
  it.each([
    ['ddd D-MMM-YYYY HH.mm', 'Tue 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ['dddd D-MMM-YYYY HH.mm', 'Tuesday 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ['ddd D MMM YYYY HH:mm', 'Tue 5 Mar 2024 14:05', '2024-03-05T14:05:00.000Z'],
    ['dddd, MMMM D YYYY h:mm A', 'Tuesday, March 5 2024 2:05 PM', '2024-03-05T14:05:00.000Z'],
    ['dddd D MMM YYYY', 'Monday 5 Jan 2024', '2024-01-05T00:00:00.000Z'],
  ])('%s reads %s', (pattern, text, want) => expectReads(pattern, text, want, true));

  it('the word must be a weekday name', () => {
    expect(first('ddd D MMM YYYY', 'Foo 5 Mar 2024')).toBeUndefined();
    expect(first('dddd D MMM YYYY', 'Someday 5 Mar 2024')).toBeUndefined();
  });

  it('inside a word the letters stay literal', () => {
    // "odd" and "Addday" have d's touched by other letters.
    const c = compileTokenFormat('HH:mm [odd]');
    expect(c.ok && c.warnings).toEqual([]);
    expect(first('HH:mm oddd', '14:05 oddd')?.matchedText).toBe('14:05 oddd');
  });

  it('ddd and the Java dd (day) are told apart', () => {
    expectReads('ddd dd MMM yyyy', 'Tue 05 Mar 2024', '2024-03-05T00:00:00.000Z', true);
    expect(error('ddd EEE dd MMM')).toMatch(/"EEE" repeats the weekday/);
  });
});

describe('unsupported tokens say so (QA G8)', () => {
  it.each(['DDD YYYY', 'DDDD YYYY', 'YYYY-DDD', 'DDDo YYYY HH:mm'])('%s: day of the year', (pattern) => {
    const e = error(pattern);
    expect(e).toMatch(/\(day of the year\) is not supported/);
    expect(e).not.toMatch(/repeats/);
  });

  it('more than 9 fraction digits', () => {
    expect(error('HH:mm:ss.SSSSSSSSSS')).toMatch(/"SSSSSSSSSS" is not supported/);
  });
});

describe('fractions of a second past milliseconds (QA G8)', () => {
  it.each([
    ['yyyy-MM-dd HH:mm:ss.SSSSSS', '2024-03-05 14:05:06.123456', '2024-03-05T14:05:06.123Z'],
    ['yyyy-MM-dd HH:mm:ss.SSSS', '2024-03-05 14:05:06.9876', '2024-03-05T14:05:06.987Z'],
    ['yyyy-MM-dd HH:mm:ss.SSSSSSSSS', '2024-03-05 14:05:06.000000001', '2024-03-05T14:05:06.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ss.SSSSSSXXX", '2024-03-05T14:05:06.123456+05:45', '2024-03-05T08:20:06.123Z'],
  ])('%s reads %s (the first three digits)', (pattern, text, want) => {
    const c = compileTokenFormat(pattern);
    expect(c.ok).toBe(true);
    const p = first(pattern, text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
  });

  it('needs exactly that many digits', () => {
    expect(first('HH:mm:ss.SSSSSS', '14:05:06.123')).toBeUndefined();
    expect(first('HH:mm:ss.SSSSSS', '14:05:06.1234567')).toBeUndefined();
  });

  it('still refuses SSS twice', () => {
    expect(error('HH:mm:ss.SSS SSS')).toMatch(/repeats the millisecond/);
  });
});

describe("Java '' is one quote (QA G9)", () => {
  it("dd MMM ''yy HH:mm reads 05 Mar '24 15:30", () => {
    expectReads("dd MMM ''yy HH:mm", "05 Mar '24 15:30", '2024-03-05T15:30:00.000Z', true);
  });

  it('two quotes, as patterns saved before Java quotes meant, still read', () => {
    expect(first("dd MMM ''yy HH:mm", "05 Mar ''24 15:30")?.matchedText).toBe("05 Mar ''24 15:30");
    expect(first("''HH:mm''", "''10:00''")?.matchedText).toBe("''10:00''");
  });

  it("the moment form 'YY and a quote inside a quoted literal are unchanged", () => {
    expect(first("D MMM 'YY, h:mm A o'clock", "5 Mar '24, 3:30 PM o'clock")?.matchedText).toBe("5 Mar '24, 3:30 PM o'clock");
    expect(first("HH:mm 'o''clock'", "10:30 o'clock")?.matchedText).toBe("10:30 o'clock");
  });

  it('a page with the time reads it through the custom format', () => {
    const [p] = parseTimes("Released 05 Mar '24 15:30, see notes", {
      assumedZone: 'UTC',
      numericDateOrder: 'dmy',
      nowMs: NOW,
      customFormats: [custom("dd MMM ''yy HH:mm")],
    });
    expect(p?.matchedText).toBe("05 Mar '24 15:30");
    expect(iso(p!.epochMs)).toBe('2024-03-05T15:30:00.000Z');
  });
});

describe('legacy2.log cases (blind QA round 7)', () => {
  // [pattern, text, ISO time or an error to match]
  it.each([
    ['ddd D-MMM-YYYY HH.mm', 'Tue 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ['EEE d-MMM-yyyy HH.mm', 'Tue 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ['dddd D-MMM-YYYY HH.mm', 'Tuesday 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ['EEEE d-MMM-yyyy HH.mm', 'Tuesday 5-Mar-2024 14.05', '2024-03-05T14:05:00.000Z'],
    ["HH:mm 'today'", '14:05 today', '2026-11-01T14:05:00.000Z'],
    ['HH:mm [today]', '14:05 today', '2026-11-01T14:05:00.000Z'],
    ['h:mm a today', '2:05 pm today', '2026-11-01T14:05:00.000Z'],
    ["dd MMM ''yy HH:mm", "05 Mar '24 15:30", '2024-03-05T15:30:00.000Z'],
    ['YYYY-MM-DD HH:mm Z', '2024-03-05 14:05 +05:45', '2024-03-05T08:20:00.000Z'],
    ['yyyy-MM-dd HH:mm Z', '2024-03-05 14:05 +0545', '2024-03-05T08:20:00.000Z'],
    ['DDD YYYY', '065 2024', /day of the year\) is not supported/],
    ['yyyy-MM-dd HH:mm:ss,SSS', '2024-03-05 14:05:06,789', '2024-03-05T14:05:06.789Z'],
    ['MM/dd/yyyy hh:mm:ss a z', '03/05/2024 02:05:06 PM PST', '2024-03-05T22:05:06.000Z'],
    ["yyyy-MM-dd'T'HH:mm:ssZ", '2024-03-05T14:05:06+0100', '2024-03-05T13:05:06.000Z'],
    ['dd.MM.yy', '05.03.24', '2024-03-05T00:00:00.000Z'],
    ['M/d/yy h:mm a', '3/5/24 2:05 PM', '2024-03-05T14:05:00.000Z'],
    ['yyyy-MM-dd HH:mm:ss.SSSSSS', '2024-03-05 14:05:06.123456', '2024-03-05T14:05:06.123Z'],
    ['MMMM d, yyyy', 'March 5, 2024', '2024-03-05T00:00:00.000Z'],
    ['HH:mm:ss', '14:05:06', '2026-11-01T14:05:06.000Z'],
  ] as Array<[string, string, string | RegExp]>)('%s with %s', (pattern, text, want) => {
    if (want instanceof RegExp) {
      expect(error(pattern)).toMatch(want);
      return;
    }
    const p = first(pattern, text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
  });
});

describe('token reference (QA G12)', () => {
  it('lists the new Java and moment spellings', () => {
    const tokens = TOKEN_REFERENCE.map((t) => t.token);
    for (const t of ['Z', 'ddd dddd', 'SSSSSS', "''"]) expect(tokens).toContain(t);
  });
});
