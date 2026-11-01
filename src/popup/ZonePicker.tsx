import { useMemo, useState, useRef, useEffect, useCallback, useId } from 'react';
import { excludedMatch, searchZones, zoneLabel, type ZoneOption } from '../lib/tz';

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

/** Shared empty defaults, so the search memo isn't invalidated on every render. */
const NO_ZONES: readonly string[] = [];

/**
 * Searchable, grouped timezone combobox: Suggested · UTC offsets ·
 * Abbreviations · regions. Type any part of a name, city, country,
 * abbreviation or offset ("kath", "mumbai", "pdt", "+545", "utc−8").
 * Arrow keys, Page Up/Down and Home/End move through every group; Enter
 * picks. Escape clears the search and closes the list; an Escape with
 * nothing to clear or close is left to the surrounding UI (a card closes).
 * Tab away closes.
 */
export function ZonePicker({
  onSelect,
  exclude = NO_ZONES,
  suggested = NO_ZONES,
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
  const hasQuery = query.trim().length > 0;
  // A query that finds only added zones ("kathm", "nepal", "utc+5:45" with
  // Asia/Kathmandu added) says so rather than "no match".
  const added = useMemo(
    () => (hasQuery && flat.length === 0 ? excludedMatch(query, exclude, { partial: true }) : null),
    [hasQuery, flat.length, query, exclude],
  );
  const listShown = open && (flat.length > 0 || hasQuery);

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
      if (e.key === 'Escape') {
        // First Escape clears the search and closes the list, and stops there.
        // With nothing to clear or close it propagates, so a card can close.
        if (hasQuery || listShown) {
          e.preventDefault();
          e.stopPropagation();
          setQuery('');
          setOpen(false);
        }
        return;
      }
      // Keep page shortcuts out of typing.
      e.stopPropagation();
      const last = flat.length - 1;
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (!open || last < 0) {
        if (e.key === 'Enter') e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, last));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 10, last));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 10, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActive(last);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const chosen = flat[active];
        if (chosen) choose(chosen.id);
      }
    },
    [open, flat, active, choose, hasQuery, listShown],
  );

  let index = -1;
  const renderOption = (o: ZoneOption): JSX.Element => {
    index += 1;
    const i = index;
    const detail = [o.matched, o.detail].filter(Boolean).join(' · ');
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
        {detail && <span className="tzx-opt-detail">{detail}</span>}
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
        aria-expanded={listShown}
        aria-controls={listId}
        aria-activedescendant={listShown && flat[active] ? optId(active) : undefined}
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
      {listShown && flat.length > 0 && (
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
      {listShown && flat.length === 0 && (
        <ul className="tzx-listbox" id={listId} role="listbox" aria-label={label} tabIndex={-1}>
          <li className="tzx-opt tzx-opt-empty" role="option" aria-selected={false} aria-disabled="true">
            {added ? `Already added: ${zoneLabel(added)}` : 'No matching timezone'}
          </li>
        </ul>
      )}
    </div>
  );
}

/*
 * CSS for the picker in contexts without popup.css (the in-page card's
 * shadow root). The active option keeps at least 4.5:1 contrast for label
 * and detail text in both themes (tests/zone-picker.test.tsx checks it).
 */
const DARK = `
.tzx-picker input, .tzx-listbox { background: #1b1d24; border-color: #33353d; color: #e7e8ec; }
.tzx-opt { color: #e7e8ec; }
.tzx-optgroup-label, .tzx-opt-detail, .tzx-opt-empty { color: #a0a3ac; }
.tzx-opt-active { background: #8989dd; color: #0f1115; }
.tzx-opt-active .tzx-opt-detail { color: #1b1d24; }
`;

function scoped(css: string, prefix: string): string {
  return css
    .trim()
    .split('\n')
    .map((rule) => {
      const [selectors, body] = rule.split('{') as [string, string];
      const scopedSelectors = selectors
        .split(',')
        .map((s) => `${prefix} ${s.trim()}`)
        .join(', ');
      return `${scopedSelectors} {${body}`;
    })
    .join('\n');
}

export const ZONE_PICKER_CSS = `
.tzx-picker { position: relative; }
.tzx-picker input { width: 100%; font: inherit; font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid #dcdee4; background: #fff; color: #24262e; outline: none; }
.tzx-picker input:focus { border-color: #1313ba; box-shadow: 0 0 0 3px rgba(19,19,186,0.15); }
.tzx-listbox { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 2; margin: 0; padding: 4px; list-style: none; max-height: 220px; overflow: auto; background: #fff; border: 1px solid #e6e7ec; border-radius: 8px; box-shadow: 0 10px 30px rgba(15,17,21,0.14); }
.tzx-listbox ul { list-style: none; margin: 0; padding: 0; }
.tzx-optgroup-label { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #5b5e68; padding: 6px 8px 2px; }
.tzx-opt { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; color: #24262e; }
.tzx-opt-detail { color: #5b5e68; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tzx-opt-active { background: #1313ba; color: #fff; }
.tzx-opt-active .tzx-opt-detail { color: #dcdcf7; }
.tzx-opt-empty { color: #5b5e68; cursor: default; }
.tzx-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
${scoped(DARK, ":host([data-tz-theme='dark'])")}
@media (prefers-color-scheme: dark) {
${scoped(DARK, ":host(:not([data-tz-theme='light']):not([data-tz-theme='dark']))")}
}
`;
