import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { BUILTIN_FORMATS } from '../src/lib/builtin-formats';
import { matchCustomFormat } from '../src/lib/custom-formats';
import { japaneseEraYear, normalizeSigns, resolveZoneToken } from '../src/lib/time-tokens';
import type { NumericDateOrder } from '../src/types';

/** Round-1 review and blind-QA parser fixes. */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (text: string, order: NumericDateOrder = 'dmy', zone = 'UTC') =>
  parseTimes(text, { assumedZone: zone, numericDateOrder: order, nowMs: NOW });
const first = (text: string, order: NumericDateOrder = 'dmy') => at(text, order)[0];
const ids = (text: string): string[] => at(text).map((p) => p.formatId ?? p.kind);

describe('dateOrder carries the calendar dates as written', () => {
  it.each(['UTC', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    '"03/04/2024 22:00 PDT" read dmy, assumed zone %s',
    (zone) => {
      const [p] = at('03/04/2024 22:00 PDT', 'dmy', zone);
      // 22:00 PDT is the next day in UTC; the dates stay as written.
      expect(iso(p!.epochMs)).toBe('2024-04-04T05:00:00.000Z');
      expect(p!.dateOrder?.order).toBe('dmy');
      expect(p!.dateOrder?.date).toEqual({ y: 2024, mo: 4, d: 3 });
      expect(p!.dateOrder?.alternate.order).toBe('mdy');
      expect(p!.dateOrder?.alternate.date).toEqual({ y: 2024, mo: 3, d: 4 });
      expect(iso(p!.dateOrder!.alternate.epochMs)).toBe('2024-03-05T05:00:00.000Z');
    },
  );

  it('read mdy, the dates swap roles', () => {
    const p = first('03/04/2024', 'mdy');
    expect(p?.dateOrder?.date).toEqual({ y: 2024, mo: 3, d: 4 });
    expect(p?.dateOrder?.alternate.date).toEqual({ y: 2024, mo: 4, d: 3 });
  });
});

describe('ISO ordinal dates are not ids', () => {
  it.each([
    'PR 2024-123',
    'ID 2024-001',
    'ticket 2019-120',
    '#2024-123',
    'Invoice No. 2024-001',
    'ID: 2024-001',
    'pr#2024-123',
    'Bug #2024-123',
    'release 2024-100',
  ])('%s', (text) => {
    expect(ids(text)).not.toContain('iso-ordinal');
  });

  it('a time next to an id leads', () => {
    expect(ids('Invoice 2024-001 due 10:00')).toEqual(['time-of-day']);
    expect(ids('Meeting 10:00, ref 2024-120')).toEqual(['time-of-day']);
  });

  it('a label on the previous line does not count', () => {
    expect(ids('Ticket\n1999-081')).toContain('iso-ordinal');
  });

  it('a genuine date-only ordinal ranks below a time of day', () => {
    const r = at('1999-081 meeting at 10:00');
    expect(r.map((p) => p.formatId)).toEqual(['time-of-day', 'iso-ordinal']);
  });

  it('genuine ordinals still parse', () => {
    expect(iso(first('1999-081')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('released 1999-081')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    const t = first('2024-123T10:00Z');
    expect(t?.matchedText).toBe('2024-123T10:00Z');
    expect(iso(t!.epochMs)).toBe('2024-05-02T10:00:00.000Z');
    expect(iso(first('1999-081+01:00')!.epochMs)).toBe('1999-03-21T23:00:00.000Z');
  });
});

describe('compact and ISO-week ids', () => {
  it.each(['Order #20240115', 'SKU 20240115', 'serial: 20240115', 'SKU 2024W012', 'model 2020W10', 'part 2024W01', 'item 1999-W13-2', 'Order #2024-W01'])(
    '%s does not convert',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it('real compact and week dates still parse', () => {
    expect(iso(first('19990322')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('shipped 20240115')!.epochMs)).toBe('2024-01-15T00:00:00.000Z');
    expect(iso(first('1999W132')!.epochMs)).toBe('1999-03-30T00:00:00.000Z');
    expect(iso(first('1999-W13-2')!.epochMs)).toBe('1999-03-30T00:00:00.000Z');
    expect(iso(first('2024-W01')!.epochMs)).toBe('2024-01-01T00:00:00.000Z');
  });

  it('a week without hyphen or weekday is not a date', () => {
    expect(ids('2020W10')).not.toContain('iso-week');
  });
});

describe('numeric triples that are times or codes', () => {
  it.each(['10.30.15', '01.02.03', '01-23-45', 'ext 01-23-45', 'lot 11-12-13'])('%s is not a date', (text) => {
    expect(ids(text)).not.toContain('numeric-date');
  });

  it('dates with a time, or with a 19xx year, still parse', () => {
    expect(iso(first('22.03.99 10:00')!.epochMs)).toBe('1999-03-22T10:00:00.000Z');
    expect(iso(first('03-22-99 10:00 PM', 'mdy')!.epochMs)).toBe('1999-03-22T22:00:00.000Z');
    expect(iso(first('10.30.15 10:00', 'mdy')!.epochMs)).toBe('2015-10-30T10:00:00.000Z');
    expect(iso(first('01-23-45 05:06', 'mdy')!.epochMs)).toBe('2045-01-23T05:06:00.000Z');
    expect(iso(first('22-03-99')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('99-03-22')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('22.03.99')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('22.03.1999')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
  });
});

describe('Japanese era years', () => {
  it.each([
    ['平成11年3月22日', '1999-03-22'],
    ['令和6年1月2日', '2024-01-02'],
    ['昭和64年1月7日', '1989-01-07'],
    ['令和元年5月1日', '2019-05-01'],
    ['平成元年1月8日', '1989-01-08'],
    ['大正1年8月1日', '1912-08-01'],
    ['明治1年1月1日', '1868-01-01'],
    ['平成11年3月22日 5時06分07秒', '1999-03-22T05:06:07'],
  ])('%s', (text, want) => {
    const p = first(text);
    expect(p?.matchedText).toBe(text);
    expect(iso(p!.epochMs).startsWith(want)).toBe(true);
  });

  it('a date outside its era is refused, not read as a plain year', () => {
    expect(at('昭和64年1月8日')).toEqual([]);
    expect(at('令和1年4月30日')).toEqual([]);
    expect(japaneseEraYear('平成', '31', 4, 30)).toBe(2019);
    expect(japaneseEraYear('平成', '31', 5, 1)).toBeNull();
    expect(japaneseEraYear('平成', '0', 1, 1)).toBeNull();
  });

  it('Gregorian CJK dates are unchanged', () => {
    expect(iso(first('1999年3月22日')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(first('99年3月22日')!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
  });
});

describe('a weekday that is also a month', () => {
  it('"Mar 3 Mar 2024" is 3 March, not martes', () => {
    const p = first('Mar 3 Mar 2024');
    expect(iso(p!.epochMs)).toBe('2024-03-03T00:00:00.000Z');
    expect(p!.matchedText).toBe('3 Mar 2024');
    expect(iso(first('mar 3 mar 2024')!.epochMs)).toBe('2024-03-03T00:00:00.000Z');
  });

  it('"Mar 3, 2024" still reads as 3 March', () => {
    const p = first('Mar 3, 2024');
    expect(iso(p!.epochMs)).toBe('2024-03-03T00:00:00.000Z');
    expect(p!.matchedText).toBe('Mar 3, 2024');
  });

  it('a weekday that is not a month keeps its place', () => {
    expect(first('lunes 22 marzo 1999')?.matchedText).toBe('lunes 22 marzo 1999');
  });
});

describe('Unicode minus in offsets', () => {
  const same = (unicode: string, ascii: string, order: NumericDateOrder = 'dmy') => {
    const u = at(unicode, order);
    const a = at(ascii, order);
    expect(u.map((p) => p.epochMs)).toEqual(a.map((p) => p.epochMs));
    expect(u.map((p) => p.kind)).toEqual(a.map((p) => p.kind));
    expect(u.length).toBeGreaterThan(0);
    for (const p of u) expect(unicode).toContain(p.matchedText);
  };

  it.each([
    ['UTC−05:00', 'UTC-05:00'],
    ['3pm UTC−05:00', '3pm UTC-05:00'],
    ['3pm GMT−5', '3pm GMT-5'],
    ['10:00 −0500', '10:00 -0500'],
    ['2024-03-04T10:00:00−05:00', '2024-03-04T10:00:00-05:00'],
    ['1999-081−05:00', '1999-081-05:00'],
    ['22/03/1999 05:06 GMT−5', '22/03/1999 05:06 GMT-5'],
    ['3pm GMT–5', '3pm GMT-5'],
  ])('%s reads like %s', (u, a) => same(u, a));

  it('keeps the original characters in matchedText', () => {
    expect(first('2024-03-04T10:00:00−05:00')?.matchedText).toBe('2024-03-04T10:00:00−05:00');
    expect(first('at 10:00 −0500 today')?.matchedText).toBe('10:00 −0500');
    expect(iso(first('2024-03-04T10:00:00−05:00')!.epochMs)).toBe('2024-03-04T15:00:00.000Z');
  });

  it('a bad offset is refused like its ASCII form', () => {
    expect(at('3pm GMT−15')).toEqual(at('3pm GMT-15'));
  });

  it('an en dash between times stays a range', () => {
    expect(at('10:00–11:00').map((p) => p.matchedText)).toEqual(['10:00', '11:00']);
    expect(normalizeSigns('10:00–11:00')).toBe('10:00–11:00');
    expect(normalizeSigns('GMT–5 and UTC−3')).toBe('GMT-5 and UTC-3');
  });

  it('resolveZoneToken reads U+2212', () => {
    expect(resolveZoneToken('UTC−05:00')?.offsetIso).toBe('-05:00');
    expect(resolveZoneToken('−0530')?.offsetIso).toBe('-05:30');
    expect(resolveZoneToken('GMT–5')?.offsetIso).toBe('-05:00');
  });

  it('custom formats read it too and keep the original text', () => {
    const fmt = { id: 'c', label: 'c', pattern: 'YYYY-MM-DD HH:mm TZ', advanced: false, enabled: true };
    const [c] = matchCustomFormat('1999-03-22 05:06 −0100', fmt, { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' });
    expect(c?.parsed.matchedText).toBe('1999-03-22 05:06 −0100');
    expect(iso(c!.parsed.epochMs)).toBe('1999-03-22T06:06:00.000Z');
  });
});

describe('the fixed formats stay fast on 20k-character hostile input', () => {
  const ctx = { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' as const, nowMs: NOW };
  const time = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const fmt = (id: string) => BUILTIN_FORMATS.find((f) => f.id === id)!;
  const fill = (unit: string) => unit.repeat(Math.ceil(20_000 / unit.length)).slice(0, 20_000);

  it.each([
    ['iso-ordinal', 'PR 2024-123 '],
    ['iso-ordinal', '#2024-'],
    ['iso-ordinal', '2024-123T10:0'],
    ['iso-ordinal', `${'a'.repeat(39)} 2024-123`],
    ['iso-week', 'SKU 2024W01'],
    ['iso-week', '2024W'],
    ['compact-date', 'Order #20240115 '],
    ['numeric-date', '10.30.15 '],
    ['numeric-date', '01-23-45-'],
    ['cjk-date', '平成11年3月'],
    ['cjk-date', '令和'],
    ['day-month-name', 'Mar 3 '],
    ['time-of-day', '10:00 −'],
    ['time-of-day', 'GMT−'],
  ])('%s on %j', (id, unit) => {
    const text = fill(unit);
    expect(time(() => fmt(id).match(text, ctx))).toBeLessThan(50);
  });

  it('sign normalization', () => {
    const text = fill('UTC−–');
    expect(time(() => normalizeSigns(text))).toBeLessThan(50);
  });
});
