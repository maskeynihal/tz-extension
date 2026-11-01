import { useEffect, useMemo, useRef, useState } from 'react';
import type { DateOnlyPolicy, NumericDateOrder, ParsedTime, Preferences } from '../types';
import { resolveLocalZone } from '../types';
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

/** "22 Mar" for an instant in a zone (the day/month picker labels). */
function dayMonth(epochMs: number, zone: string): string {
  try {
    const tz = resolveZone(zone)?.tz ?? zone;
    if (/^[+-]\d{2}:\d{2}$/.test(tz)) {
      const sign = tz.startsWith('-') ? -1 : 1;
      const mins = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
      return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        new Date(epochMs + mins * 60_000),
      );
    }
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(epochMs));
  } catch {
    return '';
  }
}

/** Keep the page selection when the user clicks inside a card (so copy still works). */
function keepPageSelection(e: React.MouseEvent): void {
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
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
.tzx-card.compact .tzx-order { margin: 0 0 4px; }
.tzx-order-label { color: #5b5e68; margin-right: 2px; }
.tzx-order-btn { font: inherit; font-size: 11px; font-weight: 600; display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 8px; border-radius: 999px; border: 1px solid #dcdee4; background: #fff; color: #24262e; cursor: pointer; }
.tzx-order-btn:hover { border-color: #1313ba; }
.tzx-order-btn.on { background: #1313ba; border-color: #1313ba; color: #fff; cursor: default; }
.tzx-order-hint { font-size: 9px; font-weight: 700; color: #898c96; }
.tzx-order-btn.on .tzx-order-hint { color: #dcdcf7; }
.tzx-btn:focus-visible, .tzx-order-btn:focus-visible, .tzx-del:focus-visible { outline: 2px solid #1313ba; outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
:host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-picker input, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-listbox { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-opt { color: #e7e8ec; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-opt-active { background: #8989dd; color: #0f1115; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-opt-active .tzx-opt-detail { color: #1b1d24; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-optgroup-label, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-opt-detail { color: #8b8e98; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-btn { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-btn.on { background: #8989dd; border-color: #8989dd; color: #0f1115; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-label, :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-order-hint { color: #a0a3ac; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-card.floating { border-color: #8989dd; }
  :host(:not([data-tz-theme='light']):not([data-tz-theme='dark'])) .tzx-floattag { background: #2a2a5a; color: #c7c7f5; }
  }
:host([data-tz-theme='dark']) .tzx-picker input, :host([data-tz-theme='dark']) .tzx-listbox { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
:host([data-tz-theme='dark']) .tzx-opt { color: #e7e8ec; }
:host([data-tz-theme='dark']) .tzx-opt-active { background: #8989dd; color: #0f1115; }
:host([data-tz-theme='dark']) .tzx-opt-active .tzx-opt-detail { color: #1b1d24; }
:host([data-tz-theme='dark']) .tzx-optgroup-label, :host([data-tz-theme='dark']) .tzx-opt-detail { color: #8b8e98; }
:host([data-tz-theme='dark']) .tzx-order-btn { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
:host([data-tz-theme='dark']) .tzx-order-btn.on { background: #8989dd; border-color: #8989dd; color: #0f1115; }
:host([data-tz-theme='dark']) .tzx-order-label, :host([data-tz-theme='dark']) .tzx-order-hint { color: #a0a3ac; }
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

  const ambiguous = parsed.dateOrder;
  const orderPicker =
    ambiguous && onDateOrder ? (
      <div className="tzx-order" role="group" aria-label={`Read ${parsed.matchedText} as`}>
        <span className="tzx-order-label">{compact ? 'Read as' : 'Day or month first?'}</span>
        {(['dmy', 'mdy'] as const).map((order) => {
          const ms = order === ambiguous.order ? parsed.epochMs : ambiguous.alternate.epochMs;
          const on = order === ambiguous.order;
          return (
            <button
              key={order}
              type="button"
              className={`tzx-order-btn${on ? ' on' : ''}`}
              aria-pressed={on}
              title={order === 'dmy' ? 'Day first (22/03/1999)' : 'Month first (03/22/1999)'}
              onClick={() => !on && onDateOrder(order)}
            >
              {dayMonth(ms, parsed.sourceZone ? 'UTC' : parsed.assumedZone)}
              <span className="tzx-order-hint">{order === 'dmy' ? 'D/M' : 'M/D'}</span>
            </button>
          );
        })}
      </div>
    ) : null;

  const pinLabel = where === 'pinned' ? 'Float on screen' : 'Pin to page';

  return (
    <div
      className={`tzx-card${pinned ? ' pinned' : ''}${where === 'floating' ? ' floating' : ''}${compact ? ' compact' : ''}`}
      role="dialog"
      aria-label="Timezone conversion"
      tabIndex={-1}
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
            placeholder="+ Add timezone… (city, UTC+5:30, PDT)"
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
