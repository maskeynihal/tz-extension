# Worker B (round 2): zones and storage

Read common.md first.

Files you own: src/lib/tz.ts, src/lib/storage.ts, src/popup/ZonePicker.tsx, src/types/index.ts (only `resolveLocalZone` and `DEFAULT_PREFERENCES`; don't touch the ParsedTime contract), tests/tz.test.ts, tests/storage.test.ts, tests/zone-picker.test.tsx, and a new tests/zones-r2.test.ts. Do not run builds or playwright.

Verify:
- `npx vitest run tests/tz.test.ts tests/storage.test.ts tests/zone-picker.test.tsx tests/zones-r2.test.ts tests/wallclock.test.ts tests/components.test.tsx`
- `npx tsc --noEmit`
- `npx eslint src/lib src/popup/ZonePicker.tsx src/types tests --max-warnings=0`

The full suite will show failures in other workers' tests that assert "−" in labels. List them in your report so the lead can route them; you may fix assertions in tests/tz.test.ts, zone-picker.test.tsx and storage.test.ts yourself.

## Fixes

1. **Local zone under its legacy name (review #3, QA #7).** Chrome reports `Asia/Katmandu` while lists save `Asia/Kathmandu`.
   - `resolveLocalZone()` (src/types/index.ts) returns the canonical current name. Import from src/lib/tz.ts only if that creates no import cycle (tz.ts must not import src/types at runtime; check). Otherwise move the canonicalisation data into a small module both can import.
   - `DEFAULT_PREFERENCES.homeZone` is then canonical.
   - Worker D switches the converter's `===` to `sameZone`; you make sure `sameZone(legacy, canonical)` is true for every LEGACY_ZONES pair and for America/Argentina/ComodRivadavia vs Catamarca.
   - Add `displayZoneName(zone): string` (or reuse an existing function) that gives the canonical city label. Worker D uses it in the clock instead of deriving names from raw ids. Tell the lead the exact name.
2. **`ianaEquivalent` for ±45-minute and other odd offsets (review #4).** UTC+12:45 / +13:45 → Pacific/Chatham, +05:45 → Asia/Kathmandu (already), +08:45 → Australia/Eucla, +09:30 / +10:30 → the right Australian zone for the season, −09:30 → Pacific/Marquesas, −03:30 / −02:30 → America/St_Johns. Never "UTC" for an offset that a real zone has. Test each.
3. **The ABA quirk (review #4, part 1).** Document it as accepted in the "Sync across versions" comment. The cost is cosmetic: abbr:PT and America/Los_Angeles show the same clock. Add a test that pins the behaviour so it's deliberate.
4. **Optional robustness (review "design assumption").** Add a shared write id (e.g. a random `w` or a counter in both items). `fromSyncItems` uses it to tell "extras newer than legacy, legacy not yet arrived" (same write id missing → treat legacy as stale and use extras' full values) from "an old device edited legacy" (legacy has no write id or a different one). Do it only if it fits cleanly. 0.6.x preserves unknown fields? It doesn't: its sanitize drops them, so an old-device write has no `w`, which is exactly the signal. Test the sequences from /tmp/tz-v2-review-r2/sync-sim.mjs (the reviewer bundled the base storage.ts; reuse that approach in a unit test if practical, or simulate by stripping fields).
5. **"usa" search (review #5).** Add US / USA / United States / America (country) aliases on the US zones, ranked sensibly (ET, CT, MT, PT, AKT, HT, plus their IANA zones). Also check "uae", "uk", "england", "scotland", "russia", "brazil", "canada", "australia", "mexico", "indonesia" (multi-zone countries list their main zones).
6. **Display minus (contract 4).** All display labels and offsets from tz.ts use ASCII "-": `offsetLabel`, `offsetString` if it's used for display, `viewInZone().offset`, group labels and option details. Search still accepts U+2212 and en dash. Update your tests.
7. **`wallClockToInstant` (contract 3).** Export `wallClockToInstant(isoLocal: string, zone: string): WallInstant | null` built on `parseWallIso` + `wallFieldsToInstant` with `tzOf(zone)`, and make `wallClockToEpochMs` use it (NaN on null). Test a gap and an overlap through both.
