import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import {
  applyOrder,
  dayPhase,
  diffFromHome,
  formatDiff,
  makeHome,
  relativeDay,
  shownInstant,
  workStatus,
} from '../src/clock/model';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';
import * as model from '../src/clock/model';
import { fromSyncItems } from '../src/lib/storage';

// Pass-through spy on the one model call each ZoneCard render makes, to count card renders.
vi.mock('../src/clock/model', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/clock/model')>();
  return { ...real, workStatus: vi.fn(real.workStatus) };
});

const KEY = 'tz-extension-prefs';

// Tuesday 2 Jan 2024, 20:00:00 UTC. Home (UTC-08:00) is 12:00 Tue; UTC+05:45 is 01:45 Wed.
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

/**
 * The last preferences written through savePreferences, read back the way
 * storage does: the legacy item holds IANA zones only, the extras item the rest.
 */
function lastSaved(): Preferences {
  const calls = chromeMock().storage.sync.set.mock.calls;
  const last = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
  if (!last?.[KEY]) throw new Error('nothing saved');
  return fromSyncItems(last);
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
    expect(within(cards[0] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('UTC-08:00');
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
    expect(home.getByText('UTC-08:00', { selector: 'dd' })).toBeInTheDocument();
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
    expect(screen.getByText('Planning:').parentElement).toHaveTextContent(/Tue 14:00 in UTC-08:00/);
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Tue 14:00 in UTC-08:00'));

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

  it('offers both ways to plan, and each one takes over from the other', async () => {
    await mount();
    const picker = document.querySelector<HTMLElement>('[data-dp-trigger]');
    expect(picker).toHaveTextContent('Pick date & time');
    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;

    // The scrubber alone: the picker stays empty.
    fireEvent.change(slider, { target: { value: '8' } });
    expect(timeOf('UTC')).toBe('22:00');
    expect(picker).toHaveTextContent('Pick date & time');

    // A picked date the scrubber cannot reach, then the scrubber takes back over.
    fireEvent.click(picker!);
    fireEvent.click(document.querySelector<HTMLElement>('button[data-day="2024-01-22"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(timeOf('UTC-08:00')).toBe('12:00');
    expect(screen.getByText('Planning:').parentElement).toHaveTextContent(/Mon, Jan 22 12:00 in UTC-08:00/);
    // The slider counts from the pick: its centre is the picked time, and a
    // nudge shifts the pick rather than discarding it for "now + 15 min"
    // (the bug the slider was once locked to avoid).
    expect(slider.value).toBe('0');
    expect(slider).toBeEnabled();
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Mon, Jan 22 12:00 in UTC-08:00'));
    expect(screen.getByRole('button', { name: 'Plan the picked time' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(slider, { target: { value: '-4' } });
    expect(timeOf('UTC-08:00')).toBe('11:00');
    expect(screen.getByText('Planning:').parentElement).toHaveTextContent(/Mon, Jan 22 11:00 in UTC-08:00/);
    // The picker's trigger follows what the board shows.
    expect(picker).toHaveTextContent('Jan 22, 2024, 11:00');
    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours before the picked time' }));
    expect(timeOf('UTC-08:00')).toBe('06:00');
    fireEvent.click(screen.getByRole('button', { name: 'Plan the picked time' }));
    expect(timeOf('UTC-08:00')).toBe('12:00');

    // Back to now, and the presets count from now again.
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours back' }));
    expect(timeOf('UTC')).toBe('14:00');
    expect(picker).toHaveTextContent('Pick date & time');
    fireEvent.change(slider, { target: { value: '-4' } });
    expect(timeOf('UTC')).toBe('19:00');
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

  it('toggles 12/24-hour with a labelled segmented control and persists it', async () => {
    await mount();
    const group = screen.getByRole('group', { name: 'Clock format' });
    const btn12 = within(group).getByRole('button', { name: '12-hour clock' });
    const btn24 = within(group).getByRole('button', { name: '24-hour clock' });
    expect(btn12).toHaveTextContent('12h');
    expect(btn24).toHaveAttribute('aria-pressed', 'true');
    expect(btn12).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn12);
    expect(lastSaved().hour12).toBe(true);
    expect(btn12).toHaveAttribute('aria-pressed', 'true');
    expect(btn24).toHaveAttribute('aria-pressed', 'false');
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

describe('ClockApp rendering cost', () => {
  it('measures card positions only when the order changes, not on each tick', async () => {
    await mount();
    const left = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get');
    const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get');
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3005);
      });
      expect(timeOf('UTC')).toBe('20:00:03');
      expect(left).not.toHaveBeenCalled();
      expect(top).not.toHaveBeenCalled();

      fireEvent.keyDown(card('UTC+05:45'), { key: 'ArrowDown', altKey: true });
      // One measurement of every card for the reorder's FLIP.
      expect(left).toHaveBeenCalledTimes(3);
      expect(top).toHaveBeenCalledTimes(3);
    } finally {
      left.mockRestore();
      top.mockRestore();
    }
  });

  it('cards re-render only when what they show changes', async () => {
    await mount();
    const renders = vi.mocked(model.workStatus);
    renders.mockClear();
    // Live: each card shows seconds, so each re-renders once per tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1005);
    });
    expect(renders).toHaveBeenCalledTimes(3);

    // Planning: the shown instant holds still, so ticks re-render no card.
    fireEvent.change(screen.getByLabelText('Shift all clocks'), { target: { value: '4' } });
    renders.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(renders).not.toHaveBeenCalled();

    // A change one card shows (12/24h) re-renders all of them, once.
    fireEvent.click(screen.getByRole('button', { name: '12-hour clock' }));
    expect(renders).toHaveBeenCalledTimes(3);
  });
});

describe('clock across DST transitions', () => {
  it('New York spring-forward (2026-03-08 07:00 UTC): diff and relative day', () => {
    const before = Date.UTC(2026, 2, 8, 6, 59); // 01:59 EST, 06:59 London
    const after = Date.UTC(2026, 2, 8, 7, 0); // 03:00 EDT, 07:00 London
    expect(diffFromHome(before, 'Europe/London', 'America/New_York')).toBe(300);
    expect(diffFromHome(after, 'Europe/London', 'America/New_York')).toBe(240);
    expect(relativeDay(before, 'Europe/London', 'America/New_York')).toBe('Today');
    // 23:30 EST on the 7th vs 04:30 on the 8th in London.
    expect(relativeDay(Date.UTC(2026, 2, 8, 4, 30), 'Europe/London', 'America/New_York')).toBe('Tomorrow');
    expect(relativeDay(Date.UTC(2026, 2, 8, 4, 30), 'America/New_York', 'Europe/London')).toBe('Yesterday');
  });

  it('London spring-forward (2026-03-29 01:00 UTC): diff and relative day', () => {
    const before = Date.UTC(2026, 2, 29, 0, 59); // 00:59 GMT, 20:59 EDT on the 28th
    const after = Date.UTC(2026, 2, 29, 1, 0); // 02:00 BST, 21:00 EDT on the 28th
    expect(diffFromHome(before, 'America/New_York', 'Europe/London')).toBe(-240);
    expect(diffFromHome(after, 'America/New_York', 'Europe/London')).toBe(-300);
    expect(diffFromHome(before, 'UTC', 'Europe/London')).toBe(0);
    expect(diffFromHome(after, 'UTC', 'Europe/London')).toBe(-60);
    expect(relativeDay(before, 'America/New_York', 'Europe/London')).toBe('Yesterday');
    expect(relativeDay(after, 'America/New_York', 'Europe/London')).toBe('Yesterday');
    // 23:30 UTC on the 28th is 23:30 GMT in London: same day.
    expect(relativeDay(Date.UTC(2026, 2, 28, 23, 30), 'UTC', 'Europe/London')).toBe('Today');
  });

  it('cards show the new gap right after the transition', async () => {
    vi.setSystemTime(Date.UTC(2026, 2, 29, 0, 59, 58));
    await mount({ ...base, homeZone: 'Europe/London', targetZones: ['America/New_York', 'UTC'] });
    expect(within(card('America/New_York')).getByText('−4h')).toBeInTheDocument();
    expect(within(card('America/New_York')).getByText('Yesterday')).toBeInTheDocument();
    expect(within(card('UTC')).getByText('same time')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2010);
    });
    expect(timeOf('Europe/London')).toBe('02:00:00');
    expect(within(card('America/New_York')).getByText('−5h')).toBeInTheDocument();
    expect(within(card('UTC')).getByText('−1h')).toBeInTheDocument();
    expect(within(card('UTC')).getByText('Today')).toBeInTheDocument();
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

describe('day tags while planning (site QA M1)', () => {
  it('count from home’s real today, not from home’s planned day', () => {
    // Home UTC-08:00 is Tue 12:00 at NOW. +18h is Wed 06:00 at home.
    const today = model.homeDayNumber(NOW, 'UTC-08:00');
    const plan = NOW + 18 * 3_600_000;
    expect(relativeDay(plan, 'UTC-08:00', 'UTC-08:00', today)).toBe('Tomorrow');
    // UTC is Wed 14:00 then. At +36h (Thu 00:00 at home) home is two days on.
    expect(relativeDay(plan, 'UTC', 'UTC-08:00', today)).toBe('Tomorrow');
    expect(relativeDay(NOW + 36 * 3_600_000, 'UTC-08:00', 'UTC-08:00', today)).toBe('In 2 days');
    // −12h: home Tue 00:00 is still today; UTC-11 would be Mon.
    expect(relativeDay(NOW - 12 * 3_600_000, 'UTC-11:00', 'UTC-08:00', today)).toBe('Yesterday');
    expect(relativeDay(NOW - 36 * 3_600_000, 'UTC-11:00', 'UTC-08:00', today)).toBe('2 days ago');
    // Live, the default is home's day at that instant, as before.
    expect(relativeDay(NOW, 'UTC+05:45', 'UTC-08:00')).toBe('Tomorrow');
  });

  it('a +18h plan tags the home card Tomorrow, +36h In 2 days, and Now goes back to Today', async () => {
    await mount();
    expect(within(card('UTC-08:00')).getByText('Today')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Shift all clocks'), { target: { value: '72' } }); // +18h
    expect(within(card('UTC-08:00')).getByText('Tomorrow')).toBeInTheDocument();
    expect(within(card('UTC')).getByText('Tomorrow')).toBeInTheDocument();
    expect(within(card('UTC+05:45')).getByText('Tomorrow')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Shift all clocks'), { target: { value: '144' } }); // +36h
    expect(within(card('UTC-08:00')).getByText('In 2 days')).toBeInTheDocument();
    expect(within(card('UTC+05:45')).getByText('In 2 days')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Shift all clocks'), { target: { value: '0' } });
    expect(within(card('UTC-08:00')).getByText('Today')).toBeInTheDocument();
    expect(within(card('UTC')).getByText('Today')).toBeInTheDocument();
  });
});
