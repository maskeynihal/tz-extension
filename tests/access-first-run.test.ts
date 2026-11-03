import { describe, it, expect, vi } from 'vitest';
import { saveAccessDismissed, ACCESS_DISMISSED_KEY } from '../src/popup/access-dismissal';

type Listener = (...args: unknown[]) => unknown;

interface Harness {
  installed: Listener[];
  startup: Listener[];
  added: Listener[];
  removed: Listener[];
  storageChanged: Listener[];
  contains: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  setBadgeText: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
}

/**
 * The worker loaded fresh over tests/setup.ts's chrome, with `granted` as the
 * answer to "every site?". Storage stays setup's in-memory one, so the
 * banner's dismissal is read for real.
 */
async function loadWorker(granted: boolean | 'throws'): Promise<Harness> {
  const h: Harness = {
    installed: [],
    startup: [],
    added: [],
    removed: [],
    storageChanged: [],
    contains: vi.fn(async () => {
      if (granted === 'throws') throw new Error('unavailable');
      return granted;
    }),
    create: vi.fn(async () => ({})),
    setBadgeText: vi.fn(async () => undefined),
    setTitle: vi.fn(async () => undefined),
  };
  const base = globalThis.chrome as unknown as Record<string, unknown> & { storage: Record<string, unknown> };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    ...base,
    storage: { ...base.storage, onChanged: { addListener: (l: Listener) => h.storageChanged.push(l) } },
    runtime: {
      id: 'ext-id',
      lastError: undefined,
      onInstalled: { addListener: (l: Listener) => h.installed.push(l) },
      onStartup: { addListener: (l: Listener) => h.startup.push(l) },
      onMessage: { addListener: vi.fn() },
      getManifest: () => ({ options_page: 'src/options/index.html', content_scripts: [] }),
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
    },
    action: { setBadgeText: h.setBadgeText, setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: h.setTitle },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: { create: h.create, query: vi.fn(async () => []), sendMessage: vi.fn() },
    commands: { getAll: vi.fn(async () => []), onCommand: { addListener: vi.fn() } },
    permissions: {
      contains: h.contains,
      onAdded: { addListener: (l: Listener) => h.added.push(l) },
      onRemoved: { addListener: (l: Listener) => h.removed.push(l) },
    },
  };
  vi.resetModules();
  await import('../src/background/service-worker');
  return h;
}

const install = (h: Harness, reason: string): void => h.installed.forEach((l) => l({ reason }));
const lastBadge = (h: Harness): unknown => h.setBadgeText.mock.calls.at(-1)?.[0];

describe('background: first install with site access withheld', () => {
  it('opens settings at the access banner', async () => {
    const h = await loadWorker(false);
    install(h, 'install');
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.create).toHaveBeenCalledWith({ url: 'chrome-extension://ext-id/src/options/index.html#access' });
  });

  it('opens nothing when every site is already granted', async () => {
    const h = await loadWorker(true);
    install(h, 'install');
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
    expect(h.create).not.toHaveBeenCalled();
  });

  it('opens nothing on an update, even with access withheld', async () => {
    const h = await loadWorker(false);
    install(h, 'update');
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '!' }));
    expect(h.create).not.toHaveBeenCalled();
  });

  it('opens nothing once the banner was dismissed, e.g. synced from another device', async () => {
    await saveAccessDismissed(true);
    const h = await loadWorker(false);
    install(h, 'install');
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.create).not.toHaveBeenCalled();
  });

  it('opens nothing when the browser will not say', async () => {
    const h = await loadWorker('throws');
    install(h, 'install');
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe('background: toolbar badge', () => {
  it('marks the icon on startup while access is withheld', async () => {
    const h = await loadWorker(false);
    h.startup.forEach((l) => l());
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '!' }));
    expect(h.setTitle.mock.calls.at(-1)?.[0]).toEqual({
      title: 'TZ Converter — allow site access to convert times on pages',
    });
  });

  it('clears the mark once access is granted', async () => {
    const h = await loadWorker(false);
    h.startup.forEach((l) => l());
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '!' }));
    h.contains.mockResolvedValue(true);
    h.added.forEach((l) => l({ origins: ['<all_urls>'], permissions: [] }));
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
    expect(h.setTitle.mock.calls.at(-1)?.[0]).toEqual({ title: 'TZ Converter' });
  });

  it('marks the icon again when access is revoked', async () => {
    const h = await loadWorker(true);
    h.startup.forEach((l) => l());
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
    h.contains.mockResolvedValue(false);
    h.removed.forEach((l) => l({ origins: ['<all_urls>'], permissions: [] }));
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '!' }));
  });

  it('follows the banner’s “Don’t show again”', async () => {
    const h = await loadWorker(false);
    h.startup.forEach((l) => l());
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '!' }));
    await saveAccessDismissed(true);
    h.storageChanged.forEach((l) => l({ [ACCESS_DISMISSED_KEY]: { newValue: { dismissed: true } } }, 'sync'));
    await vi.waitFor(() => expect(lastBadge(h)).toEqual({ text: '' }));
  });

  it('ignores storage changes that are not the dismissal', async () => {
    const h = await loadWorker(false);
    h.storageChanged.forEach((l) => l({ 'some-other-key': { newValue: 1 } }, 'sync'));
    await new Promise((r) => setTimeout(r, 10));
    expect(h.setBadgeText).not.toHaveBeenCalled();
  });
});
