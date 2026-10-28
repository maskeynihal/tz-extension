import { useMemo, useState } from 'react';
import type { Preferences } from '../types';
import { resolveLocalZone } from '../types';
import { viewInZone, wallClockToEpochMs, epochMsToWallClock, isValidZone } from '../lib/tz';
import { ZonePicker } from './ZonePicker';

export interface ConverterProps {
  readonly prefs: Preferences;
  /** Persist a preferences change (e.g. target-zone edits made here). */
  readonly onPrefsChange: (next: Preferences) => void;
}

const LOCAL_ZONE = resolveLocalZone();

/** Format a Date as the value a datetime-local input expects (no seconds). */
function toLocalInputValue(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function Converter({ prefs, onPrefsChange }: ConverterProps): JSX.Element {
  const [sourceZone, setSourceZone] = useState(prefs.homeZone);
  const [localValue, setLocalValue] = useState<string>(() =>
    toLocalInputValue(new Date()),
  );

  const result = useMemo(() => {
    if (!localValue) return { error: 'Pick a date and time.' as string | null, epochMs: null as number | null };
    if (!isValidZone(sourceZone)) return { error: 'Invalid source timezone.', epochMs: null };
    const iso = localValue.length === 16 ? `${localValue}:00` : localValue;
    try {
      const epochMs = wallClockToEpochMs(iso, sourceZone);
      if (!Number.isFinite(epochMs)) return { error: 'Could not parse that time.', epochMs: null };
      return { error: null, epochMs };
    } catch {
      return { error: 'Could not parse that time.', epochMs: null };
    }
  }, [localValue, sourceZone]);

  function setNow(): void {
    setLocalValue(toLocalInputValue(epochMsToWallClock(Date.now(), sourceZone)));
  }

  function addTarget(zone: string): void {
    if (!isValidZone(zone) || prefs.targetZones.includes(zone)) return;
    onPrefsChange({ ...prefs, targetZones: [...prefs.targetZones, zone] });
  }
  function removeTarget(zone: string): void {
    onPrefsChange({ ...prefs, targetZones: prefs.targetZones.filter((z) => z !== zone) });
  }

  const sourceIsLocal = sourceZone === LOCAL_ZONE;

  return (
    <section className="tzx-pane">
      <div className="tzx-field">
        <label htmlFor="tzx-dt">Date &amp; time</label>
        <div className="tzx-row-inline">
          <input
            id="tzx-dt"
            type="datetime-local"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
          />
          <button type="button" className="tzx-btn" onClick={setNow}>
            Now
          </button>
        </div>
      </div>

      <div className="tzx-field">
        <span className="tzx-field-label">Source timezone</span>
        <div className="tzx-row-inline" style={{ alignItems: 'center', marginBottom: 6 }}>
          <div className="tzx-current-zone" style={{ margin: 0, flex: 1 }}>{sourceZone}</div>
          <button
            type="button"
            className={sourceIsLocal ? 'tzx-chip tzx-chip-on' : 'tzx-chip'}
            title={`Use your local timezone (${LOCAL_ZONE})`}
            onClick={() => setSourceZone(LOCAL_ZONE)}
            disabled={sourceIsLocal || !isValidZone(LOCAL_ZONE)}
          >
            Local
          </button>
        </div>
        <ZonePicker
          label="Source timezone"
          placeholder="Change source timezone…"
          onSelect={setSourceZone}
        />
      </div>

      {result.error ? (
        <p className="tzx-error" role="alert">
          {result.error}
        </p>
      ) : (
        <>
          <div className="tzx-results">
            {prefs.targetZones.map((zone) => {
              const v = viewInZone(result.epochMs as number, zone, prefs.hour12);
              const isLocal = zone === LOCAL_ZONE;
              return (
                <div className="tzx-result-card" key={zone}>
                  <div className="tzx-result-head">
                    <div className="tzx-result-zone">
                      {zone}
                      {isLocal && <span className="tzx-localtag">LOCAL</span>}{' '}
                      <span className="tzx-off">{v.offset}</span>
                    </div>
                    <button
                      type="button"
                      className="tzx-icon-btn tzx-result-del"
                      aria-label={`Remove ${zone}`}
                      title={`Remove ${zone}`}
                      onClick={() => removeTarget(zone)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="tzx-result-time">
                    {v.weekday}, {v.date}
                  </div>
                  <div className="tzx-result-big">{v.time}</div>
                </div>
              );
            })}
          </div>
          <div className="tzx-field" style={{ marginTop: 10, marginBottom: 0 }}>
            <ZonePicker
              label="Add a timezone"
              placeholder="Add a timezone…"
              exclude={prefs.targetZones}
              onSelect={addTarget}
            />
          </div>
        </>
      )}
    </section>
  );
}
