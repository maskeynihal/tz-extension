import { describe, it, expect } from 'vitest';
import { parseTimes, SCAN_LIMIT } from '../src/lib/parse';
import { BUILTIN_FORMATS, BUILTIN_FORMAT_IDS } from '../src/lib/builtin-formats';
import {
  compileAdvancedFormat,
  compileTokenFormat,
  hasNestedQuantifier,
  matchCustomFormat,
  parseCustom,
} from '../src/lib/custom-formats';
import { isRealDate, resolveZoneToken, todayIn } from '../src/lib/time-tokens';
import type { CustomFormat } from '../src/types';

const iso = (ms: number): string => new Date(ms).toISOString();
const fmt = (pattern: string, extra: Partial<CustomFormat> = {}): CustomFormat => ({
  id: extra.id ?? `f-${pattern}`,
  label: extra.label ?? pattern,
  pattern,
  advanced: extra.advanced ?? false,
  enabled: extra.enabled ?? true,
});
const ctx = { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' as const };

describe('built-in registry', () => {
  it('lists every built-in with an id, label, description, examples and regex', () => {
    expect(BUILTIN_FORMAT_IDS).toEqual([
      'epoch-seconds',
      'epoch-millis',
      'iso-8601',
      'ymd-slash',
      'long-form',
      'day-month-name',
      'time-of-day',
    ]);
    for (const f of BUILTIN_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.examples.length).toBeGreaterThan(0);
      expect(f.regex).toBeInstanceOf(RegExp);
    }
  });

  it('every listed example is recognized by its own format', () => {
    for (const f of BUILTIN_FORMATS) {
      for (const ex of f.examples) {
        const hits = f.match(ex, ctx);
        expect(hits.length, `${f.id} should match "${ex}"`).toBeGreaterThan(0);
        expect(hits[0]?.parsed.formatId).toBe(f.id);
      }
    }
  });

  it('tags results with the format that matched', () => {
    const [r] = parseTimes('2024-01-02T15:04:05Z', 'UTC');
    expect(r?.formatId).toBe('iso-8601');
    expect(r?.formatLabel).toBe('ISO 8601');
  });
});

describe('disabling built-in formats', () => {
  it('skips a disabled format entirely', () => {
    expect(parseTimes('1700000000', { assumedZone: 'UTC', disabledFormats: ['epoch-seconds'] })).toHaveLength(0);
  });

  it('does not fall back to "today" for the time part of a disabled date format', () => {
    // With ISO off, "15:04" belongs to a date nothing reads; showing it as
    // today would be confidently wrong.
    expect(parseTimes('2024-01-02 15:04', { assumedZone: 'UTC', disabledFormats: ['iso-8601'] })).toHaveLength(0);
    expect(parseTimes('2024/01/02 15:04', { assumedZone: 'UTC', disabledFormats: ['ymd-slash'] })).toHaveLength(0);
    expect(parseTimes('2 Jan 2024 15:00', { assumedZone: 'UTC', disabledFormats: ['day-month-name'] })).toHaveLength(0);
    expect(parseTimes('Oct 28 2026 4:24 PM', { assumedZone: 'UTC', disabledFormats: ['long-form'] })).toHaveLength(0);
  });

  it('lets another format take over for a different value', () => {
    const [r] = parseTimes('2024-01-02 and later 15:04', { assumedZone: 'UTC', disabledFormats: ['iso-8601'] });
    expect(r?.formatId).toBe('time-of-day');
  });

  it('ignores unknown ids', () => {
    expect(parseTimes('1700000000', { assumedZone: 'UTC', disabledFormats: ['nope'] })).toHaveLength(1);
  });
});

describe('overlap resolution', () => {
  it('a custom format wins a same-length tie against a built-in (epoch digits)', () => {
    const [r, ...rest] = parseTimes('202412311030', {
      assumedZone: 'UTC',
      customFormats: [fmt('YYYYMMDDHHmm', { label: 'Compact' })],
    });
    expect(rest).toHaveLength(0);
    expect(r?.kind).toBe('custom');
    expect(r?.formatLabel).toBe('Compact');
    expect(iso(r!.epochMs)).toBe('2024-12-31T10:30:00.000Z');
  });

  it('a loose custom format cannot steal part of a longer built-in match', () => {
    const [r, ...rest] = parseTimes('2024-01-02 15:04', {
      assumedZone: 'UTC',
      customFormats: [fmt('H:mm')],
    });
    expect(rest).toHaveLength(0);
    expect(r?.formatId).toBe('iso-8601');
  });

  it('returns separate values in document order after the best one', () => {
    const rs = parseTimes('at 9:00 from 2024-01-02T10:00:00Z until 1700000000', 'UTC');
    expect(rs.map((r) => r.formatId)).toEqual(['iso-8601', 'time-of-day', 'epoch-seconds']);
  });

  it('leads with the most specific value, not the first one', () => {
    const [r] = parseTimes('Starts 9:00, deadline 2024-01-02T15:00Z', 'UTC');
    expect(r?.formatId).toBe('iso-8601');
  });

  it('a long-form date is not double-counted as a bare time', () => {
    const rs = parseTimes('Wednesday, October 28, 2026, 04:24:09 UTC', 'UTC');
    expect(rs).toHaveLength(1);
    expect(rs[0]?.formatId).toBe('long-form');
  });

  it('only scans the first SCAN_LIMIT characters', () => {
    const text = `${'x '.repeat(SCAN_LIMIT)} 1700000000`;
    expect(parseTimes(text, 'UTC')).toHaveLength(0);
  });

  it('finds a time after many plain numbers in a long selection', () => {
    const text = `${Array.from({ length: 600 }, (_, i) => String(i % 10)).join(' ')} 10:30`;
    expect(parseTimes(text, 'UTC')[0]?.matchedText).toBe('10:30');
  });

  it('finds a timestamp at the end of a long article', () => {
    const text = `${'lorem ipsum dolor sit amet '.repeat(500)}2024-12-31T10:30:00Z`;
    expect(text.length).toBeGreaterThan(13_000);
    expect(parseTimes(text, 'UTC')[0]?.matchedText).toBe('2024-12-31T10:30:00Z');
  });
});

describe('built-in fixes', () => {
  it('keeps ISO fractional seconds', () => {
    const [r] = parseTimes('2024-01-02T15:04:05.123Z', 'UTC');
    expect(iso(r!.epochMs)).toBe('2024-01-02T15:04:05.123Z');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseTimes('2024-02-31', 'UTC')).toHaveLength(0);
    expect(parseTimes('2023-02-29', 'UTC')).toHaveLength(0);
    expect(parseTimes('2024-02-29', 'UTC')).toHaveLength(1);
  });

  it('does not treat a following word as a zone', () => {
    const [r] = parseTimes('October 28, 2026 Meeting', 'UTC');
    expect(r?.matchedText).toBe('October 28, 2026');
    expect(r?.assumed).toBe(true);
  });

  it('a number followed by a word is not a time', () => {
    expect(parseTimes('chapter 5 today', 'UTC')).toHaveLength(0);
  });

  it('a bare time lands on today in the assumed zone', () => {
    const now = Date.UTC(2024, 0, 1, 20, 0, 0); // 2024-01-02 01:45 in Kathmandu
    const [r] = parseTimes('09:00', { assumedZone: 'Asia/Kathmandu', nowMs: now });
    expect(iso(r!.epochMs)).toBe('2024-01-02T03:15:00.000Z');
  });

  it('applies the date-only policy to day-first written dates', () => {
    const [r] = parseTimes('28 February 2024', { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' });
    expect(r?.dateOnly).toBe(true);
    expect(iso(r!.epochMs)).toBe('2024-02-28T00:00:00.000Z');
  });
});

describe('custom token patterns: validation messages', () => {
  const err = (p: string): string => {
    const r = compileTokenFormat(p);
    return r.ok ? 'OK' : r.error;
  };
  it('empty', () => expect(err('')).toMatch(/Enter a pattern/));
  it('too long', () => expect(err('Y'.repeat(200))).toMatch(/too long/));
  it('no tokens', () => expect(err('hello')).toMatch(/12-hour|date or time tokens/));
  it('literal-only', () => expect(err('[hello]')).toMatch(/date or time tokens/));
  it('duplicate field', () => expect(err('D MMM YYYY D')).toMatch(/repeats the day/));
  it('month without day', () => expect(err('MM/YYYY')).toMatch(/needs both a month/));
  it('minutes without hour', () => expect(err('DD/MM mm')).toMatch(/Minutes \(mm\) need an hour/));
  it('12-hour hour without A', () => expect(err('hh:mm')).toMatch(/12-hour clock/));
  it('A without hour', () => expect(err('DD/MM A')).toMatch(/AM\/PM/));
  it('unclosed bracket', () => expect(err('DD/MM [at HH:mm')).toMatch(/Unclosed \[/));
  it('valid', () => expect(err('DD/MM/YYYY HH:mm')).toBe('OK'));
});

describe('custom token patterns: matching', () => {
  const one = (pattern: string, text: string, zone = 'UTC'): string | null => {
    const r = parseCustom(text, zone, [fmt(pattern)]);
    return r ? iso(r.epochMs) : null;
  };

  it('DD/MM/YYYY HH:mm', () => expect(one('DD/MM/YYYY HH:mm', '31/12/2024 23:59')).toBe('2024-12-31T23:59:00.000Z'));
  it('12-hour with hh and A', () =>
    expect(one('MM/DD/YYYY hh:mm A', '12/31/2024 03:15 PM')).toBe('2024-12-31T15:15:00.000Z'));
  it('12-hour with h and lowercase am', () => expect(one('h:mm A', '9:05 am', 'UTC')?.slice(11)).toBe('09:05:00.000Z'));
  it('a.m. with dots', () => expect(one('h:mm A', '12:30 a.m.')?.slice(11)).toBe('00:30:00.000Z'));
  it('MMM short month', () => expect(one('D MMM YYYY', 'due 5 Sep 2024')).toBe('2024-09-05T00:00:00.000Z'));
  it('MMMM full month and Do suffix', () =>
    expect(one('MMMM Do, YYYY', 'March 3rd, 2025')).toBe('2025-03-03T00:00:00.000Z'));
  it('legacy MON token still works', () => expect(one('DD MON YYYY', '02 Jan 2024')).toBe('2024-01-02T00:00:00.000Z'));
  it('rejects a word that is not a month', () => expect(one('D MMM YYYY', '5 Foo 2024')).toBeNull());
  it('[literal] text', () =>
    expect(one('DD.MM.YYYY [um] HH:mm', '31.12.2024 um 10:30')).toBe('2024-12-31T10:30:00.000Z'));
  it('SSS milliseconds', () =>
    expect(one('HH:mm:ss.SSS DD/MM/YYYY', '10:00:01.250 02/01/2024')).toBe('2024-01-02T10:00:01.250Z'));
  it('TZ abbreviation is applied (not ignored)', () =>
    expect(one('DD/MM/YYYY HH:mm TZ', '02/01/2024 10:00 EST')).toBe('2024-01-02T15:00:00.000Z'));
  it('TZ GMT+5:30 form', () =>
    expect(one('DD/MM/YYYY HH:mm TZ', '02/01/2024 10:00 GMT+5:30')).toBe('2024-01-02T04:30:00.000Z'));
  it('TZ offset form', () =>
    expect(one('DD/MM/YYYY HH:mm TZ', '02/01/2024 10:00 +05:45')).toBe('2024-01-02T04:15:00.000Z'));
  it('rejects an unknown zone word', () => expect(one('DD/MM/YYYY HH:mm TZ', '02/01/2024 10:00 FOO')).toBeNull());
  it('two-digit year', () => expect(one('DD/MM/YY', '02/01/24')).toBe('2024-01-02T00:00:00.000Z'));
  it('rejects 31 February', () => expect(one('DD/MM/YYYY', '31/02/2024')).toBeNull());
  it('rejects hour 24', () => expect(one('DD/MM/YYYY HH:mm', '01/01/2024 24:00')).toBeNull());
  it('does not match inside a longer number', () => expect(one('D/M/YYYY', '131/12/20245')).toBeNull());

  it('a format without a year uses the current year', () => {
    const r = matchCustomFormat('31/12 10:00', fmt('DD/MM HH:mm'), { ...ctx, nowMs: Date.UTC(2030, 5, 1) });
    expect(iso(r[0]!.parsed.epochMs)).toBe('2030-12-31T10:00:00.000Z');
  });

  it('a time-only format lands on today', () => {
    const r = matchCustomFormat('at 14h30', fmt('HH[h]mm'), { ...ctx, nowMs: Date.UTC(2030, 5, 1, 3) });
    expect(iso(r[0]!.parsed.epochMs)).toBe('2030-06-01T14:30:00.000Z');
  });

  it('a date-only custom format follows the date-only policy', () => {
    const r = matchCustomFormat('02/01/2024', fmt('DD/MM/YYYY'), ctx);
    expect(r[0]?.parsed.dateOnly).toBe(true);
  });

  it('without a zone, the value is read in the assumed zone', () => {
    const r = parseCustom('02/01/2024 10:00', 'Asia/Kathmandu', [fmt('DD/MM/YYYY HH:mm')]);
    expect(r?.assumed).toBe(true);
    expect(iso(r!.epochMs)).toBe('2024-01-02T04:15:00.000Z');
  });

  it('finds a valid match after an invalid one', () => {
    const r = matchCustomFormat('31/02/2024 or 28/02/2024', fmt('DD/MM/YYYY'), ctx);
    expect(r).toHaveLength(1);
    expect(r[0]?.parsed.matchedText).toBe('28/02/2024');
  });

  it('a disabled format never matches', () => {
    expect(matchCustomFormat('31/12/2024', fmt('DD/MM/YYYY', { enabled: false }), ctx)).toHaveLength(0);
  });
});

describe('custom advanced regexes', () => {
  const err = (p: string): string => {
    const r = compileAdvancedFormat(p);
    return r.ok ? 'OK' : r.error;
  };
  it('invalid syntax', () => expect(err('(?<y>\\d{4}')).toMatch(/Invalid regular expression/));
  it('no named groups', () => expect(err('(\\d{4})-(\\d{2})')).toMatch(/Name your capture groups/));
  it('unknown group', () => expect(err('(?<year>\\d{4})')).toMatch(/Unknown group \(\?<year>\)/));
  it('two groups for one field', () => expect(err('(?<mo>\\d{2}) (?<moName>[A-Z]+) (?<d>\\d)')).toMatch(/both set the month/));
  it('nested quantifier', () => expect(err('(?<d>(\\d+)+)/(?<mo>\\d{2})')).toMatch(/repeats a group/));
  it('matches empty text', () => expect(err('(?<h>\\d*)')).toMatch(/empty text/));
  it('valid', () => expect(err('(?<y>\\d{4})\\.(?<mo>\\d{2})\\.(?<d>\\d{2})')).toBe('OK'));

  it('an optional time group is honoured when absent and present', () => {
    const f = fmt('(?<d>\\d{2})\\.(?<mo>\\d{2})\\.(?<y>\\d{4})(?: (?<h>\\d{2}):(?<mi>\\d{2}))?', { advanced: true });
    expect(iso(matchCustomFormat('02.01.2024', f, ctx)[0]!.parsed.epochMs)).toBe('2024-01-02T00:00:00.000Z');
    expect(iso(matchCustomFormat('02.01.2024 10:30', f, ctx)[0]!.parsed.epochMs)).toBe('2024-01-02T10:30:00.000Z');
  });

  it('only scans the first 500 characters', () => {
    const f = fmt('(?<y>\\d{4})\\.(?<mo>\\d{2})\\.(?<d>\\d{2})', { advanced: true });
    expect(matchCustomFormat(`${'x'.repeat(600)} 2024.01.02`, f, ctx)).toHaveLength(0);
  });
});

describe('hasNestedQuantifier', () => {
  it.each([
    ['(a+)+', true],
    ['(a*)*', true],
    ['(\\d+:?){2,}', true],
    ['((a+))+', true],
    ['([a-z]+)*', true],
    ['(a+)?', false],
    ['(a+){1}', false],
    ['(\\d{2}:)+', false],
    ['(\\d{2}:?)+', true],
    ['(?:\\d|\\d)+', true],
    ['(a|b){2,}', true],
    ['(?:am|pm)', false],
    ['\\d+-\\d+', false],
    ['[(+)]+', false],
    ['(?<y>\\d{4})-(?<mo>\\d{2})', false],
  ])('%s -> %s', (src, expected) => {
    expect(hasNestedQuantifier(src)).toBe(expected);
  });
});

describe('time-token helpers', () => {
  it('resolves zones', () => {
    expect(resolveZoneToken('Z')?.today).toBe(0);
    expect(resolveZoneToken('EST')?.today).toBe(-300);
    expect(resolveZoneToken('GMT-5:30')?.today).toBe(-330);
    expect(resolveZoneToken('+0545')?.offsetIso).toBe('+05:45');
    expect(resolveZoneToken('+25:00')).toBeNull();
    expect(resolveZoneToken('Meeting')).toBeNull();
  });
  it('validates calendar dates', () => {
    expect(isRealDate(2024, 2, 29)).toBe(true);
    expect(isRealDate(2023, 2, 29)).toBe(false);
    expect(isRealDate(2024, 4, 31)).toBe(false);
    expect(isRealDate(2024, 13, 1)).toBe(false);
  });
  it('computes today in a zone and at an offset', () => {
    const now = Date.UTC(2024, 0, 1, 23, 30);
    expect(todayIn('Asia/Tokyo', now)).toEqual({ y: 2024, mo: 1, d: 2 });
    expect(todayIn(-300, now)).toEqual({ y: 2024, mo: 1, d: 1 });
  });
});

describe('QA regressions', () => {
  it('reads a zone word after an ISO date-time', () => {
    const [r] = parseTimes('2024-12-31 10:30 UTC', 'Asia/Kathmandu');
    expect(r?.matchedText).toBe('2024-12-31 10:30 UTC');
    expect(r?.assumed).toBe(false);
    expect(iso(r!.epochMs)).toBe('2024-12-31T10:30:00.000Z');
    const [e] = parseTimes('2024-12-31 10:30 EST', 'UTC');
    expect(iso(e!.epochMs)).toBe('2024-12-31T15:30:00.000Z');
    const [g] = parseTimes('2024-12-31 10:30 GMT+5:30', 'UTC');
    expect(iso(g!.epochMs)).toBe('2024-12-31T05:00:00.000Z');
  });

  it('keeps an ISO reading when the trailing word is not a zone', () => {
    const [w] = parseTimes('2024-12-31 10:30 Meeting', 'UTC');
    expect(w?.matchedText).toBe('2024-12-31 10:30');
  });

  it('refuses an impossible offset instead of silently dropping it', () => {
    expect(parseTimes('2024-01-02T10:00+1500', 'UTC')).toHaveLength(0);
    expect(parseTimes('9:00 UTC+15', 'UTC')).toHaveLength(0);
    expect(parseTimes('9:00 GMT+5:99', 'UTC')).toHaveLength(0);
  });

  it('reads GMT+h:mm / UTC+h:mm after a bare time', () => {
    const now = Date.UTC(2026, 9, 31, 12);
    const [r] = parseTimes('9:00 GMT+5:30', { assumedZone: 'UTC', nowMs: now });
    expect(r?.matchedText).toBe('9:00 GMT+5:30');
    expect(iso(r!.epochMs)).toBe('2026-10-31T03:30:00.000Z');
    const [u] = parseTimes('9:00 UTC-8', { assumedZone: 'UTC', nowMs: now });
    expect(iso(u!.epochMs)).toBe('2026-10-31T17:00:00.000Z');
  });

  it('knows common abbreviations outside the US and Europe', () => {
    const now = Date.UTC(2026, 9, 31, 12);
    expect(iso(parseTimes('10:00 ACST', { assumedZone: 'UTC', nowMs: now })[0]!.epochMs)).toBe('2026-10-31T00:30:00.000Z');
    expect(iso(parseTimes('10:00 NPT', { assumedZone: 'UTC', nowMs: now })[0]!.epochMs)).toBe('2026-10-31T04:15:00.000Z');
    expect(iso(parseTimes('10:00 AEDT', { assumedZone: 'UTC', nowMs: now })[0]!.epochMs)).toBe('2026-10-30T23:00:00.000Z');
  });

  it('does not show the time of an unrecognized date as today', () => {
    for (const text of ['31/12/2024 10:30', '12/25/2024 3pm EST', '2024/02/31 10:00', '24.12.2024 um 18:30', '24.12.2024 um 18:00 CET', '2024/02/31 10:00 UTC', '31/12/2024 10:30:15 UTC', '2-Jan-2025x 15:04', 'Dec 31 10:30', '31 Dec at 10:30']) {
      expect(parseTimes(text, 'UTC'), text).toHaveLength(0);
    }
  });

  it('a custom format then reads those dates in full', () => {
    const [r] = parseTimes('24.12.2024 um 18:30', {
      assumedZone: 'UTC',
      customFormats: [fmt('DD.MM.YYYY [um] HH:mm')],
    });
    expect(iso(r!.epochMs)).toBe('2024-12-24T18:30:00.000Z');
  });

  it('day-first dates accept ordinals and zones; month-first ones are the other format', () => {
    const [r] = parseTimes('5th May 2025 9:30 PM CET', 'UTC');
    expect(r?.formatId).toBe('day-month-name');
    expect(iso(r!.epochMs)).toBe('2025-05-05T20:30:00.000Z');
    expect(parseTimes('Oct 28 2026 4:24 PM', 'UTC')[0]?.formatId).toBe('long-form');
  });
});

describe('ReDoS hardening', () => {
  const time = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it('token mode collapses bracketed whitespace into one \\s+', () => {
    const r = compileTokenFormat('H[            ]mm');
    expect(r.ok && r.regex.source.match(/\\s\+/g)?.length).toBe(1);
    const f = fmt('H[            ]mm');
    const ms = time(() => parseTimes(`1${' '.repeat(400)}x`, { assumedZone: 'UTC', customFormats: [f] }));
    expect(ms).toBeLessThan(200);
  });

  it('rejects alternation inside a repeated group', () => {
    const r = compileAdvancedFormat('(?<h>(?:\\d|\\d)+):(?<mi>\\d{2})');
    expect(r.ok ? 'OK' : r.error).toMatch(/repeats a group/);
  });

  it('rejects many adjacent open-ended repeats', () => {
    const r = compileAdvancedFormat('(?<h>\\d+)\\d*\\d*\\d*\\d*:(?<mi>\\d{2})');
    expect(r.ok ? 'OK' : r.error).toMatch(/too many open-ended repeats/);
  });

  it('accepts a normal regex with a couple of open-ended repeats and stays fast on hostile text', () => {
    const f = fmt('(?<h>\\d+):(?<mi>\\d{2})\\s*(?<ap>am|pm)', { advanced: true });
    expect(compileAdvancedFormat(f.pattern).ok).toBe(true);
    const hostile = `${'1'.repeat(300)}:${' '.repeat(150)}x`;
    const ms = time(() => matchCustomFormat(hostile, f, ctx));
    expect(ms).toBeLessThan(200);
    expect(matchCustomFormat('at 10:30 pm', f, ctx)[0]?.parsed.matchedText).toBe('10:30 pm');
  });

  it.each([
    '(?<h>\\d{0,80})\\d{0,80}:(?<mi>\\d{2})',
    `(?<h>\\d)${'\\d?'.repeat(14)}:(?<mi>\\d{2})`,
    '(?<h>\\d+)\\s*\\d+:(?<mi>\\d{2})',
    '(?<h>[^]{0,9})(?:am|pm|AM|PM)?\\d*:(?<mi>\\d{2})',
  ])('the largest patterns the budget accepts stay fast on hostile text: %s', (pattern) => {
    const r = compileAdvancedFormat(pattern);
    if (!r.ok) return; // rejected is also safe
    const f = fmt(pattern, { advanced: true });
    for (const hostile of ['1'.repeat(600), `${'1 '.repeat(300)}x`, '1:'.repeat(300)]) {
      expect(time(() => matchCustomFormat(hostile, f, ctx))).toBeLessThan(400);
    }
  });

  it('windowed matching still honours lookbehinds', () => {
    const f = fmt('(?<!\\d)(?<d>\\d{2})\\.(?<mo>\\d{2})\\.(?<y>\\d{4})', { advanced: true });
    expect(matchCustomFormat('x 102.01.2024', f, ctx)).toHaveLength(0);
    expect(matchCustomFormat('x 02.01.2024', f, ctx)).toHaveLength(1);
  });

  it('built-in formats stay fast on hostile 20k-character selections', () => {
    const inputs = [
      '1'.repeat(20_000),
      ' '.repeat(20_000),
      '1 '.repeat(10_000),
      '12:'.repeat(6_000),
      'Jan '.repeat(5_000),
      '2024-'.repeat(4_000),
      'a'.repeat(20_000),
    ];
    for (const text of inputs) {
      const ms = time(() => parseTimes(text, 'UTC'));
      expect(ms, text.slice(0, 10)).toBeLessThan(300);
    }
  });
});

describe('token pattern warnings', () => {
  it('warns about bare letters that will be matched literally', () => {
    const r = compileTokenFormat('DD/MM/YYYY ZZ');
    expect(r.ok && r.warnings[0]).toMatch(/Z is not a token.*use TZ/);
  });
  it('does not warn about the ISO T separator or bracketed text', () => {
    const r = compileTokenFormat('YYYY-MM-DDTHH:mm [at]');
    expect(r.ok && r.warnings).toEqual([]);
  });
});

describe('round-2 review and QA fixes', () => {
  const now = Date.UTC(2026, 9, 31, 12);
  const at = (text: string, zone = 'UTC'): ReturnType<typeof parseTimes> =>
    parseTimes(text, { assumedZone: zone, nowMs: now });

  it.each([
    ['(?<h>(?:(?:\\d|\\d))+):(?<mi>\\d{2})', /repeats a group/],
    [`(?<h>\\d)${'(?:\\d|\\d)'.repeat(28)}:(?<mi>\\d{2})`, /too many open-ended repeats/],
    ['(?<h>[^](?:\\d+)+)[:](?<mi>\\d{2})x', /repeats a group/],
    ['(?<h>\\d{2})(\\d)\\1:(?<mi>\\d{2})', /Backreferences/],
  ])('rejects %s', (pattern, msg) => {
    const r = compileAdvancedFormat(pattern);
    expect(r.ok ? 'OK' : r.error).toMatch(msg);
  });

  it('error messages show the pattern without internal flags', () => {
    const r = compileAdvancedFormat('(');
    expect(r.ok ? '' : r.error).toBe('Invalid regular expression: /(/: Unterminated group');
  });

  it('long lookbehinds see the whole prefix', () => {
    const yes = fmt('(?<=deadline: )(?<h>\\d{2}):(?<mi>\\d{2})', { advanced: true });
    expect(matchCustomFormat('project deadline: 17:30', yes, ctx)).toHaveLength(1);
    const no = fmt('(?<!cancelled at )(?<h>\\d{2}):(?<mi>\\d{2})', { advanced: true });
    expect(matchCustomFormat('cancelled at 09:00', no, ctx)).toHaveLength(0);
  });

  it('ordinary words are not read as zones', () => {
    for (const text of ['Lunch 12:30 eat with team', '3pm Art class', 'Feed at 7:00 cat food', 'Meet at 5pm West gate']) {
      const [r] = at(text);
      expect(r?.assumed, text).toBe(true);
    }
    expect(at('2024-01-02 10:00 Est')[0]?.assumed).toBe(true);
    expect(at('2024-01-02 10:00 EST')[0]?.assumed).toBe(false);
  });

  it('reads US generic zones with daylight saving', () => {
    const [summer] = parseTimes('2024-07-01 15:00 ET', 'UTC');
    expect(iso(summer!.epochMs)).toBe('2024-07-01T19:00:00.000Z');
    const [winter] = parseTimes('2024-01-15 15:00 PT', 'UTC');
    expect(iso(winter!.epochMs)).toBe('2024-01-15T23:00:00.000Z');
    expect(at('3 PM ET')[0]?.assumed).toBe(false);
  });

  it('reads a.m./p.m. with dots', () => {
    expect(iso(at('11:00 p.m.')[0]!.epochMs)).toBe('2026-10-31T23:00:00.000Z');
    expect(iso(at('3:30 p.m. UTC', 'Asia/Tokyo')[0]!.epochMs)).toBe('2026-10-31T15:30:00.000Z');
    expect(iso(at('3 p.m.')[0]!.epochMs)).toBe('2026-10-31T15:00:00.000Z');
    expect(iso(at('5th May 2025 9:30 p.m. CET')[0]!.epochMs)).toBe('2025-05-05T20:30:00.000Z');
  });

  it('never reads minutes or seconds as an hour', () => {
    expect(at('10:30:15 UTC')[0]?.matchedText).toBe('10:30:15 UTC');
    expect(at('25:00 UTC')).toHaveLength(0);
  });

  it('does not suppress times after version numbers, IPs, phone numbers or non-month words', () => {
    for (const text of [
      'v1.2.30 10:00',
      'Chrome 120.0.6099 at 10:00',
      '10.0.0.12 at 10:00',
      'Call 555-12-3456 at 3pm',
      'Sprint 12 2024 10:00',
      'Q3 2024 10:00',
    ]) {
      expect(at(text)[0]?.formatId, text).toBe('time-of-day');
    }
  });

  it('written dates take a time with only am/pm, and day-first dates with dashes', () => {
    expect(iso(at('Jan 5, 2024 at 3pm EST')[0]!.epochMs)).toBe('2024-01-05T20:00:00.000Z');
    const [d] = at('02-Jan-2024 15:04');
    expect(d?.formatId).toBe('day-month-name');
    expect(iso(d!.epochMs)).toBe('2024-01-02T15:04:00.000Z');
  });

  it('year/month/day reads a trailing zone', () => {
    expect(iso(at('2024/12/31 10:30:15 UTC', 'Asia/Kathmandu')[0]!.epochMs)).toBe('2024-12-31T10:30:15.000Z');
  });

  it('leads with the most specific value; equal ones keep document order', () => {
    expect(at('Standup 9:00, demo 16:30')[0]?.matchedText).toBe('9:00');
    expect(at('at 3pm or 1700000000')[0]?.formatId).toBe('epoch-seconds');
    expect(at('09:00 local, 14:00 UTC')[0]?.matchedText).toBe('14:00 UTC');
  });
});
