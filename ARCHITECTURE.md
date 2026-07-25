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

The release may also carry an immutable timed-lyrics directory. Its sidecars are
audio-digest-bound, schema-validated during startup, and digest-verified again
when served. `subjects.json` in the same directory can replace only weak
imported display titles. Neither artifact modifies the recovered archive or the
retained database.

The retained-volume contract is product-owned and provider-neutral. The current
Kiln volume uses this archive directory:

```text
suno-organized-2026-06-27/
reader-library/
station.sqlite3
curated-tracks.json
```

Local or newly imported volumes may name the archive `music-library/`; the
service always receives its exact location through `ZAK_RADIO_ARCHIVE`.

Kiln packaging compiles the Go server before publication, compresses the
executable to satisfy Kiln's per-file upload limit, then generates a small
offline build context containing that executable archive, runtime browser
assets, the optional timed-lyrics bundle, and a `FROM scratch` Dockerfile. Go
dependencies and application source are not copied into the Kiln context.

Kiln runs the image under rootless Podman. The process uses namespace UID 0 so
the retained bind mount maps to Kiln's unprivileged host account, and startup
fails unless `/proc/self/uid_map` proves that container root maps to a non-root
host UID.
