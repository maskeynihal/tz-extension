import { describe, it, expect } from 'vitest';
import {
  viewInZone,
  wallClockToEpochMs,
  toIsoUtc,
  isValidZone,
  listTimeZones,
  searchZones,
  zoneGroups,
  zoneLabel,
  resolveZone,
  sameZone,
  canonicalZone,
  excludedMatch,
  ianaEquivalent,
  offsetMinutesAt,
  ZONE_ABBREVIATIONS,
  type ZoneOption,
} from '../src/lib/tz';

/** All options of a search, in display order. */
function results(q: string, exclude?: readonly string[]): ZoneOption[] {
  return searchZones(q, { exclude }).flatMap((g) => g.options);
}
const ids = (q: string): string[] => results(q).map((o) => o.id);
const first = (q: string): string | undefined => ids(q)[0];

describe('zone search: minus signs and dashes', () => {
  it.each([
    ['UTC−5', 'UTC-05:00'],
    ['utc−8', 'UTC-08:00'],
    ['−08:00', 'UTC-08:00'],
    ['gmt−3', 'UTC-03:00'],
    ['utc–8', 'UTC-08:00'], // en dash
    ['UTC−03:30', 'UTC-03:30'],
  ])('%s finds %s first', (q, id) => {
    expect(first(q)).toBe(id);
  });
});

describe('zone search: cities and countries', () => {
  // Every city the brief lists, plus a few more, mapped to the zone it uses.
  const CITIES: readonly (readonly [string, string])[] = [
    ['Mumbai', 'Asia/Kolkata'],
    ['Delhi', 'Asia/Kolkata'],
    ['New Delhi', 'Asia/Kolkata'],
    ['Bangalore', 'Asia/Kolkata'],
    ['Bengaluru', 'Asia/Kolkata'],
    ['Chennai', 'Asia/Kolkata'],
    ['Kolkata', 'Asia/Kolkata'],
    ['Beijing', 'Asia/Shanghai'],
    ['Shenzhen', 'Asia/Shanghai'],
    ['San Francisco', 'America/Los_Angeles'],
    ['Seattle', 'America/Los_Angeles'],
    ['Las Vegas', 'America/Los_Angeles'],
    ['Boston', 'America/New_York'],
    ['Washington', 'America/New_York'],
    ['Miami', 'America/New_York'],
    ['Atlanta', 'America/New_York'],
    ['Dallas', 'America/Chicago'],
    ['Houston', 'America/Chicago'],
    ['Austin', 'America/Chicago'],
    ['Montreal', 'America/Toronto'],
    ['Vancouver', 'America/Vancouver'],
    ['Sydney', 'Australia/Sydney'],
    ['Melbourne', 'Australia/Melbourne'],
    ['Dubai', 'Asia/Dubai'],
    ['Singapore', 'Asia/Singapore'],
    ['Hong Kong', 'Asia/Hong_Kong'],
    ['Seoul', 'Asia/Seoul'],
    ['Tokyo', 'Asia/Tokyo'],
    ['Paris', 'Europe/Paris'],
    ['Berlin', 'Europe/Berlin'],
    ['Munich', 'Europe/Berlin'],
    ['Madrid', 'Europe/Madrid'],
    ['Barcelona', 'Europe/Madrid'],
    ['Rome', 'Europe/Rome'],
    ['Milan', 'Europe/Rome'],
    ['Amsterdam', 'Europe/Amsterdam'],
    ['Zurich', 'Europe/Zurich'],
    ['Geneva', 'Europe/Zurich'],
    ['Stockholm', 'Europe/Stockholm'],
    ['Moscow', 'Europe/Moscow'],
    ['Istanbul', 'Europe/Istanbul'],
    ['Cairo', 'Africa/Cairo'],
    ['Lagos', 'Africa/Lagos'],
    ['Nairobi', 'Africa/Nairobi'],
    ['Johannesburg', 'Africa/Johannesburg'],
    ['Cape Town', 'Africa/Johannesburg'],
    ['São Paulo', 'America/Sao_Paulo'],
    ['Rio', 'America/Sao_Paulo'],
    ['Buenos Aires', 'America/Argentina/Buenos_Aires'],
    ['Mexico City', 'America/Mexico_City'],
    ['Lima', 'America/Lima'],
    ['Bogotá', 'America/Bogota'],
    ['Karachi', 'Asia/Karachi'],
    ['Lahore', 'Asia/Karachi'],
    ['Dhaka', 'Asia/Dhaka'],
    ['Kathmandu', 'Asia/Kathmandu'],
    ['Jakarta', 'Asia/Jakarta'],
    ['Manila', 'Asia/Manila'],
    ['Bangkok', 'Asia/Bangkok'],
    ['Hanoi', 'Asia/Ho_Chi_Minh'],
    ['Ho Chi Minh', 'Asia/Ho_Chi_Minh'],
    ['Saigon', 'Asia/Ho_Chi_Minh'],
    ['Kuala Lumpur', 'Asia/Kuala_Lumpur'],
    ['Auckland', 'Pacific/Auckland'],
    ['Honolulu', 'Pacific/Honolulu'],
    ['Anchorage', 'America/Anchorage'],
    ['Reykjavik', 'Atlantic/Reykjavik'],
    ['Dublin', 'Europe/Dublin'],
    ['London', 'Europe/London'],
    ['Lisbon', 'Europe/Lisbon'],
    ['Tel Aviv', 'Asia/Jerusalem'],
    ['Jerusalem', 'Asia/Jerusalem'],
    ['Riyadh', 'Asia/Riyadh'],
    ['Tehran', 'Asia/Tehran'],
    ['Kabul', 'Asia/Kabul'],
    ['Tashkent', 'Asia/Tashkent'],
    ['Almaty', 'Asia/Almaty'],
    ['Colombo', 'Asia/Colombo'],
    ['Yangon', 'Asia/Yangon'],
    ['Perth', 'Australia/Perth'],
    ['Brisbane', 'Australia/Brisbane'],
    ['Adelaide', 'Australia/Adelaide'],
    ['Denver', 'America/Denver'],
    ['Phoenix', 'America/Phoenix'],
    ['Chicago', 'America/Chicago'],
    ['Los Angeles', 'America/Los_Angeles'],
    ['New York', 'America/New_York'],
    ['India', 'Asia/Kolkata'],
    ['Nepal', 'Asia/Kathmandu'],
    ['Germany', 'Europe/Berlin'],
  ];

  it.each(CITIES)('%s finds %s', (city, zone) => {
    const found = ids(city);
    expect(found).toContain(zone);
    // Nothing but abbreviations or other exact names ranks above the city's zone.
    const opts = results(city);
    const i = opts.findIndex((o) => o.id === zone);
    expect(opts.slice(0, i).every((o) => o.id.startsWith('abbr:') || o.id.startsWith('UTC'))).toBe(true);
  });

  it('is case- and accent-insensitive', () => {
    expect(first('MUMBAI')).toBe('Asia/Kolkata');
    expect(first('sao paulo')).toBe('America/Sao_Paulo');
    expect(first('SÃO PAULO')).toBe('America/Sao_Paulo');
    expect(first('bogota')).toBe('America/Bogota');
    expect(first('zürich')).toBe('Europe/Zurich');
    expect(first('reykjavík')).toBe('Atlantic/Reykjavik');
  });

  it('says why a result matched when the label does not show it', () => {
    expect(results('mumbai')[0]).toMatchObject({ id: 'Asia/Kolkata', matched: 'Mumbai' });
    expect(results('san fran')[0]).toMatchObject({ id: 'America/Los_Angeles', matched: 'San Francisco' });
    expect(results('beijing')[0]).toMatchObject({ id: 'Asia/Shanghai', matched: 'Beijing' });
    // Visible in the label: no extra text.
    expect(results('tokyo')[0]).toMatchObject({ id: 'Asia/Tokyo' });
    expect(results('tokyo')[0]?.matched).toBeUndefined();
    expect(results('new york').find((o) => o.id === 'America/New_York')?.matched).toBeUndefined();
  });

  it('keeps the result shape: id, label, detail, haystack', () => {
    const o = results('mumbai')[0] as ZoneOption;
    expect(Object.keys(o).sort()).toEqual(['detail', 'haystack', 'id', 'label', 'matched']);
    expect(o.label).toBe('Asia/Kolkata');
    expect(o.detail).toMatch(/^UTC\+05:30$/);
    expect(typeof o.haystack).toBe('string');
  });
});

describe('zone search: offset shorthand', () => {
  it.each(['+545', '+0545', '545', '+5:45', 'utc+545', 'gmt 5:45'])('%s finds UTC+05:45 and zones on +05:45', (q) => {
    const found = ids(q);
    expect(found[0]).toBe('UTC+05:45');
    expect(found).toContain('abbr:NPT');
    expect(found).toContain('Asia/Kathmandu');
    expect(found).not.toContain('UTC+05:30');
  });

  it.each(['-8', '−800', '-0800', '-08:00', 'utc-8'])('%s finds UTC-08:00 first', (q) => {
    const found = ids(q);
    expect(found[0]).toBe('UTC-08:00');
    expect(found).toContain('Pacific/Pitcairn');
  });
});

describe('zone search: ranking', () => {
  it('"ist" puts India first, Irish IST after it, Pakistan last', () => {
    const found = ids('ist');
    expect(found[0]).toBe('abbr:IST');
    expect(found.indexOf('abbr:IST-IE')).toBeGreaterThan(0);
    expect(found.indexOf('abbr:PKT')).toBeGreaterThan(found.indexOf('abbr:IST-IE'));
    expect(found.indexOf('Asia/Kolkata')).toBeGreaterThan(-1);
    expect(found.indexOf('Asia/Kolkata')).toBeLessThan(found.indexOf('Asia/Karachi'));
  });

  it('"gmt+1" and "+1" put UTC+01:00 first, and +10…+14 only after it', () => {
    for (const q of ['gmt+1', '+1', 'utc+1', 'GMT+01:00']) {
      const found = ids(q);
      expect(found[0]).toBe('UTC+01:00');
      const plus10 = found.indexOf('UTC+10:00');
      if (plus10 >= 0) expect(plus10).toBeGreaterThan(0);
    }
  });

  it('ranks exact abbreviation > exact city > word prefix > substring', () => {
    expect(first('pdt')).toBe('abbr:PDT');
    expect(first('cet')).toBe('abbr:CET');
    expect(first('paris')).toBe('Europe/Paris');
    // Prefix of a word beats a substring inside a word.
    const kath = ids('kath');
    expect(kath[0]).toBe('Asia/Kathmandu');
    const dam = ids('dam');
    expect(dam.indexOf('Asia/Damascus')).toBeGreaterThanOrEqual(0);
    expect(dam.indexOf('Asia/Damascus')).toBeLessThan(dam.indexOf('Europe/Amsterdam'));
  });
});

describe('zone labels', () => {
  it('gives region-suffixed abbreviations distinct labels', () => {
    expect(zoneLabel('abbr:IST-IE')).toBe('IST (IE)');
    expect(zoneLabel('abbr:CST-CN')).toBe('CST (CN)');
    expect(zoneLabel('abbr:IST')).toBe('IST');
    expect(zoneLabel('abbr:CST')).toBe('CST');
  });

  it('every abbreviation has a unique short label', () => {
    const labels = ZONE_ABBREVIATIONS.map((a) => resolveZone(`abbr:${a.code}`)?.short);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every option in the zone lists has a unique id and a unique label', () => {
    const all = zoneGroups().flatMap((g) => g.options);
    const byLabel = new Map<string, string[]>();
    for (const o of all) byLabel.set(o.label, [...(byLabel.get(o.label) ?? []), o.id]);
    const dupes = Array.from(byLabel.entries()).filter(([, v]) => v.length > 1);
    expect(dupes).toEqual([]);
    expect(new Set(all.map((o) => o.id)).size).toBe(all.length);
    // Labels match what zoneLabel shows for the same id everywhere else.
    for (const o of all) expect(zoneLabel(o.id)).toBe(o.label);
  });
});

describe('legacy IANA names', () => {
  const LEGACY: readonly (readonly [string, string])[] = [
    ['Asia/Katmandu', 'Asia/Kathmandu'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['Asia/Rangoon', 'Asia/Yangon'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ];

  it.each(LEGACY)('%s stays valid and displays as %s', (legacy, current) => {
    expect(isValidZone(legacy)).toBe(true);
    expect(zoneLabel(legacy)).toBe(current);
    expect(canonicalZone(legacy)).toBe(current);
    expect(canonicalZone(current)).toBe(current);
    expect(sameZone(legacy, current)).toBe(true);
    expect(viewInZone(Date.UTC(2024, 0, 1), legacy, false).label).toBe(current);
  });

  it('lists and searches only the current name', () => {
    const listed = new Set(listTimeZones());
    const inGroups = new Set(zoneGroups().flatMap((g) => g.options.map((o) => o.id)));
    for (const [legacy, current] of LEGACY) {
      expect(listed.has(legacy)).toBe(false);
      expect(inGroups.has(legacy)).toBe(false);
      expect(inGroups.has(current)).toBe(true);
    }
    expect(ids('katmandu')).toEqual(['Asia/Kathmandu']);
    expect(results('katmandu')[0]?.matched).toBe('Katmandu');
    expect(ids('calcutta')).toContain('Asia/Kolkata');
    expect(ids('calcutta')).not.toContain('Asia/Calcutta');
  });

  it('excludes the current name when the legacy one is already added', () => {
    expect(ids('kathmandu')).toContain('Asia/Kathmandu');
    expect(results('kathmandu', ['Asia/Katmandu']).map((o) => o.id)).not.toContain('Asia/Kathmandu');
  });
});

describe('zoneGroups cache', () => {
  it('rebuilds for a different minute, earlier or later', () => {
    const detail = (now: number): string | undefined =>
      zoneGroups(now)
        .flatMap((g) => g.options)
        .find((o) => o.id === 'America/New_York')?.detail;
    const november = Date.UTC(2026, 10, 1, 0, 0); // still EDT
    const january = Date.UTC(2026, 0, 15, 12, 0); // EST
    expect(detail(november)).toBe('UTC-04:00');
    expect(detail(january)).toBe('UTC-05:00');
    expect(detail(november + 30_000)).toBe('UTC-04:00');
    // Same minute: the cached object.
    expect(zoneGroups(january)).toBe(zoneGroups(january + 1_000));
  });
});

describe('excludedMatch', () => {
  it('names the added zone a query matches exactly', () => {
    expect(excludedMatch('kathmandu', ['Asia/Kathmandu'])).toBe('Asia/Kathmandu');
    expect(excludedMatch('Katmandu', ['Asia/Katmandu'])).toBe('Asia/Katmandu');
    expect(excludedMatch('pdt', ['abbr:PDT'])).toBe('abbr:PDT');
    expect(excludedMatch('+545', ['UTC+05:45'])).toBe('UTC+05:45');
  });

  it('is null for partial matches, other zones and empty input', () => {
    expect(excludedMatch('kath', ['Asia/Kathmandu'])).toBeNull();
    expect(excludedMatch('tokyo', ['Asia/Kathmandu'])).toBeNull();
    expect(excludedMatch('', ['Asia/Kathmandu'])).toBeNull();
    expect(excludedMatch('kathmandu', [])).toBeNull();
  });
});

describe('ianaEquivalent', () => {
  const at = Date.UTC(2026, 5, 1);
  it('keeps IANA ids and follows DST-aware generics', () => {
    expect(ianaEquivalent('Asia/Tokyo', at)).toBe('Asia/Tokyo');
    expect(ianaEquivalent('abbr:PT', at)).toBe('America/Los_Angeles');
    expect(ianaEquivalent('abbr:ET', at)).toBe('America/New_York');
  });

  it('gives a zone with the same offset all year for fixed ids', () => {
    expect(ianaEquivalent('abbr:IST', at)).toBe('Asia/Kolkata');
    expect(ianaEquivalent('UTC+05:45', at)).toBe('Asia/Kathmandu');
    expect(ianaEquivalent('UTC+05:30', at)).toBe('Asia/Kolkata');
    expect(ianaEquivalent('UTC-08:00', at)).toBe('Etc/GMT+8');
    expect(ianaEquivalent('abbr:PDT', at)).toBe('Etc/GMT+7');
    expect(ianaEquivalent('abbr:IST-IE', at)).toBe('Etc/GMT-1');
    expect(ianaEquivalent('UTC+00:00', at)).toBe('UTC');
    expect(ianaEquivalent('nonsense', at)).toBe('UTC');
    for (const id of ['UTC+05:45', 'UTC-08:00', 'abbr:PDT', 'abbr:IST-IE', 'UTC+12:45', 'UTC-09:30', 'UTC+08:45']) {
      const z = ianaEquivalent(id, at);
      expect(resolveZone(z)?.kind).toBe('iana');
      expect(offsetMinutesAt(at, z)).toBe(offsetMinutesAt(at, id));
    }
  });
});

describe('isValidZone', () => {
  it('accepts IANA ids', () => {
    expect(isValidZone('Asia/Kathmandu')).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isValidZone('Not/AZone')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('listTimeZones', () => {
  it('includes UTC and common zones', () => {
    const z = listTimeZones();
    expect(z).toContain('UTC');
    expect(z).toContain('Asia/Kathmandu');
    expect(z.length).toBeGreaterThan(10);
  });
});

describe('viewInZone', () => {
  const instant = Date.parse('2024-01-02T12:00:00Z'); // noon UTC

  it('formats UTC', () => {
    const v = viewInZone(instant, 'UTC', false);
    expect(v.time).toBe('12:00:00');
    expect(v.date).toBe('2024-01-02');
    expect(v.offset).toBe('+00:00');
  });

  it('handles fractional offset +05:45 (Kathmandu)', () => {
    const v = viewInZone(instant, 'Asia/Kathmandu', false);
    expect(v.offset).toBe('+05:45');
    expect(v.time).toBe('17:45:00'); // 12:00 + 5:45
  });

  it('handles +08:45 (Eucla)', () => {
    const v = viewInZone(instant, 'Australia/Eucla', false);
    expect(v.offset).toBe('+08:45');
  });

  it('respects 12h formatting', () => {
    const v = viewInZone(instant, 'UTC', true);
    expect(v.time).toMatch(/12:00:00\s?PM/i);
  });

  it('is DST-correct for New York (summer = EDT -04:00)', () => {
    const summer = Date.parse('2024-07-01T12:00:00Z');
    const v = viewInZone(summer, 'America/New_York', false);
    expect(v.offset).toBe('-04:00');
  });

  it('is DST-correct for New York (winter = EST -05:00)', () => {
    const winter = Date.parse('2024-01-01T12:00:00Z');
    const v = viewInZone(winter, 'America/New_York', false);
    expect(v.offset).toBe('-05:00');
  });
});

describe('wallClockToEpochMs', () => {
  it('round-trips a UTC wall clock', () => {
    const ms = wallClockToEpochMs('2024-01-02T12:00:00', 'UTC');
    expect(toIsoUtc(ms)).toBe('2024-01-02T12:00:00.000Z');
  });

  it('applies Kathmandu offset on input', () => {
    // 17:45 Kathmandu == 12:00 UTC
    const ms = wallClockToEpochMs('2024-01-02T17:45:00', 'Asia/Kathmandu');
    expect(toIsoUtc(ms)).toBe('2024-01-02T12:00:00.000Z');
  });
});
