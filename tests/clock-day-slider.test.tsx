import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import {
  LIVE,
  absolutePlan,
  daySlider,
  offsetPlan,
  planInstant,
  planMinutesFromNow,
  planSteps,
  retimePlan,
  shiftPlan,
  wallParts,
} from '../src/clock/model';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';
const Q = 15 * 60_000;

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
  storage: { sync: { set: ReturnType<typeof vi.fn> } };
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mount(prefs: Preferences = base): Promise<void> {
  await (globalThis as unknown as { chrome: StorageMock }).chrome.storage.sync.set({ [KEY]: prefs });
  render(<ClockApp />);
  await flush();
}

function card(zone: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.tzc-card[data-zone="${zone}"]`);
  if (!el) throw new Error(`no card for ${zone}`);
  return el;
}

const timeOf = (zone: string): string => card(zone).querySelector('.tzc-time')?.textContent ?? '';
const daySliderOf = (place: string): HTMLInputElement => screen.getByLabelText(`Time in ${place}`) as HTMLInputElement;
const mainSlider = (): HTMLInputElement => screen.getByLabelText('Shift all clocks') as HTMLInputElement;
const planChip = (): HTMLElement | null => screen.queryByText('Planning:')?.parentElement ?? null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('plan model: shifting from a pick', () => {
  const pick = Date.UTC(2024, 0, 20, 20, 0);

  it('a picked plan carries a scrubber shift, 0 by default', () => {
    expect(absolutePlan(pick)).toEqual({ kind: 'absolute', epochMs: pick, steps: 0 });
    expect(planInstant(NOW, absolutePlan(pick, 4))).toBe(pick + 4 * Q);
    expect(planSteps(absolutePlan(pick, -8))).toBe(-8);
    expect(planSteps(offsetPlan(12))).toBe(12);
    expect(planSteps(LIVE)).toBe(0);
  });

  it('shiftPlan counts from the pick when there is one, and from now otherwise', () => {
    expect(shiftPlan(absolutePlan(pick), 4)).toEqual(absolutePlan(pick, 4));
    // Shifting a pick back to 0 keeps the pick: it is not "live".
    expect(shiftPlan(absolutePlan(pick, 4), 0)).toEqual(absolutePlan(pick, 0));
    expect(shiftPlan(LIVE, 4)).toEqual(offsetPlan(4));
    expect(shiftPlan(offsetPlan(4), 0)).toBe(LIVE);
  });

  it('the distance from now includes the shift', () => {
    expect(planMinutesFromNow(NOW, absolutePlan(NOW + 60 * 60_000, 2))).toBe(90);
  });

  it('retimePlan keeps the pick when the target is whole steps away and in range', () => {
    expect(retimePlan(absolutePlan(pick, 1), pick + 3 * Q)).toEqual(absolutePlan(pick, 3));
    expect(retimePlan(absolutePlan(pick), pick - 48 * Q)).toEqual(absolutePlan(pick, -48));
    expect(retimePlan(absolutePlan(pick), pick + 144 * Q)).toEqual(absolutePlan(pick, 144));
  });

  it('retimePlan re-picks the target when it is out of range, off the grid, or from live', () => {
    expect(retimePlan(absolutePlan(pick), pick + 145 * Q)).toEqual(absolutePlan(pick + 145 * Q));
    expect(retimePlan(absolutePlan(pick), pick - 49 * Q)).toEqual(absolutePlan(pick - 49 * Q));
    expect(retimePlan(absolutePlan(pick + 7 * 60_000), pick + Q)).toEqual(absolutePlan(pick + Q));
    expect(retimePlan(LIVE, pick)).toEqual(absolutePlan(pick));
    expect(retimePlan(offsetPlan(8), pick)).toEqual(absolutePlan(pick));
  });
});

describe('plan model: a day slider counts real quarter hours from midnight', () => {
  it('an ordinary day has 96 steps, and the value floors to the quarter hour', () => {
    const d = daySlider(Date.UTC(2024, 0, 2, 20, 43), 'UTC');
    expect(d).toEqual({ startMs: Date.UTC(2024, 0, 2), max: 95, value: 82 });
  });

  it('a fixed offset starts at its own midnight', () => {
    const d = daySlider(NOW, 'UTC+05:45');
    // 01:45 Wed in UTC+05:45; its midnight is 18:15 UTC Tuesday.
    expect(d?.startMs).toBe(Date.UTC(2024, 0, 2, 18, 15));
    expect(d?.value).toBe(7);
  });

  it('New York spring-forward (2026-03-08) is 23 hours, and every step is a real instant', () => {
    const d = daySlider(Date.UTC(2026, 2, 8, 17, 0), 'America/New_York');
    expect(d?.startMs).toBe(Date.UTC(2026, 2, 8, 5, 0)); // 00:00 EST
    expect(d?.max).toBe(23 * 4 - 1);
    // Step 7 is 01:45 EST, step 8 is 03:00 EDT: no position lands in the gap,
    // and one arrow key crosses it in either direction.
    const at = (v: number): string => {
      const p = wallParts((d?.startMs ?? 0) + v * Q, 'America/New_York');
      return `${p.hour}:${String(p.minute).padStart(2, '0')}`;
    };
    expect(at(7)).toBe('1:45');
    expect(at(8)).toBe('3:00');
    // Going back from 03:00 lands on 01:45 and the slider reads back step 7.
    expect(daySlider((d?.startMs ?? 0) + 7 * Q, 'America/New_York')?.value).toBe(7);
  });

  it('New York fall-back (2026-11-01) is 25 hours, and the repeated hour is reachable twice', () => {
    const d = daySlider(Date.UTC(2026, 10, 1, 17, 0), 'America/New_York');
    expect(d?.startMs).toBe(Date.UTC(2026, 10, 1, 4, 0)); // 00:00 EDT
    expect(d?.max).toBe(25 * 4 - 1);
    const first = (d?.startMs ?? 0) + 6 * Q; // 01:30 EDT
    const second = (d?.startMs ?? 0) + 10 * Q; // 01:30 EST
    expect(wallParts(first, 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
    expect(wallParts(second, 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
    expect(second - first).toBe(60 * 60_000);
    expect(daySlider(second, 'America/New_York')?.value).toBe(10);
  });
});

describe('ClockApp: a slider on every card', () => {
  it('each card has its own slider at its own wall time', async () => {
    await mount();
    expect(daySliderOf('UTC').value).toBe(String(20 * 4));
    expect(daySliderOf('UTC').max).toBe('95');
    expect(daySliderOf('UTC-08:00').value).toBe(String(12 * 4));
    expect(daySliderOf('UTC').getAttribute('aria-valuetext')).toMatch(/^20:00, Tuesday/);
  });

  it('setting 17:00 on the UTC card plans 17:00 UTC, and every card follows', async () => {
    await mount();
    fireEvent.change(daySliderOf('UTC'), { target: { value: String(17 * 4) } });
    await flush();
    expect(timeOf('UTC')).toBe('17:00');
    expect(timeOf('UTC-08:00')).toBe('09:00');
    expect(timeOf('UTC+05:45')).toBe('22:45');
    expect(daySliderOf('UTC-08:00').value).toBe(String(9 * 4));
    expect(planChip()).toHaveTextContent('Tue, Jan 2 09:00 in UTC-08:00');
    // From live the target becomes the pick, so the main slider centres on it.
    expect(mainSlider().value).toBe('0');
    expect(screen.getByRole('button', { name: 'Plan the picked time' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the scenario from the request: pick 20:00 home, then fix it to 17:00 UTC', async () => {
    await mount();
    // 20:00 at home (UTC-08:00) on a later day is 04:00 UTC the next morning.
    fireEvent.click(document.querySelector<HTMLElement>('[data-dp-trigger]')!);
    fireEvent.click(document.querySelector<HTMLElement>('button[data-day="2024-01-22"]')!);
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await flush();
    expect(timeOf('UTC')).toBe('04:00');

    // The UTC card's day is Tue 23 Jan; 17:00 that day is 13 hours on, which
    // the main slider can reach, so it keeps the pick and moves with it.
    fireEvent.change(daySliderOf('UTC'), { target: { value: String(17 * 4) } });
    await flush();
    expect(timeOf('UTC')).toBe('17:00');
    expect(timeOf('UTC-08:00')).toBe('09:00');
    expect(mainSlider().value).toBe(String(13 * 4));
    expect(planChip()).toHaveTextContent('Tue, Jan 23 09:00 in UTC-08:00');

    // And the main slider moves the card sliders back.
    fireEvent.change(mainSlider(), { target: { value: '0' } });
    await flush();
    expect(timeOf('UTC')).toBe('04:00');
    expect(daySliderOf('UTC').value).toBe(String(4 * 4));
  });

  it('Page Up and Page Down on a card move an hour', async () => {
    await mount();
    fireEvent.keyDown(daySliderOf('UTC'), { key: 'PageUp' });
    await flush();
    expect(timeOf('UTC')).toBe('21:00');
    fireEvent.keyDown(daySliderOf('UTC'), { key: 'PageDown' });
    fireEvent.keyDown(daySliderOf('UTC'), { key: 'PageDown' });
    await flush();
    expect(timeOf('UTC')).toBe('19:00');
  });

  it('a home change keeps the shift counted from the pick', async () => {
    await mount();
    fireEvent.click(document.querySelector<HTMLElement>('[data-dp-trigger]')!);
    fireEvent.click(document.querySelector<HTMLElement>('button[data-day="2024-01-22"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await flush();
    fireEvent.change(mainSlider(), { target: { value: '4' } });
    await flush();
    expect(timeOf('UTC-08:00')).toBe('13:00');

    // UTC becomes home: the pick (12:00 on the 22nd) is re-read as UTC's wall
    // clock, and the +1 h shift is kept on top of it.
    fireEvent.click(screen.getByRole('button', { name: 'Make UTC home' }));
    await flush();
    expect(mainSlider().value).toBe('4');
    expect(timeOf('UTC')).toBe('13:00');
  });

  it('the main slider says which zone it is in', async () => {
    await mount();
    expect(screen.getByText('UTC-08:00 time (home)')).toBeInTheDocument();
    expect(mainSlider()).toHaveAccessibleDescription(/^UTC-08:00 time \(home\)/);
  });
});
