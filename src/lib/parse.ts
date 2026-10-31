import type { CustomFormat, DateOnlyPolicy, ParsedTime } from '../types';
import { BUILTIN_FORMATS } from './builtin-formats';
import { matchCustomFormat, type Candidate, type MatchContext } from './custom-formats';

/** Only this many characters of a selection are scanned (keeps select-all fast). */
export const SCAN_LIMIT = 2000;

/** Options controlling how ambiguous values are interpreted. */
export interface ParseOptions {
  /** Zone to assume for values with no explicit zone/offset. */
  readonly assumedZone: string;
  /** What time to use for a date with no time component. Default 'midnight'. */
  readonly dateOnlyPolicy?: DateOnlyPolicy;
  /** User-defined custom formats. They win ties against the built-ins. */
  readonly customFormats?: readonly CustomFormat[];
  /** Ids of built-in formats to skip (see BUILTIN_FORMATS). */
  readonly disabledFormats?: readonly string[];
  /** Injected clock for tests. */
  readonly nowMs?: number;
}

interface Ranked extends Candidate {
  /** Lower wins a tie: custom formats first, then built-ins in registry order. */
  readonly priority: number;
}

function overlaps(a: Candidate, b: Candidate): boolean {
  return a.index < b.index + b.length && b.index < a.index + a.length;
}

/**
 * Parse a free-text string into recognized times, in document order. The
 * caller typically shows the first.
 *
 * Every enabled format (custom and built-in) proposes its matches. Where
 * matches overlap, the longest wins; on equal length a custom format beats a
 * built-in, and built-ins follow registry order. So a custom "YYYYMMDDHHmm"
 * beats the epoch reading of "202412311030", but a loose custom "H:mm" cannot
 * steal part of a full ISO timestamp.
 *
 * Accepts either a plain assumed-zone string (back-compat) or ParseOptions.
 */
export function parseTimes(text: string, opts: string | ParseOptions): ParsedTime[] {
  const o: ParseOptions = typeof opts === 'string' ? { assumedZone: opts } : opts;
  const src = text.trim().slice(0, SCAN_LIMIT);
  if (src.length === 0) return [];

  const ctx: MatchContext = {
    assumedZone: o.assumedZone,
    dateOnlyPolicy: o.dateOnlyPolicy ?? 'midnight',
    nowMs: o.nowMs,
  };
  const disabled = new Set(o.disabledFormats ?? []);
  const ranked: Ranked[] = [];

  const custom = o.customFormats ?? [];
  custom.forEach((fmt, i) => {
    for (const c of matchCustomFormat(src, fmt, ctx)) ranked.push({ ...c, priority: i - custom.length });
  });
  BUILTIN_FORMATS.forEach((fmt, i) => {
    if (disabled.has(fmt.id)) return;
    let found: Candidate[] = [];
    try {
      found = fmt.match(src, ctx);
    } catch {
      found = [];
    }
    for (const c of found) ranked.push({ ...c, priority: i });
  });

  ranked.sort((a, b) => b.length - a.length || a.priority - b.priority || a.index - b.index);
  const chosen: Ranked[] = [];
  for (const c of ranked) {
    if (!chosen.some((k) => overlaps(k, c))) chosen.push(c);
  }
  chosen.sort((a, b) => a.index - b.index);

  // De-duplicate by (epochMs, matchedText).
  const seen = new Set<string>();
  const out: ParsedTime[] = [];
  for (const c of chosen) {
    const key = `${c.parsed.epochMs}:${c.parsed.matchedText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.parsed);
  }
  return out;
}
