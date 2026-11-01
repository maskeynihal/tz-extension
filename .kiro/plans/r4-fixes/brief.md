# Round-4 fixes

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 3 is committed (0fb9ab1, 73f93d6). date-fns is gone; time maths is in src/lib/wallclock.ts (Intl only).

Evidence:
- Review round 4: /tmp/tz-v2-review-r4/2026-11-01-134219-review.md (repin.log, e2e/repin.spec.ts, sync-sim4.mjs, q.mjs)
- Blind QA round 4: /tmp/tz-v2-blind-r4/REPORT.md (rev.mjs, misc4.log, tabreach.log, clockr4.log, fmt*.json, dock2-1280-15.log, shots/)

## Rules (every worker)
- Edit only your files. No git commands that change state.
- tsc errors in files you don't own may be another worker's in-progress edit.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your vitest files, `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`, under the default TZ and `TZ=America/New_York`.
- Report: fixes (file and function), tests, changed assertions, anything left undone, final verification lines.

## Worker A: parser
Files: src/lib/builtin-formats.ts, tests/parser-r3.test.ts, new tests/parser-r4.test.ts. Rerun the corpus (/tmp/tz-v2-review-r4/corpus.mjs, cmp.mjs) and Talend (/tmp/tz-a-talend-unit.ts, ORDER=mdy|dmy, 239/239).

1. **Review #2.** The line-start name rule misses both ways.
   - Never read as a verse: a zero-padded hour ("John 09:41"); an hour of 13 or more ("Peter 14:07 joined the call"); a time followed by `-H:MM` or `–H:MM` (a time range: "Daniel 9:17-9:45" gives both times).
   - "Mark 3:47 meeting" and "Matt 4:12 call" at line start: a following lowercase word that is a common schedule/chat word (meeting, call, standup, sync, joined, left, said, wrote, lunch, dinner, demo, review, today, tomorrow, am, pm…) means time.
   - Consider making "See John 3:16" / "Read John 3:16" refused (verbs see/read/cf./compare/quote before the name), if it doesn't cost real times on the corpus. Report what you chose.
   - "Liverpool v. 3:00" is now refused by the "v." prefix. "v." there means versus. Require "v." / "vv." to be directly before the number with no name in between ("v. 3:16" verse) and not after a capitalised word ("Liverpool v. 3:00" time).
   - Tests for all.

## Worker B: zones and storage
Files: src/lib/storage.ts, src/lib/tz.ts, src/lib/wallclock.ts (only `zoneAbbreviation` and the comment at about line 65), src/popup/ZonePicker.tsx, tests/storage-r3.test.ts, tests/zones-r2.test.ts, tests/zone-picker.test.tsx, tests/wall-note.test.ts, new tests/zones-r4.test.ts.

1. **Review #3, hybrid lists from concurrent writes.** Write the previous write id `pw` (the `w` this context last wrote or read in extras) into the legacy item. Take the newer-legacy merge branch only when `legacy.pw === extras.w` (the extras still in flight is the one this legacy item followed). Otherwise, when two devices' halves are interleaved, use the extras whole. Reproduce sync-sim4's hybrid case in a unit test, and keep all storage-r3 tests passing.
2. **Abbreviations Intl lacks (QA #6).** When `zoneAbbreviation` would return a GMT±h form, look up the project's own ZONE_ABBREVIATIONS for an entry whose IANA zone is `tz` and whose offset matches that instant: America/St_Johns gives NST/NDT, Pacific/Chatham CHAST/CHADT. Don't put a tz.ts import into wallclock.ts if it creates a cycle (tz.ts imports wallclock.ts); do the lookup in tz.ts's `viewInZone` instead. Test that the St John's and Chatham notes use the abbreviation.
3. **Names.**
   - `displayZoneName`: "America/St_Johns" gives "St. John's". Check other IANA cities whose underscored names need punctuation (Port-au-Prince is fine; "Dumont_DUrville" → "Dumont d'Urville"; "Ho_Chi_Minh" → "Ho Chi Minh"). Use a small exception map.
   - Etc/GMT±N displays as its real offset ("UTC-12:00" for Etc/GMT+12; POSIX signs are reversed) everywhere, including `resolveZone().short` / `zoneLabel` if that's where the clock gets "GMT+12".
   - Tell worker D the function to use for the clock subtitle (QA: it shows "America/St Johns" with a space; it should be the IANA id or zoneLabel).
4. **"Already added" for partial queries (QA #8).** Settings search "kathm" says "No matching timezone" when Asia/Kathmandu is already added. `excludedMatch` should also catch a query that would have matched an excluded zone by prefix or alias when nothing else matches ("kathm", "nepal", "NPT", "utc+5:45"). Say "Already added: Asia/Kathmandu". Test in zone-picker.test.tsx.

## Worker C: content script
Files: src/content/*, tests/content*.test.ts(x), e2e/v2.spec.ts. You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`.

1. **Major (review #1): a mouse pin re-opens the transient card over the new pin.** mouseup's debounced selection check runs after the click has pinned and torn down the card, finds the kept selection, and shows the card again. Fix both ways:
   - Set `dismissedKey = shownKey` when a pin is created from the transient card.
   - `onMouseUp` (and `onKeyUp` if relevant) ignore events from our UI (`fromOurUi`).
   - e2e: click "Pin to page" with the mouse, wait 600 ms, assert no `#tz-extension-popover-host`. The same for clicking card buttons (compact, a zone remove) — the card must not flicker or duplicate.
2. **QA #2, can't reach other matches.** "2024-03-22-2024-03-25" (or any selection with several times) shows the first and a non-interactive "+1 more time(s) in selection".
   - Make it a small stepper: "‹ 1 of 2 ›" buttons (aria-labels "Previous time", "Next time", live text "Time 2 of 2") that switch the card to the other match.
   - Keep the highlight in step (mark the current match's text if the range can be found).
   - Pinning pins the shown match.
   - Fix the copy: "1 more time" vs "2 more times".
   - The partial-scan message for very long selections must stay.
   - Tests (unit + e2e).
3. **QA #3, keyboard reach.** When a card opens while focus is in a page field (a keyboard selection), there's no quick way to reach it.
   - While a transient card is open, Alt+Shift+T (check `e.code === 'KeyT'` for layouts) moves focus into the card. Pressing it again or Escape returns focus.
   - Show the hint in the card's title/aria-description: "Alt+Shift+T to focus".
   - Don't steal focus otherwise.
   - Test; e2e with a keyboard selection in a textarea.
4. **QA #9.** Cards pinned further down the page are 248–251 px wide at x=105 instead of 245 px at x=97. Find why (probably `clampPageLeft` and document width vs scrollbar, or the anchor x from the range on later lines) and make widths consistent. Test.

## Worker D: popup, clock, docs
Files: src/popup/EpochTab.tsx, src/clock/*, docs/SPEC.md (hand-edit only this file in docs/), tests/ui-r3.test.tsx, tests/clock.test.tsx, new tests/ui-r4.test.tsx.

1. **Major (QA #1): the Epoch tab's reverse field is pre-filled with local wall time but read in the home zone or as UTC.** The default result is off by the user's offset. Read EpochTab.tsx. The label says "Reverse: date & time → epoch (UTC)", but it calls `readWallInput(revLocal, prefs.homeZone, …)`. Decide which zone the reverse field means, and make the label, the pre-fill and the conversion agree. Preferred: the home zone, labelled with the zone name, pre-filled with now as the home zone's wall clock (use `viewInZone(Date.now(), homeZone)` like the Converter), with a "Now" button. The default result must equal the current epoch (within a second). Test under TZ=America/New_York with home Asia/Kathmandu.
2. **Clock (QA #4–#7).**
   - Clock titles and subtitles come from B's helpers: `displayZoneName` for the title (B is making Etc/GMT+12 show "UTC-12:00" and St_Johns "St. John's"). The subtitle shows the IANA id with underscores, or `zoneLabel`, not "America/St Johns".
   - Slider Home/End go to exactly −12h and +36h from now, like the presets. Today they land at −12h 4m and +35h 56m because of quarter-hour snapping.
   - 1900 dates: clock times must not round local mean time offsets with seconds. Use `viewInZone` for the displayed time, or the second-precise offset.
   - Tests.
3. **Docs.** docs/SPEC.md still describes date-fns-tz (lines 4, 39, 52, 62, 84 per the review). Update it to describe the Intl-based src/lib/wallclock.ts (DST gap: offset before the jump; overlap: earlier instant). Don't run the site build (that would overwrite other docs files); docs/SPEC.md isn't generated, so check that build-site.mjs doesn't overwrite it.
