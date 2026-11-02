import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Converter } from '../src/popup/Converter';
import { EpochTab } from '../src/popup/EpochTab';
import { readWallInput } from '../src/popup/wallnote';
import { ClockApp } from '../src/clock/Clock';
import { utcOffsetLabel, zoneDescription, zonePlace } from '../src/clock/model';
import { FormatsSection, examplePieces } from '../src/options/Formats';
import { readEpochInput, wallClockNote } from '../site/convert';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

// The engine reports the local zone by its legacy name, as Chrome does in Nepal.
vi.mock('../src/types', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/types')>();
  return { ...real, resolveLocalZone: () => 'Asia/Katmandu' };
});

const root = resolve(__dirname, '..');

const popupPrefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  homeZone: 'Asia/Kathmandu',
  targetZones: ['UTC', 'Asia/Kathmandu'],
  hour12: false,
};

function dtInput(): HTMLInputElement {
  return screen.getByLabelText('Date & time') as HTMLInputElement;
}

function resultCard(i: number): HTMLElement {
  return document.querySelectorAll<HTMLElement>('.tzx-result-card')[i] as HTMLElement;
}

describe('popup Converter: local zone with a legacy engine name (review #3)', () => {
  it('shows the LOCAL tag and a pressed Local chip for Asia/Kathmandu when the engine says Asia/Katmandu', () => {
    render(<Converter prefs={popupPrefs} onPrefsChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: 'Local' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    // The title names the zone the way every list does.
    expect(chip.getAttribute('title')).toContain('Asia/Kathmandu');
    expect(within(resultCard(1)).getByText('LOCAL')).toBeInTheDocument();
    expect(within(resultCard(0)).queryByText('LOCAL')).not.toBeInTheDocument();
  });

  it('does not add an alias of a zone that is already a target', () => {
    const onChange = vi.fn();
    render(<Converter prefs={{ ...popupPrefs, targetZones: ['Asia/Katmandu'] }} onPrefsChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Add a timezone' });
    fireEvent.change(picker, { target: { value: 'Kathmandu' } });
    const opt = screen.queryAllByRole('option').find((o) => o.textContent?.startsWith('Asia/Kathmandu'));
    if (opt) fireEvent.mouseDown(opt);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('popup: DST gaps and overlaps (QA #1/#2)', () => {
  const ny: Preferences = { ...popupPrefs, homeZone: 'America/New_York', targetZones: ['UTC'] };

  it('reads a spring-forward gap time forward and says so', () => {
    render(<Converter prefs={ny} onPrefsChange={vi.fn()} />);
    fireEvent.change(dtInput(), { target: { value: '2024-03-10T02:30' } });
    expect(screen.getByText("02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30.")).toBeInTheDocument();
    // 03:30 EDT is 07:30 UTC.
    expect(resultCard(0).querySelector('.tzx-result-big')?.textContent).toBe('07:30:00');
    expect(dtInput()).toHaveAttribute('aria-describedby', 'tzx-dt-note');
  });

  it('reads a fall-back time as the first occurrence and says so', () => {
    render(<Converter prefs={ny} onPrefsChange={vi.fn()} />);
    fireEvent.change(dtInput(), { target: { value: '2024-11-03T01:30' } });
    expect(screen.getByText('01:30 happens twice on 3 Nov in New York; showing the first (EDT).')).toBeInTheDocument();
    // 01:30 EDT is 05:30 UTC (the later one, EST, would be 06:30).
    expect(resultCard(0).querySelector('.tzx-result-big')?.textContent).toBe('05:30:00');
  });

  it('shows no note for an ordinary time', () => {
    render(<Converter prefs={ny} onPrefsChange={vi.fn()} />);
    fireEvent.change(dtInput(), { target: { value: '2024-03-11T02:30' } });
    expect(document.querySelector('.tzx-wall-note')).toBeNull();
    expect(resultCard(0).querySelector('.tzx-result-big')?.textContent).toBe('06:30:00');
  });

  it('the Epoch tab reverse conversion is DST-correct with the same notes', () => {
    render(<EpochTab prefs={ny} />);
    const rev = screen.getByLabelText(/Reverse: date & time/);
    fireEvent.change(rev, { target: { value: '2024-03-10T02:30:00' } });
    expect(screen.getByText(/02:30 doesn't exist on 10 Mar in New York \(clocks jump forward\); shown as 03:30\./)).toBeInTheDocument();
    expect(screen.getByText(String(Date.UTC(2024, 2, 10, 7, 30) / 1000))).toBeInTheDocument();
    fireEvent.change(rev, { target: { value: '2024-11-03T01:30:00' } });
    expect(screen.getByText(/01:30 happens twice on 3 Nov in New York; showing the first \(EDT\)\./)).toBeInTheDocument();
    expect(screen.getByText(String(Date.UTC(2024, 10, 3, 5, 30) / 1000))).toBeInTheDocument();
  });

  it('readWallInput falls back to the offset when there is no letter abbreviation', () => {
    const r = readWallInput('2024-10-27T01:30', 'Europe/London');
    expect(r?.epochMs).toBe(Date.UTC(2024, 9, 27, 0, 30));
    expect(r?.note).toMatch(/^01:30 happens twice on 27 Oct in London; showing the first \((BST|UTC\+01:00)\)\.$/);
    expect(readWallInput('2024-03-31T01:30', 'Europe/London')?.note).toBe(
      "01:30 doesn't exist on 31 Mar in London (clocks jump forward); shown as 02:30.",
    );
    expect(readWallInput('nonsense', 'Europe/London')).toBeNull();
    expect(readWallInput('2024-03-31T01:30', 'Not/AZone')).toBeNull();
  });
});

// --- World clock ---

const KEY = 'tz-extension-prefs';
const NOW = Date.UTC(2024, 0, 2, 20, 0, 0);

async function mountClock(prefs: Preferences): Promise<void> {
  const chromeMock = (globalThis as unknown as { chrome: { storage: { sync: { set: (v: unknown) => Promise<void> } } } })
    .chrome;
  await chromeMock.storage.sync.set({ [KEY]: prefs });
  render(<ClockApp />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function clockCard(zone: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.tzc-card[data-zone="${zone}"]`);
  if (!el) throw new Error(`no card for ${zone}`);
  return el;
}

describe('world clock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const legacy: Preferences = {
    ...DEFAULT_PREFERENCES,
    homeZone: 'Asia/Katmandu',
    targetZones: ['America/Argentina/ComodRivadavia', 'Asia/Calcutta', 'UTC-08:00'],
    hour12: false,
  };

  it('names legacy zones by their current names everywhere (QA #7)', async () => {
    await mountClock(legacy);
    const home = within(clockCard('Asia/Katmandu'));
    expect(home.getByRole('heading', { level: 3 })).toHaveTextContent('Kathmandu');
    expect(home.getByText('Asia/Kathmandu')).toBeInTheDocument();
    const cat = within(clockCard('America/Argentina/ComodRivadavia'));
    expect(cat.getByRole('heading', { level: 3 })).toHaveTextContent('Catamarca');
    expect(cat.getByText('America/Argentina/Catamarca')).toBeInTheDocument();
    expect(within(clockCard('Asia/Calcutta')).getByRole('heading', { level: 3 })).toHaveTextContent('Kolkata');
    // "Your time … · Kathmandu" (the mocked engine zone is Asia/Katmandu).
    expect(document.querySelector('.tzc-local-date')?.textContent).toMatch(/· Kathmandu$/);

    fireEvent.change(screen.getByLabelText('Shift all clocks'), { target: { value: '8' } });
    expect(screen.getByText('Planning:').parentElement).toHaveTextContent(/in Kathmandu/);
    expect(screen.getByLabelText('Shift all clocks').getAttribute('aria-valuetext')).toMatch(/in Kathmandu/);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Katmandu|ComodRivadavia|Calcutta/);
  });

  it('model helpers use the canonical name', () => {
    expect(zonePlace('Asia/Katmandu')).toBe('Kathmandu');
    expect(zonePlace('America/Argentina/ComodRivadavia')).toBe('Catamarca');
    expect(zonePlace('Etc/UTC')).toBe('UTC');
    expect(zoneDescription('Asia/Katmandu')).toBe('Asia/Kathmandu');
    expect(zoneDescription('Europe/Kiev')).toBe('Europe/Kyiv');
  });

  it('scale marks are keyboard-reachable presets that move the planner (QA #13)', async () => {
    await mountClock(legacy);
    const slider = screen.getByLabelText('Shift all clocks') as HTMLInputElement;
    const scale = screen.getByRole('list', { name: 'Jump to' });
    const presets = within(scale).getAllByRole('button');
    expect(presets.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Plan 12 hours back',
      'Plan 6 hours back',
      'Plan the current time',
      'Plan 6 hours ahead',
      'Plan 12 hours ahead',
      'Plan 18 hours ahead',
      'Plan 24 hours ahead',
      'Plan 30 hours ahead',
      'Plan 36 hours ahead',
    ]);
    // Real buttons: in the tab order, not hidden from assistive tech.
    for (const b of presets) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.tabIndex).toBe(0);
      expect(b.closest('[aria-hidden="true"]')).toBeNull();
    }

    const ahead = screen.getByRole('button', { name: 'Plan 12 hours ahead' });
    ahead.focus();
    fireEvent.click(ahead);
    expect(slider.value).toBe('48');
    expect(ahead).toHaveAttribute('aria-pressed', 'true');
    // UTC-08:00 is 12:00 at NOW; twelve hours later it is midnight.
    expect(clockCard('UTC-08:00').querySelector('.tzc-time')?.textContent).toBe('00:00');

    fireEvent.click(screen.getByRole('button', { name: 'Plan 6 hours back' }));
    expect(slider.value).toBe('-24');
    expect(clockCard('UTC-08:00').querySelector('.tzc-time')?.textContent).toBe('06:00');

    fireEvent.click(screen.getByRole('button', { name: 'Plan the current time' }));
    expect(slider.value).toBe('0');
    expect(screen.queryByText('Planning:')).not.toBeInTheDocument();
  });

  it('offsets use the ASCII hyphen-minus; differences keep the typographic minus (contract 4)', async () => {
    expect(utcOffsetLabel(-480)).toBe('UTC-08:00');
    expect(utcOffsetLabel(345)).toBe('UTC+05:45');
    expect(utcOffsetLabel(0)).toBe('UTC±0');
    await mountClock(legacy);
    const la = within(clockCard('UTC-08:00'));
    expect(la.getByText('UTC-08:00', { selector: 'dd' })).toBeInTheDocument();
    expect(la.getByText('−13h 45m')).toBeInTheDocument();
  });
});

// --- Settings: format examples ---

describe('format examples break only at sensible points (QA partial)', () => {
  it('splits before "T" and "[", after "," and spaces', () => {
    expect(examplePieces('1999-03-22T05:06:07,000[Europe/Paris]')).toEqual([
      '1999-03-22',
      'T05:06:07,',
      '000',
      '[Europe/Paris]',
    ]);
    expect(examplePieces('2024-01-02 15:04 UTC')).toEqual(['2024-01-02 ', '15:04 ', 'UTC']);
    expect(examplePieces('Tue, 22 Mar')).toEqual(['Tue, ', '22 ', 'Mar']);
    expect(examplePieces('1700000000')).toEqual(['1700000000']);
  });

  it('renders <wbr> between nowrap pieces, and the CSS keeps pieces whole', () => {
    render(<FormatsSection prefs={DEFAULT_PREFERENCES} update={vi.fn()} />);
    const code = Array.from(document.querySelectorAll('.tzx-format-ex code')).find(
      (c) => c.textContent === '1999-03-22T05:06:07,000[Europe/Paris]',
    );
    expect(code).toBeTruthy();
    expect(code?.innerHTML).toBe(
      '<span class="tzx-ex-piece">1999-03-22</span><wbr><span class="tzx-ex-piece">T05:06:07,</span><wbr>' +
        '<span class="tzx-ex-piece">000</span><wbr><span class="tzx-ex-piece">[Europe/Paris]</span>',
    );
    const css = readFileSync(resolve(root, 'src/popup/popup.css'), 'utf8');
    expect(css).toMatch(/\.tzx-format-ex \.tzx-ex-piece\s*\{[^}]*white-space:\s*nowrap/);
  });
});

// --- Website helpers ---

describe('website epoch mode accepts 0 and negative epochs (QA #14)', () => {
  it('reads one integer in seconds or milliseconds, like the popup', () => {
    expect(readEpochInput('0')).toEqual({ epochMs: 0, unit: 'seconds' });
    expect(readEpochInput('-1')).toEqual({ epochMs: -1000, unit: 'seconds' });
    expect(readEpochInput(' -1700000000 ')).toEqual({ epochMs: -1_700_000_000_000, unit: 'seconds' });
    expect(readEpochInput('\u22121')).toEqual({ epochMs: -1000, unit: 'seconds' });
    expect(readEpochInput('1700000000000')).toEqual({ epochMs: 1_700_000_000_000, unit: 'milliseconds' });
    expect(readEpochInput('abc')).toBeNull();
    expect(readEpochInput('1.5')).toBeNull();
    expect(readEpochInput('')).toBeNull();
  });

  it('wallClockNote explains gap and ambiguous readings', () => {
    const base: ParsedTime = {
      epochMs: Date.UTC(2024, 2, 10, 7, 30),
      matchedText: '2024-03-10 02:30',
      sourceZone: 'America/New_York',
      assumedZone: 'UTC',
      assumed: false,
      kind: 'iso',
    } as ParsedTime;
    expect(wallClockNote(base, false)).toBeNull();
    expect(wallClockNote({ ...base, wallClock: 'gap' }, false)).toBe(
      "02:30 doesn't exist on 10 Mar in New York (clocks jump forward); shown as 03:30.",
    );
    expect(
      wallClockNote({ ...base, epochMs: Date.UTC(2024, 10, 3, 5, 30), wallClock: 'ambiguous' }, false),
    ).toBe('01:30 happens twice on 3 Nov in New York; showing the first (EDT).');
  });
});

// Last: importing the website entry opts this module graph into web storage.
describe('website converter page (site/demo.ts)', () => {
  it('has the 12h | 24h segmented control, accepts 0 and -1 in Epoch mode, and shows ASCII offsets', async () => {
    localStorage.clear();
    const host = document.createElement('div');
    host.id = 'demo-app';
    document.body.append(host);
    await act(async () => {
      await import('../site/demo');
    });
    await waitFor(() => expect(host.querySelector('.demo-rows')).not.toBeNull());

    const group = within(host).getByRole('group', { name: 'Clock format' });
    const h12 = within(group).getByRole('button', { name: '12-hour clock' });
    const h24 = within(group).getByRole('button', { name: '24-hour clock' });
    expect(h12).toHaveAttribute('aria-pressed', String(DEFAULT_PREFERENCES.hour12));
    fireEvent.click(h24);
    expect(h24).toHaveAttribute('aria-pressed', 'true');
    expect(h12).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(h24);
    expect(h24).toHaveAttribute('aria-pressed', 'true');
    // The old single toggle chip is gone.
    expect(within(host).queryByRole('button', { name: /toggle 12 or 24/i })).toBeNull();

    const input = within(host).getByLabelText('Time to convert') as HTMLInputElement;
    fireEvent.click(within(host).getByRole('button', { name: 'Epoch' }));
    const hint = host.querySelector('.demo-hint') as HTMLElement;
    for (const [raw, iso] of [
      ['0', '1970-01-01T00:00:00.000Z'],
      ['-1', '1969-12-31T23:59:59.000Z'],
      ['-1700000000', '1916-02-18T01:46:40.000Z'],
    ] as const) {
      input.value = raw;
      fireEvent.input(input);
      expect(hint.className).toBe('demo-hint');
      expect(hint.textContent).toContain(iso);
    }
    input.value = 'yesterday';
    fireEvent.input(input);
    expect(hint.className).toContain('is-error');

    input.value = '0';
    fireEvent.input(input);
    const offs = Array.from(host.querySelectorAll('.demo-off')).map((e) => e.textContent ?? '');
    expect(offs.length).toBeGreaterThan(0);
    for (const o of offs) expect(o).not.toContain('\u2212');
    // America/New_York is in the default zones: UTC-05:00 at the epoch.
    expect(offs).toContain('UTC-05:00');
  });
});
