# Vessel native playback

Zak Radio shares one HTML media element across Radio, Library and Reader. When
the page runs inside Vessel (the Android WebView host), `static/platform.js`
reports playback to the host over `window.ZakstakNativeBridge` so Vessel can
hold a media foreground service, MediaSession notification and partial wake lock
while the phone is locked. Chromium keeps HTML-media audio focus. Browsers
without the bridge keep the plain MediaSession path.

## Messages

All messages are JSON with `schema: "zakstak.native.v1"`.

| Direction   | `type`          | Fields                                         | Meaning                                                                              |
| ----------- | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| page → host | `hello`         | `product`                                      | Sent once at load to request capabilities.                                           |
| host → page | `capabilities`  | `mediaBuffering`, `foregroundMediaPreparation` | Optional features this host supports.                                                |
| page → host | `media`         | `state`, `title`, `subtitle`                   | `playing`, `buffering`, `paused` or `none`. Deduplicated.                            |
| page → host | `media.prepare` | `requestId`, `title`, `subtitle`               | Ask the host to start foreground protection before audio starts.                     |
| host → page | `media.ready`   | `requestId`, `ready`                           | Preparation result. The page waits at most 5.5 seconds, then treats it as not ready. |

Native transport controls arrive as a `zakstak-native-media-command` window
event with `detail.command` set to `play`, `pause` or `stop`.

Older hosts don't advertise the optional features. Then the page skips
`media.prepare` and reports `buffering` as `paused`. If Play comes before the
`capabilities` reply, the page waits up to one second for it, once per page
load.

## Playback rules

- **Buffering is active.** Radio reports `playing` only after the element's
  `playing` event. Track ends, source swaps and `waiting` report `buffering`, so
  a locked phone keeps foreground protection between tracks.
- **Prepare before play.** Before starting a paused element, `ZakAudio.play()`
  waits for `media.ready`. It checks again that the play is still wanted when
  the reply arrives. A rejected or timed-out preparation leaves Radio paused.
- **Explicit Pause wins.** `ZakAudio.pause()` cancels an in-flight play. It also
  cancels a start that Reader deferred until the next segment's metadata loads.
- **Interruptions stick.** A pause the app didn't request, such as an
  audio-focus loss, suspends Radio, and station updates don't resume it. If
  Chromium resumes the element itself when a transient focus loss ends, Radio
  follows the station again.
- **Stop is silent.** Native Stop clears whichever owner holds the element.
  Reader saves its position first. Later station updates don't reclaim the
  element for Radio until the listener presses Play, in the page or through the
  native controls.
- **Errors aren't playing.** A media error can stop audio without a pause event,
  so the page reports it as `paused`, or as `buffering` while Radio recovers.

Vessel bounds continuous buffering on its side. This bridge does not replace the
HTML player with a native player, and it doesn't keep playback alive if the
WebView process dies.

## Tests

`tests/native-playback.spec.mjs` drives a fake bridge against a second browser
fixture whose station alternates two tracks, so every boundary changes the media
source. Locked-phone behavior still needs a device check with the matching
Vessel release.
