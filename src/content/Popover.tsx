import { useEffect, useRef } from 'react';
import type { ParsedTime, Preferences } from '../types';
import { viewInZone } from '../lib/tz';

export interface PopoverProps {
  readonly parsed: ParsedTime;
  readonly matchCount: number;
  readonly prefs: Preferences;
  readonly onClose: () => void;
}

const STYLE = `
:host { all: initial; }
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
  min-width: 220px;
  max-width: 320px;
  box-sizing: border-box;
}
.tzx-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.tzx-title { font-weight: 600; font-size: 12px; opacity: 0.7; }
.tzx-close {
  border: none; background: transparent; cursor: pointer;
  font-size: 16px; line-height: 1; color: inherit; opacity: 0.55; padding: 2px 4px;
}
.tzx-close:hover { opacity: 1; }
.tzx-src {
  font-size: 11px; opacity: 0.65; margin-bottom: 8px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(0,0,0,0.08);
  word-break: break-word;
}
.tzx-assumed { color: #b45309; font-weight: 600; }
.tzx-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
.tzx-zone { opacity: 0.75; }
.tzx-time { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
.tzx-off { opacity: 0.5; font-size: 11px; margin-left: 4px; }
.tzx-more { font-size: 11px; opacity: 0.55; margin-top: 6px; }
@media (prefers-color-scheme: dark) {
  .tzx-card { color: #f0f0f0; background: #2a2a2e; border-color: rgba(255,255,255,0.12); }
  .tzx-src { border-color: rgba(255,255,255,0.1); }
  .tzx-assumed { color: #fbbf24; }
}
`;

export function Popover({ parsed, matchCount, prefs, onClose }: PopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const sourceLabel = parsed.assumed
    ? `${parsed.assumedZone} (assumed)`
    : parsed.sourceZone ?? 'UTC';

  return (
    <div
      className="tzx-card"
      role="dialog"
      aria-label="Timezone conversion"
      tabIndex={-1}
      ref={ref}
    >
      <style>{STYLE}</style>
      <div className="tzx-head">
        <span className="tzx-title">TZ Converter</span>
        <button className="tzx-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="tzx-src">
        <span>“{parsed.matchedText}”</span>
        <br />
        <span>
          read as{' '}
          <span className={parsed.assumed ? 'tzx-assumed' : undefined}>{sourceLabel}</span>
        </span>
      </div>
      {prefs.targetZones.map((zone) => {
        const v = viewInZone(parsed.epochMs, zone, prefs.hour12);
        return (
          <div className="tzx-row" key={zone}>
            <span className="tzx-zone">{zone}</span>
            <span className="tzx-time">
              {v.weekday} {v.time}
              <span className="tzx-off">{v.offset}</span>
            </span>
          </div>
        );
      })}
      {matchCount > 1 && (
        <div className="tzx-more">+{matchCount - 1} more time(s) in selection</div>
      )}
    </div>
  );
}
