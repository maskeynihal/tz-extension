# Plan: v2 — locale formats, copy-safe selection, zone search & groups, tabbed settings, pin bulk actions, card size, drag-to-reorder, world clock

Branch `feat/v2-formats-clock-pins`, stacked on `feat/stores-formats-context-menu` (PR #22).
The PR targets that branch, so its diff shows only this work. Merge #22 first.

## 1. Talend/Qlik date formats + day/month ambiguity
Source: help.qlik.com Talend Data Preparation 8.0 "List of date and date/time formats" (≈230 patterns).
The patterns reduce to these families; each becomes a built-in format (switchable in Settings):

| New built-in | Covers (Talend patterns) |
|---|---|
| `numeric-date` Numeric date (day/month order) | `dd/MM/yyyy`, `MM/dd/yyyy`, `d.M.yy`, `dd-MM-yy`, `d/M/yyyy`, `yy/MM/dd`, `yyyy/M/d`, `yyyy.MM.dd.`, `yy. M. d`, `yyyy.d.M`… with optional time `H:mm[:ss]`, `H.mm[.ss]`, `h:mm[:ss] a`, `HH' h 'mm`, `' Uhr'`, zone; time-first `HH:mm dd/MM/yy` |
| `compact-date` Compact date | `yyyyMMdd`, `yyyyMMddZ` (19990322+0100) |
| `iso-8601` (extended) | `,SSS` fractions, `X` offsets (`+01`), `[Europe/Paris]` zone ids, `G` era (`AD`) |
| `iso-ordinal` / `iso-week` | `yyyy-DDD`, `YYYY-'W'w-c`, `YYYY'W'wc` |
| written formats (extended) | localized month/weekday names (de/fr/es/it/pt/nl), `d. MMMM yyyy`, `d-MMM-yyyy`, `MMM.dd.yyyy`, `d/MMM/yyyy H:mm:ss Z`, `'o''clock'`, `MEZ`/`MESZ` |
| `unix-date` | `EEE MMM dd HH:mm:ss z yyyy` (Mon Mar 22 05:06:07 CET 1999) |
| `cjk-date` | `yyyy'年'M'月'd'日'` + `上午/下午`, `时/時 分 秒` |

Day/month ambiguity: when both numbers ≤ 12 the result carries both readings. The popover shows
"Read as **22 Mar** (day first) | **Mar 22** (month first)"; the choice is saved as
`numericDateOrder` (`dmy` | `mdy`, default from the browser locale) and is also in Settings.
Unambiguous values (a part > 12) never ask.

## 2. Copy-safe selection
Stop collapsing the native selection. The highlight marks the matched token alongside the
selection; the card no longer steals focus; mousedown inside a card keeps the page selection.
Copy (Cmd/Ctrl+C) copies exactly what the user selected, short or long.

## 3 + 4. Zones: searchable everywhere, UTC±hh:mm, abbreviations, groups
New zone ids alongside IANA: fixed offsets `UTC+05:45`, `UTC-08:00` (all real offsets −12…+14),
and abbreviations `abbr:PDT`, `abbr:EDT`… (fixed offsets, labelled with their name), plus
DST-aware generics `abbr:PT`, `abbr:ET`, `abbr:CT`, `abbr:MT` mapped to IANA zones.
One `ZoneSearch` combobox (keyboard, grouped results: Suggested · UTC offsets · Abbreviations ·
Africa · America · … ) used in the popover, popup, settings, clock page and website.

## 5. Settings: tabbed single scroll
Sticky tab bar (General · Cards · Timezones · Formats) with scrollspy; each tab jumps to its
heading; deep links `#general` … `#formats`.

## 6. Pin bulk actions
A compact "pin dock" pill appears once a card is pinned: count + Minimize all · Expand all ·
Unpin all · Close all. Unpin = card leaves its page spot and floats on screen (re-pin from the
card). Close all has a 6-second Undo toast. Keyboard reachable, reduced-motion aware.

## 7. Card size on open
Setting `cardSize`: Compact · Full · Last used (`lastCardSize` updates whenever a card is toggled).
The transient card can be compact too.

## 8. Drag-to-reorder target zones
Pointer-based sortable list with FLIP animations (Web Animations API), drag handle, keyboard
(Alt+↑/↓ and buttons), live-region announcements, reduced-motion respected.

## 9 + 10. Website + world clock
Storage adapter falls back to `localStorage` when `chrome.storage` is absent, so the website shares
the settings model. Website converter gets the new formats, zone search and saved zones.
New "World clock" page (extension `src/clock/` + website `clock.html`): live clocks for every saved
zone, day/night state, offset from you, a time scrubber to plan across zones, add/search/reorder,
12/24h, theme. Linked from popup, settings and site nav.

## Loop harness
Plan → code → QA (typecheck, lint, unit, Playwright e2e, web-ext lint) → blind QA sub-agent →
semantic review sub-agent → fix → repeat until clean → PR.
Parallel streams with strict file ownership:
- me: `src/lib/*`, `src/content/*`, `src/types`, `src/background`, shared `ZoneSearch`
- agent A: `src/options/*` (tabs, drag list, new settings)
- agent B: `src/clock/*`, `site/*`, manifest entry for the clock page
