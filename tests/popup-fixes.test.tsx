import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Converter } from '../src/popup/Converter';
import { App } from '../src/popup/App';
import { DEFAULT_PREFERENCES, resolveLocalZone, type Preferences } from '../src/types';
import { viewInZone } from '../src/lib/tz';

// Tue 2 Jan 2024 20:00:30 UTC: 01:45 Wed in Kathmandu, 15:00 Tue in New York.
const NOW = Date.UTC(2024, 0, 2, 20, 0, 30);

const prefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'Asia/Kathmandu',
  targetZones: ['UTC', 'America/New_York'],
  hour12: false,
};

function input(): HTMLInputElement {
  return screen.getByLabelText('Date & time') as HTMLInputElement;
}

/** The big time on the result card for a target zone (cards follow prefs.targetZones). */
function resultTime(zone: string): string {
  const i = prefs.targetZones.indexOf(zone);
  const cardEl = document.querySelectorAll<HTMLElement>('.tzx-result-card')[i];
  return cardEl?.querySelector('.tzx-result-big')?.textContent ?? '';
}

function wall(epochMs: number, zone: string): string {
  const v = viewInZone(epochMs, zone, false);
  return `${v.date}T${v.time.slice(0, 5)}`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('popup Converter: "now" and source-zone changes', () => {
  it('starts at now, written as the source zone wall clock', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    expect(input().value).toBe('2024-01-03T01:45');
    expect(resultTime('UTC')).toBe('20:00:00');
    expect(resultTime('America/New_York')).toBe('15:00:00');
  });

  it('Now re-reads the clock in the source zone', () => {
    render(<Converter prefs={{ ...prefs, homeZone: 'America/New_York' }} onPrefsChange={vi.fn()} />);
    expect(input().value).toBe('2024-01-02T15:00');
    fireEvent.change(input(), { target: { value: '2023-06-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Now' }));
    expect(input().value).toBe('2024-01-02T15:00');
    expect(resultTime('UTC')).toBe('20:00:00');
  });

  it('switching to Local keeps the instant and re-expresses the digits', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: '2024-03-10T08:15' } });
    // 08:15 in Kathmandu (+05:45) is 02:30 UTC.
    expect(resultTime('UTC')).toBe('02:30:00');
    const local = resolveLocalZone();
    fireEvent.click(screen.getByRole('button', { name: /local/i }));
    expect(input().value).toBe(wall(Date.UTC(2024, 2, 10, 2, 30), local));
    expect(resultTime('UTC')).toBe('02:30:00');
  });

  it('picking a source zone keeps the instant, across a DST change', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    // 2024-03-10 13:30 Kathmandu = 07:45 UTC = 03:45 EDT (just after the New York spring-forward).
    fireEvent.change(input(), { target: { value: '2024-03-10T13:30' } });
    expect(resultTime('UTC')).toBe('07:45:00');
    const picker = screen.getByRole('combobox', { name: 'Source timezone' });
    fireEvent.change(picker, { target: { value: 'New York' } });
    const option = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.startsWith('America/New_York')) as HTMLElement;
    expect(option).toBeTruthy();
    fireEvent.mouseDown(option);
    expect(document.querySelector('.tzx-current-zone')?.textContent).toMatch(/New.York/);
    expect(input().value).toBe('2024-03-10T03:45');
    expect(resultTime('UTC')).toBe('07:45:00');
  });
});

describe('popup header clock format', () => {
  it('is a labelled 12h | 24h segmented control', async () => {
    render(<App />);
    const group = await screen.findByRole('group', { name: 'Clock format' });
    const h12 = within(group).getByRole('button', { name: '12-hour clock' });
    const h24 = within(group).getByRole('button', { name: '24-hour clock' });
    expect(h12).toHaveAttribute('aria-pressed', String(DEFAULT_PREFERENCES.hour12));
    expect(h24).toHaveAttribute('aria-pressed', String(!DEFAULT_PREFERENCES.hour12));
    fireEvent.click(h24);
    expect(h24).toHaveAttribute('aria-pressed', 'true');
    expect(h12).toHaveAttribute('aria-pressed', 'false');
    // Pressing the selected option again does not flip it back.
    fireEvent.click(h24);
    expect(h24).toHaveAttribute('aria-pressed', 'true');
  });
});
