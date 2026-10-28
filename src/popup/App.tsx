import { useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type Preferences } from '../types';
import { loadPreferences, savePreferences, onPreferencesChanged } from '../lib/storage';
import { getBuildInfo } from '../lib/build-info';
import { Converter } from './Converter';
import { EpochTab } from './EpochTab';

type Tab = 'converter' | 'epoch';

const BUILD = getBuildInfo();

export function App(): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [tab, setTab] = useState<Tab>('converter');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (alive) {
        setPrefs(p);
        setLoaded(true);
      }
    });
    const unsub = onPreferencesChanged((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  function toggleHour12(): void {
    const next: Preferences = { ...prefs, hour12: !prefs.hour12 };
    setPrefs(next);
    void savePreferences(next);
  }

  function updatePrefs(next: Preferences): void {
    setPrefs(next);
    void savePreferences(next);
  }

  function openOptions(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  }

  return (
    <div className="tzx-app">
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
            className="tzx-chip"
            aria-label="Toggle 12 or 24 hour clock"
            onClick={toggleHour12}
          >
            {prefs.hour12 ? '12h' : '24h'}
          </button>
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

      {!loaded ? (
        <p className="tzx-loading">Loading…</p>
      ) : tab === 'converter' ? (
        <Converter prefs={prefs} onPrefsChange={updatePrefs} />
      ) : (
        <EpochTab prefs={prefs} />
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
