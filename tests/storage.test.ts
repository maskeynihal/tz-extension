import { describe, it, expect, vi } from 'vitest';
import {
  MAX_CUSTOM_FORMATS,
  MAX_LABEL,
  loadPreferences,
  newFormatId,
  sanitize,
  savePreferences,
} from '../src/lib/storage';
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

describe('sanitize new preferences', () => {
  it('defaults selectToConvert to on and disabledFormats to empty for old saved prefs', () => {
    const p = sanitize({ homeZone: 'UTC', hour12: true });
    expect(p.selectToConvert).toBe(true);
    expect(p.disabledFormats).toEqual([]);
  });

  it('keeps a saved selectToConvert=false', () => {
    expect(sanitize({ selectToConvert: false }).selectToConvert).toBe(false);
    expect(sanitize({ selectToConvert: 'no' }).selectToConvert).toBe(true);
  });

  it('keeps only known built-in ids in disabledFormats, de-duplicated', () => {
    const p = sanitize({ disabledFormats: ['iso-8601', 'bogus', 'iso-8601', 7, 'time-of-day'] });
    expect(p.disabledFormats).toEqual(['iso-8601', 'time-of-day']);
  });

  it('gives duplicate or missing custom format ids fresh unique ids', () => {
    const p = sanitize({
      customFormats: [
        { id: 'same', label: 'A', pattern: 'DD/MM/YYYY' },
        { id: 'same', label: 'B', pattern: 'MM/DD/YYYY' },
        { label: 'C', pattern: 'YYYY.MM.DD' },
      ],
    });
    const ids = p.customFormats.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('same');
  });

  it('caps the number of custom formats and label length', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, label: 'x'.repeat(200), pattern: 'DD/MM/YYYY' }));
    const p = sanitize({ customFormats: many });
    expect(p.customFormats).toHaveLength(MAX_CUSTOM_FORMATS);
    expect(p.customFormats[0]!.label.length).toBe(MAX_LABEL);
  });
});

describe('savePreferences', () => {
  it('reports success', async () => {
    await expect(savePreferences(DEFAULT_PREFERENCES)).resolves.toEqual({ ok: true });
  });

  it('reports a sync quota failure with an actionable message', async () => {
    const sync = (globalThis as unknown as { chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.sync;
    sync.set.mockRejectedValueOnce(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
    const r = await savePreferences(DEFAULT_PREFERENCES);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/too large for browser sync storage/);
  });

  it('reports other failures', async () => {
    const sync = (globalThis as unknown as { chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.sync;
    sync.set.mockRejectedValueOnce(new Error('boom'));
    const r = await savePreferences(DEFAULT_PREFERENCES);
    expect(r).toEqual({ ok: false, error: 'Could not save settings: boom' });
  });

  it('round-trips the new fields', async () => {
    await savePreferences({ ...DEFAULT_PREFERENCES, selectToConvert: false, disabledFormats: ['epoch-millis'] });
    const p = await loadPreferences();
    expect(p.selectToConvert).toBe(false);
    expect(p.disabledFormats).toEqual(['epoch-millis']);
  });
});

describe('newFormatId', () => {
  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newFormatId()));
    expect(ids.size).toBe(200);
  });
});
