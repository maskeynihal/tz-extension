import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_CUSTOM_FORMATS,
  MAX_LABEL,
  PREFS_EXTRAS_KEY,
  PREFS_KEY,
  SYNC_ITEM_LIMIT,
  fromSyncItems,
  loadPreferences,
  newFormatId,
  onPreferencesChanged,
  sanitize,
  savePreferences,
  syncItemBytes,
  toSyncItems,
} from '../src/lib/storage';
import { ianaEquivalent, listTimeZones } from '../src/lib/tz';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

interface AreaMock {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}
interface ChromeMock {
  storage: { sync: AreaMock; onChanged: { addListener: ReturnType<typeof vi.fn> } };
}
const chromeMock = (): ChromeMock => (globalThis as unknown as { chrome: ChromeMock }).chrome;
type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>;
const lastListener = (): ((c: Changes, area: string) => void) =>
  chromeMock().storage.onChanged.addListener.mock.calls.at(-1)?.[0] as (c: Changes, area: string) => void;

/** What sync storage holds now. */
async function stored(): Promise<Record<string, Record<string, unknown>>> {
  return (await chromeMock().storage.sync.get([PREFS_KEY, PREFS_EXTRAS_KEY])) as Record<string, Record<string, unknown>>;
}

/** An install on 0.6.x loads and saves: it keeps IANA ids only and drops fields it doesn't know. */
function oldDeviceRewrite(legacy: Record<string, unknown>, edit: (p: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const isIana = (z: unknown): boolean =>
    typeof z === 'string' && !z.startsWith('abbr:') && !/^UTC[+-]/.test(z);
  const out: Record<string, unknown> = {
    homeZone: isIana(legacy.homeZone) ? legacy.homeZone : 'UTC',
    targetZones: (legacy.targetZones as unknown[]).filter(isIana),
    hour12: legacy.hour12,
    dateOnlyPolicy: legacy.dateOnlyPolicy,
    keepSelection: legacy.keepSelection,
    theme: legacy.theme,
    customFormats: legacy.customFormats,
    disabledFormats: legacy.disabledFormats,
    selectToConvert: legacy.selectToConvert,
  };
  edit(out);
  return out;
}

const NEW_STYLE: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'abbr:PT',
  targetZones: ['UTC', 'UTC+05:45', 'America/New_York', 'abbr:PDT', 'Europe/London', 'abbr:IST-IE'],
  cardSize: 'compact',
  lastCardSize: 'compact',
  numericDateOrder: 'mdy',
};

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

describe('sync across versions: two items', () => {
  it('writes legacy-safe zone values to the legacy item and the full values to extras', () => {
    const items = toSyncItems(NEW_STYLE);
    const legacy = items[PREFS_KEY] as Preferences;
    const extras = items[PREFS_EXTRAS_KEY] as Record<string, unknown>;
    expect(legacy.targetZones).toEqual(['UTC', 'America/New_York', 'Europe/London']);
    expect(legacy.homeZone).toBe('America/Los_Angeles');
    expect(extras.targetZones).toEqual(NEW_STYLE.targetZones);
    expect(extras.homeZone).toBe('abbr:PT');
    expect(extras).toMatchObject({ cardSize: 'compact', lastCardSize: 'compact', numericDateOrder: 'mdy' });
    expect(typeof extras.fpHome).toBe('string');
    expect(typeof extras.fpTargets).toBe('string');
  });

  it('replaces a fixed-offset home with an IANA zone on the same offset', () => {
    const home = (z: string): unknown => (toSyncItems({ ...NEW_STYLE, homeZone: z })[PREFS_KEY] as Preferences).homeZone;
    expect(home('UTC+05:45')).toBe('Asia/Kathmandu');
    expect(home('abbr:IST')).toBe('Asia/Kolkata');
    expect(home('UTC-08:00')).toBe('Etc/GMT+8');
    expect(home('Asia/Tokyo')).toBe('Asia/Tokyo');
  });

  it('saves both items in one write and loads the full values back', async () => {
    await savePreferences(NEW_STYLE);
    const set = chromeMock().storage.sync.set;
    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.keys(set.mock.calls[0]?.[0] ?? {}).sort()).toEqual([PREFS_KEY, PREFS_EXTRAS_KEY].sort());
    expect(await loadPreferences()).toEqual(sanitize(NEW_STYLE));
  });

  it('reads a legacy-only item (older writes) as is', async () => {
    await chromeMock().storage.sync.set({ [PREFS_KEY]: { ...NEW_STYLE } });
    expect(await loadPreferences()).toEqual(sanitize(NEW_STYLE));
  });

  it('keeps everything when an old device saves without touching zones', async () => {
    await savePreferences(NEW_STYLE);
    const s = await stored();
    // The old device loads, flips the theme and saves: new ids and fields are gone from its write.
    await chromeMock().storage.sync.set({
      [PREFS_KEY]: oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => (p.theme = 'dark')),
    });
    const p = await loadPreferences();
    expect(p).toEqual(sanitize({ ...NEW_STYLE, theme: 'dark' }));
  });

  it("takes an old device's zone edits and re-inserts the new-style ids at their places", async () => {
    await savePreferences(NEW_STYLE);
    const s = await stored();
    // Old device sees [UTC, America/New_York, Europe/London]. It removes New York,
    // moves London first and adds Tokyo at the end.
    await chromeMock().storage.sync.set({
      [PREFS_KEY]: oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => {
        p.targetZones = ['Europe/London', 'UTC', 'Asia/Tokyo'];
      }),
    });
    const p = await loadPreferences();
    // UTC+05:45 followed UTC; abbr:PDT followed New York (removed) so it stays after UTC's group;
    // abbr:IST-IE followed London.
    expect(p.targetZones).toEqual(['Europe/London', 'abbr:IST-IE', 'UTC', 'UTC+05:45', 'abbr:PDT', 'Asia/Tokyo']);
    expect(p.homeZone).toBe('abbr:PT');
    expect(p).toMatchObject({ cardSize: 'compact', lastCardSize: 'compact', numericDateOrder: 'mdy' });
  });

  it('puts new-style ids that led the list back at the start', () => {
    const prefs: Preferences = { ...NEW_STYLE, targetZones: ['abbr:PDT', 'UTC', 'Asia/Tokyo'] };
    const items = toSyncItems(prefs);
    const legacy = oldDeviceRewrite(items[PREFS_KEY] as Record<string, unknown>, (p) => {
      p.targetZones = ['Asia/Tokyo', 'UTC', 'Europe/Paris'];
    });
    expect(fromSyncItems({ ...items, [PREFS_KEY]: legacy }).targetZones).toEqual([
      'abbr:PDT',
      'Asia/Tokyo',
      'UTC',
      'Europe/Paris',
    ]);
  });

  it('takes a home zone chosen on an old device', async () => {
    await savePreferences(NEW_STYLE);
    const s = await stored();
    await chromeMock().storage.sync.set({
      [PREFS_KEY]: oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => (p.homeZone = 'Asia/Tokyo')),
    });
    const p = await loadPreferences();
    expect(p.homeZone).toBe('Asia/Tokyo');
    expect(p.targetZones).toEqual(NEW_STYLE.targetZones);
  });

  it('accepted quirk (ABA): an old device setting home back to the legacy projection keeps the full value', async () => {
    // abbr:PT is written to the legacy item as America/Los_Angeles.
    await savePreferences(NEW_STYLE);
    let s = await stored();
    await chromeMock().storage.sync.set({
      [PREFS_KEY]: oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => (p.homeZone = 'Asia/Tokyo')),
    });
    expect((await loadPreferences()).homeZone).toBe('Asia/Tokyo');
    s = await stored();
    await chromeMock().storage.sync.set({
      [PREFS_KEY]: oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => (p.homeZone = 'America/Los_Angeles')),
    });
    // The user picked Los Angeles, but it matches the fingerprint, so abbr:PT
    // shows. Deliberate: both show the same clock; only the label differs.
    expect((await loadPreferences()).homeZone).toBe('abbr:PT');
    expect(ianaEquivalent('abbr:PT')).toBe('America/Los_Angeles');
  });

  it('writes one shared write id into both items, fresh per write', () => {
    const a = toSyncItems(NEW_STYLE);
    const b = toSyncItems(NEW_STYLE);
    const wa = (a[PREFS_KEY] as Record<string, unknown>).w;
    expect(typeof wa).toBe('string');
    expect((a[PREFS_EXTRAS_KEY] as Record<string, unknown>).w).toBe(wa);
    expect((b[PREFS_KEY] as Record<string, unknown>).w).not.toBe(wa);
    // The write id is storage bookkeeping, not a preference.
    expect(fromSyncItems(a)).not.toHaveProperty('w');
  });

  it('partial delivery: newer extras with the previous legacy item do not bring a removed zone back', () => {
    const start: Preferences = { ...NEW_STYLE, targetZones: ['Europe/London', 'UTC+05:45', 'abbr:IST-IE', 'Asia/Tokyo'] };
    const before = toSyncItems(start);
    const after = toSyncItems({ ...start, targetZones: ['Europe/London', 'UTC+05:45', 'abbr:IST-IE'] });
    // A peer has the new extras but still the old legacy item.
    const p = fromSyncItems({ [PREFS_KEY]: before[PREFS_KEY], [PREFS_EXTRAS_KEY]: after[PREFS_EXTRAS_KEY] });
    expect(p.targetZones).toEqual(['Europe/London', 'UTC+05:45', 'abbr:IST-IE']);
    expect(p.homeZone).toBe('abbr:PT');
  });

  it('partial delivery the other way: newer legacy with the previous extras shows the previous zones until extras land', () => {
    const start: Preferences = { ...NEW_STYLE, targetZones: ['Europe/London', 'UTC+05:45', 'Asia/Tokyo'] };
    const before = toSyncItems(start);
    const next: Preferences = { ...start, targetZones: ['UTC+05:45', 'Asia/Tokyo'] };
    const after = toSyncItems(next);
    const mixed = { [PREFS_KEY]: after[PREFS_KEY], [PREFS_EXTRAS_KEY]: before[PREFS_EXTRAS_KEY] };
    expect(fromSyncItems(mixed).targetZones).toEqual(start.targetZones);
    expect(fromSyncItems({ ...mixed, [PREFS_EXTRAS_KEY]: after[PREFS_EXTRAS_KEY] }).targetZones).toEqual(next.targetZones);
  });

  it('an old device write (no write id) after a new write still merges as before', () => {
    const items = toSyncItems(NEW_STYLE);
    const legacy = oldDeviceRewrite(items[PREFS_KEY] as Record<string, unknown>, (p) => {
      p.targetZones = ['Asia/Tokyo'];
    });
    expect(legacy).not.toHaveProperty('w');
    expect(fromSyncItems({ ...items, [PREFS_KEY]: legacy }).targetZones).toEqual([
      'UTC+05:45',
      'abbr:PDT',
      'abbr:IST-IE',
      'Asia/Tokyo',
    ]);
  });

  it('extras from a build before the write id still use the fingerprints', () => {
    const items = toSyncItems(NEW_STYLE);
    const { w: _drop, ...oldExtras } = items[PREFS_EXTRAS_KEY] as Record<string, unknown>;
    void _drop;
    const legacy = { ...(items[PREFS_KEY] as Record<string, unknown>), homeZone: 'Asia/Tokyo' };
    expect(fromSyncItems({ [PREFS_KEY]: legacy, [PREFS_EXTRAS_KEY]: oldExtras }).homeZone).toBe('Asia/Tokyo');
  });

  it('an alias stored by an old device and its current name collapse to one entry', async () => {
    // 0.6.x on an engine that reports legacy names stored Asia/Calcutta.
    await chromeMock().storage.sync.set({ [PREFS_KEY]: { ...DEFAULT_PREFERENCES, homeZone: 'Asia/Katmandu', targetZones: ['Asia/Calcutta'] } });
    const n = await loadPreferences();
    expect(n.targetZones).toEqual(['Asia/Calcutta']);
    await savePreferences({ ...n, targetZones: [...n.targetZones, 'Asia/Kolkata', 'UTC+05:45'] });
    expect((await loadPreferences()).targetZones).toEqual(['Asia/Calcutta', 'UTC+05:45']);
    expect(sanitize({ targetZones: ['Europe/Kyiv', 'Europe/Kiev', 'UTC'] }).targetZones).toEqual(['Europe/Kyiv', 'UTC']);
  });

  it('fires onPreferencesChanged with merged prefs for a change to either item', async () => {
    await savePreferences(NEW_STYLE);
    const s = await stored();
    const seen: Preferences[] = [];
    onPreferencesChanged((p) => seen.push(p));
    const listener = lastListener();

    // Old device write: only the legacy item changes.
    const oldWrite = oldDeviceRewrite(s[PREFS_KEY] as Record<string, unknown>, (p) => (p.hour12 = false));
    listener({ [PREFS_KEY]: { newValue: oldWrite } }, 'sync');
    expect(seen.at(-1)).toEqual(sanitize({ ...NEW_STYLE, hour12: false }));

    // Extras-only change.
    const extras = { ...(s[PREFS_EXTRAS_KEY] as Record<string, unknown>), numericDateOrder: 'dmy' };
    listener({ [PREFS_EXTRAS_KEY]: { newValue: extras } }, 'sync');
    expect(seen.at(-1)).toEqual(sanitize({ ...NEW_STYLE, hour12: false, numericDateOrder: 'dmy' }));

    // Both at once (a new build's save).
    const next = { ...NEW_STYLE, targetZones: ['UTC-08:00', 'Asia/Tokyo'] };
    const items = toSyncItems(next);
    listener({ [PREFS_KEY]: { newValue: items[PREFS_KEY] }, [PREFS_EXTRAS_KEY]: { newValue: items[PREFS_EXTRAS_KEY] } }, 'sync');
    expect(seen.at(-1)).toEqual(sanitize(next));

    // Unrelated keys and other areas are ignored.
    const n = seen.length;
    listener({ other: { newValue: 1 } }, 'sync');
    listener({ [PREFS_KEY]: { newValue: oldWrite } }, 'managed');
    expect(seen.length).toBe(n);
  });

  it('reads the other item first when a change arrives before any load', async () => {
    await chromeMock().storage.sync.set(toSyncItems(NEW_STYLE));
    const seen: Preferences[] = [];
    onPreferencesChanged((p) => seen.push(p));
    const legacy = oldDeviceRewrite(toSyncItems(NEW_STYLE)[PREFS_KEY] as Record<string, unknown>);
    lastListener()({ [PREFS_KEY]: { newValue: legacy } }, 'sync');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(sanitize(NEW_STYLE));
  });

  it('checks both items against the sync item limit before writing', async () => {
    // IANA zones until the legacy item is close to the limit, then new-style
    // ids that only the extras item carries push it over.
    const iana: string[] = [];
    for (const z of listTimeZones()) {
      if (syncItemBytes({ ...DEFAULT_PREFERENCES, targetZones: [...iana, z] }) > SYNC_ITEM_LIMIT - 300) break;
      iana.push(z);
    }
    const sizeOf = (items: Record<string, unknown>, k: string): number =>
      new TextEncoder().encode(k + JSON.stringify(items[k])).length;
    const fixed: string[] = [];
    for (let m = -720; m <= 840 && fixed.length < 300; m += 15) {
      const sign = m < 0 ? '-' : '+';
      const a = Math.abs(m);
      fixed.push(`UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`);
      const trial = toSyncItems({ ...DEFAULT_PREFERENCES, targetZones: [...iana, ...fixed] });
      if (sizeOf(trial, PREFS_EXTRAS_KEY) > SYNC_ITEM_LIMIT) break;
    }
    const prefs: Preferences = { ...DEFAULT_PREFERENCES, targetZones: [...iana, ...fixed] };
    const items = toSyncItems(prefs);
    const bytes = (k: string): number => sizeOf(items, k);
    expect(bytes(PREFS_KEY)).toBeLessThanOrEqual(SYNC_ITEM_LIMIT);
    expect(bytes(PREFS_EXTRAS_KEY)).toBeGreaterThan(SYNC_ITEM_LIMIT);
    expect(syncItemBytes(prefs)).toBe(bytes(PREFS_EXTRAS_KEY));

    const r = await savePreferences(prefs);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(/too large for browser sync storage/);
    expect(chromeMock().storage.sync.set).not.toHaveBeenCalled();
  });
});

describe('storage backends', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** A fresh copy of storage.ts (module state: the web opt-in). */
  async function freshStorage(): Promise<typeof import('../src/lib/storage')> {
    vi.resetModules();
    return import('../src/lib/storage');
  }

  it('without chrome.storage or the opt-in: defaults, failed saves, localStorage untouched', async () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const s = await freshStorage();
    const p = await s.loadPreferences();
    expect(p.targetZones).toEqual(DEFAULT_PREFERENCES.targetZones);
    const r = await s.savePreferences({ ...DEFAULT_PREFERENCES, hour12: false });
    expect(r.ok).toBe(false);
    const cb = vi.fn();
    const off = s.onPreferencesChanged(cb);
    window.dispatchEvent(new StorageEvent('storage', { key: s.PREFS_KEY, newValue: '{}' }));
    off();
    expect(cb).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('with the website opt-in: localStorage, same-tab and cross-tab change events', async () => {
    const s = await freshStorage();
    s.enableWebStorageBackend();
    const cb = vi.fn();
    const off = s.onPreferencesChanged(cb);
    const prefs: Preferences = { ...DEFAULT_PREFERENCES, targetZones: ['UTC+05:45', 'abbr:PT'], hour12: false };
    expect(await s.savePreferences(prefs)).toEqual({ ok: true });
    // Full preferences in one item; chrome.storage untouched even though it exists.
    expect(JSON.parse(localStorage.getItem(s.PREFS_KEY) ?? 'null')).toEqual(sanitize(prefs));
    expect(chromeMock().storage.sync.set).not.toHaveBeenCalled();
    expect(await s.loadPreferences()).toEqual(sanitize(prefs));
    // Same tab.
    expect(cb).toHaveBeenLastCalledWith(sanitize(prefs));
    // Another tab.
    const other = { ...prefs, theme: 'dark' };
    window.dispatchEvent(new StorageEvent('storage', { key: s.PREFS_KEY, newValue: JSON.stringify(other) }));
    expect(cb).toHaveBeenLastCalledWith(sanitize(other));
    // Other keys are ignored.
    const n = cb.mock.calls.length;
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: '{}' }));
    expect(cb).toHaveBeenCalledTimes(n);
    off();
    window.dispatchEvent(new StorageEvent('storage', { key: s.PREFS_KEY, newValue: JSON.stringify(prefs) }));
    expect(cb).toHaveBeenCalledTimes(n);
  });

  it('the opt-in reports a blocked localStorage instead of claiming success', async () => {
    const s = await freshStorage();
    s.enableWebStorageBackend();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const r = await s.savePreferences(DEFAULT_PREFERENCES);
    expect(r.ok).toBe(false);
  });
});
