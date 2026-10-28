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

## Privacy practices tab — required fields (copy/paste)

The Chrome Web Store "Privacy practices" tab requires all of the following before
you can publish. Paste each verbatim.

### Single purpose description

```
TZ Converter converts timezones for date and time values the user selects on a
web page or enters in the extension. It parses the selected or entered time and
displays the equivalent time in the user's chosen timezones.
```

### Permission justification — storage

```
The storage permission saves the user's preferences locally: their home
timezone, target timezones, 12/24-hour clock, theme, date-handling policy, and
any custom date formats. This data stays on the user's device and syncs only
through the browser's own account sync. No preference data is sent to us or any
third party.
```

### Permission justification — host permissions (content script on all sites)

```
The core feature is "select to convert": the user highlights a time on any web
page and the extension shows it in their timezones in a small popover. To work
on whatever page the user is reading, the content script must run on all sites.
It only reads the text the user has actively selected, in order to parse a time,
and injects a popover UI. It does not read, collect, or transmit page content,
and makes no network requests.
```

### Remote code justification

Answer "No" to "uses remote code" if asked. If a justification box is required:

```
This extension does not use remote code. All JavaScript is bundled into the
package at build time (Vite + esbuild). There are no eval calls, no remotely
hosted scripts, and no dynamically fetched or executed code. The extension makes
no network requests of any kind.
```

### Data usage certification

- Data collected: NONE — check no data categories.
- Check "I do not sell or transfer user data to third parties, outside of the
  approved use cases."
- Check "I do not use or transfer user data for purposes unrelated to my item's
  single purpose."
- Check "I do not use or transfer user data to determine creditworthiness or for
  lending purposes."
- Tick the final "I certify that my data usage complies with the Developer
  Program Policies."

### Why Chrome flags "remote code" here

It is a conservative flag triggered by the content script matching `<all_urls>`,
not by any actual remote code. The manifest declares only `permissions:
["storage"]`, an empty `host_permissions`, no custom CSP, and no `eval` — so the
honest answer is that no remote code is used.

## Version notes (0.5.0)

```
- New: Light / Dark / System theme, with a quick toggle in the popup.
- Select-to-convert, popup converter, epoch tool, and pinned cards — all offline.
```
