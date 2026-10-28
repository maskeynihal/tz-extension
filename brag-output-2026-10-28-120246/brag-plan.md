# Brag Plan: TZ Converter — Timezone Tools

## What is this app?
A Manifest V3 browser extension (Chrome + Firefox) that converts timezones three ways: select any time on a page to convert it in place, a full date+zone converter in the popup, and an epoch (Unix timestamp) converter.

## The angle
"Stop doing timezone math in your head." The hero trick: highlight a Unix epoch like `1700000000` buried in a deploy log and a clean card instantly tells you what it is in your zones — then pin it to the page to compare several. Grounded, useful, a little flex on how smooth it is.

## Hook (first 2-3 seconds)
A raw epoch number on a dull page — `1700000000` — gets selected, and an amber highlight + a crisp conversion card snaps in beside it. The "wait, it just knows?" moment.

## Key moments (the middle)
- The select-to-convert card appears on a selected timestamp, showing UTC / New York / London / Kathmandu with the LOCAL tag underlined.
- A second epoch gets selected and **pinned** — now two cards sit on the page side by side for comparison.
- The popup converter: pick a time, hit the Local chip, read it across zones instantly.

## Outro / punchline
Logo + "Three ways to never miss a meeting again." Then a quick install line: *Chrome Web Store · Firefox Add-ons · or load unpacked.*

## User flow worth showing
entry → key action → result:
1. Select an epoch timestamp on any page.
2. The conversion card appears (UTC + target zones, dates, offsets).
3. Pin it; select+pin a second value; compare in place.
(Secondary flow: open the popup → Converter tab → Local chip → zones update.)

## Tone
- Preset: polished
- Creative direction: quiet, premium developer-tool product film — confident, not loud.
- Interpretation: fewer scenes, longer holds, clean slides. Let each conversion land. No chaos; the smoothness IS the pitch.

## Format: landscape — 1920x1080
## Duration: 20s target

## Visual identity (from the project)
- Background: #ffffff (light) / #121318 (dark) — use the dark surface for a premium dev feel
- Accent: #1313ba (indigo — used sparingly, for LOCAL tag / active state)
- Text: #16181d heading / #24262e body (neutral slate) ; muted #898c96
- Surfaces: raised #f7f8fa / sunken #f1f2f5 ; borders #e6e7ec
- Highlight marker: amber rgba(250,204,21,0.85)
- Display + body font: Inter
- Strongest visual element: the conversion card — neutral, bordered, flat, with the amber selection highlight on the matched token and the blue LOCAL tag.

## Share copy (draft)
Built a timezone extension that converts any time you select — epoch, ISO, or "Wednesday, October 28, 2026, 04:24 UTC" — right on the page. Pin cards to compare. Chrome + Firefox. 🕑

## Audio direction
- Role: warm, restrained bed — confident product film, not hype.
- Music: bundled upbeat/polished track at low volume; soft fade-out under the logo.
- Music treatment: start ~0s low, hold steady, gentle fade in the last 1.5s.
- Music cue guidance: to be detected at composition time; target a soft cue on the first card snap (~2.5s) and the pin moment (~9s).
- Audio-reactive treatment: subtle — a faint presence on the card snap only; no waveform bars.
- SFX posture: sparse, motion-matched — a soft tick when the card snaps in, a gentle click on the pin, a light key-ish tick on the highlight. Professional restraint.
- Audio-coupled moments: card snap on selection, pin click, Local-chip toggle, count of two pinned cards.
- Restraint rule: audio must never get busy or cartoonish; one accent per real motion, nothing more.

## Storyboard

### Scene 1 — The hook: a number that converts itself — 4s
Dark page with a line "deploy finished · 1700000000". Cursor selects the epoch; an amber highlight lands on it; a conversion card snaps in beside showing UTC 2023-11-14 Tue 10:13:20 PM +00:00 and three more zones, LOCAL underlined on Kathmandu.
Sequential/interaction: yes — cursor selects the token, highlight then card snap.
Audio intent: a single satisfying "it just knows" tick on the card snap.
Audio-coupled idea: soft tick on card snap; faint key tick as highlight paints.
Music: warm low bed begins.
Transition mood: clean → Scene 2

### Scene 2 — Pin & compare — 5s
A second value is selected lower on the page and pinned; now TWO cards sit on the page. Camera eases to show both, offsets aligned, dates visible. Text overlay: "Pin times. Compare in place."
Sequential/interaction: yes — select second value, click pin, second card settles beside the first.
Audio intent: gentle click on pin; quiet confidence.
Audio-coupled idea: pin click; subtle settle.
Music: steady bed.
Transition mood: soft slide → Scene 3

### Scene 3 — The full converter — 4s
The popup (dark, Inter, neutral) Converter tab: a datetime, source zone, and the blue "Local" chip gets pressed → result cards update across UTC / New York / London / Kathmandu with big tabular times.
Sequential/interaction: yes — Local chip press, result times tick/update.
Audio intent: one soft toggle tick on the chip.
Audio-coupled idea: chip toggle tick; count-up feel on the times.
Music: steady bed.
Transition mood: clean wipe → Scene 4

### Scene 4 — Formats flex — 3s
Three format chips reveal one by one over the card: `1700000000` · `2024-07-01T14:30Z` · `Wednesday, October 28, 2026, 04:24 UTC` — "It reads all of them."
Sequential/interaction: yes — three format lines appear one by one, held together at the end.
Audio intent: a light tick per reveal, then settle.
Audio-coupled idea: beat-spaced reveals, hold full set ~0.9s.
Music: small lift.
Transition mood: soft → Scene 5

### Scene 5 — Logo + install — 4s
Clean end card: "TZ Converter — Timezone Tools" wordmark, tagline "Three ways to never miss a meeting again." Small line below: "Chrome · Firefox · load unpacked". Music fades.
Sequential/interaction: none.
Audio intent: soft resolve; bed fades to silence.
Audio-coupled idea: none.
Music: gentle fade-out.
Transition mood: soft fade → end

**Music mood for this video:** polished / warm upbeat, restrained.
**Audio summary:** A quiet warm bed under smooth motion, one soft accent per real action (card snap, pin click, chip toggle, format reveals), fading out under a clean end card.
