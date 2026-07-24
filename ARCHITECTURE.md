# Architecture

Zak Radio is organized around one executable and explicit internal package
boundaries:

```text
cmd/zak-radio/          executable entrypoint
internal/application/   product orchestration, HTTP routes, domain services,
                        persistence, retained-volume validation, and tests
internal/catalog/       catalog and track domain models
internal/config/        environment and listener configuration
internal/events/        revision-aware in-process event broadcasting
internal/httpguard/     request trust, rate, stream, and JSON admission
internal/lifecycle/     retained-volume lifecycle locking
internal/reader/        Reader public domain models
internal/station/       station commands, snapshots, and retained state models
static/                 browser shell and feature modules
scripts/                operator, packaging, recovery, and validation tools
```

The command package contains no product behavior. It starts
`internal/application`, which composes the smaller boundary packages.
Application code may depend on those packages; they must not import the
application package.

The browser loads `platform.js` before feature code. That module owns shared
storage and HTTP behavior. `app.js` owns the persistent shell and shared radio,
while `library.js` and `reader.js` own their respective views.

The retained-volume layout is product-owned and provider-neutral:

```text
music-library/
reader-library/
station.sqlite3
curated-tracks.json
```

Packaging copies `cmd/`, `internal/`, `static/`, and the vendored Go module
tree into an immutable build context. `PACKAGE.SHA256SUMS` and `RELEASE` bind
that exact source state.
