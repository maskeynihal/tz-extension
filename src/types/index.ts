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
  | 'rfc-like'
  | 'offset'
  | 'named-offset';

/** User preferences persisted in chrome.storage. */
export interface Preferences {
  /** The user's home/base IANA zone. */
  readonly homeZone: string;
  /** Target zones shown everywhere, in display order. IANA ids. */
  readonly targetZones: readonly string[];
  /** 12-hour clock when true, else 24-hour. */
  readonly hour12: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  homeZone: resolveLocalZone(),
  targetZones: ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kathmandu'],
  hour12: true,
};

export function resolveLocalZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && z.length > 0 ? z : 'UTC';
  } catch {
    return 'UTC';
  }
}
