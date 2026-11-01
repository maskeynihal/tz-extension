import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/** What the dock shows about the pinned cards on the page. */
export interface PinDockProps {
  /** Number of pinned + floating cards. */
  readonly count: number;
  /** How many are compact. */
  readonly compactCount: number;
  /** How many float on screen (the rest are pinned to the page). */
  readonly floatingCount: number;
  /** Set right after "Close all": how many were closed, for the undo offer. */
  readonly closed: number | null;
  readonly onMinimizeAll: () => void;
  readonly onExpandAll: () => void;
  /** Float every pinned card on screen (or pin every floating one back). */
  readonly onTogglePlacementAll: () => void;
  readonly onCloseAll: () => void;
  readonly onUndo: () => void;
  readonly onDismissUndo: () => void;
}

/** How long the "Closed N cards · Undo" offer stays, unless hovered or focused. */
export const UNDO_MS = 6000;

type IconName = 'pin' | 'float' | 'compact' | 'expand' | 'close' | 'chevron' | 'undo';

function Icon({ name }: { readonly name: IconName }): JSX.Element {
  const p = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (name) {
    case 'pin':
      return (
        <svg {...p}>
          <path d="M12 17v5" />
          <path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76Z" />
          <path d="M8 2h8" />
        </svg>
      );
    case 'float':
      return (
        <svg {...p}>
          <rect x="3" y="6" width="14" height="12" rx="2" />
          <path d="M21 10v8a2 2 0 0 1-2 2H9" />
        </svg>
      );
    case 'compact':
      return (
        <svg {...p}>
          <path d="M4 9h16" />
          <path d="M4 15h16" />
        </svg>
      );
    case 'expand':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M4 9h16" />
        </svg>
      );
    case 'close':
      return (
        <svg {...p}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...p}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...p}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
      );
  }
}

export const DOCK_STYLE = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.dock {
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 12px; line-height: 1; color: #24262e;
  display: inline-flex; align-items: center; gap: 2px;
  background: rgba(255,255,255,0.92); backdrop-filter: saturate(160%) blur(10px); -webkit-backdrop-filter: saturate(160%) blur(10px);
  border: 1px solid #e6e7ec; border-radius: 999px;
  box-shadow: 0 8px 24px rgba(15,17,21,0.14);
  padding: 4px; opacity: 0.78;
  /* Never wider than a phone screen (the host sits 16px from the right edge). */
  max-width: calc(100vw - 32px); flex-wrap: wrap; row-gap: 2px;
  transition: opacity 160ms ease, transform 160ms ease;
  animation: dock-in 200ms cubic-bezier(0.2, 0, 0, 1);
}
.dock:hover, .dock:focus-within { opacity: 1; }
@keyframes dock-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { transform: none; } }
.count {
  display: inline-flex; align-items: center; gap: 5px; padding: 0 8px 0 6px; height: 28px;
  font-weight: 700; color: #1313ba; border: none; background: transparent; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 700;
}
.count .chev { transition: transform 160ms ease; color: #898c96; display: inline-flex; }
.dock.open .count .chev { transform: rotate(180deg); }
.sep { width: 1px; height: 18px; background: #e6e7ec; margin: 0 2px; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; min-width: 28px; padding: 0 7px; border-radius: 999px;
  border: none; background: transparent; color: #5b5e68; cursor: pointer; font: inherit; font-weight: 600;
}
.btn:hover:not(:disabled) { background: #f1f2f5; color: #16181d; }
.btn:disabled { opacity: 0.35; cursor: default; }
.btn.danger:hover:not(:disabled) { background: #fff1f2; color: #be123c; }
.btn .txt { display: none; }
.dock.open .btn .txt { display: inline; }
.btn:focus-visible, .count:focus-visible, .undo:focus-visible { outline: 2px solid #1313ba; outline-offset: 1px; }
.toast { display: inline-flex; align-items: center; gap: 8px; padding: 0 4px 0 12px; height: 28px; position: relative; font-weight: 600; }
.undo { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; border: none; background: #1313ba; color: #fff; cursor: pointer; font: inherit; font-weight: 700; }
.undo:hover { background: #0e0e8c; }
.timer { position: absolute; left: 12px; right: 12px; bottom: -3px; height: 2px; border-radius: 2px; background: #1313ba; transform-origin: left; opacity: 0.5; animation: drain linear forwards; }
.dock:hover .timer, .dock:focus-within .timer { animation-play-state: paused; }
@keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .dock, .count .chev, .timer { animation: none !important; transition: none !important; }
}
@media (prefers-color-scheme: dark) {
  :host(:not([data-tz-theme='light'])) .dock { color: #e7e8ec; background: rgba(18,19,24,0.9); border-color: #2a2c33; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  :host(:not([data-tz-theme='light'])) .count { color: #9d9dea; }
  :host(:not([data-tz-theme='light'])) .sep { background: #2a2c33; }
  :host(:not([data-tz-theme='light'])) .btn { color: #a0a3ac; }
  :host(:not([data-tz-theme='light'])) .btn:hover:not(:disabled) { background: #22242b; color: #f3f4f6; }
  :host(:not([data-tz-theme='light'])) .btn.danger:hover:not(:disabled) { background: #2a1115; color: #fb7185; }
  :host(:not([data-tz-theme='light'])) .undo { background: #8989dd; color: #0f1115; }
  :host(:not([data-tz-theme='light'])) .timer { background: #8989dd; }
}
:host([data-tz-theme='dark']) .dock { color: #e7e8ec; background: rgba(18,19,24,0.9); border-color: #2a2c33; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
:host([data-tz-theme='dark']) .count { color: #9d9dea; }
:host([data-tz-theme='dark']) .sep { background: #2a2c33; }
:host([data-tz-theme='dark']) .btn { color: #a0a3ac; }
:host([data-tz-theme='dark']) .btn:hover:not(:disabled) { background: #22242b; color: #f3f4f6; }
:host([data-tz-theme='dark']) .btn.danger:hover:not(:disabled) { background: #2a1115; color: #fb7185; }
:host([data-tz-theme='dark']) .undo { background: #8989dd; color: #0f1115; }
:host([data-tz-theme='dark']) .timer { background: #8989dd; }
`;

/** Keep the page selection when clicking the dock (so copy still works). */
function keepSelection(e: React.MouseEvent): void {
  e.preventDefault();
}

/**
 * A small pill in the bottom-right corner, shown while cards are pinned:
 * the count, then Minimize all · Expand all · Float/Pin all · Close all.
 * Icons only until hovered, focused or opened with the count button; after
 * "Close all" it turns into an Undo offer for a few seconds.
 * A toolbar: Left/Right/Home/End move between buttons.
 */
export function PinDock(props: PinDockProps): JSX.Element {
  const { count, compactCount, floatingCount, closed } = props;
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLButtonElement>(null);
  /** Set when the undo offer ends while focus was in it: focus the dock's first button next. */
  const refocus = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const paused = useRef(false);
  const remaining = useRef(UNDO_MS);
  const startedAt = useRef(0);

  /** True while keyboard focus is inside the dock. */
  function focusInDock(): boolean {
    const el = barRef.current;
    const root = el?.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    return Boolean(el && active && el.contains(active));
  }
  /** End the undo offer (Undo, Dismiss or timeout), keeping focus in the dock if it was there. */
  function endOffer(action: () => void): void {
    refocus.current = focusInDock();
    action();
  }
  const endOfferRef = useRef(endOffer);
  endOfferRef.current = endOffer;

  // After the offer ends, focus would fall to the page: keep it on the dock
  // (its first button) if the dock is still there. If it is gone (no cards
  // left), focus falls back to the page body.
  useEffect(() => {
    if (closed !== null || !refocus.current) return;
    refocus.current = false;
    countRef.current?.focus({ preventScroll: true });
  }, [closed]);

  // The undo offer times out unless the pointer or focus is on the dock.
  useEffect(() => {
    if (closed === null) return;
    remaining.current = UNDO_MS;
    const arm = (): void => {
      window.clearTimeout(timer.current);
      startedAt.current = Date.now();
      timer.current = window.setTimeout(() => endOfferRef.current(props.onDismissUndo), remaining.current);
    };
    arm();
    // Move focus to Undo so keyboard and screen reader users can act on it.
    // This programmatic focus does not pause the countdown (the listeners
    // below are not attached yet); moving focus within the dock, or hovering
    // it, does.
    undoRef.current?.focus({ preventScroll: true });
    const el = barRef.current;
    let hovered = false;
    let focused = false;
    const sync = (): void => {
      const hold = hovered || focused;
      if (hold && !paused.current) {
        paused.current = true;
        window.clearTimeout(timer.current);
        remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
      } else if (!hold && paused.current) {
        paused.current = false;
        arm();
      }
    };
    const enter = (): void => { hovered = true; sync(); };
    const leave = (): void => { hovered = false; sync(); };
    const fin = (): void => { focused = true; sync(); };
    const fout = (e: FocusEvent): void => {
      focused = e.relatedTarget instanceof Node && Boolean(el?.contains(e.relatedTarget));
      sync();
    };
    el?.addEventListener('pointerenter', enter);
    el?.addEventListener('pointerleave', leave);
    el?.addEventListener('focusin', fin);
    el?.addEventListener('focusout', fout);
    return () => {
      window.clearTimeout(timer.current);
      paused.current = false;
      el?.removeEventListener('pointerenter', enter);
      el?.removeEventListener('pointerleave', leave);
      el?.removeEventListener('focusin', fin);
      el?.removeEventListener('focusout', fout);
    };
    // onDismissUndo identity changes per render; the offer only depends on `closed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const root = barRef.current?.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const i = buttons.findIndex((b) => b === active);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    e.preventDefault();
    e.stopPropagation();
    buttons[next]?.focus();
  }

  if (closed !== null) {
    return (
      <div className="dock open" ref={barRef} role="group" aria-label="Closed cards" onMouseDown={keepSelection}>
        <style>{DOCK_STYLE}</style>
        <span className="toast">
          <span role="status" aria-live="polite">
            Closed {closed} card{closed === 1 ? '' : 's'}
          </span>
          <span className="timer" style={{ animationDuration: `${UNDO_MS}ms` }} aria-hidden="true" />
        </span>
        <button ref={undoRef} type="button" className="undo" onClick={() => endOffer(props.onUndo)}>
          <Icon name="undo" />
          Undo
        </button>
        <button type="button" className="btn" aria-label="Dismiss" title="Dismiss" onClick={() => endOffer(props.onDismissUndo)}>
          <Icon name="close" />
        </button>
      </div>
    );
  }

  const allCompact = compactCount === count;
  const noneCompact = compactCount === 0;
  const allFloating = floatingCount === count;
  const label = `${count} pinned card${count === 1 ? '' : 's'}`;

  return (
    <div
      className={`dock${open ? ' open' : ''}`}
      ref={barRef}
      role="toolbar"
      aria-label={`Pinned cards: ${label}`}
      onKeyDown={onKeyDown}
      onMouseDown={keepSelection}
    >
      <style>{DOCK_STYLE}</style>
      <button
        type="button"
        className="count"
        ref={countRef}
        aria-expanded={open}
        aria-label={`${label}. ${open ? 'Hide' : 'Show'} action names`}
        title={open ? 'Hide labels' : 'Show labels'}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="pin" />
        {count}
        <span className="chev">
          <Icon name="chevron" />
        </span>
      </button>
      <span className="sep" aria-hidden="true" />
      <button
        type="button"
        className="btn"
        aria-label="Minimize all"
        title="Minimize all (times only)"
        disabled={allCompact}
        onClick={props.onMinimizeAll}
      >
        <Icon name="compact" />
        <span className="txt">Minimize all</span>
      </button>
      <button
        type="button"
        className="btn"
        aria-label="Expand all"
        title="Expand all"
        disabled={noneCompact}
        onClick={props.onExpandAll}
      >
        <Icon name="expand" />
        <span className="txt">Expand all</span>
      </button>
      <button
        type="button"
        className="btn"
        aria-label={allFloating ? 'Pin all to page' : 'Unpin all'}
        title={
          allFloating
            ? 'Pin all to page: each card goes back next to its text and scrolls with the page'
            : 'Unpin all: cards leave their spot on the page and float on screen, so they stay in view while you scroll'
        }
        onClick={props.onTogglePlacementAll}
      >
        <Icon name={allFloating ? 'pin' : 'float'} />
        <span className="txt">{allFloating ? 'Pin all' : 'Unpin all'}</span>
      </button>
      <button
        type="button"
        className="btn danger"
        aria-label="Close all"
        title="Close all pinned cards"
        onClick={props.onCloseAll}
      >
        <Icon name="close" />
        <span className="txt">Close all</span>
      </button>
      <span className="sr" aria-live="polite">
        {label}
      </span>
    </div>
  );
}
