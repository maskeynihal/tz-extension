import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { EpochTab } from '../src/popup/EpochTab';
import { Converter } from '../src/popup/Converter';
import { ZonePicker } from '../src/popup/ZonePicker';
import { Popover } from '../src/content/Popover';
import { type Preferences } from '../src/types';
import { parseTimes } from '../src/lib/parse';

const prefs: Preferences = {
  homeZone: 'UTC',
  targetZones: ['UTC', 'Asia/Kathmandu'],
  hour12: false,
  dateOnlyPolicy: 'midnight',
  keepSelection: true,
  theme: 'system',
  customFormats: [],
};

describe('EpochTab', () => {
  it('converts a 10-digit epoch to ISO UTC', () => {
    render(<EpochTab prefs={prefs} />);
    fireEvent.change(screen.getByLabelText('Unix epoch timestamp'), {
      target: { value: '1700000000' },
    });
    expect(screen.getByText('2023-11-14T22:13:20.000Z')).toBeInTheDocument();
    expect(screen.getByText('detected: seconds')).toBeInTheDocument();
  });

  it('shows an error for non-numeric input', () => {
    render(<EpochTab prefs={prefs} />);
    fireEvent.change(screen.getByLabelText('Unix epoch timestamp'), {
      target: { value: 'nope' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/valid epoch/i);
  });

  it('honors a forced milliseconds unit', () => {
    render(<EpochTab prefs={prefs} />);
    fireEvent.change(screen.getByLabelText('Unix epoch timestamp'), {
      target: { value: '1700000000' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'milliseconds' }));
    // 1700000000 ms = 1970-01-20T...
    expect(screen.getByText(/1970-01-20T/)).toBeInTheDocument();
  });
});

describe('Converter', () => {
  it('renders a result card per target zone', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Date & time'), {
      target: { value: '2024-01-02T12:00' },
    });
    const cards = document.querySelectorAll('.tzx-result-card');
    expect(cards.length).toBe(prefs.targetZones.length);
  });

  it('shows an error when the datetime is cleared', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Date & time'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('ZonePicker', () => {
  it('filters by query and selects a zone', () => {
    const onSelect = vi.fn();
    render(<ZonePicker label="Add zone" onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'kathman' } });
    const option = screen.getByText('Asia/Kathmandu');
    fireEvent.mouseDown(option);
    expect(onSelect).toHaveBeenCalledWith('Asia/Kathmandu');
  });

  it('shows "no matching" for gibberish', () => {
    render(<ZonePicker label="Add zone" onSelect={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzqqq' } });
    expect(screen.getByText(/no matching/i)).toBeInTheDocument();
  });
});

describe('Popover', () => {
  it('renders the matched text and a row per target zone', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    expect(parsed).toBeDefined();
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/2024-01-02T12:00:00Z/)).toBeInTheDocument();
    const zoneLabels = Array.from(dialog.querySelectorAll('.tzx-zone')).map(
      (n) => n.textContent,
    );
    expect(zoneLabels).toContain('UTC');
    expect(zoneLabels).toContain('Asia/Kathmandu');
  });

  it('shows the date for each zone row', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    // The UTC row must show the calendar date, not only the time.
    expect(within(dialog).getAllByText(/2024-01-02/).length).toBeGreaterThan(0);
  });

  it('labels an assumed zone', () => {
    const [parsed] = parseTimes('3pm', 'UTC');
    expect(parsed?.assumed).toBe(true);
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/assumed/i)).toBeInTheDocument();
  });

  it('fires onClose from the close button', () => {
    const onClose = vi.fn();
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={onClose} />,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a pin button only when transient and fires onPin', () => {
    const onPin = vi.fn();
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover
        parsed={parsed!}
        matchCount={1}
        prefs={prefs}
        pinned={false}
        onPin={onPin}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Pin to page'));
    expect(onPin).toHaveBeenCalled();
  });

  it('hides the pin button on an already-pinned card', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover
        parsed={parsed!}
        matchCount={1}
        prefs={prefs}
        pinned
        onPin={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Pin to page')).toBeNull();
  });

  it('adds a timezone row via the dropdown', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    const before = dialog.querySelectorAll('.tzx-zone').length;
    fireEvent.change(screen.getByLabelText('Add a timezone'), {
      target: { value: 'Asia/Tokyo' },
    });
    const labels = Array.from(dialog.querySelectorAll('.tzx-zone')).map((n) => n.textContent);
    expect(labels).toContain('Asia/Tokyo');
    expect(dialog.querySelectorAll('.tzx-zone').length).toBe(before + 1);
  });

  it('removes a timezone row via its × button', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover parsed={parsed!} matchCount={1} prefs={prefs} pinned={false} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByLabelText('Remove UTC'));
    const labels = Array.from(dialog.querySelectorAll('.tzx-zone')).map((n) => n.textContent);
    expect(labels).not.toContain('UTC');
  });
});

describe('Popover compact mode', () => {
  it('compact hides the source line and add dropdown, shows time rows', () => {
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover
        parsed={parsed!}
        matchCount={1}
        prefs={prefs}
        pinned
        compact
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    // No "read as" source line, no add-timezone select in compact mode.
    expect(within(dialog).queryByText(/read as/i)).toBeNull();
    expect(screen.queryByLabelText('Add a timezone')).toBeNull();
    // Still shows the converted zone rows.
    expect(dialog.querySelectorAll('.tzx-zone').length).toBeGreaterThan(0);
    expect(dialog.classList.contains('compact')).toBe(true);
  });

  it('a transient card offers both a full-pin and a compact-pin button', () => {
    const onPin = vi.fn();
    const onPinCompact = vi.fn();
    const [parsed] = parseTimes('2024-01-02T12:00:00Z', 'UTC');
    render(
      <Popover
        parsed={parsed!}
        matchCount={1}
        prefs={prefs}
        pinned={false}
        onPin={onPin}
        onPinCompact={onPinCompact}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Pin compact'));
    expect(onPinCompact).toHaveBeenCalled();
    expect(onPin).not.toHaveBeenCalled();
  });
});

describe('Converter source + target editing', () => {
  it('removes a target zone via its ✕ and persists', () => {
    const onPrefsChange = vi.fn();
    render(<Converter prefs={prefs} onPrefsChange={onPrefsChange} />);
    fireEvent.click(screen.getByLabelText('Remove UTC'));
    expect(onPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetZones: expect.not.arrayContaining(['UTC']) }),
    );
  });

  it('offers a Local source button', () => {
    render(<Converter prefs={prefs} onPrefsChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /local/i })).toBeInTheDocument();
  });
});
