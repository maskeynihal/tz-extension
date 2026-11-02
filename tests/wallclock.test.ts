import { describe, it, expect } from 'vitest';
import { parseWallIso, wallFieldsToInstant } from '../src/lib/wallclock';

const iso = (ms: number | undefined): string => new Date(ms ?? NaN).toISOString();
const at = (s: string, tz: string) => wallFieldsToInstant(parseWallIso(s)!, tz);

describe('wallFieldsToInstant', () => {
  it('reads an ordinary time with the offset in force', () => {
    expect(at('2024-07-01T12:00', 'America/New_York')).toEqual({ epochMs: Date.parse('2024-07-01T16:00:00Z') });
    expect(at('2024-01-01T12:00', 'America/New_York')).toEqual({ epochMs: Date.parse('2024-01-01T17:00:00Z') });
    expect(at('2024-01-01T12:00', 'Asia/Kathmandu')).toEqual({ epochMs: Date.parse('2024-01-01T06:15:00Z') });
  });

  it.each([
    // Spring forward: 02:30 never happened; read with the old offset -> 03:30 new time.
    ['2024-03-10T02:30', 'America/New_York', '2024-03-10T07:30:00.000Z'],
    ['2024-03-31T01:30', 'Europe/London', '2024-03-31T01:30:00.000Z'],
    ['2024-10-06T02:15', 'Australia/Sydney', '2024-10-05T16:15:00.000Z'],
  ])('a time in a gap (%s %s) moves forward and says so', (s, tz, want) => {
    const r = at(s, tz);
    expect(r?.wallClock).toBe('gap');
    expect(iso(r?.epochMs)).toBe(want);
  });

  it.each([
    // Fall back: 01:30 happened twice; the earlier (summer-time) one is used.
    ['2024-11-03T01:30', 'America/New_York', '2024-11-03T05:30:00.000Z'],
    ['2024-10-27T01:30', 'Europe/London', '2024-10-27T00:30:00.000Z'],
    // Lord Howe falls back by 30 minutes (02:00 +11 -> 01:30 +10:30).
    ['2024-04-07T01:45', 'Australia/Lord_Howe', '2024-04-06T14:45:00.000Z'],
  ])('an ambiguous time (%s %s) takes the earlier instant and says so', (s, tz, want) => {
    const r = at(s, tz);
    expect(r?.wallClock).toBe('ambiguous');
    expect(iso(r?.epochMs)).toBe(want);
  });

  it('the edges of a transition are not flagged', () => {
    expect(at('2024-03-10T01:59', 'America/New_York')?.wallClock).toBeUndefined();
    expect(at('2024-03-10T03:00', 'America/New_York')?.wallClock).toBeUndefined();
    expect(at('2024-11-03T00:59', 'America/New_York')?.wallClock).toBeUndefined();
    expect(at('2024-11-03T02:00', 'America/New_York')?.wallClock).toBeUndefined();
  });

  it('fixed offsets and UTC never have gaps', () => {
    expect(at('2024-03-10T02:30', '+05:45')).toEqual({ epochMs: Date.parse('2024-03-09T20:45:00Z') });
    expect(at('2024-03-10T02:30', 'UTC')).toEqual({ epochMs: Date.parse('2024-03-10T02:30:00Z') });
  });

  it('handles years below 100 without the 19xx shift', () => {
    expect(iso(at('0050-06-01T00:00', 'UTC')?.epochMs)).toBe('0050-06-01T00:00:00.000Z');
  });

  it('is null for an unknown zone', () => {
    expect(at('2024-03-10T02:30', 'Mars/Olympus')).toBeNull();
  });

  it('parseWallIso reads the datetime-local shapes only', () => {
    expect(parseWallIso('2024-03-10T02:30')).toEqual({ y: 2024, mo: 3, d: 10, h: 2, mi: 30, s: 0 });
    expect(parseWallIso('2024-03-10T02:30:15')).toEqual({ y: 2024, mo: 3, d: 10, h: 2, mi: 30, s: 15 });
    expect(parseWallIso('2024-03-10 02:30')).toBeNull();
  });
});
