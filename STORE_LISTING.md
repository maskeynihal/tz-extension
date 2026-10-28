# Chrome Web Store listing — TZ Converter

Copy for the Chrome Web Store Developer Dashboard. Field names match the store
form. Character limits noted where the store enforces them.

Repo: https://github.com/maskeynihal/tz-extension
Current version: 0.5.0

---

## Name (45 char max)

```
TZ Converter
```

## Short description / Summary (132 char max)

```
Convert timezones without leaving the page. Select any time you read and see it in your zones. Popup + epoch tools. Offline.
```

(123 chars.)

## Category

Productivity

## Detailed description

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
Everything runs locally in your browser. The extension makes no network
requests, collects no data, and sends nothing off your device. Its only
permission is local storage, used to remember your preferences.

Free and open source: https://github.com/maskeynihal/tz-extension
```

## Permission justifications

(Chrome asks you to justify each permission on submission.)

- **storage** — persists the user's preferences (home zone, target zones, clock
  format, theme, custom formats) locally. No data leaves the device.
- **Host permissions / content script (`<all_urls>`)** — the select-to-convert
  feature must read the user's text selection and render a popover on whatever
  page they are reading. It only reads the selected text to parse a time; it
  does not collect page content or make network requests.

## Privacy

- Single purpose: convert timezones for times the user selects or enters.
- Data collected: none. No analytics, no remote calls.
- Privacy policy URL (if required): the GitHub repo's README documents that no
  data is collected — https://github.com/maskeynihal/tz-extension

## Version notes (0.5.0)

```
- New: Light / Dark / System theme, with a quick toggle in the popup.
- Select-to-convert, popup converter, epoch tool, and pinned cards — all offline.
```
