import { describe, it, expect, beforeAll } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { MAX_LISTED, MAX_READ_CHARS, readTimes } from '../src/lib/read-times';
import { DEFAULT_PREFERENCES } from '../src/types';

// QA r6 F2: the website converter listed at most 25 times (parseTimes' cap).
// It now uses readTimes, like the extension card: every time in reading order,
// "N+" when the list is capped, opening on the parser's best match.

/** `n` distinct ISO times, one per day from 2024-01-01, 09:00 UTC. */
function isoList(n: number, sep = ', '): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(2024, 0, 1 + i, 9)).toISOString().slice(0, 16) + 'Z');
  return out.map((s, i) => (i < n - 1 ? s + sep : s));
}

const OPTS = {
  assumedZone: DEFAULT_PREFERENCES.homeZone,
  dateOnlyPolicy: DEFAULT_PREFERENCES.dateOnlyPolicy,
  customFormats: DEFAULT_PREFERENCES.customFormats,
  disabledFormats: DEFAULT_PREFERENCES.disabledFormats,
  numericDateOrder: DEFAULT_PREFERENCES.numericDateOrder,
};

describe('website converter: every time in the input (QA r6 F2)', () => {
  let host: HTMLElement;
  let input: HTMLInputElement;
  let stepper: HTMLElement;
  let count: HTMLElement;
  let hint: HTMLElement;
  const type = (v: string): void => {
    input.value = v;
    fireEvent.input(input);
  };
  const next = (): void => {
    fireEvent.click(within(stepper).getByRole('button', { name: 'Next time' }));
  };
  const prev = (): void => {
    fireEvent.click(within(stepper).getByRole('button', { name: 'Previous time' }));
  };

  beforeAll(async () => {
    localStorage.clear();
    host = document.createElement('div');
    host.id = 'demo-app';
    document.body.append(host);
    // Importing the website entry opts this module graph into web storage.
    await act(async () => {
      await import('../site/demo');
    });
    await waitFor(() => expect(host.querySelector('.demo-rows')).not.toBeNull());
    input = within(host).getByLabelText('Time to convert') as HTMLInputElement;
    stepper = host.querySelector('.demo-step') as HTMLElement;
    count = host.querySelector('.demo-stepcount') as HTMLElement;
    hint = host.querySelector('.demo-hint') as HTMLElement;
  });

  it('lists 26 times (one more than the old cap) and opens on the best match', () => {
    const parts = isoList(26);
    const text = parts.join('');
    const list = readTimes(text, OPTS);
    expect(list.matches).toHaveLength(26);
    expect(list.capped).toBe(false);

    type(text);
    expect(stepper.hidden).toBe(false);
    expect(count).toHaveTextContent(`Time ${list.best + 1} of 26`);
    expect(count.textContent).not.toContain('+');
    expect(hint.textContent).toContain(`Read "${list.matches[list.best]?.matchedText}"`);

    // The 26th time is reachable: step to the end (wrapping as needed).
    for (let i = list.best; i < 25; i++) next();
    expect(count).toHaveTextContent('Time 26 of 26');
    expect(hint.textContent).toContain('Read "2024-01-26T09:00Z"');
    next();
    expect(count).toHaveTextContent('Time 1 of 26');
    expect(hint.textContent).toContain('Read "2024-01-01T09:00Z"');
  });

  it('lists 60 pasted log lines in reading order', () => {
    // The converter is a single-line <input>: value sanitisation strips line
    // breaks, and a paste turns them into spaces. So 60 log lines arrive as
    // one line with a space between them.
    const text = isoList(60, ' INFO job done\n').join('').replace(/\n/g, ' ');
    const list = readTimes(text, OPTS);
    expect(list.matches).toHaveLength(60);
    expect(list.capped).toBe(false);

    type(text);
    expect(count).toHaveTextContent(`Time ${list.best + 1} of 60`);
    for (let i = list.best; i > 0; i--) prev();
    expect(count).toHaveTextContent('Time 1 of 60');
    prev();
    expect(count).toHaveTextContent('Time 60 of 60');
    expect(hint.textContent).toContain('Read "2024-02-29T09:00Z"');
  });

  it(`shows "N+" when 600 times are more than the ${MAX_LISTED} it lists`, () => {
    const text = isoList(600).join('');
    const list = readTimes(text, OPTS);
    expect(list.capped).toBe(true);
    expect(list.matches).toHaveLength(MAX_LISTED);

    type(text);
    expect(count).toHaveTextContent(`Time ${list.best + 1} of ${MAX_LISTED}+`);
    for (let i = list.best; i < MAX_LISTED - 1; i++) next();
    expect(count).toHaveTextContent(`Time ${MAX_LISTED} of ${MAX_LISTED}+`);
    expect(hint.textContent).toContain(`Read "${list.matches[MAX_LISTED - 1]?.matchedText}"`);

    // A short input drops the "+" again.
    type(isoList(2).join(''));
    expect(count).toHaveTextContent(/of 2$/);
  });

  it('shows "N+" when the input is longer than readTimes reads', () => {
    const text = isoList(3).join('') + ' ' + 'x'.repeat(MAX_READ_CHARS);
    const list = readTimes(text, OPTS);
    expect(list.capped).toBe(true);
    expect(list.matches).toHaveLength(3);

    type(text);
    expect(count).toHaveTextContent(`Time ${list.best + 1} of 3+`);
  });
});
