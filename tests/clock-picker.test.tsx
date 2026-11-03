import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';

// Tuesday 2 Jan 2024, 20:00:00 UTC. Home (UTC-08:00) is 12:00 Tue.
const NOW = Date.UTC(2024, 0, 2, 20, 0, 0);

const base: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'UTC-08:00',
  targetZones: ['UTC+05:45', 'UTC'],
  hour12: false,
  theme: 'system',
};

interface StorageMock {
  storage: { sync: { set: (items: Record<string, unknown>) => Promise<void> } };
}

function chromeMock(): StorageMock {
  return (globalThis as unknown as { chrome: StorageMock }).chrome;
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function mount(prefs: Preferences = base): Promise<void> {
  await chromeMock().storage.sync.set({ [KEY]: prefs });
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

function dayTagOf(zone: string): string {
  return card(zone).querySelector('.tzc-day')?.textContent ?? '';
}

/**
 * The trigger, found by its attribute: its label is a date formatted in the
 * reader's locale, so the text is not a stable handle.
 */
function trigger(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-dp-trigger]');
  if (!el) throw new Error('no picker trigger');
  return el;
}

function popover(): HTMLElement {
  return screen.getByRole('dialog', { name: /^Pick a date and time in / });
}

/** The day button for an ISO date, e.g. "2024-01-17". */
function day(iso: string): HTMLElement {
  const el = popover().querySelector<HTMLElement>(`button[data-day="${iso}"]`);
  if (!el) throw new Error(`no day cell for ${iso}`);
  return el;
}

function planChip(): HTMLElement | null {
  return screen.queryByText('Planning:')?.parentElement ?? null;
}

async function open(): Promise<void> {
  fireEvent.click(trigger());
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('date & time picker: opening and the calendar grid', () => {
  it('is a closed popover until the trigger is pressed, and announces its state', async () => {
    await mount();
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).toBeNull();

    await open();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(popover()).toBeInTheDocument();
    // Named for the home zone, so it is clear which wall clock is being picked.
    expect(popover()).toHaveAccessibleName('Pick a date and time in UTC-08:00');
  });

  it('opens on home’s current month with today marked and selected', async () => {
    await mount();
    await open();
    expect(within(popover()).getByText('January 2024')).toBeInTheDocument();
    expect(day('2024-01-02')).toHaveAttribute('aria-current', 'date');
    expect(day('2024-01-02').className).toContain('is-selected');
    // One tab stop in the grid, on the selected day.
    expect(day('2024-01-02')).toHaveAttribute('tabindex', '0');
    expect(day('2024-01-10')).toHaveAttribute('tabindex', '-1');
    // The selected day's cell carries the ARIA selection.
    expect(day('2024-01-02').closest('[role="gridcell"]')).toHaveAttribute('aria-selected', 'true');
  });

  it('seeds the month from home’s day, not the browser’s', async () => {
    // 20:00 UTC on 2 Jan is already 01:45 on the 3rd at UTC+05:45.
    await mount({ ...base, homeZone: 'UTC+05:45', targetZones: ['UTC'] });
    await open();
    expect(day('2024-01-03').className).toContain('is-selected');
  });

  it('lays out weekday headers and the right month lengths, including a leap February', async () => {
    await mount();
    await open();
    const grid = within(popover()).getByRole('grid');
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(7);
    expect(within(grid).getByRole('columnheader', { name: 'Sunday' })).toBeInTheDocument();
    expect(within(grid).getByRole('columnheader', { name: 'Saturday' })).toBeInTheDocument();
    expect(grid.querySelectorAll('button[data-day]')).toHaveLength(31);

    const next = within(popover()).getByRole('button', { name: 'Next month' });
    fireEvent.click(next);
    expect(within(popover()).getByText('February 2024')).toBeInTheDocument();
    expect(popover().querySelectorAll('button[data-day]')).toHaveLength(29);
    expect(day('2024-02-29')).toBeInTheDocument();

    fireEvent.click(within(popover()).getByRole('button', { name: 'Previous month' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Previous month' }));
    expect(within(popover()).getByText('December 2023')).toBeInTheDocument();
    expect(popover().querySelectorAll('button[data-day]')).toHaveLength(31);
  });
});

describe('date & time picker: picking a time', () => {
  it('applies a picked date to every card, with day tags from home’s real today', async () => {
    await mount();
    expect(dayTagOf('UTC-08:00')).toBe('Today');
    await open();
    fireEvent.click(day('2024-01-05'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '9' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();

    // 09:30 at home (UTC-08:00) is 17:30 UTC and 23:15 at UTC+05:45.
    expect(timeOf('UTC-08:00')).toBe('09:30');
    expect(timeOf('UTC')).toBe('17:30');
    expect(timeOf('UTC+05:45')).toBe('23:15');
    expect(dayTagOf('UTC-08:00')).toBe('In 3 days');
    expect(dayTagOf('UTC')).toBe('In 3 days');
    // The popover closes and the trigger shows what is planned.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveTextContent('Jan 5, 2024, 09:30');
  });

  it('names the planned date and its real distance in the chip, in days when far out', async () => {
    await mount();
    await open();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(day('2024-02-29'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '14' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();

    // Noon Tue 2 Jan to 14:00 Thu 29 Feb at home: 58 days and 2 hours.
    expect(planChip()).toHaveTextContent('Thu, Feb 29 14:00 in UTC-08:00');
    expect(planChip()).toHaveTextContent('+58d 2h from now');
    expect(timeOf('UTC-08:00')).toBe('14:00');
  });

  it('holds the planned instant still as the clock ticks', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-09'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    const before = timeOf('UTC');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5005);
    });
    expect(timeOf('UTC')).toBe(before);
    // Still five seconds closer, measured from the current minute.
    expect(planChip()).toHaveTextContent('+7d from now');
  });

  it('honours the 12-hour preference in the time field and the trigger', async () => {
    await mount({ ...base, hour12: true });
    await open();
    const hour = within(popover()).getByLabelText('Hour') as HTMLInputElement;
    // Noon at home reads as 12 with PM pressed, not 12 on a 24-hour dial.
    expect(hour.value).toBe('12');
    expect(hour).toHaveAttribute('max', '12');
    expect(hour).toHaveAttribute('min', '1');
    const mer = within(popover()).getByRole('group', { name: 'AM or PM' });
    expect(within(mer).getByRole('button', { name: 'PM' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(hour, { target: { value: '7' } });
    fireEvent.click(within(mer).getByRole('button', { name: 'AM' }));
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '45' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(timeOf('UTC-08:00')).toBe('7:45AM');
    expect(trigger()).toHaveTextContent('Jan 2, 2024, 7:45 AM');
  });

  it('shows a 24-hour time field when the 24-hour clock is chosen, and no AM/PM', async () => {
    await mount();
    await open();
    const hour = within(popover()).getByLabelText('Hour') as HTMLInputElement;
    expect(hour.value).toBe('12');
    expect(hour).toHaveAttribute('max', '23');
    expect(hour).toHaveAttribute('min', '0');
    expect(within(popover()).queryByRole('group', { name: 'AM or PM' })).toBeNull();
    fireEvent.change(hour, { target: { value: '19' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(timeOf('UTC-08:00')).toBe('19:00');
  });

  it('switching the clock format while open rewrites the hour field', async () => {
    await mount();
    await open();
    expect((within(popover()).getByLabelText('Hour') as HTMLInputElement).value).toBe('12');
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '19' } });
    fireEvent.click(screen.getByRole('button', { name: '12-hour clock' }));
    await flush();
    expect((within(popover()).getByLabelText('Hour') as HTMLInputElement).value).toBe('7');
    expect(within(popover()).getByRole('button', { name: 'PM' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('applying the current minute plans it without an empty distance', async () => {
    await mount();
    await open();
    // Nothing changed: the pick is home's current minute, zero away from now.
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(planChip()).toHaveTextContent('Tue, Jan 2 12:00 in UTC-08:00');
    expect(planChip()?.textContent).not.toContain('from now');
    // The slider counts from the pick, so at its centre it announces the
    // pick itself.
    const slider = screen.getByLabelText('Shift all clocks');
    expect(slider).toHaveAttribute('aria-valuetext', 'Tue, Jan 2 12:00 in UTC-08:00');
    expect((slider as HTMLInputElement).value).toBe('0');
  });

  it('marks an out-of-range or empty time invalid and will not apply it', async () => {
    await mount();
    await open();
    const hour = within(popover()).getByLabelText('Hour') as HTMLInputElement;
    const minute = within(popover()).getByLabelText('Minute') as HTMLInputElement;
    const apply = within(popover()).getByRole('button', { name: 'Apply' });
    expect(apply).toBeEnabled();

    fireEvent.change(hour, { target: { value: '31' } });
    fireEvent.change(minute, { target: { value: '99' } });
    // The fields say so, and Apply cannot plan the value they no longer show.
    expect(hour).toHaveAttribute('aria-invalid', 'true');
    expect(minute).toHaveAttribute('aria-invalid', 'true');
    expect(apply).toBeDisabled();
    expect(within(popover()).getByRole('alert')).toHaveTextContent(
      'Enter an hour from 0 to 23 and a minute from 0 to 59.',
    );
    fireEvent.click(apply);
    await flush();
    // Nothing was planned at all: the clocks are still live, seconds and all.
    expect(planChip()).toBeNull();
    expect(timeOf('UTC-08:00')).toBe('12:00:00');

    // A readable value clears it, and Apply plans what the fields now show.
    fireEvent.change(hour, { target: { value: '9' } });
    fireEvent.change(minute, { target: { value: '30' } });
    expect(hour).not.toHaveAttribute('aria-invalid');
    expect(within(popover()).queryByRole('alert')).toBeNull();
    expect(within(popover()).getByRole('button', { name: 'Apply' })).toBeEnabled();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(timeOf('UTC-08:00')).toBe('09:30');
  });

  it('refuses a non-integer hour, and an empty field, the same way', async () => {
    await mount();
    await open();
    const hour = within(popover()).getByLabelText('Hour') as HTMLInputElement;
    for (const bad of ['1.5', '-3', '', ' ']) {
      fireEvent.change(hour, { target: { value: bad } });
      expect(within(popover()).getByRole('button', { name: 'Apply' }), bad).toBeDisabled();
      expect(hour, bad).toHaveAttribute('aria-invalid', 'true');
    }
    // Leaving the field puts back the time the draft actually holds.
    fireEvent.blur(hour);
    expect(hour.value).toBe('12');
    expect(within(popover()).getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('labels the trigger from the instant the pick resolved to, never a wall time that never was', async () => {
    await mount({ ...base, homeZone: 'America/New_York', targetZones: ['UTC'] });
    await open();
    for (let i = 0; i < 2; i += 1) fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(day('2024-03-10'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '2' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    // 02:30 does not exist on 10 Mar in New York; every card shows 03:30, and
    // the trigger is the one surface that used to keep claiming 02:30.
    expect(timeOf('America/New_York')).toBe('03:30');
    expect(trigger()).toHaveTextContent('Mar 10, 2024, 03:30');
    expect(trigger()).not.toHaveTextContent('02:30');
  });
});

describe('date & time picker: a home-zone change under an applied pick', () => {
  it('re-reads the picked date and time against the new home, and says it did', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-05'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '9' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    // 09:30 at UTC-08:00 is 17:30 UTC.
    expect(timeOf('UTC')).toBe('17:30');

    fireEvent.click(screen.getByRole('button', { name: 'Make UTC+05:45 home' }));
    await flush();
    // The written date and time is what was chosen, so it is what is kept:
    // 09:30 on 5 Jan, now read on the new home's wall clock (03:45 UTC). The
    // board used to sit on the old instant while the trigger and the DST note
    // described the new zone.
    expect(timeOf('UTC+05:45')).toBe('09:30');
    expect(timeOf('UTC')).toBe('03:45');
    expect(trigger()).toHaveTextContent('Jan 5, 2024, 09:30');
    expect(planChip()).toHaveTextContent('Fri, Jan 5 09:30 in UTC+05:45');
    expect(screen.getByRole('status')).toHaveTextContent(
      "Home is now UTC+05:45; the planned time is now read as UTC+05:45's wall clock.",
    );
  });

  it('leaves a live board alone when home changes', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Make UTC+05:45 home' }));
    await flush();
    expect(planChip()).toBeNull();
    expect(timeOf('UTC')).toBe('20:00:00');
  });
});

describe('date & time picker: returning to live', () => {
  it('Clear returns to live and empties the trigger', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(planChip()).not.toBeNull();

    await open();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Clear' }));
    await flush();
    expect(planChip()).toBeNull();
    expect(timeOf('UTC')).toBe('20:00:00');
    expect(trigger()).toHaveTextContent('Pick date & time');
  });

  it('“Back to now” clears a picked plan too', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    await flush();
    expect(planChip()).toBeNull();
    expect(timeOf('UTC')).toBe('20:00:00');
    expect(trigger()).toHaveTextContent('Pick date & time');
  });

  it('moves the scrubber from a picked plan instead of discarding it', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    // The centre preset is the pick now, and it is the one pressed.
    expect(screen.getByRole('button', { name: 'Plan the picked time' })).toHaveAttribute('aria-pressed', 'true');

    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;
    expect(slider).toBeEnabled();
    expect(slider.value).toBe('0');
    expect(slider).toHaveAccessibleDescription(/UTC-08:00 time \(home\).*Counting from the picked time/);

    // A quarter hour on from the pick, nine days out — not from now.
    fireEvent.change(slider, { target: { value: '1' } });
    await flush();
    expect(planChip()).toHaveTextContent('Sat, Jan 20 12:15 in UTC-08:00');
    expect(trigger()).toHaveTextContent('Jan 20, 2024, 12:15');
    // Page Up and Home move from the pick too.
    fireEvent.keyDown(slider, { key: 'PageUp' });
    await flush();
    expect(planChip()).toHaveTextContent('Sat, Jan 20 13:15 in UTC-08:00');
    fireEvent.keyDown(slider, { key: 'Home' });
    await flush();
    expect(planChip()).toHaveTextContent('Sat, Jan 20 00:00 in UTC-08:00');
    expect(slider.value).toBe('-48');
  });

  it('jump presets count from the pick; after Now they count from now again', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours after the picked time' }));
    await flush();
    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;
    expect(slider.value).toBe('24');
    expect(timeOf('UTC-08:00')).toBe('18:00');
    expect(trigger()).toHaveTextContent('Jan 20, 2024, 18:00');
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Sat, Jan 20 18:00 in UTC-08:00'));

    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours ahead' }));
    await flush();
    expect(slider.value).toBe('24');
    expect(timeOf('UTC')).toBe('02:00');
    expect(trigger()).toHaveTextContent('Pick date & time');
  });

  it('Escape dismisses the popover and keeps an applied plan, leaving focus on the trigger', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(planChip()).not.toBeNull();

    // Opening the picker to look at a plan and pressing Escape must not wipe
    // it; clicking outside never did. Clearing is Clear's job, and Now's.
    await open();
    fireEvent.keyDown(popover(), { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(planChip()).toHaveTextContent('Sat, Jan 20 12:00 in UTC-08:00');
    expect(timeOf('UTC-08:00')).toBe('12:00');

    // The planner's own Escape still returns to now, from its own controls.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to now' }), { key: 'Escape' });
    await flush();
    expect(planChip()).toBeNull();
    expect(timeOf('UTC')).toBe('20:00:00');
  });

  it('Escape on a popover with a draft drops the draft and nothing else', async () => {
    await mount();
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.keyDown(popover(), { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing was applied, so the clocks are live, and the draft is gone:
    // reopening seeds from home's today again.
    expect(planChip()).toBeNull();
    expect(timeOf('UTC')).toBe('20:00:00');
    await open();
    expect(day('2024-01-02').className).toContain('is-selected');
  });

  it('the picker’s hint says what Escape does, and the planner’s says where it works', async () => {
    await mount();
    await open();
    expect(within(popover()).getByText(/Escape closes the picker\./)).toBeInTheDocument();
    expect(within(popover()).queryByText(/returns to now/)).toBeNull();
    fireEvent.keyDown(popover(), { key: 'Escape' });
    await flush();
    // The planner's Escape is scoped to the planner, and its copy says so.
    expect(screen.getByText(/Escape, while this planner has focus, returns to now\./)).toBeInTheDocument();
  });

  it('a click outside dismisses the popover', async () => {
    await mount();
    await open();
    fireEvent.pointerDown(document.body);
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('date & time picker: keyboard', () => {
  it('focuses the selected day on opening and moves by day and week with the arrows', async () => {
    await mount();
    await open();
    expect(day('2024-01-02')).toHaveFocus();

    fireEvent.keyDown(day('2024-01-02'), { key: 'ArrowRight' });
    await flush();
    expect(day('2024-01-03')).toHaveFocus();
    expect(day('2024-01-03').className).toContain('is-selected');

    fireEvent.keyDown(day('2024-01-03'), { key: 'ArrowDown' });
    await flush();
    expect(day('2024-01-10')).toHaveFocus();

    fireEvent.keyDown(day('2024-01-10'), { key: 'ArrowUp' });
    await flush();
    expect(day('2024-01-03')).toHaveFocus();

    fireEvent.keyDown(day('2024-01-03'), { key: 'ArrowLeft' });
    await flush();
    expect(day('2024-01-02')).toHaveFocus();
  });

  it('an arrow out of the month turns the page', async () => {
    await mount();
    await open();
    fireEvent.keyDown(day('2024-01-02'), { key: 'ArrowLeft' });
    fireEvent.keyDown(day('2024-01-01'), { key: 'ArrowLeft' });
    await flush();
    expect(within(popover()).getByText('December 2023')).toBeInTheDocument();
    expect(day('2023-12-31')).toHaveFocus();
    expect(day('2023-12-31').className).toContain('is-selected');
  });

  it('Page Up and Page Down move a month, clamping into a shorter one', async () => {
    await mount();
    await open();
    // 31 Jan has no counterpart in February: the pick lands on the 29th.
    fireEvent.keyDown(day('2024-01-02'), { key: 'End' });
    await flush();
    expect(day('2024-01-31')).toHaveFocus();
    fireEvent.keyDown(day('2024-01-31'), { key: 'PageDown' });
    await flush();
    expect(within(popover()).getByText('February 2024')).toBeInTheDocument();
    expect(day('2024-02-29')).toHaveFocus();
    fireEvent.keyDown(day('2024-02-29'), { key: 'PageUp' });
    await flush();
    expect(within(popover()).getByText('January 2024')).toBeInTheDocument();
    expect(day('2024-01-29')).toHaveFocus();
    fireEvent.keyDown(day('2024-01-29'), { key: 'Home' });
    await flush();
    expect(day('2024-01-01')).toHaveFocus();
  });

  it('keeps Tab inside the dialog, both ways round', async () => {
    await mount();
    await open();
    const pop = popover();
    const prevMonth = within(pop).getByRole('button', { name: 'Previous month' });
    const apply = within(pop).getByRole('button', { name: 'Apply' });

    // Tab off the last control used to leave the dialog open with focus on
    // the page behind it.
    apply.focus();
    fireEvent.keyDown(pop, { key: 'Tab' });
    expect(pop).toContainElement(document.activeElement as HTMLElement);
    expect(prevMonth).toHaveFocus();

    // And back round the other way.
    fireEvent.keyDown(pop, { key: 'Tab', shiftKey: true });
    expect(pop).toContainElement(document.activeElement as HTMLElement);
    expect(apply).toHaveFocus();

    // In between, Tab still walks the dialog's own controls in order, and
    // never through all 31 days.
    fireEvent.keyDown(pop, { key: 'Tab' });
    expect(prevMonth).toHaveFocus();
    fireEvent.keyDown(pop, { key: 'Tab' });
    expect(within(pop).getByRole('button', { name: 'Next month' })).toHaveFocus();
    fireEvent.keyDown(pop, { key: 'Tab' });
    expect(day('2024-01-02')).toHaveFocus();
    fireEvent.keyDown(pop, { key: 'Tab' });
    expect(within(pop).getByLabelText('Hour')).toHaveFocus();
  });

  it('Enter on a day picks it, and Apply plans it', async () => {
    await mount();
    await open();
    // A real button, so Enter fires its click.
    fireEvent.click(day('2024-01-18'));
    await flush();
    expect(day('2024-01-18').className).toContain('is-selected');
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(planChip()).toHaveTextContent('Thu, Jan 18 12:00 in UTC-08:00');
  });
});

describe('date & time picker: daylight saving', () => {
  const ny: Preferences = { ...base, homeZone: 'America/New_York', targetZones: ['UTC'] };

  it('a time in a spring-forward gap is shown after the jump, with the shared note', async () => {
    await mount(ny);
    await open();
    fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(day('2024-03-10'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '2' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();

    expect(timeOf('America/New_York')).toBe('03:30');
    expect(timeOf('UTC')).toBe('07:30');
    expect(
      screen.getByText(/02:30 doesn't exist on 10 Mar in New York \(clocks jump forward\); shown as 03:30\./),
    ).toBeInTheDocument();
  });

  it('a time in a fall-back overlap takes the earlier instant, with the shared note', async () => {
    await mount(ny);
    await open();
    for (let i = 0; i < 10; i += 1) fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(day('2024-11-03'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '1' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();

    expect(timeOf('America/New_York')).toBe('01:30');
    // The first 01:30 is still EDT, so 05:30 UTC.
    expect(timeOf('UTC')).toBe('05:30');
    expect(screen.getByText(/01:30 happens twice on 3 Nov in New York; showing the first \(EDT\)\./)).toBeInTheDocument();
  });

  it('no note for an ordinary time, and the note goes when the plan is cleared', async () => {
    await mount(ny);
    await open();
    fireEvent.click(day('2024-01-20'));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(screen.queryByText(/doesn't exist|happens twice/)).toBeNull();

    await open();
    for (let i = 0; i < 2; i += 1) fireEvent.click(within(popover()).getByRole('button', { name: 'Next month' }));
    fireEvent.click(day('2024-03-10'));
    fireEvent.change(within(popover()).getByLabelText('Hour'), { target: { value: '2' } });
    fireEvent.change(within(popover()).getByLabelText('Minute'), { target: { value: '30' } });
    fireEvent.click(within(popover()).getByRole('button', { name: 'Apply' }));
    await flush();
    expect(screen.getByText(/doesn't exist/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to now' }));
    await flush();
    expect(screen.queryByText(/doesn't exist/)).toBeNull();
  });
});
