# Worker C (round 2): content-script cards, pins, dock

Read common.md first.

Files you own: everything under src/content/, tests/content.test.ts, tests/content-fixes.test.tsx, a new tests/content-r2.test.tsx, and e2e/v2.spec.ts. You may run `TARGET=chrome npx vite build` (skips tsc, so others' half-edits don't block you) and `npx playwright test e2e/v2.spec.ts`. Do not run build:site.

Verify:
- `npx vitest run tests/content.test.ts tests/content-fixes.test.tsx tests/content-r2.test.tsx`
- `npx tsc --noEmit`
- `npx eslint src/content tests --max-warnings=0`
- `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`

## Fixes

1. **Escape swallowed after the card takes focus (review #2).** The card focuses itself on open, so Escape now starts inside our UI, and only the bubble listener closes it. A page `body` keydown handler that stops propagation keeps the card open.
   - Fix: in the capture-phase document listener, dismiss on Escape unless `composedPath()[0]` is a text field (input/textarea/contenteditable) inside our UI, or the event is inside the dock.
   - The zone picker inside the card: give it a way to tell the card "nothing to clear". The ZonePicker is worker B's file, so don't edit it. Instead, keep the current bubble path for Escapes that start in the card's search input, since those originate in our shadow root and the page can't stop them before our host… verify that claim. If a page listener on body can stop them (it can, because events from a shadow host bubble through body), handle it in your capture listener: when the target is the card's zone-search input and it is empty with its list closed (`aria-expanded="false"` and value ""), dismiss in capture; otherwise leave it to the picker.
   - e2e: a page that stops Escape on body still closes the card, from the card and from an empty search box, and a first Escape in a search box with text only clears it.
2. **"Unpin all" stacks floating cards (QA #4).** With 4 or more pins, several land on exactly the same x/y (5 pins at 390 px: cards 4 and 5 both at y=425; 15 pins at 1280: cards 4–6 at (97,479)). Lay floating cards out so none fully hides another: cascade with a step, wrap to a new column when out of room, and as a last resort offset each by at least 24 px both ways, all clamped to the viewport and clear of the dock. Unit test the layout function with 5 and 15 cards at 390×844 and 1280×800. e2e for 5 pins at 390 px: every card's header is hit-testable (`elementFromPoint` on each card's header returns that card).
3. **Undo toast never times out (QA #11).** QA saw the toast still showing after 20 s with the pointer resting where Close all was. Hover pauses the countdown, and pointerenter can fire when the toast appears under a still pointer. Fix: hover pauses only after a real pointermove inside the dock after the offer appeared. Programmatic focus on Undo doesn't pause; user focus moves (Tab within) do. Cap the total pause so the offer ends at most 30 s after it appeared. Unit test with fake timers.
4. **Width jumps between pinned and floating (QA #12).** Cards are 245 px pinned and 311 px floating. Make a card keep its width when it changes placement (pin a fixed width, or use the same width rules for both). Test.
5. **Compact card covers the wrapped second line of the selection at 390 px (QA #17, shots/card-compact-light-390.png).** Anchor below the bottom of the whole selection rect (or the last client rect of the range), not the first line. Test with a two-line range (getClientRects).
6. **DST note.** When `parsed.wallClock` is 'gap', show a short muted note in the card, e.g. "02:30 doesn't exist on this day in New York (clocks jump forward); shown as 03:30." Keep it short and compact-friendly. When it's 'ambiguous', show "01:30 happens twice on this day; showing the first (EDT)." Use the zone's label. In compact cards, a small "DST" badge with the note as its title/aria-label is enough. Test both.
7. **Display minus (contract 4).** Remove any hard-coded "−" in content display code; offsets come from tz.ts.
