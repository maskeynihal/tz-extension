import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown;

/**
 * Load the content script against a chrome mock whose storage read resolves
 * only when the test says so, to exercise the "menu click before preferences
 * load" path of a freshly injected script.
 */
async function loadContent(stored: Record<string, unknown>): Promise<{
  listener: Listener;
  releaseStorage: () => void;
}> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const listeners: Listener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: vi.fn(async () => {
          await gate;
          return { 'tz-extension-prefs': stored };
        }),
        set: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      id: 'ext-id',
      onMessage: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: vi.fn(),
      },
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
  };
  delete (window as unknown as Record<string, unknown>).__tzExtensionContent__;
  vi.resetModules();
  await import('../src/content/index');
  const listener = listeners[0];
  if (!listener) throw new Error('content script registered no message listener');
  return { listener, releaseStorage: release };
}

const shadowText = (): string =>
  document.getElementById('tz-extension-popover-host')?.shadowRoot?.textContent ?? '';

describe('content script: right-click convert', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('waits for stored preferences before converting a menu click', async () => {
    const { listener, releaseStorage } = await loadContent({
      homeZone: 'UTC',
      targetZones: ['Asia/Tokyo'],
      customFormats: [{ id: 'g', label: 'German', pattern: 'DD.MM.YYYY [um] HH:mm', advanced: false, enabled: true }],
    });
    const respond = vi.fn();
    const async = listener({ type: 'tzx/convert-selection', text: '24.12.2024 um 18:30' }, { id: 'ext-id' }, respond);
    expect(async).toBe(true);
    // Nothing yet: preferences are still loading.
    expect(respond).not.toHaveBeenCalled();
    expect(document.getElementById('tz-extension-popover-host')).toBeNull();

    releaseStorage();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
    expect(shadowText()).toContain('format: German');
    expect(shadowText()).toContain('Asia/Tokyo');
  });

  it('shows the no-match card for unrecognized text and asks for the formats section', async () => {
    const { listener, releaseStorage } = await loadContent({ homeZone: 'UTC' });
    releaseStorage();
    const respond = vi.fn();
    listener({ type: 'tzx/convert-selection', text: 'not a time' }, { id: 'ext-id' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(shadowText()).toContain('No date or time recognized');
    const btn = Array.from(
      document.getElementById('tz-extension-popover-host')?.shadowRoot?.querySelectorAll('button') ?? [],
    ).find((b) => b.textContent === 'Open format settings');
    btn?.click();
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome
      .runtime.sendMessage;
    expect(send).toHaveBeenCalledWith({ type: 'tzx/open-options', section: 'formats' });
  });

  it('ignores messages from other senders and malformed messages', async () => {
    const { listener, releaseStorage } = await loadContent({ homeZone: 'UTC' });
    releaseStorage();
    expect(listener({ type: 'tzx/convert-selection', text: '1700000000' }, { id: 'evil' }, vi.fn())).toBeUndefined();
    expect(listener({ type: 'tzx/convert-selection', text: 42 }, { id: 'ext-id' }, vi.fn())).toBeUndefined();
    expect(document.getElementById('tz-extension-popover-host')).toBeNull();
  });

  it('does not install twice in the same page while the first copy is alive', async () => {
    await loadContent({ homeZone: 'UTC' });
    const first = (window as unknown as Record<string, unknown>).__tzExtensionContent__;
    vi.resetModules();
    await import('../src/content/index');
    expect((window as unknown as Record<string, unknown>).__tzExtensionContent__).toBe(first);
  });
});
