import { describe, it, expect } from 'vitest';
import {
  excludedMatch,
  listTimeZones,
  normalizeSearch,
  offsetMinutesAt,
  resolveZone,
  searchZones,
  UTC_OFFSET_MINUTES,
} from '../src/lib/tz';

/* Round 6: dotted and decimal-hour offsets (review nit #7 / QA F8), Etc/GMT±N in search (QA F9). */

const ids = (q: string, opts: Parameters<typeof searchZones>[1] = {}): string[] =>
  searchZones(q, opts).flatMap((g) => g.options.map((o) => o.id));
const first = (q: string): string | undefined => ids(q)[0];

describe('offsets with a full stop (review nit #7, QA F8)', () => {
  it('normalizeSearch keeps a full stop between digits and drops the others', () => {
    expect(normalizeSearch('utc+1.0')).toBe('utc+1.0');
    expect(normalizeSearch('5.45')).toBe('5.45');
    expect(normalizeSearch('St. John’s')).toBe('st johns');
    expect(normalizeSearch('utc+5.')).toBe('utc+5');
    expect(normalizeSearch('.5')).toBe('5');
  });

  it.each([
    // Two digits under 60: hours and minutes.
    ['5.45', 'UTC+05:45'],
    ['+5.45', 'UTC+05:45'],
    ['utc+5.30', 'UTC+05:30'],
    // One digit: a decimal hour.
    ['5.5', 'UTC+05:30'],
    ['utc+5.5', 'UTC+05:30'],
    ['UTC+5.5', 'UTC+05:30'],
    ['-3.5', 'UTC-03:30'],
    ['gmt-3.5', 'UTC-03:30'],
    ['utc-9.5', 'UTC-09:30'],
    ['+1.0', 'UTC+01:00'],
    ['utc+1.0', 'UTC+01:00'],
    ['utc-1.0', 'UTC-01:00'],
    // Two digits from 60 up can't be minutes: a decimal hour.
    ['5.75', 'UTC+05:45'],
    ['utc+5.75', 'UTC+05:45'],
  ])('"%s" finds %s first', (q, zone) => {
    expect(first(q)).toBe(zone);
  });

  it('"+13.75" is +13:45 (Chatham daylight time)', () => {
    expect(ids('+13.75')).toContain('abbr:CHADT');
    expect(ids('+13.75')).toContain('Pacific/Chatham');
  });

  it('never reads the full stop as missing: "utc+1.0" is not UTC+10:00, "+0.5" is not UTC+05:00', () => {
    expect(ids('utc+1.0')).not.toContain('UTC+10:00');
    expect(ids('utc-1.0')).not.toContain('UTC-10:00');
    // +00:30 and +01:30 are no zone's offset: nothing, rather than a wrong one.
    expect(ids('+0.5')).toEqual([]);
    expect(ids('utc+1.30')).toEqual([]);
  });

  it('a fraction that is not a whole minute, or out of range, finds nothing', () => {
    expect(ids('5.77')).toEqual([]);
    expect(ids('utc+14.5')).toEqual([]);
    expect(ids('utc-12.5')).toEqual([]);
  });

  it('typing the full stop keeps the offsets on the way', () => {
    expect(first('utc+5.')).toBe('UTC+05:00');
    expect(ids('utc+5.')).toContain('UTC+05:30');
  });

  it('"Already added" names a zone found by a decimal offset', () => {
    expect(excludedMatch('utc+5.5', ['UTC+05:30'])).toBe('UTC+05:30');
  });
});

describe('Etc/GMT±N in search (QA F9)', () => {
  it.each(['Etc/GMT+12', 'etc/gmt+12', 'ETC/GMT+12'])('"%s" finds Etc/GMT+12 and gives its real offset', (q) => {
    const o = searchZones(q).flatMap((g) => g.options)[0];
    expect(o?.id).toBe('Etc/GMT+12');
    // Round 7 (review nit #7): the offset once, then the note.
    expect(o?.detail).toBe('UTC-12:00 · POSIX sign is reversed');
    expect(resolveZone('Etc/GMT+12')?.short).toBe('UTC-12:00');
  });

  it('every Etc detail names its real offset once', () => {
    const etc = searchZones('etc/').flatMap((g) => g.options);
    expect(etc.find((o) => o.id === 'Etc/GMT+9')?.detail).toBe('UTC-09:00 · POSIX sign is reversed');
    expect(etc.find((o) => o.id === 'Etc/GMT-14')?.detail).toBe('UTC+14:00 · POSIX sign is reversed');
    for (const o of etc) expect(o.detail?.match(/UTC[+-]\d\d:\d\d/g)).toHaveLength(1);
  });

  it('"etc/" lists every Etc/GMT±N zone, -14 to +12', () => {
    const etc = ids('etc/');
    expect(etc).toHaveLength(26);
    expect(etc).toContain('Etc/GMT-14');
    expect(etc).toContain('Etc/GMT+12');
    expect(etc).not.toContain('Etc/GMT+0');
    expect(first('etc/gmt+1')).toBe('Etc/GMT+1');
    expect(first('etc/gmt-5')).toBe('Etc/GMT-5');
  });

  it('"gmt+12" lists UTC+12:00 first and Etc/GMT+12 last, with the reversed sign explained', () => {
    const all = searchZones('gmt+12').flatMap((g) => g.options);
    expect(all[0]?.id).toBe('UTC+12:00');
    expect(all.at(-1)?.id).toBe('Etc/GMT+12');
    expect(all.at(-1)?.detail).toContain('UTC-12:00');
    expect(all.filter((o) => o.id.startsWith('Etc/'))).toHaveLength(1);
  });

  it('other searches do not list Etc zones', () => {
    for (const q of ['utc-12', '-12', 'tokyo', 'utc+5.5', 'gmt']) {
      expect(ids(q).some((id) => id.startsWith('Etc/'))).toBe(false);
    }
  });

  it('an added Etc zone is excluded and reported as already added', () => {
    expect(ids('etc/gmt+12', { exclude: ['Etc/GMT+12'] })).not.toContain('Etc/GMT+12');
    expect(excludedMatch('etc/gmt+12', ['Etc/GMT+12'])).toBe('Etc/GMT+12');
  });
});

describe('UTC offsets (round 7, QA G11)', () => {
  it('+13:45 is a fixed offset, found by "utc+13:45" and "+13.75"', () => {
    expect(UTC_OFFSET_MINUTES).toContain(825);
    expect(first('utc+13:45')).toBe('UTC+13:45');
    expect(ids('+13.75')).toContain('UTC+13:45');
    expect(ids('+13.75')).toContain('abbr:CHADT');
    expect(resolveZone('UTC+13:45')?.short).toBe('UTC+13:45');
  });

  it('lists every offset a zone has at any time of the year, in order', () => {
    const used = new Set<number>();
    const start = Date.UTC(2025, 0, 1);
    for (let day = 0; day < 366; day += 3) {
      for (const z of listTimeZones()) used.add(offsetMinutesAt(start + day * 86_400_000, z));
    }
    const missing = [...used].filter((m) => !UTC_OFFSET_MINUTES.includes(m));
    expect(missing).toEqual([]);
    expect([...UTC_OFFSET_MINUTES].sort((a, b) => a - b)).toEqual(UTC_OFFSET_MINUTES);
    expect(UTC_OFFSET_MINUTES).toHaveLength(40);
  });
});
