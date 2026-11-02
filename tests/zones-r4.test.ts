import { describe, it, expect, afterEach } from 'vitest';
import {
  ZONE_ABBREVIATIONS,
  displayZoneName,
  excludedMatch,
  resolveZone,
  viewInZone,
  zoneGroups,
  zoneLabel,
} from '../src/lib/tz';
import { describeWallClock } from '../src/lib/wall-note';
import { wallFieldsToInstant } from '../src/lib/wallclock';

/* Round 4: abbreviations Intl lacks, city punctuation, Etc/GMT±N labels, partial "Already added". */

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const JAN = Date.UTC(2024, 0, 15, 12);
const JUL = Date.UTC(2024, 6, 15, 12);

describe('abbreviations Intl lacks (QA #6)', () => {
  it.each([
    ['America/St_Johns', JAN, 'NST'],
    ['America/St_Johns', JUL, 'NDT'],
    ['Pacific/Chatham', JAN, 'CHADT'],
    ['Pacific/Chatham', JUL, 'CHAST'],
    ['Asia/Kathmandu', JAN, 'NPT'],
    ['Asia/Katmandu', JAN, 'NPT'], // legacy id, same zone
    ['Europe/Jersey', JUL, 'BST'],
    // Intl's own letters still win.
    ['America/New_York', JUL, 'EDT'],
    ['Europe/London', JAN, 'GMT'],
    // No entry: Intl's offset form stays.
    ['Asia/Kabul', JAN, 'GMT+4:30'],
    // Region-suffixed codes are never used: Dublin's summer is not "IST (IE)".
    ['Europe/Dublin', JUL, 'GMT+1'],
  ])('%s at %s is %s', (zone, at, abbr) => {
    expect(viewInZone(at, zone, false).abbrev).toBe(abbr);
  });

  it('only when the offset matches the entry at that instant', () => {
    // St John's in 1900 was on local mean time, -03:30:52: no NST.
    const lmt = viewInZone(Date.UTC(1900, 0, 1), 'America/St_Johns', false);
    expect(lmt.time).toBe('20:29:08');
    expect(lmt.abbrev).not.toBe('NST');
    // Kathmandu was on +05:30 before 1986: not NPT.
    expect(viewInZone(Date.UTC(1980, 0, 1), 'Asia/Kathmandu', false).abbrev).not.toBe('NPT');
  });

  it('fixed abbreviations and offsets keep their own label', () => {
    expect(viewInZone(JAN, 'abbr:NST', false).abbrev).toBe('NST');
    expect(viewInZone(JAN, 'abbr:CHAST', false).abbrev).toBe('CHAST');
    expect(viewInZone(JAN, 'UTC-03:30', false).abbrev).toBe('UTC-03:30');
  });

  it("St John's and Chatham fall-back notes use the abbreviation, under any host zone", () => {
    for (const host of ['America/New_York', 'Asia/Kathmandu', 'UTC']) {
      process.env.TZ = host;
      // St John's: 2 Nov 2025 02:00 NDT falls back to 01:00 NST.
      const nl = wallFieldsToInstant({ y: 2025, mo: 11, d: 2, h: 1, mi: 30, s: 0 }, 'America/St_Johns');
      expect(nl?.wallClock).toBe('ambiguous');
      expect(describeWallClock('ambiguous', nl!.epochMs, 'America/St_Johns', false)).toBe(
        "01:30 happens twice on 2 Nov in St. John's; showing the first (NDT).",
      );
      // Chatham: 7 Apr 2024 03:45 CHADT falls back to 02:45 CHAST.
      const ch = wallFieldsToInstant({ y: 2024, mo: 4, d: 7, h: 2, mi: 50, s: 0 }, 'Pacific/Chatham');
      expect(ch?.wallClock).toBe('ambiguous');
      expect(describeWallClock('ambiguous', ch!.epochMs, 'Pacific/Chatham', false)).toBe(
        '02:50 happens twice on 7 Apr in Chatham; showing the first (CHADT).',
      );
    }
  });

  it('CHAST and CHADT are offered abbreviations with unique labels', () => {
    expect(resolveZone('abbr:CHAST')).toMatchObject({ kind: 'abbr', minutes: 765, short: 'CHAST' });
    expect(resolveZone('abbr:CHADT')).toMatchObject({ kind: 'abbr', minutes: 825, short: 'CHADT' });
    const abbrs = zoneGroups().find((g) => g.id === 'abbr')?.options.map((o) => o.id) ?? [];
    expect(abbrs).toEqual(expect.arrayContaining(['abbr:CHAST', 'abbr:CHADT']));
    expect(new Set(ZONE_ABBREVIATIONS.map((a) => a.code)).size).toBe(ZONE_ABBREVIATIONS.length);
  });
});

describe('displayZoneName punctuation', () => {
  it.each([
    ['America/St_Johns', "St. John's"],
    ['Antarctica/DumontDUrville', "Dumont d'Urville"],
    ['America/Lower_Princes', "Lower Prince's Quarter"],
    ['America/St_Kitts', 'St. Kitts'],
    ['Atlantic/St_Helena', 'St. Helena'],
    ['America/Port-au-Prince', 'Port-au-Prince'],
    ['Asia/Ho_Chi_Minh', 'Ho Chi Minh'],
    ['Asia/Saigon', 'Ho Chi Minh'],
    ['America/New_York', 'New York'],
    ['America/Argentina/Buenos_Aires', 'Buenos Aires'],
  ])('%s → %s', (zone, name) => {
    if (!resolveZone(zone)) return; // not on this engine
    expect(displayZoneName(zone)).toBe(name);
  });

  it('zoneLabel keeps the IANA id with underscores', () => {
    expect(zoneLabel('America/St_Johns')).toBe('America/St_Johns');
  });
});

describe('Etc/GMT±N shows its real offset (POSIX signs are reversed)', () => {
  it.each([
    ['Etc/GMT+12', 'UTC-12:00'],
    ['Etc/GMT-14', 'UTC+14:00'],
    ['Etc/GMT+5', 'UTC-05:00'],
    ['Etc/GMT-1', 'UTC+01:00'],
  ])('%s → %s', (zone, label) => {
    expect(zoneLabel(zone)).toBe(label);
    expect(displayZoneName(zone)).toBe(label);
    expect(viewInZone(JAN, zone, false).label).toBe(label);
    // The id stays the zone, and `long` names it.
    expect(resolveZone(zone)).toMatchObject({ kind: 'iana', tz: zone, long: zone });
  });

  it('the label agrees with the offset shown', () => {
    const v = viewInZone(Date.UTC(2024, 6, 15, 12), 'Etc/GMT+12', false);
    expect(v.offset).toBe('-12:00');
    expect(v.label).toBe(`UTC${v.offset}`);
    expect(v.time).toBe('00:00:00');
  });

  it('Etc/GMT+0 and UTC aliases read UTC', () => {
    for (const z of ['Etc/GMT+0', 'Etc/GMT-0', 'Etc/GMT', 'Etc/UTC', 'UTC']) {
      if (resolveZone(z)) expect(displayZoneName(z)).toBe('UTC');
    }
  });
});

describe('excludedMatch partial (QA #8)', () => {
  const added = ['Asia/Kathmandu'];
  it.each(['kathm', 'kath', 'mandu', 'nepal', 'NPT', 'utc+5:45', '+545', 'Katmandu'])('"%s" finds Asia/Kathmandu', (q) => {
    expect(excludedMatch(q, added, { partial: true })).toBe('Asia/Kathmandu');
  });

  it('returns the id as saved (legacy alias)', () => {
    expect(excludedMatch('kathm', ['Asia/Katmandu'], { partial: true })).toBe('Asia/Katmandu');
  });

  it('prefers the best hit among several added zones', () => {
    expect(excludedMatch('kol', ['Asia/Kathmandu', 'Asia/Kolkata'], { partial: true })).toBe('Asia/Kolkata');
  });

  it('null for other zones, gibberish and empty input; exact mode unchanged', () => {
    expect(excludedMatch('tokyo', added, { partial: true })).toBeNull();
    expect(excludedMatch('zzzqqq', added, { partial: true })).toBeNull();
    expect(excludedMatch('', added, { partial: true })).toBeNull();
    expect(excludedMatch('kathm', [], { partial: true })).toBeNull();
    expect(excludedMatch('kathm', added)).toBeNull();
    expect(excludedMatch('kathmandu', added)).toBe('Asia/Kathmandu');
  });
});
