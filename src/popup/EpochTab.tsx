import { useMemo, useState } from 'react';
import type { Preferences } from '../types';
import { parseEpoch, toEpochSeconds, toEpochMillis, type EpochUnit } from '../lib/epoch';
import { viewInZone, toIsoUtc, isValidZone, zoneLabel } from '../lib/tz';
import { readWallInput } from './wallnote';

export interface EpochTabProps {
  readonly prefs: Preferences;
}

type UnitMode = 'auto' | EpochUnit;

/**
 * The error for input parseEpoch refuses, stating its real rule
 * (src/lib/epoch.ts): 1900-01-01 … 9999-12-31 UTC, and in auto mode up to 11
 * digits are seconds, 12 or more milliseconds. Checked in tests/ui-r3.test.tsx.
 */
export function epochErrorText(mode: UnitMode): string {
  const range = 'for a time from 1900-01-01 to 9999-12-31 UTC';
  if (mode === 'seconds') return `Enter a valid epoch: a whole number of seconds ${range}.`;
  if (mode === 'milliseconds') return `Enter a valid epoch: a whole number of milliseconds ${range}.`;
  return `Enter a valid epoch: a whole number ${range}. Auto reads up to 11 digits as seconds and 12 or more as milliseconds; pick a unit to change that.`;
}

function toLocalInputValue(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function EpochTab({ prefs }: EpochTabProps): JSX.Element {
  // --- Forward: epoch -> times ---
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<UnitMode>('auto');

  const parsed = useMemo(() => {
    if (raw.trim().length === 0) return { error: null as string | null, epochMs: null as number | null, unit: null as EpochUnit | null };
    const forced = mode === 'auto' ? undefined : mode;
    const r = parseEpoch(raw, forced);
    if (!r) return { error: epochErrorText(mode), epochMs: null, unit: null };
    return { error: null, epochMs: r.epochMs, unit: r.unit };
  }, [raw, mode]);

  // --- Reverse: datetime -> epoch ---
  const [revLocal, setRevLocal] = useState<string>(() => toLocalInputValue(new Date()));
  const reverse = useMemo(() => {
    const none = { s: null as number | null, ms: null as number | null, note: null as string | null };
    if (!revLocal) return { ...none, error: 'Pick a date and time.' as string | null };
    if (!isValidZone(prefs.homeZone)) return { ...none, error: 'Invalid home timezone.' };
    const r = readWallInput(revLocal, prefs.homeZone, prefs.hour12);
    if (!r) return { ...none, error: 'Could not parse that time.' };
    return { error: null, s: toEpochSeconds(r.epochMs), ms: toEpochMillis(r.epochMs), note: r.note };
  }, [revLocal, prefs.homeZone, prefs.hour12]);

  return (
    <section className="tzx-pane">
      <div className="tzx-field">
        <label htmlFor="tzx-epoch">Unix epoch timestamp</label>
        <input
          id="tzx-epoch"
          type="text"
          inputMode="numeric"
          placeholder="e.g. 1700000000 or 1700000000000"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <div className="tzx-unit-toggle" role="radiogroup" aria-label="Epoch unit">
          {(['auto', 'seconds', 'milliseconds'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'tzx-chip tzx-chip-on' : 'tzx-chip'}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {parsed.error ? (
        <p className="tzx-error" role="alert">
          {parsed.error}
        </p>
      ) : parsed.epochMs !== null ? (
        <div className="tzx-results">
          <div className="tzx-result-card tzx-utc">
            <div className="tzx-result-zone">ISO-8601 UTC</div>
            <div className="tzx-result-big tzx-mono">{toIsoUtc(parsed.epochMs)}</div>
            <div className="tzx-result-time">detected: {parsed.unit}</div>
          </div>
          {prefs.targetZones.map((zone) => {
            const v = viewInZone(parsed.epochMs as number, zone, prefs.hour12);
            return (
              <div className="tzx-result-card" key={zone}>
                <div className="tzx-result-zone">
                  {zoneLabel(zone)} <span className="tzx-off">{v.offset}</span>
                </div>
                <div className="tzx-result-time">{v.weekday}, {v.date}</div>
                <div className="tzx-result-big">{v.time}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      <hr className="tzx-sep" />

      <div className="tzx-field">
        <label htmlFor="tzx-rev">Reverse: date &amp; time → epoch ({zoneLabel(prefs.homeZone)})</label>
        <input
          id="tzx-rev"
          type="datetime-local"
          step={1}
          value={revLocal}
          onChange={(e) => setRevLocal(e.target.value)}
          aria-describedby={reverse.note ? 'tzx-rev-note' : undefined}
        />
        {reverse.note && (
          <p className="tzx-wall-note" id="tzx-rev-note">
            {reverse.note}
          </p>
        )}
      </div>
      {reverse.error ? (
        <p className="tzx-error" role="alert">
          {reverse.error}
        </p>
      ) : (
        <div className="tzx-epoch-out">
          <div>
            <span className="tzx-zone">seconds</span>
            <span className="tzx-mono tzx-time">{reverse.s}</span>
          </div>
          <div>
            <span className="tzx-zone">milliseconds</span>
            <span className="tzx-mono tzx-time">{reverse.ms}</span>
          </div>
        </div>
      )}
    </section>
  );
}
