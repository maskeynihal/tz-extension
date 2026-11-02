import { useEffect, useMemo, useState } from 'react';
import type { Preferences } from '../types';
import { parseEpoch, toEpochSeconds, toEpochMillis, type EpochUnit } from '../lib/epoch';
import { viewInZone, toIsoUtc, isValidZone, zoneLabel } from '../lib/tz';
import { readWallInput } from './wallnote';
import { SortableList } from '../options/SortableZoneList';

export interface EpochTabProps {
  readonly prefs: Preferences;
  /** Persist a preferences change; given, the zone rows can be dragged into a new order. */
  readonly onPrefsChange?: (next: Preferences) => void;
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

/**
 * The datetime-local value (with seconds) for an instant written as the wall
 * clock of `zone`. Formatted in the zone itself, never in the browser's own
 * timezone, so it reads back as the same instant in that zone. Empty for an
 * invalid zone.
 */
export function wallInputSeconds(epochMs: number, zone: string): string {
  if (!isValidZone(zone)) return '';
  const v = viewInZone(epochMs, zone, false);
  return `${v.date}T${v.time}`;
}

/**
 * The reverse field's state: the text, the zone it is written in, and the
 * exact instant when the text came from "Now" (so a second-half-of-overlap
 * "now" isn't read back as the earlier instant).
 */
interface ReverseInput {
  readonly value: string;
  readonly zone: string;
  readonly exactMs: number | null;
}

function nowInput(zone: string): ReverseInput {
  const ms = Math.floor(Date.now() / 1000) * 1000;
  return { value: wallInputSeconds(ms, zone), zone, exactMs: ms };
}

export function EpochTab({ prefs, onPrefsChange }: EpochTabProps): JSX.Element {
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
  // The field is a wall clock in the home zone: pre-filled with now as the
  // home zone shows it, and read back in the same zone.
  const homeZone = prefs.homeZone;
  const [rev, setRev] = useState<ReverseInput>(() => nowInput(homeZone));

  // Home zone changed (stored prefs load after the first render, or the user
  // changed it): keep the same instant, rewritten as the new zone's wall clock.
  useEffect(() => {
    setRev((cur) => {
      if (cur.zone === homeZone) return cur;
      const ms = cur.exactMs ?? readWallInput(cur.value, cur.zone)?.epochMs ?? null;
      if (ms === null || !isValidZone(homeZone)) return { ...cur, zone: homeZone, exactMs: null };
      return { value: wallInputSeconds(ms, homeZone), zone: homeZone, exactMs: ms };
    });
  }, [homeZone]);

  const reverse = useMemo(() => {
    const none = { s: null as number | null, ms: null as number | null, note: null as string | null };
    if (!rev.value) return { ...none, error: 'Pick a date and time.' as string | null };
    if (!isValidZone(rev.zone)) return { ...none, error: 'Invalid home timezone.' };
    if (rev.exactMs !== null) return { error: null, s: toEpochSeconds(rev.exactMs), ms: toEpochMillis(rev.exactMs), note: null };
    // A datetime-local value may carry milliseconds ("…T01:30:01.500", the
    // input's normalised form with step < 1); the wall reader takes seconds.
    const frac = /\.(\d{1,3})$/.exec(rev.value);
    const wall = frac ? rev.value.slice(0, frac.index) : rev.value;
    const extraMs = frac ? Number((frac[1] as string).padEnd(3, '0')) : 0;
    const r = readWallInput(wall, rev.zone, prefs.hour12);
    if (!r) return { ...none, error: 'Could not parse that time.' };
    const epochMs = r.epochMs + extraMs;
    return { error: null, s: toEpochSeconds(epochMs), ms: toEpochMillis(epochMs), note: r.note };
  }, [rev, prefs.hour12]);

  function zoneResult(zone: string): JSX.Element {
    const v = viewInZone(parsed.epochMs as number, zone, prefs.hour12);
    return (
      <>
        <div className="tzx-result-zone">
          {zoneLabel(zone)} <span className="tzx-off">{v.offset}</span>
        </div>
        <div className="tzx-result-time">{v.weekday}, {v.date}</div>
        <div className="tzx-result-big">{v.time}</div>
      </>
    );
  }

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
          {onPrefsChange ? (
            <SortableList
              items={prefs.targetZones}
              label="Times in your zones"
              itemLabel={zoneLabel}
              className="tzx-results"
              itemClassName="tzx-result-card tzx-result-sortable"
              onReorder={(next) => onPrefsChange({ ...prefs, targetZones: next })}
              render={(zone) => <div className="tzx-result-body">{zoneResult(zone)}</div>}
            />
          ) : (
            prefs.targetZones.map((zone) => (
              <div className="tzx-result-card" key={zone}>
                {zoneResult(zone)}
              </div>
            ))
          )}
        </div>
      ) : null}

      <hr className="tzx-sep" />

      <div className="tzx-field">
        <label htmlFor="tzx-rev">Reverse: date &amp; time → epoch ({zoneLabel(prefs.homeZone)})</label>
        <div className="tzx-row-inline">
          <input
            id="tzx-rev"
            type="datetime-local"
            step={1}
            value={rev.value}
            onChange={(e) => setRev({ value: e.target.value, zone: homeZone, exactMs: null })}
            aria-describedby={reverse.note ? 'tzx-rev-note' : undefined}
          />
          <button type="button" className="tzx-btn" onClick={() => setRev(nowInput(homeZone))}>
            Now
          </button>
        </div>
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
