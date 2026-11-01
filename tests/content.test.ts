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

describe('content script: cards, pins and the dock', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const shadowOf = (el: Element | null | undefined): ShadowRoot => {
    const root = (el as HTMLElement | null)?.shadowRoot;
    if (!root) throw new Error('no shadow root');
    return root;
  };
  const transient = (): ShadowRoot => shadowOf(document.getElementById('tz-extension-popover-host'));
  const pinHosts = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.tz-extension-pin-host'));
  const dock = (): ShadowRoot => shadowOf(document.getElementById('tz-extension-pin-dock'));
  const button = (root: ShadowRoot, label: string): HTMLButtonElement => {
    const b = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
  };

  async function openCard(
    stored: Record<string, unknown>,
    text = '2024-01-02T12:00:00Z',
  ): Promise<{ listener: Listener; set: ReturnType<typeof vi.fn> }> {
    const { listener, releaseStorage } = await loadContent(stored);
    releaseStorage();
    const respond = vi.fn();
    listener({ type: 'tzx/convert-selection', text }, { id: 'ext-id' }, respond);
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    const set = (globalThis as unknown as { chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> } } } }).chrome
      .storage.sync.set;
    return { listener, set };
  }

  it('opens compact when the card size setting says so, and does not save the size for a fixed setting', async () => {
    const { set } = await openCard({ homeZone: 'UTC', cardSize: 'compact', lastCardSize: 'compact' });
    expect(transient().querySelector('.tzx-card')?.classList.contains('compact')).toBe(true);
    button(transient(), 'Expand card').click();
    await vi.waitFor(() => expect(transient().querySelector('.tzx-card')?.classList.contains('compact')).toBe(false));
    // Only "Last used" reads lastCardSize, so a fixed size writes nothing.
    await new Promise((r) => setTimeout(r, 700));
    expect(set).not.toHaveBeenCalled();
  });

  it('"Last used" remembers the last size toggled', async () => {
    const { set } = await openCard({ homeZone: 'UTC', cardSize: 'last', lastCardSize: 'compact' });
    button(transient(), 'Expand card').click();
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(set.mock.calls.at(-1)?.[0]['tz-extension-prefs'].lastCardSize).toBe('full');
  });

  it('"Last used" opens at the remembered size', async () => {
    await openCard({ homeZone: 'UTC', cardSize: 'last', lastCardSize: 'compact' });
    expect(transient().querySelector('.tzx-card')?.classList.contains('compact')).toBe(true);
  });

  it('offers the day/month choice for an ambiguous date and re-reads it', async () => {
    const { set } = await openCard({ homeZone: 'UTC', numericDateOrder: 'dmy' }, '03/04/2024 10:00');
    const group = transient().querySelector('.tzx-order');
    expect(group?.textContent).toContain('3 Apr 2024');
    expect(group?.textContent).toContain('Mar 4, 2024');
    const monthFirst = Array.from(group?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Mar 4'));
    monthFirst?.click();
    await vi.waitFor(() =>
      expect(transient().querySelector('.tzx-order-btn.on')?.textContent).toContain('Mar 4, 2024'),
    );
    await vi.waitFor(() => expect(set.mock.calls.at(-1)?.[0]['tz-extension-prefs'].numericDateOrder).toBe('mdy'));
    expect(transient().querySelector('.tzx-date')?.textContent).toBe('2024-03-04');
  });

  it('pins, then the dock minimizes, expands, unpins (floats) and closes all with undo', async () => {
    const { listener } = await openCard({ homeZone: 'UTC' });
    button(transient(), 'Pin to page').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    listener({ type: 'tzx/convert-selection', text: '1700000000' }, { id: 'ext-id' }, vi.fn());
    await vi.waitFor(() => expect(document.getElementById('tz-extension-popover-host')).not.toBeNull());
    button(transient(), 'Pin to page').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(2));

    await vi.waitFor(() => expect(dock().querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Pinned cards: 2 pinned cards'));
    const cards = (): Element[] => pinHosts().map((h) => shadowOf(h).querySelector('.tzx-card') as Element);

    button(dock(), 'Minimize all').click();
    await vi.waitFor(() => expect(cards().every((c) => c.classList.contains('compact'))).toBe(true));
    expect(button(dock(), 'Minimize all').disabled).toBe(true);

    button(dock(), 'Expand all').click();
    await vi.waitFor(() => expect(cards().some((c) => c.classList.contains('compact'))).toBe(false));

    button(dock(), 'Unpin all').click();
    await vi.waitFor(() => expect(cards().every((c) => c.classList.contains('floating'))).toBe(true));
    expect(pinHosts().every((h) => h.style.getPropertyValue('position') === 'fixed')).toBe(true);
    button(dock(), 'Pin all to page').click();
    await vi.waitFor(() => expect(pinHosts().every((h) => h.style.getPropertyValue('position') === 'absolute')).toBe(true));

    button(dock(), 'Close all').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(0));
    expect(dock().textContent).toContain('Closed 2 cards');
    const undo = Array.from(dock().querySelectorAll('button')).find((b) => b.textContent?.includes('Undo'));
    undo?.click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(2));
  });

  it('a single card floats and pins back from its own header', async () => {
    await openCard({ homeZone: 'UTC' });
    button(transient(), 'Pin to page').click();
    await vi.waitFor(() => expect(pinHosts()).toHaveLength(1));
    const root = shadowOf(pinHosts()[0]);
    button(root, 'Float on screen').click();
    await vi.waitFor(() => expect(root.querySelector('.tzx-card.floating')).not.toBeNull());
    button(root, 'Pin to page').click();
    await vi.waitFor(() => expect(root.querySelector('.tzx-card.floating')).toBeNull());
  });

  it('never removes the page selection, so the user can still copy it', async () => {
    document.body.innerHTML = '<p id="t">Long notes. Meeting at 2024-01-02T12:00:00Z with the whole team, then lunch.</p>';
    await openCard({ homeZone: 'UTC' });
    const p = document.getElementById('t')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 350));
    expect(window.getSelection()?.toString()).toContain('Long notes.');
    expect(window.getSelection()?.toString()).toContain('then lunch.');
  });
});
