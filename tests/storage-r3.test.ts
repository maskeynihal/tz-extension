import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PREFS_EXTRAS_KEY,
  PREFS_KEY,
  fromSyncItems,
  loadPreferences,
  savePreferences,
  toSyncItems,
} from '../src/lib/storage';
import { fixedZoneId, ianaEquivalent, listTimeZones, offsetMinutesAt } from '../src/lib/tz';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

/*
 * Round 3: sync scenarios from the review's simulation (sync-sim3.mjs), with
 * 0.6.x and the b677cfc build (two items, no write id) emulated on the stored
 * items, and the projection cache.
 */

type Item = Record<string, unknown>;
interface Area {
  get: (keys: string[]) => Promise<Record<string, Item | undefined>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}
const sync = (): Area => (globalThis as unknown as { chrome: { storage: { sync: Area } } }).chrome.storage.sync;

async function stored(): Promise<{ legacy: Item; extras: Item | undefined }> {
  const s = await sync().get([PREFS_KEY, PREFS_EXTRAS_KEY]);
  return { legacy: s[PREFS_KEY] as Item, extras: s[PREFS_EXTRAS_KEY] };
}

const isIana = (z: unknown): z is string => typeof z === 'string' && !z.startsWith('abbr:') && !/^UTC[+-]/.test(z);

/** 0.6.x loads the legacy item, edits, and saves it: IANA ids only, unknown fields (w, t, cardSize…) gone. */
async function oldDeviceEdit(edit: (p: Item) => void = () => {}): Promise<void> {
  const { legacy } = await stored();
  const p: Item = {
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
  edit(p);
  await sync().set({ [PREFS_KEY]: p });
}

/** Items as the b677cfc build wrote them: the same two items without `w` or `t`. */
function r2Items(prefs: Preferences): Record<string, Item> {
  const items = toSyncItems(prefs);
  const strip = ({ w: _w, t: _t, ...rest }: Item): Item => (void _w, void _t, rest);
  return { [PREFS_KEY]: strip(items[PREFS_KEY] as Item), [PREFS_EXTRAS_KEY]: strip(items[PREFS_EXTRAS_KEY] as Item) };
}

const START: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'abbr:PT',
  targetZones: ['Europe/London', 'UTC+05:45', 'abbr:IST-IE', 'Asia/Tokyo'],
  cardSize: 'last',
};
const NO_TOKYO = ['Europe/London', 'UTC+05:45', 'abbr:IST-IE'];

describe('write time', () => {
  afterEach(() => vi.useRealTimers());

  it('both items of a write share one write time, strictly increasing even within one millisecond', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 1), toFake: ['Date'] });
    const a = toSyncItems(START);
    const b = toSyncItems(START);
    const ta = (a[PREFS_KEY] as Item).t as number;
    expect(typeof ta).toBe('number');
    expect((a[PREFS_EXTRAS_KEY] as Item).t).toBe(ta);
    expect((b[PREFS_KEY] as Item).t as number).toBeGreaterThan(ta);
    expect(fromSyncItems(a)).not.toHaveProperty('t');
  });

  it("orders a save after another device's write that was read, even when that device's clock is ahead", async () => {
    // Another device (clock a day ahead) wrote; this context loads, then saves.
    const ahead = toSyncItems(START);
    const future = Date.now() + 86_400_000;
    for (const k of [PREFS_KEY, PREFS_EXTRAS_KEY]) (ahead[k] as Item).t = future;
    await sync().set(ahead);
    await loadPreferences();
    await savePreferences({ ...START, targetZones: NO_TOKYO });
    const { legacy, extras } = await stored();
    expect(legacy.t as number).toBeGreaterThan(future);
    // A peer that got this save's legacy item with the other device's extras: legacy is newer.
    expect(fromSyncItems({ [PREFS_KEY]: legacy, [PREFS_EXTRAS_KEY]: ahead[PREFS_EXTRAS_KEY] }).targetZones).toEqual(NO_TOKYO);
    expect(extras?.t).toBe(legacy.t);
  });
});

describe('sync-sim3 scenarios', () => {
  it('0.6.x edits the theme: it drops w, and everything new is kept', async () => {
    await savePreferences(START);
    await oldDeviceEdit((p) => (p.theme = 'dark'));
    const { legacy, extras } = await stored();
    expect(legacy).not.toHaveProperty('w');
    expect(extras?.w).toEqual(expect.any(String));
    const p = await loadPreferences();
    expect(p).toMatchObject({ homeZone: 'abbr:PT', targetZones: START.targetZones, cardSize: 'last', theme: 'dark' });
  });

  it('0.6.x adds New York and removes London', async () => {
    await savePreferences(START);
    await oldDeviceEdit((p) => (p.targetZones = ['Asia/Tokyo', 'America/New_York']));
    expect((await loadPreferences()).targetZones).toEqual(['UTC+05:45', 'abbr:IST-IE', 'Asia/Tokyo', 'America/New_York']);
  });

  it('0.6.x sets home to Tokyo', async () => {
    await savePreferences(START);
    await oldDeviceEdit((p) => (p.homeZone = 'Asia/Tokyo'));
    const p = await loadPreferences();
    expect(p.homeZone).toBe('Asia/Tokyo');
    expect(p.targetZones).toEqual(START.targetZones);
  });

  it('items written by b677cfc (no w, no t) read in full, then 0.6.x adds New York', async () => {
    await sync().set(r2Items(START));
    expect(await loadPreferences()).toMatchObject({ homeZone: 'abbr:PT', targetZones: START.targetZones, cardSize: 'last' });
    await oldDeviceEdit((p) => (p.targetZones = [...(p.targetZones as string[]), 'America/New_York']));
    expect((await loadPreferences()).targetZones).toEqual([...START.targetZones, 'America/New_York']);
  });

  it('a b677cfc device removes Tokyo from items this build wrote', async () => {
    await savePreferences(START);
    // b677cfc reads by fingerprints only and writes both items without w or t.
    const seen = fromSyncItems(await sync().get([PREFS_KEY, PREFS_EXTRAS_KEY]));
    await sync().set(r2Items({ ...seen, targetZones: seen.targetZones.filter((z) => z !== 'Asia/Tokyo') }));
    expect((await loadPreferences()).targetZones).toEqual(NO_TOKYO);
  });

  it("partial delivery, extras first: a peer with B's new extras and the stale legacy item drops Tokyo", async () => {
    await savePreferences(START);
    const { legacy: stale } = await stored();
    await savePreferences({ ...START, targetZones: NO_TOKYO });
    await sync().set({ [PREFS_KEY]: stale });
    expect((await loadPreferences()).targetZones).toEqual(NO_TOKYO);
  });

  it("partial delivery, legacy first: a peer with B's new legacy item and stale extras drops Tokyo, and a save in that window keeps it dropped", async () => {
    await savePreferences(START);
    const { extras: stale } = await stored();
    await savePreferences({ ...START, targetZones: NO_TOKYO });
    await sync().set({ [PREFS_EXTRAS_KEY]: stale });
    const p = await loadPreferences();
    expect(p.targetZones).toEqual(NO_TOKYO);
    expect(p.homeZone).toBe('abbr:PT');
    // The peer saves the theme before B's extras arrive.
    await savePreferences({ ...p, theme: 'dark' });
    expect(await loadPreferences()).toMatchObject({ targetZones: NO_TOKYO, homeZone: 'abbr:PT', theme: 'dark' });
  });

  it('partial delivery, legacy first: an IANA zone B added shows at once', async () => {
    await savePreferences(START);
    const { extras: stale } = await stored();
    await savePreferences({ ...START, targetZones: [...START.targetZones, 'America/New_York'] });
    await sync().set({ [PREFS_EXTRAS_KEY]: stale });
    expect((await loadPreferences()).targetZones).toEqual([...START.targetZones, 'America/New_York']);
  });

  it('partial delivery, legacy first: a new IANA home from B shows at once; an unchanged home keeps its full value', async () => {
    const before = toSyncItems(START);
    const moved = toSyncItems({ ...START, homeZone: 'Asia/Tokyo' });
    expect(fromSyncItems({ [PREFS_KEY]: moved[PREFS_KEY], [PREFS_EXTRAS_KEY]: before[PREFS_EXTRAS_KEY] }).homeZone).toBe('Asia/Tokyo');
    const same = toSyncItems({ ...START, theme: 'dark' });
    const p = fromSyncItems({ [PREFS_KEY]: same[PREFS_KEY], [PREFS_EXTRAS_KEY]: before[PREFS_EXTRAS_KEY] });
    expect(p).toMatchObject({ homeZone: 'abbr:PT', targetZones: START.targetZones, theme: 'dark' });
  });

  it('known gap, legacy first: a new-style id B removed shows until its extras lands', () => {
    // The legacy item cannot carry new-style ids, so it cannot say one is gone.
    const before = toSyncItems(START);
    const next: Preferences = { ...START, targetZones: ['Europe/London', 'abbr:IST-IE', 'Asia/Tokyo'] };
    const after = toSyncItems(next);
    expect(fromSyncItems({ [PREFS_KEY]: after[PREFS_KEY], [PREFS_EXTRAS_KEY]: before[PREFS_EXTRAS_KEY] }).targetZones).toEqual(
      START.targetZones,
    );
    expect(fromSyncItems(after).targetZones).toEqual(next.targetZones);
  });

  it('different w with equal or missing t uses extras (the round-2 rule)', () => {
    const before = toSyncItems(START);
    const after = toSyncItems({ ...START, targetZones: NO_TOKYO });
    const legacy = after[PREFS_KEY] as Item;
    const extras = before[PREFS_EXTRAS_KEY] as Item;
    const equal = { [PREFS_KEY]: { ...legacy, t: extras.t }, [PREFS_EXTRAS_KEY]: extras };
    expect(fromSyncItems(equal).targetZones).toEqual(START.targetZones);
    const { t: _t, ...noT } = legacy;
    void _t;
    expect(fromSyncItems({ [PREFS_KEY]: noT, [PREFS_EXTRAS_KEY]: extras }).targetZones).toEqual(START.targetZones);
    // Extras newer than legacy: extras.
    expect(fromSyncItems({ [PREFS_KEY]: before[PREFS_KEY], [PREFS_EXTRAS_KEY]: after[PREFS_EXTRAS_KEY] }).targetZones).toEqual(NO_TOKYO);
  });

  it('0.6.x-only items with alias ids: read and de-duplicated', async () => {
    await sync().set({
      [PREFS_KEY]: {
        ...DEFAULT_PREFERENCES,
        homeZone: 'Asia/Katmandu',
        targetZones: ['Asia/Calcutta', 'Asia/Kolkata', 'Europe/Kiev', 'Europe/Kyiv'],
      },
    });
    const n = await loadPreferences();
    expect(n.targetZones).toEqual(['Asia/Calcutta', 'Europe/Kiev']);
    await savePreferences({ ...n, targetZones: [...n.targetZones, 'UTC+05:45'] });
    expect((await loadPreferences()).targetZones).toEqual(['Asia/Calcutta', 'Europe/Kiev', 'UTC+05:45']);
    expect((await stored()).legacy.targetZones).toEqual(['Asia/Calcutta', 'Europe/Kiev']);
  });

  it('accepted quirk (ABA): 0.6.x sets home to Tokyo and back to Los Angeles, abbr:PT shows', async () => {
    await savePreferences(START);
    await oldDeviceEdit((p) => (p.homeZone = 'Asia/Tokyo'));
    await oldDeviceEdit((p) => (p.homeZone = 'America/Los_Angeles'));
    expect((await loadPreferences()).homeZone).toBe('abbr:PT');
  });
});

describe('projection speed (review #8)', () => {
  it('a home offset no zone uses (UTC+05:15) is fast on repeated saves', () => {
    const prefs: Preferences = { ...START, homeZone: 'UTC+05:15' };
    toSyncItems(prefs); // first call fills the cache
    const t0 = performance.now();
    const items = toSyncItems(prefs);
    const ms = performance.now() - t0;
    expect((items[PREFS_KEY] as Item).homeZone).toBe('UTC');
    expect(ms).toBeLessThan(10);
  });

  it('every non-whole-hour offset gives a zone on it that year, or UTC only when a full scan finds none', () => {
    const zones = listTimeZones();
    for (const at of [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]) {
      const y = new Date(at).getUTCFullYear();
      const days = Array.from({ length: 365 }, (_, d) => Date.UTC(y, 0, 1 + d));
      // Daily brute force over every zone, once per year: offsets anyone is on.
      const used = new Set<number>();
      for (const z of zones) for (const t of days) used.add(offsetMinutesAt(t, z));
      for (let m = -720; m <= 840; m += 15) {
        if (m % 60 === 0) continue;
        const id = fixedZoneId(m);
        const got = ianaEquivalent(id, at);
        // Same answer from the cache on a second call.
        expect(ianaEquivalent(id, at)).toBe(got);
        if (got === 'UTC') {
          expect(used.has(m), `${id}: some zone is on it in ${y}`).toBe(false);
        } else {
          expect(days.some((t) => offsetMinutesAt(t, got) === m), `${id} → ${got}`).toBe(true);
        }
      }
    }
    expect(ianaEquivalent('UTC+10:30', Date.UTC(2026, 6, 15))).toBe('Australia/Lord_Howe');
    expect(ianaEquivalent('UTC+05:15', Date.UTC(2026, 6, 15))).toBe('UTC');
  });
});

/*
 * Round 4 (review #3): the legacy item carries `pw`, the write it followed.
 * Separate module instances stand in for separate devices (each has its own
 * last write id and write time), sharing the mocked chrome.storage.sync, as
 * in the review's sync-sim4.mjs.
 */
describe('previous write id (round 4)', () => {
  type Storage = typeof import('../src/lib/storage');
  const device = async (): Promise<Storage> => {
    vi.resetModules();
    return import('../src/lib/storage');
  };
  afterEach(() => vi.useRealTimers());

  it('the legacy item names the write it follows; the first write of a context has none', async () => {
    const A = await device();
    await A.savePreferences(START);
    const first = await stored();
    expect(first.legacy).not.toHaveProperty('pw');
    expect(first.extras).not.toHaveProperty('pw');
    await A.savePreferences({ ...START, targetZones: NO_TOKYO });
    expect((await stored()).legacy.pw).toBe(first.extras?.w);
    // Another device that loads before saving follows the extras it read.
    const B = await device();
    const read = (await stored()).extras?.w;
    await B.loadPreferences();
    await B.savePreferences(START);
    expect((await stored()).legacy.pw).toBe(read);
  });

  it("sync-sim4 hybrid: two devices' halves (legacy A newer, extras B) read as B's list whole", async () => {
    // A (clock an hour ahead) and B write without seeing each other; the
    // final state holds A's legacy item and B's extras. Before round 4 the
    // peer read ["UTC+05:45", "Europe/London"], A's IANA ids with B's new-style ids.
    const A = await device();
    const B = await device();
    const P = await device();
    vi.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ['Date'] });
    await A.savePreferences({ ...START, targetZones: ['Europe/London', 'abbr:IST-IE'] });
    vi.useRealTimers();
    const legacyA = (await stored()).legacy;
    const bList = ['UTC+05:45', 'Asia/Tokyo', 'America/New_York'];
    await B.savePreferences({ ...START, targetZones: bList });
    await sync().set({ [PREFS_KEY]: legacyA });
    const { legacy, extras } = await stored();
    expect(legacy.t as number).toBeGreaterThan(extras?.t as number);
    expect(legacy.pw).toBeUndefined();
    expect((await P.loadPreferences()).targetZones).toEqual(bList);
  });

  it('the hybrid the other way round (legacy B, extras A newer) also reads one list whole', async () => {
    const A = await device();
    const B = await device();
    const P = await device();
    vi.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ['Date'] });
    const aList = ['Europe/London', 'abbr:IST-IE'];
    await A.savePreferences({ ...START, targetZones: aList });
    vi.useRealTimers();
    const extrasA = (await stored()).extras;
    await B.savePreferences({ ...START, targetZones: ['UTC+05:45', 'Asia/Tokyo', 'America/New_York'] });
    await sync().set({ [PREFS_EXTRAS_KEY]: extrasA });
    expect((await P.loadPreferences()).targetZones).toEqual(aList);
  });

  it('partial delivery across devices still merges: B read A, so its legacy item follows A', async () => {
    const A = await device();
    const B = await device();
    const P = await device();
    await A.savePreferences(START);
    const extrasA = (await stored()).extras;
    await B.loadPreferences();
    await B.savePreferences({ ...START, targetZones: [...NO_TOKYO, 'America/New_York'] });
    expect((await stored()).legacy.pw).toBe(extrasA?.w);
    await sync().set({ [PREFS_EXTRAS_KEY]: extrasA });
    // B's IANA edits (Tokyo gone, New York added) show; A's new-style ids come back from A's extras.
    expect((await P.loadPreferences()).targetZones).toEqual([...NO_TOKYO, 'America/New_York']);
  });

  it('a peer that saves inside that window keeps the result', async () => {
    const A = await device();
    const B = await device();
    const P = await device();
    await A.savePreferences(START);
    const extrasA = (await stored()).extras;
    await B.loadPreferences();
    await B.savePreferences({ ...START, targetZones: NO_TOKYO });
    await sync().set({ [PREFS_EXTRAS_KEY]: extrasA });
    const p = await P.loadPreferences();
    expect(p.targetZones).toEqual(NO_TOKYO);
    await P.savePreferences({ ...p, theme: 'dark' });
    expect(await A.loadPreferences()).toMatchObject({ targetZones: NO_TOKYO, theme: 'dark', homeZone: 'abbr:PT' });
  });

  it('measuring and failed saves are not writes: the next legacy item follows the last stored extras', async () => {
    const A = await device();
    await A.savePreferences(START);
    const w1 = (await stored()).extras?.w;
    A.syncItemBytes({ ...START, theme: 'dark' });
    // Too large for sync: nothing is written.
    const huge = {
      ...START,
      customFormats: Array.from({ length: 30 }, (_, i) => ({
        id: `f${i}`,
        label: 'x'.repeat(60),
        pattern: 'YYYY-MM-DD HH:mm '.repeat(20),
        advanced: false,
        enabled: true,
      })),
    };
    expect((await A.savePreferences(huge)).ok).toBe(false);
    // A set that throws.
    vi.mocked(sync().set).mockRejectedValueOnce(new Error('network'));
    expect((await A.savePreferences({ ...START, theme: 'light' })).ok).toBe(false);
    await A.savePreferences({ ...START, targetZones: NO_TOKYO });
    expect((await stored()).legacy.pw).toBe(w1);
  });

  it('a legacy item with a different pw but pt >= extras t (writes in a row, the middle extras lost) merges', () => {
    // Round 5 (review #1): this used to read extras whole and bring Tokyo
    // back. B wrote twice after A; the peer has B's second legacy item and
    // A's extras. B's pt (its first write's t) is above A's t, so legacy follows.
    const a = toSyncItems(START);
    const b1 = toSyncItems({ ...START, targetZones: NO_TOKYO });
    const b2 = toSyncItems({ ...START, targetZones: [...NO_TOKYO, 'America/New_York'] });
    const legacy = b2[PREFS_KEY] as Item;
    expect(legacy.pw).not.toBe((a[PREFS_EXTRAS_KEY] as Item).w);
    expect(legacy.pw).toBe((b1[PREFS_EXTRAS_KEY] as Item).w);
    expect(legacy.pt).toBe((b1[PREFS_EXTRAS_KEY] as Item).t);
    expect(fromSyncItems({ [PREFS_KEY]: legacy, [PREFS_EXTRAS_KEY]: a[PREFS_EXTRAS_KEY] }).targetZones).toEqual([
      ...NO_TOKYO,
      'America/New_York',
    ]);
  });
});

/*
 * Round 5 (review #1): two saves in a row. The legacy item carries `pt`, the
 * write time of the extras it follows, so a peer can tell "B saved twice
 * before its extras landed" from "two devices' halves". As consec.mjs.
 */
describe('previous write time (round 5)', () => {
  type Storage = typeof import('../src/lib/storage');
  const device = async (): Promise<Storage> => {
    vi.resetModules();
    return import('../src/lib/storage');
  };
  const KTM: Preferences = {
    ...DEFAULT_PREFERENCES,
    homeZone: 'Asia/Kathmandu',
    targetZones: ['Europe/London', 'UTC+05:45', 'Asia/Tokyo'],
    cardSize: 'last',
  };
  const KTM_NO_TOKYO = ['Europe/London', 'UTC+05:45'];

  it('consec.mjs: B saves twice before its extras lands; the peer writes lastCardSize; Tokyo stays removed', async () => {
    const A = await device();
    const B = await device();
    const P = await device();
    await A.savePreferences(KTM);
    const extrasA = (await stored()).extras;
    await B.loadPreferences();
    await B.savePreferences({ ...KTM, targetZones: KTM_NO_TOKYO }); // remove Tokyo
    const b1 = (await stored()).extras;
    await B.savePreferences({ ...KTM, targetZones: KTM_NO_TOKYO, hour12: true }); // then toggle 12h
    const { legacy } = await stored();
    expect(legacy.pw).toBe(b1?.w);
    expect(legacy.pt).toBe(b1?.t);
    // The peer has B's newest legacy item, the extras still A's.
    await sync().set({ [PREFS_EXTRAS_KEY]: extrasA });
    const p = await P.loadPreferences();
    expect(p).toMatchObject({ targetZones: KTM_NO_TOKYO, hour12: true, homeZone: 'Asia/Kathmandu' });
    await P.savePreferences({ ...p, lastCardSize: 'compact' });
    expect(await P.loadPreferences()).toMatchObject({ targetZones: KTM_NO_TOKYO, hour12: true, lastCardSize: 'compact' });
    expect((await A.loadPreferences()).targetZones).toEqual(KTM_NO_TOKYO);
  });

  it('the first write of a context has neither pw nor pt; a write after a load follows the extras it read', async () => {
    const A = await device();
    await A.savePreferences(KTM);
    const first = await stored();
    expect(first.legacy).not.toHaveProperty('pt');
    const B = await device();
    await B.loadPreferences();
    await B.savePreferences(KTM);
    expect((await stored()).legacy).toMatchObject({ pw: first.extras?.w, pt: first.extras?.t });
  });

  it("two devices' halves stay extras-whole: each device's pt is below the other's extras t", async () => {
    // Both read a common write C, then wrote without seeing each other.
    const C = await device();
    await C.savePreferences(KTM);
    const A = await device();
    const B = await device();
    const P = await device();
    await A.loadPreferences();
    await B.loadPreferences();
    vi.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ['Date'] });
    await A.savePreferences({ ...KTM, targetZones: ['Europe/London'] });
    vi.useRealTimers();
    const legacyA = (await stored()).legacy;
    const bList = ['UTC+05:45', 'America/New_York'];
    await B.savePreferences({ ...KTM, targetZones: bList });
    const extrasB = (await stored()).extras;
    await sync().set({ [PREFS_KEY]: legacyA });
    expect(legacyA.t as number).toBeGreaterThan(extrasB?.t as number);
    expect(legacyA.pt as number).toBeLessThan(extrasB?.t as number);
    expect((await P.loadPreferences()).targetZones).toEqual(bList);
  });

  it('pt is restored after a failed save', async () => {
    const A = await device();
    await A.savePreferences(KTM);
    const first = (await stored()).extras;
    vi.mocked(sync().set).mockRejectedValueOnce(new Error('network'));
    expect((await A.savePreferences({ ...KTM, theme: 'light' })).ok).toBe(false);
    await A.savePreferences({ ...KTM, theme: 'dark' });
    expect((await stored()).legacy).toMatchObject({ pw: first?.w, pt: first?.t });
  });
});
