import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { listTimeZones } from '../lib/tz';

export interface ZonePickerProps {
  /** Called with a chosen IANA zone id. */
  readonly onSelect: (zone: string) => void;
  /** Zones to exclude from suggestions (already added). */
  readonly exclude?: readonly string[];
  readonly placeholder?: string;
  /** Visible label for the input (for a11y). */
  readonly label: string;
}

export function ZonePicker({
  onSelect,
  exclude = [],
  placeholder = 'Search timezones…',
  label,
}: ZonePickerProps): JSX.Element {
  const allZones = useMemo(() => listTimeZones(), []);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const excludeSet = useMemo(() => new Set(exclude), [exclude]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = allZones.filter((z) => !excludeSet.has(z));
    if (q.length === 0) return pool.slice(0, 50);
    return pool
      .filter((z) => z.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, allZones, excludeSet]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const choose = useCallback(
    (zone: string) => {
      onSelect(zone);
      setQuery('');
      setOpen(false);
    },
    [onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        setOpen(true);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, matches.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = matches[active];
        if (chosen) choose(chosen);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    [open, matches, active, choose],
  );

  return (
    <div className="tzx-picker" ref={containerRef}>
      <label className="tzx-sr-only" htmlFor="tzx-zone-input">
        {label}
      </label>
      <input
        id="tzx-zone-input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="tzx-zone-listbox"
        aria-autocomplete="list"
        autoComplete="off"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && matches.length > 0 && (
        <ul className="tzx-listbox" id="tzx-zone-listbox" role="listbox">
          {matches.map((zone, i) => (
            <li
              key={zone}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'tzx-opt tzx-opt-active' : 'tzx-opt'}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(zone);
              }}
            >
              {zone}
            </li>
          ))}
        </ul>
      )}
      {open && query.trim().length > 0 && matches.length === 0 && (
        <ul className="tzx-listbox" role="listbox">
          <li className="tzx-opt tzx-opt-empty" aria-disabled="true">
            No matching timezone
          </li>
        </ul>
      )}
    </div>
  );
}
