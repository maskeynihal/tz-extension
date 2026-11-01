# Worker B: zones, zone picker and storage

Read common.md first.

Files you own: src/lib/tz.ts, src/lib/storage.ts, src/popup/ZonePicker.tsx, tests/tz.test.ts, tests/storage.test.ts, new tests/zone-picker.test.tsx, scripts/release-notes.mjs (only if needed).

Do not run npm run build*, e2e or playwright.

Verify:
- `npx vitest run tests/tz.test.ts tests/storage.test.ts tests/zone-picker.test.tsx tests/components.test.tsx`
- `npx tsc --noEmit`
- `npx eslint src/lib/tz.ts src/lib/storage.ts src/popup/ZonePicker.tsx tests --max-warnings=0`

Background: zone ids are IANA names, fixed offsets `UTC+05:45` / `UTC-08:00` (−12…+14), and `abbr:XXX` (PDT, EDT…; DST-aware generics abbr:PT/MT/CT/ET/AKT map to IANA). All resolve through `resolveZone` in tz.ts, which also has `zoneLabel`, `zoneGroups`, `searchZones`, `ZONE_ABBREVIATIONS`, `UTC_OFFSET_MINUTES`, `isValidZone`. ZonePicker is a grouped searchable combobox used in the popup, options, content-script cards (inside a shadow root) and the website.

## Fixes

1. Search accepts Unicode minus U+2212 and en dash wherever '-' is accepted: "UTC−5", "−08:00", "gmt−3".
2. City aliases in search, mapped to IANA zones: Mumbai, Delhi, New Delhi, Bangalore/Bengaluru, Chennai, Kolkata, Beijing, Shenzhen, San Francisco, Seattle, Las Vegas, Boston, Washington, Miami, Atlanta, Dallas, Houston, Austin, Montreal, Vancouver, Sydney, Melbourne, Dubai, Singapore, Hong Kong, Seoul, Tokyo, Paris, Berlin, Munich, Madrid, Barcelona, Rome, Milan, Amsterdam, Zurich, Geneva, Stockholm, Moscow, Istanbul, Cairo, Lagos, Nairobi, Johannesburg, Cape Town, São Paulo, Rio, Buenos Aires, Mexico City, Lima, Bogotá, Karachi, Lahore, Dhaka, Kathmandu, Jakarta, Manila, Bangkok, Hanoi, Ho Chi Minh/Saigon, Kuala Lumpur, Auckland, Honolulu, Anchorage, Reykjavik, Dublin, London, Lisbon, Tel Aviv, Jerusalem, Riyadh, Tehran, Kabul, Tashkent, Almaty, Colombo, Yangon, Perth, Brisbane, Adelaide, Denver, Phoenix, Chicago, Los Angeles, New York, and others you judge useful. Case- and accent-insensitive. Show why a result matched (e.g. "Mumbai" next to Asia/Kolkata). Keep the searchZones result shape backward compatible (additive fields only).
3. Offset shorthand: "+545", "+0545", "545", "+5:45", "-8", "−800" find UTC+05:45 / UTC-08:00 and IANA zones currently at that offset.
4. Ranking: exact abbreviation > exact city/alias > word prefix > substring inside a word. "ist" puts India (Asia/Kolkata / abbr:IST) first, not Pak-ist-an. "gmt+1" puts UTC+01:00 first and "+1" never matches +10…+14 ahead of it.
5. Distinct short labels: `IST-IE` → "IST (IE)", `CST-CN` → "CST (CN)". Find any other short-label collisions and fix them. Add a test that all short labels are unique.
6. Legacy IANA aliases (Asia/Katmandu, Asia/Calcutta, Asia/Saigon, Asia/Rangoon, Europe/Kiev, America/Buenos_Aires…): search and groups show only the canonical name; saved legacy ids stay valid and display with the canonical label.
7. `zoneGroups(now)` cache ignores `now`: key it on Math.floor(now / 60000). Test a January date against a November build.
8. ZonePicker:
   - Hoist the default `exclude` / `suggested` arrays to module constants so useMemo works.
   - Home/End move to the first/last option.
   - Escape follows the contract in common.md.
   - When the query exactly matches an excluded zone, show "Already added" instead of an empty result.
   - Keep aria-activedescendant and roles correct.
   - Selected/active option meets WCAG AA (4.5:1) in light and dark.
9. Cross-version sync hazard. Older installs (0.6.x, where `isValidZone` accepts only Intl-valid ids) drop `UTC+05:45` / `abbr:*` ids from targetZones/homeZone and the new fields (`cardSize`, `lastCardSize`, `numericDateOrder`) on their next save, which syncs back and deletes them everywhere. Read storage.ts fully first. Then:
   - Keep writing the legacy key with legacy-valid values only. Remove new-style ids from targetZones. Replace a new-style homeZone with a legacy-safe equivalent (IANA zone for abbr generics, else the best IANA or "UTC").
   - Write a second sync key (e.g. `tz-extension-prefs-v2-extras`) with the new-only fields, the full targetZones/homeZone, and a fingerprint of the legacy zone values written.
   - On load, if the legacy zone values match the fingerprint, use the extras' full values. If an old device changed them, take its list as the truth for legacy ids and re-insert the new-style ids from extras at their original relative positions. Take new-only fields from extras. Document the rule in code.
   - Both items respect SYNC_ITEM_LIMIT (8192 bytes); the save path checks both.
   - onPreferencesChanged fires with merged prefs for a change to either key.
   - Tests simulate an old-device write (strip new ids and fields from the legacy key).
   - The localStorage path can keep storing full prefs (no old versions there).
10. Explicit website backend:
   - Export `useWebStorageBackend(): void` (exact name; worker D calls it first thing in site entry points).
   - Without it and without chrome.storage: load returns defaults; save returns `{ ok: false, error }`; localStorage is never touched.
   - The web backend listens to window `storage` events so onPreferencesChanged fires for cross-tab changes, plus the existing same-tab listeners.
   - Test both modes.

QA evidence for search: /tmp/tz-v2-blind-r1/picker.log, picker2.log, zones.log.

In your report, include the exported API names and signatures other workers depend on.
