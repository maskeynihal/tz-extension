import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { Options } from '../src/options/Options';
import { FormatsSection } from '../src/options/Formats';
import { NoMatchCard, Popover } from '../src/content/Popover';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/types';
import { parseTimes } from '../src/lib/parse';

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
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(list).getAllByRole('switch')).toHaveLength(7);
    expect(within(list).getAllByText('Regular expression')).toHaveLength(7);
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
    fireEvent.change(screen.getByLabelText('Format name'), { target: { value: 'EU' } });
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
