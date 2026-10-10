# Vessel native playback

Zak Radio shares one HTML media element across Radio, Library and Reader. The
native bridge reports Radio playing only after the element's playing event,
retains buffering intent through source changes, and waits for a negotiated
foreground media preparation acknowledgement before starting audio. Vessel owns
the native MediaSession, notification, foreground service and partial wake lock;
Chromium owns HTML-media audio focus. Older hosts receive supported states and
browsers keep their existing path.

Explicit Pause invalidates a pending play operation, including Reader's
same-source seek-to-end. Preparation invalidates native metadata deduplication,
so an identical paused state still acknowledges a native Pause after buffering.
Stop clears local radio intent and ownership; station/SSE refresh cannot restart
it. Failed preparation remains paused. Native buffering is bounded independently
of web timers. This does not replace the HTML player with Media3 or promise
survival after process death.

Validation uses eight bridge/browser regressions, the existing frontend suite,
and Vessel's debug-only exact-origin fixture on isolated Android VMs. VM
controls are real MediaSession transport controls and tests leave the display
off through multiple real MP3 source changes. Phone acceptance remains an
operator test.
