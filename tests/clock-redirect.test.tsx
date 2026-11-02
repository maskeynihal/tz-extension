import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { App } from '../src/popup/App';
import { SITE_CLOCK_URL } from '../src/lib/site';

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

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the site clock in a browser tab', async () => {
    const create = vi.fn(() => Promise.resolve({}));
    setTabs({ create });
    await pressClock();
    expect(create).toHaveBeenCalledWith({ url: SITE_CLOCK_URL });
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
    expect(open).toHaveBeenCalledWith(SITE_CLOCK_URL, '_blank', 'noopener');
  });

  it('falls back to window.open when the tab call is refused', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    setTabs({ create: vi.fn(() => Promise.reject(new Error('no tabs permission'))) });
    await pressClock();
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(SITE_CLOCK_URL, '_blank', 'noopener'));
  });
});
