import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { BUILTIN_FORMAT_IDS } from '../src/lib/builtin-formats';
import { isoWeekDate } from '../src/lib/time-tokens';
import type { NumericDateOrder } from '../src/types';

/**
 * Every pattern | example row of the Talend Data Preparation 8.0 "List of
 * date and date/time formats"
 * (https://help.qlik.com/talend/en-US/data-preparation-user-guide/8.0/list-of-date-and-date-time-formats).
 * The examples are 22 March 1999 05:06:07(.000); CET/MEZ, +0100, +01:00,
 * +01 and [Europe/Paris] are all +01:00 on that date. Without a zone the
 * example is read in the assumed zone (UTC here).
 */
const TALEND = `
yyyyMMddZ | 19990322+0100
yyyyMMdd | 19990322
yyyy-MM-dd G | 1999-03-22 AD
yyyy-MM-ddXXX | 1999-03-22+01:00
yyyy-MM-dd'T'HH:mm:ss.SSS'['VV']' | 1999-03-22T05:06:07.000[Europe/Paris]
yyyy-MM-dd'T'HH:mm:ss,SSS'['VV']' | 1999-03-22T05:06:07,000[Europe/Paris]
yyyy-MM-dd HH:mm:ss.SSS'['VV']' | 1999-03-22 05:06:07.000[Europe/Paris]
yyyy-MM-dd HH:mm:ss,SSS'['VV']' | 1999-03-22 05:06:07,000[Europe/Paris]
yyyy-MM-dd'T'HH:mm:ss.SSS | 1999-03-22T05:06:07.000
yyyy-MM-dd'T'HH:mm:ss,SSS | 1999-03-22T05:06:07,000
yyyy-MM-dd HH:mm:ss.SSS | 1999-03-22 05:06:07.000
yyyy-MM-dd HH:mm:ss,SSS | 1999-03-22 05:06:07,000
yyyy-MM-dd'T'HH:mm:ss | 1999-03-22T05:06:07
yyyy-MM-dd'T'HH:mm:ss'Z' | 1999-03-22T05:06:07Z
yyyy-MM-dd'T'HH:mm:ssZ | 1999-03-22T05:06:07Z
yyyy-MM-dd HH:mm:ss'Z' | 1999-03-22 05:06:07Z
yyyy-MM-dd HH:mm:ssZ | 1999-03-22 05:06:07Z
yyyy-MM-dd'T'HH:mm:ss.SSS'Z' | 1999-03-22T05:06:07.000Z
yyyy-MM-dd'T'HH:mm:ss,SSS'Z' | 1999-03-22T05:06:07,000Z
yyyy-MM-dd HH:mm:ss.SSS'Z' | 1999-03-22 05:06:07.000Z
yyyy-MM-dd HH:mm:ss,SSS'Z' | 1999-03-22 05:06:07,000Z
yyyy-MM-dd'T'HH:mm:ss.SSSXXX | 1999-03-22T05:06:07.000+01:00
yyyy-MM-dd'T'HH:mm:ss,SSSXXX | 1999-03-22T05:06:07,000+01:00
yyyy-MM-dd HH:mm:ss.SSSXXX | 1999-03-22 05:06:07.000+01:00
yyyy-MM-dd HH:mm:ss,SSSXXX | 1999-03-22 05:06:07,000+01:00
yyyy-MM-dd'T'HH:mm:ssX | 1999-03-22T05:06:07+01
yyyy-MM-dd HH:mm:ssX | 1999-03-22 05:06:07+01
yyyy-MM-dd'T'HH:mm:ssXXX | 1999-03-22T05:06:07+01:00
yyyy-MM-dd HH:mm:ssXXX | 1999-03-22 05:06:07+01:00
yyyy-DDDXXX | 1999-081+01:00
YYYY'W'wc | 1999W132
YYYY-'W'w-c | 1999-W13-2
yyyy-MM-dd'T'HH:mm:ss.SSSXXX'['VV']' | 1999-03-22T05:06:07.000+01:00[Europe/Paris]
yyyy-MM-dd'T'HH:mm:ss,SSSXXX'['VV']' | 1999-03-22T05:06:07,000+01:00[Europe/Paris]
yyyy-MM-dd HH:mm:ss.SSSXXX'['VV']' | 1999-03-22 05:06:07.000+01:00[Europe/Paris]
yyyy-MM-dd HH:mm:ss,SSSXXX'['VV']' | 1999-03-22 05:06:07,000+01:00[Europe/Paris]
yyyy-MM-dd'T'HH:mm:ssXXX'['VV']' | 1999-03-22T05:06:07+01:00[Europe/Paris]
yyyy-MM-dd HH:mm:ssXXX'['VV']' | 1999-03-22 05:06:07+01:00[Europe/Paris]
d.M.yy | 22.3.99
d.M.yy H.mm | 22.3.99 5.06
d.M.yyyy H.mm.ss | 22.3.1999 5.06.07
d.M.yyyy H:mm:ss | 22.3.1999 5:06:07
dd-MM-yy | 22-03-99
dd-MM-yy HH:mm | 22-03-99 05:06
dd-MM-yyyy HH:mm:ss | 22-03-1999 05:06:07
dd.MM.yy | 22.03.99
d. MMMM yyyy | 22. März 1999
EEEE, d. MMMM yyyy | Montag, 22. März 1999
dd.MM.yyyy | 22.03.1999
dd.MM.yy HH:mm | 22.03.99 05:06
d. MMMM yyyy HH:mm:ss z | 22. März 1999 05:06:07 MEZ
dd.MM.yyyy HH:mm:ss | 22.03.1999 05:06:07
dd.MM.yy HH:mm:ss | 22.03.99 05:06:07
dd.MM.yyyy HH:mm | 22.03.1999 05:06
EEEE, d. MMMM yyyy HH:mm' Uhr 'z | Montag, 22. März 1999 05:06 Uhr MEZ
d-MMM-yyyy | 22-Mar-1999
dd/MM/yy h:mm a | 22/03/99 5:06 AM
EEEE, MMMM d, yyyy h:mm:ss 'o''clock' a z | Monday, March 22, 1999 5:06:07 o'clock AM CET
d-MMM-yyyy h:mm:ss a | 22-Mar-1999 5:06:07 AM
dd MMMM yyyy | 22 March 1999
EEEE, d MMMM yyyy | Monday, 22 March 1999
dd-MMM-yyyy | 22-Mar-1999
dd MMMM yyyy HH:mm:ss z | 22 March 1999 05:06:07 CET
EEEE, d MMMM yyyy HH:mm:ss 'o''clock' z | Monday, 22 March 1999 05:06:07 o'clock CET
dd-MMM-yyyy HH:mm:ss | 22-Mar-1999 05:06:07
dd-MMM-yy hh.mm.ss.nnnnnnnnn a | 22-Mar-99 05.06.07.000000888 AM
M/d/yy | 3/22/99
MM/dd/yy | 03/11/22
MM-dd-yy | 03-22-99
M-d-yy | 3-22-99
MMM d, yyyy | Mar 22, 1999
MMMM d, yyyy | March 22, 1999
EEEE, MMMM d, yyyy | Monday, March 22, 1999
MMM d yyyy | Mar 22 1999
MMMM d yyyy | March 22 1999
MM-dd-yyyy | 03-22-1999
M-d-yyyy | 3-22-1999
yyyy-MM-ddXXX | 1999-03-22+01:00
dd/MM/yyyy | 22/03/1999
d/M/yyyy | 22/3/1999
MM/dd/yyyy | 03/22/1999
M/d/yyyy | 3/22/1999
yyyy/M/d | 1999/3/22
M/d/yy h:mm a | 3/22/99 5:06 AM
MM/dd/yy h:mm a | 03/22/99 5:06 AM
MM-dd-yy h:mm a | 03-22-99 5:06 AM
M-d-yy h:mm a | 3-22-99 5:06 AM
MMM d, yyyy h:mm:ss a | Mar 22, 1999 5:06:07 AM
EEEE, MMMM d, yyyy h:mm:ss a z | Monday, March 22, 1999 5:06:07 AM CET
EEE MMM dd HH:mm:ss z yyyy | Mon Mar 22 05:06:07 CET 1999
EEE, d MMM yyyy HH:mm:ss Z | Mon, 22 Mar 1999 05:06:07 +0100
d MMM yyyy HH:mm:ss Z | 22 Mar 1999 05:06:07 +0100
MM-dd-yyyy h:mm:ss a | 03-22-1999 5:06:07 AM
M-d-yyyy h:mm:ss a | 3-22-1999 5:06:07 AM
yyyy-MM-dd h:mm:ss a | 1999-03-22 5:06:07 AM
yyyy-M-d h:mm:ss a | 1999-3-22 5:06:07 AM
yyyy-MM-dd HH:mm:ss.S | 1999-03-22 05:06:07.0
dd/MM/yyyy h:mm:ss a | 22/03/1999 5:06:07 AM
d/M/yyyy h:mm:ss a | 22/3/1999 5:06:07 AM
MM/dd/yyyy h:mm:ss a | 03/22/1999 5:06:07 AM
M/d/yyyy h:mm:ss a | 3/22/1999 5:06:07 AM
MM/dd/yy h:mm:ss a | 03/22/99 5:06:07 AM
MM/dd/yy H:mm:ss | 03/22/99 5:06:07
M/d/yy H:mm:ss | 3/22/99 5:06:07
dd/MM/yyyy h:mm a | 22/03/1999 5:06 AM
d/M/yyyy h:mm a | 22/3/1999 5:06 AM
MM/dd/yyyy h:mm a | 03/22/1999 5:06 AM
M/d/yyyy h:mm a | 3/22/1999 5:06 AM
MM-dd-yy h:mm:ss a | 03-22-99 5:06:07 AM
M-d-yy h:mm:ss a | 3-22-99 5:06:07 AM
MM-dd-yyyy h:mm a | 03-22-1999 5:06 AM
M-d-yyyy h:mm a | 3-22-1999 5:06 AM
yyyy-MM-dd h:mm a | 1999-03-22 5:06 AM
yyyy-M-d h:mm a | 1999-3-22 5:06 AM
MMM.dd.yyyy | Mar.22.1999
d/MMM/yyyy H:mm:ss Z | 22/Mar/1999 5:06:07 +0100
dd/MMM/yy h:mm a | 22/Mar/99 5:06 AM
d/MM/yy | 22/03/99
d/MM/yy H:mm | 22/03/99 5:06
d.M.yy H:mm | 22.3.99 5:06
d.MM.yy | 22.03.99
d.MM.yyyy | 22.03.1999
d.MM.yy H:mm | 22.03.99 5:06
d.MM.yyyy H:mm:ss | 22.03.1999 5:06:07
d.M.yyyy | 22.3.1999
d.M.yyyy H:mm | 22.3.1999 5:06
yy-MM-dd | 99-03-22
yyyy-MM-dd | 1999-03-22
d MMMM yyyy HH:mm:ss z | 22 mars 1999 05:06:07 CET
MMMM d, yyyy h:mm:ss z a | March 22, 1999 5:06:07 CET AM
yyyy-MM-dd HH:mm:ss | 1999-03-22 05:06:07
EEEE d MMMM yyyy H' h 'mm z | lundi 22 mars 1999 5 h 06 CET
dd/MM/yy | 22/03/99
d MMM yyyy | 22 mars 1999
d MMMM yyyy | 22 mars 1999
EEEE d MMMM yyyy | lundi 22 mars 1999
dd/MM/yy HH:mm | 22/03/99 05:06
MM/dd/yy HH:mm | 03/22/99 05:06
M/d/yy HH:mm | 3/22/99 05:06
MM-dd-yy HH:mm | 03-22-99 05:06
M-d-yy HH:mm | 3-22-99 05:06
d MMM yyyy HH:mm:ss | 22 mars 1999 05:06:07
d MMMM yyyy HH:mm:ss z | 22 mars 1999 05:06:07 CET
MM-dd-yyyy HH:mm:ss | 03-22-1999 05:06:07
M-d-yyyy HH:mm:ss | 3-22-1999 05:06:07
yyyy-M-d HH:mm:ss | 1999-3-22 05:06:07
dd/MM/yyyy HH:mm:ss | 22/03/1999 05:06:07
d/M/yyyy HH:mm:ss | 22/3/1999 05:06:07
MM/dd/yyyy HH:mm:ss | 03/22/1999 05:06:07
M/d/yyyy HH:mm:ss | 3/22/1999 05:06:07
EEEE d MMMM yyyy HH' h 'mm z | lundi 22 mars 1999 05 h 06 CET
dd/MM/yy HH:mm:ss | 22/03/99 05:06:07
MM/dd/yy HH:mm:ss | 03/22/99 05:06:07
M/d/yy HH:mm:ss | 3/22/99 05:06:07
dd/MM/yyyy HH:mm | 22/03/1999 05:06
d/M/yyyy HH:mm | 22/3/1999 05:06
MM/dd/yyyy HH:mm | 03/22/1999 05:06
M/d/yyyy HH:mm | 3/22/1999 05:06
MM-dd-yy HH:mm:ss | 03-22-99 05:06:07
M-d-yy HH:mm:ss | 3-22-99 05:06:07
MM-dd-yyyy HH:mm | 03-22-1999 05:06
M-d-yyyy HH:mm | 3-22-1999 05:06
yyyy-M-d HH:mm | 1999-3-22 05:06
yy/MM/dd HH:mm | 99/03/22 05:06
yyyy.MM.dd | 1999.03.22
yyyy.MM.dd HH:mm:ss | 1999.03.22 05:06:07
yyyy.MM.dd HH:mm | 1999.03.22 05:06
yyyy.MM.dd. | 1999.03.22.
yyyy.MM.dd. H:mm:ss | 1999.03.22. 5:06:07
yyyy.MM.dd. H:mm | 1999.03.22. 5:06
d.M.yyyy HH:mm:ss | 22.3.1999 05:06:07
d.M.yyyy HH:mm | 22.3.1999 05:06
d-MMM-yyyy | 22-mar-1999
dd/MM/yy H.mm | 22/03/99 5.06
yy-MM-dd HH:mm | 99-03-22 05:06
d-MMM-yyyy H.mm.ss | 22-mar-1999 5.06.07
d MMMM yyyy H.mm.ss z | 22 marzo 1999 5.06.07 CET
EEEE d MMMM yyyy H.mm.ss z | lunedì 22 marzo 1999 5.06.07 CET
HH:mm dd/MM/yy | 05:06 22/03/99
HH:mm:ss dd/MM/yyyy | 05:06:07 22/03/1999
yy/MM/dd | 99/03/22
yyyy/MM/dd | 1999/03/22
yy/MM/dd H:mm | 99/03/22 5:06
MM/dd/yy H:mm | 03/22/99 5:06
M/d/yy H:mm | 3/22/99 5:06
MM-dd-yy H:mm | 03-22-99 5:06
M-d-yy H:mm | 3-22-99 5:06 AM
MM-dd-yyyy H:mm:ss | 03-22-1999 5:06:07
M-d-yyyy H:mm:ss | 3-22-1999 5:06:07
yyyy-MM-dd H:mm:ss | 1999-03-22 5:06:07
yy/MM/dd H:mm:ss | 99/03/22 5:06:07
M/d/yy h:mm:ss a | 3/22/99 5:06:07 AM
yyyy/MM/dd H:mm | 1999/03/22 5:06
dd/MM/yyyy H:mm | 22/03/1999 5:06
d/M/yyyy H:mm | 22/3/1999 5:06
MM/dd/yyyy H:mm | 03/22/1999 5:06
M/d/yyyy H:mm | 3/22/1999 5:06
MM-dd-yy H:mm:ss | 03-22-99 5:06:07
M-d-yy H:mm:ss | 3-22-99 5:06:07
MM-dd-yyyy H:mm | 03-22-1999 5:06
M-d-yyyy H:mm | 3-22-1999 5:06
yyyy-MM-dd H:mm | 1999-03-22 5:06
yyyy-M-d H:mm | 1999-3-22 5:06
yy. M. d | 99. 3. 22
yyyy. M. d | 1999. 3. 22
yy.M.d | 99.3.22
yy.M.d HH.mm | 99.3.22 05.06
yyyy-MM-dd HH.mm.ss | 1999-03-22 05.06.07
yy.d.M | 99.22.3
yyyy.d.M | 1999.22.3
yy.d.M HH:mm | 99.22.3 05:06
yyyy.d.M HH:mm:ss | 1999.22.3 05:06:07
d.M.yy HH:mm | 22.3.99 05:06
d.M.yyyy HH:mm: | 22.3.1999 05:06:
d-M-yy | 22-3-99
d-M-yy H:mm | 22-3-99 5:06
dd-MM-yyyy | 22-03-1999
dd-MM-yyyy H:mm | 22-03-1999 5:06
dd.MM.yy H:mm | 22.03.99 5:06
dd.MM.yyyy H:mm:ss | 22.03.1999 5:06:07
yyyy-MM-dd h:mm:ss.a | 1999-03-22 5:06:07.PD
yy-MM-dd h.mm.a | 99-03-22 5.06.PD
yyyy-MM-dd h.mm.ss.a z | 1999-03-22 5.06.07.PD CET
d.M.yy. | 22.3.99.
dd.MM.yyyy. | 22.03.1999.
d.M.yy. HH.mm | 22.3.99. 05.06
dd.MM.yyyy. HH.mm.ss | 22.03.1999. 05.06.07
dd.MM.yyyy. HH.mm.ss z | 22.03.1999. 05.06.07 CET
HH:mm:ss dd-MM-yyyy | 05:06:07 22-03-1999
HH:mm dd/MM/yyyy | 05:06 22/03/1999
yy-M-d | 99-3-22
yyyy-M-d | 1999-3-22
yyyy'年'M'月'd'日' | 1999年3月22日
yyyy'年'M'月'd'日' EEEE | 1999年3月22日 星期一
yy-M-d ah:mm | 99-3-22 上午5:06
yyyy-M-d H:mm:ss | 1999-3-22 5:06:07
yyyy'年'M'月'd'日' ahh'时'mm'分'ss'秒' | 1999年3月22日 上午05时06分07秒
yyyy'年'M'月'd'日' H'時'mm'分'ss'秒' z | 1999年3月22日 5時06分07秒 CET
yyyy'年'M'月'd'日' EEEE ahh'时'mm'分'ss'秒' z | 1999年3月22日 星期一 上午05时06分07秒 CET
`;

const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = Date.UTC(2026, 10, 1, 12);

interface Row {
  readonly pattern: string;
  readonly example: string;
}
const ROWS: readonly Row[] = TALEND.trim()
  .split('\n')
  .map((line) => {
    const at = line.indexOf(' | ');
    return { pattern: line.slice(0, at), example: line.slice(at + 3) };
  });

/** Examples deliberately not supported, with the reason. Empty: all are read. */
const EXCLUDED: Readonly<Record<string, string>> = {};

/**
 * Examples whose instant does not follow from the 22 March 1999 rule.
 *  - "03/11/22" (MM/dd/yy): the list's own example is 11 March 2022.
 *  - "1999W132" / "1999-W13-2": Talend computes the week with US rules
 *    (weeks start on Sunday, week 1 holds 1 January, Monday = day 2), which
 *    gives 22 March. Under ISO 8601 (weeks start on Monday, week 1 holds the
 *    first Thursday, Monday = 1) week 13 day 2 is Tuesday 30 March 1999,
 *    and that is what we read.
 */
const EXPECTED_INSTANT: Readonly<Record<string, number>> = {
  '03/11/22': Date.UTC(2022, 2, 11),
  '1999W132': Date.UTC(1999, 2, 30),
  '1999-W13-2': Date.UTC(1999, 2, 30),
  '1999-081+01:00': Date.UTC(1999, 2, 21, 23),
};

/** Examples whose highlighted text is not the whole example. */
const EXPECTED_TEXT: Readonly<Record<string, string>> = {
  // A trailing colon with nothing after it is not part of the time.
  '22.3.1999 05:06:': '22.3.1999 05:06',
};

/** The pattern's own day/month order: "MM/dd/yy" -> mdy, "dd.MM.yy" -> dmy. */
function orderOf(pattern: string): NumericDateOrder {
  const p = pattern.replace(/'[^']*'/g, '');
  const d = p.indexOf('d');
  const m = p.indexOf('M');
  return m >= 0 && d >= 0 && m < d ? 'mdy' : 'dmy';
}

function expectedInstant(row: Row): number {
  const fixed = EXPECTED_INSTANT[row.example];
  if (fixed !== undefined) return fixed;
  const p = row.pattern.replace(/'[^']*'/g, '');
  const hasTime = /[Hh]/.test(p);
  const hasSeconds = /s/.test(p);
  const base = Date.UTC(1999, 2, 22, hasTime ? 5 : 0, hasTime ? 6 : 0, hasTime && hasSeconds ? 7 : 0);
  const plusOne = /CET|MEZ|\+01|\[Europe\/Paris\]/.test(row.example);
  return base - (plusOne ? 3_600_000 : 0);
}

describe('Talend date and date/time formats', () => {
  it('has the whole list', () => {
    expect(ROWS.length).toBe(239);
  });

  for (const row of ROWS) {
    const why = EXCLUDED[row.example];
    const name = `${row.pattern} | ${row.example}`;
    if (why) {
      it.skip(`${name} (excluded: ${why})`, () => undefined);
      continue;
    }
    it(name, () => {
      const order = orderOf(row.pattern);
      const [r] = parseTimes(row.example, { assumedZone: 'UTC', numericDateOrder: order, nowMs: NOW });
      expect(r, 'recognized').toBeDefined();
      expect(iso(r!.epochMs)).toBe(iso(expectedInstant(row)));
      expect(r!.matchedText).toBe(EXPECTED_TEXT[row.example] ?? row.example);
      if (r!.dateOrder) expect(r!.dateOrder.order).toBe(order);
    });
  }

  it('reads at least 97% of the list', () => {
    const read = ROWS.filter((r) => !EXCLUDED[r.example]).length;
    expect(read / ROWS.length).toBeGreaterThanOrEqual(0.97);
  });
});

describe('day/month ambiguity', () => {
  const at = (text: string, order?: NumericDateOrder) =>
    parseTimes(text, { assumedZone: 'UTC', numericDateOrder: order, nowMs: NOW });

  it('the ambiguous Talend example offers both readings', () => {
    const [mdy] = at('03/11/22', 'mdy');
    expect(iso(mdy!.epochMs)).toBe('2022-03-11T00:00:00.000Z');
    expect(mdy!.dateOrder).toEqual({
      order: 'mdy',
      date: { y: 2022, mo: 3, d: 11 },
      alternate: { epochMs: Date.UTC(2022, 10, 3), order: 'dmy', date: { y: 2022, mo: 11, d: 3 } },
    });
    const [dmy] = at('03/11/22', 'dmy');
    expect(iso(dmy!.epochMs)).toBe('2022-11-03T00:00:00.000Z');
    expect(dmy!.dateOrder?.alternate.epochMs).toBe(Date.UTC(2022, 2, 11));
  });

  it('follows the order setting, day first by default, and keeps the time', () => {
    expect(iso(at('03/04/2024 10:30')[0]!.epochMs)).toBe('2024-04-03T10:30:00.000Z');
    expect(iso(at('03/04/2024 10:30', 'mdy')[0]!.epochMs)).toBe('2024-03-04T10:30:00.000Z');
    expect(at('03/04/2024 10:30', 'mdy')[0]!.dateOrder?.alternate).toEqual({
      epochMs: Date.UTC(2024, 3, 3, 10, 30),
      order: 'dmy',
      date: { y: 2024, mo: 4, d: 3 },
    });
    expect(iso(at('05:06 03/04/24', 'mdy')[0]!.epochMs)).toBe('2024-03-04T05:06:00.000Z');
  });

  it('unambiguous or equal parts carry no alternate', () => {
    for (const text of ['22/03/1999', '03/22/1999', '05/05/2024', '1999-3-4', '1999.22.3']) {
      const [r] = at(text, 'mdy');
      expect(r, text).toBeDefined();
      expect(r!.dateOrder, text).toBeUndefined();
    }
    expect(iso(at('22/03/1999', 'mdy')[0]!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
    expect(iso(at('03/22/1999', 'dmy')[0]!.epochMs)).toBe('1999-03-22T00:00:00.000Z');
  });

  it('two-digit years: 70–99 are 19xx, the rest 20xx', () => {
    expect(iso(at('22/03/69')[0]!.epochMs)).toBe('2069-03-22T00:00:00.000Z');
    expect(iso(at('22/03/70')[0]!.epochMs)).toBe('1970-03-22T00:00:00.000Z');
  });

  it('impossible dates are refused, and their time is not read as today', () => {
    for (const text of ['31/02/2024', '32/12/2024 10:30', '13/13/2024 10:00', '22/03/1999 25:00', '1999.13.13']) {
      expect(at(text), text).toHaveLength(0);
    }
  });
});

describe('numeric dates: not every number group is a date', () => {
  const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', nowMs: NOW });
  it.each([
    'v1.2.3',
    '1.2.30',
    'version 1.2.30',
    'Chrome 120.0.6099',
    '10.0.0.12',
    '192.168.1.10',
    '1.2.3.4',
    '555-12-3456',
    'pi is 3.14',
    '3/4',
    '1/2 cup',
    'won 2-1',
    'pages 1-10',
    'pp. 12-34',
    '12/34/56',
    '1-2-30',
    'see 22/03/19999',
  ])('%s', (text) => {
    expect(at(text).filter((r) => r.formatId === 'numeric-date')).toHaveLength(0);
  });

  it('a date in a CSV row or sentence is still read', () => {
    expect(at('id,22/03/1999,done')[0]?.matchedText).toBe('22/03/1999');
    expect(at('Due 22/03/1999.')[0]?.matchedText).toBe('22/03/1999');
    expect(at('(22.03.1999)')[0]?.matchedText).toBe('22.03.1999');
  });

  it('with numeric-date off, the time of such a date is not read as today', () => {
    const off = { assumedZone: 'UTC', nowMs: NOW, disabledFormats: ['numeric-date'] };
    for (const text of ['31/12/2024 10:30', '24.12.2024 um 18:30', '22.3.99 05:06', '1999.03.22. 5:06']) {
      expect(parseTimes(text, off), text).toHaveLength(0);
    }
  });
});

describe('ISO 8601 extensions', () => {
  const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', nowMs: NOW });

  it('an explicit offset wins over a bracketed zone, which stays in the match', () => {
    const [r] = at('1999-03-22T05:06:07+02:00[Europe/Paris]');
    expect(iso(r!.epochMs)).toBe('1999-03-22T03:06:07.000Z');
    expect(r!.matchedText).toBe('1999-03-22T05:06:07+02:00[Europe/Paris]');
  });

  it('a bracketed zone alone follows daylight saving', () => {
    expect(iso(at('1999-07-22T05:06:07[Europe/Paris]')[0]!.epochMs)).toBe('1999-07-22T03:06:07.000Z');
  });

  it('an unknown bracketed zone is left out', () => {
    const [r] = at('1999-03-22T05:06:07[Mars/Olympus]');
    expect(r!.matchedText).toBe('1999-03-22T05:06:07');
    expect(r!.assumed).toBe(true);
  });

  it('reads AD and refuses BC', () => {
    expect(at('1999-03-22 AD')[0]?.matchedText).toBe('1999-03-22 AD');
    expect(at('1999-03-22 BC')).toHaveLength(0);
  });

  it('an impossible two-digit offset is refused', () => {
    expect(at('1999-03-22T05:06:07+15')).toHaveLength(0);
  });
});

describe('ISO week and ordinal dates', () => {
  const ymd = (y: number, w: number, d: number): string | null => {
    const r = isoWeekDate(y, w, d);
    return r ? `${r.y}-${String(r.mo).padStart(2, '0')}-${String(r.d).padStart(2, '0')}` : null;
  };
  it('follows the ISO 8601 week rules', () => {
    expect(ymd(1999, 13, 2)).toBe('1999-03-30');
    expect(ymd(1999, 12, 1)).toBe('1999-03-22');
    expect(ymd(2004, 53, 6)).toBe('2005-01-01');
    expect(ymd(2008, 1, 1)).toBe('2007-12-31');
    expect(ymd(2009, 53, 7)).toBe('2010-01-03');
    expect(ymd(2020, 53, 1)).toBe('2020-12-28');
    expect(ymd(2021, 53, 1)).toBeNull();
  });
  it('parses week and ordinal dates, and refuses impossible ones', () => {
    const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', nowMs: NOW });
    expect(iso(at('2024-W01')[0]!.epochMs)).toBe('2024-01-01T00:00:00.000Z');
    expect(iso(at('2024-366')[0]!.epochMs)).toBe('2024-12-31T00:00:00.000Z');
    expect(at('2023-366')).toHaveLength(0);
    expect(at('2021-W53-1')).toHaveLength(0);
  });
});

describe('compact dates', () => {
  const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', nowMs: NOW });
  it('only whole, valid eight-digit dates', () => {
    expect(iso(at('built 20240115 ok')[0]!.epochMs)).toBe('2024-01-15T00:00:00.000Z');
    for (const text of ['20240230', '12345678', '21000101', '120240115', '2024011', '20240115.5']) {
      expect(at(text).filter((r) => r.formatId === 'compact-date'), text).toHaveLength(0);
    }
  });
  it('does not steal epochs', () => {
    expect(at('1700000000')[0]?.formatId).toBe('epoch-seconds');
    expect(at('1999032212345')[0]?.formatId).toBe('epoch-millis');
  });
  it('loses a same-length tie to a custom format', () => {
    const [r] = parseTimes('20240115', {
      assumedZone: 'UTC',
      customFormats: [{ id: 'c', label: 'Mine', pattern: 'YYYYMMDD', advanced: false, enabled: true }],
    });
    expect(r?.kind).toBe('custom');
  });
});

describe('written dates in other languages', () => {
  const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', nowMs: NOW });
  it.each([
    ['Mittwoch, 3. Mrz. 2027', '2027-03-03T00:00:00.000Z'],
    ['3 févr. 2027', '2027-02-03T00:00:00.000Z'],
    ['sábado 6 marzo 2027', '2027-03-06T00:00:00.000Z'],
    ['segunda-feira, 22 março 1999', '1999-03-22T00:00:00.000Z'],
    ['maandag 22 maart 1999 om 05:06', '1999-03-22T05:06:00.000Z'],
    ['22 Set 1999', '1999-09-22T00:00:00.000Z'],
  ])('%s', (text, expected) => {
    const [r] = at(text);
    expect(r?.matchedText).toBe(text);
    expect(iso(r!.epochMs)).toBe(expected);
  });
  it('a leading word that is not a weekday is not highlighted', () => {
    expect(at('Meet on 22 März 1999')[0]?.matchedText).toBe('22 März 1999');
  });
  it('lower-case abbreviations that are English words are not months', () => {
    expect(at('I set 5 set 2024 goals').filter((r) => r.formatId === 'day-month-name')).toHaveLength(0);
  });
  it('a German date without a year does not leak its time as today', () => {
    expect(at('22. März 10:00')).toHaveLength(0);
  });
});

describe('the new built-ins are registered', () => {
  it('in priority order', () => {
    for (const id of ['numeric-date', 'compact-date', 'iso-ordinal', 'iso-week', 'unix-date', 'cjk-date']) {
      expect(BUILTIN_FORMAT_IDS).toContain(id);
    }
  });
});

describe('new formats stay fast on hostile input', () => {
  const time = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  it.each([
    ['digit-dot runs', '1.'.repeat(10_000)],
    ['digit-dot-space runs', '1. '.repeat(6_000)],
    ['slash dates', '22/03/'.repeat(3_000)],
    ['dash runs', '12-'.repeat(6_000)],
    ['eight-digit runs', '19990322'.repeat(2_500)],
    ['month names', 'März '.repeat(4_000)],
    ['weekday names', 'lundi '.repeat(3_000)],
    ['accented letters', 'é'.repeat(20_000)],
    ['day dots', '22. '.repeat(5_000)],
    ['CJK dates', '1999年3月'.repeat(2_500)],
    ['CJK characters', '年月日'.repeat(6_000)],
    ['unix-date prefixes', 'Mon Mar 22 '.repeat(1_800)],
    ['week dates', '1999-W'.repeat(3_000)],
    ['times then dates', '05:06 '.repeat(3_000)],
    ['dot times', '5.06.07.'.repeat(2_500)],
  ])('%s', (_, text) => {
    expect(time(() => parseTimes(text, 'UTC'))).toBeLessThan(300);
  });
});
