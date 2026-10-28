import { fromZonedTime } from 'date-fns-tz';
import type { CustomFormat, ParsedTime } from '../types';

/**
 * Compiles user-defined custom formats into matchers and runs them against text.
 *
 * Two modes:
 *  - token mode (default, SAFE): the pattern uses named tokens like YYYY/MM/DD
 *    HH:mm:ss. We translate each token to a bounded regex fragment and escape
 *    every literal character, so a user can never express a catastrophic-
 *    backtracking pattern.
 *  - advanced mode: the pattern is a raw JS regex with named groups. We compile
 *    it, reject anything that cannot compile, and run it under an input-length
 *    guard. Still bounded because selection/input text is small.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Order matters: longer tokens first so "YYYY" is consumed before "YY".
const TOKENS: ReadonlyArray<[token: string, group: string, frag: string]> = [
  ['YYYY', 'y', '(?<y>\\d{4})'],
  ['MONTH', 'moName', '(?<moName>[A-Za-z]{3,9})'],
  ['MON', 'moName', '(?<moName>[A-Za-z]{3,9})'],
  ['MM', 'mo', '(?<mo>\\d{2})'],
  ['DD', 'd', '(?<d>\\d{2})'],
  ['HH', 'h', '(?<h>\\d{2})'],
  ['mm', 'mi', '(?<mi>\\d{2})'],
  ['ss', 's', '(?<s>\\d{2})'],
  ['YY', 'yy', '(?<yy>\\d{2})'],
  ['A', 'ap', '(?<ap>[AaPp][Mm])'],
  ['TZ', 'zone', '(?<zone>Z|[A-Za-z]{2,5}|[+-]\\d{2}:?\\d{2})'],
  ['M', 'mo', '(?<mo>\\d{1,2})'],
  ['D', 'd', '(?<d>\\d{1,2})'],
  ['H', 'h', '(?<h>\\d{1,2})'],
];

function escapeLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate a token pattern into a safe regex source. Returns null if empty. */
export function compileTokenPattern(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 120) return null;
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    let matched = false;
    for (const [tok, , frag] of TOKENS) {
      if (pattern.startsWith(tok, i)) {
        out += frag;
        i += tok.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = pattern[i] ?? '';
      // Collapse runs of whitespace in the pattern to \s+ for tolerance.
      out += /\s/.test(ch) ? '\\s+' : escapeLiteral(ch);
      i += 1;
    }
  }
  try {
    return new RegExp(out);
  } catch {
    return null;
  }
}

/** Compile an advanced raw-regex pattern. Rejects uncompilable input. */
export function compileAdvancedPattern(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 300) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function monthFromName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  return MONTHS[name.toLowerCase()];
}

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

function offsetToken(tok: string): string | null {
  if (tok === 'Z') return '+00:00';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tok);
  if (m) return `${m[1]}${m[2]}:${m[3]}`;
  return null;
}

/**
 * Run all enabled custom formats against `text`. Returns the first match built
 * into a ParsedTime, or null. Zone resolution: an explicit offset token wins,
 * otherwise the value is assumed in `assumedZone`.
 */
export function parseCustom(
  text: string,
  assumedZone: string,
  formats: readonly CustomFormat[],
): ParsedTime | null {
  const src = text.trim();
  if (src.length === 0 || src.length > 400) return null;

  for (const fmt of formats) {
    if (!fmt.enabled) continue;
    const re = fmt.advanced
      ? compileAdvancedPattern(fmt.pattern)
      : compileTokenPattern(fmt.pattern);
    if (!re) continue;

    let m: RegExpExecArray | null;
    try {
      m = re.exec(src);
    } catch {
      continue;
    }
    if (!m) continue;

    const g = (m.groups ?? {}) as Record<string, string | undefined>;
    let year = num(g.y);
    if (year === undefined && g.yy !== undefined) {
      const yy = Number(g.yy);
      year = yy < 70 ? 2000 + yy : 1900 + yy;
    }
    const month = num(g.mo) ?? monthFromName(g.moName);
    const day = num(g.d);
    if (year === undefined || month === undefined || day === undefined) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    let hour = num(g.h) ?? 0;
    const minute = num(g.mi) ?? 0;
    const second = num(g.s) ?? 0;
    if (g.ap) {
      const pm = g.ap.toLowerCase() === 'pm';
      if (hour < 1 || hour > 12) continue;
      hour = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    }
    if (hour > 23 || minute > 59 || second > 59) continue;

    const base = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
    const off = g.zone ? offsetToken(g.zone) : null;

    try {
      if (off) {
        const epochMs = Date.parse(`${base}${off}`);
        if (!Number.isFinite(epochMs)) continue;
        return {
          epochMs,
          matchedText: m[0],
          sourceZone: off === '+00:00' && g.zone === 'Z' ? 'UTC' : off,
          assumedZone,
          assumed: false,
          kind: 'custom',
        };
      }
      const epochMs = fromZonedTime(base, assumedZone).getTime();
      if (!Number.isFinite(epochMs)) continue;
      return {
        epochMs,
        matchedText: m[0],
        sourceZone: null,
        assumedZone,
        assumed: true,
        kind: 'custom',
      };
    } catch {
      continue;
    }
  }
  return null;
}
