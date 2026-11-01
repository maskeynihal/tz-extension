import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

/**
 * Zone ids used across the extension. Three kinds:
 *  - IANA ids ("Asia/Kathmandu", "UTC"), validated by the runtime's Intl.
 *  - Fixed UTC offsets: "UTC+05:45", "UTC-08:00" (−12:00 … +14:00).
 *  - Abbreviations: "abbr:PDT" (a fixed offset with a name) and the DST-aware
 *    US generics "abbr:PT", "abbr:MT", "abbr:CT", "abbr:ET", "abbr:AKT",
 *    which follow an IANA zone.
 * Every function here accepts any of them.
 */

/** A named zone abbreviation offered in the zone lists. */
export interface ZoneAbbreviation {
  readonly code: string;
  readonly name: string;
  /** Fixed offset in minutes east of UTC; absent for DST-aware generics. */
  readonly minutes?: number;
  /** IANA zone a DST-aware generic follows. */
  readonly iana?: string;
}

export const ZONE_ABBREVIATIONS: readonly ZoneAbbreviation[] = [
  // DST-aware generics (follow the region's clock change).
  { code: 'PT', name: 'Pacific Time (US & Canada)', iana: 'America/Los_Angeles' },
  { code: 'MT', name: 'Mountain Time (US & Canada)', iana: 'America/Denver' },
  { code: 'CT', name: 'Central Time (US & Canada)', iana: 'America/Chicago' },
  { code: 'ET', name: 'Eastern Time (US & Canada)', iana: 'America/New_York' },
  { code: 'AKT', name: 'Alaska Time', iana: 'America/Anchorage' },
  // North America
  { code: 'PST', name: 'Pacific Standard Time', minutes: -480 },
  { code: 'PDT', name: 'Pacific Daylight Time', minutes: -420 },
  { code: 'MST', name: 'Mountain Standard Time', minutes: -420 },
  { code: 'MDT', name: 'Mountain Daylight Time', minutes: -360 },
  { code: 'CST', name: 'Central Standard Time (US)', minutes: -360 },
  { code: 'CDT', name: 'Central Daylight Time (US)', minutes: -300 },
  { code: 'EST', name: 'Eastern Standard Time', minutes: -300 },
  { code: 'EDT', name: 'Eastern Daylight Time', minutes: -240 },
  { code: 'AKST', name: 'Alaska Standard Time', minutes: -540 },
  { code: 'AKDT', name: 'Alaska Daylight Time', minutes: -480 },
  { code: 'HST', name: 'Hawaii Standard Time', minutes: -600 },
  { code: 'AST', name: 'Atlantic Standard Time', minutes: -240 },
  { code: 'ADT', name: 'Atlantic Daylight Time', minutes: -180 },
  { code: 'NST', name: 'Newfoundland Standard Time', minutes: -210 },
  { code: 'NDT', name: 'Newfoundland Daylight Time', minutes: -150 },
  // South America
  { code: 'BRT', name: 'Brasília Time', minutes: -180 },
  { code: 'ART', name: 'Argentina Time', minutes: -180 },
  // Europe & Africa
  { code: 'GMT', name: 'Greenwich Mean Time', minutes: 0 },
  { code: 'WET', name: 'Western European Time', minutes: 0 },
  { code: 'WEST', name: 'Western European Summer Time', minutes: 60 },
  { code: 'BST', name: 'British Summer Time', minutes: 60 },
  { code: 'IST-IE', name: 'Irish Standard Time', minutes: 60 },
  { code: 'CET', name: 'Central European Time', minutes: 60 },
  { code: 'CEST', name: 'Central European Summer Time', minutes: 120 },
  { code: 'EET', name: 'Eastern European Time', minutes: 120 },
  { code: 'EEST', name: 'Eastern European Summer Time', minutes: 180 },
  { code: 'MSK', name: 'Moscow Time', minutes: 180 },
  { code: 'WAT', name: 'West Africa Time', minutes: 60 },
  { code: 'CAT', name: 'Central Africa Time', minutes: 120 },
  { code: 'SAST', name: 'South Africa Standard Time', minutes: 120 },
  { code: 'EAT', name: 'East Africa Time', minutes: 180 },
  // Asia & Pacific
  { code: 'GST', name: 'Gulf Standard Time', minutes: 240 },
  { code: 'PKT', name: 'Pakistan Standard Time', minutes: 300 },
  { code: 'IST', name: 'India Standard Time', minutes: 330 },
  { code: 'NPT', name: 'Nepal Time', minutes: 345 },
  { code: 'BDT', name: 'Bangladesh Time', minutes: 360 },
  { code: 'ICT', name: 'Indochina Time', minutes: 420 },
  { code: 'WIB', name: 'Western Indonesia Time', minutes: 420 },
  { code: 'CST-CN', name: 'China Standard Time', minutes: 480 },
  { code: 'SGT', name: 'Singapore Time', minutes: 480 },
  { code: 'HKT', name: 'Hong Kong Time', minutes: 480 },
  { code: 'PHT', name: 'Philippine Time', minutes: 480 },
  { code: 'AWST', name: 'Australian Western Standard Time', minutes: 480 },
  { code: 'JST', name: 'Japan Standard Time', minutes: 540 },
  { code: 'KST', name: 'Korea Standard Time', minutes: 540 },
  { code: 'ACST', name: 'Australian Central Standard Time', minutes: 570 },
  { code: 'ACDT', name: 'Australian Central Daylight Time', minutes: 630 },
  { code: 'AEST', name: 'Australian Eastern Standard Time', minutes: 600 },
  { code: 'AEDT', name: 'Australian Eastern Daylight Time', minutes: 660 },
  { code: 'NZST', name: 'New Zealand Standard Time', minutes: 720 },
  { code: 'NZDT', name: 'New Zealand Daylight Time', minutes: 780 },
];

const ABBR_BY_CODE = new Map(ZONE_ABBREVIATIONS.map((a) => [a.code, a]));

/** Every real-world UTC offset in use, in minutes (−12:00 … +14:00). */
export const UTC_OFFSET_MINUTES: readonly number[] = [
  -720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -150, -120, -60, 0, 60, 120, 180,
  210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840,
];

function pad2(n: number): string {
  return String(Math.abs(n)).padStart(2, '0');
}

/** "+05:45" for 345, "-08:00" for -480. */
export function offsetString(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** The fixed-offset zone id for a number of minutes: "UTC+05:45". */
export function fixedZoneId(minutes: number): string {
  return `UTC${offsetString(minutes)}`;
}

/** Display form of an offset, with a real minus sign: "UTC−08:00". */
function offsetLabel(minutes: number): string {
  return `UTC${offsetString(minutes).replace('-', '−')}`;
}

/** What a zone id means, resolved for formatting. */
export interface ResolvedZone {
  readonly id: string;
  readonly kind: 'iana' | 'offset' | 'abbr';
  /** The time zone argument date-fns-tz understands: an IANA id or "+05:45". */
  readonly tz: string;
  /** Short display name: "Asia/Kathmandu", "UTC+05:45", "PDT". */
  readonly short: string;
  /** Longer description for lists: "Pacific Daylight Time · UTC−07:00". */
  readonly long: string;
  /** Fixed offset in minutes, when the zone has one. */
  readonly minutes?: number;
}

const FIXED_RE = /^UTC([+-])(\d{2}):(\d{2})$/;

function isIana(id: string): boolean {
  if (!id || id.startsWith('abbr:') || FIXED_RE.test(id)) return false;
  try {
    // Throws RangeError for an invalid zone.
    new Intl.DateTimeFormat('en-US', { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

const resolvedCache = new Map<string, ResolvedZone | null>();

/** Resolve any zone id, or null when it is not valid. */
export function resolveZone(id: string): ResolvedZone | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  const hit = resolvedCache.get(id);
  if (hit !== undefined) return hit;
  let out: ResolvedZone | null = null;
  const fixed = FIXED_RE.exec(id);
  if (fixed) {
    const h = Number(fixed[2]);
    const m = Number(fixed[3]);
    const minutes = (fixed[1] === '-' ? -1 : 1) * (h * 60 + m);
    if (m < 60 && minutes >= -720 && minutes <= 840) {
      out = { id, kind: 'offset', tz: offsetString(minutes), short: offsetLabel(minutes), long: offsetLabel(minutes), minutes };
    }
  } else if (id.startsWith('abbr:')) {
    const a = ABBR_BY_CODE.get(id.slice(5));
    if (a) {
      const code = a.code.replace(/-.*$/, '');
      if (a.iana && isIana(a.iana)) {
        out = { id, kind: 'abbr', tz: a.iana, short: code, long: `${a.name} · follows ${a.iana}` };
      } else if (a.minutes !== undefined) {
        out = {
          id,
          kind: 'abbr',
          tz: offsetString(a.minutes),
          short: code,
          long: `${a.name} · ${offsetLabel(a.minutes)}`,
          minutes: a.minutes,
        };
      }
    }
  } else if (isIana(id)) {
    out = { id, kind: 'iana', tz: id, short: id, long: id };
  }
  if (resolvedCache.size > 500) resolvedCache.clear();
  resolvedCache.set(id, out);
  return out;
}

/** True when the id is a valid zone of any kind. */
export function isValidZone(zone: string): boolean {
  return resolveZone(zone) !== null;
}

/** Short display name for a zone id (falls back to the id itself). */
export function zoneLabel(zone: string): string {
  return resolveZone(zone)?.short ?? zone;
}

/**
 * The canonical list of IANA timezone identifiers.
 * Uses the runtime's Intl.supportedValuesOf when available (all modern Chromium),
 * falling back to a curated list so tests and older engines still work.
 */
export function listTimeZones(): string[] {
  try {
    const anyIntl = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    if (typeof anyIntl.supportedValuesOf === 'function') {
      const zones = anyIntl.supportedValuesOf('timeZone');
      if (Array.isArray(zones) && zones.length > 0) {
        // Merge with curated zones so widely-used aliases that a given ICU build
        // spells differently (e.g. Asia/Kathmandu vs Asia/Katmandu) are always
        // present and selectable. Keep only ids valid on this runtime.
        const merged = new Set<string>(['UTC', ...zones]);
        for (const z of FALLBACK_ZONES) {
          if (isIana(z)) merged.add(z);
        }
        return Array.from(merged).sort();
      }
    }
  } catch {
    /* fall through to curated list */
  }
  return [...FALLBACK_ZONES];
}

/** A small curated fallback covering common zones + fractional offsets. */
export const FALLBACK_ZONES: readonly string[] = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Tehran',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Eucla',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Pacific/Chatham',
];

/** One selectable zone in a grouped list. */
export interface ZoneOption {
  readonly id: string;
  /** Primary text: "Asia/Kathmandu", "UTC+05:45", "PDT". */
  readonly label: string;
  /** Secondary text: current offset, full name. */
  readonly detail: string;
  /** Lower-cased text the search box matches against. */
  readonly haystack: string;
}

export interface ZoneGroup {
  readonly id: string;
  readonly label: string;
  readonly options: readonly ZoneOption[];
}

/** Current UTC offset of a zone, e.g. "+05:45" (for list details). */
function currentOffset(tz: string, at: number): string {
  try {
    return formatInTimeZone(new Date(at), tz, 'xxx');
  } catch {
    return '';
  }
}

let groupCache: { at: number; groups: ZoneGroup[] } | null = null;

/**
 * Every selectable zone, grouped: UTC offsets, abbreviations, then IANA zones
 * by region. Cached for a minute (offsets in details depend on "now").
 */
export function zoneGroups(now: number = Date.now()): readonly ZoneGroup[] {
  if (groupCache && now - groupCache.at < 60_000) return groupCache.groups;
  const offsets: ZoneOption[] = UTC_OFFSET_MINUTES.map((m) => {
    const id = m === 0 ? 'UTC' : fixedZoneId(m);
    const label = m === 0 ? 'UTC' : offsetLabel(m);
    const plain = offsetString(m);
    const short = plain.replace(/:00$/, '').replace(/^([+-])0/, '$1');
    return {
      id,
      label,
      detail: m === 0 ? 'Coordinated Universal Time' : 'Fixed offset, no daylight saving',
      haystack: `utc gmt ${label.toLowerCase()} ${id.toLowerCase()} utc${plain} gmt${plain} utc${short} gmt${short} ${plain} ${short}`,
    };
  });
  const abbrs: ZoneOption[] = ZONE_ABBREVIATIONS.map((a) => {
    const id = `abbr:${a.code}`;
    const r = resolveZone(id);
    const code = a.code.replace(/-.*$/, '');
    const off = r ? currentOffset(r.tz, now) : '';
    return {
      id,
      label: code,
      detail: a.iana ? `${a.name} · now UTC${off}` : `${a.name} · UTC${off}`,
      haystack: `${code} ${a.name} utc${off} ${a.iana ?? ''}`.toLowerCase(),
    };
  });
  const regions = new Map<string, ZoneOption[]>();
  for (const z of listTimeZones()) {
    if (z === 'UTC') continue;
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'Other';
    const city = z.slice(z.lastIndexOf('/') + 1).replace(/_/g, ' ');
    const off = currentOffset(z, now);
    const list = regions.get(region) ?? [];
    list.push({ id: z, label: z, detail: `UTC${off}`, haystack: `${z} ${city} utc${off}`.toLowerCase() });
    regions.set(region, list);
  }
  const groups: ZoneGroup[] = [
    { id: 'offsets', label: 'UTC offsets', options: offsets },
    { id: 'abbr', label: 'Abbreviations', options: abbrs },
    ...Array.from(regions.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, options]) => ({ id: region, label: region.replace(/_/g, ' '), options })),
  ];
  groupCache = { at: now, groups };
  return groups;
}

/**
 * Search the grouped zone list. Empty query returns `suggested` first, then
 * offsets and abbreviations. Matches every word of the query, ranks prefix
 * hits first, and caps each group so the list stays fast.
 */
export function searchZones(
  query: string,
  opts: { readonly exclude?: readonly string[]; readonly suggested?: readonly string[]; readonly perGroup?: number } = {},
): readonly ZoneGroup[] {
  const exclude = new Set(opts.exclude ?? []);
  const perGroup = opts.perGroup ?? 50;
  const q = query.trim().toLowerCase().replace(/−/g, '-');
  const words = q.split(/\s+/).filter(Boolean);
  const all = zoneGroups();
  const out: ZoneGroup[] = [];
  if (words.length === 0) {
    const suggested = (opts.suggested ?? [])
      .filter((id) => !exclude.has(id) && isValidZone(id))
      .map((id): ZoneOption => {
        const r = resolveZone(id);
        return { id, label: r?.short ?? id, detail: r?.long !== r?.short ? r?.long ?? '' : '', haystack: id.toLowerCase() };
      });
    if (suggested.length) out.push({ id: 'suggested', label: 'Suggested', options: suggested });
  }
  for (const g of all) {
    let opts2 = g.options.filter((o) => !exclude.has(o.id) && words.every((w) => o.haystack.includes(w)));
    if (words.length > 0) {
      const first = words[0] as string;
      const score = (o: ZoneOption): number =>
        o.label.toLowerCase() === first ? 0 : o.label.toLowerCase().startsWith(first) ? 1 : o.haystack.includes(` ${first}`) ? 2 : 3;
      opts2 = [...opts2].sort((a, b) => score(a) - score(b));
    } else if (g.id !== 'offsets' && g.id !== 'abbr') {
      continue; // empty query: keep the list short
    }
    if (opts2.length) out.push({ ...g, options: opts2.slice(0, perGroup) });
  }
  return out;
}

/**
 * The engine's canonical id for a zone, so aliases compare equal
 * ("Asia/Katmandu" and "Asia/Kathmandu", "Asia/Calcutta" and "Asia/Kolkata").
 */
export function canonicalZone(zone: string): string {
  const r = resolveZone(zone);
  if (!r || r.kind !== 'iana') return zone;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/** True when two zone ids name the same zone (including aliases). */
export function sameZone(a: string, b: string): boolean {
  return a === b || canonicalZone(a) === canonicalZone(b);
}

export interface ZoneView {
  readonly zone: string;
  /** Short display name of the zone ("Asia/Kathmandu", "UTC+05:45", "PDT"). */
  readonly label: string;
  /** Formatted wall-clock date+time in the zone. */
  readonly dateTime: string;
  /** Just the time. */
  readonly time: string;
  /** Just the date. */
  readonly date: string;
  /** The UTC offset label, e.g. "+05:45" or "-07:00". */
  readonly offset: string;
  /** The zone's short abbreviation at that instant, e.g. "PDT", "+0545". */
  readonly abbrev: string;
  /** Day-of-week short label. */
  readonly weekday: string;
}

function tzOf(zone: string): string {
  return resolveZone(zone)?.tz ?? zone;
}

/** Format one instant (epoch ms) for display in one zone. */
export function viewInZone(epochMs: number, zone: string, hour12: boolean): ZoneView {
  const date = new Date(epochMs);
  const timePattern = hour12 ? 'h:mm:ss a' : 'HH:mm:ss';
  const r = resolveZone(zone);
  const tz = r?.tz ?? zone;
  return {
    zone,
    label: r?.short ?? zone,
    dateTime: formatInTimeZone(date, tz, `yyyy-MM-dd ${timePattern}`),
    time: formatInTimeZone(date, tz, timePattern),
    date: formatInTimeZone(date, tz, 'yyyy-MM-dd'),
    offset: formatInTimeZone(date, tz, 'xxx'),
    abbrev: r && r.kind !== 'iana' ? r.short : formatInTimeZone(date, tz, 'zzz'),
    weekday: formatInTimeZone(date, tz, 'EEE'),
  };
}

/** Minutes east of UTC for a zone at an instant. */
export function offsetMinutesAt(epochMs: number, zone: string): number {
  const r = resolveZone(zone);
  if (r?.minutes !== undefined) return r.minutes;
  const off = formatInTimeZone(new Date(epochMs), tzOf(zone), 'xxx');
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Given wall-clock components as interpreted in `zone`, return the absolute
 * instant (epoch ms). DST-correct via date-fns-tz.
 */
export function wallClockToEpochMs(isoLocal: string, zone: string): number {
  // isoLocal is a zone-less ISO string like "2024-01-02T15:04:05".
  const utc = fromZonedTime(isoLocal, tzOf(zone));
  return utc.getTime();
}

/** Convert an absolute instant to the wall-clock Date in a zone (for pickers). */
export function epochMsToWallClock(epochMs: number, zone: string): Date {
  return toZonedTime(new Date(epochMs), tzOf(zone));
}

/** ISO-8601 UTC string for an instant. */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
