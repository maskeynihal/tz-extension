// Small pure helpers for the website converter (site/demo.ts), kept apart so
// tests can exercise them without a DOM.
import { parseEpoch, type EpochUnit } from '../src/lib/epoch';

// The DST note: one wording for the in-page card, the popup and the website.
export { wallClockNote } from '../src/lib/wall-note';

export interface EpochReading {
  readonly epochMs: number;
  readonly unit: EpochUnit;
}

/**
 * What the Epoch tab accepts: one integer, seconds below 12 digits and
 * milliseconds from 12, negative allowed (before 1970), 0 included. The same
 * rule and range as the extension popup's Epoch tab (src/lib/epoch.ts).
 */
export function readEpochInput(raw: string): EpochReading | null {
  const r = parseEpoch(raw.trim().replace(/\u2212/g, '-'));
  return r ? { epochMs: r.epochMs, unit: r.unit } : null;
}
