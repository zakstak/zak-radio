# Zak Radio

Zak Radio is a Go service for shared radio, saved and temporary stations, a
searchable music library, and Reader audio. Radio, Library, and Reader share one
browser shell and audio element.

The Go backend, SQLite schema, browser assets, and retained data-volume contract
in this repository are the product source of truth. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the code layout.

## Run locally

Install Go 1.27.3+ and Node 24+. Build the browser assets:

```bash
npm ci
npm run build:css
```

Run the service against a separate development data root:

```bash
export ZAK_RADIO_METADATA_ROOT=/path/to/zak-radio-data
export ZAK_RADIO_ARCHIVE="$ZAK_RADIO_METADATA_ROOT/music-library"
export ZAK_RADIO_DB="$ZAK_RADIO_METADATA_ROOT/station.sqlite3"
export ZAK_RADIO_READER_LIBRARY="$ZAK_RADIO_METADATA_ROOT/reader-library"
export ZAK_RADIO_ALLOWED_HOSTS=loopback
export ZAK_RADIO_ALLOWED_ORIGINS=loopback

go run ./cmd/zak-radio --host 127.0.0.1 --port 8793
```

The data root must contain `curated-tracks.json`. The archive must contain
`index.json` and playable media for every indexed track. Invalid, duplicate,
missing, or path-escaping catalog entries fail startup instead of producing dead
air.

`ZAK_RADIO_TIMED_LYRICS` is optional. When supplied, it must be an immutable,
flat directory of validated `<track-id>.json` timing sidecars and may include
`subjects.json` for weak imported-title replacements. Each sidecar is bound to
the exact audio digest. Sidecars can also carry display-ready text and an
explicit verified or warning status. Warning lyrics remain readable, but the UI
labels them instead of presenting uncertain transcription or timing as exact.

Local endpoints:

- Radio: <http://127.0.0.1:8793/>
- Library: <http://127.0.0.1:8793/library>
- Reader: <http://127.0.0.1:8793/reader>
- Readiness: <http://127.0.0.1:8793/health>
- Process liveness: <http://127.0.0.1:8793/live>

## Build and test

```bash
go build ./cmd/zak-radio
go test -race ./cmd/... ./internal/...
npm test
```

Pragma provides formatting, lint, generated-artifact checks, secret scanning,
and pre-push Go, Node, and Python checks. Install
[Pragma](https://github.com/zakstak/pragma) from its latest main branch, then
configure this checkout:

```bash
~/.pragma/install.sh --agent "$PWD"
prek run --all-files
prek run --all-files --stage pre-push
```

The checked-in wrappers use the local `pragma.home` Git setting or
`PRAGMA_HOME`. Python helper regression checks use Pragma's pinned pytest tool
bundle. The Go recovery tests also exercise the retained-volume maintenance
scripts against isolated fixtures.

`static/styles.tailwind.css` is the editable Tailwind v4 source.
`static/styles.css` is generated, served by the application, and must match it.

`static/signal-stack.css` is vendored byte-for-byte from Saga Product commit
[`15d427e`](https://github.com/zakstak/saga-product/commit/15d427e4944d3b209530dfa34a65a15d5b074886).
Its SHA-256 is
`93259cde1c74b2bb619d5259ee4aac8de4d70b7809179f9457ca0f8be8800c88`. The service
switcher preserves Zak Radio's compact names-only launcher while sharing the
canonical directory validation and reliable Fleet fallback. `npm test` checks
that adaptation and failed-directory refresh behavior.

For a smoke test, use your development catalog and Reader counts:

```bash
scripts/verify-runtime.py \
  --base http://127.0.0.1:8793 \
  --expected-tracks 1 \
  --expected-reader-items 0 \
  --expected-release development
```

## Run in Kiln

Kiln requires a Dockerfile for container-backed web services and builds the
container without network access. Zak Radio does not keep that container build
or its dependencies in the source tree. The package script first compiles a
static Linux binary, compresses it for Kiln's per-file upload limit, then
generates a compact Kiln context containing only:

- a compressed archive containing the Go server binary;
- the browser runtime assets;
- an optional validated timed-lyrics and subject-title bundle;
- a `FROM scratch` Dockerfile;
- the required Kiln manifest and package integrity metadata.

Create a local, loopback-only package:

```bash
manifest="$(scripts/prepare-kiln-package.sh)"
```

For a routed package, use the exact hostnames and the exact Kiln ingress peer:

```bash
route_hosts="music.home.zakstak.com"
route_origins="https://music.home.zakstak.com"
ingress_ips="<exact-Kiln-ingress-IP-or-dedicated-small-CIDR>"

manifest="$(scripts/prepare-kiln-package.sh \
  --timed-lyrics-root /path/to/validated-timed-lyrics-bundle \
  --allowed-hosts "$route_hosts" \
  --allowed-origins "$route_origins" \
  --trusted-proxies "$ingress_ips" \
  --trusted-ingress "$ingress_ips")"
```

On an authorized Saga agent VM, run the preflight first:

```bash
saga appv doctor --agent-vm --json
```

Continue only if every preflight check passes:

```bash
saga appv check --manifest "$manifest" --json
saga appv publish --manifest "$manifest" --json
```

The generated directory lives under `.kiln-packages/<RELEASE>` and is ignored by
Git. The Dockerfile is required by Kiln, but Docker is not used to compile the
application and no `vendor/` tree is committed or packaged.

Kiln retains music, Reader artifacts, curated metadata, and SQLite under
`/data/zak-radio`. The image runs as namespace UID 0 under rootless Podman and
rejects real host-root execution. `/live` reports process liveness; `/health`
remains 503 until the full retained-data audit passes. Require `/health` before
promoting a route.

See [ARCHITECTURE](ARCHITECTURE.md) for package and data boundaries and
[RECOVERY](RECOVERY.md) before moving, migrating, backing up, or restoring data.

## Station model

The main station is server-authoritative. Anyone with direct access to this
private service may control it, while cross-origin browser writes, oversized
bodies, and abusive request rates are rejected.

Temporary stations are capability-controlled, listen-only when shared, limited
in number, and deleted after 24 hours of inactivity. The controller token stays
in the creator's browser and is sent only in mutation bodies. Retrying creation
with the same browser-generated idempotency key returns the original station
instead of consuming another slot.

Saved stations persist across restarts and do not expire. They contain either an
explicit song list or a live library filter. Library supports creating,
renaming, editing membership, and deleting them. Add to station carries the
selected song into the editor when creating your first list station.

Ownership is a capability token stored in the creator's browser, not an account
profile. Shared links are listen-only; clearing browser storage loses that
browser's controls. Radio state stays server-authoritative, Library preview is
local, and Reader keeps its own progress while sharing the same audio element.
