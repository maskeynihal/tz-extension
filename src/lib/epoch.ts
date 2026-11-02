export type EpochUnit = 'seconds' | 'milliseconds';

export interface EpochParse {
  readonly epochMs: number;
  readonly unit: EpochUnit;
}

/**
 * Accepted instants: 1900-01-01T00:00:00.000Z to 9999-12-31T23:59:59.999Z.
 * Earlier values are refused on purpose (calendar and offset data before
 * 1900 is unreliable, and such numbers are rarely timestamps).
 */
export const MIN_EPOCH_MS = -2208988800000; // 1900-01-01T00:00:00.000Z
export const MAX_EPOCH_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

/**
 * The largest value auto mode reads as seconds: 11 digits,
 * 5138-11-16T09:46:39Z. A 12-digit value is read as milliseconds.
 */
export const MAX_AUTO_SECONDS = 99999999999;

/**
 * Parse an epoch string. Auto-detects seconds vs milliseconds by digit count
 * unless `forceUnit` is given. Returns null for non-numeric or out-of-range.
 *
 * Detection rule: a bare integer with <= 11 digits (sign not counted) is
 * seconds; 12+ digits are milliseconds. So in auto mode:
 * - seconds cover -2208988800 (1900-01-01) to 99999999999 (5138-11-16);
 * - milliseconds are 12 to 15 digits, -2208988800000 (1900-01-01) to
 *   253402300799999 (9999-12-31). 12-digit values are 1973-03-03 to
 *   2001-09-09, or 1938-04-24 to 1966-10-31 when negative.
 * (Text on a page is only read as an epoch at 10-11 digits for seconds and
 * 12-13 for milliseconds; see builtin-formats.ts.)
 * A 12-digit value is never read as seconds even when it could be
 * (253402300799 is 9999-12-31 in seconds, 1978-01-11 in milliseconds):
 * 1973-2001 millisecond stamps are real data, years 5138-9999 almost never
 * are. Choose seconds explicitly (`forceUnit`) for those.
 */
export function parseEpoch(
  raw: string,
  forceUnit?: EpochUnit,
): EpochParse | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Allow a leading minus, digits only otherwise. No decimals, no separators.
  if (!/^-?\d+$/.test(trimmed)) return null;

  let value: number;
  try {
    value = Number(trimmed);
  } catch {
    return null;
  }
  if (!Number.isFinite(value)) return null;

  const digits = trimmed.replace('-', '').length;
  const unit: EpochUnit = forceUnit ?? (digits >= 12 ? 'milliseconds' : 'seconds');

  const epochMs = unit === 'seconds' ? value * 1000 : value;
  if (!Number.isFinite(epochMs)) return null;
  if (epochMs < MIN_EPOCH_MS || epochMs > MAX_EPOCH_MS) return null;

  return { epochMs, unit };
}

/** Epoch seconds for an instant (floored). */
export function toEpochSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

/** Epoch milliseconds for an instant. */
export function toEpochMillis(epochMs: number): number {
  return epochMs;
}

export function isInRange(epochMs: number): boolean {
  return epochMs >= MIN_EPOCH_MS && epochMs <= MAX_EPOCH_MS;
}
