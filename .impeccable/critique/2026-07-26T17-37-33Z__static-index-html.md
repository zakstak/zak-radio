---
target: Zak Radio
total_score: 28
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-07-26T17-37-33Z
slug: static-index-html
---

⚠️ DEGRADED: single-context (both isolated assessment workers were spawned, but
neither returned a usable structured handoff after bounded stops)

# Zak Radio — Impeccable Critique

## Design Health Score

| #         | Heuristic                       |     Score | Key Issue                                                                                                                                                                                       |
| --------- | ------------------------------- | --------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     |         3 | Loading, connection, ownership, queue, and toast states are explicit, but the live browser simultaneously exposed “Reconnecting” while route content and a live-audio owner remained available. |
| 2         | Match System / Real World       |         4 | “Radio,” “Library,” “Reader,” “Play next,” “Add to queue,” “Preview,” and “listen-only” describe the actual listening model plainly.                                                            |
| 3         | User Control and Freedom        |         3 | Return-live, cancel, navigation, preview isolation, and explicit queue actions are strong; station mutations lack a consistent visible undo path.                                               |
| 4         | Consistency and Standards       |         3 | One shell, one audio owner, Indigo state, and shared controls cohere, but Radio density and the editorial Library/Reader pages feel like different levels of refinement.                        |
| 5         | Error Prevention                |         3 | Permission checks and explicit Library actions prevent accidental playback/state mutation; disabled control fields still make listen-only capability boundaries visually laborious.             |
| 6         | Recognition Rather Than Recall  |         3 | Route labels, visible filters, owner bar, and station-target copy keep context present; the Library makes users scan past station construction to reach the archive.                            |
| 7         | Flexibility and Efficiency      |         2 | Search, filters, sort, grid/list, playback speed, and Space-to-play help, but there is no broader accelerator or exception-first path through the dense Radio controls.                         |
| 8         | Aesthetic and Minimalist Design |         2 | The authored dark listening-room world is strong, but repeated oversized heroes, section kickers, micro-labels, deep shadows, and always-visible control groups create avoidable noise.         |
| 9         | Error Recovery                  |         3 | Retry and warning states exist in source, and blocked autoplay has a join-live path; disconnected/partial subsystem recovery is not always explained locally.                                   |
| 10        | Help and Documentation          |         2 | Inline copy explains station ownership and Reader purpose, but the difference among shared control, private ownership, local preview, and Reader audio has no concise first-use explanation.    |
| **Total** |                                 | **28/40** | **Good foundation; hierarchy and state clarity need a focused pass.**                                                                                                                           |

## Design Specificity Verdict

**LLM assessment:** Zak Radio feels authored for this product. The shared
listening room, persistent audio owner, server-authoritative station, explicit
local preview, listen-only capability language, full-page Reader, real archive
artwork, Zakstak chrome, and Indigo signal cannot be transplanted unchanged into
a generic music player. The strongest product-specific design move is
behavioral: route changes do not erase who owns audio, and Library selection
does not steal communal playback.

The visual specificity is less complete. Library and Reader both use the
familiar “huge editorial headline, small uppercase kicker, bordered tool strip,
card grid” composition. The same sans face carries brand, evidence, controls,
and editorial display. Radio is dense and instrumental while Library and Reader
are spacious and campaign-like, so the product is coherent in behavior before it
is coherent in visual rhythm.

**Deterministic CLI scan:** One `broken-image` warning at `static/index.html:65`
for `<img id="cover" ... />` without a source. This is a false positive: the
current cover is assigned dynamically, and the same frame includes a deliberate
“No artwork” fallback.

**Browser detector:** Mutable injection succeeded in a fresh isolated browser at
390×844; the external detector loaded from `127.0.0.1:8400`, executed in-page,
and emitted 34 findings. The useful signals were 12 instances of 9–10px
functional text, two extreme-negative-tracking headlines, one tight-leading
case, one body paragraph only 14px from both viewport edges,
single/overused-font findings, and five repeated section-kicker findings. Six
wide-shadow findings and the clipped hidden Radio view are mostly
implementation/style cautions; the repeated-kicker count is inflated because all
three hidden route views share one DOM. The semantic green glow is acceptable
only when it represents connected/current state.

No user-visible `[Human]` overlay remains: the successful injection ran in a
headless assessment browser, which was closed after console capture.

## Overall Impression

Zak Radio already behaves like one continuous listening room rather than three
disconnected tools. Its biggest opportunity is to make the visual hierarchy as
disciplined as the playback model: browsing should lead in Library, reading
should lead in Reader, and capability/ownership should be immediately legible
without presenting every possible control at equal weight.

## What’s Working

1. **Playback truth is unusually well designed.** The persistent owner bar,
   “Return live,” route-aware audio ownership, and explicit local-preview
   boundary keep users from accidentally replacing communal playback.
2. **Library actions respect intent.** `Play next`, `Add to queue`, and
   `Preview` separate programming from private audition instead of treating card
   selection as implicit play.
3. **Reader is genuinely first-class.** It has its own route, search, filters,
   saved position, source link, narration controls, and full-page reading
   surface while still participating in the shared shell.

## Cognitive Load

Assessment: **high at the densest decision points — 4 of 8 checklist failures.**

- Fail — **Single focus:** Library opens with an archive hero, then immediately
  prioritizes saved-station creation before search and tracks.
- Fail — **Chunking:** Radio exposes seven transport controls, five track
  actions, station selection, programming, and queue in one continuous control
  field.
- Pass — **Grouping:** transport, track actions, station, queue, archive tools,
  and Reader controls have clear spatial groups.
- Pass — **Visual hierarchy:** current track artwork/title and route heroes
  establish strong entry points.
- Fail — **One thing at a time:** Library asks users to understand station
  construction and archive browsing together.
- Fail — **Minimal choices:** the Radio transport has seven visible controls;
  Library sort exposes five options; the overall Radio decision field exceeds
  four actions.
- Pass — **Working memory:** route labels, station-target copy, and the
  persistent owner bar keep playback context visible across routes.
- Pass — **Progressive disclosure:** details dialogs, local preview dock, and
  Reader item opening reveal depth deliberately, though Radio programming could
  go further.

## Emotional Journey

Radio opens with an effective emotional peak: real artwork, current track
identity, live state, and synchronized lyrics make the archive feel inhabited.
Library then promises discovery but drops into station administration before
delivering tracks, creating an avoidable valley. Reader recovers with confident,
spacious copy and a preserved source card. On mobile, the fixed audio-owner bar
is reassuring but physically obscures a large portion of the current Reader
card, so continuity becomes obstruction. The best ending state is “Return live”;
it gives every side journey a clear way home.

## Priority Issues

### [P1] Library makes station administration outrank archive discovery

**Why it matters:** “Find your next favorite” sets a browsing goal, but “Your
stations,” two station-creation actions, an empty-state message, search, sort,
view mode, and filters all precede the track grid. On mobile, users travel
through several screens of setup before the promised archive.

**Fix:** Put search, result count, filters, and tracks directly after the hero.
Move saved-station management below results or into a clearly labeled secondary
panel. Keep `Play next`, `Add to queue`, and `Preview` explicit on selection.

**Suggested command:** `$impeccable layout`

### [P1] Listen-only capability is explained in copy but not simplified in the control grammar

**Why it matters:** A listener can still encounter a large Radio control surface
dominated by disabled transport, station programming, and queue controls. The
difference between “can hear,” “can join locally,” and “can control the station”
takes too much scanning, even though the permission model is correct.

**Fix:** Preserve every control, but make capability the first organizing rule.
In listen-only mode, foreground `Join live`, current track, lyrics, reactions,
and download; visually subordinate owner-only transport/programming behind an
explicit “Owner controls this station” boundary. In owner/shared modes, reveal
the full control bench with the current capability stated beside it.

**Suggested command:** `$impeccable clarify`

### [P2] The persistent audio-owner bar obstructs mobile content

**Why it matters:** At 390×844 the bar occupied roughly 118px at the bottom and
overlaid the Reader card while presenting `Join live` and `Open Radio`.
Persistence is correct; occlusion is not.

**Fix:** Reserve the bar’s actual measured height in every active route,
collapse it to a single-line mini-player on narrow screens, and keep both
ownership label and return/open action reachable in 44px targets.

**Suggested command:** `$impeccable adapt`

### [P2] Editorial typography relies on micro-labels and aggressive tracking

**Why it matters:** The browser detector found twelve functional labels at
9–10px, tight leading, and `-0.07em` display tracking that visually collapsed
“Stories deserve / the whole page” and “Find your / next favorite.” These
choices weaken legibility and make the editorial routes feel templated rather
than crafted.

**Fix:** Set a 12px floor for consequential functional labels, loosen display
tracking and line height at mobile widths, introduce the existing editorial type
token for route heroes or another product-specific contrast, and reserve
uppercase kickers for the few places where they add orientation.

**Suggested command:** `$impeccable typeset`

### [P2] Partial connectivity is not locally explained

**Why it matters:** The live assessment exposed route content and a persistent
live-station owner while the shell reported `Reconnecting`; Library also
remained in a loading state in one fresh session. Users need to know whether
music, station control, archive data, or Reader data is unavailable.

**Fix:** Split status by consequence: “Station updates reconnecting,” “Archive
unavailable,” and “Reader available” rather than one global connection label.
Preserve cached/current content and place retry beside the affected subsystem.

**Suggested command:** `$impeccable harden`

## Persona Red Flags

**Alex — Power user/operator:** Alex can search, sort, change view, manage
stations, and use Space for live playback. The friction is scan cost: station
administration blocks the archive, and seven transport controls plus
programming/queue have no compact expert hierarchy.

**Jordan — first-time invited listener:** Jordan understands “listen-only,” but
the disabled owner control bench still looks like a broken player. The
distinction among joining live audio, controlling a station, previewing
privately, and opening Reader needs one concise capability explanation at the
point of use.

**Casey — distracted mobile listener:** Casey gets 44px navigation and controls,
no horizontal overflow at 390px, and persistent audio context. The owner bar
covers Reader content, route heroes consume substantial vertical space, and the
archive is delayed by station management.

## Minor Observations

- `static/index.html:65` is not actually a broken image; suppress or ignore that
  detector rule for this target.
- Repeated uppercase section kickers create sameness across otherwise distinct
  routes.
- The six large-shadow warnings mainly belong to docks/dialogs, but reducing
  blur would better match the crisp Signal Stack.
- The single-font browser finding is directionally useful: the visual system
  defines editorial and evidence roles, but the visible production page reads
  almost entirely as one sans voice.
- The mobile Reader card exposes a long raw source URL; treat it as supporting
  metadata, not a primary line.

## Questions to Consider

1. Which should lead the next pass: **Library discovery hierarchy**,
   **listen-only capability clarity**, or **mobile owner-bar behavior**?
2. Should the route tone remain **one restrained sans system**, become **more
   editorial in Library/Reader**, or use **artwork as the main expressive
   contrast**?
3. Should the follow-up cover **the two P1 issues only**, **all five issues**,
   or **mobile plus accessibility first**?
