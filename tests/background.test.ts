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
    tabs: { sendMessage: h.sendMessage },
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
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'tzx/convert-selection', text: '1700000000' }, { frameId: 0 });
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
    const sent = h.sendMessage.mock.calls[0]?.[1] as { text: string };
    expect(sent.text.length).toBe(MAX_MESSAGE_TEXT);
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
