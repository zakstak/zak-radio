# Data recovery and rollback

Production state lives in the Apphost retained volume mounted at
`/data/zak-radio`. The source was originally recovered on 2026-07-16 from the
disabled Zak Radio runtime on `saga-runtime-v2`; no media, database, credential,
or environment data is stored in this repository.

## Required backup layers

Apphost promotion requires a retained-volume backup. In addition, the
application creates a validated SQLite backup beside the database immediately
before any automatic schema migration:

```text
station.sqlite3.schema-v<old>-<pre-migration database SHA-256>.bak
```

The digest-based name makes retries reuse the same protected source backup.
After a WAL checkpoint, the application creates and fsyncs an exact copy of
the SQLite main file. The backup must match the source digest byte-for-byte and
pass immutable `PRAGMA quick_check`; an unrelated pre-existing file is never
adopted. Startup stops if those checks fail. After successful migration, the
current rollback copy is retained and older recognized automatic migration
backups are retired so retries and sequential upgrades cannot grow the volume
without bound.
The automatic file protects schema rollback. The platform snapshot or the
repository snapshot scripts protect the database, media, Reader artifacts,
trusted media digests, and curated metadata together.

Schema 11 retires legacy temporary stations that predate creator attribution.
Those rows cannot be assigned honestly to the per-creator fairness bucket, so
they are removed during upgrade; the shared station and newly attributed
temporary stations are retained.

Schema 12 adds bounded, JSON-safe revision headroom for station, track-stat,
skip-count, and Reader playback state. Out-of-range retained counters are
normalized during that one-time upgrade; subsequent mutations fail atomically
instead of wrapping or silently changing SQLite storage type.

Schema 13 reserves the terminal revision value so exhausted station, track,
skip, and Reader state cannot be admitted as healthy. It also adds a durable
logical-clock high-water mark, periodically checkpointed and flushed during
orderly shutdown so a host wall-clock rollback cannot replay station time
across restart.

Schema 14 adds durable temporary-station creation keys. A client-generated
idempotency key and owner token bind one creation attempt to one station, so a
timeout followed by a retry returns the original result instead of allocating
another station.

Never copy or rsync `station.sqlite3` or the volume while the service is running.
SQLite uses WAL mode, so a lone main-file copy can omit committed transactions
or be combined with stale `-wal`/`-shm` files.

## Quiesced volume backup

Run the maintenance commands on a Linux operator host with this repository,
Go 1.26+, Python 3, `bash`, `sqlite3`, `rsync`, GNU `tar`, GNU `sha256sum`, and
Linux `flock` installed. The scratch application container intentionally
contains none of those administration tools. Rootful ownership provisioning
additionally requires util-linux (`setpriv`).

Stop the service and wait for its process to exit. Then create a checkpointed,
hashed snapshot outside the retained volume:

```bash
sudo env ZAK_RADIO_SERVICE_QUIESCED=1 \
  scripts/backup-volume.sh \
  --source /data/zak-radio \
  --output /srv/backups/zak-radio \
  --source-package /path/to/currently-deployed-package \
  --expected-runtime-release <exact-health-release-before-stop> \
  --identity-receipt /srv/independent-receipts/zak-radio-<timestamp>-<release>-snapshot.txt
```

`--source-package` must be the complete verified package currently serving the
volume, not the candidate being promoted. Record `/health.release` immediately
before stopping the source service and pass that exact value as
`--expected-runtime-release`; backup seals the package, verifies its complete
inventory, compares the two identities, and runs the trusted validator from
this operator checkout. Supplied release-package source is never executed with
host privileges.
The runtime and all mutating operator procedures also contend on the same
nonblocking retained-volume lifecycle lock. `ZAK_RADIO_SERVICE_QUIESCED=1`
records the operator's intent; the lock provides process-level exclusion.
Keep the identity receipt on independently protected operator storage, outside
the retained volume, package, and backup store.
Package outputs are immutable. The builder's default is
`.apphost-packages/<RELEASE>`; never place backup output inside that package,
and never replace the running release's package while preparing a candidate.
The script refuses an in-volume destination, checkpoints WAL, runs the
read-only full-volume validator, rejects unsupported filesystem names/types,
hard links, nested mounts, and over-budget trees before a bounded copy, then
writes `SHA256SUMS` plus a
schema/release/snapshot-identity receipt. A platform snapshot is acceptable only if Apphost
documents equivalent crash-consistent semantics; otherwise keep the service
stopped for the snapshot.

Backup and bootstrap also preflight sparse-aware allocated bytes plus recovery
overhead against the destination filesystem before they create or populate a
target. Validation compares mount identities for every retained entry,
including regular-file bind mounts. Rootful target operations use a pinned
directory descriptor and abort if the operator-visible pathname no longer
names that directory.
Restore and bootstrap require an existing direct target parent that is not
group- or world-writable. They pin that parent, atomically reserve the target
name, create the new volume through the pinned descriptor, and take its
lifecycle lock before copying product data.

An existing root- or legacy-UID-owned volume must be migrated before the
65532 runtime is promoted. Keep the backup above as the rollback source, then
run:

```bash
sudo env ZAK_RADIO_SERVICE_QUIESCED=1 \
  scripts/migrate-volume-ownership.sh \
  --volume /data/zak-radio \
  --backup /srv/backups/zak-radio/zak-radio-<timestamp> \
  --source-package /srv/releases/zak-radio/<old-release> \
  --receipt /srv/operator-receipts/zak-radio-<timestamp>-<release>-ownership.txt \
  --identity-receipt /srv/independent-receipts/zak-radio-<timestamp>-<release>-snapshot.txt
```

Promotion is blocked unless `scripts/verify-ownership-receipt.sh` accepts that
receipt against the candidate volume, its exact source release package, and
its exact rollback snapshot. The trusted operator validator checks content
before and after ownership conversion without executing the old package. It
admits exact current volumes and recognized legacy migration sources, while
rejecting unexpected legacy schema objects before the candidate opens a
writable migration connection; the
new candidate then performs the schema
migration at startup. Rollback restores the untouched pre-migration
snapshot into a new empty volume with ownership-preservation mode and starts
the prior image.

Restore into a newly allocated empty volume:

```bash
sudo scripts/restore-volume.sh \
  --backup /srv/backups/zak-radio/zak-radio-<timestamp> \
  --target /data/zak-radio-restored \
  --ownership current \
  --receipt /srv/operator-receipts/zak-radio-<restore-timestamp>-<release>-current-restore.txt \
  --release-package /path/to/matching-source-package \
  --identity-receipt /srv/independent-receipts/zak-radio-<timestamp>-<release>-snapshot.txt
```

Restore first seals the snapshot into private scratch space, then verifies
the package inventory and identity, every snapshot file digest, owner/mode
entry, package release, receipt schema against the sealed database's
`PRAGMA user_version`, and the full boot contract with the trusted validator
shipped beside these recovery scripts. The verified source package supplies
identity and schema compatibility, not executable host-root code. The restore
receipt records both that compatible source release and the SHA-256 of the
trusted validator source actually executed. Recognized migration-source
validation covers Reader manifests and ready audio artifacts as well as the
database and music catalog, including legacy schemas that predate retained
Reader digest tables. The release package and independent
identity receipt must be outside the backup store, snapshot, retained target,
and each other. Snapshot controls and retained data are size/count bounded
before an explicit allowlisted copy into scratch. It checks the copied target's
complete inventory and digests before issuing a receipt. `--ownership current`
requires root and provisions
UID/GID `65532`. For rollback to a prior root or legacy-UID image, use
`--ownership preserve` and a different external receipt path; numeric
ownership and modes from the snapshot are verified byte-for-byte. Every
restore fails without a receipt if the operator cannot reproduce that numeric
ownership; use root whenever snapshot ownership differs from the operator.
The same snapshot is safe to
restore repeatedly.
Every backup, ownership conversion, and restore uses a new immutable receipt
path containing its timestamp and release. Never delete or overwrite an older
receipt to reuse an example filename. Each operation takes a nonblocking
per-receipt lock before any preflight that may fail and publishes the initial
receipt with an atomic no-replace link; a competing operation against the same
path fails and every exit path releases the lock.

Restore requires the independently retained snapshot identity and the complete
verified source package that authored the snapshot. A standalone `RELEASE`
file is deliberately insufficient. Candidate release B must never be used to
label or validate release A's pre-promotion rollback data; restore A with A,
then let B migrate a separate candidate copy.

The runtime admits at most 9 GiB of product data plus 1 GiB of validated
migration-backup artifacts on the 10 GiB retained volume. Migration must not
begin unless both the projected post-backup usage and actual available blocks
fit. A protected in-volume receipt reuses one verified backup across retries
and Reader reconciliation; incomplete backup outputs are removed.

## Additional database backup

For an additional operator-named SQLite backup, create it through SQLite's
online backup API. This is not a substitute for the volume snapshot:

```bash
install -d -m 0750 /data/zak-radio/backups
sqlite3 /data/zak-radio/station.sqlite3 \
  ".backup '/data/zak-radio/backups/station-$(date -u +%Y%m%dT%H%M%SZ).sqlite3'"
sqlite3 /data/zak-radio/backups/station-<timestamp>.sqlite3 \
  "PRAGMA quick_check; PRAGMA user_version;"
```

The first verification result must be `ok`. Record the image/release identity,
schema version, backup filename, and retained-volume backup receipt together.

## Restore gate

Restore is an image-plus-data operation:

1. Stop routing traffic and stop the service; confirm the process exited.
2. Preserve the failed volume; do not overwrite the only copy.
3. Restore the retained-volume snapshot into a new empty volume with
   `scripts/restore-volume.sh`, or restore a named SQLite backup into a new
   staging database with SQLite's backup API.
4. Run `scripts/validate-volume.sh` from the same release as the snapshot
   against the restored volume. Restore rejects any schema other than this
   release's exact schema; older snapshots must first be restored with their
   matching release, then started to create the protected pre-migration
   backup and migrate.
5. Remove stale `station.sqlite3-wal` and `station.sqlite3-shm` only while the
   service is stopped and only after the replacement database is in place.
6. Start the matching image with exact Host, Origin, trusted-proxy, and
   trusted-ingress settings. Require `/health` and
   `scripts/verify-runtime.py` to pass through every candidate external route
   with `--expected-release` set to the release recorded by the restore receipt
   before restoring traffic. The verifier streams every music and ready
   Reader artifact and compares it with its retained trusted SHA-256 digest.

Example SQLite-only staging restore while stopped. First clone or allocate a
new retained volume; the failed volume remains mounted read-only and is never
the destination:

```bash
restore_root=/data/zak-radio-restore-<timestamp>
install -d -m 0750 -o 65532 -g 65532 "$restore_root"
# Copy the known-good media, Reader library, and metadata into "$restore_root"
# from a verified snapshot or platform clone. Do not copy from a corrupt tree.
sqlite3 /data/zak-radio/backups/station-<timestamp>.sqlite3 \
  ".backup '$restore_root/station.sqlite3'"
sqlite3 "$restore_root/station.sqlite3" "PRAGMA quick_check;"
chown 65532:65532 "$restore_root/station.sqlite3"
chmod 0600 "$restore_root/station.sqlite3"
```

Use the platform's retained-volume restore for normal production recovery; the
SQLite-only procedure is appropriate only when media and metadata are already
known-good and unchanged. Validate and promote the new volume; retain the
failed volume byte-for-byte until recovery is accepted.
