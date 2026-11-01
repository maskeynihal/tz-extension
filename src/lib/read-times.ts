import type { ParsedTime } from '../types';
import { ADVANCED_SCAN_LIMIT } from './custom-formats';
import { parseTimesDetailed, SCAN_LIMIT, specificity, type ParseOptions } from './parse';

/** What readTimes returns. */
export interface TimeList {
  /** Every distinct time found, in reading order (by sourceIndex into `text`). */
  readonly matches: readonly ParsedTime[];
  /** Index in `matches` of the parser's best match (open the card there). */
  readonly best: number;
  /** True when not every time could be listed (count cap or text-length cap). */
  readonly capped: boolean;
}

/** At most this many times are listed. */
export const MAX_LISTED = 500;

/** How much of a selection is read at all. Past it, the list is `capped`. */
export const MAX_READ_CHARS = 200_000;

/**
 * Text before a cut that each re-read starts with, so look-behinds (the verse
 * guard, "a date no format read" before a time, ratio words) see what came
 * before. The built-in formats look back at most 40 characters.
 */
const CONTEXT = 40;

/**
 * When a window ends before the text does, a match near its end may be cut
 * short ("13:30" without " UTC"), and the formats look up to 20 characters
 * past a match. Only matches ending this far before the window's end count;
 * the next window reads the rest again.
 */
const EDGE = 200;

/** The smallest window a re-read uses (see nextWindow). */
const MIN_WINDOW = 1_000;

/**
 * Matches each format may yield per read (one parse stops at 25). Higher
 * means fewer re-reads of a dense text; the parser's overlap check is
 * O(n log n), so a read stays linear.
 */
const READ_CAP = 250;

function startOf(p: ParsedTime): number {
  return p.sourceIndex ?? 0;
}

function endOf(p: ParsedTime): number {
  return startOf(p) + p.matchedText.length;
}

/**
 * Find every time in `text`, in reading order, for the card's and the
 * website's stepper.
 *
 * One parse stops each format after 25 matches and reads SCAN_LIMIT
 * characters. readTimes asks the parser how far every format read in full
 * (duplicates count toward a format's cap), keeps the matches that end
 * there, and parses again from that point with CONTEXT characters of the
 * text before it. It stops at MAX_LISTED distinct times or MAX_READ_CHARS
 * characters, and then says so with `capped`.
 *
 * Deterministic: no time budget, so the same input gives the same list.
 * (A user's advanced regex format still has its own safety budget, and
 * like one parse it only reads the first ADVANCED_SCAN_LIMIT characters.)
 * Duplicates (same instant, same text) are listed once, at the first one.
 */
export function readTimes(text: string, opts: ParseOptions): TimeList {
  const end = text.trimEnd().length;
  const limit = Math.min(end, MAX_READ_CHARS);
  let capped = end > MAX_READ_CHARS;
  const all: ParsedTime[] = [];
  const seen = new Set<string>();
  // Everything that ends at or before `cut` has been listed.
  let cut = 0;
  // End of the last listed match: a later one may not overlap it.
  let listedEnd = 0;
  let window = SCAN_LIMIT;
  read: while (cut < limit) {
    const from = Math.max(0, cut - CONTEXT);
    const to = Math.min(limit, from + window);
    const chunkOpts =
      from >= ADVANCED_SCAN_LIMIT && opts.customFormats?.some((f) => f.advanced)
        ? { ...opts, customFormats: opts.customFormats.filter((f) => !f.advanced) }
        : opts;
    const { results, complete } = parseTimesDetailed(text.slice(from, to), chunkOpts, READ_CAP);
    const found = results
      .map((p) => (from === 0 ? p : { ...p, sourceIndex: from + startOf(p) }))
      .sort((a, b) => startOf(a) - startOf(b));
    // How far this read can be trusted: where a format stopped at its cap,
    // and short of the window's end when the window cut the text.
    let safe = from + complete;
    if (to < end) safe = Math.min(safe, to - EDGE);
    // A match that runs across that point is read again, whole, next time.
    for (const p of found) if (startOf(p) < safe && endOf(p) > safe) safe = startOf(p);

    for (const p of found) {
      // Read before (from the context), or overlapping a listed match.
      if (endOf(p) <= cut || startOf(p) < listedEnd) continue;
      if (endOf(p) > safe) break;
      const key = `${p.epochMs}:${p.matchedText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(p);
      listedEnd = endOf(p);
      if (all.length > MAX_LISTED) {
        capped = true;
        break read;
      }
    }
    if (safe >= limit) break;
    if (safe <= cut) {
      // No progress (a window full of matches that never ends): stop and say so.
      capped = true;
      break;
    }
    window = nextWindow(safe - cut, to - from);
    cut = safe;
  }

  const matches = all.slice(0, MAX_LISTED);
  // The first of the most specific matches, as parseTimes would lead with.
  let best = 0;
  for (let i = 1; i < matches.length; i++) {
    if (specificity(matches[i]!) > specificity(matches[best]!)) best = i;
  }
  return { matches, best, capped };
}

/**
 * The next window's length: about twice what the last read got through, so
 * dense text (a log with a time on every line) re-reads short windows
 * instead of SCAN_LIMIT characters each time, and sparse text grows back to
 * SCAN_LIMIT. Depends only on the text, so the result stays deterministic.
 */
function nextWindow(advanced: number, last: number): number {
  if (advanced >= last - EDGE - CONTEXT) return SCAN_LIMIT;
  return Math.min(SCAN_LIMIT, Math.max(MIN_WINDOW, 2 * advanced + CONTEXT + EDGE));
}
