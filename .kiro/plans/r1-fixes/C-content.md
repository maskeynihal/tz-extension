# Worker C: content-script cards, pins and dock

Read common.md first.

Files you own: everything under src/content/, tests/content.test.ts, new tests/content-fixes.test.ts(x), e2e/v2.spec.ts.

You may run `npm run build:chrome` and `npx playwright test e2e/v2.spec.ts` near the end. Other workers' half-finished edits may break the build; wait and retry, and report. Do not run build:site.

Verify:
- `npx vitest run tests/content.test.ts` (plus your new file)
- `npx tsc --noEmit`
- `npx eslint src/content tests e2e --max-warnings=0`
- `npm run build:chrome && npx playwright test e2e/v2.spec.ts`

Context: the content script shows a transient card (Popover) for a selected date/time. It can be pinned to a page spot, or floating (position: fixed). PinDock offers minimize/expand/float/close-all with a 6 s Undo. Prefs: `keepSelection` ("also mark the matched text" with a CSS highlight; the native page selection is always kept), `cardSize` ('compact'|'full'|'last'), `lastCardSize`, `numericDateOrder`. Host ids: tz-extension-popover-host, .tz-extension-pin-host, tz-extension-pin-dock.

Current state: tests/content.test.ts has 2 failing tests after partial edits ("opens compact … remembers the last size" and "offers the day/month choice …"). Decide whether the code or the test is wrong given the fixes below, and fix accordingly.

## Fixes

1. **Blocker.** `keepPageSelection` in Popover.tsx calls preventDefault on every card mousedown, so card text can't be selected or copied. Only preventDefault for `button`, `.tzx-head` (drag handle), `.tzx-order-btn` and similar controls. Text in `.tzx-row` must be selectable. e2e: drag-select and double-click a row and get selection text containing the converted time; clicking a card button still keeps the page selection. The base branch focused the transient card when keepSelection was off: restore keyboard reachability if it doesn't clear the page selection (prove in e2e), else document why not.
2. Day/month picker labels: render from `dateOrder.date` / `dateOrder.alternate.date` via formatCalendarDate, no zone math. Test with "03/04/2024 22:00 PDT" and "03/04/2024 00:30 CET".
3. Compact cards must also offer the day/month choice (small and unobtrusive). The active option must look clearly selected, with AA contrast in light and dark; the "M/D" hint on the active pill was confusing.
4. Gate pin highlights (`setPinHighlight`) on `prefs.keepSelection`, and update live when the pref changes.
5. `rememberSize` writes only when `cardSize === 'last'`, debounced (about 500 ms, trailing). `patchPrefs` re-reads prefs from storage right before merging, to avoid writing a stale copy. Test write counts.
6. `undoCloseAll` must not tear down the transient card or clear the live highlight. It restores each pin's original slot number and color (when free), placement, size and position. Test.
7. PinDock focus: after Close all, focus Undo. `role="status"` goes on the toast text span only. After Undo or timeout, move focus somewhere sensible without throwing. Test.
8. The dock stacks above pinned and floating cards (z-index and/or DOM order) and isn't covered at a 390 px viewport. Cards avoid overlapping it. e2e at 390 px if feasible.
9. "Pin to page" from floating returns the card next to its source text (the range's current position if it still exists, else the current viewport position in page coordinates). Test.
10. Escape: with the ZonePicker contract in common.md, an Escape the picker doesn't stop must close the card, including when it starts inside the shadow-root input. Test.
11. The card's zone-search placeholder is truncated: shorten it or make it fit (see /tmp/tz-v2-blind-r1/shots/). If the "offset clipped at 390 px" issue is in card rows, fix it.
12. `tooClose` cascades against pins' original pageX/pageY; use their current positions.

QA evidence: /tmp/tz-v2-blind-r1/dock*.log, size.log, inter.log, long.log, shots/. Reviewer probe: /tmp/tz-v2-review-r1/e2e/probe.spec.ts.
