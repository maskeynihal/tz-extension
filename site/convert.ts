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

export interface ReadingOrder {
  /** The matches in the order they appear in the input. */
  readonly times: readonly ParsedTime[];
  /** Where the parser's best match (its first result) sits in `times`. */
  readonly best: number;
}

/**
 * Put parseTimes' results (best-first) in reading order by `sourceIndex`,
 * like the extension card's stepper. Ties keep best-first order. A result
 * without a sourceIndex falls back to the first place its text occurs in
 * `text`, so the order stays sensible whatever the parser reports.
 */
export function readingOrder(matches: readonly ParsedTime[], text: string): ReadingOrder {
  const at = (p: ParsedTime): number => {
    if (typeof p.sourceIndex === 'number') return p.sourceIndex;
    const i = text.indexOf(p.matchedText);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const keyed = matches.map((p, rank) => ({ p, rank, at: at(p) }));
  keyed.sort((a, b) => a.at - b.at || a.rank - b.rank);
  return { times: keyed.map((k) => k.p), best: Math.max(0, keyed.findIndex((k) => k.rank === 0)) };
}

/** A key that identifies one match in the input, to keep the step across re-renders. */
export function matchKey(p: ParsedTime): string {
  return `${p.sourceIndex ?? ''}:${p.matchedText}`;
}
