import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ZonePicker, ZONE_PICKER_CSS } from '../src/popup/ZonePicker';
import * as tz from '../src/lib/tz';

// Pass-through spy, to count searches.
vi.mock('../src/lib/tz', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/tz')>();
  return { ...real, searchZones: vi.fn(real.searchZones) };
});

function setup(props: Partial<Parameters<typeof ZonePicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onParentKey = vi.fn();
  const utils = render(
    // The surrounding card listens for Escape on an ancestor.
    <div onKeyDown={(e) => onParentKey(e.key)}>
      <ZonePicker label="Add a timezone" onSelect={onSelect} {...props} />
    </div>,
  );
  const input = screen.getByRole('combobox', { name: 'Add a timezone' });
  return { ...utils, input, onSelect, onParentKey };
}

const options = (): HTMLElement[] => screen.queryAllByRole('option');
const activeOption = (input: HTMLElement): HTMLElement | null => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('ZonePicker keyboard', () => {
  it('Home and End move to the first and last option', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'america' } });
    const all = options();
    expect(all.length).toBeGreaterThan(5);
    fireEvent.keyDown(input, { key: 'End' });
    expect(activeOption(input)).toBe(all[all.length - 1]);
    expect(all[all.length - 1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeOption(input)).toBe(all[0]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toBe(all[1]);
  });

  it('keeps aria-activedescendant on a rendered option, and drops it when the list closes', () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(activeOption(input)).toHaveAttribute('role', 'option');
    expect(within(list).getAllByRole('group').length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('Enter picks the active option', () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: 'mumbai' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('Asia/Kolkata');
  });
});

describe('ZonePicker Escape contract', () => {
  it('first Escape clears the query and closes the list without reaching the card; the next one does', () => {
    const { input, onParentKey } = setup();
    fireEvent.change(input, { target: { value: 'tok' } });
    expect(options().length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onParentKey).not.toHaveBeenCalledWith('Escape');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onParentKey).toHaveBeenCalledWith('Escape');
  });

  it('an open list with an empty query also takes one Escape', () => {
    const { input, onParentKey } = setup();
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onParentKey).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onParentKey).toHaveBeenCalledWith('Escape');
  });

  it('other keys stay inside the picker', () => {
    const { input, onParentKey } = setup();
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'k' });
    expect(onParentKey).not.toHaveBeenCalled();
  });
});

describe('ZonePicker results', () => {
  it('shows "Already added" when the query names an excluded zone', () => {
    const { input } = setup({ exclude: ['Asia/Kathmandu'] });
    fireEvent.change(input, { target: { value: 'kathmandu' } });
    expect(screen.getByRole('option')).toHaveTextContent('Already added: Asia/Kathmandu');
    expect(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('treats a saved legacy id as the same zone', () => {
    const { input } = setup({ exclude: ['Asia/Katmandu'] });
    fireEvent.change(input, { target: { value: 'Kathmandu' } });
    expect(screen.getByRole('option')).toHaveTextContent('Already added: Asia/Kathmandu');
  });

  it('still says "No matching timezone" for gibberish', () => {
    const { input } = setup({ exclude: ['Asia/Kathmandu'] });
    fireEvent.change(input, { target: { value: 'zzzqqq' } });
    expect(screen.getByRole('option')).toHaveTextContent('No matching timezone');
  });

  it('shows the alias a result matched', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'mumbai' } });
    const first = options()[0] as HTMLElement;
    expect(first).toHaveTextContent('Asia/Kolkata');
    expect(first).toHaveTextContent('Mumbai');
  });

  it('accepts a Unicode minus', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'UTC−5' } });
    // Input may use U+2212; the label shows the ASCII hyphen-minus (copy-safe).
    expect(options()[0]).toHaveTextContent('UTC-05:00');
    expect(options()[0]).not.toHaveTextContent('−');
  });

  it('does not search again on a re-render with default props', () => {
    const search = vi.mocked(tz.searchZones);
    const { input, rerender } = setup();
    fireEvent.change(input, { target: { value: 'tok' } });
    const calls = search.mock.calls.length;
    const onSelect = vi.fn();
    rerender(
      <div>
        <ZonePicker label="Add a timezone" onSelect={onSelect} />
      </div>,
    );
    rerender(
      <div>
        <ZonePicker label="Add a timezone" onSelect={onSelect} />
      </div>,
    );
    expect(search.mock.calls.length).toBe(calls);
  });
});

/** WCAG relative luminance of "#rrggbb". */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The last declaration of `prop` in rules whose selector ends with `selector`, within the given CSS block. */
function declared(css: string, selector: string, prop: string): string {
  let value = '';
  css = css.replace(/@media[^{]*\{/g, '');
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sels = (m[1] as string).split(',').map((s) => s.trim());
    // The selector itself, optionally behind a :host(...) theme prefix (no other classes).
    const hit = (s: string): boolean =>
      s === selector || (s.endsWith(` ${selector}`) && !s.slice(0, -selector.length).includes('.tzx-'));
    if (!sels.some(hit)) continue;
    const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b`).exec(m[2] as string);
    if (d) {
      const hex = d[1] as string;
      value = `#${hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex}`;
    }
  }
  if (!value) throw new Error(`no ${prop} for ${selector}`);
  return value;
}

describe('ZONE_PICKER_CSS contrast', () => {
  const light = ZONE_PICKER_CSS.slice(0, ZONE_PICKER_CSS.indexOf(":host([data-tz-theme='dark'])"));
  const darkForced = ZONE_PICKER_CSS.slice(
    ZONE_PICKER_CSS.indexOf(":host([data-tz-theme='dark'])"),
    ZONE_PICKER_CSS.indexOf('@media (prefers-color-scheme: dark)'),
  );
  const darkSystem = ZONE_PICKER_CSS.slice(ZONE_PICKER_CSS.indexOf('@media (prefers-color-scheme: dark)'));

  it.each([
    ['light', light],
    ['dark (forced)', darkForced],
    ['dark (system)', darkSystem],
  ])('active option meets 4.5:1 for label and detail in %s', (_name, css) => {
    const bg = declared(css, '.tzx-opt-active', 'background');
    expect(contrast(declared(css, '.tzx-opt-active', 'color'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(declared(css, '.tzx-opt-active .tzx-opt-detail', 'color'), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['light', light, '.tzx-listbox'],
    ['dark (forced)', darkForced, '.tzx-listbox'],
    ['dark (system)', darkSystem, '.tzx-listbox'],
  ])('inactive option text meets 4.5:1 in %s', (_name, css, list) => {
    const bg = declared(css, list, 'background');
    expect(contrast(declared(css, '.tzx-opt', 'color'), bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(declared(css, '.tzx-opt-detail', 'color'), bg)).toBeGreaterThanOrEqual(4.5);
  });
});
