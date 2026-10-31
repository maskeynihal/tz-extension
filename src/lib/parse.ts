import type { CustomFormat, DateOnlyPolicy, ParsedTime } from '../types';
import { BUILTIN_FORMATS } from './builtin-formats';
import { isVeto, matchCustomFormat, now, type Candidate, type MatchContext, type MatchResult } from './custom-formats';

/**
 * Only this many characters of a selection are scanned. Built-in and token
 * regexes are linear, so this covers a select-all of a long article while
 * keeping each mouseup to a few milliseconds.
 */
export const SCAN_LIMIT = 20_000;

/** Time all custom regex formats together may spend on one selection. */
const CUSTOM_TIME_BUDGET_MS = 60;

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

type Ranked = MatchResult & {
  /** Lower wins a tie: custom formats first, then built-ins in registry order. */
  readonly priority: number;
};

/**
 * How much a match pins down: a calendar date, a time of day, and an explicit
 * zone each count. An epoch is a full instant.
 */
function specificity(p: ParsedTime): number {
  // An epoch is a full instant, but a bare 10-digit run is weaker evidence
  // than a written timestamp with a zone (it may be a phone or ticket number).
  if (p.kind === 'epoch-seconds' || p.kind === 'epoch-millis') return 3;
  const hasDate = p.kind !== 'time-of-day' && p.kind !== 'offset' && !p.timeOnly;
  return (hasDate ? 2 : 0) + (p.dateOnly ? 0 : 1) + (p.assumed ? 0 : 1);
}

function overlaps(a: { index: number; length: number }, b: { index: number; length: number }): boolean {
  return a.index < b.index + b.length && b.index < a.index + a.length;
}

/**
 * Parse a free-text string into recognized times: the best match first, then
 * the others in document order. The caller typically shows the first.
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
    // All custom regexes together get this long per selection.
    deadline: now() + CUSTOM_TIME_BUDGET_MS,
  };
  const disabled = new Set(o.disabledFormats ?? []);
  const ranked: Ranked[] = [];

  const custom = o.customFormats ?? [];
  custom.forEach((fmt, i) => {
    for (const c of matchCustomFormat(src, fmt, ctx)) ranked.push({ ...c, priority: i - custom.length });
  });
  BUILTIN_FORMATS.forEach((fmt, i) => {
    if (disabled.has(fmt.id)) return;
    let found: MatchResult[] = [];
    try {
      found = fmt.match(src, ctx);
    } catch {
      found = [];
    }
    for (const c of found) ranked.push({ ...c, priority: i });
  });

  ranked.sort((a, b) => b.length - a.length || a.priority - b.priority || a.index - b.index);
  const kept: Ranked[] = [];
  for (const c of ranked) {
    if (!kept.some((k) => overlaps(k, c))) kept.push(c);
  }
  // Vetoed spans claimed their text; they produce no result.
  const chosen = kept.filter((c): c is Candidate & { priority: number } => !isVeto(c));
  // The most specific match leads (it is what the popover shows); the rest
  // follow in document order. "Starts 9:00, deadline 2024-01-02T15:00Z" leads
  // with the timestamp; "Standup 9:00, demo 16:30" leads with 9:00.
  chosen.sort((a, b) => a.index - b.index);
  let lead = 0;
  for (let i = 1; i < chosen.length; i++) {
    if (specificity(chosen[i]!.parsed) > specificity(chosen[lead]!.parsed)) lead = i;
  }
  const ordered = chosen.length ? [chosen[lead]!, ...chosen.filter((_, i) => i !== lead)] : [];

  // De-duplicate by (epochMs, matchedText).
  const seen = new Set<string>();
  const out: ParsedTime[] = [];
  for (const c of ordered) {
    const key = `${c.parsed.epochMs}:${c.parsed.matchedText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.parsed);
  }
  return out;
}
