import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { canonicalZone, ianaEquivalent, isValidZone, resolveZone } from './tz';
import { BUILTIN_FORMAT_IDS } from './builtin-formats';
import { MAX_ADVANCED_PATTERN } from './custom-formats';

/** The settings item every version reads and writes. */
export const PREFS_KEY = 'tz-extension-prefs';
/** Second sync item with what 0.6.x can't keep (see "Sync across versions"). */
export const PREFS_EXTRAS_KEY = 'tz-extension-prefs-v2-extras';

const KEY = PREFS_KEY;
const EXTRAS_KEY = PREFS_EXTRAS_KEY;

/*
 * Backends
 * --------
 * - Extension pages and content scripts: chrome.storage (sync, else local).
 * - The website: localStorage, only after it calls enableWebStorageBackend().
 * - Anything else: none. Loads give the defaults, saves report failure, and
 *   localStorage is never touched, so a content script can never fall back to
 *   a host page's storage.
 */
let webOptIn = false;

/**
 * Opt in to keeping settings in this origin's localStorage. Only the website
 * calls it, first thing in each entry point. It takes precedence over
 * chrome.storage.
 */
export function enableWebStorageBackend(): void {
  webOptIn = true;
}

type Backend =
  | { readonly kind: 'chrome'; readonly area: chrome.storage.StorageArea; readonly name: 'sync' | 'local' }
  | { readonly kind: 'web'; readonly storage: Storage | undefined }
  | { readonly kind: 'none' };

function backend(): Backend {
  if (webOptIn) return { kind: 'web', storage: web() };
  if (typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined') {
    if (typeof chrome.storage.sync !== 'undefined') return { kind: 'chrome', area: chrome.storage.sync, name: 'sync' };
    if (typeof chrome.storage.local !== 'undefined') return { kind: 'chrome', area: chrome.storage.local, name: 'local' };
  }
  return { kind: 'none' };
}

/** This origin's localStorage, when the browser allows it. */
function web(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined; // blocked (privacy mode / sandboxed iframe)
  }
}

/** Same-tab subscribers for the localStorage backend (the storage event only fires in other tabs). */
const webListeners = new Set<(p: Preferences) => void>();

export const MAX_CUSTOM_FORMATS = 30;
export const MAX_LABEL = 60;

/** A fresh, collision-resistant custom-format id. */
export function newFormatId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `fmt-${rand}`;
}

/** chrome.storage.sync allows 8,192 bytes per item (key + JSON value). */
export const SYNC_ITEM_LIMIT = 8192;

function itemBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/**
 * Bytes of the largest sync item these preferences are written as, counted
 * as UTF-8 to be safe. Settings save only while this is at most
 * SYNC_ITEM_LIMIT.
 */
export function syncItemBytes(prefs: Preferences): number {
  // Placeholder ids and time of the real lengths, so measuring is not a write.
  const t = Math.max(Date.now(), lastWriteTime + 1);
  const ids = { w: '0'.repeat(12), t, pw: lastWriteId ?? '0'.repeat(12), pt: lastWriteIdTime ?? t };
  return Math.max(...Object.entries(buildSyncItems(prefs, ids)).map(([k, v]) => itemBytes(k, v)));
}

/** Outcome of a save, so settings UIs can tell the user when it did not stick. */
export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const TOO_LARGE: SaveResult = {
  ok: false,
  error:
    'Settings are too large for browser sync storage. Remove some custom formats or shorten their labels, then try again.',
};

/** Clamp any persisted blob back into a valid Preferences object. */
export function sanitize(input: unknown): Preferences {
  const base = DEFAULT_PREFERENCES;
  if (typeof input !== 'object' || input === null) return base;
  const obj = input as Record<string, unknown>;

  const homeZone =
    typeof obj.homeZone === 'string' && isValidZone(obj.homeZone)
      ? obj.homeZone
      : base.homeZone;

  let targetZones = base.targetZones;
  if (Array.isArray(obj.targetZones)) {
    const valid = obj.targetZones.filter(
      (z): z is string => typeof z === 'string' && isValidZone(z),
    );
    // De-dup, keep order; an alias counts as its zone ("Asia/Calcutta" and
    // "Asia/Kolkata" keep only the first). An explicitly empty array is
    // respected (the user cleared the list); only an absent/non-array field
    // falls back to defaults.
    const seen = new Set<string>();
    targetZones = valid.filter((z) => {
      const c = canonicalZone(z);
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
  }

  const hour12 = typeof obj.hour12 === 'boolean' ? obj.hour12 : base.hour12;

  const dateOnlyPolicy =
    obj.dateOnlyPolicy === 'now' || obj.dateOnlyPolicy === 'midnight'
      ? obj.dateOnlyPolicy
      : base.dateOnlyPolicy;

  const keepSelection =
    typeof obj.keepSelection === 'boolean' ? obj.keepSelection : base.keepSelection;

  const theme =
    obj.theme === 'light' || obj.theme === 'dark' || obj.theme === 'system'
      ? obj.theme
      : base.theme;

  let customFormats = base.customFormats;
  if (Array.isArray(obj.customFormats)) {
    const ids = new Set<string>();
    customFormats = obj.customFormats
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => {
        let id = typeof f.id === 'string' && f.id ? f.id.slice(0, 40) : newFormatId();
        // Ids key edits and deletes, so they must be unique.
        while (ids.has(id)) id = newFormatId();
        ids.add(id);
        return {
          id,
          label: typeof f.label === 'string' ? f.label.slice(0, MAX_LABEL) : 'Custom',
          pattern: typeof f.pattern === 'string' ? f.pattern.slice(0, MAX_ADVANCED_PATTERN) : '',
          advanced: typeof f.advanced === 'boolean' ? f.advanced : false,
          enabled: typeof f.enabled === 'boolean' ? f.enabled : true,
        };
      })
      .filter((f) => f.pattern.length > 0)
      .slice(0, MAX_CUSTOM_FORMATS);
  }

  let disabledFormats = base.disabledFormats;
  if (Array.isArray(obj.disabledFormats)) {
    disabledFormats = Array.from(
      new Set(
        obj.disabledFormats.filter(
          (id): id is string => typeof id === 'string' && BUILTIN_FORMAT_IDS.includes(id),
        ),
      ),
    );
  }

  const selectToConvert =
    typeof obj.selectToConvert === 'boolean' ? obj.selectToConvert : base.selectToConvert;

  return {
    homeZone,
    targetZones,
    hour12,
    dateOnlyPolicy,
    keepSelection,
    theme,
    customFormats,
    disabledFormats,
    selectToConvert,
    cardSize: obj.cardSize === 'compact' || obj.cardSize === 'full' || obj.cardSize === 'last' ? obj.cardSize : base.cardSize,
    lastCardSize: obj.lastCardSize === 'compact' || obj.lastCardSize === 'full' ? obj.lastCardSize : base.lastCardSize,
    numericDateOrder:
      obj.numericDateOrder === 'dmy' || obj.numericDateOrder === 'mdy' ? obj.numericDateOrder : base.numericDateOrder,
  };
}

/*
 * Sync across versions
 * --------------------
 * Builds up to 0.6.x read and write only PREFS_KEY. Their sanitize keeps IANA
 * ids only and drops fields they don't know, and their next save syncs that
 * loss to every device. So this build writes two items:
 *
 * - PREFS_KEY ("legacy"): every field, but zone values that 0.6.x accepts.
 *   targetZones loses UTC±hh:mm and abbr:* ids; a homeZone of that kind
 *   becomes its IANA equivalent (abbr:PT → America/Los_Angeles,
 *   UTC+05:45 → Asia/Kathmandu, else Etc/GMT±N or UTC).
 * - PREFS_EXTRAS_KEY ("extras"): the full homeZone and targetZones, the
 *   fields 0.6.x drops (cardSize, lastCardSize, numericDateOrder), and a
 *   fingerprint of the legacy homeZone and targetZones just written.
 * - Both items carry the same random write id `w` and write time `t` (ms,
 *   strictly above every write time this context wrote or read). 0.6.x's
 *   sanitize drops unknown fields, so a legacy item written by 0.6.x has
 *   neither.
 * - The legacy item also carries `pw`, the write id this context last wrote,
 *   or last read in an extras item, before this write: the write it follows.
 *   It is absent when the context has seen no write id. Next to it, `pt` is
 *   the `t` of the last extras item this context read from storage that
 *   another context wrote (absent when it has read none). The context's own
 *   writes, and the onChanged echo of them, never set `pt`: a second save
 *   would otherwise carry the first save's `t`, which is above every extras
 *   written before it, including another device's that this context never
 *   read. So a legacy item with `pt >= extras.t` comes from a context that
 *   had read that extras, or one at least as new.
 *
 * Reading (fromSyncItems):
 * - No extras: the legacy item as is.
 * - Legacy carries a `w` (written by this build): if it equals extras' `w`,
 *   both come from one write, so use extras' full zone values. If it differs,
 *   the two items come from two different writes of this build: either one
 *   of them has not arrived yet (sync can deliver them separately), or two
 *   devices wrote without seeing each other and each device's half survived.
 *   - legacy newer, and legacy follows this extras: its `pw` is extras' `w`,
 *     or its `pt` is at least extras' `t` (the writer had seen this extras
 *     or a newer one, e.g. it saved twice in a row and its first extras
 *     never reached this reader). Its own extras is still in flight, so
 *     legacy is the truth for IANA ids; see below.
 *   - otherwise (extras newer, equal `t`, `t` missing on either, or a legacy
 *     item that did not follow this extras: two devices' halves, each
 *     device's `pt` below the other's extras `t`): use extras' full zone
 *     values whole. Merging would bring back a zone just removed on another
 *     device, or settle on one device's IANA ids with the other's new-style
 *     ids, which nothing in flight would correct.
 *   - In the "legacy follows" case: targetZones is
 *     mergeTargets(legacy, extras) as below; homeZone is legacy's, unless it
 *     equals the fingerprint of extras' home (the newer write kept that home,
 *     so extras' full value, e.g. abbr:PT, still applies).
 *     Known gap: a new-style id removed by the newer write shows until its
 *     extras lands, since the legacy item cannot say it is gone.
 *     Known gap: two devices that never read each other's writes merge as
 *     if one followed the other only when the extras one's clock is so far
 *     behind that its `t` is at or below an extras `t` the legacy one read
 *     from a third write (the legacy one's `pt`). Saving twice does not
 *     cause it, since `pt` comes only from reads.
 *   The item still in flight settles it when it lands.
 * - Legacy has no `w` (0.6.x wrote it, or a build older than the write id):
 *   - homeZone: if the legacy value still matches its fingerprint, nobody
 *     else changed it, so use the full value from extras. Otherwise an old
 *     device picked a new home; use the legacy value.
 *   - targetZones: if the legacy list matches its fingerprint, use the full
 *     list from extras. Otherwise an old device edited the list. Its list is
 *     the truth for IANA ids (order, additions, removals), and each new-style
 *     id from extras goes back in right after the IANA id that preceded it in
 *     the full list (at the start when none did, or that id was removed and
 *     no earlier one survives).
 *   - Accepted quirk ("ABA"): an old device that sets a value back to exactly
 *     the legacy projection (home abbr:PT is written as America/Los_Angeles;
 *     the old device picks Tokyo, then Los Angeles again) matches the
 *     fingerprint, so the full value (abbr:PT) wins. The cost is cosmetic:
 *     the projection always shows the same clock as the full value, so only
 *     the label differs.
 * - cardSize, lastCardSize, numericDateOrder: from extras, else legacy.
 * - Everything else: from legacy.
 * The localStorage backend stores the full preferences in one item; no old
 * version reads it.
 */

/** New-only fields that 0.6.x drops on save. */
const EXTRA_FIELDS = ['cardSize', 'lastCardSize', 'numericDateOrder'] as const;

/** Zone ids that 0.6.x accepts: IANA ids only. */
function isLegacyZone(zone: string): boolean {
  return resolveZone(zone)?.kind === 'iana';
}

/** FNV-1a (32-bit) of the JSON form, as hex. Detects edits, not tampering. */
function fingerprint(value: unknown): string {
  const s = JSON.stringify(value) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The two sync items for a new write of these preferences. The write's id
 * becomes this context's last write id (the next write's `pw`).
 */
export function toSyncItems(prefs: Preferences): Record<string, unknown> {
  const pw = lastWriteId;
  const pt = lastWriteIdTime;
  const w = writeId();
  const t = writeTime();
  const items = buildSyncItems(prefs, { w, t, pw, pt });
  lastWriteId = w;
  // `pt` stays the write time of the last extras read from storage: this
  // write's own `t` must never become a later write's `pt` (see remember).
  noteOwnWrite(w);
  return items;
}

interface WriteIds {
  readonly w: string;
  readonly t: number;
  /** The extras write this one follows; absent when this context has seen none. */
  readonly pw: string | undefined;
  /** The write time of `pw`'s extras; absent when unknown. */
  readonly pt: number | undefined;
}

function buildSyncItems(prefs: Preferences, { w, t, pw, pt }: WriteIds): Record<string, unknown> {
  const clean = sanitize(prefs);
  const targetZones = clean.targetZones.filter(isLegacyZone);
  const homeZone = isLegacyZone(clean.homeZone) ? clean.homeZone : ianaEquivalent(clean.homeZone);
  // The legacy item keeps the new-only fields too: 0.6.x ignores them, and a
  // reader without extras still finds them.
  const legacy: Preferences = { ...clean, homeZone, targetZones };
  const extras = {
    v: 1,
    w,
    t,
    homeZone: clean.homeZone,
    targetZones: clean.targetZones,
    cardSize: clean.cardSize,
    lastCardSize: clean.lastCardSize,
    numericDateOrder: clean.numericDateOrder,
    fpHome: fingerprint(homeZone),
    fpTargets: fingerprint(targetZones),
  };
  const follows = { ...(pw === undefined ? {} : { pw }), ...(pt === undefined ? {} : { pt }) };
  return { [KEY]: { ...legacy, w, t, ...follows }, [EXTRAS_KEY]: extras };
}

/** Largest write time written or seen in this context (see writeTime). */
let lastWriteTime = 0;

/**
 * The write id `w` this context last wrote, or last read in the extras item.
 * The next write stores it as `pw` in its legacy item.
 */
let lastWriteId: string | undefined;

/**
 * The write time `t` of the last extras item read from storage that this
 * context did not write (the next write's `pt`), when known.
 */
let lastWriteIdTime: number | undefined;

/** How many of this context's recent write ids are remembered (see ownWrites). */
const OWN_WRITES_KEPT = 64;

/**
 * Write ids this context made, newest last. remember() takes no `pt` from an
 * extras item carrying one of them, including the onChanged echo of a write.
 */
const ownWrites = new Set<string>();

function noteOwnWrite(w: string): void {
  ownWrites.add(w);
  while (ownWrites.size > OWN_WRITES_KEPT) {
    const oldest = ownWrites.values().next().value;
    if (oldest === undefined) break;
    ownWrites.delete(oldest);
  }
}

/**
 * Write time for a new write: Date.now(), but always above every write time
 * this context has written or read, so a write made after reading another
 * device's items orders after them even when that device's clock is ahead.
 */
function writeTime(): number {
  lastWriteTime = Math.max(Date.now(), lastWriteTime + 1);
  return lastWriteTime;
}

/** Raise lastWriteTime to the write times found in stored items. */
function noteWriteTimes(items: Record<string, unknown> | undefined): void {
  for (const k of [KEY, EXTRAS_KEY]) {
    const t = record(items?.[k])?.t;
    if (isWriteTime(t) && t > lastWriteTime) lastWriteTime = t;
  }
}

/** A fresh id shared by the two items of one write. */
function writeId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  return rand.slice(0, 12).padEnd(12, '0');
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Re-insert the new-style ids of `full` into an old device's `legacy` list. */
function mergeTargets(legacy: readonly unknown[], full: readonly unknown[]): string[] {
  const out = legacy.filter((z): z is string => typeof z === 'string');
  let at = 0;
  for (const z of full) {
    if (typeof z !== 'string') continue;
    if (isLegacyZone(z)) {
      const i = out.indexOf(z);
      if (i >= 0) at = i + 1;
    } else if (!out.includes(z)) {
      out.splice(at, 0, z);
      at += 1;
    }
  }
  return out;
}

/** Preferences from the stored sync items (rules under "Sync across versions"). */
export function fromSyncItems(items: Record<string, unknown> | undefined | null): Preferences {
  const legacy = record(items?.[KEY]);
  const extras = record(items?.[EXTRAS_KEY]);
  if (!extras) return sanitize(legacy ?? undefined);
  const out: Record<string, unknown> = { ...(legacy ?? {}) };
  // A write id on the legacy item means this build wrote it, not 0.6.x.
  const newWriter = typeof legacy?.w === 'string' && typeof extras.w === 'string';
  if (
    newWriter &&
    legacy &&
    legacy.w !== extras.w &&
    isWriteTime(legacy.t) &&
    isWriteTime(extras.t) &&
    legacy.t > extras.t &&
    (legacy.pw === extras.w || (isWriteTime(legacy.pt) && extras.t <= legacy.pt))
  ) {
    // The legacy item of a write made after this extras was read (directly,
    // or after more writes of the same context) arrived before its own
    // extras: legacy is the truth for IANA values, extras only adds the
    // new-style ids back.
    if (typeof legacy.homeZone !== 'string' || !isLegacyZone(legacy.homeZone) || fingerprint(legacy.homeZone) === extras.fpHome) {
      out.homeZone = extras.homeZone;
    }
    if (!Array.isArray(legacy.targetZones)) out.targetZones = extras.targetZones;
    else if (Array.isArray(extras.targetZones)) out.targetZones = mergeTargets(legacy.targetZones, extras.targetZones);
  } else {
    // Same write, extras newer, write times missing, a legacy item that did
    // not follow this extras (two devices' halves), or an old device's legacy item.
    readZones(out, legacy, extras, newWriter);
  }
  for (const f of EXTRA_FIELDS) if (extras[f] !== undefined) out[f] = extras[f];
  return sanitize(out);
}

/** True for a usable write time `t`. */
function isWriteTime(t: unknown): t is number {
  return typeof t === 'number' && Number.isSafeInteger(t) && t > 0;
}

/** Zone rules for every case but "legacy is from a newer write than extras". */
function readZones(
  out: Record<string, unknown>,
  legacy: Record<string, unknown> | null,
  extras: Record<string, unknown>,
  newWriter: boolean,
): void {
  if (!legacy || newWriter || typeof legacy.homeZone !== 'string' || fingerprint(legacy.homeZone) === extras.fpHome) {
    out.homeZone = extras.homeZone;
  }
  if (
    !legacy ||
    newWriter ||
    !Array.isArray(legacy.targetZones) ||
    fingerprint(legacy.targetZones) === extras.fpTargets
  ) {
    out.targetZones = extras.targetZones;
  } else if (Array.isArray(extras.targetZones)) {
    out.targetZones = mergeTargets(legacy.targetZones, extras.targetZones);
  }
}

/**
 * Last stored items seen in this context, per storage area. A change event
 * carries only the item that changed; the other comes from here.
 */
let known: { readonly area: chrome.storage.StorageArea; readonly items: Record<string, unknown> } | null = null;

function remember(area: chrome.storage.StorageArea, items: Record<string, unknown> | undefined): void {
  known = { area, items: { [KEY]: items?.[KEY], [EXTRAS_KEY]: items?.[EXTRAS_KEY] } };
  noteWriteTimes(items);
  const extras = record(items?.[EXTRAS_KEY]);
  if (typeof extras?.w === 'string') {
    lastWriteId = extras.w;
    // Only another context's write sets `pt`. Taking it from our own writes
    // would make a second save "follow" any older extras, including another
    // device's that this context never read (review r6 #1).
    if (!ownWrites.has(extras.w)) lastWriteIdTime = isWriteTime(extras.t) ? extras.t : undefined;
  }
}

export async function loadPreferences(): Promise<Preferences> {
  const b = backend();
  if (b.kind === 'none') return DEFAULT_PREFERENCES;
  if (b.kind === 'web') {
    if (!b.storage) return DEFAULT_PREFERENCES;
    try {
      const raw = b.storage.getItem(KEY);
      return sanitize(raw ? JSON.parse(raw) : undefined);
    } catch {
      return DEFAULT_PREFERENCES;
    }
  }
  try {
    const got: Record<string, unknown> | undefined = await b.area.get<Record<string, unknown>>([KEY, EXTRAS_KEY]);
    remember(b.area, got);
    return fromSyncItems(got);
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Persist preferences. Never throws: a failure (sync quota, restricted
 * context, no storage) resolves to `{ ok: false, error }` and the caller
 * keeps its in-memory copy.
 */
export async function savePreferences(prefs: Preferences): Promise<SaveResult> {
  const b = backend();
  if (b.kind === 'none') return { ok: false, error: 'Settings storage is not available here.' };
  if (b.kind === 'web') {
    if (!b.storage) return { ok: false, error: 'Could not save settings: this browser blocks site storage.' };
    try {
      const clean = sanitize(prefs);
      b.storage.setItem(KEY, JSON.stringify(clean));
      for (const l of webListeners) l(clean);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not save settings: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const prevWriteId = lastWriteId;
  const prevWriteIdTime = lastWriteIdTime;
  const items = toSyncItems(prefs);
  if (b.name === 'sync' && Object.entries(items).some(([k, v]) => itemBytes(k, v) > SYNC_ITEM_LIMIT)) {
    lastWriteId = prevWriteId; // nothing was written
    lastWriteIdTime = prevWriteIdTime;
    return TOO_LARGE;
  }
  try {
    await b.area.set(items);
    remember(b.area, items);
    return { ok: true };
  } catch (e) {
    // A failed set may have stored nothing; the next write follows the last
    // extras this context knows of.
    if (lastWriteId === (items[EXTRAS_KEY] as { w: string }).w) {
      lastWriteId = prevWriteId;
      lastWriteIdTime = prevWriteIdTime;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/quota/i.test(msg)) return TOO_LARGE;
    return { ok: false, error: `Could not save settings: ${msg}` };
  }
}

/**
 * Subscribe to changes made elsewhere (other tabs, windows, devices) and,
 * on the website, in this tab. The callback gets the merged preferences
 * whichever sync item changed. Returns an unsubscribe fn.
 */
export function onPreferencesChanged(cb: (prefs: Preferences) => void): () => void {
  const b = backend();
  if (b.kind === 'none') return () => {};
  if (b.kind === 'web') {
    if (!b.storage || typeof window === 'undefined') return () => {};
    // Other tabs: the storage event. This tab: our own listener set.
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== KEY) return;
      try {
        cb(sanitize(e.newValue ? JSON.parse(e.newValue) : undefined));
      } catch {
        /* ignore malformed */
      }
    };
    window.addEventListener('storage', onStorage);
    webListeners.add(cb);
    return () => {
      window.removeEventListener('storage', onStorage);
      webListeners.delete(cb);
    };
  }
  if (typeof chrome.storage.onChanged === 'undefined') return () => {};
  const { area, name } = b;
  let seq = 0;
  const listener = (changes: { [k: string]: chrome.storage.StorageChange }, areaName: string): void => {
    if (areaName && areaName !== name) return;
    if (!(KEY in changes) && !(EXTRAS_KEY in changes)) return;
    const apply = (base: Record<string, unknown> | undefined): void => {
      const items: Record<string, unknown> = { [KEY]: base?.[KEY], [EXTRAS_KEY]: base?.[EXTRAS_KEY] };
      for (const k of [KEY, EXTRAS_KEY]) if (k in changes) items[k] = changes[k]?.newValue;
      remember(area, items);
      cb(fromSyncItems(items));
    };
    if (known && known.area === area) {
      apply(known.items);
      return;
    }
    // Nothing read yet in this context: fetch the other item first.
    const mine = ++seq;
    void Promise.resolve(area.get<Record<string, unknown>>([KEY, EXTRAS_KEY])).then(
      (got) => {
        if (mine === seq) apply(got);
      },
      () => {
        if (mine === seq) apply(undefined);
      },
    );
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
