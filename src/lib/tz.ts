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

/**
 * Display label of an abbreviation code. Codes that share letters with a
 * better-known zone carry a region suffix ("IST-IE", "CST-CN") and show it:
 * "IST (IE)", so Irish time never reads like India's "IST".
 */
function abbrLabel(code: string): string {
  const m = /^([A-Z]+)-([A-Z]+)$/.exec(code);
  return m ? `${m[1]} (${m[2]})` : code;
}

/**
 * Legacy IANA names that the tz database keeps only as links, mapped to the
 * current name. Engines built on CLDR (Chrome, Node) still list and resolve
 * the left-hand names, so the lists and labels translate them here. Other
 * links ("Asia/Dacca") already resolve to the current name through Intl.
 */
const LEGACY_ZONES: ReadonlyMap<string, string> = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['America/Montreal', 'America/Toronto'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

/** Current name for a legacy id, when this engine knows the current name. */
function modernIana(id: string): string {
  const m = LEGACY_ZONES.get(id);
  return m !== undefined && isIana(m) ? m : id;
}

/**
 * Bound for the per-id caches. Above every id the lists offer (about 520),
 * so a search never clears them, but still bounded against hostile ids.
 */
const CACHE_CAP = 2000;

const canonicalCache = new Map<string, string>();

/** Current canonical name of a valid IANA id ("Asia/Calcutta" → "Asia/Kolkata"). */
function canonicalIana(id: string): string {
  const hit = canonicalCache.get(id);
  if (hit !== undefined) return hit;
  let name = id;
  try {
    name = new Intl.DateTimeFormat('en-US', { timeZone: id }).resolvedOptions().timeZone;
  } catch {
    /* keep the id */
  }
  name = modernIana(name);
  if (!isIana(name)) name = id;
  if (canonicalCache.size > CACHE_CAP) canonicalCache.clear();
  canonicalCache.set(id, name);
  return name;
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
      const code = abbrLabel(a.code);
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
    // A legacy alias ("Asia/Calcutta") stays a valid id but displays under
    // its current name ("Asia/Kolkata").
    const name = canonicalIana(id);
    out = { id, kind: 'iana', tz: id, short: name, long: name };
  }
  if (resolvedCache.size > CACHE_CAP) resolvedCache.clear();
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
        // ICU lists some zones under legacy names (Asia/Katmandu, Asia/Calcutta);
        // list each under its current name only. Merge with the curated zones
        // and keep only ids valid on this runtime.
        const merged = new Set<string>(['UTC', ...zones.map(modernIana)]);
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
  /** Lower-cased, accent-free text the search box matches against. */
  readonly haystack: string;
  /**
   * Search results only: the city, country, abbreviation or legacy name the
   * query matched, when label and detail don't show it ("Mumbai" on
   * Asia/Kolkata).
   */
  readonly matched?: string;
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

/** "+05:45" → 345; null for anything else. */
function parseOffset(off: string): number | null {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Search form of any text: lower case, accents removed, every dash or minus
 * sign (U+2212, en dash…) as "-", single spaces.
 */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of normalized text, split at spaces, "/", "_", brackets and "·"; hyphenated words also by part. */
function splitWords(s: string): string[] {
  const out: string[] = [];
  for (const w of s.split(/[\s/_(),·]+/)) {
    if (!w) continue;
    out.push(w);
    if (w.includes('-') && !/^[+-]/.test(w)) for (const p of w.split('-')) if (p) out.push(p);
  }
  return out;
}

/**
 * Places people search by, mapped to the IANA zone they use. Zone cities
 * ("Tokyo" for Asia/Tokyo) and legacy names match on their own; these cover
 * other cities, countries with a single zone, and year-round abbreviations.
 * Diacritics are optional when searching ("Sao Paulo", "Bogota").
 */
const PLACE_ALIASES: readonly (readonly [string, string])[] = [
  // South Asia
  ['Mumbai', 'Asia/Kolkata'],
  ['Bombay', 'Asia/Kolkata'],
  ['Delhi', 'Asia/Kolkata'],
  ['New Delhi', 'Asia/Kolkata'],
  ['Bangalore', 'Asia/Kolkata'],
  ['Bengaluru', 'Asia/Kolkata'],
  ['Chennai', 'Asia/Kolkata'],
  ['Hyderabad', 'Asia/Kolkata'],
  ['Pune', 'Asia/Kolkata'],
  ['Ahmedabad', 'Asia/Kolkata'],
  ['Kolkata', 'Asia/Kolkata'],
  ['India', 'Asia/Kolkata'],
  ['Karachi', 'Asia/Karachi'],
  ['Lahore', 'Asia/Karachi'],
  ['Islamabad', 'Asia/Karachi'],
  ['Pakistan', 'Asia/Karachi'],
  ['Dhaka', 'Asia/Dhaka'],
  ['Bangladesh', 'Asia/Dhaka'],
  ['Kathmandu', 'Asia/Kathmandu'],
  ['Pokhara', 'Asia/Kathmandu'],
  ['Nepal', 'Asia/Kathmandu'],
  ['Colombo', 'Asia/Colombo'],
  ['Sri Lanka', 'Asia/Colombo'],
  ['Bhutan', 'Asia/Thimphu'],
  ['Maldives', 'Indian/Maldives'],
  ['Kabul', 'Asia/Kabul'],
  ['Afghanistan', 'Asia/Kabul'],
  // East & Southeast Asia
  ['Beijing', 'Asia/Shanghai'],
  ['Shenzhen', 'Asia/Shanghai'],
  ['Guangzhou', 'Asia/Shanghai'],
  ['Chengdu', 'Asia/Shanghai'],
  ['Hangzhou', 'Asia/Shanghai'],
  ['China', 'Asia/Shanghai'],
  ['Hong Kong', 'Asia/Hong_Kong'],
  ['Taipei', 'Asia/Taipei'],
  ['Taiwan', 'Asia/Taipei'],
  ['Tokyo', 'Asia/Tokyo'],
  ['Osaka', 'Asia/Tokyo'],
  ['Kyoto', 'Asia/Tokyo'],
  ['Japan', 'Asia/Tokyo'],
  ['Seoul', 'Asia/Seoul'],
  ['Busan', 'Asia/Seoul'],
  ['Korea', 'Asia/Seoul'],
  ['South Korea', 'Asia/Seoul'],
  ['Singapore', 'Asia/Singapore'],
  ['Kuala Lumpur', 'Asia/Kuala_Lumpur'],
  ['Malaysia', 'Asia/Kuala_Lumpur'],
  ['Jakarta', 'Asia/Jakarta'],
  ['Bali', 'Asia/Makassar'],
  ['Denpasar', 'Asia/Makassar'],
  ['Manila', 'Asia/Manila'],
  ['Philippines', 'Asia/Manila'],
  ['Bangkok', 'Asia/Bangkok'],
  ['Thailand', 'Asia/Bangkok'],
  ['Hanoi', 'Asia/Ho_Chi_Minh'],
  ['Ho Chi Minh City', 'Asia/Ho_Chi_Minh'],
  ['Saigon', 'Asia/Ho_Chi_Minh'],
  ['Vietnam', 'Asia/Ho_Chi_Minh'],
  ['Yangon', 'Asia/Yangon'],
  ['Myanmar', 'Asia/Yangon'],
  ['Phnom Penh', 'Asia/Phnom_Penh'],
  ['Ulaanbaatar', 'Asia/Ulaanbaatar'],
  // Central & West Asia
  ['Tashkent', 'Asia/Tashkent'],
  ['Almaty', 'Asia/Almaty'],
  ['Dubai', 'Asia/Dubai'],
  ['Abu Dhabi', 'Asia/Dubai'],
  ['United Arab Emirates', 'Asia/Dubai'],
  ['UAE', 'Asia/Dubai'],
  ['Doha', 'Asia/Qatar'],
  ['Qatar', 'Asia/Qatar'],
  ['Riyadh', 'Asia/Riyadh'],
  ['Jeddah', 'Asia/Riyadh'],
  ['Saudi Arabia', 'Asia/Riyadh'],
  ['Tehran', 'Asia/Tehran'],
  ['Iran', 'Asia/Tehran'],
  ['Tel Aviv', 'Asia/Jerusalem'],
  ['Jerusalem', 'Asia/Jerusalem'],
  ['Israel', 'Asia/Jerusalem'],
  ['Baku', 'Asia/Baku'],
  ['Tbilisi', 'Asia/Tbilisi'],
  ['Yerevan', 'Asia/Yerevan'],
  // Europe
  ['London', 'Europe/London'],
  ['Manchester', 'Europe/London'],
  ['Edinburgh', 'Europe/London'],
  ['United Kingdom', 'Europe/London'],
  ['UK', 'Europe/London'],
  ['England', 'Europe/London'],
  ['Dublin', 'Europe/Dublin'],
  ['Ireland', 'Europe/Dublin'],
  ['Lisbon', 'Europe/Lisbon'],
  ['Porto', 'Europe/Lisbon'],
  ['Portugal', 'Europe/Lisbon'],
  ['Reykjavik', 'Atlantic/Reykjavik'],
  ['Iceland', 'Atlantic/Reykjavik'],
  ['Paris', 'Europe/Paris'],
  ['Lyon', 'Europe/Paris'],
  ['France', 'Europe/Paris'],
  ['Berlin', 'Europe/Berlin'],
  ['Munich', 'Europe/Berlin'],
  ['Frankfurt', 'Europe/Berlin'],
  ['Hamburg', 'Europe/Berlin'],
  ['Germany', 'Europe/Berlin'],
  ['Madrid', 'Europe/Madrid'],
  ['Barcelona', 'Europe/Madrid'],
  ['Valencia', 'Europe/Madrid'],
  ['Spain', 'Europe/Madrid'],
  ['Rome', 'Europe/Rome'],
  ['Milan', 'Europe/Rome'],
  ['Naples', 'Europe/Rome'],
  ['Florence', 'Europe/Rome'],
  ['Venice', 'Europe/Rome'],
  ['Italy', 'Europe/Rome'],
  ['Amsterdam', 'Europe/Amsterdam'],
  ['Rotterdam', 'Europe/Amsterdam'],
  ['Netherlands', 'Europe/Amsterdam'],
  ['Brussels', 'Europe/Brussels'],
  ['Belgium', 'Europe/Brussels'],
  ['Zurich', 'Europe/Zurich'],
  ['Geneva', 'Europe/Zurich'],
  ['Switzerland', 'Europe/Zurich'],
  ['Vienna', 'Europe/Vienna'],
  ['Austria', 'Europe/Vienna'],
  ['Prague', 'Europe/Prague'],
  ['Warsaw', 'Europe/Warsaw'],
  ['Poland', 'Europe/Warsaw'],
  ['Budapest', 'Europe/Budapest'],
  ['Copenhagen', 'Europe/Copenhagen'],
  ['Denmark', 'Europe/Copenhagen'],
  ['Stockholm', 'Europe/Stockholm'],
  ['Sweden', 'Europe/Stockholm'],
  ['Oslo', 'Europe/Oslo'],
  ['Norway', 'Europe/Oslo'],
  ['Helsinki', 'Europe/Helsinki'],
  ['Finland', 'Europe/Helsinki'],
  ['Athens', 'Europe/Athens'],
  ['Greece', 'Europe/Athens'],
  ['Bucharest', 'Europe/Bucharest'],
  ['Romania', 'Europe/Bucharest'],
  ['Kyiv', 'Europe/Kyiv'],
  ['Ukraine', 'Europe/Kyiv'],
  ['Istanbul', 'Europe/Istanbul'],
  ['Turkey', 'Europe/Istanbul'],
  ['Moscow', 'Europe/Moscow'],
  ['Saint Petersburg', 'Europe/Moscow'],
  ['St Petersburg', 'Europe/Moscow'],
  // Africa
  ['Cairo', 'Africa/Cairo'],
  ['Egypt', 'Africa/Cairo'],
  ['Lagos', 'Africa/Lagos'],
  ['Abuja', 'Africa/Lagos'],
  ['Nigeria', 'Africa/Lagos'],
  ['Accra', 'Africa/Accra'],
  ['Ghana', 'Africa/Accra'],
  ['Nairobi', 'Africa/Nairobi'],
  ['Kenya', 'Africa/Nairobi'],
  ['Addis Ababa', 'Africa/Addis_Ababa'],
  ['Ethiopia', 'Africa/Addis_Ababa'],
  ['Johannesburg', 'Africa/Johannesburg'],
  ['Cape Town', 'Africa/Johannesburg'],
  ['Pretoria', 'Africa/Johannesburg'],
  ['South Africa', 'Africa/Johannesburg'],
  ['Casablanca', 'Africa/Casablanca'],
  ['Morocco', 'Africa/Casablanca'],
  // Americas
  ['New York', 'America/New_York'],
  ['NYC', 'America/New_York'],
  ['Boston', 'America/New_York'],
  ['Washington', 'America/New_York'],
  ['Washington DC', 'America/New_York'],
  ['Philadelphia', 'America/New_York'],
  ['Miami', 'America/New_York'],
  ['Atlanta', 'America/New_York'],
  ['Orlando', 'America/New_York'],
  ['Charlotte', 'America/New_York'],
  ['Pittsburgh', 'America/New_York'],
  ['Detroit', 'America/Detroit'],
  ['Toronto', 'America/Toronto'],
  ['Ottawa', 'America/Toronto'],
  ['Montreal', 'America/Toronto'],
  ['Chicago', 'America/Chicago'],
  ['Dallas', 'America/Chicago'],
  ['Houston', 'America/Chicago'],
  ['Austin', 'America/Chicago'],
  ['San Antonio', 'America/Chicago'],
  ['Minneapolis', 'America/Chicago'],
  ['Nashville', 'America/Chicago'],
  ['New Orleans', 'America/Chicago'],
  ['St Louis', 'America/Chicago'],
  ['Kansas City', 'America/Chicago'],
  ['Winnipeg', 'America/Winnipeg'],
  ['Denver', 'America/Denver'],
  ['Salt Lake City', 'America/Denver'],
  ['Calgary', 'America/Edmonton'],
  ['Phoenix', 'America/Phoenix'],
  ['Arizona', 'America/Phoenix'],
  ['Los Angeles', 'America/Los_Angeles'],
  ['LA', 'America/Los_Angeles'],
  ['San Francisco', 'America/Los_Angeles'],
  ['SF', 'America/Los_Angeles'],
  ['San Jose', 'America/Los_Angeles'],
  ['San Diego', 'America/Los_Angeles'],
  ['Silicon Valley', 'America/Los_Angeles'],
  ['Seattle', 'America/Los_Angeles'],
  ['Portland', 'America/Los_Angeles'],
  ['Las Vegas', 'America/Los_Angeles'],
  ['Vancouver', 'America/Vancouver'],
  ['Anchorage', 'America/Anchorage'],
  ['Alaska', 'America/Anchorage'],
  ['Honolulu', 'Pacific/Honolulu'],
  ['Hawaii', 'Pacific/Honolulu'],
  ['Halifax', 'America/Halifax'],
  ["St John's", 'America/St_Johns'],
  ['Mexico City', 'America/Mexico_City'],
  ['Guadalajara', 'America/Mexico_City'],
  ['Monterrey', 'America/Monterrey'],
  ['Mexico', 'America/Mexico_City'],
  ['Bogotá', 'America/Bogota'],
  ['Colombia', 'America/Bogota'],
  ['Lima', 'America/Lima'],
  ['Peru', 'America/Lima'],
  ['Santiago', 'America/Santiago'],
  ['Chile', 'America/Santiago'],
  ['Caracas', 'America/Caracas'],
  ['Venezuela', 'America/Caracas'],
  ['Buenos Aires', 'America/Argentina/Buenos_Aires'],
  ['Argentina', 'America/Argentina/Buenos_Aires'],
  ['São Paulo', 'America/Sao_Paulo'],
  ['Rio', 'America/Sao_Paulo'],
  ['Rio de Janeiro', 'America/Sao_Paulo'],
  ['Brasília', 'America/Sao_Paulo'],
  ['Brazil', 'America/Sao_Paulo'],
  ['Montevideo', 'America/Montevideo'],
  ['Uruguay', 'America/Montevideo'],
  ['Havana', 'America/Havana'],
  ['Cuba', 'America/Havana'],
  ['Panama', 'America/Panama'],
  ['Puerto Rico', 'America/Puerto_Rico'],
  // Oceania
  ['Sydney', 'Australia/Sydney'],
  ['Canberra', 'Australia/Sydney'],
  ['Melbourne', 'Australia/Melbourne'],
  ['Brisbane', 'Australia/Brisbane'],
  ['Gold Coast', 'Australia/Brisbane'],
  ['Perth', 'Australia/Perth'],
  ['Adelaide', 'Australia/Adelaide'],
  ['Darwin', 'Australia/Darwin'],
  ['Hobart', 'Australia/Hobart'],
  ['Tasmania', 'Australia/Hobart'],
  ['Auckland', 'Pacific/Auckland'],
  ['Wellington', 'Pacific/Auckland'],
  ['New Zealand', 'Pacific/Auckland'],
  ['Fiji', 'Pacific/Fiji'],
];

/**
 * Year-round abbreviations and the place that keeps them, so "IST" also
 * finds Asia/Kolkata and "JST" Asia/Tokyo. Also used to pick a real place as
 * the IANA equivalent of a fixed abbreviation (see ianaEquivalent).
 */
const ABBR_PLACES: ReadonlyMap<string, string> = new Map([
  ['IST', 'Asia/Kolkata'],
  ['IST-IE', 'Europe/Dublin'],
  ['NPT', 'Asia/Kathmandu'],
  ['PKT', 'Asia/Karachi'],
  ['BDT', 'Asia/Dhaka'],
  ['ICT', 'Asia/Bangkok'],
  ['WIB', 'Asia/Jakarta'],
  ['CST-CN', 'Asia/Shanghai'],
  ['SGT', 'Asia/Singapore'],
  ['HKT', 'Asia/Hong_Kong'],
  ['PHT', 'Asia/Manila'],
  ['AWST', 'Australia/Perth'],
  ['JST', 'Asia/Tokyo'],
  ['KST', 'Asia/Seoul'],
  ['ACST', 'Australia/Darwin'],
  ['AEST', 'Australia/Brisbane'],
  ['GST', 'Asia/Dubai'],
  ['MSK', 'Europe/Moscow'],
  ['EAT', 'Africa/Nairobi'],
  ['SAST', 'Africa/Johannesburg'],
  ['CAT', 'Africa/Maputo'],
  ['WAT', 'Africa/Lagos'],
  ['BRT', 'America/Sao_Paulo'],
  ['ART', 'America/Argentina/Buenos_Aires'],
  ['HST', 'Pacific/Honolulu'],
  ['MST', 'America/Phoenix'],
]);

/** A name an option can be found by exactly ("mumbai" → shown as "Mumbai"). */
interface SearchName {
  readonly key: string;
  readonly display: string;
}

/** Precomputed search data for one option. */
interface SearchEntry {
  readonly kind: 'offset' | 'abbr' | 'iana';
  /** Exact abbreviation / zone label keys (rank 0). */
  readonly exact: readonly string[];
  /** Exact city, alias, country or legacy names (rank 1). */
  readonly names: readonly SearchName[];
  readonly words: readonly string[];
  readonly text: string;
  /** Normalized words of what the option shows (label and detail). */
  readonly visibleWords: readonly string[];
  readonly visible: string;
  /** Offset in minutes now, when known. */
  readonly minutes: number | null;
  /** Typed forms of a fixed offset ("+05:45", "+5:45", "+0545", "+545"). */
  readonly forms: readonly string[];
}

const searchEntries = new WeakMap<ZoneOption, SearchEntry>();

let namesByZone: Map<string, SearchName[]> | null = null;

/** Search names for every IANA zone: aliases, abbreviations, legacy names. */
function zoneNames(): Map<string, SearchName[]> {
  if (namesByZone) return namesByZone;
  const map = new Map<string, SearchName[]>();
  const add = (zone: string, display: string): void => {
    const z = modernIana(zone);
    const list = map.get(z) ?? [];
    const key = normalizeSearch(display.replace(/_/g, ' '));
    if (!list.some((n) => n.key === key)) list.push({ key, display });
    map.set(z, list);
  };
  for (const [place, zone] of PLACE_ALIASES) add(zone, place);
  for (const [code, zone] of ABBR_PLACES) add(zone, abbrLabel(code));
  for (const [legacy, zone] of LEGACY_ZONES) {
    add(zone, legacy);
    add(zone, legacy.slice(legacy.lastIndexOf('/') + 1).replace(/_/g, ' '));
  }
  namesByZone = map;
  return map;
}

function makeOption(
  base: { readonly id: string; readonly label: string; readonly detail: string },
  spec: {
    readonly kind: SearchEntry['kind'];
    readonly exact?: readonly string[];
    readonly names?: readonly SearchName[];
    readonly extra?: readonly string[];
    readonly minutes: number | null;
    readonly forms?: readonly string[];
  },
): ZoneOption {
  const names = spec.names ?? [];
  const visible = normalizeSearch(`${base.label} ${base.detail}`);
  const text = normalizeSearch([base.label, base.detail, ...(spec.extra ?? []), ...names.map((n) => n.display)].join(' '));
  const option: ZoneOption = { ...base, haystack: text };
  searchEntries.set(option, {
    kind: spec.kind,
    exact: (spec.exact ?? []).map(normalizeSearch),
    names,
    words: Array.from(new Set(splitWords(text))),
    text,
    visibleWords: splitWords(visible),
    visible,
    minutes: spec.minutes,
    forms: spec.forms ?? [],
  });
  return option;
}

let groupCache: { minute: number; groups: ZoneGroup[] } | null = null;

/**
 * Every selectable zone, grouped: UTC offsets, abbreviations, then IANA zones
 * by region. Details show offsets at `now`, so the result is cached per
 * minute of `now` (any other minute, earlier or later, rebuilds).
 */
export function zoneGroups(now: number = Date.now()): readonly ZoneGroup[] {
  const minute = Math.floor(now / 60_000);
  if (groupCache && groupCache.minute === minute) return groupCache.groups;
  const offsets: ZoneOption[] = UTC_OFFSET_MINUTES.map((m) => {
    const id = m === 0 ? 'UTC' : fixedZoneId(m);
    const label = m === 0 ? 'UTC' : offsetLabel(m);
    const plain = offsetString(m);
    const short = plain.replace(/:00$/, '').replace(/^([+-])0/, '$1');
    const forms = [plain, short, plain.replace(':', ''), short.replace(':', '')];
    if (m === 0) forms.push('-00:00', '-0');
    return makeOption(
      { id, label, detail: m === 0 ? 'Coordinated Universal Time' : 'Fixed offset, no daylight saving' },
      {
        kind: 'offset',
        exact: [label, id],
        extra: ['utc gmt', `utc${plain}`, `gmt${plain}`, `utc${short}`, `gmt${short}`, plain, short],
        minutes: m,
        forms,
      },
    );
  });
  const abbrs: ZoneOption[] = ZONE_ABBREVIATIONS.map((a) => {
    const id = `abbr:${a.code}`;
    const r = resolveZone(id);
    const label = r?.short ?? abbrLabel(a.code);
    const off = r ? currentOffset(r.tz, now) : '';
    const city = a.iana ? a.iana.slice(a.iana.lastIndexOf('/') + 1).replace(/_/g, ' ') : '';
    return makeOption(
      { id, label, detail: a.iana ? `${a.name} · now UTC${off}` : `${a.name} · UTC${off}` },
      {
        kind: 'abbr',
        exact: [a.code, label],
        extra: [`utc${off}`, a.iana ?? '', city],
        minutes: a.minutes ?? parseOffset(off),
      },
    );
  });
  const names = zoneNames();
  const regions = new Map<string, ZoneOption[]>();
  for (const z of listTimeZones()) {
    if (z === 'UTC') continue;
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'Other';
    const city = z.slice(z.lastIndexOf('/') + 1).replace(/_/g, ' ');
    const off = currentOffset(z, now);
    const own: SearchName[] = [
      { key: normalizeSearch(city), display: city },
      { key: normalizeSearch(z.replace(/_/g, ' ')), display: z },
    ];
    for (const n of names.get(z) ?? []) if (!own.some((o) => o.key === n.key)) own.push(n);
    const list = regions.get(region) ?? [];
    list.push(makeOption({ id: z, label: z, detail: `UTC${off}` }, { kind: 'iana', names: own, extra: [`utc${off}`], minutes: parseOffset(off) }));
    regions.set(region, list);
  }
  const groups: ZoneGroup[] = [
    { id: 'offsets', label: 'UTC offsets', options: offsets },
    { id: 'abbr', label: 'Abbreviations', options: abbrs },
    ...Array.from(regions.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, options]) => ({ id: region, label: region.replace(/_/g, ' '), options })),
  ];
  groupCache = { minute, groups };
  return groups;
}

/** A query that is only an offset: "+545", "+0545", "545", "+5:45", "-8", "utc−8", "gmt+1". */
const OFFSET_QUERY_RE = /^(?:(?:utc|gmt) ?)?([+-])? ?(\d{1,2}:\d{2}|\d{1,4})$/;

function parseOffsetQuery(q: string): { readonly minutes: number; readonly typed: string } | null {
  const m = OFFSET_QUERY_RE.exec(q);
  if (!m) return null;
  const body = m[2] as string;
  let h: number;
  let min: number;
  if (body.includes(':')) {
    [h, min] = body.split(':').map(Number) as [number, number];
  } else if (body.length <= 2) {
    h = Number(body);
    min = 0;
  } else if (body.length === 3) {
    h = Number(body.slice(0, 1));
    min = Number(body.slice(1));
  } else {
    h = Number(body.slice(0, 2));
    min = Number(body.slice(2));
  }
  if (min >= 60) return null;
  const minutes = (m[1] === '-' ? -1 : 1) * (h * 60 + min);
  if (minutes < -720 || minutes > 840) return null;
  return { minutes: minutes || 0, typed: `${m[1] ?? '+'}${body}` };
}

/** How well an option matches. Lower is better; `matched` explains a hidden hit. */
interface SearchHit {
  readonly score: number;
  readonly matched?: string;
}

/** True when the option's visible text already shows this name. */
function showsName(e: SearchEntry, key: string): boolean {
  return ` ${e.visibleWords.join(' ')} `.includes(` ${splitWords(key).join(' ')} `);
}

/**
 * Rank: 0 exact abbreviation or zone label, 1 exact city / alias / country /
 * legacy name, 2 every word starts a word, 3 every word appears inside a word.
 */
function textHit(e: SearchEntry, q: string, words: readonly string[]): SearchHit | null {
  if (e.exact.includes(q)) return { score: 0 };
  const name = e.names.find((n) => n.key === q);
  if (name) return { score: 1, matched: showsName(e, name.key) ? undefined : name.display };
  const prefix = (w: string) => (x: string) => x.startsWith(w);
  if (words.every((w) => e.words.some(prefix(w)))) {
    if (words.every((w) => e.visibleWords.some(prefix(w)))) return { score: 2 };
    const n = e.names.find((nm) => {
      const nw = splitWords(nm.key);
      return words.every((w) => nw.some(prefix(w)));
    });
    return { score: 2, matched: n?.display };
  }
  if (words.every((w) => e.text.includes(w))) {
    if (words.every((w) => e.visible.includes(w))) return { score: 3 };
    return { score: 3, matched: e.names.find((nm) => words.every((w) => nm.key.includes(w)))?.display };
  }
  return null;
}

/** Offset queries: the fixed offset first, then abbreviations and places at that offset now. */
function offsetHit(e: SearchEntry, minutes: number, typed: string): SearchHit | null {
  if (e.minutes === minutes) return { score: e.kind === 'offset' ? 0 : e.kind === 'abbr' ? 1 : 2 };
  // While typing ("+1" on the way to "+10"), longer offsets follow the exact one.
  if (e.kind === 'offset' && e.forms.some((f) => f.startsWith(typed))) return { score: 3 };
  return null;
}

interface RankedGroup {
  readonly group: ZoneGroup;
  readonly order: number;
  readonly best: number;
  readonly hits: readonly { readonly option: ZoneOption; readonly score: number }[];
}

/** Rank every option that passes `keep` against a normalized, non-empty query. */
function rankGroups(q: string, keep: (id: string) => boolean): RankedGroup[] {
  const offset = parseOffsetQuery(q);
  const words = q.split(' ').filter(Boolean);
  const out: RankedGroup[] = [];
  zoneGroups().forEach((group, order) => {
    const hits: { option: ZoneOption; score: number; i: number }[] = [];
    group.options.forEach((o, i) => {
      if (!keep(o.id)) return;
      const e = searchEntries.get(o);
      if (!e) return;
      const hit = offset ? offsetHit(e, offset.minutes, offset.typed) : textHit(e, q, words);
      if (!hit) return;
      hits.push({ option: hit.matched ? { ...o, matched: hit.matched } : o, score: hit.score, i });
    });
    if (hits.length === 0) return;
    hits.sort((a, b) => a.score - b.score || a.i - b.i);
    out.push({ group, order, best: hits[0]?.score ?? 3, hits });
  });
  // The group holding the best match comes first; ties keep the usual order.
  return out.sort((a, b) => a.best - b.best || a.order - b.order);
}

/** Membership test for zone ids that treats aliases as the same zone. */
function zoneSet(ids: readonly string[] | undefined): (id: string) => boolean {
  if (!ids || ids.length === 0) return () => false;
  const set = new Set(ids.map(canonicalZone));
  return (id) => set.has(id) || set.has(canonicalZone(id));
}

/**
 * Search the grouped zone list. Empty query returns `suggested` first, then
 * offsets and abbreviations. Otherwise matches cities, countries,
 * abbreviations, legacy names and offsets ("+545", "utc−8"), case- and
 * accent-insensitively, ranked: exact abbreviation, exact city or alias,
 * word prefix, then substring. The group with the best hit comes first, and
 * each group is capped so the list stays fast. Options found through a name
 * they don't show carry it in `matched`.
 */
export function searchZones(
  query: string,
  opts: { readonly exclude?: readonly string[]; readonly suggested?: readonly string[]; readonly perGroup?: number } = {},
): readonly ZoneGroup[] {
  const excluded = zoneSet(opts.exclude);
  const perGroup = opts.perGroup ?? 50;
  const q = normalizeSearch(query);
  if (q) {
    return rankGroups(q, (id) => !excluded(id)).map((r) => ({
      ...r.group,
      options: r.hits.slice(0, perGroup).map((h) => h.option),
    }));
  }
  const out: ZoneGroup[] = [];
  const suggested = (opts.suggested ?? [])
    .filter((id) => !excluded(id) && isValidZone(id))
    .map((id): ZoneOption => {
      const r = resolveZone(id);
      return { id, label: r?.short ?? id, detail: r?.long !== r?.short ? r?.long ?? '' : '', haystack: normalizeSearch(id) };
    });
  if (suggested.length) out.push({ id: 'suggested', label: 'Suggested', options: suggested });
  for (const g of zoneGroups()) {
    if (g.id !== 'offsets' && g.id !== 'abbr') continue; // empty query: keep the list short
    const options = g.options.filter((o) => !excluded(o.id));
    if (options.length) out.push({ ...g, options: options.slice(0, perGroup) });
  }
  return out;
}

/**
 * The zone in `exclude` that `query` names exactly (its abbreviation, label,
 * city, alias or offset), or null. Lets a picker say "Already added" rather
 * than show an empty list.
 */
export function excludedMatch(query: string, exclude: readonly string[]): string | null {
  const q = normalizeSearch(query);
  if (!q || exclude.length === 0) return null;
  const excluded = zoneSet(exclude);
  for (const r of rankGroups(q, excluded)) {
    const hit = r.hits.find((h) => h.score <= 1);
    if (hit) return exclude.find((z) => sameZone(z, hit.option.id)) ?? hit.option.id;
  }
  return null;
}

/** True when `zone` shows offset `minutes` all year (checked in January and July). */
function constantOffset(zone: string, minutes: number, at: number): boolean {
  const y = new Date(at).getUTCFullYear();
  return [Date.UTC(y, 0, 1), Date.UTC(y, 6, 1)].every((t) => offsetMinutesAt(t, zone) === minutes);
}

/** Places with a year-round fractional offset, tried before scanning every zone. */
const FRACTIONAL_PLACES: ReadonlyMap<number, string> = new Map([
  [-570, 'Pacific/Marquesas'],
  [210, 'Asia/Tehran'],
  [270, 'Asia/Kabul'],
  [330, 'Asia/Kolkata'],
  [345, 'Asia/Kathmandu'],
  [390, 'Asia/Yangon'],
  [525, 'Australia/Eucla'],
  [570, 'Australia/Darwin'],
]);

/**
 * An IANA id that shows the same clock as `zone`, for readers that only know
 * IANA ids (older installs reading synced settings). IANA ids come back
 * unchanged, DST-aware abbreviations give the zone they follow, and fixed
 * offsets give a place on that offset all year ("abbr:IST" → Asia/Kolkata,
 * "UTC+05:45" → Asia/Kathmandu), else "Etc/GMT-8"-style ids for whole hours,
 * else a zone on that offset at `at`, else "UTC".
 */
export function ianaEquivalent(zone: string, at: number = Date.now()): string {
  const r = resolveZone(zone);
  if (!r) return 'UTC';
  if (r.kind === 'iana') return zone;
  if (r.minutes === undefined) return r.tz;
  const m = r.minutes;
  if (m === 0) return 'UTC';
  const place = r.kind === 'abbr' ? ABBR_PLACES.get(zone.slice(5)) : undefined;
  if (place && isIana(place) && constantOffset(place, m, at)) return place;
  if (m % 60 === 0) {
    // POSIX-style names: Etc/GMT-8 is UTC+08:00.
    const etc = `Etc/GMT${m > 0 ? '-' : '+'}${Math.abs(m) / 60}`;
    if (isIana(etc)) return etc;
  }
  const known = FRACTIONAL_PLACES.get(m);
  if (known && isIana(known) && constantOffset(known, m, at)) return known;
  const zones = listTimeZones();
  // No place keeps it all year (+12:45 is Chatham's winter time): one on it now.
  return zones.find((z) => constantOffset(z, m, at)) ?? zones.find((z) => offsetMinutesAt(at, z) === m) ?? 'UTC';
}

/**
 * The current canonical id for a zone, so aliases compare equal
 * ("Asia/Katmandu" and "Asia/Kathmandu", "Asia/Calcutta" and "Asia/Kolkata").
 * Legacy names map to the current tz database name, whatever spelling the
 * engine prefers. Non-IANA ids are returned unchanged.
 */
export function canonicalZone(zone: string): string {
  const r = resolveZone(zone);
  if (!r || r.kind !== 'iana') return zone;
  return canonicalIana(zone);
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
