import type { ParsedTime } from '../types';
import { displayZoneName, isValidZone, offsetMinutesAt, viewInZone } from './tz';

/**
 * One wording, used by the in-page card, the popup and the website, for a
 * written time that did not happen exactly once in its zone (see
 * src/lib/wallclock.ts for how such times are read).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "02:30:00" → "02:30"; "2:30:00 AM" → "2:30 AM". Seconds stay when not zero. */
function shortTime(t: string): string {
  return t.replace(/^(\d{1,2}:\d{2}):00\b/, '$1');
}

/** "2024-03-10" → "10 Mar". */
function shortDay(isoDate: string): string {
  const [, mo, d] = isoDate.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[mo - 1] ?? ''}`;
}

/**
 * The note for an instant read from a gap or overlap in `zone`.
 * - gap: "02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30."
 * - ambiguous: "01:30 happens twice on 3 Nov in New York; showing the first (EDT)."
 */
export function describeWallClock(
  kind: 'gap' | 'ambiguous',
  epochMs: number,
  zone: string,
  hour12: boolean,
): string {
  const place = displayZoneName(zone);
  const v = viewInZone(epochMs, zone, hour12);
  if (kind === 'gap') {
    // The written time is the instant read with the offset in force before
    // the jump. 26 h back is before any change that can make this gap
    // (Samoa's skipped day included).
    const before = offsetMinutesAt(epochMs - 26 * 3_600_000, zone);
    const written = viewInZone(epochMs + before * 60_000, 'UTC', hour12);
    // A jump across midnight (Samoa skipped all of 30 Dec 2011) lands on
    // another day: say which.
    const shown = v.date === written.date ? shortTime(v.time) : `${shortTime(v.time)} on ${shortDay(v.date)}`;
    return `${shortTime(written.time)} doesn't exist on ${shortDay(written.date)} in ${place} (clocks jump forward); shown as ${shown}.`;
  }
  // A real abbreviation ("EDT", "BST") reads better than "GMT+1"; else the offset.
  const which = /^[A-Z]{2,5}$/.test(v.abbrev) ? v.abbrev : `UTC${v.offset}`;
  return `${shortTime(v.time)} happens twice on ${shortDay(v.date)} in ${place}; showing the first (${which}).`;
}

/** The zone id a parsed value was read in, when it can be told from the result. */
function readZone(p: ParsedTime): string | null {
  if (p.assumed || p.sourceZone === null) return isValidZone(p.assumedZone) ? p.assumedZone : null;
  if (isValidZone(p.sourceZone)) return p.sourceZone;
  // Abbreviation labels name their zone: "ET (America/New_York)".
  const iana = /\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/.exec(p.sourceZone)?.[1];
  return iana && isValidZone(iana) ? iana : null;
}

/** The note for a parsed value with `wallClock` set; null otherwise. */
export function wallClockNote(p: ParsedTime, hour12: boolean): string | null {
  if (!p.wallClock) return null;
  const zone = readZone(p);
  if (zone) return describeWallClock(p.wallClock, p.epochMs, zone, hour12);
  return p.wallClock === 'gap'
    ? "This time doesn't exist on this day (clocks jump forward); shown as the time after the jump."
    : 'This time happens twice on this day; showing the first.';
}
