import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

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
          if (isValidZone(z)) merged.add(z);
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

/** True when the IANA id is valid on this runtime. */
export function isValidZone(zone: string): boolean {
  if (!zone) return false;
  try {
    // Throws RangeError for an invalid zone.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ZoneView {
  readonly zone: string;
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

/** Format one instant (epoch ms) for display in one zone. */
export function viewInZone(epochMs: number, zone: string, hour12: boolean): ZoneView {
  const date = new Date(epochMs);
  const timePattern = hour12 ? 'h:mm:ss a' : 'HH:mm:ss';
  return {
    zone,
    dateTime: formatInTimeZone(date, zone, `yyyy-MM-dd ${timePattern}`),
    time: formatInTimeZone(date, zone, timePattern),
    date: formatInTimeZone(date, zone, 'yyyy-MM-dd'),
    offset: formatInTimeZone(date, zone, 'xxx'),
    abbrev: formatInTimeZone(date, zone, 'zzz'),
    weekday: formatInTimeZone(date, zone, 'EEE'),
  };
}

/**
 * Given wall-clock components as interpreted in `zone`, return the absolute
 * instant (epoch ms). DST-correct via date-fns-tz.
 */
export function wallClockToEpochMs(
  isoLocal: string,
  zone: string,
): number {
  // isoLocal is a zone-less ISO string like "2024-01-02T15:04:05".
  const utc = fromZonedTime(isoLocal, zone);
  return utc.getTime();
}

/** Convert an absolute instant to the wall-clock Date in a zone (for pickers). */
export function epochMsToWallClock(epochMs: number, zone: string): Date {
  return toZonedTime(new Date(epochMs), zone);
}

/** ISO-8601 UTC string for an instant. */
export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
