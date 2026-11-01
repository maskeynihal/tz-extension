# Round-6 fixes

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 5 is committed (9ccd825).

Evidence:
- Review round 6: /tmp/tz-v2-review-r6/2026-11-01-151703-review.md (sync-sim6.mjs, src-fix/, cf.mjs, e2e/marks.spec.ts, readtimes*.mjs, cutctx.log, search6.mjs, bigsel.log)
- Blind QA round 6: /tmp/tz-v2-blind-r6/REPORT.md (nbsp.log, real*.log, cap-*.log, cutoff.log, site2.log, zsearch.log, pins-*.log, up.log, items.log, shots/)

## New shared module (worker A builds it; C and D consume it)

`src/lib/read-times.ts`:

```ts
export interface TimeList {
  /** Every distinct time found, in reading order (by sourceIndex into `text`). */
  readonly matches: readonly ParsedTime[];
  /** Index in `matches` of the parser's best match (open the card there). */
  readonly best: number;
  /** True when not every time could be listed (count cap or text-length cap). */
  readonly capped: boolean;
}
export const MAX_LISTED: number;      // 500
export const MAX_READ_CHARS: number;  // e.g. 200_000: how much of a selection is read at all
export function readTimes(text: string, opts: ParseOptions): TimeList;
```

- Deterministic, with no time budget: the same input always gives the same result.
- The card's and the website's "1 of N+" use `capped`.
- `sourceIndex` stays relative to `text`.

## Rules (every worker)
- Edit only your files. No git commands that change state.
- tsc errors in files you don't own may be another worker's in-progress edit.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your vitest files, `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`, under the default TZ and `TZ=America/New_York`.
- Report: fixes (file and function), tests, changed assertions, anything left undone, final verification lines.

## Worker A: parser and read-times
Files: src/lib/parse.ts, src/lib/builtin-formats.ts, src/lib/time-tokens.ts, src/lib/custom-formats.ts, new src/lib/read-times.ts, tests/parser-r5.test.ts, tests/formats.test.ts, new tests/parser-r6.test.ts, new tests/read-times.test.ts. Rerun the corpus (/tmp/tz-v2-review-r6/corpus.mjs, cmp6.mjs) and Talend (/tmp/tz-a-talend-unit.ts, ORDER=mdy|dmy, 239/239).

1. **QA F1 (Major): non-breaking and thin spaces.** U+00A0 (NBSP), U+202F (narrow NBSP, which CLDR 42+ puts before AM/PM), U+2009 (thin), U+2007 (figure) and U+200A must work like a normal space everywhere the parser reads whitespace.
   - "2024-10-02 13:30&nbsp;UTC", "2024-10-02&nbsp;13:30&nbsp;UTC", "Oct 2, 2024, 1:30\u202FPM UTC", "12:30 PM\u00A0UTC", "12:30\u00A0EST".
   - Do it like the sign normalisation: one character for one in the text the formats read, so `matchedText` and `sourceIndex` keep the original characters and positions.
   - Custom formats too.
   - Tests for each, including `sourceIndex`/`matchedText` invariants.
2. **`readTimes`** (contract above). It replaces the content script's `readTimes` (worker C deletes theirs and imports yours).
   - Fix review #4: duplicates must not hide later times. The parser's per-format cap counts raw matches, so add an internal way for `readTimes` to know where each capped format stopped (e.g. a non-exported `parseTimesDetailed` returning `{ results, complete }`, where `complete` is the index up to which every format scanned fully). Continue from there.
   - Fix review #5: parse each continuation with about 40 characters of left context, and drop results that end before the cut, so the verse guard and other look-behinds see real context.
   - Read up to `MAX_READ_CHARS` of `text` (chunking past SCAN_LIMIT), fixing QA F4: text past 20,000 characters was ignored with no notice. Set `capped` when the text is longer or `MAX_LISTED` is reached.
   - Measure: 20k-char prose, 20k ISO log lines, 200k chars. Keep it reasonable (report timings; the card runs it once per selection).
   - Tests: 26× "09:00 UTC" then "15:00 UTC" (2 matches); 60 lines; a verse right after a cut; >20k text; determinism; `capped`.
3. **Review #2: custom-format backward compatibility.**
   - Lowercase `d`/`dd`/`yy`/`yyyy` are tokens only when no letter touches them on either side ("HH:mm today", "den DD.MM.YYYY HH:mm", "MM/DD/YYYY HH:mm daily" and "YYYY-MM-DD HH:mm (yyyy)" compile as before, with the literal-letters warning).
   - A `'…'` pair is a quoted literal only when the quoted text contains at least one letter and the pattern doesn't read like an apostrophe in prose: "D MMM 'YY, h:mm A o'clock" must match as in the base.
   - Add Java letters where safe (QA F10): `a` → AM/PM marker; `EEE`/`EEEE` → short/long weekday; `XXX`/`XX`/`X` → offset; `z`/`zzz` → zone abbreviation. Apply the same no-touching-letters rule.
   - Test against the review's cf.mjs list: everything that compiled in base compiles and matches the same.
4. **Review nit #6.** A book number no longer outranks `:00` minutes or a zero-padded hour: "1 John 10:00-11:30", "Shift 1 John 10:00-11:00", "1 John 09:00-10:00", "Room 2 Peter 10:00-11:00" and "1 Samuel 9:00-9:45" give both times. "1 John 3:16" stays a verse. Test.
5. **QA F11 (nit).** Lowercase "chadt", "est" etc. stay unread on purpose (everyday words). Document that in a test rather than changing it.

## Worker B: storage and zone search
Files: src/lib/storage.ts, src/lib/tz.ts, tests/storage-r3.test.ts, tests/zones-r5.test.ts, new tests/zones-r6.test.ts.

1. **Review #1.** `pt` comes only from extras read from storage, never from this context's own writes.
   - Drop `lastWriteIdTime = t` in `toSyncItems`.
   - In `remember()`, don't take `pt` from an extras whose `w` is one of this context's own write ids (keep a small set of recent own ids; the `onChanged` echo of our own write must not count).
   - `pw` keeps its current behaviour unless the reviewer's patch (/tmp/tz-v2-review-r6/src-fix/) shows otherwise. Apply that patch's logic and check `sync-sim6-fix.log`.
   - Update the known-gap comment.
   - Unit-test the halves case from the review (A offline writes A1; B saves B1, B2; the server has legacy B2 + extras A1; the peer reads A1's list whole). Keep every round-3/4/5 storage test passing.
2. **Review nit #7 / QA F8, decimal offsets.**
   - Keep "5.45" and "utc+5.30" as h.mm (both are minutes).
   - A one-digit fraction is a decimal hour: "5.5" and "utc+5.5" → +05:30; "-3.5" → -03:30; "+1.0" → +01:00; "+0.5" → +00:30.
   - A two-digit fraction of 25/50/75 after an hour: decide carefully ("5.75" → 5:45 as decimal, or h.mm "5:75" which is invalid → decimal). Use: a two-digit fraction ≥ 60 is decimal; one < 60 is h.mm.
   - Never drop a "." between digits in `normalizeSearch`; handle it in the offset parser.
   - "utc+1.0" must not give UTC+10:00.
   - Test.
3. **QA F9.** Searching "Etc/GMT+12" (and "etc/gmt+12", "GMT+12" as a raw id) finds the Etc zone (sign-reversed) or explains it: list Etc/GMT±N options in search when the query starts with "etc/". Test.

## Worker C: content script
Files: src/content/*, tests/content*.test.ts(x), e2e/v2.spec.ts, README.md (stepper section only). You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`.

1. **Use A's `readTimes`** from src/lib/read-times.ts; delete the content script's own copy and its time budget (QA F3: the count varied between runs). README: say "up to 500 times; '+' when there are more or the selection is very long".
2. **Review #3: text-transform pages.** `spanRange` compares case-insensitively (the whitespace squash plus `toLowerCase`). When mapping fails, `matchRange` returns null (no mark), never the whole selection. Unit tests with uppercase and capitalize text; e2e in Chrome with real CSS.highlights.
3. **Review nit #10.** `mapSelectionText` stops walking once it has covered `selLead + MAX_READ_CHARS` of the string. Measure on a 2.5M-character Ctrl+A (target: no long task over 100 ms from mapping).
4. **Review nit #9.** No shortcut request at install; only when a card opens (cache the answer for the page's life, refresh on `chrome.commands` changes if feasible, or on each open with a cheap cached first paint).
5. **QA F5: hidden and off-screen text.** Selection.toString includes screen-reader-only and off-screen text, and element boundaries can glue words ("UTCend").
   - Drop matches whose mapped range has no visible box: all client rects outside the document's scrollable area, or a 1×1 clip (`clip: rect(0 0 0 0)`, `clip-path: inset(50%)`), or zero size.
   - Where an element boundary joins text with no space, mapSelectionText already knows the boundary. If the parser's match crosses into a different inline-block or positioned element, cut the match at that boundary only when it can (else drop it). Use judgement and report.
   - Tests with the QA's markup (real2.log).
6. **QA F6: pinned cards cover each other and the next source text.**
   - When pinning, avoid covering other pins and the source text of other pins: prefer below the source; if that overlaps another pin or its source rect, try to the right of the source (when the viewport has room), then cascade.
   - Pins with a picker are 316 px wide, others 254: a consistent card width is preferable. Keep width rules as now if changing them is risky, and say so.
   - Test with two pins 140 px apart.
7. **QA F7 (nit).** The card opens on the best match. If that match is off screen and another match is on screen, open on the visible match nearest to the mouse or selection end instead. When stepping scrolls, leave a margin (about 48 px) instead of putting the match flush on the edge.
8. **QA F12.** Pinned cards from a multi-time selection get the stepper too (the same component), instead of an unactionable "+2 more times" line. A step on a pin moves its mark. Undo/Close all and settings follow-through keep the pin's step.

## Worker D: website
Files: site/demo.ts, site/convert.ts, tests/ui-r5.test.tsx, tests/site.test.ts, new tests/ui-r6.test.tsx. Run `node scripts/build-site.mjs` at the end.

1. **QA F2.** The website converter uses A's `readTimes` (src/lib/read-times.ts) instead of `parseTimes` + `readingOrder`: more than 25 times listed, "N+" when `capped`, open on `best`. Remove `readingOrder` if it's no longer used (update its tests). Test with 26, 60 and 600 times.
