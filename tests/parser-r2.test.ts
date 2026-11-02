import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import type { CustomFormat, NumericDateOrder } from '../src/types';

/** Round-2 review and blind-QA parser fixes. */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (text: string, order: NumericDateOrder = 'dmy', zone = 'UTC', customFormats?: CustomFormat[]) =>
  parseTimes(text, { assumedZone: zone, numericDateOrder: order, nowMs: NOW, customFormats });
const first = (text: string, order: NumericDateOrder = 'dmy', zone = 'UTC') => at(text, order, zone)[0];
const day = (text: string, order: NumericDateOrder = 'dmy'): string | undefined => {
  const p = first(text, order);
  return p ? iso(p.epochMs).slice(0, 10) : undefined;
};

describe('two-digit-year numeric dates (review #1)', () => {
  it.each([
    ['12.03.24', '2024-03-12'],
    ['5.11.24', '2024-11-05'],
    ['23.12.25', '2025-12-23'],
    ['24.12.25', '2025-12-24'],
    ['01.02.25', '2025-02-01'],
    ['15.08.47', '2047-08-15'],
    ['Stand: 12.03.24', '2024-03-12'],
    ['22-03-24', '2024-03-22'],
    ['05-06-24', '2024-06-05'],
    ['24-03-22', '2022-03-24'],
    ['31-12-25', '2025-12-31'],
    ['12-31-25', '2025-12-31'],
  ])('%s is %s (dmy)', (text, want) => {
    expect(day(text, 'dmy')).toBe(want);
  });

  it.each([
    // Unambiguous ones read the same in either order.
    ['23.12.25', '2025-12-23'],
    ['15.08.47', '2047-08-15'],
    ['22-03-24', '2024-03-22'],
    ['31-12-25', '2025-12-31'],
    ['12-31-25', '2025-12-31'],
    // Ambiguous ones follow the setting and offer the other reading.
    ['12.03.24', '2024-12-03'],
    ['05-06-24', '2024-05-06'],
  ])('%s is %s (mdy)', (text, want) => {
    expect(day(text, 'mdy')).toBe(want);
  });

  it('an ambiguous short date offers the other order', () => {
    const p = first('12.03.24');
    expect(p?.matchedText).toBe('12.03.24');
    expect(p?.dateOrder?.date).toEqual({ y: 2024, mo: 3, d: 12 });
    expect(p?.dateOrder?.alternate.date).toEqual({ y: 2024, mo: 12, d: 3 });
  });

  it.each(['10.30.15', '01-23-45', 'ext 01-23-45', 'lot 11-12-13', 'SKU 12-03-24', 'ext 12-03-24'])(
    '%s stays refused',
    (text) => {
      expect(at(text).map((p) => p.formatId)).not.toContain('numeric-date');
    },
  );

  it('a dash date more than ten years ahead is a code; one within ten years is a date', () => {
    // NOW is 2026: 2036 is in range, 2037 is not.
    expect(day('22-03-36')).toBe('2036-03-22');
    expect(day('22-03-37')).toBeUndefined();
    // With a time attached the numbers are a date whatever the year.
    expect(iso(first('01-23-45 05:06', 'mdy')!.epochMs)).toBe('2045-01-23T05:06:00.000Z');
  });
});

describe('DST-aware wall clocks', () => {
  it.each([
    ['2024-03-10 02:30 ET', '2024-03-10T07:30:00.000Z', 'gap'],
    ['2024-03-31T01:30[Europe/London]', '2024-03-31T01:30:00.000Z', 'gap'],
    ['2024-11-03 01:30 ET', '2024-11-03T05:30:00.000Z', 'ambiguous'],
    ['2024-10-27T01:30[Europe/London]', '2024-10-27T00:30:00.000Z', 'ambiguous'],
  ])('%s is %s (%s)', (text, want, flag) => {
    const p = first(text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
    expect(p!.wallClock).toBe(flag);
  });

  it('an ordinary time in a DST zone is not flagged', () => {
    const p = first('2024-07-01 10:00 ET');
    expect(iso(p!.epochMs)).toBe('2024-07-01T14:00:00.000Z');
    expect(p!.wallClock).toBeUndefined();
  });

  it.each([
    ['2024-03-10 02:30 EDT', '2024-03-10T06:30:00.000Z'],
    ['2024-11-03 01:30 EDT', '2024-11-03T05:30:00.000Z'],
    ['2024-11-03 01:30 EST', '2024-11-03T06:30:00.000Z'],
    ['2024-03-10T02:30+05:45', '2024-03-09T20:45:00.000Z'],
    ['2024-03-10T02:30-05:00', '2024-03-10T07:30:00.000Z'],
  ])('fixed offset %s is never flagged', (text, want) => {
    const p = first(text, 'dmy', 'America/New_York');
    expect(iso(p!.epochMs)).toBe(want);
    expect(p!.wallClock).toBeUndefined();
  });

  it('the assumed zone is DST-aware too, for every format', () => {
    const zone = 'America/New_York';
    const iso1 = first('2024-03-10 02:30', 'dmy', zone);
    expect(iso(iso1!.epochMs)).toBe('2024-03-10T07:30:00.000Z');
    expect(iso1!.wallClock).toBe('gap');
    const num = first('10.03.2024 02:30', 'dmy', zone);
    expect(iso(num!.epochMs)).toBe('2024-03-10T07:30:00.000Z');
    expect(num!.wallClock).toBe('gap');
    const written = first('3 Nov 2024 01:30', 'dmy', zone);
    expect(iso(written!.epochMs)).toBe('2024-11-03T05:30:00.000Z');
    expect(written!.wallClock).toBe('ambiguous');
  });

  it('custom formats resolve wall clocks the same way', () => {
    const fmt: CustomFormat = { id: 'c', label: 'c', pattern: 'DD/MM/YYYY HH:mm', advanced: false, enabled: true };
    const [p] = at('10/03/2024 02:30', 'dmy', 'America/New_York', [fmt]);
    expect(p?.formatId).toBe('c');
    expect(iso(p!.epochMs)).toBe('2024-03-10T07:30:00.000Z');
    expect(p!.wallClock).toBe('gap');
  });

  it('a date-only value is not flagged (its time was not written)', () => {
    // Midnight does not exist in Santiago on 2024-09-08 (clocks go 00:00 -> 01:00).
    const p = first('2024-09-08', 'dmy', 'America/Santiago');
    expect(p?.dateOnly).toBe(true);
    expect(p!.wallClock).toBeUndefined();
  });
});

describe('years below 1000 are not dates', () => {
  it.each(['0000-01-01', '0999-05-05', '0000-01-01T10:00Z', '01.01.0999', '5 Jan 0500', '0000/01/01 10:00'])(
    '%s',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it('year 1000 is still read', () => {
    expect(iso(first('1000-01-01T00:00Z')!.epochMs)).toBe('1000-01-01T00:00:00.000Z');
  });
});

describe('an IANA zone after a space', () => {
  it.each([
    ['2024-03-10 02:30 [America/New_York]', '2024-03-10T07:30:00.000Z'],
    ['2024-03-10 02:30 America/New_York', '2024-03-10T07:30:00.000Z'],
    ['2024-03-10T02:30[America/New_York]', '2024-03-10T07:30:00.000Z'],
    ['2024-07-01 10:00 Europe/Paris', '2024-07-01T08:00:00.000Z'],
    ['2024-07-01 10:00:30 [Asia/Kathmandu]', '2024-07-01T04:15:30.000Z'],
  ])('%s', (text, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
    expect(p?.sourceZone).toBe(text.match(/[A-Z][a-z]+\/[A-Za-z_]+/)![0]);
  });

  it('a time of day takes the zone too', () => {
    const p = first('10:00 Europe/Paris');
    expect(p?.matchedText).toBe('10:00 Europe/Paris');
    expect(iso(p!.epochMs)).toBe('2026-11-01T09:00:00.000Z');
    const q = first('Call at 9:30 [Asia/Tokyo]');
    expect(q?.matchedText).toBe('9:30 [Asia/Tokyo]');
    expect(iso(q!.epochMs)).toBe('2026-11-01T00:30:00.000Z');
  });

  it.each([
    ['10:00 Foo/Bar', '10:00'],
    ['10:00 Europe/Atlantis', '10:00'],
    ['10:00 [Foo/Bar]', '10:00'],
    ['2024-03-10 02:30 Europe/Atlantis', '2024-03-10 02:30'],
    ['2024-03-10 02:30 [Not/AZone]', '2024-03-10 02:30'],
  ])('%s stays in the home zone, matching only %s', (text, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(want);
    expect(p?.assumed).toBe(true);
  });

  it('only directly after the time (one space)', () => {
    expect(first('2024-03-10 02:30  America/New_York')?.matchedText).toBe('2024-03-10 02:30');
    expect(first('10:00, Europe/Paris')?.matchedText).toBe('10:00');
  });

  it('a zone abbreviation before a slash still counts ("3pm ET/PT")', () => {
    const p = first('3pm ET/PT');
    expect(p?.matchedText).toBe('3pm ET');
    expect(p?.sourceZone).toContain('America/New_York');
  });
});

describe('false positives (QA #6)', () => {
  it.each(['John 3:16', 'Romans 8:28', 'Luke 2:1-20', 'Psalm 23:4', 'Psalms 23:10', 'Surah 2:255', 'see verse 3:16', 'Chapter 12:30'])(
    'scripture reference %s',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it.each([
    ['Meeting 3:16 PM', '3:16 PM'],
    ['at 3:16', '3:16'],
    ['3:16 UTC', '3:16 UTC'],
    ['Standup 9:00, demo 16:30', '9:00'],
    ['Lunch 12:30', '12:30'],
    ['John 3:16 PM', '3:16 PM'],
  ])('%s is still a time', (text, want) => {
    expect(first(text)?.matchedText).toBe(want);
  });

  it.each(['1:30 odds', 'odds of 1:30', 'mix 1:10', 'aspect ratio 4:30', 'a 1:50 scale model', 'ratio = 3:20'])(
    'ratio %s',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it.each(['Lap 1:23.456', 'split 0:59.87', 'PB 4:05.2', 'ran 10:42.18'])('duration %s', (text) => {
    expect(at(text)).toEqual([]);
  });

  it('a time at the end of a sentence is still a time', () => {
    expect(first('See you at 10:30.')?.matchedText).toBe('10:30');
  });

  it('a dotted triple before % is not a date', () => {
    expect(at('99.22.3%')).toEqual([]);
    expect(at('grew 12.03.24%')).toEqual([]);
  });

  it('an ISO date followed by -digits is an id', () => {
    expect(at('2024-03-22-001')).toEqual([]);
    expect(at('ticket 2024-03-22-17 done')).toEqual([]);
    // A date with an offset is still a date.
    expect(iso(first('1999-03-22-05:00')!.epochMs)).toBe('1999-03-22T05:00:00.000Z');
  });
});

describe('short dotted dates (QA #8)', () => {
  it('3.4.24 alone is refused (version-like)', () => {
    expect(at('3.4.24')).toEqual([]);
    expect(at('version 3.4.24')).toEqual([]);
  });

  it('3.4.24 with a time is a date, with the day/month picker', () => {
    const p = first('3.4.24 10:00');
    expect(p?.matchedText).toBe('3.4.24 10:00');
    expect(iso(p!.epochMs)).toBe('2024-04-03T10:00:00.000Z');
    expect(p!.dateOrder?.alternate.date).toEqual({ y: 2024, mo: 3, d: 4 });
    expect(iso(first('3.4.24 10:00', 'mdy')!.epochMs)).toBe('2024-03-04T10:00:00.000Z');
  });
});

describe('24:00 and leap seconds (QA #9)', () => {
  it.each([
    ['2024-01-01 24:00', '2024-01-02T00:00:00.000Z'],
    ['2024-01-01T24:00:00Z', '2024-01-02T00:00:00.000Z'],
    ['2024-12-31T24:00Z', '2025-01-01T00:00:00.000Z'],
    ['2024-02-28T24:00Z', '2024-02-29T00:00:00.000Z'],
    ['31.12.2024 24:00', '2025-01-01T00:00:00.000Z'],
  ])('%s is %s', (text, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
  });

  it.each(['2024-01-01 24:01', '2024-01-01T24:00:01Z', '2024-01-01T24:00:00.5Z'])('%s is refused', (text) => {
    expect(at(text)).toEqual([]);
  });

  it('a bare 24:00 is the end of today', () => {
    const p = first('24:00');
    expect(p?.matchedText).toBe('24:00');
    expect(iso(p!.epochMs)).toBe('2026-11-02T00:00:00.000Z');
  });

  it('a leap second reads as the last millisecond of that minute', () => {
    expect(iso(first('2016-12-31T23:59:60Z')!.epochMs)).toBe('2016-12-31T23:59:59.999Z');
    const p = first('23:59:60Z');
    expect(p?.matchedText).toBe('23:59:60Z');
    expect(iso(p!.epochMs)).toBe('2026-11-01T23:59:59.999Z');
    expect(at('2016-12-31T23:58:60Z')).toEqual([]);
  });

  it('24 pm is still not a time', () => {
    expect(at('24 pm')).toEqual([]);
  });
});
