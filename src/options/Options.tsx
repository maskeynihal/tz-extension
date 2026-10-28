import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type CustomFormat, type Preferences } from '../types';
import { loadPreferences, savePreferences } from '../lib/storage';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { viewInZone } from '../lib/tz';
import { compileTokenPattern, compileAdvancedPattern, parseCustom } from '../lib/custom-formats';
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

  // Paint the chosen theme; when following the OS, re-apply on OS flips.
  useEffect(() => {
    applyThemeToDocument(prefs.theme);
    if (prefs.theme !== 'system') return;
    return watchSystemTheme(() => applyThemeToDocument('system'));
  }, [prefs.theme]);

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
        <button
          type="button"
          className="tzx-chip"
          onClick={() => update({ ...prefs, keepSelection: !prefs.keepSelection })}
        >
          {prefs.keepSelection ? 'On' : 'Off'}
        </button>
        <p className="tzx-hint">
          Keep the page text selected while the conversion popover is open.
        </p>
      </section>

      <section className="tzx-field">
        <span className="tzx-field-label">Custom formats ({prefs.customFormats.length})</span>
        <p className="tzx-hint">
          Add your own date formats. Tokens: <code>YYYY YY MM M DD D HH H mm ss A</code>{' '}
          <code>MON MONTH TZ</code>. Example: <code>DD/MM/YYYY HH:mm</code>. Enable{' '}
          <em>advanced</em> to use a raw regex with named groups{' '}
          <code>(?&lt;y&gt;)(?&lt;mo&gt;)(?&lt;d&gt;)(?&lt;h&gt;)(?&lt;mi&gt;)(?&lt;s&gt;)(?&lt;zone&gt;)</code>.
        </p>
        <ul className="tzx-zone-list">
          {prefs.customFormats.map((fmt) => (
            <li className="tzx-zone-item" key={fmt.id}>
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <strong>{fmt.label || '(unnamed)'}</strong>
                <code className="tzx-off">{fmt.pattern}</code>
                {fmt.advanced && <span className="tzx-off">advanced regex</span>}
              </span>
              <span className="tzx-zone-item-actions">
                <button
                  type="button"
                  className="tzx-chip"
                  onClick={() =>
                    update({
                      ...prefs,
                      customFormats: prefs.customFormats.map((f) =>
                        f.id === fmt.id ? { ...f, enabled: !f.enabled } : f,
                      ),
                    })
                  }
                >
                  {fmt.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                  type="button"
                  className="tzx-icon-btn"
                  aria-label={`Remove ${fmt.label}`}
                  onClick={() =>
                    update({
                      ...prefs,
                      customFormats: prefs.customFormats.filter((f) => f.id !== fmt.id),
                    })
                  }
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
        <CustomFormatAdder
          onAdd={(fmt) =>
            update({ ...prefs, customFormats: [...prefs.customFormats, fmt] })
          }
        />
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

interface AdderProps {
  readonly onAdd: (fmt: CustomFormat) => void;
}

function CustomFormatAdder({ onAdd }: AdderProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [pattern, setPattern] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [sample, setSample] = useState('');

  const compiles =
    pattern.length === 0
      ? null
      : (advanced ? compileAdvancedPattern(pattern) : compileTokenPattern(pattern)) !== null;

  // Live preview: try the pattern against the sample text.
  let preview = '';
  if (pattern && sample) {
    const r = parseCustom(sample, 'UTC', [
      { id: 'preview', label: 'preview', pattern, advanced, enabled: true },
    ]);
    preview = r ? new Date(r.epochMs).toISOString() : 'no match';
  }

  function add(): void {
    if (!pattern || compiles === false) return;
    onAdd({
      id: `fmt-${Date.now().toString(36)}`,
      label: label.trim() || pattern,
      pattern,
      advanced,
      enabled: true,
    });
    setLabel('');
    setPattern('');
    setSample('');
  }

  return (
    <div className="tzx-adder">
      <input
        className="tzx-input"
        aria-label="Format label"
        placeholder="Label (e.g. European)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <input
        className="tzx-input"
        aria-label="Format pattern"
        placeholder={advanced ? 'Raw regex with named groups' : 'DD/MM/YYYY HH:mm'}
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
      />
      <input
        className="tzx-input"
        aria-label="Sample text to test"
        placeholder="Sample text to test (optional)"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
      />
      <label className="tzx-adder-row">
        <input
          type="checkbox"
          checked={advanced}
          onChange={(e) => setAdvanced(e.target.checked)}
        />{' '}
        Advanced (raw regex)
      </label>
      {pattern.length > 0 && (
        <p className="tzx-hint">
          {compiles === false ? (
            <span style={{ color: 'var(--error)' }}>Pattern does not compile.</span>
          ) : (
            <>Pattern OK.{preview && <> Preview: <code>{preview}</code></>}</>
          )}
        </p>
      )}
      <button
        type="button"
        className="tzx-chip"
        disabled={!pattern || compiles === false}
        onClick={add}
      >
        Add format
      </button>
    </div>
  );
}
