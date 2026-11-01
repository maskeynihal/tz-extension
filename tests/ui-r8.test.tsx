import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { MAX_LISTED, MAX_READ_CHARS } from '../src/lib/read-times';

// QA r8 H4: the website says why a time is missing or a count has a "+".
// QA r8 H5: a long zone name wraps inside its column instead of running into
// the date beside it.

const LIMIT = MAX_READ_CHARS.toLocaleString('en-US');

describe('website converter: read limit explained (QA r8 H4)', () => {
  let host: HTMLElement;
  let input: HTMLInputElement;
  let stepper: HTMLElement;
  let count: HTMLElement;
  let why: HTMLElement;
  let hint: HTMLElement;
  const type = (v: string): void => {
    input.value = v;
    fireEvent.input(input);
  };

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
    why = host.querySelector('.demo-stepwhy') as HTMLElement;
    hint = host.querySelector('.demo-hint') as HTMLElement;
  });

  it('a time only past the read limit: the hint names the limit', () => {
    // The QA input: 50,010 "x" and then a time.
    type('x'.repeat(MAX_READ_CHARS + 10) + ' 2024-05-05 10:00 UTC');
    expect(hint).toHaveTextContent(`No time found in the first ${LIMIT} characters; text past that is not read.`);
    expect(hint).toHaveClass('is-error');
    expect(hint.textContent).not.toContain("Couldn't read");
    expect(stepper.hidden).toBe(true);
    expect(why.hidden).toBe(true);
  });

  it('a short input with no time keeps the generic hint', () => {
    type('hello there');
    expect(hint).toHaveTextContent("Couldn't read that as a time. Try an epoch, an ISO string, or a full date.");
    type('x'.repeat(MAX_READ_CHARS));
    expect(hint.textContent).toContain("Couldn't read that as a time.");
  });

  it('"1 of 1+" shows the reason as visible text under the stepper', () => {
    type('2024-03-05T14:05Z ' + 'y'.repeat(MAX_READ_CHARS) + ' 2024-03-06T09:00Z');
    expect(count).toHaveTextContent('Time 1 of 1+');
    expect(why.hidden).toBe(false);
    expect(why).toHaveTextContent(`Text past the first ${LIMIT} characters is not read.`);
    // Placed right after the stepper.
    expect(stepper.nextElementSibling).toBe(why);
  });

  it('"2+" from the read limit shows the same reason', () => {
    type('2024-03-05T14:05Z and 2024-03-06T09:00Z ' + 'y'.repeat(MAX_READ_CHARS));
    expect(count).toHaveTextContent(/of 2\+$/);
    expect(why).toHaveTextContent(`Text past the first ${LIMIT} characters is not read.`);
  });

  it('the count cap shows its own reason', () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => `${1_700_000_000 + i * 60}`).join(' ');
    type(many);
    expect(count).toHaveTextContent(new RegExp(`of ${MAX_LISTED}\\+$`));
    expect(why.hidden).toBe(false);
    expect(why).toHaveTextContent(`Only the first ${MAX_LISTED} times are listed.`);
  });

  it('an uncapped input hides the reason again', () => {
    type('2024-03-05T14:05Z ' + 'y'.repeat(MAX_READ_CHARS));
    expect(why.hidden).toBe(false);
    type('2024-03-05T14:05Z and 2024-03-06T09:00Z');
    expect(count).toHaveTextContent(/of 2$/);
    expect(why.hidden).toBe(true);
    expect(why.textContent).toBe('');
  });

  it('zone names can break after "/" and keep their text', () => {
    type('2024-03-05T14:05Z');
    const names = [...host.querySelectorAll('.demo-zone-name')];
    const ny = names.find((n) => n.textContent === 'America/New_York');
    expect(ny).toBeDefined();
    expect(ny?.querySelectorAll('wbr')).toHaveLength(1);
    expect(ny?.firstChild?.textContent).toBe('America/');
  });
});

describe('website converter row CSS (QA r8 H5)', () => {
  const html = readFileSync(resolve(__dirname, '../site/app.html'), 'utf8');

  it('the zone name wraps inside its column and the column keeps its words', () => {
    // min-width: 0 let the column shrink below "New_York", so the name ran
    // into the date. The default (auto = min-content) stops at the longest
    // word; the <wbr> after "/" keeps that word short.
    const zoneRule = /\.demo-zone\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
    expect(zoneRule).toContain('display: flex');
    expect(zoneRule).not.toMatch(/min-width:\s*0/);
    expect(html).toMatch(/\.demo-zone-name\s*\{[^}]*overflow-wrap:\s*break-word/);
    // The gap between the name and the date stays.
    expect(html).toMatch(/\.demo-row\s*\{[^}]*gap:\s*16px/);
  });

  it('the read-limit line under the stepper is styled and hideable', () => {
    expect(html).toMatch(/\.demo-stepwhy\[hidden\]\s*\{\s*display:\s*none/);
  });
});
