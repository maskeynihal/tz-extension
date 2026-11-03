import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveLocalZone, type Preferences, type Theme } from '../types';
import { loadPreferences, onPreferencesChanged, savePreferences } from '../lib/storage';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { isValidZone, offsetMinutesAt, sameZone } from '../lib/tz';
import { ZonePicker } from '../popup/ZonePicker';
import {
  LIVE,
  SCRUB_MAX_STEPS,
  SCRUB_MIN_STEPS,
  STEP_MINUTES,
  absolutePlan,
  addDays,
  addMonths,
  applyOrder,
  clockText,
  dateText,
  dayPhase,
  daySlider,
  daysInMonth,
  describeDiff,
  diffFromHome,
  formatDiff,
  formatSpan,
  isPlanning,
  makeHome,
  monthGrid,
  moveItem,
  planInstant,
  planMinutesFromNow,
  planSteps,
  readWallPick,
  retimePlan,
  shiftPlan,
  relativeDay,
  homeDayNumber,
  utcOffsetLabel,
  visibleZones,
  wallPick,
  wallParts,
  withMonth,
  workStatus,
  zoneDescription,
  zonePlace,
  type Plan,
  type WallPick,
  type YearMonth,
} from './model';
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ExpandIcon,
  GripIcon,
  HomeIcon,
  PhaseIcon,
  SettingsIcon,
  ShrinkIcon,
} from './icons';

const SUGGESTED = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function canAnimate(el: Element): boolean {
  return typeof (el as HTMLElement).animate === 'function' && !prefersReducedMotion();
}

function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === 'function'
  );
}

/** Live "now", ticking on each second boundary; paused while the tab is hidden. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (): void => {
      // A few ms past the boundary so the new second has definitely begun.
      const delay = 1000 - (Date.now() % 1000) + 5;
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, delay);
    };
    const start = (): void => {
      stop();
      setNow(Date.now());
      schedule();
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return now;
}

interface DragState {
  readonly zone: string;
  readonly pointerId: number;
  readonly el: HTMLElement;
  readonly grabX: number;
  readonly grabY: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

export interface ClockAppProps {
  /** Rendered inside a host page that already has a banner and main landmark (the website). */
  readonly embedded?: boolean;
}

export function ClockApp({ embedded = false }: ClockAppProps): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const prefsRef = useRef<Preferences | null>(null);
  prefsRef.current = prefs;
  const now = useNow();
  const [plan, setPlan] = useState<Plan>(LIVE);
  // What the picker was last given, kept beside the plan so the DST note and
  // the trigger's label can be re-derived when the clock format changes.
  const [pick, setPick] = useState<WallPick | null>(null);
  const [scrubbed, setScrubbed] = useState(false);
  const [status, setStatus] = useState('');
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingZone, setDraggingZone] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // --- Preferences: load, follow external edits, persist ours. ---
  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (alive) setPrefs(p);
    });
    const unsub = onPreferencesChanged((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const update = useCallback((next: Preferences, message?: string) => {
    setPrefs(next);
    if (message) setStatus(message);
    void savePreferences(next).then((r) => {
      if (!r.ok) setStatus(r.error);
    });
  }, []);

  const theme: Theme = prefs?.theme ?? 'system';
  useEffect(() => {
    applyThemeToDocument(theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyThemeToDocument('system'));
  }, [theme]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = (): void => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const home = prefs?.homeZone ?? resolveLocalZone();
  const hour12 = prefs?.hour12 ?? true;
  const visible = useMemo(
    () => (prefs ? visibleZones(prefs) : []),
    [prefs],
  );
  const others = useMemo(() => dragOrder ?? visible.slice(1), [dragOrder, visible]);
  const othersRef = useRef(others);
  othersRef.current = others;

  const instant = planInstant(now, plan);
  const planning = isPlanning(plan);
  // Day tags count from home's real today, so a plan for tomorrow says so.
  const homeToday = homeDayNumber(now, home);

  const changePlan = useCallback((next: Plan) => {
    setScrubbed(true);
    setPlan(next);
    // The scrubber and "Now" both leave the picker with nothing applied.
    if (next.kind !== 'absolute') setPick(null);
  }, []);

  const applyPick = useCallback(
    (next: WallPick) => {
      const r = readWallPick(next, home, hour12);
      if (!r) return;
      setScrubbed(true);
      setPick(next);
      setPlan(absolutePlan(r.epochMs));
    },
    [home, hour12],
  );

  // Recomputed rather than stored, so toggling 12/24-hour rewrites the note
  // in the format the reader just chose.
  const pickNote = useMemo(
    () => (pick ? readWallPick(pick, home, hour12)?.note ?? null : null),
    [pick, home, hour12],
  );

  // A card's own slider names an instant on that zone's clock. It keeps the
  // pick (and the scrubber counts on from it) when it can; when it cannot,
  // the target is the new pick, and the picker's wall fields no longer
  // describe it, so they go.
  const planRef = useRef(plan);
  planRef.current = plan;
  const retime = useCallback((target: number) => {
    const prev = planRef.current;
    const next = retimePlan(prev, target);
    setScrubbed(true);
    if (prev.kind !== 'absolute' || next.kind !== 'absolute' || next.epochMs !== prev.epochMs) setPick(null);
    setPlan(next);
  }, []);

  // A pick is held twice over: as wall fields (the trigger's label, the DST
  // note) and as the instant every card shows. Changing home afterwards — a
  // card's "Make home", or Settings — re-renders the first half for the new
  // zone, so the second half has to follow or the board sits on an instant
  // nothing on screen describes. The written date and time is what the user
  // chose, so that is what is kept: it is re-read against the new home, and
  // the move is announced.
  const homeRef = useRef(home);
  useEffect(() => {
    const prev = homeRef.current;
    homeRef.current = home;
    if (sameZone(prev, home) || !pick) return;
    const r = readWallPick(pick, home, hour12);
    if (!r) {
      setPick(null);
      setPlan(LIVE);
      setStatus(`Home is now ${zonePlace(home)}; the planned time could not be read there, so the clocks are live again.`);
      return;
    }
    // The scrubber's shift from the pick is kept: it was counted from the pick.
    setPlan((p) => absolutePlan(r.epochMs, p.kind === 'absolute' ? p.steps : 0));
    setStatus(`Home is now ${zonePlace(home)}; the planned time is now read as ${zonePlace(home)}'s wall clock.`);
    // `pick` and `hour12` are read, not reacted to: only a home change acts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  // --- FLIP animation + focus restore after reorders. ---
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const gridRef = useRef<HTMLUListElement>(null);
  const lastPos = useRef(new Map<string, { x: number; y: number }>());
  const lastOrderKey = useRef('');
  const pendingFocus = useRef<{ zone: string; selector: string } | null>(null);
  const drag = useRef<DragState | null>(null);
  const orderKey = [home, ...others].join('|');

  const positionDragged = useCallback(() => {
    const d = drag.current;
    const grid = gridRef.current;
    if (!d || !grid) return;
    const g = grid.getBoundingClientRect();
    const x = d.lastX - g.left - d.grabX - d.el.offsetLeft;
    const y = d.lastY - g.top - d.grabY - d.el.offsetTop;
    d.el.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  /** Card positions relative to the grid. Reads layout, so only on demand. */
  const measure = useCallback((): Map<string, { x: number; y: number }> => {
    const next = new Map<string, { x: number; y: number }>();
    for (const [zone, el] of itemRefs.current) next.set(zone, { x: el.offsetLeft, y: el.offsetTop });
    return next;
  }, []);

  // FLIP runs only when the card order changes, not on every one-second tick:
  // reading offsetLeft/offsetTop of every card forces a layout.
  useLayoutEffect(() => {
    const changed = lastOrderKey.current !== '' && lastOrderKey.current !== orderKey;
    const next = measure();
    for (const [zone, pos] of next) {
      const el = itemRefs.current.get(zone);
      const prev = lastPos.current.get(zone);
      if (!el || !changed || !prev || zone === drag.current?.zone || !canAnimate(el)) continue;
      const dx = prev.x - pos.x;
      const dy = prev.y - pos.y;
      if (dx !== 0 || dy !== 0) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
          duration: 220,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
    }
    lastPos.current = next;
    lastOrderKey.current = orderKey;
    if (drag.current?.moved) positionDragged();
  }, [orderKey, measure, positionDragged]);

  // The last positions go stale when the layout changes without a reorder
  // (window resize, cards growing); refresh them then, so the next FLIP starts
  // from where the cards really were.
  const hasGrid = prefs !== null;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const refresh = (): void => {
      if (!drag.current) lastPos.current = measure();
    };
    window.addEventListener('resize', refresh);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    ro?.observe(grid);
    return () => {
      window.removeEventListener('resize', refresh);
      ro?.disconnect();
    };
  }, [hasGrid, measure]);

  // Focus restore after a reorder, remove or make-home (cheap: a ref check).
  useLayoutEffect(() => {
    const pf = pendingFocus.current;
    if (pf) {
      pendingFocus.current = null;
      const target =
        itemRefs.current.get(pf.zone)?.querySelector<HTMLElement>(pf.selector) ??
        itemRefs.current.get(pf.zone) ??
        null;
      target?.focus();
    }
  });

  // --- Card actions ---
  const moveZone = useCallback(
    (zone: string, delta: number) => {
      const p = prefsRef.current;
      if (!p) return;
      const list = othersRef.current;
      const from = list.indexOf(zone);
      const to = Math.max(0, Math.min(list.length - 1, from + delta));
      if (from < 0 || to === from) return;
      const order = moveItem(list, from, to);
      pendingFocus.current = { zone, selector: '[data-handle]' };
      update(
        { ...p, targetZones: applyOrder(p.targetZones, p.homeZone, order) },
        `Moved ${zonePlace(zone)} to position ${to + 2} of ${order.length + 1}.`,
      );
    },
    [update],
  );

  const removeZone = useCallback(
    (zone: string) => {
      const p = prefsRef.current;
      if (!p) return;
      const list = othersRef.current;
      const i = list.indexOf(zone);
      const neighbour = list[i + 1] ?? list[i - 1];
      if (neighbour) pendingFocus.current = { zone: neighbour, selector: '[data-remove]' };
      else pickerRef.current?.querySelector<HTMLInputElement>('input')?.focus();
      update(
        { ...p, targetZones: p.targetZones.filter((z) => !sameZone(z, zone)) },
        `Removed ${zonePlace(zone)}.`,
      );
    },
    [update],
  );

  const setHome = useCallback(
    (zone: string) => {
      const p = prefsRef.current;
      if (!p) return;
      pendingFocus.current = { zone, selector: '[data-title]' };
      update(makeHome(p, zone), `${zonePlace(zone)} is now your home zone.`);
    },
    [update],
  );

  const addZone = useCallback(
    (zone: string) => {
      const p = prefsRef.current;
      if (!p || !isValidZone(zone)) return;
      if (visibleZones(p).some((z) => sameZone(z, zone))) {
        setStatus(`${zonePlace(zone)} is already on the board.`);
        return;
      }
      update({ ...p, targetZones: [...p.targetZones, zone] }, `Added ${zonePlace(zone)}.`);
    },
    [update],
  );

  // --- Pointer drag (handle only) ---
  const onHandlePointerDown = useCallback((zone: string, e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const el = itemRefs.current.get(zone);
    const grid = gridRef.current;
    if (!el || !grid) return;
    e.preventDefault();
    const g = grid.getBoundingClientRect();
    drag.current = {
      zone,
      pointerId: e.pointerId,
      el,
      grabX: e.clientX - g.left - el.offsetLeft,
      grabY: e.clientY - g.top - el.offsetTop,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not supported (tests) */
    }
  }, []);

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      const grid = gridRef.current;
      if (!d || !grid || e.pointerId !== d.pointerId) return;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.moved = true;
        setDraggingZone(d.zone);
      }
      positionDragged();
      const g = grid.getBoundingClientRect();
      const px = e.clientX - g.left;
      const py = e.clientY - g.top;
      const list = othersRef.current;
      for (const z of list) {
        if (z === d.zone) continue;
        const el = itemRefs.current.get(z);
        if (!el) continue;
        const inside =
          px >= el.offsetLeft &&
          px <= el.offsetLeft + el.offsetWidth &&
          py >= el.offsetTop &&
          py <= el.offsetTop + el.offsetHeight;
        if (inside) {
          setDragOrder(moveItem(list, list.indexOf(d.zone), list.indexOf(z)));
          break;
        }
      }
    },
    [positionDragged],
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const from = d.el.style.transform;
      d.el.style.transform = '';
      if (d.moved && from && canAnimate(d.el)) {
        d.el.animate([{ transform: from }, { transform: 'translate(0, 0)' }], {
          duration: 180,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
      setDraggingZone(null);
      const p = prefsRef.current;
      const order = othersRef.current;
      setDragOrder(null);
      if (!commit || !d.moved || !p) return;
      const before = visibleZones(p).slice(1);
      if (before.join('|') === order.join('|')) return;
      update(
        { ...p, targetZones: applyOrder(p.targetZones, p.homeZone, order) },
        `Moved ${zonePlace(d.zone)} to position ${order.indexOf(d.zone) + 2} of ${order.length + 1}.`,
      );
    },
    [update],
  );

  // Stable handlers, so a memoized ZoneCard only re-renders when what it shows changes.
  const dropDrag = useCallback(() => endDrag(true), [endDrag]);
  const cancelDrag = useCallback(() => endDrag(false), [endDrag]);
  const registerRef = useCallback((zone: string, el: HTMLLIElement | null) => {
    if (el) itemRefs.current.set(zone, el);
    else itemRefs.current.delete(zone);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);

  const openSettings =
    typeof chrome !== 'undefined' && typeof chrome.runtime?.openOptionsPage === 'function'
      ? () => chrome.runtime.openOptionsPage()
      : null;

  const localZone = resolveLocalZone();
  const localParts = wallParts(now, localZone);
  const localFace = clockText(localParts, hour12);

  const Outer = embedded ? 'div' : 'main';
  const titleId = useId();

  return (
    <div className="tzc-app" data-planning={planning || undefined}>
      <header className="tzc-top">
        <div className="tzc-brand">
          <h1 className="tzc-title" id={titleId}>
            World clock
          </h1>
          <p className="tzc-local">
            <span className="tzc-local-label">Your time</span>{' '}
            <span className="tzc-local-time">
              {localFace.main}
              <span className="tzc-local-sec">:{localFace.seconds}</span>
              {localFace.meridiem && ` ${localFace.meridiem}`}
            </span>{' '}
            <span className="tzc-local-date">
              {dateText(now, localZone, { weekday: 'short', day: 'numeric', month: 'short' })} · {zonePlace(localZone)}
            </span>
          </p>
        </div>
        <div className="tzc-controls">
          <div className="tzc-seg" role="group" aria-label="Clock format">
            <button
              type="button"
              className="tzc-seg-btn"
              aria-pressed={hour12}
              aria-label="12-hour clock"
              title="12-hour clock (3:04 PM)"
              disabled={!prefs}
              onClick={() => prefs && !prefs.hour12 && update({ ...prefs, hour12: true })}
            >
              12h
            </button>
            <button
              type="button"
              className="tzc-seg-btn"
              aria-pressed={!hour12}
              aria-label="24-hour clock"
              title="24-hour clock (15:04)"
              disabled={!prefs}
              onClick={() => prefs && prefs.hour12 && update({ ...prefs, hour12: false })}
            >
              24h
            </button>
          </div>
          <div className="tzc-seg" role="group" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="tzc-seg-btn"
                aria-pressed={theme === t}
                disabled={!prefs}
                onClick={() => prefs && prefs.theme !== t && update({ ...prefs, theme: t })}
              >
                {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          {(fullscreenSupported() || openSettings) && (
            // Kept together so the gear never wraps onto a line of its own.
            <div className="tzc-actions">
              {fullscreenSupported() && (
                <button
                  type="button"
                  className="tzc-icon-btn"
                  aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
                  title={isFullscreen ? 'Exit full screen' : 'Full screen'}
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? <ShrinkIcon /> : <ExpandIcon />}
                </button>
              )}
              {openSettings && (
                <button type="button" className="tzc-icon-btn" aria-label="Open settings" title="Settings" onClick={openSettings}>
                  <SettingsIcon />
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <Outer className="tzc-main" aria-labelledby={embedded ? undefined : titleId}>
        <div className="tzc-toolbar">
          <section className="tzc-panel tzc-add" aria-labelledby={`${titleId}-add`}>
            <h2 className="tzc-panel-title" id={`${titleId}-add`}>
              Add timezone
            </h2>
            <div ref={pickerRef}>
              <ZonePicker
                label="Add a timezone"
                placeholder="Search a city, UTC+5:45, PDT…"
                onSelect={addZone}
                exclude={visible}
                suggested={SUGGESTED}
                className="tzc-picker"
              />
            </div>
          </section>
          <Scrubber
            plan={plan}
            pick={pick}
            pickNote={pickNote}
            nowMs={now}
            home={home}
            hour12={hour12}
            scrubbed={scrubbed}
            onChange={changePlan}
            onPick={applyPick}
            idBase={titleId}
          />
        </div>

        <section className="tzc-board" aria-labelledby={`${titleId}-board`}>
          <h2 className="tzc-sr-only" id={`${titleId}-board`}>
            Clocks
          </h2>
          {!prefs ? (
            <p className="tzc-loading">Loading your timezones…</p>
          ) : (
            <ul className="tzc-grid" ref={gridRef}>
              {[home, ...others].map((zone, i) => (
                <ZoneCard
                  key={zone}
                  zone={zone}
                  isHome={i === 0}
                  position={i}
                  count={others.length + 1}
                  instant={instant}
                  homeToday={homeToday}
                  home={home}
                  hour12={hour12}
                  planning={planning}
                  onRetime={retime}
                  dragging={draggingZone === zone}
                  registerRef={registerRef}
                  onMove={moveZone}
                  onRemove={removeZone}
                  onMakeHome={setHome}
                  onHandlePointerDown={onHandlePointerDown}
                  onHandlePointerMove={onHandlePointerMove}
                  onHandlePointerUp={dropDrag}
                  onHandlePointerCancel={cancelDrag}
                />
              ))}
              {others.length === 0 && (
                <li className="tzc-empty">
                  <h3 className="tzc-empty-title">No other timezones yet</h3>
                  <p className="tzc-empty-text">
                    Add the places you work with to see their time, how far they are from you, and whether they are in
                    working hours.
                  </p>
                  <button
                    type="button"
                    className="tzc-btn tzc-btn-primary"
                    onClick={() => pickerRef.current?.querySelector<HTMLInputElement>('input')?.focus()}
                  >
                    Add a timezone
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>
        <p className="tzc-sr-only" role="status">
          {status}
        </p>
      </Outer>
    </div>
  );
}

interface ScrubberProps {
  readonly plan: Plan;
  /** The date and time the picker last applied, for its own label. */
  readonly pick: WallPick | null;
  /** The shared DST note for that pick, or null. */
  readonly pickNote: string | null;
  readonly nowMs: number;
  readonly home: string;
  readonly hour12: boolean;
  readonly scrubbed: boolean;
  readonly onChange: (plan: Plan) => void;
  readonly onPick: (pick: WallPick) => void;
  readonly idBase: string;
}

const SCALE_HOURS = [-12, -6, 0, 6, 12, 18, 24, 30, 36];

/**
 * Accessible name of a scale preset: "Plan 12 hours ahead", "Plan 6 hours
 * back", or, counted from a pick, "Plan 6 hours after the picked time".
 */
function scaleLabel(h: number, fromPick: boolean): string {
  if (h === 0) return fromPick ? 'Plan the picked time' : 'Plan the current time';
  if (fromPick) return `Plan ${Math.abs(h)} hours ${h > 0 ? 'after' : 'before'} the picked time`;
  return `Plan ${Math.abs(h)} hours ${h > 0 ? 'ahead' : 'back'}`;
}

/**
 * "Tue 15:30 in Kathmandu" for the planned instant. A picked plan can be any
 * distance away, where a weekday alone is ambiguous, so it names the date too.
 */
function planText(instant: number, home: string, hour12: boolean, withDate: boolean): string {
  const face = clockText(wallParts(instant, home), hour12);
  const day = dateText(instant, home, withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short' });
  return `${day} ${face.main}${face.meridiem ? ` ${face.meridiem}` : ''} in ${zonePlace(home)}`;
}

function Scrubber({ plan, pick, pickNote, nowMs, home, hour12, scrubbed, onChange, onPick, idBase }: ScrubberProps): JSX.Element {
  const planning = isPlanning(plan);
  // With a pick applied the slider counts from the pick, not from now: its
  // centre mark is the picked time and it shifts −12 h … +36 h around it.
  // It used to lock instead, because the one thing it could do then was
  // discard the pick; counting from it keeps the pick and keeps the slider.
  const fromPick = plan.kind === 'absolute';
  const steps = planSteps(plan);
  const exact = plan.kind === 'offset' && plan.exact;
  // Minute precision is all the summary needs, so it only changes when the
  // slider moves or a new minute starts, never every second.
  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  const instant = planInstant(minuteMs, plan);
  const withDate = fromPick;
  const planLabel = useMemo(() => planText(instant, home, hour12, withDate), [instant, home, hour12, withDate]);
  // The real distance from now: a snapped slider plan is not a round number,
  // and a picked one can be days out.
  // nowMs, not minuteMs: planMinutesFromNow rounds an absolute pick to the
  // nearest minute itself, and a pre-floored "now" would defeat that. An
  // offset plan floors internally, so it reads the same either way.
  const fromNow = formatSpan(planMinutesFromNow(nowMs, plan));
  // A pick can land on the current minute, where there is no distance to give.
  const distance = fromNow ? `, ${fromNow} from now` : '';
  const valueText = planning ? `${planLabel}${distance}` : 'Now';
  const live = planning
    ? `Planning ${planLabel}${distance}.`
    : scrubbed
      ? 'Showing the current time.'
      : '';
  const span = SCRUB_MAX_STEPS - SCRUB_MIN_STEPS;
  const frac = (s: number): string => String((s - SCRUB_MIN_STEPS) / span);
  const inputId = `${idBase}-scrub`;
  // The two ends are the −12h / +36h presets: from now they are exact from
  // the current minute, not snapped to a quarter hour.
  const shift = (v: number, exactEnd = v === SCRUB_MIN_STEPS || v === SCRUB_MAX_STEPS): void =>
    onChange(shiftPlan(plan, v, exactEnd));

  return (
    <section
      className="tzc-panel tzc-scrub"
      aria-labelledby={`${idBase}-scrub-h`}
      // Escape returns to now from any control in the planner (the slider,
      // a preset, the Now button), as the hint says.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !planning) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(LIVE);
      }}
    >
      <div className="tzc-scrub-head">
        <h2 className="tzc-panel-title" id={`${idBase}-scrub-h`}>
          Plan a time
        </h2>
        {planning ? (
          <span className="tzc-plan-chip">
            <span className="tzc-plan-label">Planning:</span> {planLabel}
            {fromNow && <span className="tzc-plan-delta"> · {fromNow} from now</span>}
          </span>
        ) : (
          <span className="tzc-live-chip">
            <span className="tzc-live-dot" aria-hidden="true" /> Live
          </span>
        )}
        <div className="tzc-scrub-tools">
          <DateTimePicker
            // What the board shows, on home's wall clock: once the slider
            // has moved off a pick, the trigger follows it.
            value={fromPick ? (steps === 0 && pick ? pick : wallPick(instant, home)) : null}
            nowMs={nowMs}
            home={home}
            hour12={hour12}
            onApply={onPick}
            onClear={() => onChange(LIVE)}
            idBase={idBase}
          />
          <button
            type="button"
            className="tzc-btn"
            onClick={() => onChange(LIVE)}
            disabled={!planning}
            aria-label="Back to now"
          >
            Now
          </button>
        </div>
      </div>
      {/* The note describes the picked wall time, so only while it is shown. */}
      {pickNote && fromPick && steps === 0 && (
        <p className="tzc-dst-note" aria-live="polite">
          {pickNote}
        </p>
      )}
      <div className="tzc-range-head">
        <label className="tzc-range-label" htmlFor={inputId}>
          Shift all clocks
        </label>
        <span className="tzc-range-zone" id={`${idBase}-scrub-zone`}>
          {zonePlace(home)} time (home)
        </span>
      </div>
      <div className="tzc-range-wrap" style={{ '--tzc-now': frac(0) } as React.CSSProperties}>
        <input
          id={inputId}
          className="tzc-range"
          type="range"
          min={SCRUB_MIN_STEPS}
          max={SCRUB_MAX_STEPS}
          step={1}
          value={steps}
          aria-valuetext={valueText}
          aria-describedby={`${idBase}-scrub-zone ${idBase}-scrub-hint`}
          onChange={(e) => shift(Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              shift(e.key === 'Home' ? SCRUB_MIN_STEPS : SCRUB_MAX_STEPS, true);
              return;
            }
            let next: number | null = null;
            if (e.key === 'PageUp') next = steps + 4;
            else if (e.key === 'PageDown') next = steps - 4;
            if (next === null) return;
            e.preventDefault();
            shift(Math.max(SCRUB_MIN_STEPS, Math.min(SCRUB_MAX_STEPS, next)));
          }}
        />
        <span className="tzc-range-now" aria-hidden="true" />
      </div>
      <ul className="tzc-scale" aria-label="Jump to">
        {SCALE_HOURS.map((h) => {
          const target = (h * 60) / STEP_MINUTES;
          return (
            <li key={h} style={{ '--f': frac(target) } as React.CSSProperties}>
              <button
                type="button"
                className="tzc-scale-btn"
                aria-label={scaleLabel(h, fromPick)}
                aria-pressed={steps === target && (fromPick || exact || target === 0)}
                onClick={() => shift(target, true)}
              >
                {h === 0 ? (fromPick ? 'Pick' : 'Now') : `${h > 0 ? '+' : '−'}${Math.abs(h)}h`}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="tzc-hint" id={`${idBase}-scrub-hint`}>
        {fromPick ? 'Counting from the picked time. ' : ''}Arrow keys move 15 minutes, Page Up/Down one hour. Escape,
        while this planner has focus, returns to now.
      </p>
      <p className="tzc-sr-only" aria-live="polite">
        {live}
      </p>
    </section>
  );
}

// --- Date and time picker ---------------------------------------------------

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * A Date whose UTC fields are the pick's, purely so Intl can name its month,
 * weekday and day. Same trick as model.wallDate: never a local Date, so the
 * browser's own zone (and its DST gaps) cannot shift a calendar cell.
 */
function pickDate(p: Pick<WallPick, 'y' | 'mo' | 'd'>): Date {
  const d = new Date(0);
  // setUTCFullYear, not Date.UTC, so years 0–99 aren't read as 19xx.
  d.setUTCFullYear(p.y, p.mo - 1, p.d);
  return d;
}

function fmtUtc(d: Date, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(d);
  } catch {
    return '';
  }
}

/** "14:00" or "2:00 PM", in the reader's chosen clock format. */
function pickTimeText(p: WallPick, hour12: boolean): string {
  const face = clockText({ hour: p.h, minute: p.mi, second: 0, weekday: 0 }, hour12);
  return `${face.main}${face.meridiem ? ` ${face.meridiem}` : ''}`;
}

/** The trigger's label once something is applied: "4 Nov 2026, 2:00 PM". */
function pickLabel(p: WallPick, hour12: boolean): string {
  return `${fmtUtc(pickDate(p), { day: 'numeric', month: 'short', year: 'numeric' })}, ${pickTimeText(p, hour12)}`;
}

/** 4 Jan 1970 was a Sunday, so the headers read in the reader's locale from a known week. */
const FIRST_SUNDAY_MS = Date.UTC(1970, 0, 4);

/**
 * A whole number typed into one of the time fields, or null when what is
 * there cannot be read as one. Deliberately stricter than Number(): "1.5",
 * "-3", "1e1" and "" are all refused, so Apply can be blocked on them
 * instead of quietly planning whatever the field held before.
 */
function parseTimeField(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/**
 * The popover's own tab stops. Day buttons outside the roving one carry
 * tabindex="-1" and must not count, or Tab would walk 31 days.
 */
const POPOVER_TAB_STOPS = 'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])';

interface DateTimePickerProps {
  /** The applied pick, or null when the board is live or on a scrubber offset. */
  readonly value: WallPick | null;
  readonly nowMs: number;
  readonly home: string;
  readonly hour12: boolean;
  readonly onApply: (pick: WallPick) => void;
  readonly onClear: () => void;
  readonly idBase: string;
}

/**
 * Plan any date and time, as the home zone's wall clock. The scrubber only
 * reaches −12 h … +36 h; this reaches anywhere, so it is a separate control
 * rather than a wider slider.
 */
function DateTimePicker({ value, nowMs, home, hour12, onApply, onClear, idBase }: DateTimePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WallPick>(() => value ?? wallPick(nowMs, home));
  const [view, setView] = useState<YearMonth>(() => ({ y: draft.y, mo: draft.mo }));
  const [hourText, setHourText] = useState('');
  const [minuteText, setMinuteText] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Set only by keyboard navigation and by opening, so editing the time
  // fields never yanks focus back into the grid.
  const wantGridFocus = useRef(false);

  const hourDisplay = useCallback(
    (p: WallPick): string => (hour12 ? String(p.h % 12 || 12) : two(p.h)),
    [hour12],
  );

  const resyncTime = useCallback(
    (p: WallPick) => {
      setHourText(hourDisplay(p));
      setMinuteText(two(p.mi));
    },
    [hourDisplay],
  );

  // A 12/24-hour switch while the popover is open rewrites the hour field.
  useEffect(() => {
    if (open) resyncTime(draft);
    // Only the format matters here: ordinary draft edits keep what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour12, open]);

  useEffect(() => {
    if (!open || !wantGridFocus.current) return;
    wantGridFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('button[data-day][tabindex="0"]')?.focus();
  }, [open, draft]);

  // A click anywhere else dismisses the popover, as popovers do.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event): void => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || triggerRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openPopover = useCallback(() => {
    const seed = value ?? wallPick(nowMs, home);
    setDraft(seed);
    setView({ y: seed.y, mo: seed.mo });
    resyncTime(seed);
    wantGridFocus.current = true;
    setOpen(true);
  }, [value, nowMs, home, resyncTime]);

  const selectDay = useCallback((next: WallPick, fromKeyboard: boolean) => {
    setDraft(next);
    setView({ y: next.y, mo: next.mo });
    if (fromKeyboard) wantGridFocus.current = true;
  }, []);

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const byDays: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const days = byDays[e.key];
    if (days !== undefined) {
      e.preventDefault();
      selectDay(addDays(draft, days), true);
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      selectDay(withMonth(draft, addMonths(draft, e.key === 'PageUp' ? -1 : 1)), true);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      selectDay({ ...draft, d: e.key === 'Home' ? 1 : daysInMonth(draft.y, draft.mo) }, true);
    }
  };

  const setHour = (text: string): void => {
    setHourText(text);
    const n = parseTimeField(text, hour12 ? 1 : 0, hour12 ? 12 : 23);
    if (n === null) return;
    setDraft({ ...draft, h: hour12 ? (n % 12) + (draft.h >= 12 ? 12 : 0) : n });
  };

  const setMinute = (text: string): void => {
    setMinuteText(text);
    const n = parseTimeField(text, 0, 59);
    if (n === null) return;
    setDraft({ ...draft, mi: n });
  };

  const setMeridiem = (pm: boolean): void => {
    const next = { ...draft, h: (draft.h % 12) + (pm ? 12 : 0) };
    setDraft(next);
    resyncTime(next);
  };

  // What the applied pick actually resolved to on home's wall clock. The
  // trigger is labelled from that, not from the written fields: 02:30 on a
  // spring-forward day is never on any clock, and the trigger must not be
  // the one surface still claiming it while every card reads 03:30.
  const resolvedLabel = useMemo(() => {
    if (!value) return null;
    const r = readWallPick(value, home, hour12);
    return r ? pickLabel(wallPick(r.epochMs, home), hour12) : pickLabel(value, hour12);
  }, [value, home, hour12]);

  // Out-of-range or non-integer text used to leave the draft alone, so Apply
  // planned the previous value while the field showed something else. The
  // field is marked invalid instead and Apply is blocked until it reads.
  const hourOk = parseTimeField(hourText, hour12 ? 1 : 0, hour12 ? 12 : 23) !== null;
  const minuteOk = parseTimeField(minuteText, 0, 59) !== null;
  const timeOk = hourOk && minuteOk;
  const errorId = `${idBase}-dp-err`;

  /**
   * Tab stays inside the popover while it is open. It is a `role="dialog"`,
   * and tabbing past Apply used to leave it open with focus on the page
   * behind it.
   */
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const pop = popRef.current;
    if (!pop) return;
    const stops = Array.from(pop.querySelectorAll<HTMLElement>(POPOVER_TAB_STOPS));
    if (stops.length === 0) return;
    const i = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : i === stops.length - 1 ? 0 : i + 1;
    e.preventDefault();
    stops[next]?.focus();
  };

  const today = wallPick(nowMs, home);
  const weeks = monthGrid(view.y, view.mo);
  const monthName = fmtUtc(pickDate({ y: view.y, mo: view.mo, d: 1 }), { month: 'long', year: 'numeric' });
  const selectedInView = draft.y === view.y && draft.mo === view.mo;
  // One stop in the grid, so Tab moves past the calendar instead of through 31 days.
  const roving = selectedInView ? draft.d : 1;
  const popId = `${idBase}-dp`;

  return (
    <div className="tzc-dp">
      <button
        type="button"
        ref={triggerRef}
        className={`tzc-btn tzc-dp-trigger${value ? ' is-set' : ''}`}
        // The label is a formatted date, so it moves with the reader's locale;
        // the hook is an attribute, as on the card tools.
        data-dp-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close() : openPopover())}
      >
        <CalendarIcon size={15} />
        <span>{resolvedLabel ?? 'Pick date & time'}</span>
      </button>
      {open && (
        <div
          className="tzc-dp-pop"
          id={popId}
          ref={popRef}
          role="dialog"
          aria-label={`Pick a date and time in ${zonePlace(home)}`}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              trapTab(e);
              return;
            }
            if (e.key !== 'Escape') return;
            // Dismiss only, and stop the planner panel's own Escape from
            // seeing it. Opening the picker to look at a plan and pressing
            // Escape used to wipe that plan, where clicking outside only
            // dropped the draft; the same "I'm done looking" gesture must not
            // mean two different things. Clearing is Clear's job, and Now's.
            e.preventDefault();
            e.stopPropagation();
            close();
          }}
        >
          <div className="tzc-dp-head">
            <button
              type="button"
              className="tzc-icon-btn tzc-dp-nav"
              aria-label="Previous month"
              onClick={() => setView(addMonths(view, -1))}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <span className="tzc-dp-month" aria-live="polite">
              {monthName}
            </span>
            <button
              type="button"
              className="tzc-icon-btn tzc-dp-nav"
              aria-label="Next month"
              onClick={() => setView(addMonths(view, 1))}
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>

          <div className="tzc-dp-grid" role="grid" aria-label={monthName} ref={gridRef} onKeyDown={onGridKeyDown}>
            <div className="tzc-dp-row" role="row">
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(FIRST_SUNDAY_MS + i * 86_400_000);
                return (
                  <span
                    key={i}
                    className="tzc-dp-wd"
                    role="columnheader"
                    aria-label={fmtUtc(d, { weekday: 'long' })}
                  >
                    {fmtUtc(d, { weekday: 'short' })}
                  </span>
                );
              })}
            </div>
            {weeks.map((week, wi) => (
              <div className="tzc-dp-row" role="row" key={wi}>
                {week.map((day, di) => {
                  if (day === null) return <span className="tzc-dp-cell" role="gridcell" key={di} />;
                  const cell: WallPick = { ...draft, y: view.y, mo: view.mo, d: day };
                  const isSelected = selectedInView && draft.d === day;
                  const isToday = today.y === view.y && today.mo === view.mo && today.d === day;
                  const iso = `${String(view.y).padStart(4, '0')}-${two(view.mo)}-${two(day)}`;
                  return (
                    <span className="tzc-dp-cell" role="gridcell" aria-selected={isSelected} key={di}>
                      <button
                        type="button"
                        className={`tzc-dp-day${isSelected ? ' is-selected' : ''}${isToday ? ' is-today' : ''}`}
                        data-day={iso}
                        tabIndex={day === roving ? 0 : -1}
                        aria-current={isToday ? 'date' : undefined}
                        aria-label={fmtUtc(pickDate(cell), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                        onClick={() => selectDay(cell, false)}
                      >
                        {day}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="tzc-dp-time" role="group" aria-label={`Time in ${zonePlace(home)}`}>
            <input
              className="tzc-dp-num"
              type="number"
              inputMode="numeric"
              aria-label="Hour"
              min={hour12 ? 1 : 0}
              max={hour12 ? 12 : 23}
              value={hourText}
              aria-invalid={!hourOk || undefined}
              aria-describedby={hourOk ? undefined : errorId}
              onChange={(e) => setHour(e.currentTarget.value)}
              onBlur={() => resyncTime(draft)}
            />
            <span className="tzc-dp-colon" aria-hidden="true">
              :
            </span>
            <input
              className="tzc-dp-num"
              type="number"
              inputMode="numeric"
              aria-label="Minute"
              min={0}
              max={59}
              value={minuteText}
              aria-invalid={!minuteOk || undefined}
              aria-describedby={minuteOk ? undefined : errorId}
              onChange={(e) => setMinute(e.currentTarget.value)}
              onBlur={() => resyncTime(draft)}
            />
            {hour12 && (
              <div className="tzc-seg tzc-dp-mer" role="group" aria-label="AM or PM">
                <button
                  type="button"
                  className="tzc-seg-btn"
                  aria-pressed={draft.h < 12}
                  onClick={() => setMeridiem(false)}
                >
                  AM
                </button>
                <button
                  type="button"
                  className="tzc-seg-btn"
                  aria-pressed={draft.h >= 12}
                  onClick={() => setMeridiem(true)}
                >
                  PM
                </button>
              </div>
            )}
          </div>

          {!timeOk && (
            <p className="tzc-dp-error" id={errorId} role="alert">
              {!hourOk && !minuteOk
                ? `Enter an hour from ${hour12 ? 1 : 0} to ${hour12 ? 12 : 23} and a minute from 0 to 59.`
                : !hourOk
                  ? `Enter an hour from ${hour12 ? 1 : 0} to ${hour12 ? 12 : 23}.`
                  : 'Enter a minute from 0 to 59.'}
            </p>
          )}

          <p className="tzc-dp-hint">Arrow keys move a day, Page Up/Down a month, Escape closes the picker.</p>

          <div className="tzc-dp-actions">
            <button
              type="button"
              className="tzc-btn"
              onClick={() => {
                onClear();
                close();
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="tzc-btn tzc-btn-primary"
              disabled={!timeOk}
              onClick={() => {
                onApply(draft);
                close();
              }}
            >
              Apply
            </button>
          </div>
          <p className="tzc-sr-only" aria-live="polite">
            {`${fmtUtc(pickDate(draft), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${pickTimeText(draft, hour12)} selected`}
          </p>
        </div>
      )}
    </div>
  );
}

interface ZoneCardProps {
  readonly zone: string;
  readonly isHome: boolean;
  readonly position: number;
  readonly count: number;
  readonly instant: number;
  /** Home's real calendar day now (homeDayNumber), for the Today / Tomorrow tag. */
  readonly homeToday: number;
  readonly home: string;
  readonly hour12: boolean;
  readonly planning: boolean;
  readonly dragging: boolean;
  /** Plan the instant this card's own slider was moved to. Stable. */
  readonly onRetime: (target: number) => void;
  /** Stable callbacks taking the zone, so the memoized card skips unchanged renders. */
  readonly registerRef: (zone: string, el: HTMLLIElement | null) => void;
  readonly onMove: (zone: string, delta: number) => void;
  readonly onRemove: (zone: string) => void;
  readonly onMakeHome: (zone: string) => void;
  readonly onHandlePointerDown: (zone: string, e: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onHandlePointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onHandlePointerUp: () => void;
  readonly onHandlePointerCancel: () => void;
}

const QUARTER_MS = STEP_MINUTES * 60_000;

/**
 * One clock card. Memoized on its props, which are exactly what it displays
 * plus stable callbacks: while planning, `instant` holds still, so a tick does
 * not re-render any card; live, each card re-renders once a second for its
 * seconds digits and nothing else does.
 */
const ZoneCard = memo(function ZoneCard(props: ZoneCardProps): JSX.Element {
  const { zone, isHome, position, count, instant, homeToday, home, hour12, planning, dragging, registerRef } = props;
  const uid = useId();
  const refCb = useCallback((el: HTMLLIElement | null) => registerRef(zone, el), [registerRef, zone]);
  const parts = wallParts(instant, zone);
  const face = clockText(parts, hour12);
  const phase = dayPhase(parts.hour + parts.minute / 60);
  const rel = relativeDay(instant, zone, home, homeToday);
  const diff = diffFromHome(instant, zone, home);
  const diffText = formatDiff(diff) ?? 'same time';
  const work = workStatus(parts.hour, parts.minute, parts.weekday);
  const place = zonePlace(zone);
  const desc = zoneDescription(zone);
  const offset = utcOffsetLabel(offsetMinutesAt(instant, zone));
  const date = dateText(instant, zone, { weekday: 'long', day: 'numeric', month: 'short' });
  // Two wall-clock reads per card; live, the instant moves every second, but
  // the slider only every quarter hour, so it is keyed on that.
  const quarter = Math.floor(instant / QUARTER_MS) * QUARTER_MS;
  const day = useMemo(() => daySlider(quarter, zone), [quarter, zone]);
  const { onRetime } = props;
  const retimeTo = (step: number): void => {
    if (!day) return;
    onRetime(day.startMs + Math.max(0, Math.min(day.max, step)) * QUARTER_MS);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>): void => {
    if (isHome || !e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      props.onMove(zone, -1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      props.onMove(zone, 1);
    }
  };

  return (
    <li
      ref={refCb}
      className={`tzc-card tzc-phase-${phase}${isHome ? ' is-home' : ''}${dragging ? ' is-dragging' : ''}`}
      data-zone={zone}
      aria-labelledby={`${uid}-t`}
      onKeyDown={onKeyDown}
    >
      <div className="tzc-card-head">
        <div className="tzc-card-names">
          <h3 className="tzc-card-title" id={`${uid}-t`} tabIndex={-1} data-title>
            {place}
            {isHome && <span className="tzc-home-tag">Home</span>}
          </h3>
          <p className="tzc-card-sub">{desc}</p>
        </div>
        <span className="tzc-glyph" aria-hidden="true">
          <PhaseIcon phase={phase} size={18} />
        </span>
      </div>

      <p className="tzc-time">
        <span className="tzc-time-main">{face.main}</span>
        {!planning && <span className="tzc-time-sec">:{face.seconds}</span>}
        {face.meridiem && <span className="tzc-time-mer">{face.meridiem}</span>}
      </p>

      <p className="tzc-date">
        <span>{date}</span>
        <span className={`tzc-day${rel === 'Today' ? ' tzc-day-today' : ' tzc-day-other'}`}>{rel}</span>
      </p>

      <dl className="tzc-facts">
        <div>
          <dt>Offset</dt>
          <dd>{offset}</dd>
        </div>
        <div>
          <dt>From home</dt>
          <dd className="tzc-diff" title={describeDiff(diff)}>
            {isHome ? 'Home zone' : diffText}
          </dd>
        </div>
      </dl>

      <p className={`tzc-work tzc-work-${work.state}`}>
        <span className="tzc-work-dot" aria-hidden="true" />
        {work.text}
      </p>

      {/* This zone's day, midnight to midnight, as a slider: moving it plans
          that time here, and every other card and the main slider follow.
          It counts real quarter hours from midnight (see daySlider), so a
          DST day is simply shorter or longer, and the band behind it marks
          working hours. */}
      {day && (
        <div className="tzc-progress" style={{ '--tzc-fill': String(day.max ? day.value / day.max : 0) } as React.CSSProperties}>
          <span className="tzc-progress-work" aria-hidden="true" />
          <span className="tzc-progress-fill" aria-hidden="true" />
          <input
            className="tzc-day-range"
            type="range"
            min={0}
            max={day.max}
            step={1}
            value={day.value}
            aria-label={`Time in ${place}`}
            aria-valuetext={`${face.main}${face.meridiem ? ` ${face.meridiem}` : ''}, ${date}`}
            onChange={(e) => retimeTo(Number(e.currentTarget.value))}
            onKeyDown={(e) => {
              if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
              e.preventDefault();
              retimeTo(day.value + (e.key === 'PageUp' ? 4 : -4));
            }}
          />
        </div>
      )}

      {!isHome && (
        <div className="tzc-card-tools">
          <button
            type="button"
            className="tzc-tool tzc-handle"
            data-handle
            aria-label={`Reorder ${place}, position ${position + 1} of ${count}`}
            aria-describedby={`${uid}-hint`}
            title="Drag to reorder (Alt+↑/↓)"
            onPointerDown={(e) => props.onHandlePointerDown(zone, e)}
            onPointerMove={props.onHandlePointerMove}
            onPointerUp={props.onHandlePointerUp}
            onPointerCancel={props.onHandlePointerCancel}
            onLostPointerCapture={props.onHandlePointerUp}
            onKeyDown={(e) => {
              // On the handle, plain arrows reorder too.
              if (e.altKey) return;
              if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                props.onMove(zone, -1);
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                props.onMove(zone, 1);
              }
            }}
          >
            <GripIcon />
          </button>
          <span className="tzc-sr-only" id={`${uid}-hint`}>
            Use arrow keys here, or Alt plus arrow keys anywhere on the card, to move it.
          </span>
          <button type="button" className="tzc-tool tzc-tool-text" onClick={() => props.onMakeHome(zone)} aria-label={`Make ${place} home`}>
            <HomeIcon size={14} />
            <span>Make home</span>
          </button>
          <button
            type="button"
            className="tzc-tool tzc-remove"
            data-remove
            onClick={() => props.onRemove(zone)}
            aria-label={`Remove ${place}`}
            title="Remove"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}
    </li>
  );
});
