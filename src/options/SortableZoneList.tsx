import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { animate, cancelAnimations } from './motion';

/** What a row's renderer can do with its own row. */
export interface SortableItemContext {
  readonly index: number;
  readonly count: number;
  /** Move the row one place up (-1) or down (1). Announces the move and keeps focus. */
  readonly move: (dir: -1 | 1) => void;
  /** Collapse the row out, then call `onRemove`. */
  readonly remove: () => void;
}

export interface SortableListProps {
  /** Unique string keys, in display order. */
  readonly items: readonly string[];
  /** Accessible name of the list. */
  readonly label: string;
  /** Human name of an item, used in handle labels and announcements. */
  readonly itemLabel: (item: string) => string;
  /** Row content, shown after the drag handle. */
  readonly render: (item: string, ctx: SortableItemContext) => ReactNode;
  /** Called once per finished move (drop, keyboard or button) with the new order. */
  readonly onReorder: (next: string[], change: { readonly item: string; readonly from: number; readonly to: number }) => void;
  /** Called after a row's remove animation. Required for `ctx.remove`. */
  readonly onRemove?: (item: string) => void;
  /** Height covered at the top of the viewport (a sticky bar), for auto-scroll. */
  readonly topInset?: number;
  readonly className?: string;
  readonly itemClassName?: string;
}

interface DragState {
  readonly pointerId: number;
  readonly key: string;
  readonly from: number;
  readonly seq: string;
  readonly handle: HTMLElement;
  readonly rows: readonly HTMLElement[];
  /** Row centers relative to the list top, without transforms. */
  readonly centers: readonly number[];
  /** How far a row moves to make room: dragged height plus the gap. */
  readonly step: number;
  /** Pointer position relative to the list top at pointerdown. */
  readonly startY: number;
  readonly minDy: number;
  readonly maxDy: number;
  readonly shifts: number[];
  /** The window keydown listener for Escape, kept so it can be removed. */
  readonly onKey: (e: KeyboardEvent) => void;
  target: number;
  lastClientY: number;
  scrollRaf: number;
}

/**
 * A keyboard pick-up (Space or Enter on a handle): the row moves with the
 * arrow keys in a local order that is only reported on drop.
 */
interface GrabState {
  readonly key: string;
  /** Position when picked up. */
  readonly from: number;
  /** The order shown while the row is held. */
  readonly order: readonly string[];
  /** `items` when picked up; a different list from the parent ends the grab. */
  readonly base: string;
}

type PendingFocus = { readonly kind: 'element'; readonly el: HTMLElement; readonly key: string } | { readonly kind: 'index'; readonly index: number };

/** Distance from a viewport edge where dragging starts to scroll the page. */
const EDGE_PX = 56;
const MAX_SCROLL_PX = 18;

function rowsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.sortKey !== undefined);
}

/** Visual row centers (transforms included) relative to the list top. */
function centersOf(list: HTMLElement): Map<string, number> {
  const top = list.getBoundingClientRect().top;
  const out = new Map<string, number>();
  for (const row of rowsOf(list)) {
    if (row.dataset.sortExit !== undefined) continue;
    const r = row.getBoundingClientRect();
    out.set(row.dataset.sortKey ?? '', r.top + r.height / 2 - top);
  }
  return out;
}

function translate(px: number, scale = false): string {
  return `translateY(${px}px)${scale ? ' scale(1.02)' : ''}`;
}

function GripIcon(): JSX.Element {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden focusable="false">
      {[3, 8, 13].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.5" fill="currentColor" />
          <circle cx="7.5" cy={y} r="1.5" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

/**
 * A reorderable list. Rows move by dragging the grip (mouse, pen or touch,
 * through Pointer Events), with Alt+ArrowUp / Alt+ArrowDown, or through
 * `ctx.move`. Other rows slide aside while dragging and every change animates
 * with FLIP (Web Animations API); with reduced motion everything is instant.
 * The new order is reported once per move, never per pointer move.
 */
export function SortableList(props: SortableListProps): JSX.Element {
  const { items, label, itemLabel, render, className, itemClassName } = props;
  const latest = useRef(props);
  latest.current = props;

  const listRef = useRef<HTMLUListElement>(null);
  const hintId = useId();
  const [message, setMessage] = useState('');

  /** Layout centers after the last settle; the "first" of FLIP for outside changes. */
  const stored = useRef<Map<string, number>>(new Map());
  /** Visual centers captured right before one of our own changes. */
  const pendingFrom = useRef<Map<string, number> | null>(null);
  const pendingDrop = useRef<{ key: string; seq: string } | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const exiting = useRef<Map<string, 'animating' | 'removed'>>(new Map());
  const drag = useRef<DragState | null>(null);
  const prevKeys = useRef<string | null>(null);
  const dragSeq = useRef(0);
  const [grab, setGrabState] = useState<GrabState | null>(null);
  const grabRef = useRef<GrabState | null>(null);
  const itemsString = items.join('\n');
  // A grab made on another list (the parent changed it meanwhile) is over.
  const activeGrab = grab && grab.base === itemsString ? grab : null;
  const shownItems = activeGrab ? activeGrab.order : items;

  function setGrab(g: GrabState | null): void {
    grabRef.current = g;
    setGrabState(g);
  }

  function announce(text: string): void {
    // Repeat announcements must still change the text to be read again.
    setMessage((prev) => (prev === text ? `${text}\u00a0` : text));
  }

  function rowFor(key: string): HTMLElement | null {
    const list = listRef.current;
    return list ? rowsOf(list).find((r) => r.dataset.sortKey === key) ?? null : null;
  }

  function focusHandle(row: HTMLElement | null | undefined): void {
    row?.querySelector<HTMLElement>('[data-sort-handle]')?.focus();
  }

  /**
   * Clear transforms, measure the real layout, and animate each row from where
   * it was drawn (`from`) to where it now is.
   */
  function settle(from: Map<string, number> | null, drop: { key: string; seq: string } | null, animateEnter: boolean): void {
    const list = listRef.current;
    if (!list) return;
    const rows = rowsOf(list).filter((r) => r.dataset.sortExit === undefined);
    for (const r of rows) {
      cancelAnimations(r);
      r.style.transform = '';
    }
    const now = centersOf(list);
    for (const r of rows) {
      const key = r.dataset.sortKey ?? '';
      const to = now.get(key) ?? 0;
      const was = from?.get(key);
      if (drop && key === drop.key) {
        const anim = animate(r, [{ transform: translate((was ?? to) - to, true) }, { transform: 'none' }]);
        const clear = (): void => {
          if (r.dataset.sortDragging === drop.seq) delete r.dataset.sortDragging;
        };
        if (anim) {
          anim.addEventListener('finish', clear);
          anim.addEventListener('cancel', clear);
        } else clear();
      } else if (was === undefined) {
        if (animateEnter) {
          animate(r, [
            { opacity: 0, transform: 'translateY(-6px)' },
            { opacity: 1, transform: 'none' },
          ]);
        }
      } else if (Math.abs(was - to) > 0.5) {
        animate(r, [{ transform: translate(was - to) }, { transform: 'none' }]);
      }
    }
    stored.current = now;
  }

  /** Undo a collapse whose removal did not happen (the parent kept the item). */
  function restoreExiting(): void {
    const current = latest.current.items;
    for (const [key, state] of exiting.current) {
      if (!current.includes(key)) {
        exiting.current.delete(key);
      } else if (state === 'removed') {
        const row = rowFor(key);
        if (row) {
          cancelAnimations(row);
          delete row.dataset.sortExit;
        }
        exiting.current.delete(key);
      }
    }
  }

  function commit(key: string, from: number, to: number): void {
    const { items: current, itemLabel: nameOf, onReorder } = latest.current;
    const next = [...current];
    next.splice(from, 1);
    next.splice(to, 0, key);
    announce(`Moved ${nameOf(key)} to position ${to + 1} of ${next.length}`);
    onReorder(next, { item: key, from, to });
  }

  function moveBy(index: number, dir: -1 | 1): void {
    const list = listRef.current;
    const current = latest.current.items;
    const key = current[index];
    const to = index + dir;
    if (!list || key === undefined || to < 0 || to >= current.length || drag.current || grabRef.current) return;
    if (exiting.current.has(key)) return;
    const active = document.activeElement;
    pendingFocus.current =
      active instanceof HTMLElement && list.contains(active) ? { kind: 'element', el: active, key } : null;
    pendingFrom.current = centersOf(list);
    pendingDrop.current = null;
    commit(key, index, to);
  }

  function removeItem(key: string): void {
    const { onRemove, items: current, itemLabel: nameOf } = latest.current;
    const list = listRef.current;
    if (!onRemove || !list || exiting.current.has(key) || drag.current || grabRef.current) return;
    const index = current.indexOf(key);
    const row = rowFor(key);
    const active = document.activeElement;
    pendingFocus.current = row && active instanceof Node && row.contains(active) ? { kind: 'index', index } : null;
    announce(`Removed ${nameOf(key)}`);
    if (!row) {
      onRemove(key);
      return;
    }
    const height = row.getBoundingClientRect().height;
    const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
    cancelAnimations(row);
    row.style.transform = '';
    row.dataset.sortExit = '';
    const anim = animate(
      row,
      [
        { height: `${height}px`, opacity: 1 },
        {
          height: '0px',
          opacity: 0,
          paddingTop: '0px',
          paddingBottom: '0px',
          borderTopWidth: '0px',
          borderBottomWidth: '0px',
          marginBottom: `${-gap}px`,
        },
      ],
      { fill: 'forwards' },
    );
    if (!anim) {
      delete row.dataset.sortExit;
      onRemove(key);
      return;
    }
    exiting.current.set(key, 'animating');
    anim.addEventListener('finish', () => {
      if (exiting.current.get(key) !== 'animating') return;
      exiting.current.set(key, 'removed');
      // The rows below already slid up with the collapse: measure them there
      // so the commit that drops this row does not animate them again.
      if (listRef.current) stored.current = centersOf(listRef.current);
      // Commit the removal now, so the collapsed row never flashes back.
      flushSync(() => latest.current.onRemove?.(key));
      restoreExiting();
    });
  }

  // ---- Pointer drag -------------------------------------------------------

  function stopDragListeners(d: DragState): void {
    window.removeEventListener('keydown', d.onKey, true);
    if (d.scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.scrollRaf);
    d.scrollRaf = 0;
    document.documentElement.classList.remove('tzx-sort-grabbing');
    if (listRef.current) delete listRef.current.dataset.sorting;
    try {
      if (d.handle.hasPointerCapture?.(d.pointerId)) d.handle.releasePointerCapture(d.pointerId);
    } catch {
      // The pointer is already gone.
    }
  }

  function updateDrag(): void {
    const d = drag.current;
    const list = listRef.current;
    if (!d || !list) return;
    const listTop = list.getBoundingClientRect().top;
    const dy = Math.min(d.maxDy, Math.max(d.minDy, d.lastClientY - listTop - d.startY));
    const dragged = d.rows[d.from];
    if (dragged) dragged.style.transform = translate(dy, true);
    const center = (d.centers[d.from] ?? 0) + dy;
    let target = 0;
    d.centers.forEach((c, j) => {
      if (j !== d.from && c < center) target += 1;
    });
    if (target === d.target) return;
    d.target = target;
    d.rows.forEach((row, j) => {
      if (j === d.from) return;
      let shift = 0;
      if (d.from < target && j > d.from && j <= target) shift = -d.step;
      else if (target < d.from && j >= target && j < d.from) shift = d.step;
      if (shift === d.shifts[j]) return;
      // Start from where the row is drawn now, even mid-animation.
      const r = row.getBoundingClientRect();
      const current = r.top + r.height / 2 - listTop - (d.centers[j] ?? 0);
      cancelAnimations(row);
      row.style.transform = shift ? translate(shift) : '';
      animate(row, [{ transform: translate(current) }, { transform: shift ? translate(shift) : 'none' }]);
      d.shifts[j] = shift;
    });
  }

  function autoScrollStep(): void {
    const d = drag.current;
    if (!d) return;
    d.scrollRaf = 0;
    const speed = scrollSpeed(d.lastClientY);
    if (speed === 0) return;
    const before = window.scrollY;
    window.scrollBy(0, speed);
    if (window.scrollY === before) return; // at the end of the page
    updateDrag();
    d.scrollRaf = requestAnimationFrame(autoScrollStep);
  }

  function scrollSpeed(clientY: number): number {
    const top = (latest.current.topInset ?? 0) + EDGE_PX;
    const bottom = window.innerHeight - EDGE_PX;
    if (clientY < top) return -Math.ceil(MAX_SCROLL_PX * Math.min(1, (top - clientY) / EDGE_PX));
    if (clientY > bottom) return Math.ceil(MAX_SCROLL_PX * Math.min(1, (clientY - bottom) / EDGE_PX));
    return 0;
  }

  function endDrag(mode: 'drop' | 'cancel'): void {
    const d = drag.current;
    const list = listRef.current;
    if (!d) return;
    drag.current = null;
    stopDragListeners(d);
    if (!list) return;
    const from = centersOf(list);
    const drop = { key: d.key, seq: d.seq };
    const nameOf = latest.current.itemLabel;
    if (mode === 'drop' && d.target !== d.from) {
      pendingFrom.current = from;
      pendingDrop.current = drop;
      pendingFocus.current = null;
      commit(d.key, d.from, d.target);
      // If the parent did not re-render with the new order, put rows back.
      window.setTimeout(() => {
        if (pendingDrop.current !== drop) return;
        pendingFrom.current = null;
        pendingDrop.current = null;
        settle(from, drop, false);
      }, 0);
      return;
    }
    if (mode === 'cancel') {
      announce(`Reorder cancelled. ${nameOf(d.key)} stays at position ${d.from + 1} of ${d.rows.length}`);
    }
    settle(from, drop, false);
  }

  function onDragKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    endDrag('cancel');
  }

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>, key: string): void {
    const list = listRef.current;
    // A row held from the keyboard stays held until Space, Enter or Escape.
    if (!list || !e.isPrimary || exiting.current.size > 0 || grabRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const stale = drag.current;
    if (stale) {
      // A drag is only live while its handle still holds that pointer. A
      // pointer that is pressed again, or a drag whose capture is gone (its
      // pointerup or cancel never arrived), is stuck: drop it so it cannot
      // block this one.
      const live =
        stale.pointerId !== e.pointerId &&
        stale.handle.isConnected &&
        stale.handle.hasPointerCapture?.(stale.pointerId) === true;
      if (live) return;
      endDrag('cancel');
    }
    const rows = rowsOf(list);
    const from = rows.findIndex((r) => r.dataset.sortKey === key);
    const row = rows[from];
    if (!row) return;
    e.preventDefault();
    const handle = e.currentTarget;
    try {
      handle.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort; move events still reach the handle.
    }
    for (const r of rows) {
      cancelAnimations(r);
      r.style.transform = '';
    }
    const listRect = list.getBoundingClientRect();
    const rects = rows.map((r) => r.getBoundingClientRect());
    const centers = rects.map((r) => r.top + r.height / 2 - listRect.top);
    const first = rects[0];
    const second = rects[1];
    const gap = first && second ? Math.max(0, second.top - (first.top + first.height)) : 0;
    const own = rects[from] ?? row.getBoundingClientRect();
    const ownTop = own.top - listRect.top;
    const last = rects[rects.length - 1];
    const listBottom = last ? last.top + last.height - listRect.top : own.height;
    dragSeq.current += 1;
    const seq = String(dragSeq.current);
    drag.current = {
      pointerId: e.pointerId,
      key,
      from,
      seq,
      handle,
      rows,
      centers,
      step: own.height + gap,
      startY: e.clientY - listRect.top,
      minDy: -ownTop,
      maxDy: listBottom - (ownTop + own.height),
      shifts: rows.map(() => 0),
      onKey: onDragKeyDown,
      target: from,
      lastClientY: e.clientY,
      scrollRaf: 0,
    };
    row.dataset.sortDragging = seq;
    list.dataset.sorting = '';
    document.documentElement.classList.add('tzx-sort-grabbing');
    window.addEventListener('keydown', drag.current.onKey, true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLButtonElement>): void {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    d.lastClientY = e.clientY;
    updateDrag();
    if (!d.scrollRaf && scrollSpeed(e.clientY) !== 0 && typeof requestAnimationFrame === 'function') {
      d.scrollRaf = requestAnimationFrame(autoScrollStep);
    }
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLButtonElement>, mode: 'drop' | 'cancel'): void {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    endDrag(mode);
  }

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>, index: number): void {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveBy(index, e.key === 'ArrowUp' ? -1 : 1);
  }

  // ---- Keyboard pick-up: Space/Enter, arrows, Space/Enter or Escape -------

  /** Keep focus on the held row's handle across the re-render that moves it. */
  function keepFocus(key: string): void {
    const list = listRef.current;
    const active = document.activeElement;
    pendingFocus.current =
      list && active instanceof HTMLElement && list.contains(active) ? { kind: 'element', el: active, key } : null;
  }

  function pickUp(key: string): void {
    const current = latest.current.items;
    const from = current.indexOf(key);
    if (from < 0 || drag.current || exiting.current.size > 0) return;
    setGrab({ key, from, order: [...current], base: current.join('\n') });
    announce(
      `Picked up ${latest.current.itemLabel(key)}, position ${from + 1} of ${current.length}. ` +
        'Press Up or Down Arrow to move it, Space or Enter to drop it, Escape to cancel.',
    );
  }

  function grabMove(dir: -1 | 1): void {
    const g = grabRef.current;
    const list = listRef.current;
    if (!g || !list) return;
    const name = latest.current.itemLabel(g.key);
    const n = g.order.length;
    const at = g.order.indexOf(g.key);
    const to = at + dir;
    if (to < 0 || to >= n) {
      announce(`${name} is already ${to < 0 ? 'first' : 'last'}, position ${at + 1} of ${n}`);
      return;
    }
    const order = [...g.order];
    order.splice(at, 1);
    order.splice(to, 0, g.key);
    pendingFrom.current = centersOf(list);
    pendingDrop.current = null;
    keepFocus(g.key);
    setGrab({ ...g, order });
    announce(`${name}, position ${to + 1} of ${n}`);
  }

  function dropGrab(): void {
    const g = grabRef.current;
    const list = listRef.current;
    if (!g) return;
    const name = latest.current.itemLabel(g.key);
    const at = g.order.indexOf(g.key);
    setGrab(null);
    if (at === g.from || !list) {
      announce(`Dropped ${name}. It stays at position ${g.from + 1} of ${g.order.length}`);
      return;
    }
    // If the parent keeps the old order, the rows slide back from here.
    const from = centersOf(list);
    pendingFrom.current = from;
    pendingDrop.current = null;
    keepFocus(g.key);
    announce(`Dropped ${name} at position ${at + 1} of ${g.order.length}`);
    latest.current.onReorder([...g.order], { item: g.key, from: g.from, to: at });
    // The parent took the order in the same render (nothing moved): clear.
    window.setTimeout(() => {
      if (pendingFrom.current === from) {
        pendingFrom.current = null;
        pendingFocus.current = null;
      }
    }, 0);
  }

  function cancelGrab(refocus: boolean): void {
    const g = grabRef.current;
    const list = listRef.current;
    if (!g) return;
    setGrab(null);
    if (g.order.indexOf(g.key) !== g.from && list) {
      pendingFrom.current = centersOf(list);
      pendingDrop.current = null;
      if (refocus) keepFocus(g.key);
      else pendingFocus.current = null;
    }
    announce(`Reorder cancelled. ${latest.current.itemLabel(g.key)} stays at position ${g.from + 1} of ${g.order.length}`);
  }

  function onHandleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, key: string): void {
    if (e.ctrlKey || e.metaKey) return;
    const g = grabRef.current;
    const pickKey = e.key === ' ' || e.key === 'Enter';
    if (!g) {
      if (!pickKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) pickUp(key);
      return;
    }
    if (g.key !== key) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Alt+arrow moves the held row too, rather than committing a move.
      grabMove(e.key === 'ArrowUp' ? -1 : 1);
    } else if (pickKey) {
      if (!e.repeat) dropGrab();
    } else if (e.key === 'Escape') {
      cancelGrab(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onHandleBlur(key: string): void {
    const g = grabRef.current;
    if (!g || g.key !== key) return;
    // Moving the row re-inserts its handle, which may blur it before focus is
    // put back. Only a focus that stays elsewhere ends the grab.
    window.setTimeout(() => {
      if (grabRef.current !== g) return;
      const handle = rowFor(g.key)?.querySelector('[data-sort-handle]');
      if (handle && document.activeElement === handle) return;
      cancelGrab(false);
    }, 0);
  }

  // ---- After every change of order or membership: FLIP, focus, cleanup ---

  // The parent changed the list under a keyboard grab (another tab, a sync):
  // the list already shows the parent's order; end the grab and say so.
  useLayoutEffect(() => {
    const g = grabRef.current;
    if (!g || g.base === itemsString) return;
    grabRef.current = null;
    setGrabState(null);
    // The FLIP effect below runs next in this commit and puts focus back.
    if (items.includes(g.key)) keepFocus(g.key);
    announce('Reorder cancelled. The list changed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsString]);

  const keyString = shownItems.join('\n');
  useLayoutEffect(() => {
    const list = listRef.current;
    const before = prevKeys.current;
    prevKeys.current = keyString;
    if (!list) return;
    if (before === null) {
      stored.current = centersOf(list);
      return;
    }
    if (before === keyString) return;
    // The list changed under a drag (another tab, a sync): drop the drag.
    const d = drag.current;
    if (d) {
      drag.current = null;
      stopDragListeners(d);
      delete d.rows[d.from]?.dataset.sortDragging;
    }
    const from = pendingFrom.current ?? stored.current;
    const drop = pendingDrop.current;
    pendingFrom.current = null;
    pendingDrop.current = null;
    restoreExiting();
    settle(from, drop, true);

    const focus = pendingFocus.current;
    pendingFocus.current = null;
    if (focus?.kind === 'element') {
      const el = focus.el;
      if (el.isConnected && !(el instanceof HTMLButtonElement && el.disabled)) {
        if (document.activeElement !== el) el.focus();
      } else {
        focusHandle(rowFor(focus.key));
      }
    } else if (focus?.kind === 'index') {
      const rows = rowsOf(list).filter((r) => r.dataset.sortExit === undefined);
      focusHandle(rows[Math.min(focus.index, rows.length - 1)]);
    }
    // Reads refs and DOM only; runs when the order or membership changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyString]);

  // Leave the page clean if the list unmounts mid-drag.
  useEffect(
    () => () => {
      const d = drag.current;
      drag.current = null;
      if (d) stopDragListeners(d);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <>
      <ul ref={listRef} className={`tzx-sort-list${className ? ` ${className}` : ''}`} aria-label={label}>
        {shownItems.map((item, index) => {
          const name = itemLabel(item);
          const held = activeGrab?.key === item;
          const ctx: SortableItemContext = {
            index,
            count: shownItems.length,
            move: (dir) => moveBy(index, dir),
            remove: () => removeItem(item),
          };
          return (
            <li
              key={item}
              data-sort-key={item}
              // A row held from the keyboard looks lifted, like a pointer drag.
              data-sort-dragging={held ? 'key' : undefined}
              className={`tzx-sort-item${itemClassName ? ` ${itemClassName}` : ''}`}
              tabIndex={-1}
              onKeyDown={(e) => onRowKeyDown(e, index)}
            >
              <button
                type="button"
                className="tzx-sort-handle"
                data-sort-handle=""
                aria-label={`Drag to reorder ${name}`}
                aria-describedby={hintId}
                aria-keyshortcuts="Space Enter Alt+ArrowUp Alt+ArrowDown"
                aria-pressed={held}
                onKeyDown={(e) => onHandleKeyDown(e, item)}
                onBlur={() => onHandleBlur(item)}
                onPointerDown={(e) => onPointerDown(e, item)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => onPointerEnd(e, 'drop')}
                onPointerCancel={(e) => onPointerEnd(e, 'cancel')}
                // Capture can be taken away without a pointerup or
                // pointercancel (e.g. the handle re-renders or the window loses
                // the pointer). Our own release after a drop fires this too,
                // but by then the drag is already over and it is a no-op.
                onLostPointerCapture={(e) => onPointerEnd(e, 'cancel')}
              >
                <GripIcon />
              </button>
              {render(item, ctx)}
            </li>
          );
        })}
      </ul>
      <p id={hintId} className="tzx-sr-only">
        Drag to reorder, or press Space or Enter to pick up, the arrow keys to move, and Space or Enter to drop. Alt+Up
        Arrow and Alt+Down Arrow move a row at once. Escape cancels.
      </p>
      <p className="tzx-sr-only" aria-live="polite" aria-atomic="true">
        {message}
      </p>
    </>
  );
}
