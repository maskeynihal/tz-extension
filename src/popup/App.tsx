import { useEffect, useState } from 'react';
import type { Preferences } from '../types';
import { useSyncedPreferences } from '../lib/use-synced-prefs';
import { SITE_CLOCK_URL } from '../lib/site';
import { applyThemeToDocument, watchSystemTheme } from '../lib/theme';
import { getBuildInfo } from '../lib/build-info';
import { AccessBanner } from './AccessBanner';
import { Converter } from './Converter';
import { EpochTab } from './EpochTab';

type Tab = 'converter' | 'epoch';

const BUILD = getBuildInfo();

export function App(): JSX.Element {
  // Own-write echoes are skipped, so quick reorders never jump back.
  const { prefs, loaded, saveError, update: updatePrefs } = useSyncedPreferences();
  const [tab, setTab] = useState<Tab>('converter');

  // Paint the chosen theme; when following the OS, re-apply on OS flips.
  useEffect(() => {
    applyThemeToDocument(prefs.theme);
    if (prefs.theme !== 'system') return;
    return watchSystemTheme(() => applyThemeToDocument('system'));
  }, [prefs.theme]);

  function setHour12(hour12: boolean): void {
    if (prefs.hour12 === hour12) return;
    updatePrefs({ ...prefs, hour12 });
  }

  function cycleTheme(): void {
    const order: Preferences['theme'][] = ['system', 'light', 'dark'];
    const i = order.indexOf(prefs.theme);
    updatePrefs({ ...prefs, theme: order[(i + 1) % order.length] ?? 'system' });
  }

  /**
   * Open the world clock on the website. The extension no longer carries its
   * own copy of the page: it is the same app either way, and a tab on the site
   * can be bookmarked, shared and left open.
   */
  function openWorldClock(): void {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      void Promise.resolve(chrome.tabs.create({ url: SITE_CLOCK_URL })).catch(() =>
        window.open(SITE_CLOCK_URL, '_blank', 'noopener'),
      );
      return;
    }
    window.open(SITE_CLOCK_URL, '_blank', 'noopener');
  }

  function openOptions(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  }

  return (
    <div className="tzx-app">
      <AccessBanner />
      <header className="tzx-app-head">
        <div className="tzx-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'converter'}
            className={tab === 'converter' ? 'tzx-tab tzx-tab-on' : 'tzx-tab'}
            onClick={() => setTab('converter')}
          >
            Converter
          </button>
          <button
            role="tab"
            aria-selected={tab === 'epoch'}
            className={tab === 'epoch' ? 'tzx-tab tzx-tab-on' : 'tzx-tab'}
            onClick={() => setTab('epoch')}
          >
            Epoch
          </button>
        </div>
        <div className="tzx-head-actions">
          <button
            type="button"
            className="tzx-icon-btn"
            aria-label="Open world clock"
            title="World clock (opens tz.nihal.com.np)"
            onClick={openWorldClock}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
            </svg>
          </button>
          <button
            type="button"
            className="tzx-icon-btn"
            aria-label={`Theme: ${prefs.theme}. Click to change.`}
            title={`Theme: ${prefs.theme === 'system' ? 'System' : prefs.theme === 'light' ? 'Light' : 'Dark'} (click to cycle)`}
            onClick={cycleTheme}
          >
            {prefs.theme === 'system' ? '◐' : prefs.theme === 'light' ? '☀' : '☾'}
          </button>
          <div className="tzx-segment tzx-segment-sm" role="group" aria-label="Clock format">
            {([true, false] as const).map((h12) => (
              <button
                key={String(h12)}
                type="button"
                className={`tzx-seg-btn${prefs.hour12 === h12 ? ' active' : ''}`}
                aria-pressed={prefs.hour12 === h12}
                aria-label={h12 ? '12-hour clock' : '24-hour clock'}
                title={h12 ? '12-hour clock' : '24-hour clock'}
                onClick={() => setHour12(h12)}
              >
                {h12 ? '12h' : '24h'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="tzx-icon-btn"
            aria-label="Open settings"
            title="Settings"
            onClick={openOptions}
          >
            ⚙
          </button>
        </div>
      </header>

      {saveError && (
        // A failed save goes back to what is stored; say why it snapped back.
        <p className="tzx-error" role="alert">
          {saveError}
        </p>
      )}

      {!loaded ? (
        <p className="tzx-loading">Loading…</p>
      ) : tab === 'converter' ? (
        <Converter prefs={prefs} onPrefsChange={updatePrefs} />
      ) : (
        <EpochTab prefs={prefs} onPrefsChange={updatePrefs} />
      )}

      <footer className="tzx-foot" title={BUILD.builtAt ? `Built ${BUILD.builtAt}` : undefined}>
        {BUILD.releaseUrl ? (
          <a
            className="tzx-foot-link"
            href={BUILD.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Release v${BUILD.version} on GitHub`}
          >
            v{BUILD.version}
          </a>
        ) : (
          <span>v{BUILD.version}</span>
        )}
        <span className="tzx-foot-sep">·</span>
        {BUILD.commitUrl ? (
          <a
            className="tzx-foot-link tzx-foot-commit"
            href={BUILD.commitUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="View this commit on GitHub"
          >
            {BUILD.commit}
          </a>
        ) : (
          <span className="tzx-foot-commit">{BUILD.commit}</span>
        )}
        {BUILD.repoUrl && (
          <>
            <span className="tzx-foot-sep">·</span>
            <a
              className="tzx-foot-link"
              href={BUILD.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the repository on GitHub"
            >
              GitHub
            </a>
          </>
        )}
      </footer>
    </div>
  );
}
