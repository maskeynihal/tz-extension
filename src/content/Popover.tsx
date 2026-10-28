import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedTime, Preferences } from '../types';
import { viewInZone, listTimeZones, isValidZone } from '../lib/tz';

export interface PopoverProps {
  readonly parsed: ParsedTime;
  readonly matchCount: number;
  readonly prefs: Preferences;
  /** Whether this card is pinned (persisted on the page) or transient. */
  readonly pinned: boolean;
  /** Pin a transient card. Absent on an already-pinned card. */
  readonly onPin?: () => void;
  readonly onClose: () => void;
}

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
  min-width: 248px;
  max-width: 340px;
}
.tzx-card.pinned { border-color: #2563eb; box-shadow: 0 6px 20px rgba(37,99,235,0.28); }
.tzx-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 8px; margin-bottom: 8px;
}
.tzx-title { font-weight: 600; font-size: 12px; opacity: 0.7; display: flex; align-items: center; gap: 6px; }
.tzx-pindot { color: #2563eb; font-size: 11px; }
.tzx-actions { display: flex; align-items: center; gap: 2px; }
.tzx-btn {
  border: none; background: transparent; cursor: pointer;
  font-size: 14px; line-height: 1; color: inherit; opacity: 0.55; padding: 3px 5px; border-radius: 6px;
}
.tzx-btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
.tzx-btn.active { opacity: 1; color: #2563eb; }
.tzx-src {
  font-size: 11px; opacity: 0.65; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(0,0,0,0.08);
  word-break: break-word;
}
.tzx-assumed { color: #b45309; font-weight: 600; }
.tzx-row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 3px 0; }
.tzx-zonewrap { display: flex; align-items: center; gap: 4px; min-width: 0; }
.tzx-zone { opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tzx-del { border: none; background: transparent; cursor: pointer; color: inherit; opacity: 0.35; font-size: 12px; padding: 0 2px; line-height: 1; }
.tzx-del:hover { opacity: 0.9; color: #dc2626; }
.tzx-val { text-align: right; white-space: nowrap; }
.tzx-date { font-size: 11px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.tzx-time { font-variant-numeric: tabular-nums; font-weight: 600; }
.tzx-off { opacity: 0.5; font-size: 11px; margin-left: 4px; }
.tzx-more { font-size: 11px; opacity: 0.55; margin-top: 6px; }
.tzx-add {
  margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.08);
}
.tzx-select {
  width: 100%; font: inherit; font-size: 12px; padding: 5px 6px;
  border-radius: 6px; border: 1px solid rgba(0,0,0,0.18);
  background: #fff; color: inherit; cursor: pointer;
}
@media (prefers-color-scheme: dark) {
  .tzx-card { color: #f0f0f0; background: #2a2a2e; border-color: rgba(255,255,255,0.12); }
  .tzx-src, .tzx-add { border-color: rgba(255,255,255,0.1); }
  .tzx-assumed { color: #fbbf24; }
  .tzx-btn:hover { background: rgba(255,255,255,0.08); }
  .tzx-select { background: #1f1f23; border-color: rgba(255,255,255,0.18); }
}
`;

export function Popover({
  parsed,
  matchCount,
  prefs,
  pinned,
  onPin,
  onClose,
}: PopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Per-card zone list, seeded from preferences. Editable without touching
  // global prefs so each pinned card can compare its own set of zones.
  const [zones, setZones] = useState<string[]>(() => [...prefs.targetZones]);
  const allZones = useMemo(() => listTimeZones(), []);

  useEffect(() => {
    if (!pinned) ref.current?.focus();
  }, [pinned]);

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
      className={`tzx-card${pinned ? ' pinned' : ''}`}
      role="dialog"
      aria-label="Timezone conversion"
      tabIndex={-1}
      ref={ref}
    >
      <style>{STYLE}</style>
      <div className="tzx-head">
        <span className="tzx-title">
          TZ Converter{pinned && <span className="tzx-pindot" title="Pinned">📌</span>}
        </span>
        <div className="tzx-actions">
          {!pinned && onPin && (
            <button
              className="tzx-btn"
              aria-label="Pin to page"
              title="Pin to page — stays until you close it"
              onClick={onPin}
            >
              📌
            </button>
          )}
          <button className="tzx-btn" aria-label="Close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <div className="tzx-src">
        <span>“{parsed.matchedText}”</span>
        <br />
        <span>
          read as{' '}
          <span className={parsed.assumed ? 'tzx-assumed' : undefined}>{sourceLabel}</span>
        </span>
      </div>

      {zones.map((zone) => {
        const v = viewInZone(parsed.epochMs, zone, prefs.hour12);
        return (
          <div className="tzx-row" key={zone}>
            <span className="tzx-zonewrap">
              <span className="tzx-zone" title={zone}>{zone}</span>
              <button
                className="tzx-del"
                aria-label={`Remove ${zone}`}
                title={`Remove ${zone}`}
                onClick={() => removeZone(zone)}
              >
                ×
              </button>
            </span>
            <span className="tzx-val">
              <span className="tzx-date">{v.date}</span>{' '}
              <span className="tzx-time">
                {v.weekday} {v.time}
                <span className="tzx-off">{v.offset}</span>
              </span>
            </span>
          </div>
        );
      })}

      {matchCount > 1 && (
        <div className="tzx-more">+{matchCount - 1} more time(s) in selection</div>
      )}

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
    </div>
  );
}
