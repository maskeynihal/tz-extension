// Pure helpers for the world clock: no React, no DOM. Unit-tested through
// the Clock component and directly where the maths is fiddly.
import {
  displayZoneName,
  offsetMinutesAt,
  resolveZone,
  sameZone,
  wallClockToInstant,
  zoneLabel,
} from '../lib/tz';
import { wallFieldsAt } from '../lib/wallclock';
import { describeWallClock } from '../lib/wall-note';
import type { Preferences } from '../types';

/** Scrubber range, in 15-minute steps: −12 h … +36 h. */
export const STEP_MINUTES = 15;
export const SCRUB_MIN_STEPS = -48;
export const SCRUB_MAX_STEPS = 144;

const STEP_MS = STEP_MINUTES * 60_000;
const MINUTE_MS = 60_000;

/**
 * The instant every card shows. Live (`steps === 0`) is the current time.
 * While planning with the slider it starts from the current quarter hour so
 * planned times land on :00 / :15 / :30 / :45 in every real-world zone.
 * `exact` (a "+24h"-style preset) starts from the current minute instead, so
 * "+24h" from 12:43 is 12:43 tomorrow. Both hold still between minutes.
 */
export function shownInstant(nowMs: number, steps: number, exact = false): number {
  if (steps === 0) return nowMs;
  const unit = exact ? MINUTE_MS : STEP_MS;
  return Math.floor(nowMs / unit) * unit + steps * STEP_MS;
}

/**
 * Whole minutes from the current minute to the planned instant: the honest
 * "from now" figure. A snapped plan from 12:43 at +24h is 12:30 tomorrow,
 * which is 23h 47m away; an exact preset is 24h.
 */
export function minutesFromNow(nowMs: number, steps: number, exact = false): number {
  if (steps === 0) return 0;
  return Math.round((shownInstant(nowMs, steps, exact) - Math.floor(nowMs / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/**
 * "+5h 45m", "−9h", "−30m"; `null` when the offsets are equal. A relative
 * difference, not an offset anyone pastes into a tool, so it keeps the
 * typographic minus.
 */
export function formatDiff(minutes: number): string | null {
  if (minutes === 0) return null;
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean);
  return `${sign}${parts.join(' ')}`;
}

/** Spoken form for screen readers: "5 hours 45 minutes ahead of home". */
export function describeDiff(minutes: number): string {
  if (minutes === 0) return 'same time as home';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [
    h ? `${h} hour${h === 1 ? '' : 's'}` : '',
    m ? `${m} minute${m === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `${parts.join(' ')} ${minutes > 0 ? 'ahead of' : 'behind'} home`;
}

/** Minutes the zone is ahead of home at that instant (negative = behind). */
export function diffFromHome(epochMs: number, zone: string, home: string): number {
  return offsetMinutesAt(epochMs, zone) - offsetMinutesAt(epochMs, home);
}

/** "Today", "Tomorrow", "Yesterday", or "In 2 days" / "2 days ago" further out. */
export type RelativeDay = 'Yesterday' | 'Today' | 'Tomorrow' | `In ${number} days` | `${number} days ago`;

/**
 * A zone's wall clock at an instant, as a Date whose UTC fields are the local
 * fields. Built from the zone's own wall fields (as viewInZone reads them),
 * not a local-time Date, so the browser's own DST gaps can never shift it and
 * second-precise offsets (local mean time before 1900-ish: Kathmandu
 * +05:41:16) aren't rounded to the minute.
 */
export function wallDate(epochMs: number, zone: string): Date {
  const tz = resolveZone(zone)?.tz;
  const w = tz ? wallFieldsAt(epochMs, tz) : null;
  if (!w) return new Date(epochMs + offsetMinutesAt(epochMs, zone) * 60_000);
  const d = new Date(0);
  // setUTCFullYear, not Date.UTC, so years 0–99 aren't read as 19xx.
  d.setUTCFullYear(w.y, w.mo - 1, w.d);
  d.setUTCHours(w.h, w.mi, w.s, ((epochMs % 1000) + 1000) % 1000);
  return d;
}

function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/** Home's calendar day at an instant, as a day count (changes only at home's midnight). */
export function homeDayNumber(epochMs: number, home: string): number {
  return dayNumber(wallDate(epochMs, home));
}

/**
 * The zone's calendar day at `epochMs`, relative to home's real today.
 * `homeToday` is homeDayNumber(now, home); left out, it is home's day at
 * `epochMs` itself, which is the same thing while live. While planning it
 * must be given: a time planned for tomorrow at home is "Tomorrow", not
 * "Today".
 */
export function relativeDay(epochMs: number, zone: string, home: string, homeToday?: number): RelativeDay {
  const diff = dayNumber(wallDate(epochMs, zone)) - (homeToday ?? homeDayNumber(epochMs, home));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return diff > 0 ? `In ${diff} days` : `${-diff} days ago`;
}

export type DayPhase = 'night' | 'dawn' | 'day' | 'dusk';

/**
 * A simple, location-free day/night heuristic by local hour:
 * dawn 06–08, day 08–18, dusk 18–20, night 20–06.
 */
export function dayPhase(hour: number): DayPhase {
  if (hour >= 6 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 18) return 'day';
  if (hour >= 18 && hour < 20) return 'dusk';
  return 'night';
}

export type WorkState = 'work' | 'edge' | 'off';

export interface WorkStatus {
  readonly state: WorkState;
  readonly text: string;
}

/**
 * Whether a local wall-clock moment is inside business hours (09:00–18:00,
 * Monday–Friday). An hour or two either side is "edge" (reachable, but early
 * or late).
 */
export function workStatus(hour: number, minute: number, weekday: number): WorkStatus {
  const t = hour * 60 + minute;
  if (weekday === 0 || weekday === 6) return { state: 'off', text: 'Weekend' };
  if (t >= 9 * 60 && t < 18 * 60) return { state: 'work', text: 'Working hours' };
  if (t >= 7 * 60 && t < 9 * 60) return { state: 'edge', text: 'Early, before work' };
  if (t >= 18 * 60 && t < 21 * 60) return { state: 'edge', text: 'Evening, after work' };
  return { state: 'off', text: 'Outside working hours' };
}

/** Local wall-clock parts of an instant in a zone. */
export interface WallParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

export function wallParts(epochMs: number, zone: string): WallParts {
  const d = wallDate(epochMs, zone);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), weekday: d.getUTCDay() };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Clock face text: "3:04" + "05" + "PM", or "15:04" + "05" + "". */
export function clockText(p: WallParts, hour12: boolean): { main: string; seconds: string; meridiem: string } {
  if (hour12) {
    return { main: `${p.hour % 12 || 12}:${pad(p.minute)}`, seconds: pad(p.second), meridiem: p.hour < 12 ? 'AM' : 'PM' };
  }
  return { main: `${pad(p.hour)}:${pad(p.minute)}`, seconds: pad(p.second), meridiem: '' };
}

/** "Tuesday, 4 Nov" style date for the zone, in the reader's locale. */
export function dateText(epochMs: number, zone: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(wallDate(epochMs, zone));
  } catch {
    return '';
  }
}

/** Fraction of the local day elapsed, 0…1. */
export function dayProgress(p: WallParts): number {
  return (p.hour * 60 + p.minute) / 1440;
}

/**
 * A friendly place name, from the zone's current canonical name, so a legacy
 * id ("Asia/Katmandu", "America/Argentina/ComodRivadavia") reads like every
 * other surface ("Kathmandu", "Catamarca").
 */
export function zonePlace(zone: string): string {
  return displayZoneName(zone);
}

/**
 * The secondary line under a card's title: the zone's label as the card and
 * popup write it (zoneLabel, the IANA id with its underscores:
 * "America/St_Johns"), so the same zone reads the same everywhere. For
 * Etc/GMT±N, whose label is its offset, it is the IANA id ("Etc/GMT+12").
 */
export function zoneDescription(zone: string): string {
  const r = resolveZone(zone);
  if (!r) return '';
  if (r.kind === 'iana') {
    if (r.short === 'UTC' || r.short === 'Etc/UTC') return 'Coordinated Universal Time';
    // Etc/GMT±N is titled by its offset ("UTC-12:00", which zoneLabel also
    // returns); the subtitle names the IANA id so the card doesn't say the
    // same thing twice (note the inverted sign: Etc/GMT+12 is UTC-12:00).
    if (r.short !== r.long) return r.long;
    return zoneLabel(zone);
  }
  if (r.kind === 'offset') return 'Fixed offset, no daylight saving';
  return r.long;
}

/**
 * Offset vs UTC for display: "UTC+05:45", "UTC-08:00", "UTC±0". ASCII
 * hyphen-minus, like every other offset, so copied text pastes cleanly.
 */
export function utcOffsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC±0';
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Home first, then the target zones that are not the home zone. */
export function visibleZones(prefs: Pick<Preferences, 'homeZone' | 'targetZones'>): string[] {
  const others: string[] = [];
  for (const z of prefs.targetZones) {
    if (sameZone(z, prefs.homeZone)) continue;
    if (others.some((o) => sameZone(o, z))) continue;
    others.push(z);
  }
  return [prefs.homeZone, ...others];
}

/**
 * Write a new order of the non-home zones back into targetZones, keeping any
 * entries equal to the home zone in their slots (the popup lists them).
 */
export function applyOrder(targetZones: readonly string[], home: string, order: readonly string[]): string[] {
  const queue = [...order];
  const out: string[] = [];
  for (const z of targetZones) {
    if (sameZone(z, home)) out.push(z);
    else if (order.includes(z)) {
      const next = queue.shift();
      if (next !== undefined) out.push(next);
    }
    // Duplicates (aliases of a zone already shown) are dropped.
  }
  // Anything in `order` that was not in targetZones (should not happen) goes last.
  return [...out, ...queue];
}

/** Move one item of a list by `delta` places, clamped. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(clamped, 0, item);
  return next;
}

/** Make `zone` home; the previous home stays on the board in that zone's slot. */
export function makeHome(prefs: Preferences, zone: string): Preferences {
  const prev = prefs.homeZone;
  if (sameZone(prev, zone)) return prefs;
  let targets = [...prefs.targetZones];
  if (!targets.some((z) => sameZone(z, prev))) {
    const i = targets.findIndex((z) => z === zone);
    if (i >= 0) targets.splice(i, 0, prev);
    else targets = [prev, ...targets];
  }
  return { ...prefs, homeZone: zone, targetZones: targets };
}

// ---------------------------------------------------------------------------
// Planning: the scrubber's offset, or an outright date and time.
// ---------------------------------------------------------------------------

/**
 * What the board shows.
 * - `live`: the current time.
 * - `offset`: the scrubber, −12 h … +36 h in 15-minute steps (see shownInstant).
 * - `absolute`: an instant picked outright (the date picker, or a card's own
 *   slider), which the scrubber then shifts by `steps` quarter hours, −12 h …
 *   +36 h around it, exactly as it shifts the current time when live. The
 *   slider used to lock while a pick was applied; it moves from the pick now.
 *
 * A union rather than extra arguments on shownInstant/minutesFromNow: those
 * two carry the scrubber's snapping rules, which an absolute pick has nothing
 * to do with, and their signatures are depended on all over the tests.
 */
export type Plan =
  | { readonly kind: 'live' }
  | { readonly kind: 'offset'; readonly steps: number; readonly exact: boolean }
  | { readonly kind: 'absolute'; readonly epochMs: number; readonly steps: number };

export const LIVE: Plan = { kind: 'live' };

/** A scrubber plan. `steps === 0` is live, so callers need no special case. */
export function offsetPlan(steps: number, exact = false): Plan {
  return steps === 0 ? LIVE : { kind: 'offset', steps, exact };
}

/**
 * A picked instant, shifted by `steps` of the scrubber. Anything non-finite
 * falls back to live rather than showing NaN.
 */
export function absolutePlan(epochMs: number, steps = 0): Plan {
  return Number.isFinite(epochMs) ? { kind: 'absolute', epochMs, steps } : LIVE;
}

/** The scrubber's position for a plan: steps from now, or from the pick. */
export function planSteps(plan: Plan): number {
  return plan.kind === 'live' ? 0 : plan.steps;
}

/**
 * Move the scrubber to `steps` without losing what it is counted from: a
 * live or offset plan counts from now, a picked one from the pick. `exact`
 * only means anything from now (see shownInstant).
 */
export function shiftPlan(plan: Plan, steps: number, exact = false): Plan {
  if (plan.kind === 'absolute') return absolutePlan(plan.epochMs, steps);
  return offsetPlan(steps, exact);
}

export function isPlanning(plan: Plan): boolean {
  return plan.kind !== 'live';
}

/** The instant every card shows for a plan. */
export function planInstant(nowMs: number, plan: Plan): number {
  if (plan.kind === 'live') return nowMs;
  if (plan.kind === 'absolute') return plan.epochMs + plan.steps * STEP_MS;
  return shownInstant(nowMs, plan.steps, plan.exact);
}

/**
 * Whole minutes from now to the planned instant, for every kind of plan: the
 * same honest "from now" figure minutesFromNow gives the scrubber, so a pick
 * two weeks out reports its real distance.
 *
 * An absolute pick counts from the *nearest* minute, not the one just gone.
 * Flooring was asymmetric — it pushed future distances up by the seconds
 * already elapsed (a pick 3 d 0 h 34.03 m away read "+3d 35m") while past
 * ones rounded toward zero — so the same gap read differently depending on
 * its sign. Rounding keeps the seconds out of the figure, as the scrubber
 * does, and is wrong by at most 30 s in either direction.
 */
export function planMinutesFromNow(nowMs: number, plan: Plan): number {
  if (plan.kind === 'live') return 0;
  if (plan.kind === 'offset') return minutesFromNow(nowMs, plan.steps, plan.exact);
  return Math.round((planInstant(nowMs, plan) - Math.round(nowMs / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/**
 * The plan that shows `target`, chosen on one card's own slider. A picked
 * plan keeps its pick and only moves the scrubber when the target is a whole
 * number of steps away and in range, so the main thumb travels with the
 * card's; otherwise (or from live) the target becomes the new pick.
 */
export function retimePlan(plan: Plan, target: number): Plan {
  if (plan.kind === 'absolute') {
    const delta = target - plan.epochMs;
    const steps = delta / STEP_MS;
    if (Number.isInteger(steps) && steps >= SCRUB_MIN_STEPS && steps <= SCRUB_MAX_STEPS) {
      return absolutePlan(plan.epochMs, steps);
    }
  }
  return absolutePlan(target);
}

/**
 * A card slider over one calendar day in a zone, in real 15-minute steps
 * from that day's first instant. Counting real time rather than wall-clock
 * positions is what lets the arrow keys walk through a DST change: a
 * spring-forward day simply has 92 steps, a fall-back day 100, and the
 * repeated hour can be reached twice. `startMs` is local midnight (or, where
 * a zone skips midnight, the first instant of the day).
 */
export interface DaySlider {
  readonly startMs: number;
  /** The last step, i.e. the quarter hour before the next day starts. */
  readonly max: number;
  /** The planned instant's step, floored to a quarter hour and clamped. */
  readonly value: number;
}

export function daySlider(epochMs: number, zone: string): DaySlider | null {
  const today = wallPick(epochMs, zone);
  const midnight = { ...today, h: 0, mi: 0 };
  const start = wallClockToInstant(pickToIso(midnight), zone)?.epochMs;
  const next = wallClockToInstant(pickToIso(addDays(midnight, 1)), zone)?.epochMs;
  if (start === undefined || next === undefined || !Number.isFinite(start) || !Number.isFinite(next) || next <= start) {
    return null;
  }
  const max = Math.ceil((next - start) / STEP_MS) - 1;
  const value = Math.max(0, Math.min(max, Math.floor((epochMs - start) / STEP_MS)));
  return { startMs: start, max, value };
}

const DAY_MINUTES = 1440;

/**
 * "from now" for any distance. Hours and minutes within two days ("+36h",
 * "+23h 47m"), days beyond ("+3d 4h", "+10d"). Two days, because the
 * scrubber's own range tops out at +36 h — so every slider plan keeps reading
 * in hours, as it always has — and a meeting inside two days is still thought
 * of in hours.
 */
export function formatSpan(minutes: number): string | null {
  if (Math.abs(minutes) < 2 * DAY_MINUTES) return formatDiff(minutes);
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const parts = [`${Math.floor(abs / DAY_MINUTES)}d`];
  const h = Math.floor((abs % DAY_MINUTES) / 60);
  const m = abs % 60;
  // A unit is only dropped off the end, never out of the middle: "+3d 35m"
  // read as if an hours figure had gone missing, so once minutes are shown a
  // zero hours is shown with them ("+3d 0h 35m"). "+10d" still stops at days.
  if (h || m) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return `${sign}${parts.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Calendar arithmetic for the picker. All of it on UTC fields: a local Date
// would let the browser's own zone (and its DST gaps) decide which day a cell
// belongs to.
// ---------------------------------------------------------------------------

/** A date and time as written on a wall clock. `mo` is 1-12. */
export interface WallPick {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
}

export interface YearMonth {
  readonly y: number;
  readonly mo: number;
}

/** Midnight of a calendar day read as UTC. setUTCFullYear, so years 0–99 aren't 19xx. */
function dayUtc(y: number, mo: number, d: number): number {
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  return t.getTime();
}

/** Length of a month, 1-12, leap years included. */
export function daysInMonth(y: number, mo: number): number {
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31;
}

/** Weekday of a calendar day, 0 = Sunday, as the rest of the model numbers them. */
export function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(dayUtc(y, mo, d)).getUTCDay();
}

/** Step a month, carrying the year. */
export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const n = ym.y * 12 + (ym.mo - 1) + delta;
  return { y: Math.floor(n / 12), mo: (((n % 12) + 12) % 12) + 1 };
}

/** Step a pick by whole days, keeping its time of day. */
export function addDays(pick: WallPick, delta: number): WallPick {
  const d = new Date(dayUtc(pick.y, pick.mo, pick.d) + delta * 86_400_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: pick.h, mi: pick.mi };
}

/** A pick moved into another month, clamped to that month's length (31 Jan → 28 Feb). */
export function withMonth(pick: WallPick, ym: YearMonth): WallPick {
  return { ...pick, y: ym.y, mo: ym.mo, d: Math.min(pick.d, daysInMonth(ym.y, ym.mo)) };
}

/**
 * The weeks of a month as day numbers, Sunday first, with nulls padding the
 * first and last weeks so every row is seven cells.
 */
export function monthGrid(y: number, mo: number): (number | null)[][] {
  const cells: (number | null)[] = Array<number | null>(weekdayOf(y, mo, 1)).fill(null);
  for (let d = 1; d <= daysInMonth(y, mo); d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The wall-clock date and time of an instant in a zone, to seed the picker. */
export function wallPick(epochMs: number, zone: string): WallPick {
  const d = wallDate(epochMs, zone);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  };
}

/** "2026-03-08T02:30:00", the shape wallClockToInstant parses. */
export function pickToIso(pick: WallPick): string {
  return `${String(pick.y).padStart(4, '0')}-${pad(pick.mo)}-${pad(pick.d)}T${pad(pick.h)}:${pad(pick.mi)}:00`;
}

export interface PickReading {
  readonly epochMs: number;
  /** The shared note when the picked time fell in a DST gap or overlap, else null. */
  readonly note: string | null;
}

/**
 * The instant a picked date and time names on `zone`'s wall clock, with the
 * project's gap and overlap conventions and the one shared wording. Goes
 * through wallClockToInstant, like the popup's readWallInput, so no local
 * Date is built anywhere and the browser's zone cannot leak in.
 */
export function readWallPick(pick: WallPick, zone: string, hour12 = false): PickReading | null {
  const r = wallClockToInstant(pickToIso(pick), zone);
  if (!r || !Number.isFinite(r.epochMs)) return null;
  return { epochMs: r.epochMs, note: r.wallClock ? describeWallClock(r.wallClock, r.epochMs, zone, hour12) : null };
}
