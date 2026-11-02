# Round-1 fixes: common rules for every worker

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension (MV3 extension "TZ Converter", Chrome + Firefox, TypeScript strict, React 18, vitest, Playwright; website in site/ built by scripts/build-site.mjs into docs/).

Four workers (A parser, B zones/storage, C content cards, D popup/options/clock/site) edit disjoint files in the same working tree at the same time.

- Edit only the files your brief lists. If you need a change elsewhere, say so in your report.
- No git commands that change state (no commit, add, stash, checkout, reset, restore).
- A previous attempt at this round failed midway. **Some of your files may already contain partial edits.** Run `git diff -- <your files>` first, read it, keep what is correct, and finish the rest. Do not revert other workers' files.
- `npx tsc --noEmit` errors in files you don't own may be other workers' in-progress edits: report them, don't fix them.
- No shortcuts: real fixes, no weakened or skipped tests. If a fix intentionally changes behaviour that an existing test asserts, update the assertion and explain it in your report.
- Every fix needs a test (unit; e2e where noted).

## Shared contract (already in src/types/index.ts, owned by the lead; do not change)

`ParsedTime.dateOrder` is `{ order, date: CalendarDate, alternate: { epochMs, order, date: CalendarDate } }`, where `CalendarDate = { y, mo (1-12), d }` holds the calendar fields as written in the source (wall clock of the source zone, never converted). `formatCalendarDate(date, order)` is exported from src/types and gives "4 Mar 2024" (dmy) or "Mar 4, 2024" (mdy).

Worker B adds to src/lib/storage.ts: `export function useWebStorageBackend(): void`, an explicit opt-in to localStorage for the website. Without the opt-in and without chrome.storage, storage never touches localStorage. The web backend fires onPreferencesChanged for cross-tab `storage` events.

ZonePicker Escape contract (B implements, C relies on it): the first Escape with a query or an open list clears/closes it and stops propagation. An Escape with nothing to clear or close is not stopped, so the containing card can close.

## Evidence

- Code review round 1: /tmp/tz-v2-review-r1/2026-11-01-100642-review.md (plus fp.mjs, corpus.mjs, diff.txt, perf2.mjs, demo-dm.mjs, e2e/probe.spec.ts)
- Blind QA round 1: /tmp/tz-v2-blind-r1/ (*.log, *.mjs, shots/, talend.json with 239 Talend examples)

## Report back

A concise list of fixes (file and function), tests added, assertions changed and why, anything left undone, and the final output lines of each verification command.
