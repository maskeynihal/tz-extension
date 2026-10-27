export type EpochUnit = 'seconds' | 'milliseconds';

export interface EpochParse {
  readonly epochMs: number;
  readonly unit: EpochUnit;
}

/** Reasonable bounds: years roughly 1900..9999 in milliseconds. */
const MIN_EPOCH_MS = -2208988800000; // 1900-01-01
const MAX_EPOCH_MS = 253402300799000; // 9999-12-31T23:59:59

/**
 * Parse an epoch string. Auto-detects seconds vs milliseconds by digit count
 * unless `forceUnit` is given. Returns null for non-numeric or out-of-range.
 *
 * Detection rule: a bare integer with <= 11 significant digits is treated as
 * seconds; 12+ digits as milliseconds. This keeps present-day timestamps
 * (10-digit seconds / 13-digit ms) unambiguous while staying sane at the edges.
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
