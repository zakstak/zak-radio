# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Zak Radio serves a private operator who programs the shared station, invited
listeners who join the communal broadcast, owners of temporary private stations,
and readers who move between music, lyrics, library browsing, and source
readings. A listener may be allowed to hear a station without being allowed to
control it.

## Product Purpose

Zak Radio is an interactive listening, library, reader, and station-management
application for an original personal archive. It keeps shared playback
server-authoritative while letting the browser join audio, browse without
stealing the live station, create capability-controlled private stations, and
move between music and source reading in one continuous product.

## Positioning

Zak Radio is a listening room, not a collection of disconnected media tools. The
shared station has one authoritative state across listeners and windows; Library
previews remain local; Reader keeps its own bounded audio ownership and saved
position without becoming a second radio controller.

## Operating Context

- The primary routes are Radio, Library, and Reader inside one persistent web
  application.
- Radio exposes live station state, artwork, transport, reactions, download,
  synchronized lyrics or transcript, queue, and station programming.
- Library supports search, filtering, sorting, details, local preview, and
  explicit add-to-station workflows.
- Reader supports a source library, text and audio reading, progress, filtering,
  and handoff with the shared audio owner.
- Public station changes synchronize through the server and SSE across multiple
  windows.
- Temporary stations are owner-capability controlled and shared links are
  listen-only.

## Capabilities and Constraints

- Production sources are `static/index.html`, `static/styles.tailwind.css`,
  `static/app.js`, `static/library.js`, `static/reader.js`, and
  `static/platform.js`.
- `static/styles.css` is generated and served; change the Tailwind source and
  rebuild it with `npm run build:css`.
- Playback, repeat, seek, station programming, and station revision remain
  server-authoritative. Browser behavior must not create a second source of
  truth.
- Private and shared station permissions, owner-token handling, listen-only
  links, expiry, and multi-window synchronization must be preserved.
- Library audio preview must not mutate the shared station.
- Radio, Library, Reader, playback, queue, reactions, downloads, lyrics, station
  controls, dialogs, and responsive behavior must not be hidden merely to
  simplify layout.
- Real cover art is product content, not decorative interface chrome.

## Brand Commitments

- Product name: Zak Radio.
- Organization: Zakstak.
- Zak Radio must be recognizable as part of the Zakstak product family while
  remaining the expressive, artwork-led listening product.
- The user has made the Indigo recognition accent binding for this product.
  Green remains semantic-only for confirmed connected, healthy, or current
  state.

## Evidence on Hand

- `README.md` records local operation, routes, data boundaries, and packaging.
- `DESIGN.md` records the current Radio product direction.
- `static/index.html` and the route scripts contain the production workflows.
- `tests/frontend.spec.mjs` exercises browser behavior and responsive
  regressions.
- Go tests under `internal/application` exercise the server-authoritative
  station, permissions, SSE, and safety contracts.
- Real archive metadata, artwork, lyrics, and reader materials are available to
  the running product. No customer, licensing, benchmark, or market claim has
  been supplied and future UI work must not fabricate one.

## Product Principles

1. One shared station state, many synchronized listeners.
2. Browsing and private preview never steal the communal broadcast.
3. Capability boundaries are visible and enforced, not merely styled.
4. The current track and source material remain the emotional center.
5. Radio, Library, and Reader form one product without becoming one layout.

## Accessibility & Inclusion

Preserve keyboard operation, visible focus, reduced motion, screen-reader status
announcements, labeled icon controls, and 44px touch targets. Every route and
working control must remain available without document-level horizontal overflow
at 320px. Loading, empty, blocked-autoplay, listen-only, disconnected, failed,
and unavailable states must remain understandable without color alone.
