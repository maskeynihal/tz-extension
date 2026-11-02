import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import { wallDate, zoneDescription } from '../src/clock/model';
import { EpochTab, wallInputSeconds } from '../src/popup/EpochTab';
import { viewInZone } from '../src/lib/tz';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';

function revInput(): HTMLInputElement {
  return screen.getByLabelText(/Reverse: date & time/) as HTMLInputElement;
}

/**
 * The field's value with seconds. The input normalises what it is given (as
 * browsers do: ":00" seconds dropped; jsdom also writes ".000"), so compare
 * the wall time it holds, not the spelling.
 */
function revValue(): string {
  const v = revInput().value.replace(/\.0+$/, '');
  return v.length === 16 ? `${v}:00` : v;
}

/** The reverse result's "seconds" value as a number. */
function revSeconds(): number {
  const row = screen.getByText('seconds', { selector: '.tzx-epoch-out .tzx-zone' }).parentElement;
  return Number(row?.querySelector('.tzx-time')?.textContent);
}

function revMillis(): number {
  const row = screen.getByText('milliseconds', { selector: '.tzx-epoch-out .tzx-zone' }).parentElement;
  return Number(row?.querySelector('.tzx-time')?.textContent);
}

const ktm: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'Asia/Kathmandu', targetZones: ['UTC'] };

// QA r4 #1: the reverse field was pre-filled with the browser's wall clock but
// read in the home zone, so its default epoch was off by the difference. Run
// this file with TZ=America/New_York too: the browser zone must not matter.
describe('Epoch tab reverse field (QA r4 #1)', () => {
  it('opens on now: the default result is the current epoch', () => {
    const before = Date.now();
    render(<EpochTab prefs={ktm} />);
    const after = Date.now();
    const s = revSeconds();
    expect(s).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(s).toBeLessThanOrEqual(Math.floor(after / 1000));
    expect(revMillis()).toBe(s * 1000);
  });

  it('is labelled with, pre-filled in and read in the home zone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.UTC(2024, 6, 15, 12, 0, 7, 450);
      vi.setSystemTime(now);
      render(<EpochTab prefs={ktm} />);
      expect(revInput().labels?.[0]).toHaveTextContent('Reverse: date & time → epoch (Asia/Kathmandu)');
      // 12:00:07Z is 17:45:07 in Kathmandu, whatever the browser's zone.
      expect(revValue()).toBe('2024-07-15T17:45:07');
      expect(revSeconds()).toBe(Math.floor(now / 1000));
      // A typed value is read as Kathmandu wall time too.
      fireEvent.change(revInput(), { target: { value: '2024-01-01T05:45:00' } });
      expect(revSeconds()).toBe(Date.UTC(2024, 0, 1) / 1000);
      // The input's normalised form may carry milliseconds; they count.
      fireEvent.change(revInput(), { target: { value: '2024-01-01T05:45:00.500' } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(revMillis()).toBe(Date.UTC(2024, 0, 1) + 500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Now" resets the field to the current time in the home zone', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2024, 6, 15, 12, 0, 0));
      render(<EpochTab prefs={ktm} />);
      fireEvent.change(revInput(), { target: { value: '1999-12-31T23:59:59' } });
      vi.setSystemTime(Date.UTC(2024, 6, 15, 12, 30, 9));
      fireEvent.click(screen.getByRole('button', { name: 'Now' }));
      expect(revValue()).toBe('2024-07-15T18:15:09');
      expect(revSeconds()).toBe(Date.UTC(2024, 6, 15, 12, 30, 9) / 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the instant when the home zone arrives after the first render', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.UTC(2024, 6, 15, 12, 0, 0);
      vi.setSystemTime(now);
      const { rerender } = render(<EpochTab prefs={{ ...ktm, homeZone: 'UTC' }} />);
      expect(revValue()).toBe('2024-07-15T12:00:00');
      rerender(<EpochTab prefs={ktm} />);
      expect(revValue()).toBe('2024-07-15T17:45:00');
      expect(revSeconds()).toBe(now / 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"now" in the second half of a fall-back overlap is the real now, not the earlier instant', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 06:30Z on 3 Nov 2024 is 01:30 EST, the second 01:30 in New York.
      const now = Date.UTC(2024, 10, 3, 6, 30, 0);
      vi.setSystemTime(now);
      render(<EpochTab prefs={{ ...ktm, homeZone: 'America/New_York' }} />);
      expect(revValue()).toBe('2024-11-03T01:30:00');
      expect(revSeconds()).toBe(now / 1000);
      // Typing the same wall time reads it as the first (EDT) one, with the note.
      fireEvent.change(revInput(), { target: { value: '2024-11-03T01:30:01' } });
      expect(revSeconds()).toBe(Date.UTC(2024, 10, 3, 5, 30, 1) / 1000);
      expect(screen.getByText(/happens twice/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wallInputSeconds writes the zone wall clock with seconds', () => {
    expect(wallInputSeconds(Date.UTC(2024, 0, 1, 0, 0, 5), 'Asia/Kathmandu')).toBe('2024-01-01T05:45:05');
    expect(wallInputSeconds(0, 'Not/AZone')).toBe('');
  });
});

// --- World clock (QA r4 #4–#7) ---

// Tuesday 2 Jan 2024, 12:43:20 UTC: not on a quarter hour.
const NOW = Date.UTC(2024, 0, 2, 12, 43, 20);

const clockPrefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'UTC',
  targetZones: ['UTC+05:45'],
  hour12: false,
  theme: 'system',
};

async function mountClock(prefs: Preferences = clockPrefs): Promise<void> {
  const chromeMock = (globalThis as unknown as { chrome: { storage: { sync: { set: (v: unknown) => Promise<void> } } } })
    .chrome;
  await chromeMock.storage.sync.set({ [KEY]: prefs });
  render(<ClockApp />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function card(zone: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.tzc-card[data-zone="${zone}"]`);
  if (!el) throw new Error(`no card for ${zone}`);
  return el;
}

function timeOf(zone: string): string {
  return card(zone).querySelector('.tzc-time')?.textContent ?? '';
}

function planChip(): HTMLElement | null {
  return screen.queryByText('Planning:')?.parentElement ?? null;
}

describe('world clock (QA r4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('#6: the card subtitle is the IANA id with its underscores', async () => {
    await mountClock({ ...clockPrefs, targetZones: ['America/St_Johns', 'America/New_York'] });
    expect(card('America/St_Johns').querySelector('.tzc-card-sub')).toHaveTextContent(/^America\/St_Johns$/);
    expect(card('America/New_York').querySelector('.tzc-card-sub')).toHaveTextContent(/^America\/New_York$/);
    expect(zoneDescription('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(zoneDescription('UTC')).toBe('Coordinated Universal Time');
  });

  it('#5: Home and End go to exactly −12h and +36h, like the presets', async () => {
    await mountClock();
    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.value).toBe('144');
    expect(planChip()).toHaveTextContent(/Thu 00:43 in UTC/);
    expect(planChip()).toHaveTextContent('+36h from now');
    expect(timeOf('UTC')).toMatch(/^00:43/);
    expect(screen.getByRole('button', { name: /36 hours ahead/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.value).toBe('-48');
    expect(planChip()).toHaveTextContent(/Tue 00:43 in UTC/);
    expect(planChip()).toHaveTextContent('−12h from now');
  });

  it('#5: dragging (or a page step) to an end is exact too; the middle still snaps', async () => {
    await mountClock();
    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '144' } });
    expect(planChip()).toHaveTextContent('+36h from now');
    fireEvent.change(slider, { target: { value: '-48' } });
    expect(planChip()).toHaveTextContent('−12h from now');
    fireEvent.change(slider, { target: { value: '140' } });
    expect(planChip()).toHaveTextContent('+34h 47m from now');
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(planChip()).toHaveTextContent('+36h from now');
  });

  it('#7: 1900 local mean time keeps its seconds', async () => {
    vi.setSystemTime(Date.UTC(1900, 0, 1, 0, 0, 0));
    await mountClock({ ...clockPrefs, targetZones: ['Asia/Kathmandu', 'America/St_Johns', 'Pacific/Kiritimati'] });
    for (const zone of ['Asia/Kathmandu', 'America/St_Johns', 'Pacific/Kiritimati']) {
      // The clock face agrees with the card and popup (viewInZone).
      expect(timeOf(zone)).toBe(viewInZone(Date.now(), zone, false).time);
    }
    expect(timeOf('Asia/Kathmandu')).toBe('05:41:16');
    expect(timeOf('America/St_Johns')).toBe('20:29:08');
  });
});

describe('wallDate', () => {
  it('is second-precise and keeps the milliseconds', () => {
    const ms = Date.UTC(1900, 0, 1, 0, 0, 0, 250);
    expect(wallDate(ms, 'Asia/Kathmandu').toISOString()).toBe('1900-01-01T05:41:16.250Z');
    expect(wallDate(Date.UTC(2024, 6, 1, 12), 'UTC+05:45').toISOString()).toBe('2024-07-01T17:45:00.000Z');
  });

  it('handles years before 100 without reading them as 19xx', () => {
    const d = wallDate(Date.UTC(2024, 0, 1) - 0, 'UTC');
    expect(d.getUTCFullYear()).toBe(2024);
    const early = new Date(0);
    early.setUTCFullYear(50, 0, 1);
    expect(wallDate(early.getTime(), 'UTC').getUTCFullYear()).toBe(50);
  });
});
