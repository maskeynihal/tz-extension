# Firefox Add-ons (AMO) listing — TZ Converter

Copy for addons.mozilla.org (AMO) submission. Field names match the AMO
developer flow. Character limits noted where AMO enforces them.

Repo: https://github.com/maskeynihal/tz-extension
Current version: 0.8.1
Add-on id: tz-converter@maskeynihal
strict_min_version: Firefox 128

---

## Name (50 char max)

```
TZ Converter
```

## Summary (250 char max)

```
Convert timezones without leaving the page. Select any time you're reading — ISO, a Unix epoch, or "October 28, 2026, 04:24 UTC" — and see it in your zones instantly. Plus a popup converter and epoch tool. Fully offline, no data collected.
```

(239 chars.)

## Categories

Primary: Other / Productivity
(AMO's closest fits: "Tabs" no; choose the productivity-leaning category.)

## Description

```
TZ Converter turns timezone math into a glance.

Select any time on any web page — an ISO timestamp, a Unix epoch, or a long
date like "Wednesday, October 28, 2026, 04:24 UTC" — and a small card shows it
in every timezone you care about. No tab-switching, no mental arithmetic.

FEATURES
• Select-to-convert — highlight a time, see it in your zones right there.
• Right-click any selection → "Convert with TZ Converter". Prefer no automatic
  popups? Turn select-to-convert off and use only the menu.
• Several times in one selection? Step through them with ‹ 1 of 3 ›, in the
  order they appear; the card marks each one on the page.
• Keyboard friendly — Alt+Shift+K (Ctrl+Shift+K on Mac) moves focus into the
  open card and back. Change the key in Add-ons → ⚙ → Manage Extension
  Shortcuts.
• Pin cards to the page, each with its own colored highlight on the matched text.
• Toolbar popup converter — pick a source zone and time, read the rest.
• Epoch converter — Unix seconds/milliseconds to readable dates and back.
• Every recognized format listed in Settings — switch off any that misfire.
• Custom formats — teach it the date layouts your sites use, with a live tester.
• Light / Dark / System theme, with a quick toggle in the popup.
• 12- or 24-hour clock, your home zone, and your target zones — all configurable.
• World clock — the popup's clock button opens tz.nihal.com.np/clock with your
  zones: live clocks, working hours, and a planner with a slider on every zone
  and a date & time picker for any day.
• Asks for site access in one click if your browser withheld it, and marks the
  toolbar icon until it has it.

PRIVATE BY DESIGN
Everything runs locally in your browser. The add-on makes no network requests,
collects no data, and sends nothing off your device. Your preferences are saved
in the browser's own storage, and synced only by the browser's account sync if
you have it turned on. It adds one right-click menu item. The world clock
button opens the website in a tab; your zones travel in the link's # fragment,
which browsers never send to a server.

Free and open source: https://github.com/maskeynihal/tz-extension
```

## Data collection

AMO now asks add-ons to declare data collection. This one collects nothing — the
manifest declares `data_collection_permissions: { required: ["none"] }`. In the
form, select **"This add-on does not collect any data."**

## Notes to Reviewer

```
No account or login is required to test. Select any date/time text on a page, or
open the toolbar popup, to convert. All conversion runs locally.

On the "Unsafe assignment to innerHTML" validation warning:
This add-on is open source (https://github.com/maskeynihal/tz-extension) and
built with React 18. The flagged innerHTML assignments live inside the bundled
react-dom library, not our code. Our own source contains ZERO uses of innerHTML,
dangerouslySetInnerHTML, outerHTML, insertAdjacentHTML, or document.write — this
is verifiable in the repository. The add-on never renders remote or
user-supplied HTML: it parses the text the user selected into a date and
displays computed times as plain React text nodes.

Permissions: "storage" (user preferences), "contextMenus" (one right-click
"Convert" item for selected text), and "activeTab" + "scripting" (after that
menu click, inject the add-on's own packaged content script into the current tab
if it is not running there yet, e.g. a site the user has not granted access to;
and, right after the user grants all-sites access from the add-on's "Allow on
all sites" button, into the tabs already open, since content scripts otherwise
reach only pages loaded later).
Host permissions are declared for all sites, matching the content script that
select-to-convert needs: the feature starts when the user highlights text on
the page rather than by clicking the add-on, so there is no click for the
browser to hang temporary access on. It reads the user's text selection to
parse a time and renders a popover. No network requests are made anywhere in
the add-on.

Site access on Firefox: MV3 host permissions can be withheld, and a fresh
install may start without them. On a first install with access withheld the
add-on opens its own settings page, where an "Allow on all sites" button calls
permissions.request({origins: ["<all_urls>"]}) from the user's click, and the
toolbar icon shows a "!" badge until access is granted or the user chooses
"Don't show again". It asks for nothing beyond what the manifest declares.

The popup's world clock button opens https://tz.nihal.com.np/clock in a new
tab, with the user's zones in the URL fragment (never sent to the server). The
popup footer links to the author's site, GitHub and LinkedIn. The add-on itself
fetches nothing.

Build: Vite + @crxjs/vite-plugin, React 18 (time zone maths uses the browser's Intl API; no time library). The Firefox manifest is
produced by scripts/firefox-manifest.mjs, which converts the background to an
event-page script list, adds the gecko id and strict_min_version, declares
data_collection_permissions (none), and strips the Chrome-only use_dynamic_url
key. Source zip and build steps are in the repo README.
```

## Version notes (0.8.x)

```
- Select-to-convert works from install: the add-on declares access to all
  sites, which it needs because conversion starts when you highlight text.
- If Firefox withheld that access, the add-on opens its settings with one
  "Allow on all sites" button, and marks its icon with "!" until it is allowed.
- The world clock moved to tz.nihal.com.np/clock; the popup's clock button opens
  it with your zones. It plans any date and time, with a slider on every zone.
- Credits and links to the author in the popup.
```

## License / source

AMO requires source for add-ons built with a bundler/minifier. Point the "source
code" field at the public repo (https://github.com/maskeynihal/tz-extension) or
upload a source zip. Build command: `npm ci && npm run zip:firefox` produces
`tz-extension-firefox.zip`.

## Source-code submission answer (build tools)

AMO asks: do you use code generators/minifiers, file-combining tools (webpack),
template engines, or any processing that generates the shipped code? **Yes.**

Tools used:
- **Vite 5.4.11** + **@crxjs/vite-plugin 2.0.0** — bundles the TypeScript/React
  source and CSS into the shipped `assets/*.js` and `.css` files (file combiner,
  like webpack).
- **esbuild 0.21.5** — Vite's default minifier; minifies the JavaScript.
- **TypeScript 5.6.3** — compiles `.ts`/`.tsx` to JavaScript (code generator).
- **@vitejs/plugin-react 4.3.3** — transforms JSX to JavaScript.
- No HTML/CSS template engine. CSS is plain CSS (with a design-token file),
  concatenated by the bundler.

Build instructions to paste in AMO's "how to build" field:

```
Requirements: Node.js 20+ (package.json engines: node >=20; built with 20.x /
24.x) and npm. A package-lock.json is committed for exact dependency versions.

1. Unzip the source archive, or clone:
   git clone https://github.com/maskeynihal/tz-extension
2. Install the exact dependencies:
   npm ci
3. Build the Firefox add-on:
   npm run zip:firefox

This runs, in order: a TypeScript type-check (tsc --noEmit), a Vite production
build with TARGET=firefox, then scripts/firefox-manifest.mjs (which rewrites the
manifest into Firefox MV3 shape: background.scripts, the gecko id and
strict_min_version, data_collection_permissions "none", and strips the
Chrome-only use_dynamic_url key), then zips dist-firefox/ into
tz-extension-firefox.zip (source maps and dotfiles excluded).

All build configuration lives in the repository: package.json, vite.config.ts,
src/manifest.ts, and scripts/firefox-manifest.mjs. No build step fetches remote
code; everything comes from the pinned npm dependencies.
```

