# TZ Extension — Spec & Tickets (source of truth)

A Manifest V3 browser extension for timezone conversion. TypeScript (strict),
Vite + @crxjs/vite-plugin, React 19, date-fns-tz. Target: Chrome/Edge (Chromium MV3).

## Problem statement

Users work across timezones. They need to:
1. Convert a time they see on any web page to their zones, in place (text selection).
2. Convert an arbitrary time between many timezones (full converter).
3. Convert a Unix epoch timestamp to human time in many timezones.

## Non-goals

- Firefox MV2 (Chromium MV3 only for v1).
- Calendar/recurring events, meeting scheduling.
- Server/sync — storage is local (chrome.storage.sync for prefs only).

## Features & acceptance criteria

### F1 — Select-to-convert (content script)
- AC1: Selecting text that contains a parseable time/date shows a floating popover
  anchored near the selection, rendered inside a Shadow DOM (no page CSS leakage).
- AC2: The popover lists the detected time converted into each of the user's saved
  target timezones, plus the detected source interpretation.
- AC3: If the selection does NOT parse as a time, NO popover appears (silent).
- AC4: Popover dismisses on: click outside, Escape, new selection, scroll away.
- AC5: Works on arbitrary sites without throwing; isolated styles; no global leaks.
- AC6: Parser handles: ISO-8601 (with/without tz), `HH:mm` / `h:mm a`, `3pm`,
  `2024-01-02 15:04`, RFC-ish `Jan 2 2024 3:00 PM`, epoch (10-digit s / 13-digit ms),
  and times with explicit offsets (`15:00 UTC`, `+05:45`, `PST`). Ambiguous bare
  times (`3pm`) are interpreted in the page/user local zone and labeled as assumed.
- AC7: Debounced selection handling; does not fire on every mousemove.

### F2 — Full converter (popup)
- AC1: Enter/pick a date+time and a source timezone; see it in N target zones.
- AC2: Add/remove target timezones from the full IANA list with typeahead search.
- AC3: "Now" button fills current instant. Live-updating clock optional but must not leak timers.
- AC4: 12h/24h toggle. DST-correct (date-fns-tz, not fixed offsets).
- AC5: Invalid input shows an inline error, never crashes.

### F3 — Epoch converter (popup tab)
- AC1: Paste epoch; auto-detect seconds (10) vs milliseconds (13) with manual override.
- AC2: Show the instant in all target zones + ISO-8601 UTC.
- AC3: Reverse: pick a datetime → show its epoch (s and ms).
- AC4: Non-numeric / out-of-range input shows inline error.

### Cross-cutting
- Preferences (target zones, 12/24h, home zone) persist via chrome.storage.sync,
  with chrome.storage.local fallback; sane defaults on first run (home = resolved
  local zone via Intl.DateTimeFormat().resolvedOptions().timeZone).
- No `any`. Strict TS. ESLint clean. All timezone math via date-fns-tz.
- Unit tests (Vitest) for the parser and conversion lib with a table of edge cases.
- One Playwright/puppeteer smoke test that loads the built extension and opens the popup.

## Architecture

```
src/
  manifest.ts              # MV3 manifest (crxjs reads this)
  lib/
    tz.ts                  # IANA zone list, conversion/format helpers (date-fns-tz)
    parse.ts               # robust time/date string parser -> ParsedTime[]
    epoch.ts               # epoch<->date, s/ms detection
    storage.ts             # typed chrome.storage wrapper + defaults
  types/index.ts           # shared types
  background/service-worker.ts
  content/
    index.ts               # selection listener, mounts popover in Shadow DOM
    Popover.tsx            # React popover
    content.css
  popup/
    index.html, main.tsx, App.tsx, Converter.tsx, EpochTab.tsx, ZonePicker.tsx
  options/
    index.html, main.tsx, Options.tsx
tests/      # vitest unit
e2e/        # playwright smoke
```

## Edge cases (must all be handled)
- Empty / whitespace-only selection.
- Multiple candidate times in one selection → parse the first clear one, note count.
- Epoch boundary: 0, negative, year > 9999, 32-bit overflow.
- DST transitions (spring-forward gap, fall-back overlap) — date-fns-tz semantics, documented.
- Half-hour / 45-min offset zones (Asia/Kathmandu +05:45, Australia/Eucla +08:45).
- `chrome.storage` unavailable (content script on restricted pages) → graceful no-op.
- Shadow DOM style isolation from hostile page CSS.
- Timezone abbreviations are ambiguous (CST=China/Central US) — document the resolution rule.
- Popover positioning near viewport edges (flip/clamp).

## Verification gate (Ready to Ship requires ALL)
- `npm run typecheck` clean
- `npm run lint` clean
- `npm test` all green, parser/epoch/tz edge-case tables covered
- `npm run build` produces a loadable `dist/` with manifest + all three surfaces
- e2e smoke passes (popup loads, converter renders)
- Review subagent verdict: "Ready to Ship"
