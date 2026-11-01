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
  /** True when the source had a time but no date (taken as today). */
  readonly timeOnly?: boolean;
  /** How confident / what kind of match produced this. */
  readonly kind: ParseKind;
  /**
   * Id of the format that matched: a built-in id (see BUILTIN_FORMATS) or a
   * custom format's id. Absent only on values built outside the parser.
   */
  readonly formatId?: string;
  /** Human-readable name of the format that matched, shown in the popover. */
  readonly formatLabel?: string;
  /**
   * Set when a numeric date could be day-first or month-first (03/04/2024).
   * `order` is the reading used for epochMs; `alternate` is the other one.
   * `date` / `alternate.date` are the calendar fields as written in the source
   * (wall clock of the source zone), so labels never need a zone round-trip.
   */
  readonly dateOrder?: {
    readonly order: NumericDateOrder;
    readonly date: CalendarDate;
    readonly alternate: {
      readonly epochMs: number;
      readonly order: NumericDateOrder;
      readonly date: CalendarDate;
    };
  };
}

/** A calendar date as written in the source text. `mo` is 1-12. */
export interface CalendarDate {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4 Mar 2024" for 'dmy', "Mar 4, 2024" for 'mdy'. Never touches a timezone. */
export function formatCalendarDate(date: CalendarDate, order: NumericDateOrder): string {
  const m = SHORT_MONTHS[date.mo - 1] ?? String(date.mo);
  return order === 'dmy' ? `${date.d} ${m} ${date.y}` : `${m} ${date.d}, ${date.y}`;
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
   * Token pattern (see TOKEN_REFERENCE in lib/custom-formats.ts): YYYY YY
   * MMMM MMM MM M DD Do D HH H hh h mm ss SSS A TZ, plus the legacy MON and
   * MONTH. `[text]` matches text literally; other characters match themselves.
   * Example: "DD/MM/YYYY HH:mm".
   * In advanced mode this is a raw JS regex source with named groups
   * (?<y>) (?<yy>) (?<mo>) (?<moName>) (?<d>) (?<h>) (?<mi>) (?<s>) (?<ms>)
   * (?<ap>) (?<zone>).
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
  /** Ids of built-in formats the user switched off (see BUILTIN_FORMATS). */
  readonly disabledFormats: readonly string[];
  /**
   * Show the converter automatically when text is selected. When false, only
   * the right-click "Convert" menu item opens it.
   */
  readonly selectToConvert: boolean;
  /** Size a card opens at: compact, full, or whatever was used last. */
  readonly cardSize: CardSize;
  /** The size the user last switched a card to (used when cardSize is 'last'). */
  readonly lastCardSize: 'compact' | 'full';
  /**
   * How to read a numeric date whose day and month could swap (03/04/2024).
   * Unambiguous dates (a part above 12) ignore this.
   */
  readonly numericDateOrder: NumericDateOrder;
}

/** Card size on open. */
export type CardSize = 'compact' | 'full' | 'last';

/** Day-first (22/03/1999) or month-first (03/22/1999). */
export type NumericDateOrder = 'dmy' | 'mdy';

/** Month-first for US-style locales, day-first elsewhere. */
export function localeDateOrder(): NumericDateOrder {
  try {
    const lang =
      (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) ||
      Intl.DateTimeFormat().resolvedOptions().locale;
    // Ask the locale itself which comes first.
    const parts = new Intl.DateTimeFormat(lang, { day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(
      new Date(Date.UTC(2000, 10, 22)),
    );
    const d = parts.findIndex((p) => p.type === 'day');
    const m = parts.findIndex((p) => p.type === 'month');
    return m >= 0 && d >= 0 && m < d ? 'mdy' : 'dmy';
  } catch {
    return 'dmy';
  }
}

export const DEFAULT_PREFERENCES: Preferences = {
  homeZone: resolveLocalZone(),
  targetZones: ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kathmandu'],
  hour12: true,
  dateOnlyPolicy: 'midnight',
  keepSelection: true,
  theme: 'system',
  customFormats: [],
  disabledFormats: [],
  selectToConvert: true,
  cardSize: 'last',
  lastCardSize: 'full',
  numericDateOrder: localeDateOrder(),
};

export function resolveLocalZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && z.length > 0 ? z : 'UTC';
  } catch {
    return 'UTC';
  }
}
