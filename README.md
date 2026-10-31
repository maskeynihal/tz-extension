# TZ Converter — Timezone Tools

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/cokhjgalkhboifkgoomlbaigocjpmhkk?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/tz-converter-%E2%80%94-timezone-t/cokhjgalkhboifkgoomlbaigocjpmhkk) [![Firefox Add-ons](https://img.shields.io/amo/v/tz-converter-timezone-tools?label=Firefox%20Add-ons)](https://addons.mozilla.org/en-US/firefox/addon/tz-converter-timezone-tools/)

A Manifest V3 browser extension for timezone conversion. Works in Chromium (Chrome, Edge, Brave) and Firefox.

**[Chrome Web Store](https://chromewebstore.google.com/detail/tz-converter-%E2%80%94-timezone-t/cokhjgalkhboifkgoomlbaigocjpmhkk)** · **[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tz-converter-timezone-tools/)** · **[Website](https://maskeynihal.github.io/tz-extension/)** · **[Live converter](https://maskeynihal.github.io/tz-extension/app.html)** · **[Latest release](https://github.com/maskeynihal/tz-extension/releases/latest)** · **[Privacy](https://maskeynihal.github.io/tz-extension/privacy.html)**

No install needed to try it — the [online converter](https://maskeynihal.github.io/tz-extension/app.html) runs the same engine the extension ships.

## Demo

A real walkthrough of every feature, in an actual browser:

https://github.com/maskeynihal/tz-extension/raw/main/docs/assets/demo-real.mp4

<sub>Can't see the player? <a href="https://github.com/maskeynihal/tz-extension/raw/main/docs/assets/demo-real.mp4">Download the demo</a> · or watch the <a href="https://github.com/maskeynihal/tz-extension/raw/main/docs/assets/launch.mp4">20-second montage</a>.</sub>

| Select to convert | Full converter |
|---|---|
| ![Selecting a timestamp on a page shows a conversion card](docs/assets/select-to-convert.png) | ![The popup converter across several timezones](docs/assets/popup.png) |

## Features

1. **Select to convert.** Select any text on a page. If it parses as a date/time, a small popover appears next to your selection showing that time in your chosen timezones. Renders in an isolated Shadow DOM, clamps to the viewport, and stays silent when the selection is not a time.
2. **Full converter.** The toolbar popup takes a date + source timezone and shows it in any number of target zones. "Now" button, 12/24-hour toggle, DST-correct, inline validation.
3. **Epoch converter.** Paste a Unix timestamp (seconds or milliseconds — auto-detected, overridable) to see it in your zones plus ISO-8601 UTC. Reverse direction too: a date back to an epoch.
4. **Right-click to convert.** Select text, right-click, and choose **Convert “…” with TZ Converter**. Works even when automatic select-to-convert is off, and says so when the selection holds no time it recognizes.
5. **Formats you control.** The settings page lists every built-in format (with its regular expression) and lets you switch any of them off. Add your own formats with tokens such as `DD/MM/YYYY HH:mm`, `MMM D, YYYY h:mm A` or `DD.MM.YYYY [um] HH:mm`, or with a raw regex using named groups. A live tester shows which format matches a piece of text.

Settings also cover: home zone, target zones (add, reorder, remove), 12/24-hour clock, theme, the date-only time policy, keeping the selection highlighted, and **Convert when I select text** (turn it off to convert only from the right-click menu). Everything is persisted via `chrome.storage`.

### Custom format tokens

| Token | Meaning | Token | Meaning |
|---|---|---|---|
| `YYYY` / `YY` | 4- / 2-digit year | `HH` / `H` | hour 00-23 / 0-23 |
| `MM` / `M` | month 01-12 / 1-12 | `hh` / `h` | hour 01-12 / 1-12 (needs `A`) |
| `MMMM` / `MMM` | month name / short name | `mm`, `ss`, `SSS` | minutes, seconds, milliseconds |
| `DD` / `D` / `Do` | day 01-31 / 1-31 / 5th | `A` | AM/PM, any case, `a.m.` too |
| `TZ` | `UTC`, `EST`, `+05:45`, `GMT+1` | `[text]` | literal text, e.g. `[at]` |

A format needs a month and a day, or just a time (it then means today). The year is optional (defaults to this year). When formats overlap, the longest match wins; on a tie, custom formats beat built-ins. Raw regexes must use the groups `y yy mo moName d h mi s ms ap zone`, may not repeat a repeating group such as `(a+)+`, and only scan the first 500 characters of a selection.

## Install

- **Chrome, Edge, Brave and other Chromium browsers:** [Chrome Web Store](https://chromewebstore.google.com/detail/tz-converter-%E2%80%94-timezone-t/cokhjgalkhboifkgoomlbaigocjpmhkk)
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tz-converter-timezone-tools/)

Store updates follow each GitHub release once the store review passes.

### From source (unpacked)

#### Chrome / Edge

1. `npm run build:chrome` → produces `dist/`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `dist/`.

#### Firefox

1. `npm run build:firefox` → produces `dist-firefox/`
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**.
3. Select `dist-firefox/manifest.json`.

Prebuilt `tz-extension-chrome.zip` and `tz-extension-firefox.zip` are attached to every [release](https://github.com/maskeynihal/tz-extension/releases/latest); unzip one and load the folder the same way.

## Development

```bash
npm install          # install dependencies
npm run dev          # Vite dev server (Chrome manifest)
npm run dev:firefox  # Vite dev server (Firefox manifest)
```

## Build & package

| Command | Output |
|---|---|
| `npm run build:chrome` | `dist/` |
| `npm run build:firefox` | `dist-firefox/` |
| `npm run build:all` | both |
| `npm run zip:chrome` | `tz-extension-chrome.zip` |
| `npm run zip:firefox` | `tz-extension-firefox.zip` |
| `npm run zip:all` | both zips |
| `npm run zip:source` | `tz-extension-source.zip` (tracked files, for AMO review) |

Zips contain the extension at the top level (manifest at root), source maps stripped — ready for the Chrome Web Store and AMO.

## Releasing

Every merge to `main` bumps the version from Conventional Commits, tags it, attaches both zips to a GitHub release, and submits the new version to the Chrome Web Store and Firefox Add-ons. Store credentials, local dry runs, and re-publishing a tag are covered in [PUBLISHING.md](PUBLISHING.md).

## Quality gate

```bash
npm run typecheck    # tsc --noEmit (strict, no any)
npm run lint         # eslint, zero warnings
npm test             # vitest unit tests
npm run e2e          # playwright smoke test
```

## Stack

- **Build:** Vite 5 + `@crxjs/vite-plugin` 2
- **UI:** React 18 + TypeScript (strict)
- **Time:** `date-fns` + `date-fns-tz` (DST-correct, fractional offsets)
- **Tests:** Vitest + Testing Library (unit), Playwright (e2e)

## Permissions

- `storage`: saves your settings.
- `contextMenus`: the right-click **Convert “…”** item.
- `activeTab` + `scripting`: if you use that item in a tab where the content script is not running yet (opened before install or update, or a Firefox site you have not granted access to), it is injected into that tab after your click.

No `host_permissions`. The content script runs at `document_idle` on all pages purely to read your text selection; nothing leaves the browser.

## Project layout

```
src/
  background/   MV3 service worker (seeds prefs, right-click menu, on-demand injection)
  content/      select-to-convert popover (Shadow DOM)
  popup/        converter + epoch tabs
  options/      settings: zones, preferences, formats (Formats.tsx)
  lib/          parse.ts (orchestrates matching), builtin-formats.ts (format
                registry), custom-formats.ts (token/regex compiler),
                time-tokens.ts, tz.ts, epoch.ts, storage.ts, messages.ts
  types/        shared types
scripts/
  firefox-manifest.mjs   rewrites the manifest to Firefox MV3 shape
  publish-chrome.mjs     uploads + submits a zip to the Chrome Web Store (API v2)
  publish-firefox.mjs    submits a zip + source archive to AMO via web-ext sign
  source-archive.mjs     builds tz-extension-source.zip with git archive
```

## License

Not yet licensed. Add a `LICENSE` file (MIT is a reasonable default) before publishing.
