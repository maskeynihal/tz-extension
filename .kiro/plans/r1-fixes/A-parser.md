# Worker A: parser fixes

Read common.md first.

Files you own: src/lib/builtin-formats.ts, src/lib/time-tokens.ts, src/lib/parse.ts, src/lib/custom-formats.ts (only if needed), new tests/parser-fixes.test.ts. You may adjust assertions in tests/locale-formats.test.ts, tests/parse.test.ts, tests/formats.test.ts when a fix intentionally changes behaviour.

Do not run npm run build*, e2e or playwright.

Verify:
- `npx vitest run tests/parser-fixes.test.ts tests/locale-formats.test.ts tests/parse.test.ts tests/formats.test.ts tests/format-registry.test.ts tests/epoch.test.ts`
- `npx tsc --noEmit`
- `npx eslint src/lib tests/parser-fixes.test.ts --max-warnings=0`

## Fixes

0. Populate `dateOrder.date` and `dateOrder.alternate.date` wherever `dateOrder` is produced (numericMatcher and any other producer). Test: "03/04/2024 22:00 PDT" read dmy gives date {2024,4,3} and alternate {2024,3,4}, whatever the zone.
1. ISO ordinal false positives (`RE_ORDINAL`): "PR 2024-123", "ID 2024-001", "ticket 2019-120", "Invoice 2024-001 due 10:00", "Meeting 10:00, ref 2024-120", "#2024-123" must not read as ordinal dates. Refuse a match preceded on the same line (allowing whitespace, ':', '#', 'No.') by an id word (case-insensitive: PR, ID, ticket, invoice, inv, ref, order, issue, bug, case, req, no, number, SKU, build, job, run, release) or by '#'. In `specificity`, rank a date-only ordinal below a time-of-day, so a surviving ordinal never leads over a time. Genuine ordinals ("1999-081", "2024-123T10:00Z") and all Talend examples still parse.
2. Compact and ISO-week ids: "Order #20240115", "SKU 2024W012", "model 2020W10", "part 2024W01" must not convert. Reject compact/week matches preceded by '#' or id words (order, SKU, id, model, part, item, ref, no, build, lot, serial, product). For the week form without a hyphen, require the hyphenated `-W` form or an attached weekday digit outside an id context. Talend coverage must stay 239/239 (see /tmp/tz-v2-blind-r1/talend.json and talend.mjs).
3. `numericDate`: "10.30.15" must not become 30 Oct 2015. Refuse two-digit-year dot triples whose parts form a valid H.MM.SS (H 0-23, MM/SS 0-59) unless a time follows. "01-23-45", "ext 01-23-45" and "lot 11-12-13" must not become dates: refuse dash triples of three two-digit parts unless a time follows. "22.03.99 10:00", "03-22-99 10:00 PM" and the Talend dash/dot examples keep working.
4. Japanese era years: "平成11年3月22日", "令和6年1月2日", "昭和64年1月7日" must not read as 2011/2006/2064. Preferred: convert era years (令和 1 = 2019, 平成 1 = 1989, 昭和 1 = 1926, 大正 1 = 1912, 明治 1 = 1868; 元年 = year 1). Acceptable: a negative lookbehind for the era names in RE_CJK.
5. "Mar 3 Mar 2024": the leading "Mar" is consumed as Spanish weekday "martes". A weekday prefix that is also a month abbreviation must not be taken as a weekday when a day number and month follow. "Mar 3, 2024" still reads as 3 March.
6. Unicode minus U+2212: offsets like "UTC−05:00", "GMT−5", "10:00 −0500", "2024-03-04T10:00:00−05:00" parse exactly like the ASCII versions everywhere offsets are read (zone regexes, `resolveZoneToken`, `badOffset`, ISO). matchedText stays the original substring. "10:00–11:00" stays a range: accept U+2212 as a sign anywhere, en dash only directly after GMT/UTC.
7. Performance: new regexes stay under 50 ms on 20k-character hostile input (follow the existing timing tests).
