# Round-5 fixes

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension. Round 4 is committed (bc5e21c).

Evidence:
- Review round 5: /tmp/tz-v2-review-r5/2026-11-01-142206-review.md (consec.mjs, consec.log, sync-sim5.mjs, probe5.log, order.mjs, abbr5.log, excl.mjs)
- Blind QA round 5: /tmp/tz-v2-blind-r5/REPORT.md (step*.log, kbd*.log, dst5.log, kat*.log, cust.mjs, shots/)

Shared contract (lead, already in src/types/index.ts): `ParsedTime.sourceIndex?: number` is where `matchedText` starts in the text given to `parseTimes` (UTF-16 index into the untrimmed input). Worker A sets it; worker C uses it. Results stay best-first.

## Rules (every worker)
- Edit only your files. No git commands that change state.
- tsc errors in files you don't own may be another worker's in-progress edit.
- Real fixes with tests; no weakened or skipped tests; explain any changed assertion.
- Verify with your vitest files, `npx tsc --noEmit` and `npx eslint <your paths> tests --max-warnings=0`, under the default TZ and `TZ=America/New_York`.
- Report: fixes (file and function), tests, changed assertions, anything left undone, final verification lines.

## Worker A: parser
Files: src/lib/parse.ts, src/lib/builtin-formats.ts, src/lib/time-tokens.ts, src/lib/custom-formats.ts, src/options/Formats.tsx (only the custom-format error text, if needed), tests/parser-r4.test.ts, tests/formats.test.ts, new tests/parser-r5.test.ts. Rerun the corpus (/tmp/tz-v2-review-r5/corpus.mjs, cmp.mjs) and Talend (/tmp/tz-a-talend-unit.ts, ORDER=mdy|dmy, 239/239).

1. **`sourceIndex`.** Set it on every result of `parseTimes`, including custom formats. It is the index in the original, untrimmed input (account for the `trim()` and the sign normalisation, which keeps lengths). Test that `text.slice(p.sourceIndex, p.sourceIndex + p.matchedText.length) === p.matchedText` across the corpus and Talend examples, and for inputs with leading whitespace and U+2212.
2. **Review #3.** A lowercase "see"/"read" mid-sentence is not a citation: "see John 9:41 tomorrow", "I'll see John 3:47 today" and "We will see Mark 4:12" are times. Only a capitalised See/Read/Compare/Cf. at the line or sentence start (after `^`, `. `, `; `, `: ` or an opening bracket/quote) counts, and TIME_WORD_AFTER still vetoes after a citation verb. "See John 3:16" and "Please see John 3:16." stay verses. Rework "Read John 3:16 today" accordingly and report.
3. **Review #4.** Test `g.num || g.ctx` before the zero-pad and time-range veto: "2 Peter 1:16-2:10" and "Matthew 5:17-7:12" are verse ranges. Let a citation verb outrank hour ≥ 13 ("See John 15:13" is a verse) only when the minutes aren't zero-padded multiples of five… keep it simple: hour ≥ 13 after a citation verb is a verse; without a verb it's a time.
4. **QA N5.** `2024-07-15 12:00 CHADT` is read as UTC. Add CHADT (+13:45) and CHAST (+12:45) to the parser's abbreviation offsets (ABBREV_OFFSETS in time-tokens.ts), and any other abbreviation that zone search offers but the parser doesn't read. Write a test that iterates ZONE_ABBREVIATIONS from src/lib/tz.ts and checks the parser reads each unambiguous code with its offset (skip region-suffixed or deliberately ambiguous ones, and list the skipped ones in the test).
5. **QA N11.** Custom formats: accept Java/Talend tokens `yyyy`, `yy`, `dd`, `d` (and `'T'`-style quoted literals) as aliases of `YYYY`, `YY`, `DD`, `D`. If any alias would be ambiguous with an existing token, keep the error but name the fix ("use DD for the day, not dd"). Test with `yyyy~MM~dd HH:mm`, `dd~MM~yyyy HH:mm` and `yyyy-MM-dd'T'HH:mm`.

## Worker B: storage and zones
Files: src/lib/storage.ts, src/lib/tz.ts, src/popup/ZonePicker.tsx, tests/storage-r3.test.ts, tests/zones-r4.test.ts, tests/zone-picker.test.tsx, new tests/zones-r5.test.ts.

1. **Review #1, two saves in a row.** Store `pt`, the `t` of the extras this context last followed, next to `pw`. Merge when `legacy.pw === extras.w || (isWriteTime(legacy.pt) && isWriteTime(extras.t) && extras.t <= legacy.pt)` and legacy is newer. Reproduce /tmp/tz-v2-review-r5/consec.mjs as a unit test (B saves twice before its extras lands; the peer then writes `lastCardSize`; Tokyo must stay removed). Keep the round-4 hybrid case (two devices' halves: extras whole) and every storage-r3 test passing. Update the comment.
2. **Review #6.** Search finds the punctuated display names: "St. John's", "st johns", "St Johns", "Dumont d'Urville", "dumont durville", "Lower Prince's Quarter". Strip `.` and `'`/`’` in `normalizeSearch`, or index the CITY_NAMES values.
3. **Review #7.** Own-table abbreviations must be right for their era. Add a `since` year (or valid-from instant) to the ABBR_PLACES/zones entries where history differs: Buenos Aires −03:00 was ARST before 1969 (summer time); BDT (Dhaka) from 1971; NPT from 1986 (+05:45). Without a known name for an era, return the Intl offset form. Test.
4. **QA N6.** The picker's "Already added: …" line shows whenever a listed (excluded) zone matches the query, not only when nothing else matches: "new york" with America/New_York added shows the ET result and "Already added: America/New_York". It's a non-selectable `aria-disabled` option at the end of the list (or a note under it), and keyboard navigation skips it. Test.

## Worker C: content script, manifest, background, README
Files: src/content/*, src/manifest.ts, src/background/*, README.md, STORE_LISTING.md, STORE_LISTING_FIREFOX.md (only to mention the shortcut and stepper), tests/content*.test.ts(x), tests/background.test.ts, e2e/v2.spec.ts, scripts/firefox-manifest.mjs (only if commands need Firefox handling). You may run `TARGET=chrome npx vite build && npx playwright test e2e/v2.spec.ts`, and `npm run build:firefox && npx web-ext lint --source-dir dist-firefox`.

1. **Review #2, the focus shortcut.** Alt+Shift+T is Chrome's "focus toolbar" on Windows, Linux and ChromeOS, and on macOS Option+Shift+T types "ˇ".
   - Replace the content-script key handler with a manifest `commands` entry (e.g. `"focus-card"`, description "Move focus to the open conversion card and back"). Pick a `suggested_key` not reserved by Chrome or Firefox: research the lists (Chrome keyboard shortcuts help page, Firefox's). Candidates: Alt+Shift+K, Alt+Shift+Y. On mac, use MacCtrl+Shift+K or Command+Shift+… only if free.
   - The service worker's `chrome.commands.onCommand` sends a message to the active tab's content script, which toggles focus as today.
   - Remove the keydown interception entirely, so page shortcuts are never blocked.
   - Read the effective binding with `chrome.commands.getAll` (via the background) and show it in the card's hint and aria-keyshortcuts; when unbound, the hint says to set one in the browser's shortcut settings.
   - Firefox MV3 supports `commands`; check scripts/firefox-manifest.mjs passes it through and web-ext lint stays at 0 errors.
   - Update README and store listings.
   - Tests: background command → message; content handler; manifest snapshot.
2. **QA N1 and review #5, reading order and marks.** Number stepper positions in reading order by `sourceIndex` (ties: best-first). Open on the best match, so the card may open on "2 of 3". Map the mark through `sourceIndex`: the content script parses `selection.toString()`, so build a map from that string's indices to (text node, offset) pairs in the selection range, accounting for collapsed whitespace and line breaks. This fixes "10:00\n UTC" marking the whole paragraph, and a refused earlier copy taking the mark. Remove or rework `matchSpans` if it's no longer needed. Tests.
3. **QA N2, the 25 cap.** Find where results are capped at 25. Either raise the cap (measure on a 60-time selection; keep under ~50 ms) or keep it and say so: "1 of 25+" with a title "Only the first 25 times are listed". Prefer showing the true count when it's cheap. Test.
4. **QA N3, compact cards.** Show a minimal stepper on compact cards ("‹ 1/2 ›", small) when there are several times. Test.
5. **QA N4, off-screen matches.** When stepping to a match outside the viewport, bring it into view without closing the card (today any scroll dismisses the transient card): scroll the match into view with `block: 'nearest'`, suppress the scroll-dismiss for that programmatic scroll, and re-anchor the card next to the new match. Test (unit with mocked rects; e2e at 1280×700 with 30 lines).
6. **QA N9.** An open card re-reads its text when settings that affect parsing or display change in another tab (numericDateOrder, hour12, target zones, home zone, formats), keeping the current step when the same match still exists. Test.
7. **README.** Document the stepper and the shortcut (and how to rebind it).

## Worker D: website and clock
Files: site/demo.ts, site/convert.ts, site/app.html, src/clock/model.ts, src/clock/Clock.tsx, tests/ui-r4.test.tsx, tests/site.test.ts, new tests/ui-r5.test.tsx. Run `node scripts/build-site.mjs` at the end.

1. **QA N8.** The website converter shows the other times found in the input, like the extension card: a "‹ 1 of N ›" stepper (reading order by `sourceIndex`, which worker A adds to ParsedTime; open on the best match) that switches the rows, the "Read as" hint, the format line and the day/month picker. Accessible (labelled buttons, aria-live count). Test in a DOM test like ui-r2's site test.
2. **Review #6 / QA N7.** The clock card subtitle for Etc/GMT±N shows the IANA id (`resolveZone(zone)?.long`, e.g. "Etc/GMT+12") under the "UTC-12:00" title, not the label twice. Test.
