import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { compileTokenPattern, parseCustom } from '../src/lib/custom-formats';

const Z = 'Asia/Kathmandu';

describe('long-form & extended formats', () => {
  it('parses "Wednesday, October 28, 2026, 04:24:09 UTC"', () => {
    const [r] = parseTimes('Wednesday, October 28, 2026, 04:24:09 UTC', { assumedZone: Z });
    expect(r?.kind).toBe('long-form');
    expect(new Date(r!.epochMs).toISOString()).toBe('2026-10-28T04:24:09.000Z');
  });

  it('parses "Jan 1, 1970 (UTC)" with a parenthesized zone', () => {
    const [r] = parseTimes('Jan 1, 1970 (UTC)', { assumedZone: Z });
    expect(r).toBeDefined();
    expect(new Date(r!.epochMs).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('parses full month name "28 February 2024"', () => {
    const [r] = parseTimes('28 February 2024', { assumedZone: 'UTC' });
    expect(r).toBeDefined();
    expect(new Date(r!.epochMs).toISOString()).toBe('2024-02-28T00:00:00.000Z');
  });
});

describe('date-only policy', () => {
  it('midnight policy fills 00:00', () => {
    const [r] = parseTimes('2024-01-02', { assumedZone: 'UTC', dateOnlyPolicy: 'midnight' });
    expect(r?.dateOnly).toBe(true);
    expect(new Date(r!.epochMs).toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });

  it('now policy fills a non-midnight time of day', () => {
    const [r] = parseTimes('2024-01-02', { assumedZone: 'UTC', dateOnlyPolicy: 'now' });
    expect(r?.dateOnly).toBe(true);
    // Same calendar date, but the time is "now" — almost never exactly midnight.
    expect(new Date(r!.epochMs).toISOString().startsWith('2024-01-02')).toBe(true);
  });
});

describe('custom formats', () => {
  it('compiles a token pattern and parses DD/MM/YYYY HH:mm', () => {
    expect(compileTokenPattern('DD/MM/YYYY HH:mm')).toBeInstanceOf(RegExp);
    const r = parseCustom('31/12/2024 23:59', 'UTC', [
      { id: 'a', label: 'DMY', pattern: 'DD/MM/YYYY HH:mm', advanced: false, enabled: true },
    ]);
    expect(r).not.toBeNull();
    expect(new Date(r!.epochMs).toISOString()).toBe('2024-12-31T23:59:00.000Z');
  });

  it('ignores a disabled format', () => {
    const r = parseCustom('31/12/2024 23:59', 'UTC', [
      { id: 'a', label: 'DMY', pattern: 'DD/MM/YYYY HH:mm', advanced: false, enabled: false },
    ]);
    expect(r).toBeNull();
  });

  it('rejects an overlong token pattern (ReDoS guard)', () => {
    expect(compileTokenPattern('x'.repeat(200))).toBeNull();
  });

  it('advanced regex with named groups parses', () => {
    const r = parseCustom('2024.01.02', 'UTC', [
      {
        id: 'b',
        label: 'dots',
        pattern: '(?<y>\\d{4})\\.(?<mo>\\d{2})\\.(?<d>\\d{2})',
        advanced: true,
        enabled: true,
      },
    ]);
    expect(r).not.toBeNull();
    expect(new Date(r!.epochMs).toISOString()).toBe('2024-01-02T00:00:00.000Z');
  });
});
