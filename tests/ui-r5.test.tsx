import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent, waitFor, within } from '@testing-library/react';
import { ClockApp } from '../src/clock/Clock';
import { zoneDescription, zonePlace } from '../src/clock/model';
import { matchKey, readingOrder } from '../site/convert';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

const KEY = 'tz-extension-prefs';

function fake(matchedText: string, sourceIndex?: number): ParsedTime {
  return {
    epochMs: 0,
    matchedText,
    assumed: false,
    assumedZone: 'UTC',
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
  } as unknown as ParsedTime;
}

describe('readingOrder (QA r5 N8)', () => {
  it('sorts best-first results by sourceIndex and reports where the best one went', () => {
    const best = fake('2024-07-01T09:00Z', 15);
    const r = readingOrder([best, fake('1700000000', 0), fake('10:00', 40)], 'x');
    expect(r.times.map((p) => p.matchedText)).toEqual(['1700000000', '2024-07-01T09:00Z', '10:00']);
    expect(r.best).toBe(1);
    expect(r.times[r.best]).toBe(best);
  });

  it('keeps best-first order on ties', () => {
    const a = fake('10:00 UTC', 3);
    const b = fake('10:00', 3);
    expect(readingOrder([a, b], 'x').times).toEqual([a, b]);
    expect(readingOrder([b, a], 'x').times).toEqual([b, a]);
  });

  it('falls back to where the text occurs when sourceIndex is missing', () => {
    const text = '1700000000 and 2024-07-01T09:00Z';
    const r = readingOrder([fake('2024-07-01T09:00Z'), fake('1700000000')], text);
    expect(r.times.map((p) => p.matchedText)).toEqual(['1700000000', '2024-07-01T09:00Z']);
    expect(r.best).toBe(1);
  });

  it('is empty for no matches, and the key tells repeated text apart by position', () => {
    expect(readingOrder([], '')).toEqual({ times: [], best: 0 });
    expect(matchKey(fake('10:00', 0))).not.toBe(matchKey(fake('10:00', 9)));
  });
});

// --- World clock: Etc/GMT±N subtitle (review r5 #6 / QA r5 N7) ---

const NOW = Date.UTC(2024, 0, 2, 12, 43, 20);

describe('world clock card subtitle for Etc/GMT±N', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the IANA id under the offset title instead of repeating the label', async () => {
    expect(zonePlace('Etc/GMT+12')).toBe('UTC-12:00');
    expect(zoneDescription('Etc/GMT+12')).toBe('Etc/GMT+12');
    expect(zoneDescription('Etc/GMT-14')).toBe('Etc/GMT-14');
    // Unchanged: plain IANA zones, UTC aliases and fixed offsets.
    expect(zoneDescription('America/St_Johns')).toBe('America/St_Johns');
    expect(zoneDescription('Etc/GMT')).toBe('Coordinated Universal Time');
    expect(zoneDescription('UTC+05:45')).toBe('Fixed offset, no daylight saving');

    const prefs: Preferences = {
      ...DEFAULT_PREFERENCES,
      homeZone: 'UTC',
      targetZones: ['Etc/GMT+12', 'America/New_York'],
      hour12: false,
      theme: 'system',
    };
    const chromeMock = (globalThis as unknown as { chrome: { storage: { sync: { set: (v: unknown) => Promise<void> } } } })
      .chrome;
    await chromeMock.storage.sync.set({ [KEY]: prefs });
    render(<ClockApp />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const card = document.querySelector<HTMLElement>('.tzc-card[data-zone="Etc/GMT+12"]');
    expect(card?.querySelector('.tzc-card-title')).toHaveTextContent(/^UTC-12:00$/);
    expect(card?.querySelector('.tzc-card-sub')).toHaveTextContent(/^Etc\/GMT\+12$/);
  });
});

// Last: importing the website entry opts this module graph into web storage.
describe('website converter: other times in the input (QA r5 N8)', () => {
  it('steps through the times in reading order, opening on the best match', async () => {
    localStorage.clear();
    const host = document.createElement('div');
    host.id = 'demo-app';
    document.body.append(host);
    await act(async () => {
      await import('../site/demo');
    });
    await waitFor(() => expect(host.querySelector('.demo-rows')).not.toBeNull());

    const input = within(host).getByLabelText('Time to convert') as HTMLInputElement;
    const stepper = host.querySelector('.demo-step') as HTMLElement;
    const hint = host.querySelector('.demo-hint') as HTMLElement;
    const format = host.querySelector('.demo-format') as HTMLElement;
    const orderBox = host.querySelector('.demo-order') as HTMLElement;
    const count = host.querySelector('.demo-stepcount') as HTMLElement;
    const type = (v: string): void => {
      input.value = v;
      fireEvent.input(input);
    };

    // The seeded epoch is one time: no stepper.
    expect(stepper.hidden).toBe(true);

    expect(within(host).queryByRole('group', { name: 'Times in the input' })).toBeNull();

    // The parser's best match is the ISO string, second in reading order.
    type('1700000000 and 2024-07-01T09:00Z');
    expect(stepper.hidden).toBe(false);
    // Accessible: a labelled group with labelled buttons and a live count.
    const group = within(host).getByRole('group', { name: 'Times in the input' });
    const prev = within(group).getByRole('button', { name: 'Previous time' });
    const next = within(group).getByRole('button', { name: 'Next time' });
    expect(count).toHaveAttribute('aria-live', 'polite');
    expect(count).toHaveTextContent('Time 2 of 2');
    expect(hint.textContent).toContain('Read "2024-07-01T09:00Z"');
    expect(hint.textContent).toContain('2024-07-01T09:00:00.000Z');
    expect(format).toHaveTextContent('Matched by format: ISO 8601');
    const isoRows = host.querySelector('.demo-rows')?.textContent;

    fireEvent.click(prev);
    expect(count).toHaveTextContent('Time 1 of 2');
    expect(hint.textContent).toContain('Read "1700000000"');
    expect(hint.textContent).toContain('2023-11-14T22:13:20.000Z');
    expect(format).toHaveTextContent('Matched by format: Unix epoch (seconds)');
    expect(host.querySelector('.demo-rows')?.textContent).not.toBe(isoRows);

    // Wraps both ways.
    fireEvent.click(prev);
    expect(count).toHaveTextContent('Time 2 of 2');
    fireEvent.click(next);
    expect(count).toHaveTextContent('Time 1 of 2');

    // A setting change re-renders and keeps the chosen time.
    fireEvent.click(within(host).getByRole('button', { name: '24-hour clock' }));
    expect(count).toHaveTextContent('Time 1 of 2');
    expect(hint.textContent).toContain('Read "1700000000"');

    // The day/month picker follows the shown time.
    type('03/04/2024 10:00 UTC, 2024-07-01T09:00Z');
    expect(count).toHaveTextContent('Time 1 of 2');
    expect(orderBox.hidden).toBe(false);
    expect(within(orderBox).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(next);
    expect(count).toHaveTextContent('Time 2 of 2');
    expect(orderBox.hidden).toBe(true);
    expect(hint.textContent).toContain('Read "2024-07-01T09:00Z"');

    // New input opens on its best match again.
    type('1700000000 and 2024-07-01T09:00Z');
    expect(count).toHaveTextContent('Time 2 of 2');

    // One time, no time, and the Epoch tab hide it.
    type('2024-07-01T09:00Z');
    expect(stepper.hidden).toBe(true);
    type('nothing here');
    expect(stepper.hidden).toBe(true);
    type('1700000000 and 2024-07-01T09:00Z');
    fireEvent.click(within(host).getByRole('button', { name: 'Epoch' }));
    expect(stepper.hidden).toBe(true);
  });
});
