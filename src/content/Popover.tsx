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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: #1a1a1a;
  background: #ffffff;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.18);
  padding: 10px 12px;
  min-width: 240px;
  max-width: 360px;
}
.tzx-card.pinned { border-color: #2563eb; box-shadow: 0 6px 20px rgba(37,99,235,0.28); }
.tzx-card.compact { min-width: 190px; padding: 6px 8px; }
.tzx-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 8px; margin-bottom: 8px; cursor: grab; user-select: none;
}
.tzx-card.compact .tzx-head { margin-bottom: 4px; }
.tzx-head:active { cursor: grabbing; }
.tzx-title { font-weight: 600; font-size: 12px; opacity: 0.7; display: flex; align-items: center; gap: 6px; }
.tzx-grip { opacity: 0.4; font-size: 12px; }
.tzx-pindot { color: #2563eb; font-size: 11px; }
.tzx-actions { display: flex; align-items: center; gap: 2px; }
.tzx-btn {
  border: none; background: transparent; cursor: pointer;
  font-size: 14px; line-height: 1; color: inherit; opacity: 0.55; padding: 3px 5px; border-radius: 6px;
}
.tzx-btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
.tzx-btn.active { opacity: 1; color: #2563eb; }
.tzx-src {
  font-size: 11px; opacity: 0.7; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(0,0,0,0.08);
  word-break: break-word;
}
.tzx-assumed { color: #b45309; font-weight: 600; }
.tzx-dateonly { margin-top: 6px; display: flex; align-items: center; gap: 6px; font-size: 11px; }
.tzx-dateonly select { font: inherit; font-size: 11px; padding: 1px 4px; border-radius: 5px; border: 1px solid rgba(0,0,0,0.18); background: #fff; color: inherit; }

/* Stacked row: zone label on its own line, value below — no truncation. */
.tzx-row { padding: 4px 0; }
.tzx-row + .tzx-row { border-top: 1px solid rgba(0,0,0,0.05); }
.tzx-zonewrap { display: flex; align-items: center; gap: 5px; }
.tzx-zone { opacity: 0.8; font-size: 12px; }
.tzx-row.local .tzx-zone { text-decoration: underline; text-decoration-color: #2563eb; text-underline-offset: 2px; font-weight: 600; }
.tzx-localtag { font-size: 9px; font-weight: 700; color: #2563eb; border: 1px solid #2563eb; border-radius: 4px; padding: 0 3px; letter-spacing: 0.03em; }
.tzx-del { border: none; background: transparent; cursor: pointer; color: inherit; opacity: 0.3; font-size: 12px; padding: 0 2px; line-height: 1; margin-left: auto; }
.tzx-del:hover { opacity: 0.9; color: #dc2626; }
.tzx-val { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-top: 1px; }
.tzx-date { font-size: 11px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.tzx-time { font-variant-numeric: tabular-nums; font-weight: 600; }
.tzx-off { opacity: 0.5; font-size: 11px; }
/* Compact: single line per zone, no date, no remove button. */
.tzx-card.compact .tzx-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 1px 0; border: none; }
.tzx-card.compact .tzx-zone { font-size: 11px; }
.tzx-card.compact .tzx-date, .tzx-card.compact .tzx-del, .tzx-card.compact .tzx-localtag { display: none; }
.tzx-card.compact .tzx-val { margin-top: 0; flex-wrap: nowrap; }
.tzx-more { font-size: 11px; opacity: 0.55; margin-top: 6px; }
.tzx-add { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.08); }
.tzx-select {
  width: 100%; font: inherit; font-size: 12px; padding: 5px 6px;
  border-radius: 6px; border: 1px solid rgba(0,0,0,0.18);
  background: #fff; color: inherit; cursor: pointer;
}
@media (prefers-color-scheme: dark) {
  .tzx-card { color: #f0f0f0; background: #2a2a2e; border-color: rgba(255,255,255,0.12); }
  .tzx-src, .tzx-add { border-color: rgba(255,255,255,0.1); }
  .tzx-row + .tzx-row { border-color: rgba(255,255,255,0.06); }
  .tzx-assumed { color: #fbbf24; }
  .tzx-btn:hover { background: rgba(255,255,255,0.08); }
  .tzx-select, .tzx-dateonly select { background: #1f1f23; border-color: rgba(255,255,255,0.18); }
  .tzx-localtag { color: #60a5fa; border-color: #60a5fa; }
  .tzx-row.local .tzx-zone { text-decoration-color: #60a5fa; }
}
`;

export function Popover({
  parsed,
  matchCount,
  prefs,
  pinned,
  compact = false,
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
          {pinned && <span className="tzx-pindot" title="Pinned">📌</span>}
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
