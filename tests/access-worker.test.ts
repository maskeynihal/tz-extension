import { describe, it, expect, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

interface Harness {
  added: Listener[];
  query: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
}

/**
 * A chrome mock with permissions + tabs, then the worker loaded fresh.
 * Tabs carry URLs, because the worker now only hands executeScript the tabs
 * the manifest's content script would have matched (review r8 #10, #11).
 */
async function loadWorker(tabs: unknown[]): Promise<Harness> {
  const h: Harness = {
    added: [],
    query: vi.fn(async () => tabs),
    executeScript: vi.fn(async () => []),
  };
  const base = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    ...base,
    runtime: {
      id: 'ext-id',
      lastError: undefined,
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getManifest: () => ({
        content_scripts: [{ js: ['assets/loader.js'], matches: ['<all_urls>'] }],
      }),
    },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: { query: h.query, sendMessage: vi.fn() },
    commands: { getAll: vi.fn(async () => []), onCommand: { addListener: vi.fn() } },
    scripting: { executeScript: h.executeScript },
    permissions: { onAdded: { addListener: (l: Listener) => h.added.push(l) }, onRemoved: { addListener: vi.fn() } },
  };
  vi.resetModules();
  await import('../src/background/service-worker');
  return h;
}

/** Three ordinary web tabs. */
const webTabs = [
  { id: 1, url: 'https://a.example/' },
  { id: 2, url: 'http://b.example/page' },
  { id: 3, url: 'https://c.example/x?y=1' },
];

const targets = (h: Harness): number[] =>
  h.executeScript.mock.calls.map((c) => (c[0] as { target: { tabId: number } }).target.tabId);

const grantAll = (h: Harness): void => h.added.forEach((l) => l({ origins: ['<all_urls>'], permissions: [] }));

describe('background: a new all-sites grant', () => {
  it('injects the content script into the tabs that are already open', async () => {
    const h = await loadWorker(webTabs);
    // One listener injects into open tabs; the other refreshes the toolbar badge.
    expect(h.added).toHaveLength(2);
    grantAll(h);
    await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledTimes(3));
    expect(h.query).toHaveBeenCalledWith({});
    expect(targets(h)).toEqual([1, 2, 3]);
    expect(h.executeScript.mock.calls[0]?.[0]).toEqual({
      target: { tabId: 1, frameIds: [0] },
      files: ['assets/loader.js'],
    });
  });

  it('keeps going past a tab it cannot inject into', async () => {
    const h = await loadWorker(webTabs);
    h.executeScript.mockImplementation(async (opts: { target: { tabId: number } }) => {
      if (opts.target.tabId === 2) throw new Error('Cannot access contents of the page');
      return [];
    });
    grantAll(h);
    await vi.waitFor(() => expect(targets(h)).toEqual([1, 2, 3]));
  });

  it('skips tabs without a usable id and survives an unreadable tab list', async () => {
    const h = await loadWorker([
      { id: undefined, url: 'https://a.example/' },
      { id: -1, url: 'https://b.example/' },
      { id: 4, url: 'https://c.example/' },
    ]);
    grantAll(h);
    await vi.waitFor(() => expect(targets(h)).toEqual([4]));

    const h2 = await loadWorker([]);
    h2.query.mockRejectedValue(new Error('no tabs permission'));
    grantAll(h2);
    await new Promise((r) => setTimeout(r, 0));
    expect(h2.executeScript).not.toHaveBeenCalled();
  });

  /*
   * executeScript is not bound by the manifest's match patterns. Checked
   * against a real Chromium: every one of these is refused ("Cannot access
   * contents of the page", "Cannot access a chrome:// URL"), including the
   * extension's own options page, so nothing was ever injected where the
   * manifest would not have matched — but each one still cost a round trip,
   * and no other browser is obliged to refuse the same way.
   */
  it('never offers executeScript a page the manifest would not have matched', async () => {
    const h = await loadWorker([
      { id: 1, url: 'chrome-extension://abcdefghijklmnop/src/options/index.html' },
      { id: 2, url: 'chrome://version' },
      { id: 3, url: 'about:blank' },
      { id: 4, url: 'data:text/html,<p>hi' },
      { id: 5, url: 'devtools://devtools/bundled/devtools_app.html' },
      // No URL at all: without host access the browser withholds it, and a
      // tab we have no access to could not be injected into anyway.
      { id: 6 },
      { id: 7, url: 'https://ok.example/' },
    ]);
    grantAll(h);
    await vi.waitFor(() => expect(targets(h)).toEqual([7]));
    // Also when the browser reports no origins at all, so the walk is not
    // narrowed by the grant and the manifest's patterns are the only filter.
    h.added.forEach((l) => l(undefined));
    await vi.waitFor(() => expect(targets(h)).toEqual([7, 7]));
  });

  it('only walks the tabs a partial grant actually covers', async () => {
    const h = await loadWorker([
      { id: 1, url: 'https://example.com/one' },
      { id: 2, url: 'https://other.example/two' },
      { id: 3, url: 'https://sub.example.com/three' },
    ]);
    h.added.forEach((l) => l({ origins: ['https://example.com/*'], permissions: [] }));
    await vi.waitFor(() => expect(targets(h)).toEqual([1]));
  });

  it('does nothing for a grant that adds no host access', async () => {
    const h = await loadWorker(webTabs);
    // Some future optional permission: no page changes, so no tab walk.
    h.added.forEach((l) => l({ origins: [], permissions: ['bookmarks'] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.executeScript).not.toHaveBeenCalled();
    // A browser that tells us nothing still gets the full walk.
    h.added.forEach((l) => l(undefined));
    await vi.waitFor(() => expect(targets(h)).toEqual([1, 2, 3]));
  });

  it('does not wait for one tab before starting the next', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, url: `https://t${i}.example/` }));
    const h = await loadWorker(many);
    let inFlight = 0;
    let peak = 0;
    h.executeScript.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    grantAll(h);
    await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledTimes(6));
    // Serially this would never exceed one.
    expect(peak).toBeGreaterThan(1);
  });
});
