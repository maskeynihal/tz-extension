import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';
import { toIsoUtc } from '../src/lib/tz';

const Z = 'UTC';

describe('parseTimes — ISO', () => {
  it('ISO with Z', () => {
    const [r] = parseTimes('meeting at 2024-01-02T15:04:05Z ok', Z);
    expect(r).toBeDefined();
    expect(toIsoUtc(r!.epochMs)).toBe('2024-01-02T15:04:05.000Z');
    expect(r!.assumed).toBe(false);
    expect(r!.kind).toBe('iso');
  });

  it('ISO with explicit offset +05:45', () => {
    const [r] = parseTimes('2024-01-02T17:45:00+05:45', Z);
    expect(toIsoUtc(r!.epochMs)).toBe('2024-01-02T12:00:00.000Z');
  });

  it('ISO without tz is assumed in the given zone', () => {
    const [r] = parseTimes('2024-01-02 15:04', 'Asia/Kathmandu');
    expect(r!.assumed).toBe(true);
    expect(r!.assumedZone).toBe('Asia/Kathmandu');
    // 15:04 Kathmandu -> 09:19 UTC
    expect(toIsoUtc(r!.epochMs)).toBe('2024-01-02T09:19:00.000Z');
  });
});

describe('parseTimes — epoch', () => {
  it('10-digit seconds', () => {
    const [r] = parseTimes('ts=1700000000 end', Z);
    expect(r!.kind).toBe('epoch-seconds');
    expect(r!.epochMs).toBe(1700000000000);
  });
  it('13-digit millis', () => {
    const [r] = parseTimes('1700000000000', Z);
    expect(r!.kind).toBe('epoch-millis');
  });
});

describe('parseTimes — bare time of day', () => {
  it('3pm is assumed, today', () => {
    const [r] = parseTimes('lunch at 3pm', Z);
    expect(r).toBeDefined();
    expect(r!.assumed).toBe(true);
    expect(r!.kind).toBe('time-of-day');
  });

  it('15:30 with colon parses', () => {
    const [r] = parseTimes('standup 15:30', Z);
    expect(r).toBeDefined();
    expect(r!.kind).toBe('time-of-day');
  });

  it('time with named offset UTC is absolute', () => {
    const [r] = parseTimes('call 9:00 UTC', Z);
    expect(r).toBeDefined();
    expect(r!.assumed).toBe(false);
  });

  it('a lone small integer is NOT a time', () => {
    expect(parseTimes('section 5', Z)).toHaveLength(0);
  });

  it('12am maps to 00:00', () => {
    const [r] = parseTimes('12:00 am UTC', Z);
    expect(toIsoUtc(r!.epochMs)).toMatch(/T00:00:00/);
  });

  it('12pm maps to 12:00', () => {
    const [r] = parseTimes('12:00 pm UTC', Z);
    expect(toIsoUtc(r!.epochMs)).toMatch(/T12:00:00/);
  });

  it('rejects 13pm', () => {
    expect(parseTimes('13pm', Z)).toHaveLength(0);
  });
});

describe('parseTimes — RFC-like', () => {
  it('Jan 2 2024 3:00 PM UTC', () => {
    const [r] = parseTimes('Jan 2 2024 3:00 PM UTC', Z);
    expect(r).toBeDefined();
    expect(toIsoUtc(r!.epochMs)).toBe('2024-01-02T15:00:00.000Z');
  });

  it('2 Jan 2024 15:00 (no tz, assumed)', () => {
    const [r] = parseTimes('2 Jan 2024 15:00', Z);
    expect(r).toBeDefined();
    expect(r!.assumed).toBe(true);
  });
});

describe('parseTimes — negatives & edges', () => {
  it('empty selection', () => {
    expect(parseTimes('', Z)).toHaveLength(0);
    expect(parseTimes('   ', Z)).toHaveLength(0);
  });
  it('non-time text', () => {
    expect(parseTimes('the quick brown fox', Z)).toHaveLength(0);
  });
});
