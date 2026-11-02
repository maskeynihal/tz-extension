# Worker D: popup, settings, world clock, website

Read common.md first.

Files you own:
- src/popup/App.tsx, Converter.tsx, EpochTab.tsx, popup.css (not ZonePicker.tsx, which belongs to B)
- src/options/*, src/clock/*
- site/*, scripts/build-site.mjs
- docs/* (only through the site build)
- tests/options.test.tsx, tests/clock.test.tsx, the Converter/popup parts of tests/components.test.tsx
- new tests/popup-fixes.test.tsx or tests/site.test.ts

Do not run build:chrome/firefox/all or playwright. At the end run `node scripts/build-site.mjs` directly (`npm run build:site` runs tsc first, which may fail on others' work).

Verify:
- `npx vitest run tests/options.test.tsx tests/clock.test.tsx tests/components.test.tsx` (plus new files)
- `npx tsc --noEmit`
- `npx eslint src/popup src/options src/clock site scripts tests --max-warnings=0`
- `node scripts/build-site.mjs`

## Fixes

1. **Major.** The popup Converter's initial datetime is "now" as wall clock in the source/home zone (`epochMsToWallClock(Date.now(), sourceZone)` or the existing equivalent). Changing the source zone, including to "Local", keeps the same instant and re-expresses the wall clock instead of keeping the digits. See /tmp/tz-v2-blind-r1/popnow.mjs. Test.
2. site/demo.ts `dayMonth` passes a display label as a zone, giving "Invalid Date". Render picker labels from `dateOrder.date` / `dateOrder.alternate.date` via formatCalendarDate.
3. Website storage: call `useWebStorageBackend()` from src/lib/storage.ts as the first statement of every website entry point (site/demo.ts, and the site's clock and app pages; check scripts/build-site.mjs and site/*.html). The clock page shares src/clock with the extension, so add a site-specific entry or have the site build inject it. The extension clock page must not opt in. The site app re-renders on onPreferencesChanged (cross-tab). B is writing the function concurrently; if it doesn't exist yet when you finish, still write the call and say so.
4. SortableList (src/options/SortableZoneList.tsx): `onLostPointerCapture={(e) => onPointerEnd(e, 'cancel')}`, so a lost capture can't block later drags. Test.
5. World clock (src/clock/):
   - Move the FLIP measurement (offsetLeft/offsetTop of every card each second) behind an order key, so it runs only when the order changes.
   - Memoize ZoneCard on what it displays.
   - The gear/settings button wraps at 390 px: fix.
   - The 12h/24h chip is unclear as a toggle: make it an explicit labelled segmented control (radio or aria-pressed).
   - Test diff and relative day at DST-transition instants (2026-03-08 America/New_York, 2026-03-29 Europe/London).
6. Contrast and cosmetics in the popup, options and clock (QA: /tmp/tz-v2-blind-r1/shots, opt1.log, settings.log, clock.log, pages.log, site1.log, site2.log):
   - Selected segmented buttons in dark mode need AA (4.5:1).
   - The "M/D" hint on the active date-order pill in settings.
   - Offset clipped at 390 px, if it's in these surfaces.
   - Format examples in the settings Formats list break mid-token: keep each token whole.
7. site/app.html footer gets a Privacy link like the other pages.
8. Rebuild docs/ and confirm the pages reference existing chunks.
