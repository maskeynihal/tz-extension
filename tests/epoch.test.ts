import { describe, it, expect } from 'vitest';
import { parseEpoch, toEpochSeconds, toEpochMillis, isInRange } from '../src/lib/epoch';

describe('parseEpoch', () => {
  it('detects 10-digit seconds', () => {
    const r = parseEpoch('1700000000');
    expect(r).toEqual({ epochMs: 1700000000000, unit: 'seconds' });
  });

  it('detects 13-digit milliseconds', () => {
    const r = parseEpoch('1700000000000');
    expect(r).toEqual({ epochMs: 1700000000000, unit: 'milliseconds' });
  });

  it('honors forced unit', () => {
    expect(parseEpoch('1700000000', 'milliseconds')).toEqual({
      epochMs: 1700000000,
      unit: 'milliseconds',
    });
  });

  it('handles epoch 0', () => {
    expect(parseEpoch('0')).toEqual({ epochMs: 0, unit: 'seconds' });
  });

  it('handles negative epoch (pre-1970)', () => {
    const r = parseEpoch('-100000');
    expect(r?.epochMs).toBe(-100000000);
    expect(r?.unit).toBe('seconds');
  });

  it('rejects non-numeric', () => {
    expect(parseEpoch('abc')).toBeNull();
    expect(parseEpoch('17e9')).toBeNull();
    expect(parseEpoch('1.5')).toBeNull();
    expect(parseEpoch('')).toBeNull();
    expect(parseEpoch('   ')).toBeNull();
  });

  it('rejects out-of-range (beyond year 9999)', () => {
    // 15 digits of milliseconds -> year ~33658, past the 9999 ceiling.
    expect(parseEpoch('999999999999999')).toBeNull();
    // Forced-seconds huge value also overflows.
    expect(parseEpoch('999999999999', 'seconds')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseEpoch('  1700000000  ')?.epochMs).toBe(1700000000000);
  });
});

describe('toEpoch*', () => {
  it('floors seconds', () => {
    expect(toEpochSeconds(1700000000999)).toBe(1700000000);
  });
  it('passes millis through', () => {
    expect(toEpochMillis(1700000000999)).toBe(1700000000999);
  });
});

describe('isInRange', () => {
  it('accepts now', () => {
    expect(isInRange(Date.now())).toBe(true);
  });
  it('rejects absurd future', () => {
    expect(isInRange(1e18)).toBe(false);
  });
});
