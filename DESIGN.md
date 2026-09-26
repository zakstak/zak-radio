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
Keep controls labeled, touch targets at least 44px, status changes announced to
screen readers, and permissions understandable without color alone.
Do not replace cover art with decorative interface chrome or hide working
playback, queue, station, reaction, download, Library, or Reader behavior for
visual simplicity.

Use the shared tokens referenced by [styles.tailwind.css](static/styles.tailwind.css)
as the palette and typography source; rebuild `static/styles.css` after edits.
