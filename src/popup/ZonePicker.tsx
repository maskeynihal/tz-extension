import { useMemo, useState, useRef, useEffect, useCallback, useId } from 'react';
import { searchZones, type ZoneOption } from '../lib/tz';

export interface ZonePickerProps {
  /** Called with a chosen zone id (IANA, "UTC+05:45" or "abbr:PDT"). */
  readonly onSelect: (zone: string) => void;
  /** Zones to exclude from suggestions (already added). */
  readonly exclude?: readonly string[];
  /** Shown first when the search box is empty (e.g. your local zone). */
  readonly suggested?: readonly string[];
  readonly placeholder?: string;
  /** Visible label for the input (for a11y). */
  readonly label: string;
  /** Extra class on the root, for compact contexts such as the in-page card. */
  readonly className?: string;
  /** Focus the input on mount. */
  readonly autoFocus?: boolean;
}

/**
 * Searchable, grouped timezone combobox: Suggested · UTC offsets ·
 * Abbreviations · regions. Type any part of a name, city, abbreviation or
 * offset ("kath", "pdt", "+5:30", "utc-8"). Arrow keys move through every
 * group; Enter picks; Escape or Tab away closes.
 */
export function ZonePicker({
  onSelect,
  exclude = [],
  suggested = [],
  placeholder = 'Search timezones…',
  label,
  className,
  autoFocus = false,
}: ZonePickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Unique per instance: two pickers on one page must not share ids, or the
  // second input gets the first one's label.
  const uid = useId();
  const inputId = `${uid}-input`;
  const listId = `${uid}-listbox`;
  const optId = (i: number): string => `${uid}-opt-${i}`;

  const groups = useMemo(
    () => searchZones(query, { exclude, suggested, perGroup: query.trim() ? 40 : 60 }),
    [query, exclude, suggested],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the keyboard-highlighted option visible in the scrolling list. The
  // list may live in a shadow root, so look it up from the list element.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    function onDocDown(e: Event): void {
      const path = e.composedPath();
      if (containerRef.current && !path.includes(containerRef.current)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown, true);
    return () => document.removeEventListener('mousedown', onDocDown, true);
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
      // Keep page shortcuts (and the card's own Escape handler) out of typing.
      e.stopPropagation();
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        setOpen(true);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 10, flat.length - 1));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 10, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = flat[active];
        if (chosen) choose(chosen.id);
      } else if (e.key === 'Escape') {
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
      }
    },
    [open, flat, active, choose],
  );

  let index = -1;
  const renderOption = (o: ZoneOption): JSX.Element => {
    index += 1;
    const i = index;
    return (
      <li
        key={o.id}
        id={optId(i)}
        data-index={i}
        role="option"
        aria-selected={i === active}
        className={i === active ? 'tzx-opt tzx-opt-active' : 'tzx-opt'}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => {
          e.preventDefault();
          choose(o.id);
        }}
      >
        <span className="tzx-opt-label">{o.label}</span>
        {o.detail && <span className="tzx-opt-detail">{o.detail}</span>}
      </li>
    );
  };

  return (
    <div
      className={`tzx-picker${className ? ` ${className}` : ''}`}
      ref={containerRef}
      onBlur={(e) => {
        // Close when keyboard focus leaves the picker (Tab away).
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !containerRef.current?.contains(next)) {
          // Nothing was chosen: drop the half-typed search with the list.
          setOpen(false);
          setQuery('');
        }
      }}
    >
      <label className="tzx-sr-only" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open && flat.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && flat[active] ? optId(active) : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && flat.length > 0 && (
        <ul className="tzx-listbox" id={listId} role="listbox" aria-label={label} tabIndex={-1} ref={listRef}>
          {groups.map((g) => (
            <li key={g.id} role="presentation" className="tzx-optgroup">
              <div className="tzx-optgroup-label" id={`${uid}-g-${g.id}`} aria-hidden="true">
                {g.label}
              </div>
              <ul role="group" aria-labelledby={`${uid}-g-${g.id}`} className="tzx-optgroup-list">
                {g.options.map(renderOption)}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim().length > 0 && flat.length === 0 && (
        <ul className="tzx-listbox" role="listbox" aria-label={label} tabIndex={-1}>
          <li className="tzx-opt tzx-opt-empty" role="option" aria-selected={false} aria-disabled="true">
            No matching timezone
          </li>
        </ul>
      )}
    </div>
  );
}

/** CSS for the picker, for contexts without popup.css (the in-page card's shadow root). */
export const ZONE_PICKER_CSS = `
.tzx-picker { position: relative; }
.tzx-picker input { width: 100%; font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid #dcdee4; background: #fff; color: #24262e; outline: none; }
.tzx-picker input:focus { border-color: #1313ba; box-shadow: 0 0 0 3px rgba(19,19,186,0.15); }
.tzx-listbox { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 2; margin: 0; padding: 4px; list-style: none; max-height: 220px; overflow: auto; background: #fff; border: 1px solid #e6e7ec; border-radius: 8px; box-shadow: 0 10px 30px rgba(15,17,21,0.14); }
.tzx-listbox ul { list-style: none; margin: 0; padding: 0; }
.tzx-optgroup-label { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #898c96; padding: 6px 8px 2px; }
.tzx-opt { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; color: #24262e; }
.tzx-opt-detail { color: #898c96; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tzx-opt-active { background: #1313ba; color: #fff; }
.tzx-opt-active .tzx-opt-detail { color: #dcdcf7; }
.tzx-opt-empty { color: #898c96; cursor: default; }
.tzx-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
`;
