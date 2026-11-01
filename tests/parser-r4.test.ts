import { describe, it, expect } from 'vitest';
import { parseTimes } from '../src/lib/parse';

/** Round-4 review parser fixes: the given-name verse rule (review #2). */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const at = (text: string) => parseTimes(text, { assumedZone: 'UTC', numericDateOrder: 'dmy', nowMs: NOW });
const texts = (text: string) => at(text).map((p) => p.matchedText);
const isoOf = (text: string) => at(text).map((p) => new Date(p.epochMs).toISOString());

describe('given-name books: time signals win over the line-start rule', () => {
  it.each([
    // a zero-padded hour is never a verse
    ['John 09:41', ['09:41']],
    // ("1 John 09:41" is a verse since round 5: a book number settles it.)
    // an hour of 13 or more with only line-start context
    ['Peter 14:07 joined the call', ['14:07']],
    ['Luke 13:02', ['13:02']],
    // a following schedule or chat word
    ['Mark 3:47 meeting', ['3:47']],
    ['Matt 4:12 call', ['4:12']],
    ['- John 3:22 sync', ['3:22']],
    ['Peter 2:17 joined', ['2:17']],
    ['James 7:43 said hi', ['7:43']],
    ['John 3:16 tomorrow', ['3:16']],
    // a time range keeps both halves
    ['Daniel 9:17-9:45', ['9:17', '9:45']],
    ['Daniel 9:17 – 9:45', ['9:17', '9:45']],
    ['John 3:31–4:30', ['3:31', '4:30']],
    // ("2 Peter 1:17-1:45" is a verse range since round 5: see parser-r5.)
  ])('%s is a time', (text, want) => {
    expect(texts(text)).toEqual(want);
  });

  it('the times are today in the assumed zone', () => {
    expect(isoOf('Peter 14:07 joined the call')).toEqual(['2026-11-01T14:07:00.000Z']);
    expect(isoOf('Daniel 9:17-9:45')).toEqual(['2026-11-01T09:17:00.000Z', '2026-11-01T09:45:00.000Z']);
  });

  it.each([
    'John 3:16',
    'Peter 2:17',
    '> Luke 6:31',
    // book numbers and verse ranges outweigh the hour and the next word
    'Luke 15:11–32',
    '1 John 3:16 meeting',
    'John 3:16-18',
    'John 3:16,18',
    // "says" is how a quote opens, not a chat line
    'John 3:16 says',
  ])('%s is still a verse', (text) => {
    expect(at(text)).toEqual([]);
  });
});

describe('citation verbs before a given-name book', () => {
  it.each([
    'See John 3:16',
    'Please see John 3:16.',
    'Read John 3:16',
    'Read John 14:07',
    'cf. Luke 2:11',
    'Compare Mark 4:39',
    'quoting Matthew 5:9',
    'See 1 John 4:19',
  ])('%s is a verse', (text) => {
    expect(at(text)).toEqual([]);
  });

  it.each([
    ['See Peter 10:30', ['10:30']],
    ['See John 09:41', ['09:41']],
    // Round 5: only a capitalised verb at the line or sentence start cites,
    // and a schedule word after still says time.
    ['see John 3:16', ['3:16']],
    ['Read John 3:16 today', ['3:16']],
    ['See Daniel 9:17-9:45', ['9:17', '9:45']],
    ['Call John 3:16', ['3:16']],
    ['Lunch with Peter 12:30', ['12:30']],
  ])('%s is a time', (text, want) => {
    expect(texts(text)).toEqual(want);
  });
});

describe('"v." means verse only directly before the number', () => {
  it.each(['v. 3:16', 'vv. 3:16', 'V. 3:16', 'see v. 3:16', 'See v. 3:16', 'cf. v. 3:16', '(v. 3:16)'])(
    '%s is a verse',
    (text) => {
      expect(at(text)).toEqual([]);
    },
  );

  it.each([
    ['Liverpool v. 3:00', ['3:00']],
    ['Liverpool v. 3:16', ['3:16']],
    ['Arsenal vs Chelsea, Liverpool v. 3:47', ['3:47']],
    // "v." before a given name no longer counts as verse context
    ['v. John 3:30', ['3:30']],
  ])('%s is a time', (text, want) => {
    expect(texts(text)).toEqual(want);
  });

  it('other books keep their plain rule', () => {
    expect(at('Romans 13:14')).toEqual([]);
    expect(at('verse 3:16')).toEqual([]);
    expect(at('ch. 3:16')).toEqual([]);
  });
});
