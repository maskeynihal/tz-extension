import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import {
  applyOrder,
  dayPhase,
  formatDiff,
  makeHome,
  relativeDay,
  shownInstant,
  workStatus,
} from '../src/clock/model';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';

// Tuesday 2 Jan 2024, 20:00:00 UTC. Home (UTC−08:00) is 12:00 Tue; UTC+05:45 is 01:45 Wed.
const NOW = Date.UTC(2024, 0, 2, 20, 0, 0);

const base: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'UTC-08:00',
  targetZones: ['UTC+05:45', 'UTC'],
  hour12: false,
  theme: 'system',
};

interface StorageMock {
  storage: {
    sync: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    onChanged: { addListener: ReturnType<typeof vi.fn> };
  };
}

function chromeMock(): StorageMock {
  return (globalThis as unknown as { chrome: StorageMock }).chrome;
}

/** The last preferences written through savePreferences. */
function lastSaved(): Preferences {
  const calls = chromeMock().storage.sync.set.mock.calls;
  const last = calls[calls.length - 1]?.[0] as Record<string, Preferences> | undefined;
  if (!last?.[KEY]) throw new Error('nothing saved');
  return last[KEY];
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mount(prefs: Preferences = base): Promise<void> {
  await chromeMock().storage.sync.set({ [KEY]: prefs });
  chromeMock().storage.sync.set.mockClear();
  render(<ClockApp />);
  await flush();
}

function card(zone: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.tzc-card[data-zone="${zone}"]`);
  if (!el) throw new Error(`no card for ${zone}`);
  return el;
}

function timeOf(zone: string): string {
  return card(zone).querySelector('.tzc-time')?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ClockApp', () => {
  it('renders the home card first, then each target, with labels not raw ids', async () => {
    await mount();
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.tzc-card'));
    expect(cards.map((c) => c.dataset.zone)).toEqual(['UTC-08:00', 'UTC+05:45', 'UTC']);
    expect(within(cards[0] as HTMLElement).getByText('Home')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('UTC−08:00');
    expect(within(card('UTC')).getByRole('heading', { level: 3 })).toHaveTextContent('UTC');
    expect(within(card('UTC')).getByText('Coordinated Universal Time')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'World clock' })).toBeInTheDocument();
  });

  it('shows time, difference from home, relative day and working hours', async () => {
    await mount();
    expect(timeOf('UTC-08:00')).toBe('12:00:00');
    expect(timeOf('UTC+05:45')).toBe('01:45:00');
    expect(timeOf('UTC')).toBe('20:00:00');

    const kath = within(card('UTC+05:45'));
    expect(kath.getByText('+13h 45m')).toBeInTheDocument();
    expect(kath.getByText('Tomorrow')).toBeInTheDocument();
    expect(kath.getByText('UTC+05:45', { selector: 'dd' })).toBeInTheDocument();
    expect(kath.getByText('Outside working hours')).toBeInTheDocument();

    const utc = within(card('UTC'));
    expect(utc.getByText('+8h')).toBeInTheDocument();
    expect(utc.getByText('Today')).toBeInTheDocument();
    expect(utc.getByText('Evening, after work')).toBeInTheDocument();

    const home = within(card('UTC-08:00'));
    expect(home.getByText('Home zone')).toBeInTheDocument();
    expect(home.getByText('Working hours')).toBeInTheDocument();
    expect(home.getByText('UTC−08:00', { selector: 'dd' })).toBeInTheDocument();
  });

  it('ticks once per second', async () => {
    await mount();
    expect(timeOf('UTC')).toBe('20:00:00');
    await act(async () => {
      // The tick lands just past the next second boundary.
      await vi.advanceTimersByTimeAsync(1005);
    });
    expect(timeOf('UTC')).toBe('20:00:01');
  });

  it('scrubber shifts every clock together and Now resets', async () => {
    await mount();
    const slider = screen.getByLabelText('Shift all clocks');
    fireEvent.change(slider, { target: { value: '8' } }); // +2h
    expect(timeOf('UTC-08:00')).toBe('14:00');
    expect(timeOf('UTC+05:45')).toBe('03:45');
    expect(timeOf('UTC')).toBe('22:00');
    expect(screen.getByText('Planning:').parentElement).toHaveTextContent(/Tue 14:00 in UTC−08:00/);
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Tue 14:00 in UTC−08:00'));

    // Page Up adds an hour; Escape returns to now.
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(timeOf('UTC')).toBe('23:00');
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(timeOf('UTC')).toBe('20:00:00');

    fireEvent.change(slider, { target: { value: '-4' } });
    expect(timeOf('UTC')).toBe('19:00');
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    expect(timeOf('UTC')).toBe('20:00:00');
    expect(screen.queryByText('Planning:')).not.toBeInTheDocument();
  });

  it('removes a zone and persists it', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Remove UTC' }));
    expect(document.querySelector('.tzc-card[data-zone="UTC"]')).toBeNull();
    expect(lastSaved().targetZones).toEqual(['UTC+05:45']);
    expect(screen.getByRole('status')).toHaveTextContent('Removed UTC.');
  });

  it('makes a zone home and keeps the old home on the board', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Make UTC+05:45 home' }));
    const saved = lastSaved();
    expect(saved.homeZone).toBe('UTC+05:45');
    expect(saved.targetZones).toEqual(['UTC-08:00', 'UTC+05:45', 'UTC']);
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.tzc-card')).map((c) => c.dataset.zone);
    expect(cards).toEqual(['UTC+05:45', 'UTC-08:00', 'UTC']);
    expect(within(card('UTC-08:00')).getByText('−13h 45m')).toBeInTheDocument();
  });

  it('reorders with Alt+arrow keys and with arrows on the handle', async () => {
    await mount();
    fireEvent.keyDown(card('UTC+05:45'), { key: 'ArrowDown', altKey: true });
    expect(lastSaved().targetZones).toEqual(['UTC', 'UTC+05:45']);
    expect(Array.from(document.querySelectorAll<HTMLElement>('.tzc-card')).map((c) => c.dataset.zone)).toEqual([
      'UTC-08:00',
      'UTC',
      'UTC+05:45',
    ]);

    const handle = within(card('UTC+05:45')).getByRole('button', { name: /^Reorder UTC\+05:45/ });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(lastSaved().targetZones).toEqual(['UTC+05:45', 'UTC']);
    // Already first: no further save.
    const count = chromeMock().storage.sync.set.mock.calls.length;
    fireEvent.keyDown(within(card('UTC+05:45')).getByRole('button', { name: /^Reorder/ }), { key: 'ArrowUp' });
    expect(chromeMock().storage.sync.set.mock.calls.length).toBe(count);
    // The home card is not movable.
    expect(within(card('UTC-08:00')).queryByRole('button', { name: /Reorder|Remove|Make/ })).toBeNull();
  });

  it('toggles 12/24-hour and persists it', async () => {
    await mount();
    const btn12 = screen.getByRole('button', { name: '12h' });
    expect(btn12).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn12);
    expect(lastSaved().hour12).toBe(true);
    expect(btn12).toHaveAttribute('aria-pressed', 'true');
    expect(timeOf('UTC')).toBe('8:00:00PM');
    expect(timeOf('UTC-08:00')).toBe('12:00:00PM');
  });

  it('changes theme through preferences', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(lastSaved().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('shows an empty state when there are no other zones', async () => {
    await mount({ ...base, targetZones: [] });
    expect(document.querySelectorAll('.tzc-card')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'No other timezones yet' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a timezone' }));
    expect(screen.getByRole('combobox', { name: 'Add a timezone' })).toHaveFocus();
  });

  it('follows preference changes made elsewhere', async () => {
    await mount();
    const listener = chromeMock().storage.onChanged.addListener.mock.calls[0]?.[0] as
      | ((changes: Record<string, { newValue: unknown }>, area: string) => void)
      | undefined;
    expect(listener).toBeTypeOf('function');
    act(() => {
      listener?.({ [KEY]: { newValue: { ...base, targetZones: ['abbr:PDT'] } } }, 'sync');
    });
    const zones = Array.from(document.querySelectorAll<HTMLElement>('.tzc-card')).map((c) => c.dataset.zone);
    expect(zones).toEqual(['UTC-08:00', 'abbr:PDT']);
    expect(within(card('abbr:PDT')).getByRole('heading', { level: 3 })).toHaveTextContent('PDT');
    expect(within(card('abbr:PDT')).getByText('+1h')).toBeInTheDocument();
  });
});

describe('clock model', () => {
  it('formats differences', () => {
    expect(formatDiff(0)).toBeNull();
    expect(formatDiff(345)).toBe('+5h 45m');
    expect(formatDiff(-540)).toBe('−9h');
    expect(formatDiff(-30)).toBe('−30m');
  });

  it('plans from the current quarter hour', () => {
    const t = Date.UTC(2024, 0, 2, 20, 7, 31);
    expect(shownInstant(t, 0)).toBe(t);
    expect(shownInstant(t, 2)).toBe(Date.UTC(2024, 0, 2, 20, 30));
    expect(shownInstant(t, -1)).toBe(Date.UTC(2024, 0, 2, 19, 45));
  });

  it('classifies day phase and working hours', () => {
    expect(dayPhase(3)).toBe('night');
    expect(dayPhase(6.5)).toBe('dawn');
    expect(dayPhase(12)).toBe('day');
    expect(dayPhase(19)).toBe('dusk');
    expect(dayPhase(20)).toBe('night');
    expect(workStatus(9, 0, 2).state).toBe('work');
    expect(workStatus(17, 59, 2).state).toBe('work');
    expect(workStatus(18, 0, 2).state).toBe('edge');
    expect(workStatus(8, 0, 2).state).toBe('edge');
    expect(workStatus(23, 0, 2).state).toBe('off');
    expect(workStatus(12, 0, 6).text).toBe('Weekend');
  });

  it('computes relative day against home', () => {
    expect(relativeDay(NOW, 'UTC+05:45', 'UTC-08:00')).toBe('Tomorrow');
    expect(relativeDay(NOW, 'UTC-08:00', 'UTC+05:45')).toBe('Yesterday');
    expect(relativeDay(NOW, 'UTC', 'UTC-08:00')).toBe('Today');
  });

  it('writes a new order back without losing home entries', () => {
    expect(applyOrder(['UTC', 'Asia/Tokyo', 'Europe/Paris'], 'UTC', ['Europe/Paris', 'Asia/Tokyo'])).toEqual([
      'UTC',
      'Europe/Paris',
      'Asia/Tokyo',
    ]);
  });

  it('make home is a no-op for the current home', () => {
    expect(makeHome(base, 'UTC-08:00')).toBe(base);
    expect(makeHome(base, 'UTC').targetZones).toEqual(['UTC+05:45', 'UTC-08:00', 'UTC']);
  });
});
