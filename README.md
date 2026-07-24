# Zak Radio

Zak Radio is one Go service for an always-on shared radio, private temporary
stations, a searchable local music library, and Reader audio. The browser uses
one application shell and one audio element, so moving between Radio, Library,
and Reader does not accidentally start competing players.

The Go service, SQLite schema, frontend assets, container build, Apphost
manifest, and retained data-volume contract in this repository are the product
source of truth. The retired FastAPI spike and manual systemd deployment are
intentionally not supported.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the command, application,
boundary-package, browser-module, and retained-volume layout.

## Run locally

Install Go 1.26+ and Node 24+, then point the service at a complete data root:

```bash
npm ci
npm run build:css

export ZAK_RADIO_METADATA_ROOT=/path/to/zak-radio-data
export ZAK_RADIO_ARCHIVE="$ZAK_RADIO_METADATA_ROOT/music-library"
export ZAK_RADIO_DB="$ZAK_RADIO_METADATA_ROOT/station.sqlite3"
export ZAK_RADIO_READER_LIBRARY="$ZAK_RADIO_METADATA_ROOT/reader-library"
export ZAK_RADIO_ALLOWED_HOSTS=loopback
export ZAK_RADIO_ALLOWED_ORIGINS=loopback
export ZAK_RADIO_TRUSTED_PROXIES=
export ZAK_RADIO_TRUSTED_INGRESS=

go run ./cmd/zak-radio --host 127.0.0.1 --port 8793
```

The data root must contain `curated-tracks.json`. The archive must contain
`index.json` and one playable `audio.mp3` for every indexed track. Invalid,
duplicate, missing, or path-escaping catalog entries fail startup instead of
creating dead air.

The canonical archive directory is `music-library`. Before deploying this
layout over an existing stopped retained volume, rename its current archive
directory to `music-library`, then run `scripts/validate-volume.sh` against the
volume before starting the service.

Catalog and media identity is content-derived. Track listings and station
snapshots expose the current catalog revision, and audio plus cover URLs carry
the retained artifact digest. Replacing catalog content, including a same-ID
track, therefore invalidates browser and proxy caches without relying on file
timestamps.

Validate a stopped retained volume without migrating or otherwise writing it:

```bash
scripts/validate-volume.sh /path/to/zak-radio-data
```

The validator checks the exact schema, main station, catalog structure,
trusted music and Reader digests, required Reader artifacts, and unsupported
filesystem entries.

Local endpoints:

- Radio: <http://127.0.0.1:8793/>
- Library: <http://127.0.0.1:8793/library>
- Reader: <http://127.0.0.1:8793/reader>
- Readiness: <http://127.0.0.1:8793/health>
- Process liveness: <http://127.0.0.1:8793/live>

## Build and verify

```bash
./scripts/review-baseline.sh
docker build -t zak-radio:local .
```

`static/styles.tailwind.css` is the editable Tailwind v4 source.
`static/styles.css` is generated and must match it. The baseline runs the race
detector, vet, a clean Go build, dependency audit, generated-asset comparison,
and syntax/patch checks.

For runtime smoke verification:

```bash
scripts/verify-runtime.py \
  --base http://127.0.0.1:8793 \
  --expected-tracks 156 \
  --expected-reader-items 1 \
  --expected-release development
```

The verifier checks readiness, catalog completeness, station state, all indexed
music files, all ready Reader segments, byte ranges, and a rollback-safe write
transaction.

Startup hashes every trusted media artifact before readiness becomes green.
After startup, retained integrity work runs at most once every five minutes,
examines one media artifact per cycle, and has a 30-second cycle deadline.
Failures remain cached in readiness until that artifact passes a later audit;
this bounds recurring storage and single-connection SQLite work while keeping
tamper detection continuous.

## Station model

The main station is server-authoritative. Anyone with direct access to this
private service may control it, but cross-origin browser writes, oversized
bodies, and abusive request rates are rejected.

Temporary stations are capability-controlled, listen-only when shared, limited
in number, and deleted after 24 hours of inactivity. The controller token stays
in the creator's browser and is sent only in mutation bodies; it is never put in
a URL or access log. Creation requires a browser-generated idempotency key and
owner token. Retrying the same attempt returns the same station and credentials
instead of consuming another temporary-station slot.

## Apphost deployment

[`apphost.vnext.toml`](apphost.vnext.toml) is the canonical deployment contract:

- a Go web service on port `8787`;
- readiness at `/health`;
- a retained, backup-required volume mounted at `/data/zak-radio`;
- `retainOnDestroy` data semantics.

The self-contained Dockerfile builds both the Go binary and frontend assets
from a clean checkout. The final image runs as numeric UID/GID `65532` and its
entrypoint verifies that the retained volume was pre-provisioned for that
identity before it opens product data or the network listener. Bootstrap and
current-runtime restore mode provision the volume; runtime startup never
recursively changes operator-owned paths. No prebuilt binary, Python
environment, or systemd unit is required.

The runtime holds a nonblocking exclusive lock in the retained-volume root for
its entire lifetime. Backup, bootstrap, ownership migration, and provisioning
take the same lock before operating, so a mistaken quiescence assertion cannot
race a live process. The operator scripts require Linux `flock` support and
Python 3 for the no-follow lock wrapper.

Privilege-enforced production startup accepts only the canonical retained
layout (`music-library`, `station.sqlite3`, and `reader-library`
directly beneath the metadata root), matching every shipped backup and restore
tool. Alternate in-root paths remain available only for non-production
development fixtures.

For a new empty volume, import only from a stopped service or immutable export:

```bash
sudo env ZAK_RADIO_SOURCE_QUIESCED=1 \
  scripts/bootstrap-volume.sh \
  --source /path/to/quiesced-export \
  --target /path/to/new-volume
```

Bootstrap and backup validate either the exact current schema or an exact
supported migration source without changing it. They measure allocated source
blocks and available destination space before creating or copying target
entries; sparse files remain sparse. Retained-tree admission rejects file and
directory bind mounts by mount identity, and rootful provisioning pins the
validated directory descriptor so a renamed pathname cannot redirect the
operation. Restore and bootstrap require the target's direct parent to exist,
be trusted, and not be group- or world-writable. They pin that parent, reserve
the target name atomically, and create and lock the new volume through the
pinned descriptor.

Before promoting an existing retained volume from a root/legacy-UID image,
take a verified backup, stop the old service, and run the receipt-gated
ownership migration:

```bash
sudo env ZAK_RADIO_SERVICE_QUIESCED=1 \
  scripts/migrate-volume-ownership.sh \
  --volume /path/to/retained-volume \
  --backup /path/to/verified-pre-migration-snapshot \
  --source-package /path/to/currently-deployed-package \
  --receipt /path/to/operator-receipts/zak-radio-<timestamp>-<release>-ownership.txt \
  --identity-receipt /path/to/independent-receipts/zak-radio-<timestamp>-<release>-snapshot.txt
```

The source package must match the old running schema and the rollback
snapshot. Ownership conversion verifies the package identity, then uses the
trusted validator from this operator checkout; release-package source is
never executed with host privileges. Only after the receipt passes does the
new candidate perform its schema migration. Supported legacy schema objects
are allowlisted before any writable migration connection is opened, so
unexpected views, indexes, or triggers fail before the retained database is
changed. Before
promotion, bind the receipt back to the candidate volume, source package, and
rollback snapshot:

```bash
sudo scripts/verify-ownership-receipt.sh \
  --volume /path/to/retained-volume \
  --receipt /path/to/operator-receipts/zak-radio-<timestamp>-<release>-ownership.txt
```

Keep the pre-migration backup until the new image passes `/health` and
`scripts/verify-runtime.py`. Rollback restores that backup into a new empty
volume and promotes the prior image; never mutate the backup snapshot.

Kiln applies a strict package policy and must not receive the repository's
`.git` directory or operator-only Python verifier. The manifest format has no
plain runtime-environment field, so the package builder is the explicit
deployment configuration channel: it bakes exact route and ingress values
into the immutable candidate image. Discover the candidate's exact ingress
peer from Kiln and use the route hosts returned by the publish/plan output;
never substitute a whole container-network range.

```bash
route_hosts="music-314a5651.home.zakstak.com,zak-radio-c4c4cc7a.home.zakstak.com"
route_origins="https://music-314a5651.home.zakstak.com,https://zak-radio-c4c4cc7a.home.zakstak.com"
ingress_ips="<exact-Kiln-ingress-IP-or-dedicated-small-CIDR>"

manifest="$(scripts/prepare-apphost-package.sh \
  --allowed-hosts "$route_hosts" \
  --allowed-origins "$route_origins" \
  --trusted-proxies "$ingress_ips" \
  --trusted-ingress "$ingress_ips")"
saga appv publish --manifest "$manifest" --service-url "$APPHOST_SERVICE_URL"
```

The package directory contains `RELEASE`, a deterministic digest of the
reviewed source plus exact route/ingress configuration. `PACKAGE.SHA256SUMS`
binds every build input, and the container build recomputes it before
compilation. The same value is
compiled into `/live` and `/health`; pass it as `--expected-release` to every
promotion verifier run. Backups take the complete currently deployed package
as `--source-package`, compare it to `--expected-runtime-release` captured
from live health immediately before shutdown, and require an independently
stored `--identity-receipt`;
restores require that receipt and the complete matching source package through
`--release-package`. Restore verifies the package inventory and release
identity, then runs the trusted validator shipped with these operator scripts.
It never executes source from the supplied package with host privileges; a
detached 64-hex release file still cannot claim package provenance.
The restore receipt records the compatible source release and the SHA-256 of
the trusted validator source actually used. The package binds compatibility
identity and schema; it does not falsely attest that package code performed the
validation.

The builder's default output is immutable and versioned as
`.apphost-packages/<RELEASE>`; preparing a candidate never replaces the
package required to back up or restore the running release. An explicit
`--output` may be reused only for identical inputs and otherwise fails closed.
The generated package tree is ignored; this repository remains the only source
of product code. Calling the builder without all four external values
intentionally produces a loopback-only local image. External packages always
retain the `loopback` Host and Origin tokens required by Kiln's local health
probe in addition to the exact public routes.

Prepared packages include the complete Go vendor tree and the already
baseline-verified generated CSS. The production Dockerfile performs no
dependency download and is tested with `--network=none --pull=false`, matching
Kiln's clean offline build contract. Routing and ingress values live in a
hashed generated Go source file; the image has no overridable routing build
arguments, and a packaged binary rejects conflicting runtime environment
values.

External listener configuration fails closed unless exact comma-separated
Hosts, Origins, proxy identity sources, and authorized ingress peers are
present. `ZAK_RADIO_TRUSTED_PROXIES` controls who may overwrite client
identity through `X-Real-IP`; `ZAK_RADIO_TRUSTED_INGRESS` independently
controls which backend peers may reach an external Host. IPv6 abuse buckets
default to `/64` and can be changed with `ZAK_RADIO_CLIENT_IPV6_PREFIX`.
Loopback Hosts require a loopback peer.

Before promotion, take the platform-required retained-volume backup and run
the runtime verifier through every candidate HTTPS route, then send a request
with an unknown Host and require `421`. A loopback health check alone is not a
promotion proof. See [RECOVERY.md](RECOVERY.md) for migration backup and
restore gates.

The 10 GiB platform volume admits at most 9 GiB of retained product data plus
1 GiB of validated migration-backup artifacts. Startup accounts for those
categories separately and rejects a post-backup tree that could not restart.
Migration checks both projected durable usage and actual free filesystem
blocks before mutation. A protected receipt reuses the same verified backup
across failed retries and Reader reconciliation, preventing restart loops from
allocating another full copy. Readiness turns unhealthy when remaining
filesystem headroom falls below the operational minimum.
The protected migration backup is an exact, fsynced copy of the checkpointed
SQLite main file and must match its source digest. A successful promotion keeps
that current rollback copy while retiring older recognized automatic migration
backups, bounding retained-volume growth.

## Review gate

[REVIEW.md](REVIEW.md) defines the five independent review lenses, finding
contract, repeat-until-clean protocol, and exit gate used for this greenfield
project.
