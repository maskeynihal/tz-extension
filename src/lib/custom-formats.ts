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
 *  - token mode (default, SAFE): the pattern uses named tokens like YYYY/MM/DD
 *    HH:mm:ss. Each token becomes a bounded regex fragment and every literal
 *    character is escaped, so a user can never express a catastrophic-
 *    backtracking pattern.
 *  - advanced mode: the pattern is a raw JS regex with named groups. It must
 *    compile, use only known group names, not match empty text, and not nest
 *    unbounded repeats (a best-effort ReDoS guard). It also only ever sees the
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
  '(?<zone>Z|[+-]\\d{2}:?\\d{2}|(?:GMT|UTC)[+-]\\d{1,2}(?::?\\d{2})?|[A-Za-z]{2,5})';

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
  | { readonly ok: true; readonly regex: RegExp; readonly groups: ReadonlySet<Field> }
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
  if (!hasDate && !hasTime) return 'The pattern needs date or time tokens (for example DD/MM/YYYY or HH:mm).';
  if (hasDate && !(hasMonth && has('d'))) {
    return 'A date needs both a month (MM, M, MMM or MMMM) and a day (DD, D or Do).';
  }
  if (has('mi') && !has('h')) return 'Minutes (mm) need an hour token (HH, H, hh or h).';
  if (has('s') && !has('mi')) return 'Seconds (ss) need minutes (mm).';
  if (has('ms') && !has('s')) return 'Milliseconds (SSS) need seconds (ss).';
  if (has('ap') && !has('h')) return 'AM/PM (A) needs an hour token (hh or h).';
  if (twelveHourTokens && !has('ap')) return 'hh and h are 12-hour clock tokens. Add A for AM/PM, or use HH or H.';
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
    pieces.push({ kind: 'literal', src: escapeLiteral(ch) });
    i += 1;
  }
  const fieldError = checkFields(groups, twelveHour);
  if (fieldError) return { ok: false, error: fieldError };

  // Do not start or end a match in the middle of a number or word.
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  const src =
    (first?.kind === 'token' ? '(?<![A-Za-z0-9])' : '') +
    pieces.map((p) => p.src).join('') +
    (last?.kind === 'token' ? '(?![A-Za-z0-9])' : '');
  try {
    return { ok: true, regex: new RegExp(src, 'g'), groups };
  } catch (e) {
    return { ok: false, error: `The pattern could not be compiled: ${(e as Error).message}` };
  }
}

/**
 * Best-effort ReDoS guard: true when a group containing an unbounded repeat
 * (+, *, {n,}) is itself repeated, e.g. (a+)+ or (\d+:?)*.
 */
export function hasNestedQuantifier(src: string): boolean {
  // One flag per open group: does it contain an unbounded repeat?
  const stack: boolean[] = [];
  const rest = (j: number): string => src.slice(j);
  const isUnbounded = (j: number): boolean =>
    src[j] === '+' || src[j] === '*' || (src[j] === '{' && /^\{\d+,\}/.test(rest(j)));
  // Any quantifier that allows more than one repetition.
  const isRepeat = (j: number): boolean => {
    if (src[j] === '+' || src[j] === '*') return true;
    if (src[j] !== '{') return false;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(rest(j));
    if (!m) return false;
    if (m[2] === undefined) return Number(m[1]) > 1;
    return m[3] === '' || Number(m[3]) > 1;
  };
  const markTop = (): void => {
    if (stack.length > 0) stack[stack.length - 1] = true;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') {
      stack.push(false);
      i++;
      continue;
    }
    if (c === ')') {
      const inner = stack.pop() ?? false;
      const next = i + 1;
      if (inner && isRepeat(next)) return true;
      if (inner || isUnbounded(next)) markTop();
      i = next;
      continue;
    }
    let atomEnd: number;
    if (c === '\\') {
      atomEnd = i + 2;
    } else if (c === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
      atomEnd = j + 1;
    } else {
      atomEnd = i + 1;
    }
    if (isUnbounded(atomEnd)) markTop();
    i = atomEnd;
  }
  return false;
}

/** Compile an advanced raw-regex pattern, or explain why it cannot be used. */
export function compileAdvancedFormat(pattern: string): CompileResult {
  if (!pattern || pattern.trim().length === 0) return { ok: false, error: 'Enter a regular expression.' };
  if (pattern.length > MAX_ADVANCED_PATTERN) {
    return { ok: false, error: `The regex is too long (max ${MAX_ADVANCED_PATTERN} characters).` };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (e) {
    return { ok: false, error: `Invalid regular expression: ${(e as Error).message}` };
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
  if (hasNestedQuantifier(pattern)) {
    return {
      ok: false,
      error: 'This regex repeats a group that already repeats, like (a+)+. That can freeze the page, so it is not allowed.',
    };
  }
  try {
    const probe = new RegExp(pattern);
    if (probe.exec('') !== null) return { ok: false, error: 'This regex can match empty text. Make at least one part required.' };
  } catch {
    /* compiled above */
  }
  return { ok: true, regex, groups };
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

export interface MatchContext {
  readonly assumedZone: string;
  readonly dateOnlyPolicy: DateOnlyPolicy;
  /** Injected for tests; defaults to Date.now(). */
  readonly nowMs?: number;
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
  const today = todayIn(zone ? zone.minutes : ctx.assumedZone, now);

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
  const src = fmt.advanced ? text.slice(0, ADVANCED_SCAN_LIMIT) : text;
  // Fresh regex per call: the cached one is shared and `g` regexes are stateful.
  const re = new RegExp(compiled.regex.source, 'g');
  const out: Candidate[] = [];
  let guard = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_MATCHES_PER_FORMAT && guard++ < 200) {
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
    const parsed = fromGroups(
      (m.groups ?? {}) as Record<string, string | undefined>,
      m[0],
      fmt,
      ctx,
    );
    if (parsed) {
      out.push({ parsed, index: m.index, length: m[0].length });
    } else {
      // Invalid values here; a valid match may still start inside this one.
      re.lastIndex = m.index + 1;
    }
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
