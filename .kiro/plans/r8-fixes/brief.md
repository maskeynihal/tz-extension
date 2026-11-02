# Round-8 fixes (final)

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 7 is committed (369e4c7).

Evidence:
- Review round 8: /tmp/tz-v2-review-r8/2026-11-01-170931-review.md (chat8.log, rtl8.log, rtlchat8-head.log, pins8.log, pinall8.log, e2e/probe8.spec.ts, e2e/pins8.spec.ts, a3src/dist = a3c30cc build)
- Blind QA round 8: /tmp/tz-v2-blind-r8/REPORT.md (pins3-*.log, pins4 runs, siteoff.mjs, sitecap2.log, wk.log, shots/)

## Rules
- Edit only your files. No git commands that change state.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your vitest files, `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`, under the default TZ and `TZ=America/New_York`.
- Report: fixes (file and function), tests, changed assertions, anything left undone, final verification lines.

## Worker C: content script
Files: src/content/*, tests/content*.test.ts(x), e2e/v2.spec.ts, README.md (pins/visibility bullet only). You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`.

1. **Review Major #1: negative scroll offsets hide visible times.** `paneScroll` plus the negative-page-coordinate rule in `visibleBoxes` drops visible text in `flex-direction: column-reverse` panes (scrollTop negative when scrolled up) and in RTL scroll containers or pages (scrollLeft/scrollX negative).
   - Apply the negative-coordinate rule only to text inside an element that is `position: absolute` or `fixed` (on the text's element or an ancestor below the nearest scroll container). That is how off-page and screen-reader-only text is built. Measure those against the window's scroll only.
   - Every other box with non-zero size is kept, unless `clippedAway` or `inkless`. Remove `paneScroll` if it's no longer needed.
   - Tests (unit and e2e in Chrome):
     - a column-reverse chat pane with 120 messages, scrolled up: a visible message gives a card, and the whole list lists 120;
     - an RTL table in a scroller, scrolled so the time shows;
     - an RTL page scrolled sideways;
     - an RTL wide table with the time off to the left;
     - the round-6/7 off-page, fixed top:-500 and sr-only cases still dropped;
     - the round-7 LTR pane and `<pre>` cases still listed.
2. **QA H1 (Major): a stepped pin jumps far off screen.** When a stepped pin's own new mark is under it, re-place it only to a spot that is wholly on screen and near the mark: just above the mark, just below it, or beside it, still never over other pins. If none exists, keep the pin where it is (its mark may be partly covered) rather than moving it off screen. Test at 390 with 2 and 5 pins: after stepping, the pin is still within the viewport.
3. **Review Minor #2 / QA G2: new pins off screen.**
   - After a pin is placed, if it isn't wholly in the viewport, scroll it into view (`block: 'nearest'`) so the card doesn't vanish on click. Don't let that scroll dismiss anything.
   - At 1280, include free columns to the right of existing pins in the on-screen search, so pin 4 and 5 of the QA's five lines go to the empty x≈958–1280 area rather than below the fold, when they fit there.
   - Test both.
4. **Review Minor #3: "Pin all to page" after scrolling away.** When a card's text is off screen, place it by its text (below it, beside it, the nearest free spot near the text) before trying on-screen spots. Test: three pins near the top, scroll to y=2000, Unpin all, Pin all: each card ends near its own text (within one card height).

## Worker D: website
Files: site/demo.ts, site/app.html, tests/ui-r7.test.tsx, new tests/ui-r8.test.tsx. Run `node scripts/build-site.mjs` at the end.

1. **QA H4.**
   - When the input is longer than `MAX_READ_CHARS` and no time is found in the part read, the hint says "No time found in the first 50,000 characters; text past that is not read." instead of the generic "Couldn't read that…".
   - When "1 of 1+" (or any capped count) shows, show the explanation as visible text under the stepper too (the card has it), not only as a title.
   - Test.
2. **QA H5.** At 390 px in dark mode, the zone name "America/New_York" runs 3 px into its date in the converter rows. Fix the row layout (allow wrapping or ellipsis with a min gap). Add a CSS assertion test if there's a pattern for it in tests/site.test.ts.
