import { describe, it, expect } from 'vitest';
import { MAX_LISTED, MAX_READ_CHARS, readTimes, type TimeList } from '../src/lib/read-times';
import { parseTimes, SCAN_LIMIT, type ParseOptions } from '../src/lib/parse';
import type { CustomFormat } from '../src/types';

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const OPTS: ParseOptions = { assumedZone: 'UTC', numericDateOrder: 'dmy', nowMs: NOW };
const read = (text: string, opts: ParseOptions = OPTS) => readTimes(text, opts);
const texts = (r: TimeList) => r.matches.map((p) => p.matchedText);
const pad = (n: number) => String(n).padStart(2, '0');

/** Every match is the text at its sourceIndex, and they come in reading order without overlaps. */
function expectWellFormed(text: string, r: TimeList): void {
  let end = 0;
  for (const p of r.matches) {
    const i = p.sourceIndex ?? -1;
    expect(text.slice(i, i + p.matchedText.length)).toBe(p.matchedText);
    expect(i).toBeGreaterThanOrEqual(end);
    end = i + p.matchedText.length;
  }
  if (r.matches.length) expect(r.best).toBeLessThan(r.matches.length);
}

/** `n` distinct dated lines. */
function lines(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `Item ${i} at 2024-${pad((i % 12) + 1)}-${pad((i % 28) + 1)} ${pad(i % 24)}:${pad(i % 60)} UTC.`,
  ).join('\n');
}

describe('readTimes', () => {
  it('limits are as documented', () => {
    expect(MAX_LISTED).toBe(500);
    expect(MAX_READ_CHARS).toBe(200_000);
  });

  it('empty and time-free text', () => {
    expect(read('')).toEqual({ matches: [], best: 0, capped: false });
    expect(read('   no times here   ')).toEqual({ matches: [], best: 0, capped: false });
  });

  it('agrees with one parse on short text, and opens on its best match', () => {
    for (const text of [
      'Starts 9:00, deadline 2024-01-02T15:00Z',
      'Standup 9:00, demo 16:30',
      'Flight 2024-03-05 10:00 UTC, lands 15:30 JST',
      '1 John 10:00-11:30',
    ]) {
      const one = parseTimes(text, OPTS);
      const r = read(text);
      expectWellFormed(text, r);
      const byPlace = [...one].sort((a, b) => (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0));
      expect(texts(r)).toEqual(byPlace.map((p) => p.matchedText));
      expect(r.matches[r.best]).toEqual(one[0]);
      expect(r.capped).toBe(false);
    }
  });

  it('duplicates do not hide later times (review #4)', () => {
    const text = Array.from({ length: 26 }, () => 'Daily standup 09:00 UTC').join('\n') + '\nRetro 15:00 UTC';
    const r = read(text);
    expect(texts(r)).toEqual(['09:00 UTC', '15:00 UTC']);
    expect(r.capped).toBe(false);
    expectWellFormed(text, r);
    // Same with a duplicate run the size of several parser caps.
    const long = Array(300).fill('10:00 UTC').join(', ') + ', 11:00 UTC';
    expect(texts(read(long))).toEqual(['10:00 UTC', '11:00 UTC']);
  });

  it('lists 40 and 60 lines, in reading order', () => {
    for (const n of [26, 40, 60]) {
      const text = lines(n);
      const r = read(text);
      expect(r.matches).toHaveLength(n);
      expect(r.capped).toBe(false);
      expectWellFormed(text, r);
    }
  });

  it('a re-read sees the text before the cut (review #5)', () => {
    const head = Array.from({ length: 25 }, (_, i) => `${pad(i % 24)}:${pad(i)} UTC`).join(', ');
    // What one parse makes of the same words after one time.
    // (The last head time is "00:24 UTC", and "-11:30" joins it as an offset.)
    const alone = (tail: string) =>
      parseTimes(`x 00:24 UTC${tail}`, OPTS)
        .sort((a, b) => (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0))
        .map((p) => p.matchedText);
    for (const tail of [' John 3:16', ' See John 3:16', ', John 3:16', '; v. 3:16', ' 2:30 odds', ', ratio 4:30', ' Jan 5', ' and 3:16 pm', ' on 2024-03-05', '-11:30']) {
      const r = read(head + tail);
      expect(texts(r).slice(0, 24)).toEqual(head.split(', ').slice(0, 24));
      expect(texts(r).slice(24)).toEqual(alone(tail));
    }
    // A verse straight after the cut: chapter:verse with its book before it.
    const verse = Array.from({ length: 25 }, (_, i) => `${pad(i % 24)}:${pad(i)} UTC`).join('\n') + '\nRomans 8:28\nlater 14:00 UTC';
    expect(texts(read(verse)).slice(25)).toEqual(['14:00 UTC']);
  });

  it(`reads past ${SCAN_LIMIT} characters (QA F4)`, () => {
    const late = 'x'.repeat(19_994) + ' 2024-05-05 10:00 UTC';
    expect(texts(read(late))).toEqual(['2024-05-05 10:00 UTC']);
    const apart = '2024-05-05 10:00 UTC ' + 'lorem ipsum '.repeat(2_000) + ' 2024-05-06 11:00 UTC';
    const r = read(apart);
    expect(texts(r)).toEqual(['2024-05-05 10:00 UTC', '2024-05-06 11:00 UTC']);
    expect(r.capped).toBe(false);
    // 300 times over more than SCAN_LIMIT characters: all of them, no "+".
    const many = lines(300).replace(/\n/g, ' Some words in between to make it long. '.repeat(2) + '\n');
    expect(many.length).toBeGreaterThan(SCAN_LIMIT);
    const m = read(many);
    expect(m.matches).toHaveLength(300);
    expect(m.capped).toBe(false);
    expectWellFormed(many, m);
  });

  it('a match across a window edge is read whole', () => {
    // Put a zone-bearing time right at SCAN_LIMIT, so the first window cuts it.
    const t = '2024-05-05 10:00 UTC';
    for (const shift of [-15, -10, -4, -1, 0, 3]) {
      const text = 'x '.repeat((SCAN_LIMIT + shift) / 2 | 0) + t + ' and 2024-05-06 11:00 UTC';
      const r = read(text);
      expect(texts(r)).toEqual([t, '2024-05-06 11:00 UTC']);
      expect(r.matches[0]!.assumed).toBeFalsy();
    }
  });

  it(`is capped at ${MAX_LISTED} times`, () => {
    const text = lines(600);
    const r = read(text);
    expect(r.matches).toHaveLength(MAX_LISTED);
    expect(r.capped).toBe(true);
    expectWellFormed(text, r);
    const exact = read(lines(MAX_LISTED));
    expect(exact.matches).toHaveLength(MAX_LISTED);
    expect(exact.capped).toBe(false);
  });

  it(`reads ${MAX_READ_CHARS} characters, and says when there is more`, () => {
    const filler = 'y'.repeat(MAX_READ_CHARS - 100);
    const inside = read(`${filler} 2024-05-05 10:00 UTC`);
    expect(texts(inside)).toEqual(['2024-05-05 10:00 UTC']);
    expect(inside.capped).toBe(false);
    const past = read(`2024-05-05 10:00 UTC ${filler}${'z'.repeat(200)} 2024-05-06 11:00 UTC`);
    expect(texts(past)).toEqual(['2024-05-05 10:00 UTC']);
    expect(past.capped).toBe(true);
    // Trailing spaces past the limit are not "more".
    expect(read(`2024-05-05 10:00 UTC ${filler}${' '.repeat(200)}`).capped).toBe(false);
  });

  it('is deterministic', () => {
    const text = lines(700) + '\n' + 'x'.repeat(30_000) + '\n' + lines(20);
    const a = read(text);
    for (let k = 0; k < 3; k++) expect(read(text)).toEqual(a);
    expect(a.capped).toBe(true);
    expect(a.matches).toHaveLength(MAX_LISTED);
  });

  it('opens on the most specific match, wherever it is', () => {
    const text = Array.from({ length: 40 }, (_, i) => `standup ${pad(i % 24)}:${pad(i)}`).join('\n') + '\ndeadline 2024-01-02T15:00Z';
    const r = read(text);
    expect(r.matches).toHaveLength(41);
    expect(r.best).toBe(40);
  });

  it('reads no-break spaces, with the original characters', () => {
    const text = Array.from({ length: 30 }, (_, i) => `2024-10-${pad(i + 1)} 13:30\u00A0UTC`).join('; ');
    const r = read(text);
    expect(r.matches).toHaveLength(30);
    expect(r.matches.every((p) => p.matchedText.endsWith('\u00A0UTC') && !p.assumed)).toBe(true);
    expectWellFormed(text, r);
  });

  it('reads custom token formats past their cap too', () => {
    const fmt: CustomFormat = { id: 'c1', label: 'x', pattern: 'DD~MM~YYYY HH:mm', advanced: false, enabled: true };
    const text = Array.from({ length: 40 }, (_, i) => `run ${pad((i % 28) + 1)}~03~2024 ${pad(i % 24)}:00`).join('\n');
    const r = read(text, { ...OPTS, customFormats: [fmt] });
    expect(r.matches).toHaveLength(40);
    expect(r.matches.every((p) => p.formatId === 'c1')).toBe(true);
  });

  it('keeps advanced regex formats to the start of the selection, as one parse does', () => {
    const fmt: CustomFormat = {
      id: 'adv',
      label: 'adv',
      pattern: String.raw`T(?<y>\d{4})(?<mo>\d{2})(?<d>\d{2})`,
      advanced: true,
      enabled: true,
    };
    const text = 'T20240105 ' + 'z'.repeat(2_000) + ' T20240106';
    const r = read(text, { ...OPTS, customFormats: [fmt] });
    expect(texts(r)).toEqual(['T20240105']);
  });

  it('stays quick on long and hostile selections', () => {
    const cases = [
      lines(5_000).slice(0, MAX_READ_CHARS),
      '12:30 '.repeat(33_000),
      'John 3:16 '.repeat(20_000),
      '1'.repeat(MAX_READ_CHARS),
    ];
    for (const text of cases) {
      const t0 = performance.now();
      read(text);
      // Generous for CI; locally these take 2–70 ms.
      expect(performance.now() - t0).toBeLessThan(1_500);
    }
  });
});
