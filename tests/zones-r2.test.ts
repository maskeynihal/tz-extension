import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  UTC_OFFSET_MINUTES,
  canonicalZone,
  displayZoneName,
  fixedZoneId,
  ianaEquivalent,
  isValidZone,
  resolveZone,
  sameZone,
  searchZones,
  viewInZone,
  wallClockToEpochMs,
  wallClockToInstant,
  zoneGroups,
  zoneLabel,
} from '../src/lib/tz';
import { DEFAULT_PREFERENCES, resolveLocalZone } from '../src/types';

const JAN = Date.UTC(2024, 0, 15, 12);
const JUL = Date.UTC(2024, 6, 15, 12);

/** Ids of the first `n` results, across groups. */
const top = (q: string, n: number): string[] => searchZones(q).flatMap((g) => g.options.map((o) => o.id)).slice(0, n);

afterEach(() => vi.restoreAllMocks());

describe('local zone under its legacy name', () => {
  const engineSays = (zone: string): void => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    // Only the first call (resolveLocalZone's own) reports the legacy name.
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementationOnce(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: zone };
    });
  };

  it.each([
    ['Asia/Katmandu', 'Asia/Kathmandu'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Asia/Kathmandu', 'Asia/Kathmandu'],
    ['UTC', 'UTC'],
  ])('resolveLocalZone turns %s into %s', (reported, want) => {
    engineSays(reported);
    expect(resolveLocalZone()).toBe(want);
  });

  it('the default home zone is already canonical', () => {
    expect(DEFAULT_PREFERENCES.homeZone).toBe(canonicalZone(DEFAULT_PREFERENCES.homeZone));
  });

  // Same pairs as LEGACY_ZONES in src/lib/tz.ts.
  it.each([
    ['Africa/Asmera', 'Africa/Asmara'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['America/Catamarca', 'America/Argentina/Catamarca'],
    ['America/Coral_Harbour', 'America/Atikokan'],
    ['America/Cordoba', 'America/Argentina/Cordoba'],
    ['America/Godthab', 'America/Nuuk'],
    ['America/Indianapolis', 'America/Indiana/Indianapolis'],
    ['America/Jujuy', 'America/Argentina/Jujuy'],
    ['America/Louisville', 'America/Kentucky/Louisville'],
    ['America/Mendoza', 'America/Argentina/Mendoza'],
    ['America/Montreal', 'America/Toronto'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Asia/Katmandu', 'Asia/Kathmandu'],
    ['Asia/Rangoon', 'Asia/Yangon'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['Atlantic/Faeroe', 'Atlantic/Faroe'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Pacific/Enderbury', 'Pacific/Kanton'],
    ['Pacific/Ponape', 'Pacific/Pohnpei'],
    ['Pacific/Truk', 'Pacific/Chuuk'],
    ['America/Argentina/ComodRivadavia', 'America/Argentina/Catamarca'],
  ])('sameZone(%s, %s)', (legacy, current) => {
    expect(isValidZone(legacy)).toBe(true);
    expect(sameZone(legacy, current)).toBe(true);
    expect(sameZone(current, legacy)).toBe(true);
    expect(canonicalZone(legacy)).toBe(current);
  });

  it('sameZone still tells different zones apart', () => {
    expect(sameZone('Asia/Katmandu', 'Asia/Kolkata')).toBe(false);
    expect(sameZone('abbr:PT', 'America/Los_Angeles')).toBe(false);
  });
});

describe('displayZoneName', () => {
  it.each([
    ['Asia/Katmandu', 'Kathmandu'],
    ['Asia/Kathmandu', 'Kathmandu'],
    ['Asia/Calcutta', 'Kolkata'],
    ['America/Argentina/ComodRivadavia', 'Catamarca'],
    ['America/New_York', 'New York'],
    ['America/Indiana/Indianapolis', 'Indianapolis'],
    ['UTC', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['UTC+05:45', 'UTC+05:45'],
    ['UTC-08:00', 'UTC-08:00'],
    ['abbr:PT', 'PT'],
    ['abbr:IST-IE', 'IST (IE)'],
    ['Not/AZone', 'Not/AZone'],
  ])('%s → %s', (zone, want) => {
    expect(displayZoneName(zone)).toBe(want);
  });
});

describe('ianaEquivalent for offsets without an Etc name', () => {
  it.each([
    ['UTC+12:45', JAN, 'Pacific/Chatham'],
    ['UTC+12:45', JUL, 'Pacific/Chatham'],
    ['UTC+13:45', JAN, 'Pacific/Chatham'],
    ['UTC+13:45', JUL, 'Pacific/Chatham'],
    ['UTC+05:45', JAN, 'Asia/Kathmandu'],
    ['UTC+08:45', JAN, 'Australia/Eucla'],
    ['UTC+08:45', JUL, 'Australia/Eucla'],
    ['UTC+09:30', JAN, 'Australia/Darwin'],
    ['UTC+09:30', JUL, 'Australia/Darwin'],
    // +10:30 is Adelaide's summer time and Lord Howe's standard time.
    ['UTC+10:30', JAN, 'Australia/Adelaide'],
    ['UTC+10:30', JUL, 'Australia/Lord_Howe'],
    ['abbr:ACDT', JAN, 'Australia/Adelaide'],
    ['UTC-09:30', JAN, 'Pacific/Marquesas'],
    ['UTC-09:30', JUL, 'Pacific/Marquesas'],
    ['UTC-03:30', JAN, 'America/St_Johns'],
    ['UTC-03:30', JUL, 'America/St_Johns'],
    ['UTC-02:30', JAN, 'America/St_Johns'],
    ['UTC-02:30', JUL, 'America/St_Johns'],
    ['abbr:NST', JUL, 'America/St_Johns'],
    ['abbr:NDT', JAN, 'America/St_Johns'],
    ['UTC+03:30', JAN, 'Asia/Tehran'],
    ['UTC+04:30', JAN, 'Asia/Kabul'],
    ['UTC+06:30', JAN, 'Asia/Yangon'],
  ])('%s at %s → %s', (zone, at, want) => {
    expect(ianaEquivalent(zone, at)).toBe(want);
  });

  it('never gives UTC for an offset a real zone uses, in either season', () => {
    for (const m of [...UTC_OFFSET_MINUTES, 825]) {
      if (m === 0) continue;
      for (const at of [JAN, JUL]) {
        const iana = ianaEquivalent(fixedZoneId(m), at);
        expect(iana, `${fixedZoneId(m)} at ${new Date(at).toISOString()}`).not.toBe('UTC');
        expect(resolveZone(iana)?.kind).toBe('iana');
      }
    }
  });
});

describe('country search', () => {
  it('"usa" and friends list the US generics east to west, then the US zones', () => {
    for (const q of ['usa', 'USA', 'us', 'united states', 'america']) {
      expect(top(q, 6), q).toEqual(['abbr:ET', 'abbr:CT', 'abbr:MT', 'abbr:PT', 'abbr:AKT', 'abbr:HST']);
    }
    const ids = searchZones('usa').flatMap((g) => g.options.map((o) => o.id));
    const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
    expect(ids.filter((z) => zones.includes(z))).toEqual(zones);
  });

  it('says which name matched', () => {
    const et = searchZones('usa')[0]?.options[0];
    expect(et?.matched).toBe('USA');
  });

  it.each([
    ['uae', ['Asia/Dubai']],
    ['uk', ['Europe/London']],
    ['england', ['Europe/London']],
    ['scotland', ['Europe/London']],
    ['wales', ['Europe/London']],
    ['russia', ['Europe/Moscow', 'Europe/Kaliningrad', 'Europe/Samara']],
    ['brazil', ['America/Sao_Paulo', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha']],
    ['canada', ['abbr:ET', 'abbr:CT', 'abbr:MT', 'abbr:PT']],
    ['australia', ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth']],
    ['mexico', ['America/Mexico_City', 'America/Cancun', 'America/Tijuana']],
    ['indonesia', ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']],
  ])('%s starts with its main zones', (q, want) => {
    expect(top(q, want.length)).toEqual(want);
  });

  it('canada also lists its IANA zones', () => {
    const ids = searchZones('canada').flatMap((g) => g.options.map((o) => o.id));
    for (const z of ['America/Toronto', 'America/Vancouver', 'America/Halifax', 'America/St_Johns']) expect(ids).toContain(z);
  });

  it('russia still reaches the Asian zones after Moscow', () => {
    const ids = searchZones('russia').flatMap((g) => g.options.map((o) => o.id));
    expect(ids).toContain('Asia/Vladivostok');
    expect(ids.indexOf('Europe/Moscow')).toBeLessThan(ids.indexOf('Asia/Yekaterinburg'));
  });
});

describe('displayed offsets use the ASCII hyphen-minus', () => {
  it('labels and descriptions', () => {
    expect(zoneLabel('UTC-08:00')).toBe('UTC-08:00');
    expect(resolveZone('UTC-03:30')?.long).toBe('UTC-03:30');
    expect(resolveZone('abbr:PST')?.long).toBe('Pacific Standard Time · UTC-08:00');
    expect(viewInZone(JAN, 'America/New_York', false).offset).toBe('-05:00');
    expect(viewInZone(JAN, 'UTC-08:00', false).label).toBe('UTC-08:00');
  });

  it('no group label, option label or detail shows U+2212', () => {
    for (const g of zoneGroups(JAN)) {
      expect(g.label).not.toContain('\u2212');
      for (const o of g.options) {
        expect(o.label, o.id).not.toContain('\u2212');
        expect(o.detail, o.id).not.toContain('\u2212');
      }
    }
  });

  it('search still accepts U+2212 and the en dash', () => {
    expect(top('utc\u22128', 1)).toEqual(['UTC-08:00']);
    expect(top('utc\u20138', 1)).toEqual(['UTC-08:00']);
    expect(top('\u221203:30', 1)).toEqual(['UTC-03:30']);
  });
});

describe('wallClockToInstant', () => {
  it('flags a spring-forward gap and moves the time forward', () => {
    expect(wallClockToInstant('2024-03-10T02:30', 'America/New_York')).toEqual({
      epochMs: Date.parse('2024-03-10T07:30:00Z'),
      wallClock: 'gap',
    });
    expect(wallClockToEpochMs('2024-03-10T02:30:00', 'America/New_York')).toBe(Date.parse('2024-03-10T07:30:00Z'));
  });

  it('flags a fall-back overlap and takes the earlier instant', () => {
    expect(wallClockToInstant('2024-11-03T01:30', 'America/New_York')).toEqual({
      epochMs: Date.parse('2024-11-03T05:30:00Z'),
      wallClock: 'ambiguous',
    });
    expect(wallClockToEpochMs('2024-11-03T01:30:00', 'America/New_York')).toBe(Date.parse('2024-11-03T05:30:00Z'));
  });

  it('follows the zone a DST-aware abbreviation tracks', () => {
    expect(wallClockToInstant('2024-03-10T02:30', 'abbr:ET')?.wallClock).toBe('gap');
    expect(wallClockToInstant('2024-11-03T01:30', 'abbr:ET')?.wallClock).toBe('ambiguous');
  });

  it('accepts fixed offsets, fixed abbreviations and legacy names', () => {
    expect(wallClockToInstant('2024-03-10T02:30', 'UTC+05:45')).toEqual({ epochMs: Date.parse('2024-03-09T20:45:00Z') });
    expect(wallClockToInstant('2024-03-10T02:30', 'abbr:PST')).toEqual({ epochMs: Date.parse('2024-03-10T10:30:00Z') });
    expect(wallClockToInstant('2024-01-02T17:45', 'Asia/Katmandu')).toEqual({ epochMs: Date.parse('2024-01-02T12:00:00Z') });
    expect(wallClockToInstant('2024-01-02T12:00:30', 'UTC')).toEqual({ epochMs: Date.parse('2024-01-02T12:00:30Z') });
  });

  it('is null (NaN for wallClockToEpochMs) for a bad zone or string', () => {
    expect(wallClockToInstant('2024-03-10T02:30', 'Mars/Olympus')).toBeNull();
    expect(wallClockToInstant('2024-03-10 02:30', 'UTC')).toBeNull();
    expect(wallClockToEpochMs('garbage', 'UTC')).toBeNaN();
    expect(wallClockToEpochMs('2024-03-10T02:30', 'Mars/Olympus')).toBeNaN();
  });
});
