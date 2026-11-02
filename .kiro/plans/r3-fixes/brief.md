# Round-3 fixes

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 2 is committed (bb1a73e). Since then the lead has:
- removed date-fns-tz and date-fns entirely; src/lib/tz.ts formatting (`viewInZone`, `offsetMinutesAt`) now uses `wallFieldsAt`, `offsetMinutes` and `zoneAbbreviation` from src/lib/wallclock.ts, which are host-zone independent;
- added `TZ=America/New_York npm test` to CI.

Don't touch those parts unless your brief says so.

Evidence:
- Review round 3: /tmp/tz-v2-review-r3/2026-11-01-124430-review.md (diff.txt, sync-sim3.mjs, e2e/unpin.spec.ts, unpin.log, perf3.mjs)
- Blind QA round 3: /tmp/tz-v2-blind-r3/REPORT.md (dock2-*.log, dock-*.log, misc2.log, epoch.log, kb.log, shots/)

## Rules (every worker)
- Edit only the files listed for you. No git commands that change state.
- tsc errors in files you don't own may be another worker's in-progress edit.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your own vitest files plus `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`. Run your tests under `TZ=America/New_York` as well as the default.
- Report: fixes (file and function), tests, changed assertions, anything left undone, and the final verification lines.

## Worker A: parser
Files: src/lib/builtin-formats.ts, src/lib/time-tokens.ts, src/lib/epoch.ts, tests/parser-r2.test.ts, tests/epoch.test.ts, new tests/parser-r3.test.ts. Also rerun the corpus (/tmp/tz-v2-review-r3/corpus.mjs, cmp.mjs) and the Talend check (/tmp/tz-a-talend-unit.ts, ORDER=mdy|dmy, must stay 239/239).

1. **Review #2, verse guard and given names.**
   - "Lunch with Peter 12:30", "Call John 3:30", "Ping Mark 10:00", "Daniel 9:15 standup", "Meet James 14:00", "Ruth 9:00", "Amos 11:30" must convert again.
   - For book names that are also given names (John, Mark, Luke, James, Peter, Daniel, Timothy, Samuel, Ruth, Joel, Amos, Esther, Jonah, Jude, Philip/Philemon, Titus, Matthew, Thomas…), refuse only with scripture context: a leading book number ("1 John 3:16", "2 Peter 1:5"), a verse range or list directly after ("3:16-18", "3:16,18", "3:16–18"), or "verse"/"chapter"/"ch."/"v." before. "John 3:16" alone (the most famous verse) may stay refused only if you can do it without losing "Call John 3:30": choose a rule and report it. Note that "John 3:16" was a QA false positive.
   - Drop "at" from the RATIO_BEFORE connectors: "split at 10:30" must convert.
   - Add all of these as tests.
2. **Review #6.** The ISO-id veto must not drop the first date of a hyphen range: "2024-03-22-2024-03-25" gives both dates. Skip the veto when the trailing text is another ISO date.
3. **Review #7, leap seconds.** Accept `:60` only where it can be a real leap second: after applying the offset, the UTC time is 23:59:60 ("05:44:60 +05:45" yes, "23:59:60Z" yes, "10:59:60" with no zone no, "10:59:60 UTC" no). For a zone-less value, the assumed zone decides (assumedZone UTC + "23:59:60" yes).
4. **QA #4, epoch messages and range.** Read src/lib/epoch.ts. Pre-1900 negatives are refused by design; keep that, but report the exact range. `253402300799` (9999-12-31T23:59:59 in seconds, 12 digits) is read as milliseconds (1978). Look at the digit-count rule. If 12-digit values can be seconds when the milliseconds reading is implausible or ambiguous, decide carefully and document. Don't break 12-digit ms values that are real (1973–2001 ms values are 12 digits). If it stays, make sure the hint text is accurate (worker D owns the UI strings; give D the exact range in your report).

## Worker B: storage and zones
Files: src/lib/storage.ts, src/lib/tz.ts (only the `ianaEquivalent`/projection code, `usesOffset`, `pickOnOffset`, ODD_OFFSET_PLACES), tests/storage.test.ts, tests/zones-r2.test.ts, new tests/storage-r3.test.ts.

1. **Review #3, legacy-first partial delivery.** If the legacy item of a newer write arrives while extras is still from an older write, the reader trusts the stale extras (a removed zone comes back, and a save in that window makes it permanent). Add a monotonic write time `t` (ms, Date.now(), plus a counter if equal) to both items. When both have `w` and the `w` values differ: if legacy is newer (`t` larger), use `mergeTargets(legacy, extras)` for zones (legacy is the truth for IANA ids, new-style ids re-inserted) and legacy's homeZone when it is legacy-valid; if extras is newer, use extras. Equal `w`: extras. Missing `t` on either: the current rules. Reproduce with /tmp/tz-v2-review-r3/sync-sim3.mjs (copy and adapt it into a unit test), including "peer saves theme in the window".
2. **Review #8, projection speed.** With home `UTC+05:15`, `toSyncItems` takes about 30 ms per save because `usesOffset` probes 12 months × about 400 zones. Cache per (minutes, year) and make the scan stop early. Target under 5 ms for repeated saves; test with a timing bound that is generous for CI (e.g. second call < 10 ms).

## Worker C: content script
Files: src/content/*, tests/content*.test.ts(x), e2e/v2.spec.ts. You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`.

1. **QA #1 and review #4, "Unpin all" still hides cards.** With 5 pins (138 px apart) at 1280×800, card 5 covers card 4's header and none of card 4's 6 header buttons can be clicked. At 390 px cards 3 and 4 have 0/6 reachable. With 15 pins at 1280, cards 4–5 are unreachable. Protecting the 24×24 corner isn't enough: each card's whole header row (all its buttons) must stay uncovered by every card painted above it. Also:
   - Lay out with the height the card has after it floats (the "floating" tag can make it taller), or re-fit after render, so no card ends below the viewport.
   - When there isn't room for all headers, overlap bodies, never headers (a staircase where each card is offset by at least one header height).
   - Unit tests: for every card, every header button's centre is outside all later cards (5 and 15 cards at 390×844 and 1280×800).
   - e2e: at 390 px and 1280 px with 5 pins, `elementFromPoint` at every header button's centre hits that button.
2. **QA #2, "Pin all to page" at 390 px doesn't return cards next to their sources.** Cards 3 and 4 came back at y=480/546 instead of about 372/510, overlapping. Each card should go back next to its own source (the same rule as the single "Pin to page"), with the cascade applied only against cards already placed in this pass at their new positions, not against floating positions. Test at 390 and 1280.
3. **QA #3, Expand all changes card size.** After Minimize all then Expand all, cards become 311 px instead of their earlier 245 px. Remember each card's full-size width (the locked width) and restore it on expand, for single toggles and Expand all. Test.
4. **QA #10, focus after Escape.** Closing a card with Escape (from the card or its zone input) should return focus to the element that had it before the card took focus, when that element still exists and is focusable. Else leave it on body without scrolling. Test.

## Worker D: clock and popup/site strings
Files: src/clock/*, src/popup/EpochTab.tsx, site/demo.ts, site/convert.ts, tests/clock.test.tsx, tests/ui-r2.test.tsx, new tests/ui-r3.test.tsx. Run `node scripts/build-site.mjs` at the end.

1. **QA #8, clock.**
   - Escape returns the planner to now from any control in the planner, including a focused scale button, as the help text promises. Test.
   - The "+24h" preset gives "Mon 12:30 PM" from 12:43 because of 15-minute snapping. Either make presets exact (no snapping for preset jumps), or label the result honestly. Prefer exact presets. Test.
2. **QA #4 strings.** The website says "0 and negative values work too" and the popup says "in range 1900–9999", but pre-1900 is refused and 9999 isn't reachable in auto mode. Make every hint state the real accepted range. Worker A reports the exact rule; read src/lib/epoch.ts yourself to word it. Keep it short. Test the strings.
