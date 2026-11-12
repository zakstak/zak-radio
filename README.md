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

Unknown page addresses answer 404 with the app shell, which shows "Page not
found" with links to Radio, Library, and Reader. API, media, and asset paths
keep plain 404 responses.

Local endpoints:

- Radio: <http://127.0.0.1:8793/>
- Library: <http://127.0.0.1:8793/library>
- Reader: <http://127.0.0.1:8793/reader>
- Readiness: <http://127.0.0.1:8793/health>
- Process liveness: <http://127.0.0.1:8793/live>

## Add songs

Signed-in listeners can use **Library > Add song** when the service has an SSO
identity source configured. The form requires a title, artist, and MP3 file.
Lyrics are optional. Accepted songs appear immediately in Library and Radio, and
persist across restarts.

The server enforces these requirements:

- Title and artist each contain 1 to 120 characters on one line.
- Audio is a complete, decodable MPEG-1 or MPEG-2 Layer III `.mp3`, at most 32
  MiB and 20 minutes, with a constant sample rate. ID3v2.3, ID3v2.4, and ID3v1
  tags are supported.
- Lyrics are UTF-8 text, at most 64 KiB, without control characters other than
  line breaks and tabs.
- The audio digest is new to the library, and the catalog and retained volume
  have capacity for the song.

Duration, track IDs, filenames, and audio digests come from the server. Uploads
cannot replace existing songs or choose storage paths. The service accepts one
upload at a time and limits each client address to 20 attempts per hour.

### Configure upload identity

Uploads are disabled by default. To enable them, configure
`ZAK_RADIO_UPLOAD_IDENTITY_HEADER` or `--upload-identity-header` with the exact
identity header that your SSO proxy sets after successful authentication.
`ZAK_RADIO_TRUSTED_PROXIES` must identify the immediate proxy peer by IP or
CIDR. The proxy must discard client-supplied copies of that header and overwrite
it with the authenticated user identity. Forwarding an arbitrary request header
does not establish a login.

For Kiln packages, pass `--upload-identity-header HEADER` to
`scripts/prepare-kiln-package.sh` along with the existing exact routing
settings. The header name becomes part of the package identity. The gateway must
allow POST requests to `/api/tracks` and bodies up to 33 MiB. This application
setting does not configure the gateway or change SSO policy.

### Give an agent upload access

Sign in and open **Library > API access** to create an upload key. Copy the key
once, then configure your agent to send it as `Authorization: Bearer <key>`.
Keys grant `songs:write`, expire after 30 days by default, and can be revoked in
the same dialog. Each user can have five active keys. Only hashes of keys and
their owners' SSO identities are stored.

Give the agent the instance's `/ai.json` URL. It includes the authentication
steps, upload format, curl examples, and retry rules in one document. The same
guide is available at `/.well-known/ai.json`, and it links to the complete
OpenAPI definition at `/api/song-upload/openapi.json`. `GET /api/song-upload`
checks its access and reports the limits. `POST /api/tracks` accepts multipart
fields `title`, `artist`, `audio`, and optional `lyrics`, and returns the new
track with status 201. Errors are JSON with stable codes. Duplicate audio
returns 409 with `existing_track_id`, so an agent can resolve a retry after a
lost response.

See [Upload songs through the API](docs/song-upload-api.md) for curl examples,
agent instructions, and gateway requirements. The gateway must forward bearer
credentials to these automation endpoints without an interactive SSO redirect.
Key management remains behind SSO. This checkout does not change the gateway.

Uploaded media lives under the configured archive's `uploads/Listener songs/`.
Files are flushed before an atomic index replacement, so an interrupted write
cannot expose a partial song. A crash before index publication can leave an
unreferenced upload directory. Retained-volume backups include these files. The
curated metadata format stays compatible. API keys add database schema 19 with
an automatic backup before migration. A schema-18 binary cannot open the
migrated database. Roll back with the matching pre-upgrade volume snapshot.

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
switcher adapts the canonical one in two ways: compact launcher tiles (name and
monogram), and a fallback note that links Fleet when the service directory
doesn't load. It shares the canonical directory validation and reliable Fleet
fallback. `npm test` checks those adaptations and failed-directory refresh
behavior.

Interface wording follows [docs/ui-glossary.md](docs/ui-glossary.md).

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

Pyre owns deployment access and Kiln owns publication, backups, and runtime
health. Follow the execution host's current Pyre instructions and
[deployment procedure](docs/deployment.md). Forge has a scoped Pyre client;
publication does not require a Saga CLI or a worker VM.

On Forge, verify the installed client:

```bash
~/.local/bin/pyre-lab kiln.doctor
~/.local/bin/pyre-lab kiln.inventory
```

Preserve the exact live rollback package before publication. A directory's
timestamp does not prove that it matches the running deployment. Kiln 2.1
rejects volume size limits that its directory backend cannot enforce, so the
generated manifest omits that declaration. The retained volume, mount, and
backup requirement remain unchanged. The manifest's historical `owner = "saga"`
is a stored identity, not an instruction to use retired Saga tooling.

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
in number, and deleted after 24 hours of inactivity. Their owner can also end
them early with `DELETE /api/stations/{id}`. When the limit is reached, creation
answers 429 with `Retry-After` set to when the next slot frees up by expiry;
without it, saved stations hold every slot. `X-Station-Limit` gives the number
of stations the limit allows and `X-Station-Limit-Scope` says whether it is the
creator's own limit (`creator`) or the service-wide one (`service`), so the
browser can state the limit plainly. The controller token stays in the creator's
browser and is sent only in mutation bodies. Retrying creation with the same
browser-generated idempotency key returns the original station instead of
consuming another slot.

Saved stations persist across restarts and do not expire. They contain either an
explicit song list or a live library filter. A filter station matches its words
the way Library search does (case and accents folded, British spellings, and
close spellings when nothing matches exactly), so a saved search keeps playing
the songs it showed. Library supports creating, renaming, editing membership,
and deleting them. Add to station carries the selected song into the editor when
creating your first list station.

Like and Dislike are per-browser toggles. The browser remembers its own reaction
for each song, and `POST /api/reaction` with `"remove": true` withdraws it;
counts never go below zero.

Ownership is a capability token stored in the creator's browser, not an account
profile. Shared links are listen-only; clearing browser storage loses that
browser's controls. The station editor can copy a private edit link
(`/library#edit=<station>.<token>`) that moves editing of a saved station to
another browser. The token stays in the URL fragment, so it never reaches the
server's request log; the receiving browser checks it with an empty `PATCH` and
removes it from the address at once. Radio state stays server-authoritative,
Library preview is local, and Reader keeps its own progress while sharing the
same audio element.
