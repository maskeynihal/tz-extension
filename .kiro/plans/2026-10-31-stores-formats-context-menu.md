# Plan: store links, store auto-publish, format registry, context menu, select-to-convert toggle

Branch: `feat/stores-formats-context-menu` → one PR, several Conventional Commits
(`feat:` bumps the minor version, so the merge releases v0.7.0 and, once secrets
exist, submits it to both stores).

## What the reproduction showed (custom formats "not working")

Driven in real Chromium with the built extension (options page + content script):

| Pattern / input | Result | Cause |
|---|---|---|
| `DD.MM.YYYY HH:mm` on `31.12.2024 10:30` | works | — |
| `YYYYMMDDHHmm` on `202412311030` | read as a **Unix epoch** | built-ins always run first; custom only runs when nothing else matched |
| `MM/DD/YYYY hh:mm A` | "no match" | `hh` (12-hour) is not a token; it becomes literal `hh` |
| `D MMM YYYY` | "does not compile", Add disabled | `MMM` = `MM`+`M` → duplicate regex group; no error explains why |
| `HH:mm TZ` with `EST` | zone silently ignored, assumed home zone | custom `TZ` only understands `Z`/`±hh:mm` |
| `31/02/2024` | accepted, rolls to March | no calendar-day validation |
| literal words (`at`, `on`) | collide with tokens | no escape syntax |

## Design

### Format registry (tasks 3 + 4) — `src/lib/formats.ts`
- Every built-in becomes a named entry: `id`, `label`, `description`, `examples`,
  `pattern` (regex source shown to the user), and a matcher.
  Entries: `epoch-seconds`, `epoch-millis`, `iso-8601`, `ymd-slash`, `long-form`,
  `day-month-name`, `time-of-day`.
- `parseTimes` runs every **enabled** built-in and every enabled custom format,
  collects all candidates (with position), and picks non-overlapping winners:
  longest match first, then custom before built-in (explicit user intent), then
  built-in order. This fixes the epoch-vs-custom clash without letting a loose
  custom `H:mm` steal a full ISO string. Winners return in document order.
- Each result carries `formatId` + `formatLabel`; the popover shows
  "matched by: …" so users know what to disable.
- New preference `disabledFormats: string[]` (built-in ids).
- Scan window capped at 2,000 chars (select-all of a page stays fast); advanced
  regexes run on the first 500 chars only.

### Custom format engine fixes
- Tokens (moment/day.js style, legacy kept): `YYYY YY MMMM MMM MM M DD Do D HH H hh h mm ss SSS A TZ`,
  plus legacy `MON MONTH`. `[text]` escapes literals.
- Validation returns a specific error: duplicate field, missing day/month,
  12-hour hour without `A`, uncompilable regex, nested quantifier (ReDoS guard).
- Year optional (defaults to the current year), time-only formats allowed (today).
- `TZ` resolves abbreviations (EST, CET, IST…), `GMT+5:30`, offsets — shared
  resolver with the built-ins.
- Real calendar validation (no 31 Feb).
- Options UI: list of built-ins with enable/disable switches, custom formats
  with edit, enable/disable, delete, live test against sample text in the
  home zone, error messages, token reference table.

### Context menu (task 5)
- Permissions: `contextMenus`, `activeTab`, `scripting` (none trigger a new
  install-time warning in Chrome).
- Service worker registers "Convert “%s” with TZ Converter" for `selection`.
- On click: message the tab's content script; if no listener (tab opened before
  install/update, or Firefox host access not granted) inject the content script
  via `scripting.executeScript` using `activeTab`, then retry.
- Content script shows the popover at the current selection rect (fallback:
  viewport top-centre). If nothing parses, a "No time recognized" card appears,
  because the user asked explicitly.
- Works with select-to-convert off.

### Select-to-convert preference (task 6)
- `selectToConvert: boolean` (default `true`). Off → selections do nothing;
  right-click still works. Toggle on the Options page and a quick toggle in the
  popup header. Applies live via `storage.onChanged`.

### Store links (task 1)
- README: store badges/links at the top and in Install; manual install moved to
  "Install from source". Remove the stale "add-on id is a placeholder" note.
- Website (`site/` → rebuilt into `docs/`): nav + hero CTAs and the Install
  section point to both stores.

### Store auto-publish CI (task 2)
- `scripts/publish-chrome.mjs`: Chrome Web Store API **v2**
  (`oauth2` refresh token → `:upload` → poll `:fetchStatus` → `:publish`).
- Firefox: `web-ext sign --channel=listed` (AMO API v5) uploading the built zip
  plus a source archive (`git archive`) and reviewer notes for build steps.
- `release.yml`: a `publish` job after `release`, per-store, skipped with a
  warning when secrets are missing; `workflow_dispatch` to re-publish a tag.
  Uses the `store-publish` environment so secrets can need approval.
- `docs/PUBLISHING.md`: how to create each secret.

## Loop harness
For each work stream: **plan → code → QA → review → fix**, repeated until clean.
1. Code: CI/docs stream delegated to a sub-agent in parallel; core features by me.
2. QA: typecheck, lint, unit tests (new parser/format/storage/options tests),
   Playwright e2e in real Chromium (context menu, toggle, formats, custom formats),
   Firefox build lint via `web-ext lint`.
3. Blind QA: a sub-agent that does not read `src/` drives the built extension
   from the user's point of view and reports defects.
4. Review: `semantic_reviewer` on the full diff; fix findings; re-run QA.
5. PR: push branch, open PR with test evidence.

## Out of scope / needs the owner
- Creating store API credentials and adding them as GitHub secrets.
- First manual submission is already done; CI handles updates only.
