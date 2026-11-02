import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { parseEpoch, MIN_EPOCH_MS, MAX_EPOCH_MS, MAX_AUTO_SECONDS } from '../src/lib/epoch';

/** Round-3 review and blind-QA parser fixes. */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (text: string, zone = 'UTC') => parseTimes(text, { assumedZone: zone, numericDateOrder: 'dmy', nowMs: NOW });
const first = (text: string, zone = 'UTC') => at(text, zone)[0];

describe('verse guard and given names (review #2)', () => {
  it.each([
    ['Lunch with Peter 12:30', '12:30', '2026-11-01T12:30:00.000Z'],
    ['Call John 3:30', '3:30', '2026-11-01T03:30:00.000Z'],
    ['Ping Mark 10:00', '10:00', '2026-11-01T10:00:00.000Z'],
    ['Daniel 9:15 standup', '9:15', '2026-11-01T09:15:00.000Z'],
    ['Meet James 14:00', '14:00', '2026-11-01T14:00:00.000Z'],
    ['Ruth 9:00', '9:00', '2026-11-01T09:00:00.000Z'],
    ['Amos 11:30', '11:30', '2026-11-01T11:30:00.000Z'],
    ['Sync with Luke 16:45', '16:45', '2026-11-01T16:45:00.000Z'],
    ['1:1 with Timothy 15:00', '15:00', '2026-11-01T15:00:00.000Z'],
    ['Call John 3:16', '3:16', '2026-11-01T03:16:00.000Z'],
    ['Matt 10:30 dentist', '10:30', '2026-11-01T10:30:00.000Z'],
    ['Peter 10:00-11:00', '10:00', '2026-11-01T10:00:00.000Z'],
    ['split at 10:30', '10:30', '2026-11-01T10:30:00.000Z'],
  ])('%s is a time', (text, matched, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(matched);
    expect(iso(p!.epochMs)).toBe(want);
  });

  it.each([
    // a book number
    '1 John 3:16',
    '2 Peter 1:5 says',
    'II Timothy 3:16',
    'First John 4:19',
    // a verse range or list right after
    'Read Mark 10:45-52 tonight',
    'Peter 3:16,18',
    'Luke 15:11–32',
    // "verse" / "chapter" / "ch." / "v." before the name or the number
    'verse John 3:16',
    'see chapter Daniel 9:24',
    'v. 3:16',
    // a given-name book opening the line, minutes not a multiple of five
    'John 3:16',
    '"John 3:16"',
    // books that are not names keep the plain rule
    'Romans 8:28',
    'Genesis 1:27',
  ])('%s is a verse', (text) => {
    expect(at(text)).toEqual([]);
  });

  it('"at" no longer makes a ratio, the other connectors still do', () => {
    expect(at('odds of 1:30')).toEqual([]);
    expect(at('ratio = 3:20')).toEqual([]);
    expect(first('mix at 10:30')?.matchedText).toBe('10:30');
  });
});

describe('ISO-id veto and hyphen ranges (review #6)', () => {
  it('both dates of a hyphen range convert', () => {
    const ps = at('2024-03-22-2024-03-25');
    expect(ps.map((p) => iso(p.epochMs).slice(0, 10))).toEqual(['2024-03-22', '2024-03-25']);
    expect(ps.map((p) => p.matchedText)).toEqual(['2024-03-22', '2024-03-25']);
  });

  it('ids are still refused', () => {
    expect(at('2024-03-22-001')).toEqual([]);
    expect(at('build 2024-03-22-20240 done')).toEqual([]);
  });
});

describe('leap seconds only at 23:59:60 UTC (review #7)', () => {
  it.each([
    ['2016-12-31T23:59:60Z', '2016-12-31T23:59:59.999Z'],
    ['2017-01-01T05:44:60+05:45', '2016-12-31T23:59:59.999Z'],
    ['2016-12-31T18:59:60-05:00', '2016-12-31T23:59:59.999Z'],
    ['2016-12-31 23:59:60 UTC', '2016-12-31T23:59:59.999Z'],
    ['2016-12-31T23:59:60.5Z', '2016-12-31T23:59:59.999Z'],
  ])('%s is %s', (text, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs)).toBe(want);
  });

  it('a bare time with an offset that lands on 23:59:60 UTC', () => {
    const p = first('05:44:60 +05:45');
    expect(p?.matchedText).toBe('05:44:60 +05:45');
    expect(iso(p!.epochMs)).toBe('2026-10-31T23:59:59.999Z');
    expect(first('23:59:60Z')?.matchedText).toBe('23:59:60Z');
  });

  it.each(['10:59:60', '10:59:60 UTC', '2016-12-31T10:59:60Z', '2016-12-31T23:59:60+01:00', '23:59:60 +05:45'])(
    '%s is refused',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it('without a zone the assumed zone decides', () => {
    expect(iso(first('2016-12-31 23:59:60', 'UTC')!.epochMs)).toBe('2016-12-31T23:59:59.999Z');
    expect(at('2016-12-31 23:59:60', 'Asia/Kathmandu')).toEqual([]);
    expect(iso(first('2017-01-01 05:44:60', 'Asia/Kathmandu')!.epochMs)).toBe('2016-12-31T23:59:59.999Z');
    expect(iso(first('2016-12-31 18:59:60', 'America/New_York')!.epochMs)).toBe('2016-12-31T23:59:59.999Z');
  });
});

describe('epoch range (QA #4)', () => {
  it('the range is 1900-01-01 to 9999-12-31T23:59:59.999Z', () => {
    expect(iso(MIN_EPOCH_MS)).toBe('1900-01-01T00:00:00.000Z');
    expect(iso(MAX_EPOCH_MS)).toBe('9999-12-31T23:59:59.999Z');
    expect(parseEpoch('-2208988800')?.epochMs).toBe(MIN_EPOCH_MS);
    expect(parseEpoch('-2208988801')).toBeNull();
    expect(parseEpoch('253402300799999')).toEqual({ epochMs: MAX_EPOCH_MS, unit: 'milliseconds' });
    expect(parseEpoch('253402300800000')).toBeNull();
  });

  it('auto mode reads up to 11 digits as seconds, 12+ as milliseconds', () => {
    expect(iso(MAX_AUTO_SECONDS * 1000)).toBe('5138-11-16T09:46:39.000Z');
    expect(parseEpoch(String(MAX_AUTO_SECONDS))).toEqual({ epochMs: MAX_AUTO_SECONDS * 1000, unit: 'seconds' });
    // 12-digit milliseconds are real 1973-2001 data and stay milliseconds.
    expect(parseEpoch('100000000000')).toEqual({ epochMs: 100000000000, unit: 'milliseconds' });
    expect(parseEpoch('999999999999')).toEqual({ epochMs: 999999999999, unit: 'milliseconds' });
    const r = parseEpoch('253402300799');
    expect(r?.unit).toBe('milliseconds');
    expect(iso(r!.epochMs)).toBe('1978-01-11T21:31:40.799Z');
    // Year 9999 in seconds needs the seconds unit.
    expect(iso(parseEpoch('253402300799', 'seconds')!.epochMs)).toBe('9999-12-31T23:59:59.000Z');
  });
});
