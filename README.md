# Zak Radio

Zak Radio is one Go service for an always-on shared radio, private temporary
stations, a searchable local music library, and Reader audio. The browser uses
one application shell and one audio element, so Radio, Library, and Reader do
not create competing players.

The Go backend, SQLite schema, browser assets, and retained data-volume contract
in this repository are the product source of truth. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the code layout.

## Run locally

Install Go 1.26+ and Node 24+, then point the service at a complete data root:

```bash
npm ci
npm run build:css

export ZAK_RADIO_METADATA_ROOT=/path/to/zak-radio-data
export ZAK_RADIO_ARCHIVE="$ZAK_RADIO_METADATA_ROOT/music-library"
export ZAK_RADIO_DB="$ZAK_RADIO_METADATA_ROOT/station.sqlite3"
export ZAK_RADIO_READER_LIBRARY="$ZAK_RADIO_METADATA_ROOT/reader-library"
export ZAK_RADIO_TIMED_LYRICS=/path/to/validated-timed-lyrics-bundle
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
the exact audio digest. Tracks without a validated sidecar keep the normal
static lyrics view rather than receiving guessed timing.

Local endpoints:

- Radio: <http://127.0.0.1:8793/>
- Library: <http://127.0.0.1:8793/library>
- Reader: <http://127.0.0.1:8793/reader>
- Readiness: <http://127.0.0.1:8793/health>
- Process liveness: <http://127.0.0.1:8793/live>

## Build and test

```bash
go build ./cmd/zak-radio
go test ./...
npm run test:browser
```

Run the complete local gate with:

```bash
./scripts/check.sh
```

`static/styles.tailwind.css` is the editable Tailwind v4 source.
`static/styles.css` is generated, served by the application, and must match it.

For a running-service smoke test:

```bash
scripts/verify-runtime.py \
  --base http://127.0.0.1:8793 \
  --expected-tracks 156 \
  --expected-reader-items 1 \
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
route_hosts="music-314a5651.home.zakstak.com,zak-radio-c4c4cc7a.home.zakstak.com"
route_origins="https://music-314a5651.home.zakstak.com,https://zak-radio-c4c4cc7a.home.zakstak.com"
ingress_ips="<exact-Kiln-ingress-IP-or-dedicated-small-CIDR>"

manifest="$(scripts/prepare-kiln-package.sh \
  --timed-lyrics-root /path/to/validated-timed-lyrics-bundle \
  --allowed-hosts "$route_hosts" \
  --allowed-origins "$route_origins" \
  --trusted-proxies "$ingress_ips" \
  --trusted-ingress "$ingress_ips")"
```

Validate and publish it from an authorized Saga agent VM:

```bash
saga appv doctor --agent-vm --json
saga appv check --manifest "$manifest" --json
saga appv publish --manifest "$manifest" --json
```

The generated directory lives under `.kiln-packages/<RELEASE>` and is ignored by
Git. The Dockerfile is required by Kiln, but Docker is not used to compile the
application and no `vendor/` tree is committed or packaged.

## Build lyric timing and subject metadata

Timed lyrics are generated offline and promoted as immutable release input. The
generator uses vocal isolation, speech timing, and exact ordered matching
against the recovered lyrics. It does not rewrite source lyrics or invent
timings for unmatched text:

```bash
python3 scripts/generate-timed-lyrics.py \
  --archive /path/to/music-library \
  --output-root /path/to/alignment-run \
  --bundle-root /path/to/validated-timed-lyrics-bundle
```

Weak imported titles can be replaced with locally generated subject labels. This
command talks only to the configured local Ollama endpoint:

```bash
python3 scripts/generate-track-subjects.py \
  --archive /path/to/music-library \
  --curated /path/to/curated-tracks.json \
  --output /path/to/validated-timed-lyrics-bundle/subjects.json
```

Kiln mounts `/data/zak-radio` as a retained volume because the backend genuinely
needs persistent SQLite state, music, curated metadata, and Reader artifacts.
The image runs as container UID 0 specifically because Kiln launches it inside
an unprivileged rootless Podman user namespace; the server verifies that UID 0
maps to a non-root host UID and refuses real host-root execution. The generated
Kiln image opens its listener before performing the initial full media-digest
audit. `/health` remains `503` until that audit finishes, allowing operators and
routes to remain fail-closed while it runs. Kiln gates the container process on
`/live`; route promotion still waits for `/health` to report every retained-data
check green. The current Kiln retained-volume layout is:

```text
suno-organized-2026-06-27/
reader-library/
station.sqlite3
curated-tracks.json
```

Local and newly imported data roots may use `music-library/` instead; the
archive path is explicit in `ZAK_RADIO_ARCHIVE`.

Runtime instances hold shared lifecycle locks in the retained-volume root so
Kiln can health-check a rolling replacement before retiring the prior container.
Backup, restore, migration, and provisioning take the exclusive lock, so they
still require every runtime instance to be stopped. Validate a stopped retained
volume without modifying it:

```bash
scripts/validate-volume.sh /path/to/zak-radio-data
```

See [`RECOVERY.md`](RECOVERY.md) before moving, migrating, backing up, or
restoring the retained volume.

## Station model

The main station is server-authoritative. Anyone with direct access to this
private service may control it, while cross-origin browser writes, oversized
bodies, and abusive request rates are rejected.

Temporary stations are capability-controlled, listen-only when shared, limited
in number, and deleted after 24 hours of inactivity. The controller token stays
in the creator's browser and is sent only in mutation bodies. Retrying creation
with the same browser-generated idempotency key returns the original station
instead of consuming another slot.
