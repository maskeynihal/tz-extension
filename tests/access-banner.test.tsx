import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import { AccessBanner } from '../src/popup/AccessBanner';
import { App } from '../src/popup/App';
import { Options } from '../src/options/Options';
import { loadAccessDismissed, saveAccessDismissed } from '../src/popup/access-dismissal';

type Listener = () => void;

interface PermMock {
  contains: Mock;
  request: Mock;
  getAll: Mock;
  added: Listener[];
  removed: Listener[];
}

/**
 * tests/setup.ts rebuilds `chrome` for every test and other suites depend on
 * it, so the permissions API is grafted on here instead of there.
 *
 * `getAll` reports what a real Chromium reports: the granted origin patterns,
 * which is the only thing that tells "allowed a few sites" apart from
 * "allowed nothing" — `contains({origins:['<all_urls>']})` is false for both.
 */
function installPermissions(granted: boolean, origins?: string[]): PermMock {
  const m: PermMock = {
    contains: vi.fn(async () => granted),
    request: vi.fn(async () => false),
    getAll: vi.fn(async () => ({ origins: origins ?? (granted ? ['<all_urls>'] : []), permissions: ['storage'] })),
    added: [],
    removed: [],
  };
  const c = globalThis.chrome as unknown as Record<string, unknown>;
  c.permissions = {
    contains: m.contains,
    request: m.request,
    getAll: m.getAll,
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

  it('appears when access is withheld, offering the grant and a way to stop asking', async () => {
    installPermissions(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.textContent).toMatch(/won’t convert until you allow/i);
    // Two: the grant, and "don't show again". The banner used to offer only
    // the grant, which left a user who kept saying no with a permanent notice
    // (review r8 #7).
    expect(banner()?.querySelectorAll('button')).toHaveLength(2);
    expect(allow()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t show again' })).toBeInTheDocument();
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

  /*
   * A rejected request means this browser will not let the extension ask at
   * all (a refusal resolves `false` instead). Offering the button again would
   * be offering one that does nothing, so the banner degrades to telling the
   * user where to grant it by hand (review r8 #6).
   */
  it('a rejected request stops offering the button and says where to grant it by hand', async () => {
    const p = installPermissions(false);
    p.request.mockRejectedValue(new Error('not an optional permission'));
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(allow()));
    await waitFor(() => expect(document.querySelector('.tzx-access-hint')).not.toBeNull());
    expect(banner()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow on all sites' })).toBeNull();
    expect(document.querySelector('.tzx-access-hint')?.textContent).toMatch(/won’t let the extension ask/i);
    expect(document.querySelector('.tzx-access-hint')?.textContent).toMatch(/Site access/);
  });

  it('offers no grant button at all where the browser has no request()', async () => {
    const p = installPermissions(false);
    delete (globalThis.chrome.permissions as unknown as Record<string, unknown>).request;
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Allow on all sites' })).toBeNull();
    expect(p.request).not.toHaveBeenCalled();
    // The user can still stop being told about it.
    expect(screen.getByRole('button', { name: 'Don’t show again' })).toBeInTheDocument();
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

  /*
   * A user who chose "on specific sites" does get conversions there, so the
   * old copy ("times on pages won't convert") was simply false for them, on
   * every popup open, with no way out (review r8 #7). Verified against a real
   * Chromium: withholding reports `origins: []`, a per-site grant reports
   * exactly those patterns, and contains(<all_urls>) is false for both.
   */
  it('tells a partial grant apart from no access, and words it honestly', async () => {
    const p = installPermissions(false, ['https://example.com/*']);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(p.getAll).toHaveBeenCalled();
    const text = banner()?.textContent ?? '';
    expect(text).toMatch(/convert on the sites you’ve allowed/i);
    // The false claim, specifically: not for someone who allowed some sites.
    expect(text).not.toMatch(/Times on pages won’t convert until you allow/);
    // Widening is still on offer, because other pages really are dead.
    expect(allow()).toBeInTheDocument();
  });

  it('says nothing is granted only when nothing is', async () => {
    installPermissions(false, []);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.textContent).toMatch(/Times on pages won’t convert until you allow/);
  });

  it('falls back to the no-access wording where getAll is missing or broken', async () => {
    const p = installPermissions(false, ['https://example.com/*']);
    p.getAll.mockRejectedValue(new Error('unsupported'));
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.textContent).toMatch(/Times on pages won’t convert until you allow/);
  });

  it('stops telling the user once, and keeps quiet on the next popup', async () => {
    installPermissions(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).not.toBeNull());
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Don’t show again' })));
    await waitFor(() => expect(banner()).toBeNull());
    // Persisted, so the next popup (a fresh mount) stays quiet too.
    expect(await loadAccessDismissed()).toBe(true);
    cleanup();
    installPermissions(false);
    await mount(<AccessBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('a dismissal does not hide a later grant confirmation, and is forgotten once access lands', async () => {
    await saveAccessDismissed(true);
    const p = installPermissions(false);
    await mount(<AccessBanner />);
    await waitFor(() => expect(banner()).toBeNull());
    p.contains.mockResolvedValue(true);
    await settle(() => p.added.forEach((l) => l()));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/reading pages now/i));
    // The user is no longer being nagged, so a future revoke may say so once.
    await waitFor(async () => expect(await loadAccessDismissed()).toBe(false));
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

describe('settings page', () => {
  // The worker opens settings#access on a first install with access withheld,
  // so the banner has to be there, at the anchor, above everything else.
  it('shows the banner at #access when access is withheld', async () => {
    installPermissions(false);
    await mount(<Options />);
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()?.closest('#access')).not.toBeNull();
    expect(allow()).toBeInTheDocument();
  });

  it('shows no banner when access is granted', async () => {
    const p = installPermissions(true);
    await mount(<Options />);
    await waitFor(() => expect(p.contains).toHaveBeenCalled());
    expect(banner()).toBeNull();
  });
});
