# Chrome Web Store listing — TZ Converter

Copy for the Chrome Web Store Developer Dashboard. Field names match the store
form. Character limits noted where the store enforces them.

**Keep the dashboard in step with the manifest.** CI uploads each release and
submits it, but it cannot edit the listing. When a release adds a permission or
host access, its justification must be pasted into the dashboard's Privacy tab
first; until then every submit fails with `HTTP 400 INVALID_ITEM_METADATA`
("Your submission does not meet the requirements to be published"), even though
the upload itself succeeded. Paste the new justification, save, then submit the
draft from the dashboard or re-publish the tag (PUBLISHING.md section 6).

Repo: https://github.com/maskeynihal/tz-extension
Current version: 0.8.1
Manifest: `permissions: ["storage", "contextMenus", "activeTab", "scripting"]`, `host_permissions: ["<all_urls>"]`

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
• Right-click any selection → "Convert with TZ Converter". Prefer no automatic
  popups? Turn select-to-convert off and use only the menu.
• Several times in one selection? Step through them with ‹ 1 of 3 ›, in the
  order they appear; the card marks each one on the page.
• Keyboard friendly — Alt+Shift+K (Ctrl+Shift+K on Mac) moves focus into the
  open card and back. Change the key in chrome://extensions/shortcuts.
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
Everything runs locally in your browser. The extension makes no network
requests, collects no data, and sends nothing off your device. Your preferences
are saved in the browser's own storage, and synced only by the browser's
account sync if you have it turned on. It adds one right-click menu item.
The world clock button opens the website in a tab; your zones travel in the
link's # fragment, which browsers never send to a server.

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

### Permission justification — contextMenus

```
Adds one right-click menu item, "Convert “<selection>” with TZ Converter", shown
only when text is selected. Clicking it converts the selected date or time into
the user's timezones in a small popover on the page. This lets users who turn off
automatic select-to-convert still convert on demand.
```

### Permission justification — activeTab

```
Used only when the user clicks the extension's right-click menu item in a tab
where the content script is not running yet (for example a tab that was open
before the extension was installed or updated). The click grants temporary
access to that one tab so the converter can be shown there. No other tabs are
accessed and nothing is read beyond the user's selection.
```

### Permission justification — scripting

```
Loads the extension's own bundled content script into a tab that does not have
it yet, in two cases, both started by the user:
1. Together with activeTab, after the user clicks the right-click "Convert"
   item in the current tab.
2. Right after the user grants site access from the extension's "Allow on all
   sites" button: the browser applies content scripts only to pages loaded
   afterwards, so the extension loads it into the tabs that are already open,
   limited to the URLs its manifest content script matches.
Only files packaged in the extension are injected; no remote code, no arbitrary
code strings.
```

### Permission justification — host permissions (`<all_urls>`)

```
The core feature is "select to convert": the user highlights a time on any web
page and the extension shows it in their timezones in a small popover. To work
on whatever page the user is reading, the content script must run on all sites,
so the extension declares host access to all sites.

The access has to be standing rather than granted per click. The feature is
triggered by the user selecting text on the page, not by clicking the
extension's icon, so there is no click for the browser to hang temporary
access on. With activeTab alone the extension would convert nothing until the
user first opened its popup in that tab.

It only reads the text the user has actively selected, in order to parse a
time, and injects a popover UI. It does not read, collect, or transmit page
content, and makes no network requests.
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
not by any actual remote code. The manifest declares `permissions:
["storage", "contextMenus", "activeTab", "scripting"]`, `host_permissions:
["<all_urls>"]`, no custom CSP, and no `eval`. `scripting` only injects the
extension's own packaged content-script file, so the honest answer is that no
remote code is used.

## Version notes (0.8.x)

```
- Select-to-convert works from install: the extension now declares access to
  all sites, which it needs because conversion starts when you highlight text,
  not when you click the icon.
- If your browser withheld that access, the extension asks once in a tab and
  shows a "!" on its icon until it is allowed.
- The world clock moved to tz.nihal.com.np/clock; the popup's clock button opens
  it with your zones. It plans any date and time, with a slider on every zone.
- Credits and links to the author in the popup.
```
