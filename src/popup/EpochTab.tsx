import { useMemo, useState } from 'react';
import type { Preferences } from '../types';
import { parseEpoch, toEpochSeconds, toEpochMillis, type EpochUnit } from '../lib/epoch';
import { viewInZone, toIsoUtc, wallClockToEpochMs, isValidZone } from '../lib/tz';

export interface EpochTabProps {
  readonly prefs: Preferences;
}

type UnitMode = 'auto' | EpochUnit;

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
    if (!r) return { error: 'Enter a valid epoch (integer, in range 1900–9999).', epochMs: null, unit: null };
    return { error: null, epochMs: r.epochMs, unit: r.unit };
  }, [raw, mode]);

  // --- Reverse: datetime -> epoch ---
  const [revLocal, setRevLocal] = useState<string>(() => toLocalInputValue(new Date()));
  const reverse = useMemo(() => {
    if (!revLocal) return { error: 'Pick a date and time.' as string | null, s: null as number | null, ms: null as number | null };
    if (!isValidZone(prefs.homeZone)) return { error: 'Invalid home timezone.', s: null, ms: null };
    const iso = revLocal.length === 16 ? `${revLocal}:00` : revLocal;
    try {
      const epochMs = wallClockToEpochMs(iso, prefs.homeZone);
      if (!Number.isFinite(epochMs)) return { error: 'Could not parse that time.', s: null, ms: null };
      return { error: null, s: toEpochSeconds(epochMs), ms: toEpochMillis(epochMs) };
    } catch {
      return { error: 'Could not parse that time.', s: null, ms: null };
    }
  }, [revLocal, prefs.homeZone]);

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
                  {zone} <span className="tzx-off">{v.offset}</span>
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
        <label htmlFor="tzx-rev">Reverse: date &amp; time → epoch ({prefs.homeZone})</label>
        <input
          id="tzx-rev"
          type="datetime-local"
          step={1}
          value={revLocal}
          onChange={(e) => setRevLocal(e.target.value)}
        />
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
