import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { App } from '../src/popup/App';
import {
  CLOCK_HANDOFF_PARAM,
  MAX_HANDOFF_FRAGMENT,
  MAX_HANDOFF_ZONES,
  SITE_CLOCK_URL,
  clockUrlForPreferences,
  readClockHandoff,
  stripClockHandoff,
} from '../src/lib/site';
import { DEFAULT_PREFERENCES } from '../src/types';
import { PREFS_KEY } from '../src/lib/storage';

/**
 * The world clock is a website page now. The popup's button opens it in a
 * tab, so this pins the URL it asks for; the e2e only checks that a tab off
 * the extension opens, because a real navigation there needs the network.
 */
describe('the popup world clock button', () => {
  function setTabs(tabs: { create: ReturnType<typeof vi.fn> } | undefined): void {
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    if (tabs) c.tabs = tabs;
    else delete c.tabs;
  }

  /** Mount the popup, press the clock button, then unmount. */
  async function pressClock(): Promise<void> {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open world clock' }));
    cleanup();
  }

  /** The single URL the popup asked a tab to open. */
  function openedUrl(create: ReturnType<typeof vi.fn>): string {
    expect(create).toHaveBeenCalledTimes(1);
    return (create.mock.calls[0]?.[0] as { url: string }).url;
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the site clock in a browser tab', async () => {
    const create = vi.fn(() => Promise.resolve({}));
    setTabs({ create });
    await pressClock();
    expect(openedUrl(create).startsWith(`${SITE_CLOCK_URL}#`)).toBe(true);
    expect(SITE_CLOCK_URL).toBe('https://tz.nihal.com.np/clock');
  });

  it('says where it goes, so leaving the extension is no surprise', async () => {
    setTabs({ create: vi.fn(() => Promise.resolve({})) });
    render(<App />);
    const button = await screen.findByRole('button', { name: 'Open world clock' });
    expect(button.getAttribute('title')).toContain('tz.nihal.com.np');
  });

  it('falls back to window.open where chrome.tabs is missing', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    setTabs(undefined);
    await pressClock();
    expect(open).toHaveBeenCalledWith(expect.stringContaining(SITE_CLOCK_URL), '_blank', 'noopener');
  });

  it('falls back to window.open when the tab call is refused', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    setTabs({ create: vi.fn(() => Promise.reject(new Error('no tabs permission'))) });
    await pressClock();
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(expect.stringContaining(SITE_CLOCK_URL), '_blank', 'noopener'),
    );
  });

  /*
   * The website clock keeps its settings in the site origin's localStorage,
   * so without a handoff a user's zones never reach it (review r8 #1). The
   * popup carries them in the fragment, which is never sent to the server.
   */
  it('hands the stored zones over in the fragment, not a query string', async () => {
    const prefs = { ...DEFAULT_PREFERENCES, homeZone: 'Asia/Kathmandu', targetZones: ['UTC', 'abbr:PDT'], hour12: false };
    await chrome.storage.sync.set({ [PREFS_KEY]: prefs });
    const create = vi.fn(() => Promise.resolve({}));
    setTabs({ create });
    render(<App />);
    // Wait for the stored preferences to land before pressing the button.
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Open world clock' }));
    const url = new URL(openedUrl(create));
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/clock');
    expect(readClockHandoff(url.hash)).toEqual({
      homeZone: 'Asia/Kathmandu',
      targetZones: ['UTC', 'abbr:PDT'],
      hour12: false,
    });
  });

  it('sends nothing before the stored preferences have been read', async () => {
    // Otherwise the first click would hand the *defaults* over and overwrite
    // whatever the site had saved.
    const create = vi.fn(() => Promise.resolve({}));
    setTabs({ create });
    let resolveLoad: (v: Record<string, unknown>) => void = () => {};
    const slow = new Promise<Record<string, unknown>>((r) => {
      resolveLoad = r;
    });
    vi.spyOn(chrome.storage.sync, 'get').mockReturnValue(slow as unknown as ReturnType<typeof chrome.storage.sync.get>);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open world clock' }));
    expect(openedUrl(create)).toBe(SITE_CLOCK_URL);
    await act(async () => {
      resolveLoad({});
    });
  });
});

describe('the clock handoff payload', () => {
  const build = (p: Partial<typeof DEFAULT_PREFERENCES>): string =>
    clockUrlForPreferences({ ...DEFAULT_PREFERENCES, ...p });
  const hashOf = (url: string): string => `#${url.split('#')[1] ?? ''}`;
  const roundTrip = (p: Partial<typeof DEFAULT_PREFERENCES>): ReturnType<typeof readClockHandoff> =>
    readClockHandoff(hashOf(build(p)));

  it('carries only the home zone, the target zones and the clock format', () => {
    const url = build({ homeZone: 'UTC', targetZones: ['Europe/London'], hour12: true, theme: 'dark' });
    expect(roundTrip({ homeZone: 'UTC', targetZones: ['Europe/London'], hour12: true })).toEqual({
      homeZone: 'UTC',
      targetZones: ['Europe/London'],
      hour12: true,
    });
    // Nothing else travels: no theme, no custom formats, nothing identifying.
    const payload = decodeURIComponent(hashOf(url).slice(`#${CLOCK_HANDOFF_PARAM}=`.length));
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['h12', 'home', 'v', 'zones']);
    expect(payload).not.toMatch(/theme|dark|customFormats|selectToConvert/);
  });

  it('keeps an empty zone list, which is a real setting', () => {
    expect(roundTrip({ targetZones: [] })?.targetZones).toEqual([]);
  });

  it('leaves out a zone the extension itself could not resolve', () => {
    expect(roundTrip({ homeZone: 'Mars/Olympus', targetZones: ['UTC', 'Not/AZone'] })).toEqual({
      targetZones: ['UTC'],
      hour12: DEFAULT_PREFERENCES.hour12,
    });
  });

  it('stays small: a full zone list is well inside the fragment bound', () => {
    const many = Array.from({ length: MAX_HANDOFF_ZONES }, () => 'America/Argentina/Buenos_Aires');
    expect(build({ targetZones: many }).length).toBeLessThan(MAX_HANDOFF_FRAGMENT);
  });

  it('reads nothing out of a URL that carries no handoff', () => {
    expect(readClockHandoff('')).toBeNull();
    expect(readClockHandoff('#')).toBeNull();
    expect(readClockHandoff('#install')).toBeNull();
    expect(readClockHandoff('#other=1')).toBeNull();
    expect(stripClockHandoff('#install')).toBeNull();
  });

  it('refuses a malformed payload instead of guessing at it', () => {
    for (const bad of [
      `#${CLOCK_HANDOFF_PARAM}=`,
      `#${CLOCK_HANDOFF_PARAM}=not-json`,
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('{"v":1')}`,
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('[1,2,3]')}`,
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('"a string"')}`,
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('null')}`,
      // A version this build does not know: better ignored than half-read.
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('{"v":99,"home":"UTC"}')}`,
      // Nothing valid in it at all.
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('{"v":1}')}`,
      `#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent(`{"v":1,"home":"${'x'.repeat(5000)}"}`)}`,
    ]) {
      expect(readClockHandoff(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it('trusts nothing in a hostile payload', () => {
    const hostile = (payload: unknown): ReturnType<typeof readClockHandoff> =>
      readClockHandoff(`#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent(JSON.stringify(payload))}`);
    // Zones that are not zones, of every shape, are dropped. A list where
    // nothing survived is dropped whole rather than used to wipe the list.
    expect(
      hostile({ v: 1, home: 'javascript:alert(1)', zones: ['<script>x</script>', 42, null, { a: 1 }, ['UTC']] }),
    ).toBeNull();
    // Mixed: only the real zone survives.
    expect(hostile({ v: 1, zones: ['UTC', 'file:///etc/passwd'] })).toEqual({ targetZones: ['UTC'] });
    // Non-booleans never become the clock format.
    expect(hostile({ v: 1, home: 'UTC', h12: 'true' })).toEqual({ homeZone: 'UTC' });
    // A long list is cut to the bound.
    expect(hostile({ v: 1, zones: Array.from({ length: 100 }, () => 'UTC') })?.targetZones).toHaveLength(
      MAX_HANDOFF_ZONES,
    );
    // Prototype pollution: "__proto__" in JSON.parse output is a plain key,
    // and only known fields are ever read out.
    const polluted = hostile({ v: 1, home: 'UTC', __proto__: { homeZone: 'Mars/Olympus' } });
    expect(polluted).toEqual({ homeZone: 'UTC' });
    expect(({} as { homeZone?: string }).homeZone).toBeUndefined();
  });

  it('takes its own parameter out of the fragment and leaves anyone else’s alone', () => {
    expect(stripClockHandoff(`#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent('{"v":1}')}`)).toBe('');
    expect(stripClockHandoff(`#other=1&${CLOCK_HANDOFF_PARAM}=x`)).toBe('#other=1');
    expect(stripClockHandoff('#settings')).toBeNull();
    expect(stripClockHandoff('')).toBeNull();
  });
});

/*
 * The other half of the handoff: the website entry. It adopts what the link
 * carries, through the same sanitize a stored blob goes through, and then
 * takes the parameter out of the address bar.
 */
describe('the website clock entry', () => {
  const stored = (): Record<string, unknown> | undefined => {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  };

  /** Load site/clock.ts fresh with this fragment in the address bar. */
  async function loadEntry(hash: string): Promise<void> {
    window.history.replaceState(null, '', `/clock${hash}`);
    // A fresh module graph, so this file's other suites keep the chrome.storage
    // backend: enableWebStorageBackend() is module state in src/lib/storage.ts.
    vi.resetModules();
    await import('../site/clock');
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/clock');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('adopts the zones the popup handed over, and cleans the fragment away', async () => {
    const url = clockUrlForPreferences({ homeZone: 'Asia/Kathmandu', targetZones: ['UTC', 'abbr:PDT'], hour12: false });
    await loadEntry(`#${url.split('#')[1] ?? ''}`);
    await waitFor(() => expect(stored()).toBeTruthy());
    expect(stored()?.homeZone).toBe('Asia/Kathmandu');
    expect(stored()?.targetZones).toEqual(['UTC', 'abbr:PDT']);
    expect(stored()?.hour12).toBe(false);
    // A copied link must not be a frozen snapshot of someone's settings.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/clock');
  });

  it('leaves the site on its own settings when the link carries nothing', async () => {
    const mine = { ...DEFAULT_PREFERENCES, homeZone: 'Europe/London', targetZones: ['UTC'] };
    localStorage.setItem(PREFS_KEY, JSON.stringify(mine));
    await loadEntry('');
    await new Promise((r) => setTimeout(r, 0));
    expect(stored()?.homeZone).toBe('Europe/London');
    expect(stored()?.targetZones).toEqual(['UTC']);
  });

  it('ignores a malformed fragment, keeping what the site had', async () => {
    const mine = { ...DEFAULT_PREFERENCES, homeZone: 'Europe/London', targetZones: ['UTC'] };
    localStorage.setItem(PREFS_KEY, JSON.stringify(mine));
    await loadEntry(`#${CLOCK_HANDOFF_PARAM}=%7Bnot-json`);
    await new Promise((r) => setTimeout(r, 0));
    expect(stored()?.homeZone).toBe('Europe/London');
    expect(stored()?.targetZones).toEqual(['UTC']);
    // Still cleaned up: the parameter was ours, however broken.
    expect(window.location.hash).toBe('');
  });

  it('adopts nothing a hostile link made up', async () => {
    const mine = { ...DEFAULT_PREFERENCES, homeZone: 'Europe/London', targetZones: ['UTC'] };
    localStorage.setItem(PREFS_KEY, JSON.stringify(mine));
    const payload = JSON.stringify({
      v: 1,
      home: 'Mars/Olympus',
      zones: ['javascript:alert(1)'],
      h12: 'yes',
      theme: 'dark',
      customFormats: [{ id: 'x', label: 'x', pattern: 'x', advanced: true, enabled: true }],
    });
    await loadEntry(`#${CLOCK_HANDOFF_PARAM}=${encodeURIComponent(payload)}`);
    await new Promise((r) => setTimeout(r, 0));
    const after = stored();
    expect(after?.homeZone).toBe('Europe/London');
    expect(after?.targetZones).toEqual(['UTC']);
    expect(after?.theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(after?.customFormats).toEqual([]);
    expect(window.location.hash).toBe('');
  });
});
