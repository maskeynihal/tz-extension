import { describe, it, expect } from 'vitest';
import { sanitize } from '../src/lib/storage';
import { DEFAULT_PREFERENCES } from '../src/types';

describe('sanitize targetZones', () => {
  it('falls back to defaults when the field is absent', () => {
    const p = sanitize({ homeZone: 'UTC' });
    expect(p.targetZones).toEqual(DEFAULT_PREFERENCES.targetZones);
  });

  it('falls back to defaults when the field is not an array', () => {
    const p = sanitize({ targetZones: 'UTC' });
    expect(p.targetZones).toEqual(DEFAULT_PREFERENCES.targetZones);
  });

  it('RESPECTS a deliberately-empty array (user cleared the list)', () => {
    const p = sanitize({ targetZones: [] });
    expect(p.targetZones).toEqual([]);
  });

  it('keeps only valid zones, de-duplicated, in order', () => {
    const p = sanitize({ targetZones: ['UTC', 'Not/AZone', 'UTC', 'Asia/Tokyo'] });
    expect(p.targetZones).toEqual(['UTC', 'Asia/Tokyo']);
  });

  it('sanitizes custom formats and drops empty patterns', () => {
    const p = sanitize({
      customFormats: [
        { id: 'a', label: 'X', pattern: 'DD/MM/YYYY', advanced: false, enabled: true },
        { id: 'b', label: 'empty', pattern: '', advanced: false, enabled: true },
      ],
    });
    expect(p.customFormats).toHaveLength(1);
    expect(p.customFormats[0]!.pattern).toBe('DD/MM/YYYY');
  });

  it('clamps dateOnlyPolicy to a known value', () => {
    expect(sanitize({ dateOnlyPolicy: 'now' }).dateOnlyPolicy).toBe('now');
    expect(sanitize({ dateOnlyPolicy: 'garbage' }).dateOnlyPolicy).toBe(
      DEFAULT_PREFERENCES.dateOnlyPolicy,
    );
  });
});
