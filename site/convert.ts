// Small pure helpers for the website converter (site/demo.ts), kept apart so
// tests can exercise them without a DOM.
import { parseEpoch, type EpochUnit } from '../src/lib/epoch';
import type { ParsedTime } from '../src/types';

// The DST note: one wording for the in-page card, the popup and the website.
export { wallClockNote } from '../src/lib/wall-note';

export interface EpochReading {
  readonly epochMs: number;
  readonly unit: EpochUnit;
}

/**
 * The Epoch tab's error hint. It states the real rule in src/lib/epoch.ts:
 * up to 11 digits are seconds, 12 or more are milliseconds, and the result
 * must fall in 1900-01-01 … 9999-12-31 UTC (so 9999 is reachable only in
 * milliseconds, and pre-1900 values are refused). tests/ui-r3.test.tsx checks
 * every claim here against parseEpoch.
 */
export const EPOCH_INPUT_HINT =
  "That isn't a Unix timestamp we can read. Paste a whole number of seconds (up to 11 digits, like 1700000000) or milliseconds (12 or more digits) for a time from 1900-01-01 to 9999-12-31 UTC; negative values count back from 1970.";

/**
 * What the Epoch tab accepts: one integer, seconds below 12 digits and
 * milliseconds from 12, negative allowed (back to 1900-01-01), 0 included.
 * The same rule and range as the extension popup's Epoch tab (src/lib/epoch.ts).
 */
export function readEpochInput(raw: string): EpochReading | null {
  const r = parseEpoch(raw.trim().replace(/\u2212/g, '-'));
  return r ? { epochMs: r.epochMs, unit: r.unit } : null;
}

/** A key that identifies one match in the input, to keep the step across re-renders. */
export function matchKey(p: ParsedTime): string {
  return `${p.sourceIndex ?? ''}:${p.matchedText}`;
}
