import { describe, it, expect, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

interface Harness {
  added: Listener[];
  query: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
}

/** A chrome mock with permissions + tabs, then the worker loaded fresh. */
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
      getManifest: () => ({ content_scripts: [{ js: ['assets/loader.js'] }] }),
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

const targets = (h: Harness): number[] =>
  h.executeScript.mock.calls.map((c) => (c[0] as { target: { tabId: number } }).target.tabId);

describe('background: a new all-sites grant', () => {
  it('injects the content script into the tabs that are already open', async () => {
    const h = await loadWorker([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(h.added).toHaveLength(1);
    h.added.forEach((l) => l({ origins: ['<all_urls>'] }));
    await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledTimes(3));
    expect(h.query).toHaveBeenCalledWith({});
    expect(targets(h)).toEqual([1, 2, 3]);
    expect(h.executeScript.mock.calls[0]?.[0]).toEqual({
      target: { tabId: 1, frameIds: [0] },
      files: ['assets/loader.js'],
    });
  });

  it('keeps going past a tab it cannot inject into', async () => {
    const h = await loadWorker([{ id: 1 }, { id: 2 }, { id: 3 }]);
    h.executeScript.mockImplementation(async (opts: { target: { tabId: number } }) => {
      if (opts.target.tabId === 2) throw new Error('Cannot access contents of the page');
      return [];
    });
    h.added.forEach((l) => l({ origins: ['<all_urls>'] }));
    await vi.waitFor(() => expect(targets(h)).toEqual([1, 2, 3]));
  });

  it('skips tabs without a usable id and survives an unreadable tab list', async () => {
    const h = await loadWorker([{ id: undefined }, { id: -1 }, { id: 4 }]);
    h.added.forEach((l) => l({ origins: ['<all_urls>'] }));
    await vi.waitFor(() => expect(targets(h)).toEqual([4]));

    const h2 = await loadWorker([]);
    h2.query.mockRejectedValue(new Error('no tabs permission'));
    h2.added.forEach((l) => l({ origins: ['<all_urls>'] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h2.executeScript).not.toHaveBeenCalled();
  });
});
