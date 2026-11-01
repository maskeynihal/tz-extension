import { useEffect, useMemo, useRef, useState } from 'react';
import type { DateOnlyPolicy, NumericDateOrder, ParsedTime, Preferences } from '../types';
import { formatCalendarDate, resolveLocalZone } from '../types';
import { viewInZone, isValidZone, sameZone, zoneLabel, resolveZone } from '../lib/tz';
import { SCAN_LIMIT } from '../lib/parse';
import { ZonePicker, ZONE_PICKER_CSS } from '../popup/ZonePicker';

/** Where a card lives: the transient card, pinned to a spot on the page, or floating on screen. */
export type CardPlacement = 'transient' | 'pinned' | 'floating';

export interface PopoverProps {
  readonly parsed: ParsedTime;
  readonly matchCount: number;
  readonly prefs: Preferences;
  /** True for pinned and floating cards (they stay until closed). */
  readonly pinned: boolean;
  /** Pinned to the page (scrolls with it) or floating on screen. Default: pinned when `pinned`. */
  readonly placement?: CardPlacement;
  /** Compact card: only the converted rows, no header text / add box. */
  readonly compact?: boolean;
  /** This pin's number (1-based) — shown as a colored badge tying card to highlight. */
  readonly pinNumber?: number;
  /** This pin's highlight color (the dot/badge color matching the on-page mark). */
  readonly pinDot?: string;
  /** Pin a transient card. Absent on an already-pinned card. */
  readonly onPin?: () => void;
  /** Pinned card: float it on screen; floating card: pin it back to the page. */
  readonly onTogglePlacement?: () => void;
  readonly onClose: () => void;
  /** Toggle this card between full and compact. */
  readonly onToggleCompact?: () => void;
  /** Start dragging the card from the header. Provided by the host. */
  readonly onDragStart?: (e: React.PointerEvent) => void;
  /** Re-resolve the instant when the date-only time policy flips. */
  readonly onDateOnlyPolicy?: (policy: DateOnlyPolicy) => void;
  /** Re-resolve an ambiguous numeric date with the other day/month order. */
  readonly onDateOrder?: (order: NumericDateOrder) => void;
}

/** Small stroke icons, sized by the button font. */
function Icon({ name }: { readonly name: 'pin' | 'float' | 'compact' | 'expand' | 'close' }): JSX.Element {
  const common = {
    width: 14,
    height: 14,
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
        <svg {...common}>
          <path d="M12 17v5" />
          <path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76Z" />
          <path d="M8 2h8" />
        </svg>
      );
    case 'float':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="14" height="12" rx="2" />
          <path d="M21 10v8a2 2 0 0 1-2 2H9" />
        </svg>
      );
    case 'compact':
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      );
    case 'expand':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      );
    case 'close':
      return (
        <svg {...common}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
  }
}

/**
 * Controls that are not text. A mousedown on one of them must not start a
 * selection inside the card, which would drop the page selection (and the
 * user's chance to copy it). The card's own background counts too.
 */
const NON_TEXT_CONTROLS = 'button, [role="button"], .tzx-head, .tzx-order, .tzx-order-btn';

/**
 * Keep the page selection when the user clicks a card control (so copy still
 * works), but let a mousedown on the card's text through, so the converted
 * times can be selected and copied.
 */
export function keepPageSelection(e: React.MouseEvent): void {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (t === e.currentTarget || t.closest(NON_TEXT_CONTROLS)) e.preventDefault();
}

/** "day first" / "month first", for labels and titles. */
function orderName(order: NumericDateOrder): string {
  return order === 'dmy' ? 'day first' : 'month first';
}

/** True when nothing on the page holds focus (so focusing the card takes it from no one). */
function pageFocusIsFree(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

const LOCAL_ZONE = resolveLocalZone();

const STYLE = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.tzx-card {
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #24262e;
  background: #ffffff;
  border: 1px solid #e6e7ec;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(15,17,21,0.14);
  padding: 10px 12px;
  min-width: 240px;
  max-width: 360px;
  -webkit-font-smoothing: antialiased;
}
.tzx-card.pinned { border-color: #1313ba; box-shadow: 0 10px 30px rgba(19,19,186,0.18); }
.tzx-card.compact { min-width: 190px; padding: 6px 8px; }
.tzx-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 8px; margin-bottom: 8px; cursor: grab; user-select: none;
}
.tzx-card.compact .tzx-head { margin-bottom: 4px; }
.tzx-head:active { cursor: grabbing; }
.tzx-title { font-weight: 600; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #898c96; display: flex; align-items: center; gap: 6px; }
.tzx-grip { color: #b4b6be; font-size: 12px; }
.tzx-pindot { color: #1313ba; font-size: 11px; }
.tzx-pinbadge { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; color: #fff; font-size: 12px; font-weight: 800; line-height: 1; }
.tzx-actions { display: flex; align-items: center; gap: 2px; }
.tzx-btn {
  border: none; background: transparent; cursor: pointer;
  font-size: 14px; line-height: 1; color: #5b5e68; opacity: 0.85; padding: 3px 5px; border-radius: 6px;
}
.tzx-btn:hover { opacity: 1; background: #f1f2f5; color: #16181d; }
.tzx-btn.active { opacity: 1; color: #1313ba; }
.tzx-src {
  font-size: 11px; color: #5b5e68; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 1px solid #e6e7ec;
  word-break: break-word;
}
.tzx-assumed { color: #f97316; font-weight: 600; }
.tzx-fmt { color: #898c96; }
.tzx-nomatch p { margin: 0 0 8px; font-size: 12px; color: #5b5e68; word-break: break-word; }
.tzx-nomatch .tzx-quote { color: #16181d; font-weight: 600; }
.tzx-linkbtn { font: inherit; font-size: 12px; font-weight: 600; border: 1px solid #dcdee4; background: #fff; color: #1313ba; border-radius: 6px; padding: 5px 9px; cursor: pointer; }
.tzx-linkbtn:hover { border-color: #1313ba; }
.tzx-dateonly { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-size: 11px; }
.tzx-dateonly select { font: inherit; font-size: 11px; padding: 2px 5px; border-radius: 6px; border: 1px solid #dcdee4; background: #fff; color: #24262e; }

/* Stacked row: zone label on its own line, value below — no truncation. */
.tzx-row { padding: 5px 0; }
.tzx-row + .tzx-row { border-top: 1px solid #f1f2f5; }
.tzx-zonewrap { display: flex; align-items: center; gap: 5px; }
.tzx-zone { color: #5b5e68; font-size: 12px; font-weight: 500; }
.tzx-row.local .tzx-zone { text-decoration: underline; text-decoration-color: #1313ba; text-underline-offset: 2px; font-weight: 600; color: #16181d; }
.tzx-localtag { font-size: 9px; font-weight: 700; color: #1313ba; background: #ebebfa; border-radius: 4px; padding: 1px 4px; letter-spacing: 0.04em; }
.tzx-del { border: none; background: transparent; cursor: pointer; color: #898c96; opacity: 0.6; font-size: 12px; padding: 0 2px; line-height: 1; margin-left: auto; }
.tzx-del:hover { opacity: 1; color: #be123c; }
.tzx-val { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-top: 1px; }
.tzx-date { font-size: 11px; color: #898c96; font-variant-numeric: tabular-nums; }
.tzx-time { font-variant-numeric: tabular-nums; font-weight: 600; color: #16181d; }
.tzx-off { color: #898c96; font-size: 11px; }
/* Compact: single line per zone, no date, no remove button. */
.tzx-card.compact .tzx-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 1px 0; border: none; }
.tzx-card.compact .tzx-zone { font-size: 11px; }
.tzx-card.compact .tzx-date, .tzx-card.compact .tzx-del, .tzx-card.compact .tzx-localtag { display: none; }
.tzx-card.compact .tzx-val { margin-top: 0; flex-wrap: nowrap; }
.tzx-more { font-size: 11px; color: #898c96; margin-top: 6px; }
.tzx-add { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e6e7ec; }
.tzx-select {
  width: 100%; font: inherit; font-size: 12px; padding: 6px 7px;
  border-radius: 6px; border: 1px solid #dcdee4;
  background: #fff; color: #24262e; cursor: pointer;
}
@media (prefers-color-scheme: dark) {
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-card { color: #e7e8ec; background: #121318; border-color: #2a2c33; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-card.pinned { border-color: #8989dd; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-title { color: #787b85; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-grip { color: #5f6169; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-pindot { color: #9d9dea; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-btn { color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-btn:hover { background: #22242b; color: #f3f4f6; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-btn.active { color: #9d9dea; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-src, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-add { border-color: #2a2c33; color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-row + .tzx-row { border-color: #22242b; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-zone { color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-date, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-off, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-more { color: #787b85; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-time { color: #f3f4f6; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-assumed { color: #fb923c; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-select, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-dateonly select { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-localtag { color: #c7c7f5; background: #2a2a5a; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-row.local .tzx-zone { text-decoration-color: #8989dd; color: #f3f4f6; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-nomatch p, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-fmt { color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-nomatch .tzx-quote { color: #f3f4f6; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-linkbtn { background: #1b1d24; border-color: #33353d; color: #9d9dea; }
}
/* Explicit dark override (user chose Dark), independent of the OS setting. */
:host([data-tz-theme='dark']) .tzx-card { color: #e7e8ec; background: #121318; border-color: #2a2c33; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
:host([data-tz-theme='dark']) .tzx-card.pinned { border-color: #8989dd; }
:host([data-tz-theme='dark']) .tzx-title { color: #787b85; }
:host([data-tz-theme='dark']) .tzx-grip { color: #5f6169; }
:host([data-tz-theme='dark']) .tzx-pindot { color: #9d9dea; }
:host([data-tz-theme='dark']) .tzx-btn { color: #a0a3ac; }
:host([data-tz-theme='dark']) .tzx-btn:hover { background: #22242b; color: #f3f4f6; }
:host([data-tz-theme='dark']) .tzx-btn.active { color: #9d9dea; }
:host([data-tz-theme='dark']) .tzx-src, :host([data-tz-theme='dark']) .tzx-add { border-color: #2a2c33; color: #a0a3ac; }
:host([data-tz-theme='dark']) .tzx-row + .tzx-row { border-color: #22242b; }
:host([data-tz-theme='dark']) .tzx-zone { color: #a0a3ac; }
:host([data-tz-theme='dark']) .tzx-date, :host([data-tz-theme='dark']) .tzx-off, :host([data-tz-theme='dark']) .tzx-more { color: #787b85; }
:host([data-tz-theme='dark']) .tzx-time { color: #f3f4f6; }
:host([data-tz-theme='dark']) .tzx-assumed { color: #fb923c; }
:host([data-tz-theme='dark']) .tzx-select, :host([data-tz-theme='dark']) .tzx-dateonly select { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
:host([data-tz-theme='dark']) .tzx-localtag { color: #c7c7f5; background: #2a2a5a; }
:host([data-tz-theme='dark']) .tzx-row.local .tzx-zone { text-decoration-color: #8989dd; color: #f3f4f6; }
:host([data-tz-theme='dark']) .tzx-nomatch p, :host([data-tz-theme='dark']) .tzx-fmt { color: #a0a3ac; }
:host([data-tz-theme='dark']) .tzx-nomatch .tzx-quote { color: #f3f4f6; }
:host([data-tz-theme='dark']) .tzx-linkbtn { background: #1b1d24; border-color: #33353d; color: #9d9dea; }
${ZONE_PICKER_CSS}
.tzx-btn svg { display: block; }
.tzx-card-picker input { font-size: 12px; }
.tzx-card.floating { border-style: dashed; border-color: #1313ba; }
.tzx-floattag { font-size: 9px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #1313ba; background: #ebebfa; border-radius: 4px; padding: 1px 5px; }
.tzx-order { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 6px; font-size: 11px; }
.tzx-order-label { color: #5b5e68; margin-right: 2px; }
.tzx-order-btn { font: inherit; font-size: 11px; font-weight: 600; display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 8px; border-radius: 999px; border: 1px solid #dcdee4; background: #fff; color: #24262e; cursor: pointer; }
.tzx-order-btn:hover { border-color: #1313ba; }
.tzx-order-btn { font-weight: 500; color: #5b5e68; }
.tzx-order-btn.on { background: #1313ba; border-color: #1313ba; color: #fff; font-weight: 700; cursor: default; }
.tzx-order-check { font-weight: 800; }
.tzx-order.mini { gap: 3px; margin: 0 0 4px; }
.tzx-order.mini .tzx-order-btn { font-size: 10px; padding: 1px 6px; gap: 3px; }
.tzx-btn:focus-visible, .tzx-order-btn:focus-visible, .tzx-del:focus-visible { outline: 2px solid #1313ba; outline-offset: 1px; }
.tzx-card:focus { outline: none; }
.tzx-card:focus-visible { outline: 2px solid #1313ba; outline-offset: 2px; }
/* Never wider than a phone screen; long zone names give way, the time and offset never clip. */
.tzx-card { max-width: min(360px, calc(100vw - 16px)); }
.tzx-card.compact .tzx-zonewrap { min-width: 0; }
.tzx-card.compact .tzx-zone { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tzx-card.compact .tzx-val { flex-shrink: 0; }
@media (prefers-color-scheme: dark) {
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-btn { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-btn.on { background: #8989dd; border-color: #8989dd; color: #0f1115; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-label { color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-btn:focus-visible, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-btn:focus-visible, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-del:focus-visible, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-card:focus-visible { outline-color: #9d9dea; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-card.floating { border-color: #8989dd; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-floattag { background: #2a2a5a; color: #c7c7f5; }
  }
:host([data-tz-theme='dark']) .tzx-order-btn { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
:host([data-tz-theme='dark']) .tzx-order-btn.on { background: #8989dd; border-color: #8989dd; color: #0f1115; }
:host([data-tz-theme='dark']) .tzx-order-label { color: #a0a3ac; }
:host([data-tz-theme='dark']) .tzx-btn:focus-visible, :host([data-tz-theme='dark']) .tzx-order-btn:focus-visible, :host([data-tz-theme='dark']) .tzx-del:focus-visible, :host([data-tz-theme='dark']) .tzx-card:focus-visible { outline-color: #9d9dea; }
:host([data-tz-theme='dark']) .tzx-card.floating { border-color: #8989dd; }
:host([data-tz-theme='dark']) .tzx-floattag { background: #2a2a5a; color: #c7c7f5; }
`;

export function Popover({
  parsed,
  matchCount,
  prefs,
  pinned,
  placement,
  compact = false,
  pinNumber,
  pinDot,
  onPin,
  onTogglePlacement,
  onClose,
  onToggleCompact,
  onDragStart,
  onDateOnlyPolicy,
  onDateOrder,
}: PopoverProps): JSX.Element {
  const where: CardPlacement = placement ?? (pinned ? 'pinned' : 'transient');
  const cardRef = useRef<HTMLDivElement>(null);
  // Keyboard users reach the new card (Tab moves through its buttons, Escape
  // closes it). Focusing a non-editable element keeps the page selection; a
  // selection in a text field keeps its focus instead, so it stays copyable.
  useEffect(() => {
    if (pinned) return;
    if (!pageFocusIsFree()) return;
    cardRef.current?.focus({ preventScroll: true });
    // Only on open: re-renders (size, order, zones) must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [zones, setZones] = useState<string[]>(() => {
    // Drop aliases of zones already listed (e.g. Asia/Katmandu vs Asia/Kathmandu).
    const base: string[] = [];
    for (const z of prefs.targetZones) if (!base.some((b) => sameZone(b, z))) base.push(z);
    if (isValidZone(LOCAL_ZONE) && !base.some((z) => sameZone(z, LOCAL_ZONE))) base.unshift(LOCAL_ZONE);
    return base;
  });
  const suggested = useMemo(
    () => [prefs.homeZone, 'UTC', 'abbr:PT', 'abbr:ET', 'Europe/London', 'Asia/Tokyo'].filter((z) => !zones.includes(z)),
    [prefs.homeZone, zones],
  );

  const sourceLabel = parsed.assumed
    ? `${zoneLabel(parsed.assumedZone)} (assumed)`
    : parsed.sourceZone ?? 'UTC';

  function addZone(zone: string): void {
    if (!zone || !isValidZone(zone)) return;
    setZones((prev) => (prev.some((z) => sameZone(z, zone)) ? prev : [...prev, zone]));
  }
  function removeZone(zone: string): void {
    setZones((prev) => prev.filter((z) => z !== zone));
  }

  // Day/month labels come from the calendar fields as written in the text, so
  // no zone math can shift them (03/04/2024 22:00 PDT is 3 Apr or Mar 4).
  const ambiguous = parsed.dateOrder;
  const readings =
    ambiguous && onDateOrder && ambiguous.date && ambiguous.alternate?.date
      ? (['dmy', 'mdy'] as const).map((order) => {
          const date = order === ambiguous.order ? ambiguous.date : ambiguous.alternate.date;
          const label = formatCalendarDate(date, order);
          // Compact cards show the date without its year ("3 Apr" / "Mar 4").
          return { order, on: order === ambiguous.order, label, short: label.replace(/,?\s+\d+$/, '') };
        })
      : null;
  // Full cards: a labelled pair of pills. Compact cards: the same pair, smaller
  // and without the question. The reading in use is filled and ticked.
  const orderPicker =
    readings && onDateOrder ? (
      <div className={`tzx-order${compact ? ' mini' : ''}`} role="group" aria-label={`Read ${parsed.matchedText} as`}>
        {!compact && <span className="tzx-order-label">Day or month first?</span>}
        {readings.map(({ order, on, label, short }) => (
          <button
            key={order}
            type="button"
            className={`tzx-order-btn${on ? ' on' : ''}`}
            aria-pressed={on}
            aria-label={`${label}, ${orderName(order)}`}
            title={on ? `Read ${orderName(order)}: ${label}` : `Read ${orderName(order)} instead: ${label}`}
            onClick={() => !on && onDateOrder(order)}
          >
            {on && (
              <span className="tzx-order-check" aria-hidden="true">
                ✓
              </span>
            )}
            {compact ? short : label}
          </button>
        ))}
      </div>
    ) : null;

  const pinLabel = where === 'pinned' ? 'Float on screen' : 'Pin to page';

  return (
    <div
      className={`tzx-card${pinned ? ' pinned' : ''}${where === 'floating' ? ' floating' : ''}${compact ? ' compact' : ''}`}
      role="dialog"
      aria-label="Timezone conversion"
      tabIndex={-1}
      ref={cardRef}
      onMouseDown={keepPageSelection}
    >
      <style>{STYLE}</style>
      <div className="tzx-head" onPointerDown={onDragStart} title="Drag to move">
        <span className="tzx-title">
          <span className="tzx-grip" aria-hidden>⋮⋮</span>
          TZ{compact ? '' : ' Converter'}
          {pinned && pinNumber !== undefined && (
            <span
              className="tzx-pinbadge"
              title={`Pin #${pinNumber} — matches the highlight of the same color on the page`}
              style={pinDot ? { background: pinDot } : undefined}
            >
              {pinNumber}
            </span>
          )}
          {where === 'floating' && <span className="tzx-floattag">floating</span>}
        </span>
        <div className="tzx-actions">
          {!pinned && onPin && (
            <button className="tzx-btn" aria-label="Pin to page" title="Pin to page (stays while you work)" onClick={onPin}>
              <Icon name="pin" />
            </button>
          )}
          {pinned && onTogglePlacement && (
            <button
              className={`tzx-btn${where === 'pinned' ? ' active' : ''}`}
              aria-label={pinLabel}
              aria-pressed={where === 'pinned'}
              title={where === 'pinned' ? 'Pinned to the page · click to float it on screen' : 'Floating on screen · click to pin it to the page'}
              onClick={onTogglePlacement}
            >
              <Icon name={where === 'pinned' ? 'pin' : 'float'} />
            </button>
          )}
          {onToggleCompact && (
            <button
              className="tzx-btn"
              aria-label={compact ? 'Expand card' : 'Make compact'}
              title={compact ? 'Expand' : 'Compact (times only)'}
              onClick={onToggleCompact}
            >
              <Icon name={compact ? 'expand' : 'compact'} />
            </button>
          )}
          <button className="tzx-btn" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>

      {!compact && (
        <div className="tzx-src">
          <span>“{parsed.matchedText}”</span>
          <br />
          <span>
            read as{' '}
            <span className={parsed.assumed ? 'tzx-assumed' : undefined}>{sourceLabel}</span>
          </span>
          {parsed.formatLabel && (
            <>
              <br />
              <span className="tzx-fmt" title="The format that recognized this text. You can switch formats off in Settings.">
                format: {parsed.formatLabel}
              </span>
            </>
          )}
          {parsed.dateOnly && onDateOnlyPolicy && (
            <div className="tzx-dateonly">
              <span>date only — time:</span>
              <select
                aria-label="Date-only time policy"
                value={prefs.dateOnlyPolicy}
                onChange={(e) => onDateOnlyPolicy(e.target.value as DateOnlyPolicy)}
              >
                <option value="midnight">midnight (00:00)</option>
                <option value="now">current time</option>
              </select>
            </div>
          )}
          {orderPicker}
        </div>
      )}
      {compact && orderPicker}

      {zones.map((zone) => {
        const v = viewInZone(parsed.epochMs, zone, prefs.hour12);
        const isLocal = sameZone(zone, LOCAL_ZONE);
        const name = zoneLabel(zone);
        return (
          <div className={`tzx-row${isLocal ? ' local' : ''}`} key={zone}>
            <div className="tzx-zonewrap">
              <span className="tzx-zone" title={resolveZone(zone)?.long ?? name}>{name}</span>
              {isLocal && <span className="tzx-localtag" title="Your local timezone">LOCAL</span>}
              {!compact && (
                <button
                  className="tzx-del"
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                  onClick={() => removeZone(zone)}
                >
                  ×
                </button>
              )}
            </div>
            <div className="tzx-val">
              {!compact && <span className="tzx-date">{v.date}</span>}
              <span className="tzx-time">
                {compact ? v.time : `${v.weekday} ${v.time}`}
              </span>
              <span className="tzx-off">{v.offset}</span>
            </div>
          </div>
        );
      })}

      {!compact && matchCount > 1 && (
        <div className="tzx-more">+{matchCount - 1} more time(s) in selection</div>
      )}

      {!compact && (
        <div className="tzx-add">
          <ZonePicker
            label="Add a timezone"
            placeholder="+ Add zone: city, PDT, UTC+3"
            exclude={zones}
            suggested={suggested}
            onSelect={addZone}
            className="tzx-card-picker"
          />
        </div>
      )}
    </div>
  );
}

export interface NoMatchCardProps {
  /** The selection the user asked to convert. */
  readonly text: string;
  /** True when the selection was longer than what is checked. */
  readonly truncated?: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
  readonly onDragStart?: (e: React.PointerEvent) => void;
}

const MAX_QUOTE = 80;

/**
 * Shown when the user explicitly asked to convert (right-click menu) but no
 * enabled format recognized the selection.
 */
export function NoMatchCard({ text, truncated = false, onClose, onOpenSettings, onDragStart }: NoMatchCardProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const quote = oneLine.length > MAX_QUOTE ? `${oneLine.slice(0, MAX_QUOTE - 1)}…` : oneLine;
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="tzx-card tzx-nomatch" role="dialog" aria-label="No time recognized" tabIndex={-1} ref={ref}>
      <style>{STYLE}</style>
      <div className="tzx-head" onPointerDown={onDragStart} title="Drag to move">
        <span className="tzx-title">
          <span className="tzx-grip" aria-hidden>⋮⋮</span>
          TZ Converter
        </span>
        <div className="tzx-actions">
          <button className="tzx-btn" aria-label="Close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <p>
        No date or time recognized in <span className="tzx-quote">“{quote}”</span>.
      </p>
      {(truncated || text.length > SCAN_LIMIT) && (
        <p>Only the first {SCAN_LIMIT.toLocaleString('en-US')} characters of a selection are checked.</p>
      )}
      <p>If this is a format your sites use, add it as a custom format.</p>
      <button type="button" className="tzx-linkbtn" onClick={onOpenSettings}>
        Open format settings
      </button>
    </div>
  );
}
