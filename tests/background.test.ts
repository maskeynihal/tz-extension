import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isConvertSelectionMessage, isOpenOptionsMessage, MAX_MESSAGE_TEXT } from '../src/lib/messages';

type Listener = (...args: unknown[]) => unknown;

interface Harness {
  installed: Listener[];
  startup: Listener[];
  clicked: Listener[];
  messages: Listener[];
  create: ReturnType<typeof vi.fn>;
  removeAll: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
  openOptionsPage: ReturnType<typeof vi.fn>;
  commands: Listener[];
  getAll: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
}

/** Install a chrome mock with the APIs the worker uses, then load the worker fresh. */
async function loadWorker(): Promise<Harness> {
  const h: Harness = {
    installed: [],
    startup: [],
    clicked: [],
    messages: [],
    create: vi.fn((_props: unknown, cb?: () => void) => cb?.()),
    removeAll: vi.fn((cb?: () => void) => cb?.()),
    sendMessage: vi.fn(),
    executeScript: vi.fn(async () => []),
    openOptionsPage: vi.fn(async () => undefined),
    commands: [],
    getAll: vi.fn(async () => [{ name: 'focus-card', shortcut: 'Alt+Shift+K', description: '' }]),
    query: vi.fn(async () => [{ id: 9 }]),
  };
  const base = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    ...base,
    runtime: {
      id: 'ext-id',
      lastError: undefined,
      onInstalled: { addListener: (l: Listener) => h.installed.push(l) },
      onStartup: { addListener: (l: Listener) => h.startup.push(l) },
      onMessage: { addListener: (l: Listener) => h.messages.push(l) },
      getManifest: () => ({ content_scripts: [{ js: ['assets/loader.js'] }] }),
      openOptionsPage: h.openOptionsPage,
    },
    contextMenus: {
      create: h.create,
      removeAll: h.removeAll,
      onClicked: { addListener: (l: Listener) => h.clicked.push(l) },
    },
    tabs: { sendMessage: h.sendMessage, query: h.query },
    commands: { getAll: h.getAll, onCommand: { addListener: (l: Listener) => h.commands.push(l) } },
    scripting: { executeScript: h.executeScript },
  };
  vi.resetModules();
  await import('../src/background/service-worker');
  return h;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('background: context menu', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('registers the selection menu item on install and on startup, idempotently', async () => {
    const h = await loadWorker();
    h.installed.forEach((l) => l({ reason: 'install' }));
    h.startup.forEach((l) => l());
    expect(h.removeAll).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[0]?.[0]).toEqual({
      id: 'tzx-convert-selection',
      title: 'Convert “%s” with TZ Converter',
      contexts: ['selection'],
    });
  });

  it('sends the selection to the clicked frame when its content script is there', async () => {
    const h = await loadWorker();
    h.sendMessage.mockResolvedValue({ ok: true });
    h.clicked.forEach((l) => l({ menuItemId: 'tzx-convert-selection', frameId: 0, selectionText: '1700000000' }, { id: 7 }));
    await flush();
    expect(h.sendMessage).toHaveBeenCalledWith(
      7,
      { type: 'tzx/convert-selection', text: '1700000000', truncated: false },
      { frameId: 0 },
    );
    expect(h.executeScript).not.toHaveBeenCalled();
  });

  it('injects the content script when the tab has none, then retries', async () => {
    const h = await loadWorker();
    h.sendMessage
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValue({ ok: true });
    h.clicked.forEach((l) => l({ menuItemId: 'tzx-convert-selection', frameId: 0, selectionText: 'x' }, { id: 3 }));
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(2));
    expect(h.executeScript).toHaveBeenCalledWith({ target: { tabId: 3, frameIds: [0] }, files: ['assets/loader.js'] });
  });

  it('falls back to the top frame when a sub-frame cannot be reached', async () => {
    const h = await loadWorker();
    h.sendMessage.mockImplementation(async (_tab: number, _msg: unknown, opts: { frameId: number }) => {
      if (opts.frameId === 0) return { ok: true };
      throw new Error('no receiver');
    });
    h.executeScript.mockRejectedValue(new Error('Cannot access contents of the page'));
    h.clicked.forEach((l) => l({ menuItemId: 'tzx-convert-selection', frameId: 12, selectionText: 'x' }, { id: 4 }));
    await vi.waitFor(() =>
      expect(h.sendMessage).toHaveBeenCalledWith(4, expect.anything(), { frameId: 0 }),
    );
  });

  it('ignores other menu items and clicks without a tab', async () => {
    const h = await loadWorker();
    h.clicked.forEach((l) => l({ menuItemId: 'other', frameId: 0 }, { id: 1 }));
    h.clicked.forEach((l) => l({ menuItemId: 'tzx-convert-selection', frameId: 0 }, undefined));
    await flush();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('truncates very long selections before messaging', async () => {
    const h = await loadWorker();
    h.sendMessage.mockResolvedValue({ ok: true });
    const long = 'a'.repeat(MAX_MESSAGE_TEXT + 100);
    h.clicked.forEach((l) => l({ menuItemId: 'tzx-convert-selection', frameId: 0, selectionText: long }, { id: 2 }));
    await flush();
    const sent = h.sendMessage.mock.calls[0]?.[1] as { text: string; truncated: boolean };
    expect(sent.text.length).toBe(MAX_MESSAGE_TEXT);
    expect(sent.truncated).toBe(true);
  });

  it('opens settings at the formats section when asked', async () => {
    const h = await loadWorker();
    const create = vi.fn(async () => ({}));
    const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
    c.tabs = { ...c.tabs, create };
    c.runtime = {
      ...c.runtime,
      getManifest: () => ({ options_page: 'src/options/index.html' }),
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
    };
    h.messages.forEach((l) => l({ type: 'tzx/open-options', section: 'formats' }, { id: 'ext-id' }, vi.fn()));
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://ext-id/src/options/index.html#formats' });
    expect(h.openOptionsPage).not.toHaveBeenCalled();
  });

  it('opens settings only for messages from this extension', async () => {
    const h = await loadWorker();
    const respond = vi.fn();
    h.messages.forEach((l) => l({ type: 'tzx/open-options' }, { id: 'someone-else' }, respond));
    expect(h.openOptionsPage).not.toHaveBeenCalled();
    h.messages.forEach((l) => l({ type: 'tzx/open-options' }, { id: 'ext-id' }, respond));
    expect(h.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });
});

describe('background: the focus-card command', () => {
  it('forwards the command to every frame of the tab it was pressed in', async () => {
    const h = await loadWorker();
    h.sendMessage.mockResolvedValue({ ok: true });
    expect(h.commands).toHaveLength(1);
    h.commands.forEach((l) => l('focus-card', { id: 5 }));
    await flush();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith(5, { type: 'tzx/focus-card' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('uses the active tab when the browser gives none, and ignores other commands', async () => {
    const h = await loadWorker();
    h.sendMessage.mockResolvedValue(undefined);
    h.commands.forEach((l) => l('something-else', { id: 5 }));
    await flush();
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.commands.forEach((l) => l('focus-card', undefined));
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(9, { type: 'tzx/focus-card' }));
    expect(h.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it('a tab without a content script is not an error', async () => {
    const h = await loadWorker();
    h.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    h.commands.forEach((l) => l('focus-card', { id: 5 }));
    await flush();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('tells the content script what the command is bound to, or "" when unbound', async () => {
    const h = await loadWorker();
    const respond = vi.fn();
    const kept = h.messages.map((l) => l({ type: 'tzx/get-shortcut' }, { id: 'ext-id' }, respond));
    expect(kept).toContain(true); // answers asynchronously
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ shortcut: 'Alt+Shift+K' }));
    h.getAll.mockResolvedValue([{ name: 'focus-card', shortcut: '', description: '' }]);
    const again = vi.fn();
    h.messages.forEach((l) => l({ type: 'tzx/get-shortcut' }, { id: 'ext-id' }, again));
    await vi.waitFor(() => expect(again).toHaveBeenCalledWith({ shortcut: '' }));
    // Not for pages or other extensions.
    const other = vi.fn();
    h.messages.forEach((l) => l({ type: 'tzx/get-shortcut' }, { id: 'someone-else' }, other));
    await flush();
    expect(other).not.toHaveBeenCalled();
  });
});

describe('manifest', () => {
  it('declares the focus-card command with keys the browsers do not reserve', async () => {
    // The crxjs plugin pulls in esbuild, which does not load under jsdom;
    // defineManifest hands the object back as it is.
    vi.doMock('@crxjs/vite-plugin', () => ({ defineManifest: <T,>(m: T): T => m }));
    vi.resetModules();
    const { default: m } = (await import('../src/manifest')) as unknown as { default: { commands?: unknown } };
    vi.doUnmock('@crxjs/vite-plugin');
    expect(m.commands).toEqual({
      'focus-card': {
        suggested_key: { default: 'Alt+Shift+K', mac: 'MacCtrl+Shift+K' },
        description: 'Move focus to the open conversion card and back',
      },
    });
    // Chrome (Windows, Linux, ChromeOS) takes Alt+Shift with A, B, I, L, M, N, S and T.
    const key = (m.commands as Record<string, { suggested_key: { default: string } }>)['focus-card']?.suggested_key.default;
    expect(['A', 'B', 'I', 'L', 'M', 'N', 'S', 'T'].map((k) => `Alt+Shift+${k}`)).not.toContain(key);
  });
});

describe('message validators', () => {
  it('accept well-formed messages only', () => {
    expect(isConvertSelectionMessage({ type: 'tzx/convert-selection', text: 'x' })).toBe(true);
    expect(isConvertSelectionMessage({ type: 'tzx/convert-selection', text: 5 })).toBe(false);
    expect(isConvertSelectionMessage({ type: 'tzx/convert-selection', text: 'a'.repeat(MAX_MESSAGE_TEXT + 1) })).toBe(false);
    expect(isConvertSelectionMessage(null)).toBe(false);
    expect(isOpenOptionsMessage({ type: 'tzx/open-options' })).toBe(true);
    expect(isOpenOptionsMessage({ type: 'nope' })).toBe(false);
  });
});
