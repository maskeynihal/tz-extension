# Worker A (round 2): parser

Read common.md first.

Files you own: src/lib/builtin-formats.ts, src/lib/time-tokens.ts, src/lib/parse.ts, src/lib/custom-formats.ts, src/lib/epoch.ts (only if needed), tests/parser-fixes.test.ts, tests/locale-formats.test.ts, tests/parse.test.ts, tests/formats.test.ts, and a new tests/parser-r2.test.ts. Do not run builds or playwright.

Verify:
- `npx vitest run tests/parser-r2.test.ts tests/parser-fixes.test.ts tests/locale-formats.test.ts tests/parse.test.ts tests/formats.test.ts tests/format-registry.test.ts tests/epoch.test.ts tests/wallclock.test.ts`
- `npx tsc --noEmit`
- `npx eslint src/lib tests --max-warnings=0`
- Talend coverage 239/239 in both mdy and dmy (your earlier equivalent script was /tmp/tz-a-talend-unit.ts; copy it into /tmp if needed).
- Rerun the reviewer's corpus diff (/tmp/tz-v2-review-r2/corpus.mjs, diff.txt) and confirm no lost reading versus the base branch other than intended refusals.

## Fixes

1. **Major regression (review #1).** The round-1 guard in `numericDate` refuses real two-digit-year dates: "12.03.24", "5.11.24", "23.12.25", "01.02.25", "15.08.47", "Stand: 12.03.24", "22-03-24", "05-06-24", "24-03-22", "31-12-25", "12-31-25" no longer convert. Keep the round-1 refusals ("10.30.15", "01-23-45", "ext 01-23-45", "lot 11-12-13") by narrower rules:
   - Dots: dotted numeric dates are day-first in every locale that uses them. Refuse a two-digit-year dot triple only when the middle part can't be a month (B > 12, like 10.30.15).
   - Dashes: refuse "01-23-45" by plausibility. With no time attached, a two-digit year that expands to more than about 10 years after the current year (the `nowMs` the parser already gets, else Date.now()) is not a date. Also refuse after code words via the existing `CODE_ID_BEFORE` ("ext", "lot", "SKU"…).
   - "lot 11-12-13" is refused by the code word.
   - Add 20xx rows to the tests ("12.03.24", "22-03-24", "31-12-25" in both orders where relevant, and the review's whole list).
2. **DST.** In `buildParsed` (time-tokens.ts), resolve IANA-zone and assumed-zone wall clocks with `wallFieldsToInstant` from src/lib/wallclock.ts instead of `fromZonedTime`, and set `ParsedTime.wallClock` when it reports 'gap' or 'ambiguous'. The same applies to any other place the parser turns wall fields into an instant (custom formats, `dateOnlyAt`…). Tests:
   - "2024-03-10 02:30 ET" gives 07:30Z with wallClock 'gap'.
   - "2024-03-31T01:30[Europe/London]" gives 01:30Z, 'gap'.
   - "2024-11-03 01:30 ET" gives 05:30Z, 'ambiguous'.
   - "2024-10-27T01:30[Europe/London]" gives 00:30Z, 'ambiguous'.
   - Fixed-offset tokens (EDT, +05:45) are never flagged.
3. **Years.** `0000-01-01` displays nonsense. Refuse years below 1000 for written/numeric/ISO dates (a three-digit or zero year is never a timestamp on a web page). Epoch inputs keep their own bounds. Test.
4. **Bracketed or bare IANA zone after a space.** "2024-03-10 02:30 [America/New_York]" and "2024-03-10 02:30 America/New_York" should use that zone (matchedText includes it). Only real IANA names (validate with `resolveZone`) and only directly after the time (one space). Keep "…T02:30[America/New_York]" working. Also cover "10:00 Europe/Paris" for time-only. Test negatives: "10:00 Foo/Bar" stays home zone, and its matchedText is "10:00".
5. **False positives** (QA #6):
   - "John 3:16", "Luke 2:1-20", "Psalm 23:4": a book-chapter:verse pattern (capitalised word directly before, single-digit or two-digit hour with no am/pm, no seconds, no zone) is not a time. Keep "Meeting 3:16 PM", "at 3:16", "3:16 UTC". Use judgement: rather than a Bible-book list, refuse `H:MM` with no am/pm, seconds or zone when preceded by a capitalised word that isn't a known time-context word (at, by, from, until, till, before, after, around, starts, ends, due, meeting, call, opens, closes, weekday names, month names, today, tomorrow, tonight…). If that's too broad on the corpus, use a short list of scripture books plus "verse/chapter" instead. Measure on the corpus and choose. Report what you chose and why.
   - "1:30 odds", "odds of 1:30": a ratio context ("odds", "ratio", "scale", "aspect", "split", "mix", "x:y") after or before → not a time.
   - "Lap 1:23.456", "split 0:59.87": `m:ss.fff` with fractional seconds after lap/split/time/PB/race words, or any `M:SS.fff` without an hour part, is a duration, not a time of day.
   - "99.22.3%": a dotted triple directly followed by '%' or preceded/followed by a digit-dot is not a date.
   - "2024-03-22-001": an ISO date directly followed by "-digits" (no T/space/time) is an id, not a date.
6. **Short dotted dates (QA #8).** "3.4.24" is refused (version-like); keep refusing it date-only, but accept it when a time follows ("3.4.24 10:00"), with the day/month picker. Test both.
7. **24:00 and leap seconds (QA #9).**
   - "2024-01-01 24:00" and "2024-01-01T24:00:00Z" mean 2024-01-02 00:00 (ISO 8601). Accept 24:00[:00] only with minutes and seconds zero.
   - "23:59:60Z" / "2016-12-31T23:59:60Z": JS has no leap seconds. Read as 23:59:59.999 of that day (so the date stays right). Test. A bare "24:00" with no date: today's end, i.e. tomorrow 00:00.
