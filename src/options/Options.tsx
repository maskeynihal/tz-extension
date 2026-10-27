import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { loadPreferences, savePreferences } from '../lib/storage';
import { viewInZone } from '../lib/tz';
import { ZonePicker } from '../popup/ZonePicker';

export function Options(): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (alive) {
        setPrefs(p);
        setLoaded(true);
      }
    });
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  function update(next: Preferences): void {
    setPrefs(next);
    void savePreferences(next);
  }

  function addZone(zone: string): void {
    if (prefs.targetZones.includes(zone)) return;
    update({ ...prefs, targetZones: [...prefs.targetZones, zone] });
  }

  function removeZone(zone: string): void {
    update({ ...prefs, targetZones: prefs.targetZones.filter((z) => z !== zone) });
  }

  function moveZone(index: number, dir: -1 | 1): void {
    const next = [...prefs.targetZones];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    update({ ...prefs, targetZones: next });
  }

  if (!loaded) return <p className="tzx-loading">Loading…</p>;

  return (
    <div className="tzx-options">
      <h1>TZ Converter — Settings</h1>

      <section className="tzx-field">
        <span className="tzx-field-label">Home timezone</span>
        <div className="tzx-current-zone">{prefs.homeZone}</div>
        <ZonePicker
          label="Home timezone"
          placeholder="Change home timezone…"
          onSelect={(z) => update({ ...prefs, homeZone: z })}
        />
        <p className="tzx-hint">
          Used to interpret selected times that carry no explicit timezone.
        </p>
      </section>

      <section className="tzx-field">
        <span className="tzx-field-label">Clock format</span>
        <button
          type="button"
          className="tzx-chip"
          onClick={() => update({ ...prefs, hour12: !prefs.hour12 })}
        >
          {prefs.hour12 ? '12-hour' : '24-hour'}
        </button>
      </section>

      <section className="tzx-field">
        <span className="tzx-field-label">Target timezones ({prefs.targetZones.length})</span>
        <ul className="tzx-zone-list">
          {prefs.targetZones.map((zone, i) => {
            const v = viewInZone(now, zone, prefs.hour12);
            return (
              <li className="tzx-zone-item" key={zone}>
                <span>
                  <strong>{zone}</strong>{' '}
                  <span className="tzx-off">
                    {v.time} {v.offset}
                  </span>
                </span>
                <span className="tzx-zone-item-actions">
                  <button
                    type="button"
                    className="tzx-icon-btn"
                    aria-label={`Move ${zone} up`}
                    disabled={i === 0}
                    onClick={() => moveZone(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="tzx-icon-btn"
                    aria-label={`Move ${zone} down`}
                    disabled={i === prefs.targetZones.length - 1}
                    onClick={() => moveZone(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="tzx-icon-btn"
                    aria-label={`Remove ${zone}`}
                    onClick={() => removeZone(zone)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <ZonePicker
          label="Add a target timezone"
          placeholder="Add a timezone…"
          exclude={prefs.targetZones}
          onSelect={addZone}
        />
      </section>
    </div>
  );
}
