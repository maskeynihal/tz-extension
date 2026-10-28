/** A resolved instant plus how it was interpreted. */
export interface ParsedTime {
  /** The absolute instant, as epoch milliseconds (UTC). */
  readonly epochMs: number;
  /** The raw substring that was recognized. */
  readonly matchedText: string;
  /**
   * The timezone the source value was interpreted in.
   * `null` when the value carried no zone/offset and was assumed to be in `assumedZone`.
   */
  readonly sourceZone: string | null;
  /** When sourceZone is null, the zone we assumed (user/local). */
  readonly assumedZone: string;
  /** True when we had to assume a zone (bare time with no offset). */
  readonly assumed: boolean;
  /** True when the source had a date but no time and we filled one in. */
  readonly dateOnly?: boolean;
  /** How confident / what kind of match produced this. */
  readonly kind: ParseKind;
}

export type ParseKind =
  | 'iso'
  | 'iso-no-tz'
  | 'epoch-seconds'
  | 'epoch-millis'
  | 'time-of-day'
  | 'datetime-no-tz'
  | 'date-no-tz'
  | 'rfc-like'
  | 'long-form'
  | 'offset'
  | 'named-offset'
  | 'custom';

/** What time to assume for a date that carries no time component. */
export type DateOnlyPolicy = 'midnight' | 'now';

/**
 * UI theme. `system` follows the OS `prefers-color-scheme`; `light` and `dark`
 * force that theme everywhere (popup, options, and the in-page popover),
 * overriding the OS preference.
 */
export type Theme = 'system' | 'light' | 'dark';

/**
 * A user-defined custom format. Built from safe named tokens (NOT raw regex by
 * default) so a bad pattern cannot hang the page. `advanced` switches `pattern`
 * to a raw regex with named capture groups; it runs under a length guard.
 */
export interface CustomFormat {
  readonly id: string;
  readonly label: string;
  /**
   * Token pattern using: YYYY, YY, MM, M, DD, D, HH, H, mm, ss, A (am/pm),
   * MON (Jan), MONTH (January), TZ (zone/offset). Literal characters match
   * themselves. Example: "DD/MM/YYYY HH:mm".
   * In advanced mode this is a raw JS regex source with named groups
   * (?<y>) (?<mo>) (?<d>) (?<h>) (?<mi>) (?<s>) (?<zone>).
   */
  readonly pattern: string;
  readonly advanced: boolean;
  readonly enabled: boolean;
}

/** User preferences persisted in chrome.storage. */
export interface Preferences {
  /** The user's home/base IANA zone. */
  readonly homeZone: string;
  /** Target zones shown everywhere, in display order. IANA ids. */
  readonly targetZones: readonly string[];
  /** 12-hour clock when true, else 24-hour. */
  readonly hour12: boolean;
  /** What to assume as the time for a date with no time component. */
  readonly dateOnlyPolicy: DateOnlyPolicy;
  /** Keep the page text selected (highlighted) while a popover is open. */
  readonly keepSelection: boolean;
  /** UI theme: follow the OS, or force light/dark everywhere. */
  readonly theme: Theme;
  /** User-defined custom formats, tried in addition to the built-ins. */
  readonly customFormats: readonly CustomFormat[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  homeZone: resolveLocalZone(),
  targetZones: ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kathmandu'],
  hour12: true,
  dateOnlyPolicy: 'midnight',
  keepSelection: true,
  theme: 'system',
  customFormats: [],
};

export function resolveLocalZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && z.length > 0 ? z : 'UTC';
  } catch {
    return 'UTC';
  }
}
