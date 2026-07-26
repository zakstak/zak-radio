---
name: Zak Radio
description: A continuous Zakstak listening room.
colors:
  ink: "#080A0C"
  panel: "#12161A"
  raised: "#181D22"
  line: "#30363D"
  frost: "#D8D4E2"
  muted: "#A49FB0"
  signal: "#8983E8"
  signal-readable: "#D7D3FF"
  success: "#85C9A0"
  warning: "#E7B66A"
  danger: "#E98585"
typography:
  body: "Noto Sans, Helvetica Neue, Arial, sans-serif"
  evidence: "JetBrains Mono, SFMono-Regular, Consolas, monospace"
rounded:
  control: "2px"
  compact: "10px"
  surface: "12px"
---

# Zak Radio interface

Zak Radio inherits Zakstak’s Signal Stack and uses Indigo for identity,
selection, focus, playback flow, and the relationship between the current track
and its lyrics. Cover art provides atmosphere; the shell remains neutral. Green,
amber, and red are reserved for real connection and error state.

Radio, Library, and Reader share one application shell and one audio element.
Live radio is server-authoritative. Library preview stays local and must never
mutate station playback. Queue and saved-station mutations remain explicit and
station-scoped. Reader remains a first-class route without becoming a competing
player.

Preserve keyboard operation, visible focus, reduced motion, truthful loading and
empty states, synchronized-lyric uncertainty labels, and layouts down to 320px.
Do not replace cover art with decorative interface chrome or hide working
playback, queue, station, reaction, download, Library, or Reader behavior for
visual simplicity.
