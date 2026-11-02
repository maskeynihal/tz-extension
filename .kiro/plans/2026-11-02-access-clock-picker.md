# Always-on access, world clock on the website, date picker

Three pieces, on branch `feat/always-on-site-access` (PR #28).

## 1. Standing site access — done

`host_permissions: ['<all_urls>']`, matching the content script. Select-to-convert
starts when the user highlights text, not when they click the icon, so there is no
click for `activeTab` to hang temporary access on.

## 2. World clock moves to the website — done

The popup opens `tz.nihal.com.np/clock`; the extension builds no clock page.
`src/lib/site.ts` holds the URLs. The shared app (`src/clock/Clock.tsx`,
`mount.tsx`, `model.ts`, `clock.css`) stays for the website entry.

## 3. In progress

**A. One-click "Allow on all sites".** Browsers let the user withhold site access:
Chrome's Site access menu, Firefox's extensions button. Firefox MV3 goes further —
a content script only runs where host permission is granted, and the toolbar menu
offers *per-site* grants only; all-sites lives in `about:addons` → Permissions.
A sideloaded add-on starts with nothing granted and looks dead.

So the extension needs to offer the blanket grant itself:
`permissions.request({ origins: ['<all_urls>'] })` from a click is one prompt for
every site. Shown only when access is actually missing, so Chrome users who were
granted at install never see it.

**B. Date and time picker on the world clock.** The planner only reaches
−12 h … +36 h through the scrubber. A picker lets the user plan any date, in the
home zone's wall clock, with the project's DST conventions and the shared note.

## Ownership while both run in parallel

- A: `src/popup/*`, `src/background/service-worker.ts`, its own test files.
- B: `src/clock/*` (not `index.html`/`main.tsx`, which are gone), `tests/clock.test.tsx`,
  `e2e/site.spec.ts`, `site/clock.html`.
- Neither touches `src/manifest.ts`, `vite.config.ts`, `tests/manifest.test.ts`,
  `tests/clock-redirect.test.tsx`, `e2e/clock-redirect.spec.ts`, `e2e/v2.spec.ts`.

## Gate for both

`npm run typecheck`, `npm run lint`, `npx vitest run` (also under
`TZ=America/New_York`), `npm run build:all`, `npm run build:site`,
`npx playwright test`, `npx web-ext lint --source-dir dist-firefox`.
