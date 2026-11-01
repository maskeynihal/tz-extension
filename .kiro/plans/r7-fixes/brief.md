# Round-7 fixes

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 6 is committed (a3c30cc).

Evidence:
- Review round 7: /tmp/tz-v2-review-r7/2026-11-01-160500-review.md (probe7*.log, marks7.log, pins7*.log, rtperf7*.log, e2e/*.spec.ts, prev/ = 9ccd825 build)
- Blind QA round 7: /tmp/tz-v2-blind-r7/REPORT.md (pins2-*.log, dock.log, cutoff2.log, legacy2.log, f5b.log, zsearch.log, space.log, shots/)

## Rules (every worker)
- Edit only your files. No git commands that change state.
- tsc errors in files you don't own may be another worker's in-progress edit.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your vitest files, `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`, under the default TZ and `TZ=America/New_York`.
- Report: fixes (file and function), tests, changed assertions, anything left undone, final verification lines.

## Worker A: parser, custom formats, zone list, README tokens
Files: src/lib/read-times.ts, src/lib/custom-formats.ts, src/lib/tz.ts (only UTC_OFFSET_MINUTES and `etcGroup`'s detail text), README.md (custom-format token section only), tests/read-times.test.ts, tests/parser-r6.test.ts, tests/zones-r6.test.ts, new tests/parser-r7.test.ts. Rerun Talend (/tmp/tz-a-talend-unit.ts, ORDER=mdy|dmy, 239/239) and the review's cf list (/tmp/tz-v2-review-r7/cf7.mjs).

1. **Review #4.** Lower `MAX_READ_CHARS` to 50,000. Keep `capped` for anything longer. Update read-times tests. Report Node timings at 50k for the review's worst inputs (rtperf7.mjs).
2. **QA G6.** Java `Z` (RFC 822 offset: `+0100`, `-0530`, and `Z` for UTC) as a custom-format token, with the existing no-touching-letters rule. `yyyy-MM-dd'T'HH:mm:ssZ` with `2024-03-05T14:05:06+0100`, and `yyyy-MM-dd HH:mm Z` with `+0545`. A saved pattern where `Z` was a literal must keep working (the compile-fallback approach). Test.
3. **QA G8.**
   - moment-style `ddd`/`dddd` weekday tokens (short/long weekday names, validated like `EEE`).
   - Better messages: `DDD` (day of year) and `SSSSSS` (micro/nanoseconds) say the token isn't supported instead of "repeats the day/millisecond". If `SSSSSS` (fraction digits beyond 3) is easy, support it as fractional seconds, reading the first 3 digits.
   - Test against legacy2.log cases.
4. **QA G9.** `''` (Java escaped apostrophe) before `yy`: `dd MMM ''yy HH:mm` matches `05 Mar '24 15:30`. Test.
5. **QA G11.** Add +13:45 to UTC_OFFSET_MINUTES (and check every offset any zone uses today is there: compute from listTimeZones over a year and add the missing ones). Update any test that counts the offsets.
6. **Review nit #7.** The Etc option detail: "UTC-09:00 · POSIX sign is reversed" (don't repeat the offset).
7. **QA G12.** README: document the Java/Talend tokens (yyyy, yy, dd, d, a, EEE, EEEE, X/XX/XXX, Z, z, 'quoted', '') next to the moment ones, and say lower-case abbreviations aren't read.

## Worker C: content script
Files: src/content/*, tests/content*.test.ts(x), e2e/v2.spec.ts, README.md (pins/stepper section only; coordinate with A by editing only that section). You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`.

1. **Review #1 (Major): scroll panes and code blocks.** `visibleBoxes` drops boxes outside the document's scrollWidth/scrollHeight, which loses times scrolled inside an `overflow:auto` pane or a horizontally scrolling `<pre>`.
   - Keep a box unless it has zero size, sits at negative page coordinates (`left:-9999px`, `top:-500px` fixed), or `clippedAway` is true.
   - Never drop for being past the far edge.
   - Also drop text with `opacity: 0` (on it or an ancestor) or `color: transparent` / fully transparent colour (QA G10), using the existing per-element cache.
   - Tests: an inner scroll pane with 60 rows (all 60 listed; scrolled to the middle too); a `<pre style="overflow-x:auto">` with the time past the right edge; and the off-screen/sr-only cases from round 6 still dropped. Also an e2e in Chrome for the pane.
2. **Review #2: inline-block edges.** Insert a space at a `box` break only where a letter meets a letter or digit on either side ("UTCend", "UTC3 days"), never between two digits or next to punctuation. Tests: `<span ib>10</span>:<span ib>30</span> UTC` → 10:30 UTC; one inline-block per digit; the "UTC3 days ago" and date-chip/time-chip cases still right.
3. **Pins (QA G1 Major, G2, G4; review #3 and nit #5).** Replace the round-6 placement with a simpler rule. Existing pins never move when a new pin is added.
   - A new pin goes in the first free spot from this list. Free means not over another pin, not over another pin's source text, and not over its own text. Prefer a spot that is fully in the viewport.
     1. right below its text;
     2. to the right of its text, if the viewport has room;
     3. the nearest free spot in a search over the document that grows outward from below its text (on-screen first);
     4. else stack it directly below the lowest card in the way (no overlap, even if that's further down the page; it scrolls with the page).
   - Delete `makeRoomFor`.
   - Same rule for "Pin to page" from floating and "Pin all to page", which places cards one by one in reading order.
   - Tests:
     - at 1280: five lines 40 px apart; no existing pin moves; no overlaps; prefer on-screen;
     - at 390: five lines; no overlaps, stacked;
     - Unpin all → Pin all.
     - e2e at 390 and 1280.
   - QA G3 (a stepped pin's mark under another pin): leave it, since it's inherent when pins sit near text, but make sure pins never cover their *own* text after a step: re-place a stepped pin only if its own new mark is under itself.
   - QA G5 (floating layout): floating layout is by design header-safe; don't change it.
4. **Review nit #6.** A pin doesn't hold the whole selection map: when pinning, keep only what it needs (the matches and a way to rebuild the map lazily from its range when it steps), or drop `selMap` and rebuild on demand. Test that a pin made from a large selection has no `selMap` until it steps.
5. **QA G7.** When `capped` is true, show the stepper's "+" even with a single listed match ("1 of 1+", compact "1/1+"), with the "Only the first … are listed" / "text past … not read" title. Test.

## Worker D: website and settings
Files: site/demo.ts, src/options/SortableZoneList.tsx, tests/ui-r6.test.tsx, tests/options.test.tsx, new tests/ui-r7.test.tsx. Run `node scripts/build-site.mjs` at the end.

1. **QA G7 on the website.** When `capped` is true, show the stepper with "1 of 1+" even for a single match. Test.
2. **QA G13.** In settings, Space or Enter on a "Drag to reorder" handle picks the item up; arrow keys move it; Space/Enter drops it; Escape cancels, restoring the order. Live-region announcements for each step. Alt+↑/↓ keeps working. Test.
