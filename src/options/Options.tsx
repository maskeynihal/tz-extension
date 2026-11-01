import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveLocalZone, type Preferences } from '../types';
import { useSyncedPreferences } from '../lib/use-synced-prefs';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { resolveZone, sameZone, viewInZone, zoneLabel } from '../lib/tz';
import { ZonePicker } from '../popup/ZonePicker';
import { FormatsSection, Switch } from './Formats';
import { SettingsNav, useScrollSpy, type NavSection } from './SettingsNav';
import { SortableList } from './SortableZoneList';
import { prefersReducedMotion } from './motion';

const SECTIONS: readonly NavSection[] = [
  { id: 'general', label: 'General' },
  { id: 'cards', label: 'Cards' },
  { id: 'timezones', label: 'Timezones' },
  { id: 'formats', label: 'Formats' },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** Offered first in the zone pickers (after your own zone), when not already used. */
const POPULAR_ZONES = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'abbr:PT', 'abbr:ET'];

function suggestedZones(skip: readonly string[]): string[] {
  // sameZone: the engine may report the local zone by a legacy name ("Asia/Katmandu").
  const out: string[] = [];
  for (const z of [resolveLocalZone(), ...POPULAR_ZONES]) {
    if (!skip.some((s) => sameZone(s, z)) && !out.some((o) => sameZone(o, z))) out.push(z);
  }
  return out;
}

/** A row of flush buttons, one pressed; like the theme chooser. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (next: T) => void;
}): JSX.Element {
  return (
    <div className="tzx-segment" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`tzx-seg-btn${value === o.value ? ' active' : ''}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Options(): JSX.Element {
  const { prefs, loaded, saveError, update } = useSyncedPreferences();
  const [now, setNow] = useState(() => Date.now());
  const [activeSection, setActiveSection] = useState<string>('general');
  const [stickyHeight, setStickyHeight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  // Own-write echoes are filtered in useSyncedPreferences.

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Paint the chosen theme; when following the OS, re-apply on OS flips.
  useEffect(() => {
    applyThemeToDocument(prefs.theme);
    if (prefs.theme !== 'system') return;
    return watchSystemTheme(() => applyThemeToDocument('system'));
  }, [prefs.theme]);

  // Sections scroll to just below the sticky bar (scroll-margin-top reads
  // --tzx-sticky-h). Set it on the DOM before paint so deep links land right.
  useLayoutEffect(() => {
    const bar = stickyRef.current;
    const root = rootRef.current;
    if (!bar || !root) return;
    const measure = (): void => {
      const h = bar.offsetHeight;
      root.style.setProperty('--tzx-sticky-h', `${h}px`);
      setStickyHeight(h);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [loaded, saveError]);

  const pauseSpy = useScrollSpy(SECTION_IDS, stickyHeight, setActiveSection, loaded);

  // Deep links: settings#formats (from the in-page card), #general, …
  useEffect(() => {
    if (!loaded || typeof window === 'undefined') return;
    function follow(): void {
      const id = window.location.hash.replace(/^#/, '');
      if (!id) return;
      if (SECTION_IDS.includes(id)) {
        setActiveSection(id);
        pauseSpy(300);
      }
      document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
    }
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // pauseSpy only writes a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const homeExclude = useMemo(() => [prefs.homeZone], [prefs.homeZone]);
  const homeSuggested = useMemo(() => suggestedZones(homeExclude), [homeExclude]);
  const targetSuggested = useMemo(() => suggestedZones(prefs.targetZones), [prefs.targetZones]);

  function goToSection(id: string): void {
    const section = document.getElementById(id);
    if (!section) return;
    const smooth = !prefersReducedMotion();
    setActiveSection(id);
    pauseSpy(smooth ? 1200 : 200);
    section.scrollIntoView?.({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    window.history.replaceState?.(null, '', `#${id}`);
    // Move focus to the heading so Tab continues inside the chosen section.
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }

  function addZone(zone: string): void {
    if (prefs.targetZones.some((z) => sameZone(z, zone))) return;
    update({ ...prefs, targetZones: [...prefs.targetZones, zone] });
  }

  function removeZone(zone: string): void {
    update({ ...prefs, targetZones: prefs.targetZones.filter((z) => z !== zone) });
  }

  if (!loaded) return <p className="tzx-loading">Loading…</p>;

  const home = resolveZone(prefs.homeZone);
  const homeLabel = zoneLabel(prefs.homeZone);
  const homeView = viewInZone(now, prefs.homeZone, prefs.hour12);

  return (
    <div className="tzx-options" ref={rootRef}>
      <h1>TZ Converter — Settings</h1>
      <div className="tzx-settings-sticky" ref={stickyRef}>
        <SettingsNav sections={SECTIONS} active={activeSection} onNavigate={goToSection} />
        {saveError && (
          <p className="tzx-banner tzx-bad" role="alert">
            {saveError}
          </p>
        )}
      </div>

      <section className="tzx-settings-section" id="general" aria-labelledby="tzx-general-h">
        <h2 className="tzx-section-h" id="tzx-general-h" tabIndex={-1}>
          General
        </h2>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Convert when I select text</h3>
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
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Home timezone</h3>
          <div className="tzx-current-zone">
            {homeLabel}{' '}
            <span className="tzx-off">
              {homeView.time} {homeView.offset}
            </span>
          </div>
          {home && home.long !== homeLabel && <p className="tzx-hint tzx-zone-long">{home.long}</p>}
          <ZonePicker
            label="Home timezone"
            placeholder="Change home timezone…"
            exclude={homeExclude}
            suggested={homeSuggested}
            onSelect={(z) => update({ ...prefs, homeZone: z })}
          />
          <p className="tzx-hint">Used to interpret selected times that carry no explicit timezone.</p>
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Clock format</h3>
          <Segmented
            label="Clock format"
            value={prefs.hour12 ? '12' : '24'}
            options={[
              { value: '12', label: '12-hour (3:04 PM)' },
              { value: '24', label: '24-hour (15:04)' },
            ]}
            onChange={(v) => update({ ...prefs, hour12: v === '12' })}
          />
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Appearance</h3>
          <Segmented
            label="Theme"
            value={prefs.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(theme) => update({ ...prefs, theme })}
          />
          <p className="tzx-hint">
            System follows your OS setting. Light or Dark forces that theme everywhere — the popup, this page, and
            the in-page converter.
          </p>
        </div>
      </section>

      <section className="tzx-settings-section" id="cards" aria-labelledby="tzx-cards-h">
        <h2 className="tzx-section-h" id="tzx-cards-h" tabIndex={-1}>
          Cards
        </h2>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Card size on open</h3>
          <Segmented
            label="Card size on open"
            value={prefs.cardSize}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'full', label: 'Full' },
              { value: 'last', label: 'Last used' },
            ]}
            onChange={(cardSize) => update({ ...prefs, cardSize })}
          />
          <p className="tzx-hint">
            Last used opens the card the way you last left it (currently:{' '}
            {prefs.lastCardSize === 'compact' ? 'Compact' : 'Full'}).
          </p>
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Date with no time</h3>
          <select
            className="tzx-select"
            aria-label="Date-only time policy"
            value={prefs.dateOnlyPolicy}
            onChange={(e) => update({ ...prefs, dateOnlyPolicy: e.target.value as Preferences['dateOnlyPolicy'] })}
          >
            <option value="midnight">Assume midnight (00:00)</option>
            <option value="now">Assume the current time</option>
          </select>
          <p className="tzx-hint">
            When a selection is just a date (e.g. <code>2024-01-02</code>), this is the time used. You can override
            it per popover.
          </p>
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Numeric date order</h3>
          <Segmented
            label="Numeric date order"
            value={prefs.numericDateOrder}
            options={[
              { value: 'dmy', label: 'Day first (22/03/1999)' },
              { value: 'mdy', label: 'Month first (03/22/1999)' },
            ]}
            onChange={(numericDateOrder) => update({ ...prefs, numericDateOrder })}
          />
          <p className="tzx-hint">
            Used when a date like <code>03/04/2024</code> could be read either way. You can also switch it from the
            card.
          </p>
        </div>

        <div className="tzx-field">
          <h3 className="tzx-field-label">Keep selection highlighted</h3>
          <Switch
            checked={prefs.keepSelection}
            label="Keep selection highlighted"
            onChange={(v) => update({ ...prefs, keepSelection: v })}
          />
          <p className="tzx-hint">
            While a card is open, also mark the matched date or time with a colored highlight. Your own selection
            always stays as you made it, so you can copy it — short or long.
          </p>
        </div>
      </section>

      <section className="tzx-settings-section" id="timezones" aria-labelledby="tzx-timezones-h">
        <h2 className="tzx-section-h" id="tzx-timezones-h" tabIndex={-1}>
          Timezones
        </h2>
        <div className="tzx-field">
          <h3 className="tzx-field-label">Target timezones ({prefs.targetZones.length})</h3>
          <p className="tzx-hint">
            Shown on every card, in this order. Drag the grip to reorder, or press Space on it, move with ↑ / ↓ and press
            Space again. Alt+↑ / Alt+↓ on a row moves it at once.
          </p>
          <SortableList
            items={prefs.targetZones}
            label="Target timezones"
            className="tzx-zone-list"
            itemClassName="tzx-zone-item"
            topInset={stickyHeight}
            itemLabel={zoneLabel}
            onReorder={(next) => update({ ...prefs, targetZones: next })}
            onRemove={removeZone}
            render={(zone, ctx) => {
              const name = zoneLabel(zone);
              const long = resolveZone(zone)?.long;
              const v = viewInZone(now, zone, prefs.hour12);
              return (
                <>
                  <span className="tzx-zone-main">
                    <strong className="tzx-zone-name">{name}</strong>
                    {long && long !== name && <span className="tzx-zone-desc">{long}</span>}
                  </span>
                  <span className="tzx-zone-clock">
                    <span className="tzx-zone-time">{v.time}</span> <span className="tzx-off">{v.offset}</span>
                  </span>
                  <span className="tzx-zone-item-actions">
                    <button
                      type="button"
                      className="tzx-icon-btn"
                      aria-label={`Move ${name} up`}
                      disabled={ctx.index === 0}
                      onClick={() => ctx.move(-1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="tzx-icon-btn"
                      aria-label={`Move ${name} down`}
                      disabled={ctx.index === ctx.count - 1}
                      onClick={() => ctx.move(1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="tzx-icon-btn tzx-zone-remove"
                      aria-label={`Remove ${name}`}
                      onClick={ctx.remove}
                    >
                      ✕
                    </button>
                  </span>
                </>
              );
            }}
          />
          {prefs.targetZones.length === 0 && (
            <p className="tzx-hint">No target timezones yet. Add one below to see it on every card.</p>
          )}
          <ZonePicker
            label="Add a target timezone"
            placeholder="Add a timezone…"
            exclude={prefs.targetZones}
            suggested={targetSuggested}
            onSelect={addZone}
          />
        </div>
      </section>

      <FormatsSection prefs={prefs} update={update} />
    </div>
  );
}
