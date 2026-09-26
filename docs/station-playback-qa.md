# Station creation and playback QA

Date: 2026-09-26. Host: `saga-codex-worker`.
Checkout: `/home/agent/git/zak-radio`, based on `424434eb679c7e9e75e3bdcefe215a2702156836`.

## Reproduced defects and fixes

- **First station lost its song.** From Radio or Library, Add to station opened
  an empty editor when the browser owned no list stations. The selected song now
  enters the draft and is saved in the station's creation request.
- **Retry created duplicates.** Dropping a successful create response produced
  two stations after retry. Creation credentials now survive retries within the
  draft. The returned station ID is retained before refreshing the list, and
  edits made during retry update that station.
- **Interrupted radio could require Next.** A real HTTP response stopped after
  32,768 bytes of an MP3. Chromium remained at 1.857738 seconds with
  `paused=false`, `readyState=2`, and no media error. Foreground recovery made no
  replacement request and remained in flight; Next restored playback. Recovery
  now reloads a stalled stream before awaiting station refresh, bounds a pending
  `play()` call to four seconds, and does not treat buffering events as success.
- **Restore failed with rsync 3.5.0.** The full recovery drill rejected the
  `/proc/self/fd` destination with ELOOP. Restore now changes into the pinned
  directory before copying to `./`, retaining the inode and lifecycle-lock
  protections.
- Corrected the singular song count and distinguished saved-station owner
  controls from the shared main station.
- **QA cleanup failed under rootless Docker.** The script used host IDs inside
  the container's user namespace, leaving its temporary volume inaccessible.
  Cleanup now derives ownership from the mounted scratch directory. Prerequisite
  checks run before the expensive suite, and PASS is printed after cleanup.

## Script cleanup

Deleted the requested `.impeccable/critique/2026-07-26T17-37-33Z__static-index-html.md`.
Removed `generate-timed-lyrics.py`, an unused compatibility wrapper with ignored
`--model` and `--without-vad` flags. The documented replacement is
`python3 scripts/lyrics-harness.py bulk`.

Checked references for every remaining script. They support documented media,
release, recovery, validation, or test workflows; their safety helpers remain.
Corrected the browser fixture's static-directory environment variable to the
name read by the configuration loader.

Removed the duplicate `PRODUCT.md` brief and stale `docs/vessel-header.md`
release notes. README now starts with the disposable sandbox and describes
saved stations and browser-held ownership. Offline lyrics instructions moved
to `docs/lyrics.md`; recovery notes link the actual migrations instead of
keeping a partial schema history and distinguish rootful ownership examples
from Kiln's rootless runtime. Current design and recovery constraints remain.

## Real-media local verification

The disposable, loopback-only sandbox used a separate SQLite database, three
12-second MP3s generated at 330/440/550 Hz with LAME 3.100, and a Reader item
with two real MP3 segments. No production media or database was modified.

| Check | Observed result |
| --- | --- |
| Create a station from Gamma, then add Beta | Membership was exactly Gamma and Beta |
| Play Gamma, then Next | Correct media URLs, advancing clocks, readyState 4, no media errors |
| Search for Alpha and save a filter station | One eligible song; Alpha's MP3 played |
| Restart the Go process and reload | Both station definitions and memberships survived |
| Open shared station in another browser context | Listen-only controls; no stations in that browser's owned list |
| Reader segment playback and route change | Segment MP3 played and continued while Library was visible |
| Reader second segment, pause, reload | Position restored to 12.9 seconds in the second segment |
| Repeat the interrupted MP3 scenario after the fix | Same media URL reloaded; playback advanced to 2.948031 seconds without Next |
| `verify-runtime.py`, 3 tracks and 1 Reader item | Passed catalog, database, journal, media, Reader integrity, static, and writable checks; checked all 3 track and 2 Reader MP3s |

The automated regressions use a real HTTP server that sends part of the
committed MP3 fixture and leaves the response open. They cover one and two
consecutive stalled requests without replacing the browser's media methods.
Additional regressions cover cancellation, failed saves, lost responses,
refresh failures, actual audio playback, and intentional local pause.

## Full validation

`scripts/check.sh` completed with exit status 0 and `checks: PASS`:

- Go race tests, vet, build, and vulnerability scan.
- Repository secret scan and frontend dependency audit: no findings.
- Generated CSS comparison, JavaScript and operator-script syntax.
- All 57 browser behavior and accessibility checks.
- All 36 lyrics, 4 subject-metadata, and 6 runtime-verifier Python tests.
- Root/container backup, bootstrap, restore, ownership migration, and receipt
  checks, including rejected targets inside snapshots or source volumes.
- Minimal offline Kiln image build, file permissions, runtime health, real MP3
  range reads, reaction persistence across restart, and temporary-volume cleanup.
- Patch whitespace checks.

After correcting the fixture's environment variable, both first-station browser
tests passed again. The lyrics bulk CLI help, edited shell-script syntax, and
all local Markdown links were checked. Full-run evidence is worker-local at
`/tmp/zak-radio-full-qa-final.log`; this document records the portable results.

The worker's existing rootless Docker daemon is used. Task-local tools supply
Gitleaks 8.30.1, Docker Buildx 0.37.1, and Debian rsync 3.4.1 without changing
system packages or authentication. Release downloads were checksum-verified.
The recovery container independently exercises Alpine rsync 3.5.0.

## Limits

The playback reproduction used local Chromium with a phone-sized viewport and
an actual interrupted HTTP media stream. It is not a physical Android
background/lock-screen test. Station ownership remains browser-held capability
tokens; this change does not introduce account-based synchronization.

No production deployment is claimed here. The final Kiln management preflight
still returned HTTP 502 for both identity and status; publication remains
blocked before any production mutation.
