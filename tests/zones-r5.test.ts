import { describe, it, expect } from 'vitest';
import { excludedMatch, normalizeSearch, searchZones, viewInZone } from '../src/lib/tz';

/* Round 5: punctuated display names in search (review #6), own abbreviations by era (review #7). */

const first = (q: string): string | undefined => searchZones(q).flatMap((g) => g.options)[0]?.id;

describe('search finds punctuated display names (review #6)', () => {
  it.each([
    ["St. John's", 'America/St_Johns'],
    ['st johns', 'America/St_Johns'],
    ['St Johns', 'America/St_Johns'],
    ['St. John’s', 'America/St_Johns'],
    ["Dumont d'Urville", 'Antarctica/DumontDUrville'],
    ['dumont durville', 'Antarctica/DumontDUrville'],
    ['Dumont d’Urville', 'Antarctica/DumontDUrville'],
    ["Lower Prince's Quarter", 'America/Lower_Princes'],
    ['lower princes quarter', 'America/Lower_Princes'],
    ['lower princes', 'America/Lower_Princes'],
  ])('"%s" finds %s first', (q, zone) => {
    expect(first(q)).toBe(zone);
  });

  it('shows the display name a hidden match came from', () => {
    const o = searchZones('dumont durville').flatMap((g) => g.options)[0];
    expect(o?.matched).toBe("Dumont d'Urville");
  });

  it('normalizeSearch drops full stops and apostrophes, and offsets still parse', () => {
    expect(normalizeSearch("  St. John’s  ")).toBe('st johns');
    expect(first('utc+5:45')).toBe('UTC+05:45');
    expect(first('UTC−3:30')).toBe('UTC-03:30');
  });

  it('"Already added" also finds an added zone by its punctuated name', () => {
    expect(excludedMatch("St. John's", ['America/St_Johns'])).toBe('America/St_Johns');
    expect(excludedMatch("dumont d'urville", ['Antarctica/DumontDUrville'])).toBe('Antarctica/DumontDUrville');
  });
});

/** The distinct abbreviations a zone shows on the 15th of each month of `year`. */
function abbrevsIn(zone: string, year: number): string[] {
  const out = new Set<string>();
  for (let m = 0; m < 12; m++) {
    const v = viewInZone(Date.UTC(year, m, 15, 12), zone, false);
    out.add(`${v.abbrev} ${v.offset}`);
  }
  return [...out];
}

describe('own abbreviations by era (review #7)', () => {
  it.each([
    // Argentina's −03:00 before Oct 1969 was summer time: no own name, Intl's form.
    ['America/Argentina/Buenos_Aires', 1950, ['GMT-3 -03:00']],
    ['America/Argentina/Buenos_Aires', 1980, ['ART -03:00']],
    // Dhaka is on +06:00 from 1951, Bangladesh Time from 1971.
    ['Asia/Dhaka', 1960, ['GMT+6 +06:00']],
    ['Asia/Dhaka', 1980, ['BDT +06:00']],
    ['Asia/Karachi', 1960, ['GMT+5 +05:00']],
    ['Asia/Karachi', 1980, ['PKT +05:00']],
    // Seoul on +09:00 under Japanese rule was not KST.
    ['Asia/Seoul', 1930, ['GMT+9 +09:00']],
    ['Asia/Seoul', 1990, ['KST +09:00']],
    // Nepal: +05:30 until 1986 (no name), NPT at +05:45 after.
    ['Asia/Kathmandu', 1980, ['GMT+5:30 +05:30']],
    ['Asia/Kathmandu', 1990, ['NPT +05:45']],
  ] as const)('%s in %i reads %j', (zone, year, want) => {
    expect(abbrevsIn(zone, year)).toEqual(want);
  });

  it('switches at the valid-from instant', () => {
    const since = Date.UTC(1969, 9, 5, 4); // 00:00 −04:00, when standard time became −03:00
    expect(viewInZone(since - 60_000, 'America/Argentina/Buenos_Aires', false).abbrev).not.toBe('ART');
    expect(viewInZone(since, 'America/Argentina/Buenos_Aires', false).abbrev).toBe('ART');
    const npt = Date.UTC(1985, 11, 31, 18, 30);
    expect(viewInZone(npt, 'Asia/Kathmandu', false).abbrev).toBe('NPT');
    expect(viewInZone(npt - 60_000, 'Asia/Kathmandu', false).abbrev).not.toBe('NPT');
  });

  it('entries without a valid-from date are unchanged (St John’s 1940, Chatham, Jersey)', () => {
    expect(viewInZone(Date.UTC(1940, 0, 15, 12), 'America/St_Johns', false).abbrev).toBe('NST');
    expect(viewInZone(Date.UTC(2024, 0, 15, 12), 'Pacific/Chatham', false).abbrev).toBe('CHADT');
    expect(viewInZone(Date.UTC(2024, 6, 15, 12), 'Europe/Jersey', false).abbrev).toBe('BST');
  });
});
