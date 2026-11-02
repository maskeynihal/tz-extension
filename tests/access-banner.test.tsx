import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AccessBanner } from '../src/popup/AccessBanner';
import { App } from '../src/popup/App';

type Listener = () => void;

interface PermMock {
  contains: Mock;
  request: Mock;
  added: Listener[];
  removed: Listener[];
}

/**
 * tests/setup.ts rebuilds `chrome` for every test and other suites depend on
 * it, so the permissions API is grafted on here instead of there.
 */
function installPermissions(granted: boolean): PermMock {
  const m: PermMock = {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => false),
    added: [],
    removed: [],
  };
  const c = globalThis.chrome as unknown as Record<string, unknown>;
  c.permissions = {
    contains: m.contains,
    request: m.request,
    onAdded: {
      addListener: (l: Listener) => m.added.push(l),
      removeListener: (l: Listener) => {
        m.added = m.added.filter((x) => x !== l);
      },
    },
    onRemoved: {
      addListener: (l: Listener) => m.removed.push(l),
      removeListener: (l: Listener) => {
        m.removed = m.removed.filter((x) => x !== l);
      },
    },
  };
  return m;
}

const banner = (): HTMLElement | null => document.querySelector('.tzx-access');
const allow = (): HTMLElement => screen.getByRole('button', { name: 'Allow on all sites' });

/** Render and let the initial contains() check settle inside act. */
async function mount(ui: JSX.Element): Promise<HTMLElement> {
  let container = document.body;
  await act(async () => {
    container = render(ui).container;
  });
  return container;
}

/** Run something that resolves a permissions promise, then let React catch up. */
async function settle(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('popup access banner', () => {
  it('stays away when all-sites access is already granted', async () => {
    const p = installPermissions(true);
    await mount(<AccessBanner />);
    await waitFor(() => expect(p.contains).toHaveBeenCalledWith({ origins: ['<all_urls>'] }));
    expect(banner()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow on all sites' })).toBeNull();
    // No premature confirmation for access the user never had to grant.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears with one button when access is withheld', async () => {
    installPermissions(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.textContent).toMatch(/won’t convert until you allow/i);
    expect(banner()?.querySelectorAll('button')).toHaveLength(1);
  });

  it('asks for every site at once, from the click', async () => {
    const p = installPermissions(false);
    p.request.mockResolvedValue(true);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(allow()));
    expect(p.request).toHaveBeenCalledTimes(1);
    expect(p.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('a granted request hides the banner and confirms', async () => {
    const p = installPermissions(false);
    p.request.mockResolvedValue(true);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(allow()));
    await waitFor(() => expect(banner()).toBeNull());
    expect(screen.getByRole('status').textContent).toMatch(/reading pages now/i);
  });

  it('a declined request keeps the banner and says where to change it', async () => {
    const p = installPermissions(false);
    p.request.mockResolvedValue(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(allow()));
    await waitFor(() => expect(document.querySelector('.tzx-access-hint')).not.toBeNull());
    expect(banner()).not.toBeNull();
    expect(allow()).toBeEnabled();
    expect(document.querySelector('.tzx-access-hint')?.textContent).toMatch(/later/i);
  });

  it('a rejected request is treated as "not granted"', async () => {
    const p = installPermissions(false);
    p.request.mockRejectedValue(new Error('no user gesture'));
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(allow()));
    await waitFor(() => expect(document.querySelector('.tzx-access-hint')).not.toBeNull());
    expect(banner()).not.toBeNull();
  });

  it('a grant that lands while the popup is open hides the banner', async () => {
    const p = installPermissions(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(p.added).toHaveLength(1);
    // Firefox grants through its own UI; onAdded is the only signal we get.
    p.contains.mockResolvedValue(true);
    await settle(() => p.added.forEach((l) => l()));
    await waitFor(() => expect(banner()).toBeNull());
    expect(screen.getByRole('status').textContent).toMatch(/reading pages now/i);
  });

  it('a revoked grant brings the banner back', async () => {
    const p = installPermissions(true);
    await mount(<AccessBanner />);
    await waitFor(() => expect(p.contains).toHaveBeenCalled());
    expect(banner()).toBeNull();
    expect(p.removed).toHaveLength(1);
    p.contains.mockResolvedValue(false);
    await settle(() => p.removed.forEach((l) => l()));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it('renders nothing and does not crash when chrome.permissions is absent', async () => {
    const container = await mount(<AccessBanner />);
    expect(container.innerHTML).toBe('');
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('says nothing when the browser will not answer contains()', async () => {
    const p = installPermissions(false);
    p.contains.mockRejectedValue(new Error('unsupported'));
    const container = await mount(<AccessBanner />);
    await waitFor(() => expect(p.contains).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('drops its permission listeners on unmount', async () => {
    const p = installPermissions(false);
    let unmount = (): void => {};
    await act(async () => {
      unmount = render(<AccessBanner />).unmount;
    });
    expect(p.added).toHaveLength(1);
    unmount();
    expect(p.added).toHaveLength(0);
    expect(p.removed).toHaveLength(0);
  });
});

describe('popup App', () => {
  it('shows the banner above the tabs when access is withheld', async () => {
    installPermissions(false);
    await mount(<App />);
    await waitFor(() => expect(banner()).not.toBeNull());
    const app = document.querySelector('.tzx-app');
    const kids = Array.from(app?.children ?? []);
    expect(kids.indexOf(banner() as Element)).toBeLessThan(
      kids.findIndex((k) => k.classList.contains('tzx-app-head')),
    );
    expect(screen.getByRole('tab', { name: 'Converter' })).toBeInTheDocument();
  });

  it('shows no banner when access is granted', async () => {
    const p = installPermissions(true);
    await mount(<App />);
    await waitFor(() => expect(p.contains).toHaveBeenCalled());
    expect(banner()).toBeNull();
  });
});
