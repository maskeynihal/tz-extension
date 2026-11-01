import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveLocalZone, type Preferences, type Theme } from '../types';
import { loadPreferences, onPreferencesChanged, savePreferences } from '../lib/storage';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { isValidZone, offsetMinutesAt, sameZone } from '../lib/tz';
import { ZonePicker } from '../popup/ZonePicker';
import {
  SCRUB_MAX_STEPS,
  SCRUB_MIN_STEPS,
  STEP_MINUTES,
  applyOrder,
  clockText,
  dateText,
  dayPhase,
  dayProgress,
  describeDiff,
  diffFromHome,
  formatDiff,
  makeHome,
  minutesFromNow,
  moveItem,
  relativeDay,
  shownInstant,
  utcOffsetLabel,
  visibleZones,
  wallParts,
  workStatus,
  zoneDescription,
  zonePlace,
} from './model';
import { CloseIcon, ExpandIcon, GripIcon, HomeIcon, PhaseIcon, SettingsIcon, ShrinkIcon } from './icons';

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
  const [steps, setSteps] = useState(0);
  // A preset ("+24h") plans from the current minute; the slider snaps to quarter hours.
  const [exact, setExact] = useState(false);
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

  const instant = shownInstant(now, steps, exact);
  const planning = steps !== 0;

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
            steps={steps}
            exact={exact}
            nowMs={now}
            home={home}
            hour12={hour12}
            scrubbed={scrubbed}
            onChange={(s, isExact = false) => {
              setScrubbed(true);
              setSteps(s);
              setExact(isExact && s !== 0);
            }}
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
                  home={home}
                  hour12={hour12}
                  planning={planning}
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
  readonly steps: number;
  /** The plan came from a preset and starts at the current minute, not the quarter hour. */
  readonly exact: boolean;
  readonly nowMs: number;
  readonly home: string;
  readonly hour12: boolean;
  readonly scrubbed: boolean;
  readonly onChange: (steps: number, exact?: boolean) => void;
  readonly idBase: string;
}

const SCALE_HOURS = [-12, -6, 0, 6, 12, 18, 24, 30, 36];

/** Accessible name of a scale preset: "Plan 12 hours ahead", "Plan 6 hours back". */
function scaleLabel(h: number): string {
  if (h === 0) return 'Plan the current time';
  return `Plan ${Math.abs(h)} hours ${h > 0 ? 'ahead' : 'back'}`;
}

/** "Tue 15:30 in Kathmandu" for the planned instant. */
function planText(instant: number, home: string, hour12: boolean): string {
  const face = clockText(wallParts(instant, home), hour12);
  const day = dateText(instant, home, { weekday: 'short' });
  return `${day} ${face.main}${face.meridiem ? ` ${face.meridiem}` : ''} in ${zonePlace(home)}`;
}

function Scrubber({ steps, exact, nowMs, home, hour12, scrubbed, onChange, idBase }: ScrubberProps): JSX.Element {
  const planning = steps !== 0;
  // Minute precision is all the summary needs, so it only changes when the
  // slider moves or a new minute starts, never every second.
  const minuteMs = Math.floor(nowMs / 60_000) * 60_000;
  const instant = shownInstant(minuteMs, steps, exact);
  const plan = useMemo(() => planText(instant, home, hour12), [instant, home, hour12]);
  // The real distance from now: a snapped slider plan is not a round number.
  const fromNow = formatDiff(minutesFromNow(minuteMs, steps, exact));
  const valueText = planning ? `${plan}, ${fromNow ?? ''} from now` : 'Now';
  const live = planning ? `Planning ${plan}, ${fromNow ?? ''} from now.` : scrubbed ? 'Showing the current time.' : '';
  const span = SCRUB_MAX_STEPS - SCRUB_MIN_STEPS;
  const frac = (s: number): string => String((s - SCRUB_MIN_STEPS) / span);
  const inputId = `${idBase}-scrub`;

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
        onChange(0);
      }}
    >
      <div className="tzc-scrub-head">
        <h2 className="tzc-panel-title" id={`${idBase}-scrub-h`}>
          Plan a time
        </h2>
        {planning ? (
          <span className="tzc-plan-chip">
            <span className="tzc-plan-label">Planning:</span> {plan}
            <span className="tzc-plan-delta"> · {fromNow} from now</span>
          </span>
        ) : (
          <span className="tzc-live-chip">
            <span className="tzc-live-dot" aria-hidden="true" /> Live
          </span>
        )}
        <button
          type="button"
          className="tzc-btn"
          onClick={() => onChange(0)}
          disabled={!planning}
          aria-label="Back to now"
        >
          Now
        </button>
      </div>
      <label className="tzc-sr-only" htmlFor={inputId}>
        Shift all clocks
      </label>
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
          aria-describedby={`${idBase}-scrub-hint`}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            let next: number | null = null;
            if (e.key === 'PageUp') next = steps + 4;
            else if (e.key === 'PageDown') next = steps - 4;
            if (next === null) return;
            e.preventDefault();
            onChange(Math.max(SCRUB_MIN_STEPS, Math.min(SCRUB_MAX_STEPS, next)));
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
                aria-label={scaleLabel(h)}
                aria-pressed={steps === target && (exact || target === 0)}
                onClick={() => onChange(target, true)}
              >
                {h === 0 ? 'Now' : `${h > 0 ? '+' : '−'}${Math.abs(h)}h`}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="tzc-hint" id={`${idBase}-scrub-hint`}>
        Arrow keys move 15 minutes, Page Up/Down one hour, Escape returns to now.
      </p>
      <p className="tzc-sr-only" aria-live="polite">
        {live}
      </p>
    </section>
  );
}

interface ZoneCardProps {
  readonly zone: string;
  readonly isHome: boolean;
  readonly position: number;
  readonly count: number;
  readonly instant: number;
  readonly home: string;
  readonly hour12: boolean;
  readonly planning: boolean;
  readonly dragging: boolean;
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

/**
 * One clock card. Memoized on its props, which are exactly what it displays
 * plus stable callbacks: while planning, `instant` holds still, so a tick does
 * not re-render any card; live, each card re-renders once a second for its
 * seconds digits and nothing else does.
 */
const ZoneCard = memo(function ZoneCard(props: ZoneCardProps): JSX.Element {
  const { zone, isHome, position, count, instant, home, hour12, planning, dragging, registerRef } = props;
  const uid = useId();
  const refCb = useCallback((el: HTMLLIElement | null) => registerRef(zone, el), [registerRef, zone]);
  const parts = wallParts(instant, zone);
  const face = clockText(parts, hour12);
  const phase = dayPhase(parts.hour + parts.minute / 60);
  const rel = relativeDay(instant, zone, home);
  const diff = diffFromHome(instant, zone, home);
  const diffText = formatDiff(diff) ?? 'same time';
  const work = workStatus(parts.hour, parts.minute, parts.weekday);
  const place = zonePlace(zone);
  const desc = zoneDescription(zone);
  const offset = utcOffsetLabel(offsetMinutesAt(instant, zone));
  const progress = dayProgress(parts);
  const date = dateText(instant, zone, { weekday: 'long', day: 'numeric', month: 'short' });

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
        <span className={`tzc-day tzc-day-${rel.toLowerCase()}`}>{rel}</span>
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

      <div className="tzc-progress" aria-hidden="true">
        <span className="tzc-progress-work" />
        <span className="tzc-progress-fill" style={{ width: `${progress * 100}%` }} />
        <span className="tzc-progress-mark" style={{ left: `${progress * 100}%` }} />
      </div>

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
