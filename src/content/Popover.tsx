import { useEffect, useMemo, useRef, useState } from 'react';
import type { DateOnlyPolicy, ParsedTime, Preferences } from '../types';
import { resolveLocalZone } from '../types';
import { viewInZone, listTimeZones, isValidZone } from '../lib/tz';

export interface PopoverProps {
  readonly parsed: ParsedTime;
  readonly matchCount: number;
  readonly prefs: Preferences;
  /** Whether this card is pinned (persisted on the page) or transient. */
  readonly pinned: boolean;
  /** Compact pinned card: only the converted rows, no header text / add box. */
  readonly compact?: boolean;
  /** This pin's number (1-based) — shown as a colored badge tying card to highlight. */
  readonly pinNumber?: number;
  /** This pin's highlight color (the dot/badge color matching the on-page mark). */
  readonly pinDot?: string;
  /** Pin a transient card normally. Absent on an already-pinned card. */
  readonly onPin?: () => void;
  /** Pin a transient card in compact mode. Absent on an already-pinned card. */
  readonly onPinCompact?: () => void;
  readonly onClose: () => void;
  /** Toggle this (pinned) card between full and compact. */
  readonly onToggleCompact?: () => void;
  /** Start dragging the card from the header. Provided by the host. */
  readonly onDragStart?: (e: React.PointerEvent) => void;
  /** Re-resolve the instant when the date-only time policy flips. */
  readonly onDateOnlyPolicy?: (policy: DateOnlyPolicy) => void;
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
  .tzx-card { color: #e7e8ec; background: #121318; border-color: #2a2c33; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
  .tzx-card.pinned { border-color: #8989dd; }
  .tzx-title { color: #787b85; }
  .tzx-grip { color: #5f6169; }
  .tzx-pindot { color: #9d9dea; }
  .tzx-btn { color: #a0a3ac; }
  .tzx-btn:hover { background: #22242b; color: #f3f4f6; }
  .tzx-btn.active { color: #9d9dea; }
  .tzx-src, .tzx-add { border-color: #2a2c33; color: #a0a3ac; }
  .tzx-row + .tzx-row { border-color: #22242b; }
  .tzx-zone { color: #a0a3ac; }
  .tzx-date, .tzx-off, .tzx-more { color: #787b85; }
  .tzx-time { color: #f3f4f6; }
  .tzx-assumed { color: #fb923c; }
  .tzx-select, .tzx-dateonly select { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
  .tzx-localtag { color: #c7c7f5; background: #2a2a5a; }
  .tzx-row.local .tzx-zone { text-decoration-color: #8989dd; color: #f3f4f6; }
}
`;

export function Popover({
  parsed,
  matchCount,
  prefs,
  pinned,
  compact = false,
  pinNumber,
  pinDot,
  onPin,
  onPinCompact,
  onClose,
  onToggleCompact,
  onDragStart,
  onDateOnlyPolicy,
}: PopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  const [zones, setZones] = useState<string[]>(() => {
    const base = [...prefs.targetZones];
    if (isValidZone(LOCAL_ZONE) && !base.includes(LOCAL_ZONE)) base.unshift(LOCAL_ZONE);
    return base;
  });
  const allZones = useMemo(() => listTimeZones(), []);

  useEffect(() => {
    if (!pinned && !prefs.keepSelection) ref.current?.focus();
  }, [pinned, prefs.keepSelection]);

  const sourceLabel = parsed.assumed
    ? `${parsed.assumedZone} (assumed)`
    : parsed.sourceZone ?? 'UTC';

  function addZone(zone: string): void {
    if (!zone || !isValidZone(zone)) return;
    setZones((prev) => (prev.includes(zone) ? prev : [...prev, zone]));
  }
  function removeZone(zone: string): void {
    setZones((prev) => prev.filter((z) => z !== zone));
  }

  return (
    <div
      className={`tzx-card${pinned ? ' pinned' : ''}${compact ? ' compact' : ''}`}
      role="dialog"
      aria-label="Timezone conversion"
      tabIndex={-1}
      ref={ref}
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
        </span>
        <div className="tzx-actions">
          {!pinned && onPin && (
            <button className="tzx-btn" aria-label="Pin to page" title="Pin / stick to page" onClick={onPin}>
              📌
            </button>
          )}
          {!pinned && onPinCompact && (
            <button
              className="tzx-btn"
              aria-label="Pin compact"
              title="Pin a compact card (times only)"
              onClick={onPinCompact}
            >
              ▬
            </button>
          )}
          {pinned && onToggleCompact && (
            <button
              className="tzx-btn"
              aria-label={compact ? 'Expand card' : 'Make compact'}
              title={compact ? 'Expand' : 'Compact (times only)'}
              onClick={onToggleCompact}
            >
              {compact ? '▢' : '▬'}
            </button>
          )}
          <button className="tzx-btn" aria-label="Close" title="Close" onClick={onClose}>
            ×
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
        </div>
      )}

      {zones.map((zone) => {
        const v = viewInZone(parsed.epochMs, zone, prefs.hour12);
        const isLocal = zone === LOCAL_ZONE;
        return (
          <div className={`tzx-row${isLocal ? ' local' : ''}`} key={zone}>
            <div className="tzx-zonewrap">
              <span className="tzx-zone" title={zone}>{zone}</span>
              {isLocal && <span className="tzx-localtag" title="Your local timezone">LOCAL</span>}
              {!compact && (
                <button
                  className="tzx-del"
                  aria-label={`Remove ${zone}`}
                  title={`Remove ${zone}`}
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
          <select
            className="tzx-select"
            aria-label="Add a timezone"
            value=""
            onChange={(e) => {
              addZone(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              + Add timezone…
            </option>
            {allZones
              .filter((z) => !zones.includes(z))
              .map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
