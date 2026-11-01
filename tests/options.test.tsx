import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Options } from '../src/options/Options';
import { FormatsSection } from '../src/options/Formats';
import { NoMatchCard, Popover } from '../src/content/Popover';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';
import { parseTimes } from '../src/lib/parse';
import { BUILTIN_FORMATS } from '../src/lib/builtin-formats';

const base: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', hour12: false };

/** FormatsSection with real state, so edits flow back like on the settings page. */
function Harness({ initial, onChange }: { initial: Preferences; onChange?: (p: Preferences) => void }): JSX.Element {
  const [prefs, setPrefs] = useState(initial);
  return (
    <FormatsSection
      prefs={prefs}
      update={(p) => {
        setPrefs(p);
        onChange?.(p);
      }}
    />
  );
}

describe('Options page', () => {
  it('shows the select-to-convert switch and saves changes', async () => {
    render(<Options />);
    const sw = await screen.findByRole('switch', { name: 'Convert when I select text' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Selecting text does nothing/)).toBeInTheDocument();
    const sync = (globalThis as unknown as { chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.sync;
    await waitFor(() => expect(sync.set).toHaveBeenCalled());
    const saved = sync.set.mock.calls.at(-1)?.[0]['tz-extension-prefs'];
    expect(saved.selectToConvert).toBe(false);
  });

  it('shows a banner when saving fails', async () => {
    const sync = (globalThis as unknown as { chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.sync;
    render(<Options />);
    const sw = await screen.findByRole('switch', { name: 'Keep selection highlighted' });
    sync.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    fireEvent.click(sw);
    expect(await screen.findByRole('alert')).toHaveTextContent(/too large for browser sync storage/);
  });
});

describe('FormatsSection', () => {
  it('lists every built-in format with an on/off switch and its regex', () => {
    render(<Harness initial={base} />);
    const list = screen.getByRole('list', { name: 'Built-in formats' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(BUILTIN_FORMATS.length);
    expect(within(list).getAllByRole('switch')).toHaveLength(BUILTIN_FORMATS.length);
    expect(within(list).getAllByText('Regular expression')).toHaveLength(BUILTIN_FORMATS.length);
  });

  it('switching a built-in off stores its id and the tester stops matching it', () => {
    const onChange = vi.fn();
    render(<Harness initial={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Unix epoch (seconds) format' }));
    expect(onChange.mock.calls.at(-1)?.[0].disabledFormats).toEqual(['epoch-seconds']);
    fireEvent.change(screen.getByLabelText('Test text'), { target: { value: '1700000000' } });
    expect(screen.getByText('No enabled format recognizes this text.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn all on' }));
    expect(onChange.mock.calls.at(-1)?.[0].disabledFormats).toEqual([]);
    expect(screen.getByText('Unix epoch (seconds)', { selector: '.tzx-badge' })).toBeInTheDocument();
  });

  it('explains an invalid pattern and blocks adding it', () => {
    render(<Harness initial={base} />);
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'MM/YYYY' } });
    expect(screen.getByText(/needs both a month/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add format' })).toBeDisabled();
  });

  it('adds, previews, edits, toggles and removes a custom format', () => {
    const onChange = vi.fn();
    render(<Harness initial={base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'DD/MM/YYYY HH:mm' } });
    fireEvent.change(screen.getByLabelText('Format name (optional)'), { target: { value: 'EU' } });
    fireEvent.change(screen.getByLabelText('Sample text to test'), { target: { value: 'at 31/12/2024 10:30' } });
    expect(screen.getByText(/2024-12-31T10:30:00.000Z/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add format' }));

    let saved: Preferences = onChange.mock.calls.at(-1)?.[0];
    expect(saved.customFormats).toHaveLength(1);
    expect(saved.customFormats[0]).toMatchObject({ label: 'EU', pattern: 'DD/MM/YYYY HH:mm', enabled: true });
    // The form resets after adding.
    expect(screen.getByLabelText('Format pattern')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Edit EU' }));
    expect(screen.getByLabelText('Format pattern')).toHaveValue('DD/MM/YYYY HH:mm');
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'DD.MM.YYYY HH:mm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    saved = onChange.mock.calls.at(-1)?.[0];
    expect(saved.customFormats).toHaveLength(1);
    expect(saved.customFormats[0]?.pattern).toBe('DD.MM.YYYY HH:mm');

    fireEvent.click(screen.getByRole('switch', { name: 'EU format' }));
    saved = onChange.mock.calls.at(-1)?.[0];
    expect(saved.customFormats[0]?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove EU' }));
    saved = onChange.mock.calls.at(-1)?.[0];
    expect(saved.customFormats).toHaveLength(0);
  });

  it('flags a saved custom format that no longer compiles', () => {
    render(
      <Harness
        initial={{ ...base, customFormats: [{ id: 'x', label: 'Old', pattern: 'MM/YYYY', advanced: false, enabled: true }] }}
      />,
    );
    expect(screen.getByText(/Not used:/)).toBeInTheDocument();
  });

  it('supports advanced regex mode with group help', () => {
    render(<Harness initial={base} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }));
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: '(?<year>\\d{4})' } });
    expect(screen.getByText(/Unknown group/)).toBeInTheDocument();
    expect(screen.getByText('Group names')).toBeInTheDocument();
  });
});

describe('in-page cards', () => {
  it('Popover shows which format matched', () => {
    const [parsed] = parseTimes('2024-01-02T15:04:05Z', 'UTC');
    render(<Popover parsed={parsed!} matchCount={1} prefs={base} pinned={false} onClose={() => {}} />);
    expect(screen.getByText('format: ISO 8601')).toBeInTheDocument();
  });

  it('NoMatchCard quotes the selection and offers settings', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<NoMatchCard text={`  hello\n   world ${'x'.repeat(200)}`} onClose={onClose} onOpenSettings={onOpen} />);
    expect(screen.getByRole('dialog', { name: 'No time recognized' })).toHaveTextContent(/“hello world x+…”/);
    fireEvent.click(screen.getByRole('button', { name: 'Open format settings' }));
    expect(onOpen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('settings robustness', () => {
  type SyncMock = {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  const chromeMock = (): {
    storage: { sync: SyncMock; onChanged: { addListener: ReturnType<typeof vi.fn> } };
  } =>
    (globalThis as unknown as {
      chrome: { storage: { sync: SyncMock; onChanged: { addListener: ReturnType<typeof vi.fn> } } };
    }).chrome;

  it('applies a change made elsewhere even while its own save is in flight', async () => {
    render(<Options />);
    const sw = await screen.findByRole('switch', { name: 'Keep selection highlighted' });
    const onChanged = chromeMock().storage.onChanged.addListener.mock.calls.at(-1)?.[0] as (
      c: Record<string, { newValue: unknown }>,
      a: string,
    ) => void;
    // Hold our own save open.
    let finish: () => void = () => {};
    chromeMock().storage.sync.set.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    fireEvent.click(sw);
    // Another context switches select-to-convert off meanwhile.
    onChanged({ 'tz-extension-prefs': { newValue: { ...base, keepSelection: false, selectToConvert: false } } }, 'sync');
    expect(await screen.findByRole('switch', { name: 'Convert when I select text' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    finish();
  });

  it('goes back to the stored settings when a save fails', async () => {
    render(<Options />);
    const sw = await screen.findByRole('switch', { name: 'Convert when I select text' });
    chromeMock().storage.sync.set.mockRejectedValueOnce(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
    fireEvent.click(sw);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('blocks adding a duplicate custom format', () => {
    render(
      <Harness
        initial={{ ...base, customFormats: [{ id: 'x', label: 'EU', pattern: 'DD/MM/YYYY', advanced: false, enabled: true }] }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'DD/MM/YYYY' } });
    expect(screen.getByText(/You already have this format \(“EU”\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add format' })).toBeDisabled();
  });

  it('shows a warning for letters that are matched literally', () => {
    render(<Harness initial={base} />);
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'DD/MM/YYYY ZZ' } });
    expect(screen.getByText(/Z is not a token/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add format' })).toBeEnabled();
  });

  it('gives each timezone picker its own accessible name and closes it when focus leaves', async () => {
    render(<Options />);
    const home = await screen.findByRole('combobox', { name: 'Home timezone' });
    const add = screen.getByRole('combobox', { name: 'Add a target timezone' });
    expect(home.id).not.toBe(add.id);
    fireEvent.focus(home);
    expect(home).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(home, { key: 'ArrowDown' });
    expect(home.getAttribute('aria-activedescendant')).toMatch(/opt-1$/);
    fireEvent.blur(home, { relatedTarget: document.body });
    expect(home).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('settings robustness, round 2', () => {
  const chromeMock = (): {
    storage: {
      sync: { set: ReturnType<typeof vi.fn> };
      onChanged: { addListener: ReturnType<typeof vi.fn> };
    };
  } =>
    (globalThis as unknown as {
      chrome: {
        storage: { sync: { set: ReturnType<typeof vi.fn> }; onChanged: { addListener: ReturnType<typeof vi.fn> } };
      };
    }).chrome;

  it('two quick local changes end on the second, even when echoes arrive late', async () => {
    render(<Options />);
    const sw = await screen.findByRole('switch', { name: 'Convert when I select text' });
    const onChanged = chromeMock().storage.onChanged.addListener.mock.calls.at(-1)?.[0] as (
      c: Record<string, { newValue: unknown }>,
      a: string,
    ) => void;
    fireEvent.click(sw); // A1: off
    fireEvent.click(sw); // A2: on
    await waitFor(() => expect(chromeMock().storage.sync.set.mock.calls.length).toBeGreaterThanOrEqual(2));
    const calls = chromeMock().storage.sync.set.mock.calls.map((c) => c[0]['tz-extension-prefs']);
    // Echo A1, then A2.
    onChanged({ 'tz-extension-prefs': { newValue: calls.at(-2) } }, 'sync');
    onChanged({ 'tz-extension-prefs': { newValue: calls.at(-1) } }, 'sync');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('treats patterns that differ only in spacing as duplicates', () => {
    render(
      <Harness
        initial={{ ...base, customFormats: [{ id: 'x', label: 'EU', pattern: 'DD/MM/YYYY HH:mm', advanced: false, enabled: true }] }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: '  DD/MM/YYYY   HH:mm ' } });
    expect(screen.getByText(/You already have this format/)).toBeInTheDocument();
  });

  it('says when the layout matches but the values are impossible', () => {
    render(<Harness initial={base} />);
    fireEvent.change(screen.getByLabelText('Format pattern'), { target: { value: 'DD/MM/YYYY' } });
    fireEvent.change(screen.getByLabelText('Sample text to test'), { target: { value: '31/02/2024' } });
    expect(screen.getByText(/layout matches, but the values are not a real date/)).toBeInTheDocument();
  });

  it('blocks a format that would not fit in browser sync storage', () => {
    const big = Array.from({ length: 25 }, (_, i) => ({
      id: `f${i}`,
      label: 'x'.repeat(60),
      pattern: `(?<d>\\d{2})\\.(?<mo>\\d{2})\\.(?<y>\\d{4})${'[a-z]{0,1}'.repeat(25)}${i}`,
      advanced: true,
      enabled: true,
    }));
    render(<Harness initial={{ ...base, customFormats: big }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regular expression' }));
    fireEvent.change(screen.getByLabelText('Format pattern'), {
      target: { value: '(?<d>\\d{2})-(?<mo>\\d{2})-(?<y>\\d{4})' },
    });
    expect(screen.getByText(/Not enough room in browser sync storage/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add format' })).toBeDisabled();
  });
});

// ---- Tabbed layout, new card settings and the sortable zone list ----------

type SetMock = ReturnType<typeof vi.fn>;
const syncSet = (): SetMock =>
  (globalThis as unknown as { chrome: { storage: { sync: { set: SetMock } } } }).chrome.storage.sync.set;
const lastSaved = (): Preferences | undefined => syncSet().mock.calls.at(-1)?.[0]['tz-extension-prefs'];

/** jsdom has no PointerEvent; a MouseEvent with the pointer fields is enough for React. */
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** Rows are 40px tall with a 10px gap, starting 100px down the viewport, in DOM order. */
function mockRowRects(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = (top: number, height: number): DOMRect =>
      ({ top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    if (this instanceof HTMLElement && this.dataset.sortKey !== undefined && this.parentElement) {
      const rows = Array.from(this.parentElement.children).filter(
        (c) => c instanceof HTMLElement && c.dataset.sortKey !== undefined && c.dataset.sortExit === undefined,
      );
      return rect(100 + rows.indexOf(this) * 50, 40);
    }
    if (this.classList.contains('tzx-sort-list')) return rect(100, this.children.length * 50 - 10);
    return rect(0, 0);
  });
}

/** A Web Animation stand-in that tests can finish by hand. */
function stubAnimate(): { calls: SetMock; finishAll: () => void } {
  const anims: EventTarget[] = [];
  const calls = vi.fn((_keyframes: Keyframe[], _opts?: KeyframeAnimationOptions) => {
    const a = new EventTarget();
    Object.assign(a, { cancel: () => a.dispatchEvent(new Event('cancel')), finish: () => a.dispatchEvent(new Event('finish')) });
    anims.push(a);
    return a as unknown as Animation;
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function (this: Element, k: Keyframe[], o?: KeyframeAnimationOptions) {
      return calls(k, o);
    },
  });
  return { calls, finishAll: () => anims.forEach((a) => a.dispatchEvent(new Event('finish'))) };
}

const ZONES = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kathmandu'];

async function renderOptions(): Promise<HTMLElement> {
  render(<Options />);
  return screen.findByRole('list', { name: 'Target timezones' });
}

function rowKeys(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('listitem')
    .map((li) => li.dataset.sortKey ?? '');
}

describe('settings layout', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    scrollIntoView.mockClear();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('has a section tab bar whose active tab follows clicks', async () => {
    render(<Options />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['General', '#general'],
      ['Cards', '#cards'],
      ['Timezones', '#timezones'],
      ['Formats', '#formats'],
    ]);
    expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(within(nav).getByRole('link', { name: 'Cards' }));
    expect(within(nav).getByRole('link', { name: 'Cards' })).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('link', { name: 'General' })).not.toHaveAttribute('aria-current');
    expect(window.location.hash).toBe('#cards');
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById('cards'));
    expect(scrollIntoView.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: 'smooth', block: 'start' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Cards' }));
  });

  it('jumps without smooth scrolling when motion is reduced', async () => {
    stubMatchMedia(true);
    render(<Options />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Timezones' }));
    expect(scrollIntoView.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: 'auto' });
  });

  it('groups settings into sections with headings and ids', async () => {
    render(<Options />);
    await screen.findByRole('navigation', { name: 'Settings sections' });
    for (const [id, name] of [
      ['general', 'General'],
      ['cards', 'Cards'],
      ['timezones', 'Timezones'],
      ['formats', 'Recognized formats'],
    ] as const) {
      const section = document.getElementById(id);
      expect(section).not.toBeNull();
      expect(within(section as HTMLElement).getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    const general = document.getElementById('general') as HTMLElement;
    expect(within(general).getByRole('switch', { name: 'Convert when I select text' })).toBeInTheDocument();
    expect(within(general).getByRole('combobox', { name: 'Home timezone' })).toBeInTheDocument();
    const cards = document.getElementById('cards') as HTMLElement;
    expect(within(cards).getByRole('group', { name: 'Card size on open' })).toBeInTheDocument();
    expect(within(cards).getByRole('switch', { name: 'Keep selection highlighted' })).toBeInTheDocument();
  });

  it('follows a deep link to a section after load', async () => {
    window.history.replaceState(null, '', '#formats');
    render(<Options />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    await waitFor(() => expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById('formats')));
    expect(within(nav).getByRole('link', { name: 'Formats' })).toHaveAttribute('aria-current', 'true');
  });

  it('moves the active tab with the section in view (scrollspy)', async () => {
    let fire: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
          fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    render(<Options />);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    act(() => fire([{ target: document.getElementById('timezones') as Element, isIntersecting: true }]));
    expect(within(nav).getByRole('link', { name: 'Timezones' })).toHaveAttribute('aria-current', 'true');
  });

  it('saves the card size on open and explains "Last used"', async () => {
    render(<Options />);
    const group = await screen.findByRole('group', { name: 'Card size on open' });
    expect(screen.getByText(/Last used opens the card the way you last left it \(currently: Full\)/)).toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Compact' }));
    expect(within(group).getByRole('button', { name: 'Compact' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(lastSaved()?.cardSize).toBe('compact'));
    fireEvent.click(within(group).getByRole('button', { name: 'Last used' }));
    await waitFor(() => expect(lastSaved()?.cardSize).toBe('last'));
  });

  it('chooses the clock format with a labelled two-option control', async () => {
    render(<Options />);
    const group = await screen.findByRole('group', { name: 'Clock format' });
    const h12 = within(group).getByRole('button', { name: /^12-hour/ });
    const h24 = within(group).getByRole('button', { name: /^24-hour/ });
    // Nothing stored yet: the default is 12-hour.
    expect(h12).toHaveAttribute('aria-pressed', 'true');
    expect(h24).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(h24);
    expect(h24).toHaveAttribute('aria-pressed', 'true');
    expect(h12).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(lastSaved()?.hour12).toBe(false));
    fireEvent.click(h12);
    await waitFor(() => expect(lastSaved()?.hour12).toBe(true));
  });

  it('saves the numeric date order', async () => {
    render(<Options />);
    const group = await screen.findByRole('group', { name: 'Numeric date order' });
    fireEvent.click(within(group).getByRole('button', { name: 'Day first (22/03/1999)' }));
    await waitFor(() => expect(lastSaved()?.numericDateOrder).toBe('dmy'));
    fireEvent.click(within(group).getByRole('button', { name: 'Month first (03/22/1999)' }));
    await waitFor(() => expect(lastSaved()?.numericDateOrder).toBe('mdy'));
    expect(within(group).getByRole('button', { name: 'Month first (03/22/1999)' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('target timezone reordering', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', FakePointerEvent);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).animate;
    document.documentElement.classList.remove('tzx-sort-grabbing');
  });

  it('shows each zone with its label, time and a drag handle', async () => {
    const list = await renderOptions();
    expect(rowKeys(list)).toEqual(ZONES);
    const row = within(list).getAllByRole('listitem')[2] as HTMLElement;
    expect(within(row).getByText('Europe/London')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Drag to reorder Europe/London' })).toBeInTheDocument();
    expect(row.querySelector('.tzx-zone-time')?.textContent).toMatch(/\d/);
  });

  it('Alt+ArrowUp moves the focused row, saves, announces and keeps focus', async () => {
    const list = await renderOptions();
    const handle = screen.getByRole('button', { name: 'Drag to reorder Europe/London' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp', altKey: true });
    expect(rowKeys(list)).toEqual(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu']);
    await waitFor(() => expect(lastSaved()?.targetZones).toEqual(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kathmandu']));
    expect(screen.getByText('Moved Europe/London to position 2 of 4')).toHaveAttribute('aria-live', 'polite');
    expect(document.activeElement).toBe(handle);

    // Alt+ArrowDown on the row itself works too; without Alt nothing moves.
    const row = handle.closest('li') as HTMLElement;
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    expect(rowKeys(list)[1]).toBe('Europe/London');
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    expect(rowKeys(list)[2]).toBe('Europe/London');
    await waitFor(() => expect(lastSaved()?.targetZones?.[2]).toBe('Europe/London'));
  });

  it('the ↑ ↓ buttons still move rows', async () => {
    const list = await renderOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Move UTC down' }));
    expect(rowKeys(list)).toEqual(['America/New_York', 'UTC', 'Europe/London', 'Asia/Kathmandu']);
    await waitFor(() => expect(lastSaved()?.targetZones?.[1]).toBe('UTC'));
    expect(screen.getByRole('button', { name: 'Move America/New_York up' })).toBeDisabled();
  });

  it('dragging a row with the pointer reorders and saves once, on drop', async () => {
    mockRowRects();
    const capture = vi.fn();
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, writable: true, value: capture });
    const list = await renderOptions();
    const handle = screen.getByRole('button', { name: 'Drag to reorder UTC' });
    const dragged = handle.closest('li') as HTMLElement;
    const london = within(list).getAllByRole('listitem')[2] as HTMLElement;
    const savesBefore = syncSet().mock.calls.length;

    fireEvent.pointerDown(handle, { pointerId: 7, clientY: 120, button: 0 });
    expect(capture).toHaveBeenCalledWith(7);
    expect(dragged).toHaveAttribute('data-sort-dragging');
    fireEvent.pointerMove(handle, { pointerId: 7, clientY: 180 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientY: 230 });
    // The dragged row follows the pointer; the rows it passed make room.
    expect(dragged.style.transform).toContain('translateY(110px)');
    expect(london.style.transform).toBe('translateY(-50px)');
    expect(syncSet().mock.calls.length).toBe(savesBefore);

    fireEvent.pointerUp(handle, { pointerId: 7, clientY: 230 });
    expect(rowKeys(list)).toEqual(['America/New_York', 'Europe/London', 'UTC', 'Asia/Kathmandu']);
    await waitFor(() => expect(lastSaved()?.targetZones).toEqual(['America/New_York', 'Europe/London', 'UTC', 'Asia/Kathmandu']));
    expect(syncSet().mock.calls.length).toBe(savesBefore + 1);
    expect(screen.getByText('Moved UTC to position 3 of 4')).toBeInTheDocument();
    expect(dragged.style.transform).toBe('');
    expect(london.style.transform).toBe('');
    expect(dragged).not.toHaveAttribute('data-sort-dragging');
    delete (Element.prototype as Partial<Element>).setPointerCapture;
  });

  it('Escape during a drag puts the row back and saves nothing', async () => {
    mockRowRects();
    const list = await renderOptions();
    const handle = screen.getByRole('button', { name: 'Drag to reorder UTC' });
    const dragged = handle.closest('li') as HTMLElement;
    const savesBefore = syncSet().mock.calls.length;
    fireEvent.pointerDown(handle, { pointerId: 3, clientY: 120, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 230 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dragged.style.transform).toBe('');
    expect(screen.getByText(/Reorder cancelled\. UTC stays at position 1 of 4/)).toBeInTheDocument();
    // The pointer coming up afterwards is not a drop.
    fireEvent.pointerUp(handle, { pointerId: 3, clientY: 230 });
    expect(rowKeys(list)).toEqual(ZONES);
    expect(syncSet().mock.calls.length).toBe(savesBefore);
    expect(document.documentElement).not.toHaveClass('tzx-sort-grabbing');
  });

  it('losing pointer capture mid-drag cancels it, and the next drag still works', async () => {
    mockRowRects();
    const list = await renderOptions();
    const handle = screen.getByRole('button', { name: 'Drag to reorder UTC' });
    const dragged = handle.closest('li') as HTMLElement;
    const savesBefore = syncSet().mock.calls.length;
    fireEvent.pointerDown(handle, { pointerId: 4, clientY: 120, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 4, clientY: 230 });
    expect(dragged.style.transform).toContain('translateY(110px)');

    fireEvent.lostPointerCapture(handle, { pointerId: 4 });
    expect(dragged.style.transform).toBe('');
    expect(dragged).not.toHaveAttribute('data-sort-dragging');
    expect(screen.getByText(/Reorder cancelled\. UTC stays at position 1 of 4/)).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass('tzx-sort-grabbing');
    fireEvent.pointerUp(handle, { pointerId: 4, clientY: 230 });
    expect(rowKeys(list)).toEqual(ZONES);
    expect(syncSet().mock.calls.length).toBe(savesBefore);

    fireEvent.pointerDown(handle, { pointerId: 5, clientY: 120, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientY: 230 });
    fireEvent.pointerUp(handle, { pointerId: 5, clientY: 230 });
    expect(rowKeys(list)).toEqual(['America/New_York', 'Europe/London', 'UTC', 'Asia/Kathmandu']);
    await waitFor(() => expect(lastSaved()?.targetZones).toEqual(['America/New_York', 'Europe/London', 'UTC', 'Asia/Kathmandu']));
  });

  it('a drag whose pointerup never arrived does not block the next drag', async () => {
    mockRowRects();
    const list = await renderOptions();
    const utc = screen.getByRole('button', { name: 'Drag to reorder UTC' });
    const utcRow = utc.closest('li') as HTMLElement;
    // Stuck: pressed and moved, but the release was lost (no capture held).
    fireEvent.pointerDown(utc, { pointerId: 8, clientY: 120, button: 0 });
    fireEvent.pointerMove(utc, { pointerId: 8, clientY: 180 });

    const kathmandu = screen.getByRole('button', { name: 'Drag to reorder Asia/Kathmandu' });
    const kathRow = kathmandu.closest('li') as HTMLElement;
    fireEvent.pointerDown(kathmandu, { pointerId: 9, clientY: 270, button: 0 });
    // The stuck drag was dropped and its row put back.
    expect(utcRow).not.toHaveAttribute('data-sort-dragging');
    expect(utcRow.style.transform).toBe('');
    expect(kathRow).toHaveAttribute('data-sort-dragging');
    fireEvent.pointerMove(kathmandu, { pointerId: 9, clientY: 120 });
    fireEvent.pointerUp(kathmandu, { pointerId: 9, clientY: 120 });
    expect(rowKeys(list)).toEqual(['Asia/Kathmandu', 'UTC', 'America/New_York', 'Europe/London']);
    await waitFor(() =>
      expect(lastSaved()?.targetZones).toEqual(['Asia/Kathmandu', 'UTC', 'America/New_York', 'Europe/London']),
    );
  });

  it('the remove button removes the zone and moves focus to the next row', async () => {
    const list = await renderOptions();
    const remove = screen.getByRole('button', { name: 'Remove Europe/London' });
    remove.focus();
    fireEvent.click(remove);
    expect(rowKeys(list)).toEqual(['UTC', 'America/New_York', 'Asia/Kathmandu']);
    await waitFor(() => expect(lastSaved()?.targetZones).toEqual(['UTC', 'America/New_York', 'Asia/Kathmandu']));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Drag to reorder Asia/Kathmandu' }));
    expect(screen.getByRole('heading', { name: 'Target timezones (3)' })).toBeInTheDocument();
  });

  it('animates moves and removals when motion is allowed', async () => {
    stubMatchMedia(false);
    mockRowRects();
    const { calls, finishAll } = stubAnimate();
    const list = await renderOptions();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Europe/London' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    // FLIP: both swapped rows slide from where they were.
    const moves = calls.mock.calls.map((c) => (c[0] as Keyframe[])[0]?.transform);
    expect(moves).toEqual(expect.arrayContaining(['translateY(50px)', 'translateY(-50px)']));

    calls.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Remove UTC' }));
    expect(calls).toHaveBeenCalledTimes(1);
    // Saved only once the collapse finishes.
    expect(rowKeys(list)).toContain('UTC');
    act(() => finishAll());
    expect(rowKeys(list)).not.toContain('UTC');
    await waitFor(() => expect(lastSaved()?.targetZones).not.toContain('UTC'));
  });

  it('with reduced motion nothing is animated and changes are instant', async () => {
    stubMatchMedia(true);
    mockRowRects();
    const { calls } = stubAnimate();
    const list = await renderOptions();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Europe/London' }), {
      key: 'ArrowUp',
      altKey: true,
    });
    const handle = screen.getByRole('button', { name: 'Drag to reorder UTC' });
    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 120, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 230 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 230 });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Asia/Kathmandu' }));
    expect(rowKeys(list)).toEqual(['Europe/London', 'America/New_York', 'UTC']);
    expect(calls).not.toHaveBeenCalled();
    await waitFor(() => expect(lastSaved()?.targetZones).toEqual(['Europe/London', 'America/New_York', 'UTC']));
  });
});
