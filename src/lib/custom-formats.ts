import type { CustomFormat, DateOnlyPolicy, ParsedTime } from '../types';
import {
  buildParsed,
  dateOnlyTime,
  monthFromName,
  resolveZoneToken,
  to24h,
  todayIn,
} from './time-tokens';

/**
 * Compiles user-defined custom formats into matchers and runs them against text.
 *
 * Two modes:
 *  - token mode (default): the pattern uses named tokens like YYYY/MM/DD
 *    HH:mm:ss. Each token becomes a bounded regex fragment, every literal
 *    character is escaped, and whitespace runs collapse into one \s+, so the
 *    compiled regex has no competing open-ended repeats.
 *  - advanced mode: the pattern is a raw JS regex with named groups. It must
 *    compile, use only known group names, not match empty text, and not nest
 *    nest repeats, and stay under a backtracking-cost estimate (see
 *    analyzeRegex). It runs on short windows (ADVANCED_MATCH_WINDOW) over the
 *    first ADVANCED_SCAN_LIMIT characters of a selection.
 */

/** A capture-group name the parser understands. */
export type Field = 'y' | 'yy' | 'mo' | 'moName' | 'd' | 'h' | 'mi' | 's' | 'ms' | 'ap' | 'zone';

export const KNOWN_GROUPS: readonly Field[] = ['y', 'yy', 'mo', 'moName', 'd', 'h', 'mi', 's', 'ms', 'ap', 'zone'];

export const MAX_TOKEN_PATTERN = 120;
export const MAX_ADVANCED_PATTERN = 300;
/** Advanced (raw) regexes only scan this many characters of a selection. */
export const ADVANCED_SCAN_LIMIT = 500;
/** Stop after this many matches per format (bounded work on long selections). */
const MAX_MATCHES_PER_FORMAT = 25;

const ZONE_FRAG =
  '(?<zone>Z|[+-]\\d{2}:?\\d{2}|(?:[Gg][Mm][Tt]|[Uu][Tt][Cc])[+-]\\d{1,2}(?::?\\d{2})?|[A-Za-z]{2,5})';

interface TokenDef {
  readonly token: string;
  readonly group: Field;
  readonly frag: string;
  readonly meaning: string;
  readonly example: string;
  /** 12-hour hour token: needs A. */
  readonly twelveHour?: boolean;
  /** Kept for old saved formats; hidden from the reference table. */
  readonly legacy?: boolean;
}

// Order matters: longer tokens first so "YYYY" is consumed before "YY",
// "MMMM" before "MMM" before "MM" before "M".
const TOKENS: readonly TokenDef[] = [
  { token: 'YYYY', group: 'y', frag: '(?<y>\\d{4})', meaning: '4-digit year', example: '2024' },
  { token: 'MMMM', group: 'moName', frag: '(?<moName>[A-Za-z]{3,9})', meaning: 'Month name', example: 'January' },
  { token: 'MONTH', group: 'moName', frag: '(?<moName>[A-Za-z]{3,9})', meaning: 'Month name', example: 'January', legacy: true },
  { token: 'MON', group: 'moName', frag: '(?<moName>[A-Za-z]{3,9}\\.?)', meaning: 'Month name', example: 'Jan', legacy: true },
  { token: 'MMM', group: 'moName', frag: '(?<moName>[A-Za-z]{3,4}\\.?)', meaning: 'Short month name', example: 'Jan' },
  { token: 'SSS', group: 'ms', frag: '(?<ms>\\d{3})', meaning: 'Milliseconds', example: '045' },
  { token: 'MM', group: 'mo', frag: '(?<mo>\\d{2})', meaning: '2-digit month', example: '01' },
  { token: 'DD', group: 'd', frag: '(?<d>\\d{2})', meaning: '2-digit day', example: '05' },
  { token: 'Do', group: 'd', frag: '(?<d>\\d{1,2})(?:st|nd|rd|th)', meaning: 'Day with suffix', example: '5th' },
  { token: 'HH', group: 'h', frag: '(?<h>\\d{2})', meaning: '2-digit hour, 00-23', example: '09' },
  { token: 'hh', group: 'h', frag: '(?<h>\\d{2})', meaning: '2-digit hour, 01-12 (needs A)', example: '09', twelveHour: true },
  { token: 'mm', group: 'mi', frag: '(?<mi>\\d{2})', meaning: 'Minutes', example: '30' },
  { token: 'ss', group: 's', frag: '(?<s>\\d{2})', meaning: 'Seconds', example: '07' },
  { token: 'YY', group: 'yy', frag: '(?<yy>\\d{2})', meaning: '2-digit year (70-99 → 19xx)', example: '24' },
  { token: 'TZ', group: 'zone', frag: ZONE_FRAG, meaning: 'Zone or offset', example: 'UTC, EST, +05:45, GMT+1' },
  { token: 'A', group: 'ap', frag: '(?<ap>[AaPp]\\.?[Mm]\\.?)', meaning: 'AM/PM (any case)', example: 'PM' },
  { token: 'M', group: 'mo', frag: '(?<mo>\\d{1,2})', meaning: 'Month, 1-2 digits', example: '1' },
  { token: 'D', group: 'd', frag: '(?<d>\\d{1,2})', meaning: 'Day, 1-2 digits', example: '5' },
  { token: 'H', group: 'h', frag: '(?<h>\\d{1,2})', meaning: 'Hour, 0-23', example: '9' },
  { token: 'h', group: 'h', frag: '(?<h>\\d{1,2})', meaning: 'Hour, 1-12 (needs A)', example: '9', twelveHour: true },
];

/** Token reference for the settings page. */
export const TOKEN_REFERENCE: ReadonlyArray<{ token: string; meaning: string; example: string }> = [
  ...TOKENS.filter((t) => !t.legacy).map(({ token, meaning, example }) => ({ token, meaning, example })),
  { token: '[text]', meaning: 'Literal text (use for words like “at”)', example: '[at]' },
];

/** Which field a group fills. Two groups for the same field is an error. */
const FIELD_OF: Readonly<Record<Field, string>> = {
  y: 'year',
  yy: 'year',
  mo: 'month',
  moName: 'month',
  d: 'day',
  h: 'hour',
  mi: 'minute',
  s: 'second',
  ms: 'millisecond',
  ap: 'AM/PM',
  zone: 'zone',
};

export type CompileResult =
  | {
      readonly ok: true;
      readonly regex: RegExp;
      readonly groups: ReadonlySet<Field>;
      /** Non-blocking advice, e.g. letters that will be matched literally. */
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

function escapeLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Shared rules on which fields a format must (and must not) combine. */
function checkFields(groups: ReadonlySet<Field>, twelveHourTokens: boolean): string | null {
  const has = (f: Field): boolean => groups.has(f);
  const hasMonth = has('mo') || has('moName');
  const hasDate = hasMonth || has('d') || has('y') || has('yy');
  const hasTime = has('h') || has('mi') || has('s') || has('ms');
  if (!hasDate && !hasTime) {
    return 'The pattern needs date or time tokens (for example DD/MM/YYYY or HH:mm). Literal words go in [ ].';
  }
  if (hasDate && !(hasMonth && has('d'))) {
    return 'A date needs both a month (MM, M, MMM or MMMM) and a day (DD, D or Do).';
  }
  if (has('mi') && !has('h')) return 'Minutes (mm) need an hour token (HH, H, hh or h).';
  if (has('s') && !has('mi')) return 'Seconds (ss) need minutes (mm).';
  if (has('ms') && !has('s')) return 'Milliseconds (SSS) need seconds (ss).';
  if (has('ap') && !has('h')) return 'AM/PM (A) needs an hour token (hh or h).';
  if (twelveHourTokens && !has('ap')) {
    return 'hh and h are 12-hour clock tokens. Add A for AM/PM, or use HH or H. To match letters literally, wrap them in [ ].';
  }
  return null;
}

/** Translate a token pattern into a safe regex, or explain why it cannot be used. */
export function compileTokenFormat(pattern: string): CompileResult {
  if (!pattern || pattern.trim().length === 0) return { ok: false, error: 'Enter a pattern.' };
  if (pattern.length > MAX_TOKEN_PATTERN) {
    return { ok: false, error: `The pattern is too long (max ${MAX_TOKEN_PATTERN} characters).` };
  }
  const pieces: Array<{ kind: 'token' | 'literal'; src: string }> = [];
  const groups = new Set<Field>();
  const seenField = new Map<string, string>();
  let twelveHour = false;
  const literalLetters = new Set<string>();
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) return { ok: false, error: 'Unclosed [ — wrap literal text like [at].' };
      const lit = pattern.slice(i + 1, close);
      for (const c of lit) pieces.push({ kind: 'literal', src: /\s/.test(c) ? '\\s+' : escapeLiteral(c) });
      i = close + 1;
      continue;
    }
    const def = TOKENS.find((t) => pattern.startsWith(t.token, i));
    if (def) {
      const field = FIELD_OF[def.group];
      const prev = seenField.get(field);
      if (prev !== undefined) {
        return {
          ok: false,
          error: `"${def.token}" repeats the ${field} (already set by "${prev}"). Each field can appear once; wrap literal letters in [ ].`,
        };
      }
      seenField.set(field, def.token);
      groups.add(def.group);
      if (def.twelveHour) twelveHour = true;
      pieces.push({ kind: 'token', src: def.frag });
      i += def.token.length;
      continue;
    }
    if (/\s/.test(ch)) {
      // Collapse a run of whitespace into one tolerant \s+.
      while (i < pattern.length && /\s/.test(pattern[i] ?? '')) i++;
      pieces.push({ kind: 'literal', src: '\\s+' });
      continue;
    }
    // "T" is the usual ISO date/time separator; any other bare letter is
    // probably a mistyped token, so say how it will be read.
    if (/[A-Za-z]/.test(ch) && ch !== 'T') literalLetters.add(ch);
    pieces.push({ kind: 'literal', src: escapeLiteral(ch) });
    i += 1;
  }
  const fieldError = checkFields(groups, twelveHour);
  if (fieldError) return { ok: false, error: fieldError };

  // Collapse adjacent whitespace pieces (e.g. "[   ]" or "[at ] HH") into a
  // single \s+. Two \s+ in a row backtrack quadratically; a dozen hang a page.
  const merged: typeof pieces = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (p.src === '\\s+' && prev?.src === '\\s+') continue;
    merged.push(p);
  }

  // Do not start or end a match in the middle of a number or word.
  const first = merged[0];
  const last = merged[merged.length - 1];
  const src =
    (first?.kind === 'token' ? '(?<![A-Za-z0-9])' : '') +
    merged.map((p) => p.src).join('') +
    (last?.kind === 'token' ? '(?![A-Za-z0-9])' : '');
  const warnings: string[] = [];
  if (literalLetters.size > 0) {
    const list = Array.from(literalLetters).join(', ');
    warnings.push(
      `${list} ${literalLetters.size === 1 ? 'is not a token and is' : 'are not tokens and are'} matched literally. Wrap literal text in [ ] to make that explicit${literalLetters.has('Z') ? '; use TZ to read a zone' : ''}.`,
    );
  }
  try {
    return { ok: true, regex: new RegExp(src, 'g'), groups, warnings };
  } catch (e) {
    return { ok: false, error: `The pattern could not be compiled: ${(e as Error).message}` };
  }
}

/**
 * Longest text an advanced regex may match. Advanced regexes run on windows of
 * this many characters, so an open-ended repeat (+, *, {n,}) can never scan
 * more than this from one start position.
 */
export const ADVANCED_MATCH_WINDOW = 80;
/** Upper bound on the estimated backtracking work per start position. */
const MAX_REGEX_COST = 20_000;
/**
 * Upper bound on cost × width: roughly the characters one attempt can
 * examine across all its backtracking. Bounds a single exec, which the
 * wall-clock budget cannot interrupt.
 */
const MAX_REGEX_WORK = 5_000_000;
/** Longest text a lookbehind may inspect (it runs on every attempt). */
const MAX_LOOKBEHIND_WIDTH = 32;
/**
 * Wall-clock budget for one advanced format on one selection. The static
 * checks bound a single attempt; this bounds the sum over all start positions.
 */
export const ADVANCED_TIME_BUDGET_MS = 25;

export interface RegexRisk {
  /** A repeated group contains a repeat or an alternation: exponential. */
  readonly nested: boolean;
  /** Product of the choices every quantifier allows (unbounded = window). */
  readonly cost: number;
  /** Widest text any lookbehind can inspect (unbounded = Infinity). */
  readonly lookbehindWidth: number;
  /**
   * Characters one attempt can examine, counting lookahead bodies (each one
   * re-scans) and capping open-ended repeats at the match window.
   */
  readonly width: number;
}

/**
 * Static ReDoS analysis for user regexes. Catastrophic backtracking needs
 * either a repeated group that can match the same text several ways (nested
 * repeats such as (a+)+, or alternation such as (a|a)+) or many adjacent
 * repeats competing for the same characters (\d+\d*\d*). The first is
 * rejected outright. The second is bounded by estimating the work as the
 * product of each quantifier's range, with unbounded ones capped at the match
 * window. The estimate over-counts for repeats that cannot overlap, which errs
 * on the safe side.
 */
export function analyzeRegex(src: string): RegexRisk {
  interface Frame {
    /** Contains a variable-length repeat (?, *, +, {m,n} with m < n). */
    hasRepeat: boolean;
    /** Contains an alternation, here or in any nested group. */
    hasAlt: boolean;
    /** Number of top-level branches in this group. */
    branches: number;
    cost: number;
    /** Widest text this group can match (sum of atom maxima). */
    width: number;
    /** Widest branch so far (alternation takes the max over branches). */
    branchWidth: number;
    lookbehind: boolean;
  }
  const frame = (lookbehind = false): Frame => ({
    hasRepeat: false,
    hasAlt: false,
    branches: 1,
    cost: 1,
    width: 0,
    branchWidth: 0,
    lookbehind,
  });
  let lookbehindWidth = 0;
  const widthOf = (f: Frame): number => Math.max(f.width, f.branchWidth);
  const stack: Frame[] = [frame()];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  let nested = false;

  /** Parse a quantifier at j: its range and length, or null. */
  const quantAt = (j: number): { min: number; max: number; len: number } | null => {
    const c = src[j];
    let q: { min: number; max: number; len: number } | null = null;
    if (c === '*') q = { min: 0, max: Infinity, len: 1 };
    else if (c === '+') q = { min: 1, max: Infinity, len: 1 };
    else if (c === '?') q = { min: 0, max: 1, len: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(j));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        q = { min, max, len: m[0].length };
      }
    }
    if (q && src[j + q.len] === '?') q = { ...q, len: q.len + 1 }; // lazy
    return q;
  };
  const factor = (q: { min: number; max: number }): number =>
    q.max === Infinity ? ADVANCED_MATCH_WINDOW : Math.max(1, Math.min(q.max, ADVANCED_MATCH_WINDOW) - q.min + 1);

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') {
      i++;
      // Skip group syntax such as ?: ?= ?! ?<= ?<! ?<name>
      let behind = false;
      if (src[i] === '?') {
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(src.slice(i));
        if (m) {
          behind = m[0] === '?<=' || m[0] === '?<!';
          i += m[0].length;
        }
      }
      stack.push(frame(behind));
      continue;
    }
    if (c === ')') {
      const inner = stack.length > 1 ? (stack.pop() as Frame) : frame();
      // Each branch is another way to match: alternation multiplies the work.
      const innerCost = inner.cost * inner.branches;
      const innerWidth = widthOf(inner);
      if (inner.lookbehind) lookbehindWidth = Math.max(lookbehindWidth, innerWidth);
      i++;
      const q = quantAt(i);
      const parent = top();
      if (q) {
        i += q.len;
        if (q.max > 1 && (inner.hasRepeat || inner.hasAlt)) nested = true;
        parent.cost *= innerCost * factor(q);
        if (q.max > q.min) parent.hasRepeat = true;
        if (inner.lookbehind && q.max > 1) lookbehindWidth = Infinity;
        parent.width += inner.lookbehind ? 0 : innerWidth * Math.min(q.max, ADVANCED_MATCH_WINDOW);
      } else {
        parent.cost *= innerCost;
        // Lookarounds match no text of their own.
        parent.width += inner.lookbehind ? 0 : innerWidth;
      }
      // Wrapping in a plain group must not hide what is inside it.
      if (inner.hasRepeat) parent.hasRepeat = true;
      if (inner.hasAlt) parent.hasAlt = true;
      continue;
    }
    if (c === '|') {
      const f = top();
      f.hasAlt = true;
      f.branches += 1;
      f.branchWidth = Math.max(f.branchWidth, f.width);
      f.width = 0;
      i++;
      continue;
    }
    let atomEnd: number;
    if (c === '\\') {
      atomEnd = i + 2;
    } else if (c === '[') {
      // In JavaScript (unlike PCRE) a "]" right after "[" or "[^" closes the
      // class: [] matches nothing and [^] matches any character.
      let j = i + 1;
      if (src[j] === '^') j++;
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
      atomEnd = j + 1;
    } else {
      atomEnd = i + 1;
    }
    // Anchors and boundaries match no text.
    const zeroWidth = (c === '^' || c === '$') || (c === '\\' && (src[i + 1] === 'b' || src[i + 1] === 'B'));
    const q = quantAt(atomEnd);
    if (q) {
      top().cost *= factor(q);
      // A fixed count like \d{2} matches one way; only variable repeats are ambiguous.
      if (q.max > q.min) top().hasRepeat = true;
      if (!zeroWidth) top().width += Math.min(q.max, ADVANCED_MATCH_WINDOW);
      i = atomEnd + q.len;
    } else {
      if (!zeroWidth) top().width += 1;
      i = atomEnd;
    }
  }
  let cost = 1;
  for (const f of stack) cost *= f.cost * f.branches;
  const width = stack.reduce((w, f) => w + widthOf(f), 0) + (Number.isFinite(lookbehindWidth) ? lookbehindWidth : 0);
  return { nested, cost, lookbehindWidth, width };
}

/** True when a repeated group contains a repeat or an alternation, e.g. (a+)+ or (a|b)*. */
export function hasNestedQuantifier(src: string): boolean {
  return analyzeRegex(src).nested;
}

/** Compile an advanced raw-regex pattern, or explain why it cannot be used. */
export function compileAdvancedFormat(pattern: string): CompileResult {
  if (!pattern || pattern.trim().length === 0) return { ok: false, error: 'Enter a regular expression.' };
  if (pattern.length > MAX_ADVANCED_PATTERN) {
    return { ok: false, error: `The regex is too long (max ${MAX_ADVANCED_PATTERN} characters).` };
  }
  let regex: RegExp;
  try {
    // Compile once without flags so the engine's message shows the user's text.
    new RegExp(pattern);
    regex = new RegExp(pattern, 'g');
  } catch (e) {
    // Engines already prefix "Invalid regular expression: /src/: ...".
    const msg = (e as Error).message.replace(/^Invalid regular expression:\s*/i, '');
    return { ok: false, error: `Invalid regular expression: ${msg}` };
  }
  if (/\\[1-9]|\\k</.test(pattern.replace(/\\\\/g, ''))) {
    return { ok: false, error: 'Backreferences (\\1, \\k<name>) are not supported in custom formats.' };
  }
  const names = Array.from(pattern.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g), (m) => m[1] ?? '');
  if (names.length === 0) {
    return {
      ok: false,
      error: 'Name your capture groups so the parser knows what each part is, e.g. (?<y>\\d{4})-(?<mo>\\d{2})-(?<d>\\d{2}).',
    };
  }
  const groups = new Set<Field>();
  const seenField = new Map<string, string>();
  for (const n of names) {
    if (!(KNOWN_GROUPS as readonly string[]).includes(n)) {
      return { ok: false, error: `Unknown group (?<${n}>). Use: ${KNOWN_GROUPS.join(', ')}.` };
    }
    const field = FIELD_OF[n as Field];
    const prev = seenField.get(field);
    if (prev !== undefined) {
      return { ok: false, error: `Groups (?<${prev}>) and (?<${n}>) both set the ${field}. Use one.` };
    }
    seenField.set(field, n);
    groups.add(n as Field);
  }
  const fieldError = checkFields(groups, false);
  if (fieldError) return { ok: false, error: fieldError };
  const risk = analyzeRegex(pattern);
  if (risk.nested) {
    return {
      ok: false,
      error:
        'This regex repeats a group that contains a repeat or a choice, like (a+)+ or (a|b)+. That can freeze the page, so it is not allowed.',
    };
  }
  if (risk.lookbehindWidth > MAX_LOOKBEHIND_WIDTH) {
    return {
      ok: false,
      error: `Lookbehinds may look back at most ${MAX_LOOKBEHIND_WIDTH} characters, with fixed or bounded repeats only.`,
    };
  }
  if (risk.cost > MAX_REGEX_COST || risk.cost * Math.max(1, risk.width) > MAX_REGEX_WORK) {
    return {
      ok: false,
      error:
        'This regex has too many open-ended repeats (+, *, {n,}) to run safely on every page. Use bounded repeats such as \\d{1,4} or \\s{0,3}.',
    };
  }
  try {
    const probe = new RegExp(pattern);
    if (probe.exec('') !== null) return { ok: false, error: 'This regex can match empty text. Make at least one part required.' };
  } catch {
    /* compiled above */
  }
  return { ok: true, regex, groups, warnings: [] };
}

/** Compile either mode. */
export function compileFormat(fmt: Pick<CustomFormat, 'pattern' | 'advanced'>): CompileResult {
  return fmt.advanced ? compileAdvancedFormat(fmt.pattern) : compileTokenFormat(fmt.pattern);
}

/** Back-compat helper: a compiled token pattern or null. */
export function compileTokenPattern(pattern: string): RegExp | null {
  const r = compileTokenFormat(pattern);
  return r.ok ? r.regex : null;
}

/** Back-compat helper: a compiled advanced pattern or null. */
export function compileAdvancedPattern(pattern: string): RegExp | null {
  const r = compileAdvancedFormat(pattern);
  return r.ok ? r.regex : null;
}

// Small cache so the content script does not recompile on every selection.
const cache = new Map<string, CompileResult>();
function compiledFor(fmt: Pick<CustomFormat, 'pattern' | 'advanced'>): CompileResult {
  const key = `${fmt.advanced ? 'r' : 't'}:${fmt.pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = compileFormat(fmt);
  if (cache.size > 100) cache.clear();
  cache.set(key, res);
  return res;
}

/** One match of a format inside a text. */
export interface Candidate {
  readonly parsed: ParsedTime;
  readonly index: number;
  readonly length: number;
}

/**
 * Text that has the shape of a timestamp but holds impossible values
 * ("2024-13-01 10:00", "10:00+15:00"). It wins overlaps like a match but
 * produces no result, so no other format can read a piece of it (the "10:00"
 * or the "15:00") as a time of its own.
 */
export interface Veto {
  readonly veto: true;
  readonly index: number;
  readonly length: number;
}

export type MatchResult = Candidate | Veto;

export function isVeto(m: MatchResult): m is Veto {
  return 'veto' in m;
}

export interface MatchContext {
  readonly assumedZone: string;
  readonly dateOnlyPolicy: DateOnlyPolicy;
  /** Injected for tests; defaults to Date.now(). */
  readonly nowMs?: number;
  /**
   * performance.now() value after which advanced regexes stop scanning. Lets
   * parseTimes share one budget across every custom format.
   */
  readonly deadline?: number;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Turn one regex match into a ParsedTime, or null when its values are invalid. */
function fromGroups(
  g: Record<string, string | undefined>,
  matched: string,
  fmt: Pick<CustomFormat, 'id' | 'label' | 'pattern'>,
  ctx: MatchContext,
): ParsedTime | null {
  // Zone first: it decides which "today" a time-only format lands on.
  let zone: ReturnType<typeof resolveZoneToken> = null;
  if (g.zone !== undefined && g.zone !== '') {
    zone = resolveZoneToken(g.zone);
    if (!zone) return null; // the format promised a zone and this is not one
  }

  // Decide from what this match captured: an advanced regex may make the date
  // or time part optional.
  const hasDate = g.mo !== undefined || g.moName !== undefined || g.d !== undefined;
  const hasTime = g.h !== undefined;
  if (!hasDate && !hasTime) return null;
  const now = ctx.nowMs ?? Date.now();
  const today = todayIn(zone ? zone.today : ctx.assumedZone, now);

  let year: number | undefined = num(g.y);
  if (year === undefined && g.yy !== undefined) {
    const yy = Number(g.yy);
    if (!Number.isFinite(yy)) return null;
    year = yy < 70 ? 2000 + yy : 1900 + yy;
  }
  let month: number | undefined = num(g.mo) ?? monthFromName(g.moName);
  let day: number | undefined = num(g.d);
  if (hasDate) {
    if (g.moName !== undefined && month === undefined) return null; // not a month name
    if (month === undefined || day === undefined) return null;
    year = year ?? today.y;
  } else {
    year = today.y;
    month = today.mo;
    day = today.d;
  }

  let h: number;
  let mi: number;
  let s: number;
  let ms: number | undefined;
  const dateOnly = !hasTime;
  if (hasTime) {
    const rawH = num(g.h);
    if (rawH === undefined) return null;
    const hour = to24h(rawH, g.ap);
    if (hour === null) return null;
    h = hour;
    mi = num(g.mi) ?? 0;
    s = num(g.s) ?? 0;
    if (g.ms !== undefined && /^\d{1,9}$/.test(g.ms)) ms = Number(g.ms.slice(0, 3).padEnd(3, '0'));
  } else {
    ({ h, mi, s } = dateOnlyTime(ctx.dateOnlyPolicy, ctx.assumedZone));
  }

  return buildParsed({ y: year, mo: month, d: day, h, mi, s, ms }, zone, ctx.assumedZone, {
    matchedText: matched,
    kind: 'custom',
    formatId: fmt.id,
    formatLabel: fmt.label || fmt.pattern,
    dateOnly,
    timeOnly: !hasDate,
  });
}

/** All matches of one custom format in `text` (empty when disabled or invalid). */
export function matchCustomFormat(
  text: string,
  fmt: CustomFormat,
  ctx: MatchContext,
): Candidate[] {
  if (!fmt.enabled) return [];
  const compiled = compiledFor(fmt);
  if (!compiled.ok) return [];
  return fmt.advanced
    ? matchWindowed(text.slice(0, ADVANCED_SCAN_LIMIT), compiled.regex.source, fmt, ctx)
    : matchGlobal(text, compiled.regex.source, fmt, ctx);
}

function toCandidate(
  m: RegExpExecArray,
  index: number,
  fmt: CustomFormat,
  ctx: MatchContext,
): Candidate | null {
  const parsed = fromGroups((m.groups ?? {}) as Record<string, string | undefined>, m[0], fmt, ctx);
  return parsed ? { parsed, index, length: m[0].length } : null;
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * True when the format's layout appears in `text`, even if the values are not
 * a real date (for the settings tester's hint). Same limits as matching.
 */
export function layoutMatches(text: string, fmt: Pick<CustomFormat, 'pattern' | 'advanced'>): boolean {
  const compiled = compiledFor(fmt);
  if (!compiled.ok) return false;
  if (!fmt.advanced) return new RegExp(compiled.regex.source).test(text.slice(0, 2000));
  let re: RegExp;
  try {
    re = new RegExp(compiled.regex.source, 'y');
  } catch {
    return false;
  }
  const src = text.slice(0, ADVANCED_SCAN_LIMIT);
  const started = now();
  for (let i = 0; i < src.length; i++) {
    if ((i & 15) === 0 && now() - started > ADVANCED_TIME_BUDGET_MS) return false;
    re.lastIndex = i;
    try {
      if (re.exec(src.slice(0, i + ADVANCED_MATCH_WINDOW))) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Token patterns: bounded fragments, so one global scan is safe. */
function matchGlobal(src: string, source: string, fmt: CustomFormat, ctx: MatchContext): Candidate[] {
  // Fresh regex per call: the cached one is shared and `g` regexes are stateful.
  const re = new RegExp(source, 'g');
  const out: Candidate[] = [];
  let guard = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_MATCHES_PER_FORMAT && guard++ <= src.length + 1) {
    try {
      m = re.exec(src);
    } catch {
      break;
    }
    if (!m) break;
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const c = toCandidate(m, m.index, fmt, ctx);
    if (c) out.push(c);
    // On invalid values a valid match may still start inside this one.
    else re.lastIndex = m.index + 1;
  }
  return out;
}

/**
 * Advanced regexes: try each start position with a sticky regex on text cut
 * ADVANCED_MATCH_WINDOW characters past it, so a match (and its backtracking)
 * never runs past the window. Text before the start stays visible for
 * lookbehinds.
 */
function matchWindowed(src: string, source: string, fmt: CustomFormat, ctx: MatchContext): Candidate[] {
  let re: RegExp;
  try {
    re = new RegExp(source, 'y');
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  const stopAt = Math.min(now() + ADVANCED_TIME_BUDGET_MS, ctx.deadline ?? Infinity);
  let i = 0;
  while (i < src.length && out.length < MAX_MATCHES_PER_FORMAT) {
    // Out of time: keep what we found rather than stall the page.
    if ((i & 7) === 0 && now() > stopAt) break;
    // Everything before i stays visible for lookbehinds; only the text after
    // i is cut to the window.
    const win = src.slice(0, i + ADVANCED_MATCH_WINDOW);
    re.lastIndex = i;
    let m: RegExpExecArray | null = null;
    try {
      m = re.exec(win);
    } catch {
      return out;
    }
    if (m && m[0].length > 0) {
      const c = toCandidate(m, i, fmt, ctx);
      if (c) {
        out.push(c);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Back-compat entry point: the first match of any enabled format, or null.
 * Zone resolution: an explicit zone token wins, otherwise `assumedZone`.
 */
export function parseCustom(
  text: string,
  assumedZone: string,
  formats: readonly CustomFormat[],
  dateOnlyPolicy: DateOnlyPolicy = 'midnight',
): ParsedTime | null {
  const src = text.trim();
  if (src.length === 0) return null;
  for (const fmt of formats) {
    const [first] = matchCustomFormat(src, fmt, { assumedZone, dateOnlyPolicy });
    if (first) return first.parsed;
  }
  return null;
}
