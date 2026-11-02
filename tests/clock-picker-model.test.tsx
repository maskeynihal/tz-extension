import { describe, it, expect } from 'vitest';
import {
  LIVE,
  absolutePlan,
  addDays,
  addMonths,
  daysInMonth,
  formatDiff,
  formatSpan,
  isPlanning,
  monthGrid,
  offsetPlan,
  pickToIso,
  planInstant,
  planMinutesFromNow,
  readWallPick,
  relativeDay,
  homeDayNumber,
  wallPick,
  weekdayOf,
  withMonth,
  type WallPick,
} from '../src/clock/model';

// Tuesday 2 Jan 2024, 20:00 UTC — noon at UTC-08:00, as in tests/clock.test.tsx.
const NOW = Date.UTC(2024, 0, 2, 20, 0, 0);

const at = (y: number, mo: number, d: number, h = 0, mi = 0): WallPick => ({ y, mo, d, h, mi });

describe('plans', () => {
  it('live, offset and absolute plans resolve to their instant', () => {
    expect(planInstant(NOW, LIVE)).toBe(NOW);
    expect(isPlanning(LIVE)).toBe(false);

    const offset = offsetPlan(8); // +2h, snapped to the quarter hour
    expect(isPlanning(offset)).toBe(true);
    expect(planInstant(NOW, offset)).toBe(Date.UTC(2024, 0, 2, 22, 0));

    const picked = absolutePlan(Date.UTC(2024, 1, 29, 9, 30));
    expect(isPlanning(picked)).toBe(true);
    // An absolute plan holds its instant whatever "now" is.
    expect(planInstant(NOW, picked)).toBe(Date.UTC(2024, 1, 29, 9, 30));
    expect(planInstant(NOW + 86_400_000, picked)).toBe(Date.UTC(2024, 1, 29, 9, 30));
  });

  it('a zero-step offset is live, and a non-finite instant falls back to live', () => {
    expect(offsetPlan(0)).toBe(LIVE);
    expect(offsetPlan(0, true)).toBe(LIVE);
    expect(absolutePlan(NaN)).toBe(LIVE);
    expect(absolutePlan(Number.POSITIVE_INFINITY)).toBe(LIVE);
  });

  it('“from now” for an absolute plan counts from the current minute, across days', () => {
    // Seconds into the minute must not count, as for the scrubber.
    const now = NOW + 20_000;
    expect(planMinutesFromNow(now, LIVE)).toBe(0);
    expect(planMinutesFromNow(now, absolutePlan(Date.UTC(2024, 0, 5, 20, 0)))).toBe(3 * 1440);
    expect(planMinutesFromNow(now, absolutePlan(Date.UTC(2023, 11, 30, 20, 0)))).toBe(-3 * 1440);
    expect(planMinutesFromNow(now, absolutePlan(Date.UTC(2024, 0, 2, 20, 45)))).toBe(45);
    // The scrubber's own figure is unchanged.
    expect(planMinutesFromNow(now, offsetPlan(96, true))).toBe(24 * 60);
  });

  it('rounds “from now” the same way in both directions', () => {
    // Half a minute into the minute, a pick three days out is thirty seconds
    // short of three days, and one three days back is thirty seconds over.
    // The figure must be wrong by the same amount either way: it used to
    // count from the minute just gone, which pushed every future distance up
    // (a pick 3 d 0 h 34 m away read "+3d 35m") and left past ones exact.
    const ahead = Date.UTC(2024, 0, 5, 20, 0);
    const behind = Date.UTC(2023, 11, 30, 20, 0);
    for (const secs of [31_000, 45_000, 59_000]) {
      const now = NOW + secs;
      const fwd = planMinutesFromNow(now, absolutePlan(ahead));
      const back = planMinutesFromNow(now, absolutePlan(behind));
      // Both figures move by the same signed amount, because both instants
      // are the same distance the same side of a whole minute from now.
      expect(fwd - 3 * 1440).toBe(back + 3 * 1440);
      // Never flattered: a distance short of three days does not read as three.
      expect(fwd).toBeLessThan(3 * 1440);
    }
    // And never more than half a minute out in either direction.
    for (const secs of [0, 1_000, 29_000, 31_000, 59_999]) {
      const now = NOW + secs;
      expect(Math.abs(planMinutesFromNow(now, absolutePlan(ahead)) * 60_000 - (ahead - now))).toBeLessThanOrEqual(30_000);
      expect(Math.abs(planMinutesFromNow(now, absolutePlan(behind)) * 60_000 - (behind - now))).toBeLessThanOrEqual(30_000);
    }
  });

  it('formats a span in hours within two days and in days beyond', () => {
    // Up to two days it is exactly formatDiff, so every scrubber plan reads as before.
    for (const m of [0, 345, -540, -30, 2160, -720, 2087]) expect(formatSpan(m)).toBe(formatDiff(m));
    expect(formatSpan(2160)).toBe('+36h');
    expect(formatSpan(2879)).toBe('+47h 59m');
    expect(formatSpan(2880)).toBe('+2d');
    expect(formatSpan(-2880)).toBe('−2d');
    expect(formatSpan(4410)).toBe('+3d 1h 30m');
    expect(formatSpan(14_400)).toBe('+10d');
    // A unit is only dropped off the end, never out of the middle: "−4d 15m"
    // read as if the hours had gone missing.
    expect(formatSpan(-5775)).toBe('−4d 0h 15m');
    expect(formatSpan(4335)).toBe('+3d 0h 15m');
    // Still dropped off the end: whole days stop at days, whole hours at hours.
    expect(formatSpan(4320)).toBe('+3d');
    expect(formatSpan(4500)).toBe('+3d 3h');
  });

  it('day tags for an absolute plan still count from home’s real today', () => {
    const today = homeDayNumber(NOW, 'UTC-08:00');
    // 6 Jan 09:00 at home (UTC-08:00) is four days on from Tue 2 Jan.
    const plan = readWallPick(at(2024, 1, 6, 9, 0), 'UTC-08:00', false);
    expect(plan?.epochMs).toBe(Date.UTC(2024, 0, 6, 17, 0));
    expect(relativeDay(plan!.epochMs, 'UTC-08:00', 'UTC-08:00', today)).toBe('In 4 days');
    // 17:00 UTC on the 6th is already the 7th at UTC+09:00.
    expect(relativeDay(plan!.epochMs, 'UTC+09:00', 'UTC-08:00', today)).toBe('In 5 days');
    const back = readWallPick(at(2023, 12, 28, 9, 0), 'UTC-08:00', false);
    expect(relativeDay(back!.epochMs, 'UTC-08:00', 'UTC-08:00', today)).toBe('5 days ago');
  });
});

describe('calendar arithmetic', () => {
  it('knows month lengths, including leap years and the century rules', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect([1, 3, 5, 7, 8, 10, 12].map((mo) => daysInMonth(2024, mo))).toEqual([31, 31, 31, 31, 31, 31, 31]);
    expect([4, 6, 9, 11].map((mo) => daysInMonth(2024, mo))).toEqual([30, 30, 30, 30]);
  });

  it('reads weekdays without the host zone', () => {
    expect(weekdayOf(2024, 1, 1)).toBe(1); // Monday
    expect(weekdayOf(2024, 2, 29)).toBe(4); // Thursday
    expect(weekdayOf(2026, 11, 2)).toBe(1);
  });

  it('lays a month out in Sunday-first weeks, padded with nulls', () => {
    const jan = monthGrid(2024, 1);
    expect(jan).toHaveLength(5);
    expect(jan[0]).toEqual([null, 1, 2, 3, 4, 5, 6]);
    expect(jan[4]).toEqual([28, 29, 30, 31, null, null, null]);

    const feb = monthGrid(2024, 2); // leap: 29 days, starting Thursday
    expect(feb[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(feb[4]).toEqual([25, 26, 27, 28, 29, null, null]);
    expect(monthGrid(2023, 2)[4]).toEqual([26, 27, 28, null, null, null, null]);
    for (const weeks of [jan, feb, monthGrid(2024, 9)]) {
      for (const week of weeks) expect(week).toHaveLength(7);
    }
  });

  it('steps days across month and year ends', () => {
    expect(addDays(at(2024, 12, 31, 23, 45), 1)).toEqual(at(2025, 1, 1, 23, 45));
    expect(addDays(at(2024, 3, 1), -1)).toEqual(at(2024, 2, 29));
    expect(addDays(at(2023, 3, 1), -1)).toEqual(at(2023, 2, 28));
    expect(addDays(at(2024, 1, 15, 9, 30), 7)).toEqual(at(2024, 1, 22, 9, 30));
  });

  it('steps months carrying the year, and clamps the day into a shorter month', () => {
    expect(addMonths({ y: 2024, mo: 1 }, -1)).toEqual({ y: 2023, mo: 12 });
    expect(addMonths({ y: 2024, mo: 12 }, 1)).toEqual({ y: 2025, mo: 1 });
    expect(addMonths({ y: 2024, mo: 1 }, 14)).toEqual({ y: 2025, mo: 3 });
    expect(addMonths({ y: 2024, mo: 3 }, -14)).toEqual({ y: 2023, mo: 1 });
    expect(withMonth(at(2024, 1, 31, 8, 0), { y: 2024, mo: 2 })).toEqual(at(2024, 2, 29, 8, 0));
    expect(withMonth(at(2024, 1, 31, 8, 0), { y: 2023, mo: 2 })).toEqual(at(2023, 2, 28, 8, 0));
    expect(withMonth(at(2024, 5, 15), { y: 2024, mo: 6 })).toEqual(at(2024, 6, 15));
  });

  it('writes a pick as the ISO shape wallClockToInstant parses', () => {
    expect(pickToIso(at(2026, 3, 8, 2, 30))).toBe('2026-03-08T02:30:00');
    expect(pickToIso(at(850, 12, 1, 0, 5))).toBe('0850-12-01T00:05:00');
  });

  it('seeds a pick from an instant in the zone, never the browser’s', () => {
    expect(wallPick(NOW, 'UTC-08:00')).toEqual(at(2024, 1, 2, 12, 0));
    expect(wallPick(NOW, 'UTC+05:45')).toEqual(at(2024, 1, 3, 1, 45));
    expect(wallPick(NOW, 'Asia/Kathmandu')).toEqual(at(2024, 1, 3, 1, 45));
  });
});

describe('reading a picked wall clock', () => {
  it('reads a plain time as that zone’s wall clock, with no note', () => {
    expect(readWallPick(at(2026, 6, 15, 9, 0), 'UTC-08:00', false)).toEqual({
      epochMs: Date.UTC(2026, 5, 15, 17, 0),
      note: null,
    });
    expect(readWallPick(at(2026, 6, 15, 9, 0), 'Asia/Kathmandu', false)).toEqual({
      epochMs: Date.UTC(2026, 5, 15, 3, 15),
      note: null,
    });
    // Summer vs winter in a DST zone: the same written time, two offsets.
    expect(readWallPick(at(2026, 7, 1, 12, 0), 'America/New_York', false)?.epochMs).toBe(Date.UTC(2026, 6, 1, 16, 0));
    expect(readWallPick(at(2026, 1, 1, 12, 0), 'America/New_York', false)?.epochMs).toBe(Date.UTC(2026, 0, 1, 17, 0));
  });

  it('a time in a spring-forward gap uses the offset from before the jump, and says so', () => {
    const r = readWallPick(at(2026, 3, 8, 2, 30), 'America/New_York', false);
    // 02:30 read as EST (−05:00); the clocks show 03:30 EDT.
    expect(r?.epochMs).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(r?.note).toMatch(/02:30 doesn't exist on 8 Mar in New York \(clocks jump forward\); shown as 03:30\./);
  });

  it('a time in a fall-back overlap takes the earlier instant, and says so', () => {
    const r = readWallPick(at(2026, 11, 1, 1, 30), 'America/New_York', false);
    // The first 01:30, still EDT (−04:00).
    expect(r?.epochMs).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(r?.note).toMatch(/01:30 happens twice on 1 Nov in New York; showing the first \(EDT\)\./);
  });

  it('the note follows the reader’s clock format', () => {
    expect(readWallPick(at(2026, 11, 1, 1, 30), 'America/New_York', true)?.note).toMatch(
      /1:30 AM happens twice on 1 Nov in New York/,
    );
  });

  it('is null for an unreadable zone', () => {
    expect(readWallPick(at(2026, 6, 15, 9, 0), 'Not/AZone')).toBeNull();
  });
});
