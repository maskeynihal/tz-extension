import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import { minutesFromNow, shownInstant } from '../src/clock/model';
import { EpochTab, epochErrorText } from '../src/popup/EpochTab';
import { parseEpoch } from '../src/lib/epoch';
import { EPOCH_INPUT_HINT, readEpochInput } from '../site/convert';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';

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

function timeOf(zone: string): string {
  return document.querySelector(`.tzc-card[data-zone="${zone}"] .tzc-time`)?.textContent ?? '';
}

function planChip(): HTMLElement | null {
  return screen.queryByText('Planning:')?.parentElement ?? null;
}

describe('world clock planner (QA #8)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Escape returns to now from a focused preset button', async () => {
    await mountClock();
    const ahead = screen.getByRole('button', { name: 'Plan 12 hours ahead' });
    ahead.focus();
    fireEvent.keyDown(ahead, { key: 'Enter' });
    fireEvent.click(ahead);
    expect(planChip()).not.toBeNull();
    fireEvent.keyDown(ahead, { key: 'Escape' });
    expect(planChip()).toBeNull();
    expect((screen.getByLabelText('Shift all clocks') as HTMLInputElement).value).toBe('0');
    expect(timeOf('UTC')).toBe('12:43:20');
  });

  it('Escape returns to now from the slider and the Now button too', async () => {
    await mountClock();
    const slider = screen.getByLabelText('Shift all clocks');
    fireEvent.change(slider, { target: { value: '8' } });
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(planChip()).toBeNull();

    fireEvent.change(slider, { target: { value: '8' } });
    const nowBtn = screen.getByRole('button', { name: 'Back to now' });
    fireEvent.keyDown(nowBtn, { key: 'Escape' });
    expect(planChip()).toBeNull();
  });

  it('Escape outside the planner does not touch the plan', async () => {
    await mountClock();
    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours ahead' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(planChip()).not.toBeNull();
  });

  it('presets are exact: +24h from 12:43 plans 12:43 tomorrow and says +24h', async () => {
    await mountClock();
    const btn = screen.getByRole('button', { name: 'Plan 24 hours ahead' });
    fireEvent.click(btn);
    expect(timeOf('UTC')).toBe('12:43');
    expect(planChip()).toHaveTextContent(/Wed 12:43 in UTC/);
    expect(planChip()).toHaveTextContent('+24h from now');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Shift all clocks')).toHaveAttribute(
      'aria-valuetext',
      expect.stringMatching(/Wed 12:43 in UTC, \+24h from now$/),
    );

    // It follows the clock minute by minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(timeOf('UTC')).toBe('12:44');

    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours back' }));
    expect(timeOf('UTC')).toBe('06:44');
    expect(planChip()).toHaveTextContent('−6h from now');
  });

  it('the slider still snaps to quarter hours and reports the real distance', async () => {
    await mountClock();
    const slider = screen.getByLabelText('Shift all clocks');
    fireEvent.change(slider, { target: { value: '96' } });
    expect(timeOf('UTC')).toBe('12:30');
    expect(planChip()).toHaveTextContent('+23h 47m from now');
    // Not the exact preset, so the +24h preset is not shown as pressed.
    expect(screen.getByRole('button', { name: 'Plan 24 hours ahead' })).toHaveAttribute('aria-pressed', 'false');

    // From an exact preset, an arrow-key move snaps again.
    fireEvent.click(screen.getByRole('button', { name: 'Plan 24 hours ahead' }));
    fireEvent.change(slider, { target: { value: '97' } });
    expect(timeOf('UTC')).toBe('12:45');
    expect(planChip()).toHaveTextContent('+24h 2m from now');
  });

  it('model: exact and snapped instants', () => {
    expect(shownInstant(NOW, 96, true)).toBe(Date.UTC(2024, 0, 3, 12, 43));
    expect(shownInstant(NOW, 96)).toBe(Date.UTC(2024, 0, 3, 12, 30));
    expect(shownInstant(NOW, 0, true)).toBe(NOW);
    expect(minutesFromNow(NOW, 96, true)).toBe(24 * 60);
    expect(minutesFromNow(NOW, 96)).toBe(24 * 60 - 13);
    expect(minutesFromNow(NOW, 1)).toBe(2);
    // One step back from 12:43 is 12:15 (the quarter hour, then 15 minutes).
    expect(minutesFromNow(NOW, -1)).toBe(-28);
    expect(minutesFromNow(NOW, 0)).toBe(0);
  });
});

// --- Epoch hints (QA #4) ---

const MIN_S = -2208988800; // 1900-01-01T00:00:00Z
const MAX_S = 253402300799; // 9999-12-31T23:59:59Z

describe('epoch hints state the real accepted range (QA #4)', () => {
  it('every claim in the hints holds for parseEpoch', () => {
    // 1900-01-01 … 9999-12-31 UTC, both ends included.
    expect(parseEpoch(String(MIN_S))?.epochMs).toBe(Date.UTC(1900, 0, 1));
    expect(parseEpoch(String(MIN_S - 1))).toBeNull();
    expect(parseEpoch(String(MAX_S * 1000))?.epochMs).toBe(Date.UTC(9999, 11, 31, 23, 59, 59));
    // The last millisecond of 9999 is still in range.
    expect(parseEpoch(String(MAX_S * 1000 + 999))?.unit).toBe('milliseconds');
    expect(parseEpoch(String(MAX_S * 1000 + 1000))).toBeNull();
    expect(parseEpoch(String(MAX_S), 'seconds')?.epochMs).toBe(MAX_S * 1000);
    expect(parseEpoch(String(MAX_S + 1), 'seconds')).toBeNull();
    expect(parseEpoch(String(MIN_S * 1000), 'milliseconds')?.epochMs).toBe(MIN_S * 1000);
    expect(parseEpoch(String(MIN_S * 1000 - 1), 'milliseconds')).toBeNull();
    // Auto: up to 11 digits are seconds, 12 or more milliseconds.
    expect(parseEpoch('99999999999')?.unit).toBe('seconds');
    expect(parseEpoch('-2208988800')?.unit).toBe('seconds');
    expect(parseEpoch('100000000000')?.unit).toBe('milliseconds');
    // Whole numbers only.
    expect(parseEpoch('1.5')).toBeNull();
  });

  it('popup error texts', () => {
    expect(epochErrorText('auto')).toBe(
      'Enter a valid epoch: a whole number for a time from 1900-01-01 to 9999-12-31 UTC. Auto reads up to 11 digits as seconds and 12 or more as milliseconds; pick a unit to change that.',
    );
    expect(epochErrorText('seconds')).toBe('Enter a valid epoch: a whole number of seconds for a time from 1900-01-01 to 9999-12-31 UTC.');
    expect(epochErrorText('milliseconds')).toBe(
      'Enter a valid epoch: a whole number of milliseconds for a time from 1900-01-01 to 9999-12-31 UTC.',
    );
    for (const m of ['auto', 'seconds', 'milliseconds'] as const) expect(epochErrorText(m)).not.toMatch(/1900–9999/);
  });

  it('the popup shows the error for a pre-1900 value and the unit-specific one when forced', () => {
    render(<EpochTab prefs={{ ...DEFAULT_PREFERENCES, targetZones: ['UTC'] }} />);
    const input = screen.getByLabelText('Unix epoch timestamp');
    fireEvent.change(input, { target: { value: String(MIN_S - 1) } });
    expect(screen.getByRole('alert')).toHaveTextContent(epochErrorText('auto'));
    fireEvent.change(input, { target: { value: String(MAX_S + 1) } });
    fireEvent.click(screen.getByRole('radio', { name: 'seconds' }));
    expect(screen.getByRole('alert')).toHaveTextContent(epochErrorText('seconds'));
    // 9999-12-31T23:59:59 is reachable as seconds once the unit is chosen.
    fireEvent.change(input, { target: { value: String(MAX_S) } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('9999-12-31T23:59:59.000Z')).toBeInTheDocument();
  });

  it('the website hint', () => {
    expect(EPOCH_INPUT_HINT).toBe(
      "That isn't a Unix timestamp we can read. Paste a whole number of seconds (up to 11 digits, like 1700000000) or milliseconds (12 or more digits) for a time from 1900-01-01 to 9999-12-31 UTC; negative values count back from 1970.",
    );
    expect(EPOCH_INPUT_HINT).not.toMatch(/work too/);
    expect(readEpochInput(String(MIN_S))?.epochMs).toBe(Date.UTC(1900, 0, 1));
    expect(readEpochInput(String(MIN_S - 1))).toBeNull();
    expect(readEpochInput(String(MAX_S * 1000))?.unit).toBe('milliseconds');
  });
});

// Last: importing the website entry opts this module graph into web storage.
describe('website converter page shows the range hint', () => {
  it('on a pre-1900 epoch', async () => {
    localStorage.clear();
    const host = document.createElement('div');
    host.id = 'demo-app';
    document.body.append(host);
    await act(async () => {
      await import('../site/demo');
    });
    await waitFor(() => expect(host.querySelector('.demo-rows')).not.toBeNull());
    fireEvent.click(within(host).getByRole('button', { name: 'Epoch' }));
    const input = within(host).getByLabelText('Time to convert') as HTMLInputElement;
    const hint = host.querySelector('.demo-hint') as HTMLElement;
    input.value = String(MIN_S - 1);
    fireEvent.input(input);
    expect(hint.className).toContain('is-error');
    expect(hint.textContent).toBe(EPOCH_INPUT_HINT);
    input.value = String(MIN_S);
    fireEvent.input(input);
    expect(hint.textContent).toContain('1900-01-01T00:00:00.000Z');
  });
});
