import { useMemo, useState } from 'react';
import type { Preferences } from '../types';
import { resolveLocalZone } from '../types';
import { viewInZone, isValidZone, sameZone, zoneLabel } from '../lib/tz';
import { ZonePicker } from './ZonePicker';
import { readWallInput } from './wallnote';

export interface ConverterProps {
  readonly prefs: Preferences;
  /** Persist a preferences change (e.g. target-zone edits made here). */
  readonly onPrefsChange: (next: Preferences) => void;
}

const LOCAL_ZONE = resolveLocalZone();

/**
 * The value a datetime-local input expects (no seconds) for an instant shown
 * as the wall clock of `zone`. Formatted in the zone itself, so the browser's
 * own timezone (and its DST gaps) never leaks into the digits.
 */
function wallInputValue(epochMs: number, zone: string): string {
  const v = viewInZone(epochMs, zone, false);
  return `${v.date}T${v.time.slice(0, 5)}`;
}

export function Converter({ prefs, onPrefsChange }: ConverterProps): JSX.Element {
  const [sourceZone, setSourceZone] = useState(prefs.homeZone);
  // Start at "now", written as the source zone's wall clock.
  const [localValue, setLocalValue] = useState<string>(() =>
    isValidZone(prefs.homeZone) ? wallInputValue(Date.now(), prefs.homeZone) : '',
  );

  const result = useMemo(() => {
    if (!localValue)
      return { error: 'Pick a date and time.' as string | null, epochMs: null as number | null, note: null as string | null };
    if (!isValidZone(sourceZone)) return { error: 'Invalid source timezone.', epochMs: null, note: null };
    const r = readWallInput(localValue, sourceZone, prefs.hour12);
    if (!r) return { error: 'Could not parse that time.', epochMs: null, note: null };
    return { error: null, epochMs: r.epochMs, note: r.note };
  }, [localValue, sourceZone, prefs.hour12]);

  function setNow(): void {
    if (isValidZone(sourceZone)) setLocalValue(wallInputValue(Date.now(), sourceZone));
  }

  /**
   * Change the source zone but keep the same instant: the input is rewritten
   * as the new zone's wall clock, so every result stays put.
   */
  function changeSource(zone: string): void {
    if (!isValidZone(zone)) return;
    if (result.epochMs !== null) setLocalValue(wallInputValue(result.epochMs, zone));
    setSourceZone(zone);
  }

  function addTarget(zone: string): void {
    if (!isValidZone(zone) || prefs.targetZones.some((z) => sameZone(z, zone))) return;
    onPrefsChange({ ...prefs, targetZones: [...prefs.targetZones, zone] });
  }
  function removeTarget(zone: string): void {
    onPrefsChange({ ...prefs, targetZones: prefs.targetZones.filter((z) => z !== zone) });
  }

  // Compare through sameZone: the engine may report a legacy name
  // ("Asia/Katmandu") for the zone the lists call "Asia/Kathmandu".
  const sourceIsLocal = sameZone(sourceZone, LOCAL_ZONE);

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
            aria-describedby={result.note ? 'tzx-dt-note' : undefined}
          />
          <button type="button" className="tzx-btn" onClick={setNow}>
            Now
          </button>
        </div>
        {result.note && (
          <p className="tzx-wall-note" id="tzx-dt-note">
            {result.note}
          </p>
        )}
      </div>

      <div className="tzx-field">
        <span className="tzx-field-label">Source timezone</span>
        <div className="tzx-row-inline" style={{ alignItems: 'center', marginBottom: 6 }}>
          <div className="tzx-current-zone" style={{ margin: 0, flex: 1 }}>{zoneLabel(sourceZone)}</div>
          <button
            type="button"
            className={sourceIsLocal ? 'tzx-chip tzx-chip-on' : 'tzx-chip'}
            title={
              sourceIsLocal
                ? `Source is your local timezone (${zoneLabel(LOCAL_ZONE)})`
                : `Use your local timezone (${zoneLabel(LOCAL_ZONE)})`
            }
            aria-pressed={sourceIsLocal}
            onClick={() => changeSource(LOCAL_ZONE)}
            disabled={!isValidZone(LOCAL_ZONE)}
          >
            Local
          </button>
        </div>
        <ZonePicker
          label="Source timezone"
          placeholder="Change source timezone…"
          onSelect={changeSource}
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
              const isLocal = sameZone(zone, LOCAL_ZONE);
              return (
                <div className="tzx-result-card" key={zone}>
                  <div className="tzx-result-head">
                    <div className="tzx-result-zone">
                      {zoneLabel(zone)}
                      {isLocal && <span className="tzx-localtag">LOCAL</span>}{' '}
                      <span className="tzx-off">{v.offset}</span>
                    </div>
                    <button
                      type="button"
                      className="tzx-icon-btn tzx-result-del"
                      aria-label={`Remove ${zoneLabel(zone)}`}
                      title={`Remove ${zoneLabel(zone)}`}
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
