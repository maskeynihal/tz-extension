# Firefox Add-ons (AMO) listing — TZ Converter

Copy for addons.mozilla.org (AMO) submission. Field names match the AMO
developer flow. Character limits noted where AMO enforces them.

Repo: https://github.com/maskeynihal/tz-extension
Current version: 0.5.0
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
• Pin cards to the page, each with its own colored highlight on the matched text.
• Toolbar popup converter — pick a source zone and time, read the rest.
• Epoch converter — Unix seconds/milliseconds to readable dates and back.
• Custom formats — teach it the date layouts your sites use.
• Light / Dark / System theme, with a quick toggle in the popup.
• 12- or 24-hour clock, your home zone, and your target zones — all configurable.

PRIVATE BY DESIGN
Everything runs locally in your browser. The add-on makes no network requests,
collects no data, and sends nothing off your device. Its only permission is
local storage, used to remember your preferences.

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

Permissions: only "storage" (for user preferences). No host permissions declared
beyond the content script needed for select-to-convert, which reads the user's
text selection to parse a time and renders a popover. No network requests are
made anywhere in the add-on.

Build: Vite + @crxjs/vite-plugin, React 18, date-fns-tz. The Firefox manifest is
produced by scripts/firefox-manifest.mjs, which converts the background to an
event-page script list, adds the gecko id and strict_min_version, declares
data_collection_permissions (none), and strips the Chrome-only use_dynamic_url
key. Source zip and build steps are in the repo README.
```

## Version notes (0.5.0)

```
- New: Light / Dark / System theme chooser in Settings, plus a quick theme
  toggle in the toolbar popup.
- Fix (Firefox): removed a Chrome-only manifest key (use_dynamic_url) and
  declared data_collection_permissions (none) — the add-on collects and
  transmits no data.
- Timezone conversion, epoch converter, select-to-convert popover, and
  pin-to-page all run fully offline.
```

## License / source

AMO requires source for add-ons built with a bundler/minifier. Point the "source
code" field at the public repo (https://github.com/maskeynihal/tz-extension) or
upload a source zip. Build command: `npm ci && npm run zip:firefox` produces
`tz-extension-firefox.zip`.
