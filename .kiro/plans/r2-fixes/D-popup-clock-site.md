# Worker D (round 2): popup, settings, world clock, website

Read common.md first.

Files you own:
- src/popup/App.tsx, Converter.tsx, EpochTab.tsx, popup.css (not ZonePicker.tsx)
- src/options/*, src/clock/*
- site/*, scripts/build-site.mjs, docs/* (only through the site build)
- tests/options.test.tsx, tests/clock.test.tsx, tests/components.test.tsx, tests/popup-fixes.test.tsx, tests/site.test.ts, and a new tests/ui-r2.test.tsx

Do not run build:chrome/firefox/all or playwright. At the end run `node scripts/build-site.mjs`.

Verify:
- `npx vitest run tests/options.test.tsx tests/clock.test.tsx tests/components.test.tsx tests/popup-fixes.test.tsx tests/site.test.ts tests/ui-r2.test.tsx`
- `npx tsc --noEmit`
- `npx eslint src/popup src/options src/clock site tests --max-warnings=0`
- `node scripts/build-site.mjs`

## Fixes

1. **Converter LOCAL tag and Local chip (review #3).** Use `sameZone(…, LOCAL_ZONE)` for `sourceIsLocal` and `isLocal` in Converter.tsx, and check the whole popup/clock/options for other `=== LOCAL`-style comparisons. Test with a mocked local zone of "Asia/Katmandu" and home "Asia/Kathmandu".
2. **DST in the popup (QA #1/#2).** Converter and EpochTab: use `wallClockToInstant` (B adds it to tz.ts; signature in common.md) and show a short note under the input when the typed time is a gap ("02:30 doesn't exist on 10 Mar in New York; using 03:30.") or ambiguous ("01:30 happens twice on 3 Nov in New York; using the first, EDT."). Use `zoneLabel`. Test both. If B's function isn't there yet when you start, write against the contract and say so.
3. **Clock zone names (QA #7).** The world clock shows "Katmandu" and "Planning … in Katmandu", and "ComodRivadavia" where cards show "Catamarca". Derive every displayed name from the canonical zone (B adds a helper, probably `displayZoneName`; until then use `resolveZone(id)?.short` / `zoneLabel`). Test with legacy ids.
4. **Clock scale labels (QA #13).** The −12h…+36h labels look like presets but are inert spans. Make them buttons that set the planner offset to that value (with aria-labels like "Plan 12 hours ahead"), or restyle them as plain tick marks. Prefer buttons, keyboard-accessible. Test.
5. **Website epoch mode (QA #14).** It rejects `-1` and `0` while "Any time" accepts `-1700000000`. Find what epoch mode accepts and make it consistent: 0 and negative epochs are valid. Test via the site code where testable (site/*.ts helpers), or extract a helper.
6. **Website 12h/24h control.** Same labelled segmented control as the extension, replacing the single toggle chip on the website app.
7. **Format example at 390 px (QA partial).** `1999-03-22T05:06:07,000[Europe/Paris]` still breaks after "1999-03-". Let long examples break only at sensible points: before "T", before "[", after "," or a space. Use `<wbr>` insertion in the rendering, with `white-space: nowrap` on the pieces. Test that the rendered example contains wbr at those points and the CSS keeps pieces whole.
8. **Display minus (contract 4).** Remove hard-coded "−" in display code in your files (clock diffs like "−3h" may stay typographic if they are not offsets that users copy; decide and say which). Update assertions.
9. Rebuild docs/ (`node scripts/build-site.mjs`).
