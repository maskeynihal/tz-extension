import { wallClockToInstant } from '../lib/tz';
import { describeWallClock } from '../lib/wall-note';

export interface WallReading {
  readonly epochMs: number;
  /** A short note when the typed time falls in a DST gap or overlap, else null. */
  readonly note: string | null;
}

/**
 * Read a datetime-local value ("YYYY-MM-DDTHH:mm[:ss]") as the wall clock of
 * `zone`, DST-correct, with a note for times that never happened (gap) or
 * happened twice (ambiguous), worded as on the in-page card. Null when the
 * value or zone can't be read.
 */
export function readWallInput(value: string, zone: string, hour12 = false): WallReading | null {
  const iso = value.length === 16 ? `${value}:00` : value;
  const r = wallClockToInstant(iso, zone);
  if (!r || !Number.isFinite(r.epochMs)) return null;
  return { epochMs: r.epochMs, note: r.wallClock ? describeWallClock(r.wallClock, r.epochMs, zone, hour12) : null };
}
