# Round-2 fixes: common rules for every worker

Repo: /Users/leapfrog/Projects/maskeynihal/tz-extension (MV3 extension "TZ Converter", Chrome + Firefox, TypeScript strict, React 18, vitest, Playwright; website in site/ built by scripts/build-site.mjs into docs/). Round 1 is committed (b677cfc). The tree was clean except for the lead's new files listed below.

Four workers (A parser, B zones, C content cards, D popup/options/clock/site) edit disjoint files in the same working tree at the same time.

- Edit only the files your brief lists. If you need a change elsewhere, say so in your report.
- No git commands that change state (no commit, add, stash, checkout, reset, restore).
- `npx tsc --noEmit` errors in files you don't own may be other workers' in-progress edits: report them, don't fix them.
- No shortcuts: real fixes, no weakened or skipped tests. If a fix intentionally changes behaviour an existing test asserts, update the assertion and explain it in your report.
- Every fix needs a test (unit; e2e where noted).

## Evidence

- Code review round 2: /tmp/tz-v2-review-r2/2026-11-01-115531-review.md (plus diff.txt, corpus.mjs, probe.log, sync-sim.mjs, search.log)
- Blind QA round 2: /tmp/tz-v2-blind-r2/REPORT.md (plus *.log, shots/)

## Shared contracts (already written by the lead)

1. **DST-aware wall clock.** `src/lib/wallclock.ts` (lead; tested in tests/wallclock.test.ts; do not change without telling the lead):
   - `wallFieldsToInstant(fields: {y, mo, d, h, mi, s}, tz: string): { epochMs, wallClock?: 'gap' | 'ambiguous' } | null`
   - `parseWallIso(iso: 'YYYY-MM-DDTHH:mm[:ss]'): WallFields | null`
   - Gap times (spring forward) are read with the offset from before the jump (02:30 becomes 03:30). Ambiguous times (fall back) take the earlier instant. This matches java.time and Temporal's "compatible".
   - `tz` is an IANA name or an offset string like "+05:45" or "UTC".
2. `ParsedTime.wallClock?: 'gap' | 'ambiguous'` (src/types/index.ts, lead). The parser sets it; the card and the website show a short note when it's set.
3. Worker B adds to src/lib/tz.ts: `wallClockToInstant(isoLocal: string, zone: string): WallInstant | null`, a thin wrapper over the helper that accepts any zone id (IANA, `UTC+05:45`, `abbr:*`). `wallClockToEpochMs` keeps its signature but becomes DST-correct through it. Worker D uses `wallClockToInstant` in the popup.
4. Displayed offsets use the ASCII hyphen-minus "-" everywhere (zone labels like "UTC-08:00", card rows, popup, clock), so copied text pastes cleanly into any tool. The parser and search accept U+2212 as input; only display changes. Worker B owns the label and offset formatting in tz.ts. Others just stop hard-coding "−" in display code.

## Report back

A concise list of fixes (file and function), tests added, assertions changed and why, anything left undone, and the final output lines of each verification command.
