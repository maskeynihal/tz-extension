import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { loadPreferences, onPreferencesChanged, sanitize, savePreferences } from '../lib/storage';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { viewInZone } from '../lib/tz';
import { ZonePicker } from '../popup/ZonePicker';
import { FormatsSection, Switch } from './Formats';

export function Options(): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [saveError, setSaveError] = useState<string | null>(null);
  // Our own writes echo back through storage.onChanged. Remember what we last
  // wrote and ignore only that echo, so changes made elsewhere (the popup, the
  // in-page card, another settings tab) still show up here.
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (alive) {
        setPrefs(p);
        setLoaded(true);
      }
    });
    // Pick up changes made elsewhere (the popup, the in-page card, another tab).
    const unsub = onPreferencesChanged((p) => {
      if (!alive || JSON.stringify(p) === lastWritten.current) return;
      setPrefs(p);
    });
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      unsub();
      window.clearInterval(t);
    };
  }, []);

  // Paint the chosen theme; when following the OS, re-apply on OS flips.
  useEffect(() => {
    applyThemeToDocument(prefs.theme);
    if (prefs.theme !== 'system') return;
    return watchSystemTheme(() => applyThemeToDocument('system'));
  }, [prefs.theme]);

  function update(next: Preferences): void {
    setPrefs(next);
    lastWritten.current = JSON.stringify(sanitize(next));
    void savePreferences(next).then((r) => {
      if (r.ok) {
        setSaveError(null);
        return;
      }
      // Not saved: show why, and go back to what is actually stored so the
      // page never claims a setting that the extension is not using.
      setSaveError(r.error);
      lastWritten.current = null;
      void loadPreferences().then(setPrefs);
    });
  }

  // Deep link from the in-page card: settings#formats.
  useEffect(() => {
    if (!loaded || typeof window === 'undefined') return;
    const id = window.location.hash.replace(/^#/, '');
    if (id) document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
  }, [loaded]);

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
      {saveError && (
        <p className="tzx-banner tzx-bad" role="alert">
          {saveError}
        </p>
      )}

      <section className="tzx-field">
        <span className="tzx-field-label">Convert when I select text</span>
        <Switch
          checked={prefs.selectToConvert}
          label="Convert when I select text"
          onChange={(v) => update({ ...prefs, selectToConvert: v })}
        />
        <p className="tzx-hint">
          {prefs.selectToConvert
            ? 'Selecting a date or time on a page shows the converter right away.'
            : 'Selecting text does nothing.'}{' '}
          You can always right-click a selection and choose <em>Convert “…” with TZ Converter</em>.
        </p>
      </section>

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
        <span className="tzx-field-label">Appearance</span>
        <div className="tzx-segment" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tzx-seg-btn${prefs.theme === t ? ' active' : ''}`}
              aria-pressed={prefs.theme === t}
              onClick={() => update({ ...prefs, theme: t })}
            >
              {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <p className="tzx-hint">
          System follows your OS setting. Light or Dark forces that theme
          everywhere — the popup, this page, and the in-page converter.
        </p>
      </section>

      <section className="tzx-field">
        <span className="tzx-field-label">Date with no time</span>
        <select
          className="tzx-select"
          aria-label="Date-only time policy"
          value={prefs.dateOnlyPolicy}
          onChange={(e) =>
            update({ ...prefs, dateOnlyPolicy: e.target.value as Preferences['dateOnlyPolicy'] })
          }
        >
          <option value="midnight">Assume midnight (00:00)</option>
          <option value="now">Assume the current time</option>
        </select>
        <p className="tzx-hint">
          When a selection is just a date (e.g. <code>2024-01-02</code>), this is the time used.
          You can override it per popover.
        </p>
      </section>

      <section className="tzx-field">
        <span className="tzx-field-label">Keep selection highlighted</span>
        <Switch
          checked={prefs.keepSelection}
          label="Keep selection highlighted"
          onChange={(v) => update({ ...prefs, keepSelection: v })}
        />
        <p className="tzx-hint">
          While a card is open, mark the matched text with a colored highlight. The browser's own selection is
          cleared so the mark stays visible; turn this off to keep the normal selection (for example to copy it).
        </p>
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

      <FormatsSection prefs={prefs} update={update} />
    </div>
  );
}
