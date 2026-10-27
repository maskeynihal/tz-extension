import { describe, it, expect } from 'vitest';
import {
  viewInZone,
  wallClockToEpochMs,
  toIsoUtc,
  isValidZone,
  listTimeZones,
} from '../src/lib/tz';

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
