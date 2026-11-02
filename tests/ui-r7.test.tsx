import { describe, it, expect, beforeAll } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { MAX_READ_CHARS, readTimes } from '../src/lib/read-times';
import { DEFAULT_PREFERENCES } from '../src/types';

// QA r7 G7: on the website, a capped list with a single listed match still
// shows the stepper as "1 of 1+", so the "+" says the input was not read in
// full. A single match from a short input keeps the stepper hidden.

const OPTS = {
  assumedZone: DEFAULT_PREFERENCES.homeZone,
  dateOnlyPolicy: DEFAULT_PREFERENCES.dateOnlyPolicy,
  customFormats: DEFAULT_PREFERENCES.customFormats,
  disabledFormats: DEFAULT_PREFERENCES.disabledFormats,
  numericDateOrder: DEFAULT_PREFERENCES.numericDateOrder,
};

describe('website converter: capped single match (QA r7 G7)', () => {
  let host: HTMLElement;
  let input: HTMLInputElement;
  let stepper: HTMLElement;
  let count: HTMLElement;
  let hint: HTMLElement;
  const type = (v: string): void => {
    input.value = v;
    fireEvent.input(input);
  };
  const button = (name: string): HTMLButtonElement => within(stepper).getByRole('button', { name }) as HTMLButtonElement;

  beforeAll(async () => {
    localStorage.clear();
    host = document.createElement('div');
    host.id = 'demo-app';
    document.body.append(host);
    await act(async () => {
      await import('../site/demo');
    });
    await waitFor(() => expect(host.querySelector('.demo-rows')).not.toBeNull());
    input = within(host).getByLabelText('Time to convert') as HTMLInputElement;
    stepper = host.querySelector('.demo-step') as HTMLElement;
    count = host.querySelector('.demo-stepcount') as HTMLElement;
    hint = host.querySelector('.demo-hint') as HTMLElement;
  });

  it('shows "1 of 1+" when one time is listed and the input is longer than is read', () => {
    const text = '2024-03-05T14:05Z ' + 'x'.repeat(MAX_READ_CHARS);
    const list = readTimes(text, OPTS);
    expect(list.matches).toHaveLength(1);
    expect(list.capped).toBe(true);

    type(text);
    expect(stepper.hidden).toBe(false);
    expect(count).toHaveTextContent('Time 1 of 1+');
    expect(count.getAttribute('title')).toBe(`Text past the first ${MAX_READ_CHARS.toLocaleString('en-US')} characters is not read`);
    expect(hint.textContent).toContain('Read "2024-03-05T14:05Z"');
    // Nothing to step to: both buttons are disabled and a click changes nothing.
    expect(button('Previous time')).toBeDisabled();
    expect(button('Next time')).toBeDisabled();
    fireEvent.click(button('Next time'));
    expect(count).toHaveTextContent('Time 1 of 1+');
  });

  it('hides the stepper again for a single time in a short input', () => {
    type('2024-03-05T14:05Z ' + 'x'.repeat(MAX_READ_CHARS));
    expect(stepper.hidden).toBe(false);
    type('2024-03-05T14:05Z');
    expect(stepper.hidden).toBe(true);
    expect(count.hasAttribute('title')).toBe(false);
    // Two times: the stepper is back with live buttons and no "+".
    type('2024-03-05T14:05Z and 2024-03-06T09:00Z');
    expect(stepper.hidden).toBe(false);
    expect(count).toHaveTextContent(/of 2$/);
    expect(button('Next time')).not.toBeDisabled();
  });

  it('hides the stepper when a capped input has no time at all', () => {
    type('x'.repeat(MAX_READ_CHARS + 10));
    expect(stepper.hidden).toBe(true);
  });
});
