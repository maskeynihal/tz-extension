import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { useState } from 'react';
import { SortableList } from '../src/options/SortableZoneList';
import { App } from '../src/popup/App';
import { Popover } from '../src/content/Popover';
import { DEFAULT_PREFERENCES, type ParsedTime, type Preferences } from '../src/types';

/**
 * SortableList outside Settings: inside a shadow root (the in-page card), with
 * auto-scroll off, per-row classes, rows of uneven height; and the popup,
 * whose reorders must survive late echoes of its own saves.
 */

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

/** Row tops and heights by DOM index; the list starts at 100px. */
function mockRows(heights: readonly number[], gap = 0): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = (top: number, height: number): DOMRect =>
      ({ top, height, bottom: top + height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const tops: number[] = [];
    let y = 100;
    for (const h of heights) {
      tops.push(y);
      y += h + gap;
    }
    if (this instanceof HTMLElement && this.dataset.sortKey !== undefined && this.parentElement) {
      const rows = Array.from(this.parentElement.children).filter(
        (c) => c instanceof HTMLElement && c.dataset.sortKey !== undefined,
      );
      const i = rows.indexOf(this);
      return rect(tops[i] ?? 0, heights[i] ?? 0);
    }
    if (this.classList.contains('tzx-sort-list')) return rect(100, y - gap - 100);
    return rect(0, 0);
  });
}

function List({ initial, autoScroll }: { initial: string[]; autoScroll?: boolean }): JSX.Element {
  const [items, setItems] = useState(initial);
  return (
    <SortableList
      items={items}
      label="Zones"
      itemLabel={(z) => z}
      autoScroll={autoScroll}
      itemClassName={(z) => (z === 'B' ? 'row is-b' : 'row')}
      onReorder={(next) => setItems(next)}
      render={(z) => <span className="name">{z}</span>}
    />
  );
}

const keysOf = (root: ParentNode): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('li[data-sort-key]')).map((li) => li.dataset.sortKey ?? '');

describe('SortableList in a shadow root (the in-page card)', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('PointerEvent', FakePointerEvent);
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, writable: true, value: vi.fn() });
    host = document.createElement('div');
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    const mount = document.createElement('div');
    shadow.appendChild(mount);
    root = createRoot(mount);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function handle(name: string): HTMLButtonElement {
    return shadow.querySelector(`button[aria-label="Drag to reorder ${name}"]`) as HTMLButtonElement;
  }

  it('keeps focus on the held row as it moves, and drops it in place', () => {
    act(() => root.render(<List initial={['A', 'B', 'C']} />));
    const a = handle('A');
    a.focus();
    expect(shadow.activeElement).toBe(a);
    act(() => {
      fireEvent.keyDown(a, { key: ' ' });
    });
    act(() => {
      fireEvent.keyDown(shadow.activeElement as Element, { key: 'ArrowDown' });
    });
    // Focus followed the row inside the shadow root (document.activeElement is only the host).
    expect(shadow.activeElement).toBe(handle('A'));
    expect(keysOf(shadow)).toEqual(['B', 'A', 'C']);
    act(() => {
      fireEvent.keyDown(handle('A'), { key: ' ' });
    });
    expect(keysOf(shadow)).toEqual(['B', 'A', 'C']);
    expect(handle('A')).toHaveAttribute('aria-pressed', 'false');
    expect(shadow.activeElement).toBe(handle('A'));
  });

  it('removing a row with focus in it moves focus to the next row inside the shadow root', () => {
    function Removable(): JSX.Element {
      const [items, setItems] = useState(['A', 'B', 'C']);
      return (
        <SortableList
          items={items}
          label="Zones"
          itemLabel={(z) => z}
          onReorder={(next) => setItems(next)}
          onRemove={(z) => setItems((prev) => prev.filter((x) => x !== z))}
          render={(z, ctx) => (
            <button type="button" aria-label={`Remove ${z}`} onClick={ctx.remove}>
              x
            </button>
          )}
        />
      );
    }
    act(() => root.render(<Removable />));
    const remove = shadow.querySelector('button[aria-label="Remove B"]') as HTMLButtonElement;
    remove.focus();
    expect(shadow.activeElement).toBe(remove);
    act(() => {
      remove.click();
    });
    expect(keysOf(shadow)).toEqual(['A', 'C']);
    // Focus is seen through the shadow root, so it lands on the row now at that place.
    expect(shadow.activeElement).toBe(handle('C'));
  });

  it('marks the shadow host while dragging, never the page, and keeps pointer events from the page', () => {
    mockRows([40, 40, 40]);
    act(() => root.render(<List initial={['A', 'B', 'C']} />));
    const pageSaw = vi.fn();
    document.addEventListener('pointerdown', pageSaw);
    document.addEventListener('pointermove', pageSaw);
    document.addEventListener('pointerup', pageSaw);
    const c = handle('C');
    act(() => {
      fireEvent.pointerDown(c, { pointerId: 3, clientY: 190, button: 0 });
    });
    expect(host).toHaveClass('tzx-sort-grabbing');
    expect(document.documentElement).not.toHaveClass('tzx-sort-grabbing');
    act(() => {
      fireEvent.pointerMove(c, { pointerId: 3, clientY: 100 });
      fireEvent.pointerUp(c, { pointerId: 3, clientY: 100 });
    });
    expect(keysOf(shadow)).toEqual(['C', 'A', 'B']);
    expect(host).not.toHaveClass('tzx-sort-grabbing');
    expect(pageSaw).not.toHaveBeenCalled();
    document.removeEventListener('pointerdown', pageSaw);
    document.removeEventListener('pointermove', pageSaw);
    document.removeEventListener('pointerup', pageSaw);
  });

  it('adds per-row classes from a function', () => {
    act(() => root.render(<List initial={['A', 'B']} />));
    const rows = shadow.querySelectorAll('li');
    expect(rows[0]?.className).toBe('tzx-sort-item row');
    expect(rows[1]?.className).toBe('tzx-sort-item row is-b');
  });
});

describe('SortableList drag limits and auto-scroll', () => {
  let raf: FrameRequestCallback[];
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', FakePointerEvent);
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, writable: true, value: vi.fn() });
    raf = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => raf.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a row reaches the very top and bottom when the rows differ in height', () => {
    // The first row has no top border, so it is 1px shorter than the others.
    mockRows([40, 41, 41, 41]);
    render(<List initial={['A', 'B', 'C', 'D']} />);
    const list = screen.getByRole('list', { name: 'Zones' });
    const d = screen.getByRole('button', { name: 'Drag to reorder D' });
    fireEvent.pointerDown(d, { pointerId: 1, clientY: 245 });
    fireEvent.pointerMove(d, { pointerId: 1, clientY: -500 });
    fireEvent.pointerUp(d, { pointerId: 1, clientY: -500 });
    expect(keysOf(list)).toEqual(['D', 'A', 'B', 'C']);

    const a = screen.getByRole('button', { name: 'Drag to reorder A' });
    // A is now second (top 141, 41px tall in this mock); drag far down.
    fireEvent.pointerDown(a, { pointerId: 2, clientY: 160 });
    fireEvent.pointerMove(a, { pointerId: 2, clientY: 2000 });
    fireEvent.pointerUp(a, { pointerId: 2, clientY: 2000 });
    expect(keysOf(list)).toEqual(['D', 'B', 'C', 'A']);
  });

  it('scrolls the window near its edge by default, and not with autoScroll off', () => {
    mockRows([40, 40, 40]);
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    const { unmount } = render(<List initial={['A', 'B', 'C']} />);
    let h = screen.getByRole('button', { name: 'Drag to reorder A' });
    fireEvent.pointerDown(h, { pointerId: 1, clientY: 120 });
    fireEvent.pointerMove(h, { pointerId: 1, clientY: window.innerHeight - 2 });
    expect(raf.length).toBe(1);
    raf.shift()?.(0);
    expect(scrollBy).toHaveBeenCalled();
    fireEvent.pointerUp(h, { pointerId: 1, clientY: window.innerHeight - 2 });
    unmount();

    scrollBy.mockClear();
    raf = [];
    render(<List initial={['A', 'B', 'C']} autoScroll={false} />);
    h = screen.getByRole('button', { name: 'Drag to reorder A' });
    fireEvent.pointerDown(h, { pointerId: 2, clientY: 120 });
    fireEvent.pointerMove(h, { pointerId: 2, clientY: window.innerHeight - 2 });
    expect(raf.length).toBe(0);
    expect(scrollBy).not.toHaveBeenCalled();
    fireEvent.pointerUp(h, { pointerId: 2, clientY: window.innerHeight - 2 });
  });
});

describe('popup reorder', () => {
  type Listener = (c: Record<string, { newValue: unknown }>, a: string) => void;
  const chromeMock = (): {
    storage: { sync: { set: ReturnType<typeof vi.fn> }; onChanged: { addListener: ReturnType<typeof vi.fn> } };
  } =>
    (globalThis as unknown as {
      chrome: { storage: { sync: { set: ReturnType<typeof vi.fn> }; onChanged: { addListener: ReturnType<typeof vi.fn> } } };
    }).chrome;

  it('two quick moves end on the second, even when the echoes of both saves arrive late', async () => {
    await chromeMock().storage.sync.set({
      'tz-extension-prefs': { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] },
    });
    chromeMock().storage.sync.set.mockClear();
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Converted times' });
    await waitFor(() => expect(keysOf(list)).toEqual(['UTC', 'Europe/London', 'Asia/Tokyo']));
    const listeners = chromeMock().storage.onChanged.addListener.mock.calls.map((c) => c[0] as Listener);

    const utc = within(list).getByRole('button', { name: 'Drag to reorder UTC' });
    utc.focus();
    fireEvent.keyDown(utc, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(within(list).getByRole('button', { name: 'Drag to reorder UTC' }), { key: 'ArrowDown', altKey: true });
    expect(keysOf(list)).toEqual(['Europe/London', 'Asia/Tokyo', 'UTC']);
    await waitFor(() => expect(chromeMock().storage.sync.set.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Echo each save, in order, after both were made.
    for (const [items] of chromeMock().storage.sync.set.mock.calls as Array<[Record<string, unknown>]>) {
      const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]));
      act(() => listeners.forEach((l) => l(changes, 'sync')));
      expect(keysOf(list)).toEqual(['Europe/London', 'Asia/Tokyo', 'UTC']);
    }
  });

  it('a failed save puts the stored order back and says why', async () => {
    await chromeMock().storage.sync.set({
      'tz-extension-prefs': { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC', 'Asia/Tokyo'] },
    });
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Converted times' });
    await waitFor(() => expect(keysOf(list)).toEqual(['UTC', 'Asia/Tokyo']));
    chromeMock().storage.sync.set.mockRejectedValue(new Error('MAX_WRITE_OPERATIONS_PER_MINUTE'));
    const utc = within(list).getByRole('button', { name: 'Drag to reorder UTC' });
    fireEvent.keyDown(utc, { key: 'ArrowDown', altKey: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('MAX_WRITE_OPERATIONS_PER_MINUTE');
    await waitFor(() => expect(keysOf(list)).toEqual(['UTC', 'Asia/Tokyo']));
  });

  it('a change made elsewhere is still shown', async () => {
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Converted times' });
    const listeners = chromeMock().storage.onChanged.addListener.mock.calls.map((c) => c[0] as Listener);
    const elsewhere: Preferences = { ...DEFAULT_PREFERENCES, targetZones: ['Asia/Tokyo', 'UTC'] };
    act(() => listeners.forEach((l) => l({ 'tz-extension-prefs': { newValue: elsewhere } }, 'sync')));
    await waitFor(() => expect(keysOf(list)).toEqual(['Asia/Tokyo', 'UTC']));
  });
});

describe('selection card rows', () => {
  const parsed = {
    epochMs: Date.UTC(2024, 0, 2, 15, 4, 5),
    matchedText: '2024-01-02T15:04:05Z',
    sourceZone: 'UTC',
    assumed: false,
    assumedZone: 'UTC',
    start: 0,
    end: 20,
  } as unknown as ParsedTime;
  const prefs: Preferences = { ...DEFAULT_PREFERENCES, homeZone: 'UTC', targetZones: ['UTC', 'Europe/London', 'Asia/Tokyo'] };

  it('a full card lists its zones as a reorderable list, local to the card', () => {
    const { container } = render(<Popover parsed={parsed} matchCount={1} prefs={prefs} pinned={false} onClose={() => {}} />);
    const list = within(container).getByRole('list', { name: 'Times in your zones' });
    const before = keysOf(list);
    expect(before.slice(-3)).toEqual(['UTC', 'Europe/London', 'Asia/Tokyo']);
    const tokyo = within(list).getByRole('button', { name: /^Drag to reorder .*Tokyo/ });
    tokyo.focus();
    fireEvent.keyDown(tokyo, { key: 'ArrowUp', altKey: true });
    expect(keysOf(list).slice(-2)).toEqual(['Asia/Tokyo', 'Europe/London']);
  });

  it('a compact card has no grips', () => {
    const { container } = render(<Popover parsed={parsed} matchCount={1} prefs={prefs} pinned={false} compact onClose={() => {}} />);
    expect(container.querySelector('[data-sort-handle]')).toBeNull();
    expect(container.querySelectorAll('.tzx-row').length).toBeGreaterThanOrEqual(3);
  });
});
