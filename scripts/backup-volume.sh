#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: ZAK_RADIO_SERVICE_QUIESCED=1 $0 --source VOLUME --output BACKUP_DIRECTORY --source-package DEPLOYED_PACKAGE --expected-runtime-release RELEASE --identity-receipt EXTERNAL_RECEIPT" >&2
  exit 2
}

[[ "${ZAK_RADIO_SERVICE_QUIESCED:-}" == "1" ]] || {
  echo "refusing snapshot: stop the service, then set ZAK_RADIO_SERVICE_QUIESCED=1" >&2
  exit 2
}
[[ "$#" == 10 && "$1" == "--source" && "$3" == "--output" &&
   "$5" == "--source-package" && "$7" == "--expected-runtime-release" &&
   "$9" == "--identity-receipt" ]] || usage
source_root="$(realpath "$2")"
output_root="$(realpath -m "$4")"
source_package="$(realpath "$6")"
expected_runtime_release="$8"
identity_receipt="$(realpath -m "${10}")"
[[ -d "$source_package" && ! -L "$source_package" &&
   "$expected_runtime_release" =~ ^[0-9a-f]{64}$ ]] || usage
[[ -d "$source_root" && "$source_root" != "/" && "$output_root" != "/" ]] || usage
[[ "$identity_receipt" != "/" && ! -e "$identity_receipt" ]] || usage
case "$output_root/" in
  "$source_root/"*) echo "backup output must be outside the retained volume" >&2; exit 2 ;;
esac
case "$source_package/" in
  "$source_root/"*|"$output_root/"*) echo "source package must be outside the retained volume and backup storage" >&2; exit 2 ;;
esac
case "$output_root/" in
  "$source_package/"*) echo "backup output must be outside the immutable source package" >&2; exit 2 ;;
esac
case "$identity_receipt/" in
  "$source_root/"*|"$output_root/"*|"$source_package/"*) echo "identity receipt must be outside the volume, backup storage, and source package" >&2; exit 2 ;;
esac
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v go >/dev/null
command -v python3 >/dev/null
command -v ln >/dev/null
command -v tar >/dev/null
command -v sync >/dev/null
command -v du >/dev/null
command -v df >/dev/null
if ! python3 "$script_root/with-volume-lock.py" --verify "$source_root" 2>/dev/null; then
  unset ZAK_RADIO_VOLUME_ROOT_FD ZAK_RADIO_VOLUME_LOCK_FD
  exec python3 "$script_root/with-volume-lock.py" "$source_root" -- "$0" "$@"
fi
locked_source_root="/proc/self/fd/$ZAK_RADIO_VOLUME_ROOT_FD/."
tar --version | grep -q 'GNU tar' || {
  echo "backup requires GNU tar for bounded sparse-file handling" >&2
  exit 2
}
source_release="$("$script_root/verify-release-package.sh" "$source_package")"
[[ "$source_release" == "$expected_runtime_release" ]] || {
  echo "source package does not match the recorded runtime release" >&2
  exit 1
}
install -d -m 0750 "$(dirname -- "$identity_receipt")"
receipt_lock="${identity_receipt}.lock"
mkdir -m 0700 "$receipt_lock" 2>/dev/null || {
  echo "another operation owns the identity receipt path" >&2
  exit 1
}
trap 'rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
[[ ! -e "$identity_receipt" ]] || {
  echo "refusing to overwrite identity receipt: $identity_receipt" >&2
  exit 1
}
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
install -d -m 0700 "$scratch/package"
(
  cd "$source_package"
  tar --numeric-owner -cf - .
) | head -c $((600 * 1024 * 1024)) |
  tar --numeric-owner -xf - -C "$scratch/package"
sealed_package="$scratch/package"
source_release="$("$script_root/verify-release-package.sh" "$sealed_package")"
[[ "$source_release" == "$expected_runtime_release" ]] || {
  echo "sealed source package does not match the recorded runtime release" >&2
  exit 1
}
database="$locked_source_root/station.sqlite3"
"$script_root/validate-volume-tree.sh" "$locked_source_root"
[[ -f "$database" && ! -L "$database" ]] || {
  echo "retained volume has no station.sqlite3" >&2
  exit 1
}
checkpoint="$(sqlite3 "$database" 'pragma wal_checkpoint(truncate);')"
[[ "$checkpoint" == "0|0|0" ]] || {
  echo "SQLite WAL checkpoint failed: $checkpoint" >&2
  exit 1
}
[[ "$(sqlite3 "$database" 'pragma quick_check;')" == "ok" ]] || {
  echo "SQLite quick_check failed" >&2
  exit 1
}
schema_version="$(sqlite3 "$database" 'pragma user_version;')"
for sqlite_sidecar in "$locked_source_root/station.sqlite3-wal" "$locked_source_root/station.sqlite3-shm"; do
  rm -f -- "$sqlite_sidecar"
done
sync -f "$database"
sync -f "$locked_source_root"
"$script_root/validate-volume.sh" --migration-source "$locked_source_root"

allocated_bytes="$(du -B1 -s "$locked_source_root" | awk '{print $1}')"
[[ "$allocated_bytes" =~ ^[0-9]+$ ]] || {
  echo "could not determine source allocation" >&2
  exit 1
}
output_anchor="$output_root"
while [[ ! -e "$output_anchor" ]]; do
  output_anchor="$(dirname -- "$output_anchor")"
done
output_available="$(df -B1 --output=avail "$output_anchor" | tail -n 1 | tr -d ' ')"
[[ "$output_available" =~ ^[0-9]+$ ]] || {
  echo "could not determine backup free space" >&2
  exit 1
}
required_bytes=$((allocated_bytes + 128 * 1024 * 1024))
(( output_available >= required_bytes )) || {
  echo "backup requires $required_bytes free bytes; $output_available available" >&2
  exit 1
}
install -d -m 0750 "$output_root"
receipt_staging="$(mktemp "$(dirname -- "$identity_receipt")/.zak-radio-snapshot.XXXXXX")"
timestamp="$(date -u +%Y%m%dT%H%M%S.%NZ)"
staging="$(mktemp -d "$output_root/.zak-radio-$timestamp.XXXXXX")"
trap 'rm -rf -- "$scratch" "$staging"; rm -f -- "$receipt_staging"; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
install -d -m 0750 "$staging/volume"
(
  cd "$locked_source_root"
  tar --sparse --numeric-owner --exclude='./.zak-radio-volume.lock' -cf - .
) | head -c $((11 * 1024 * 1024 * 1024)) |
  tar --numeric-owner -xf - -C "$staging/volume"
"$script_root/validate-volume-tree.sh" "$staging/volume"
"$script_root/validate-volume.sh" --migration-source "$staging/volume"
(
  cd "$staging/volume"
  find . -type f ! -name '.zak-radio-volume.lock' -print0 | sort -z | xargs -0 sha256sum
) >"$staging/SHA256SUMS"
(
  cd "$staging/volume"
  find . ! -name '.zak-radio-volume.lock' -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort
) >"$staging/OWNER_MODES"
printf 'created_at=%s\nschema_version=%s\nsource_release=%s\n' \
  "$timestamp" "$schema_version" "$source_release" >"$staging/RECEIPT"
snapshot_identity="$(
  {
    cat "$staging/SHA256SUMS"
    cat "$staging/OWNER_MODES"
    printf 'created_at=%s\nschema_version=%s\nsource_release=%s\n' \
      "$timestamp" "$schema_version" "$source_release"
  } | sha256sum | cut -d' ' -f1
)"
printf 'snapshot_identity=%s\n' "$snapshot_identity" >>"$staging/RECEIPT"
"$script_root/verify-snapshot.sh" \
  --snapshot "$staging" --release-package "$sealed_package" >/dev/null
sync -f "$staging"
destination="$output_root/zak-radio-$timestamp"
[[ ! -e "$destination" ]] || {
  echo "refusing to overwrite existing snapshot: $destination" >&2
  exit 1
}
mv -T "$staging" "$destination"
sync -f "$output_root"
printf 'created_at=%s\nsnapshot_identity=%s\nsource_release=%s\nsnapshot_manifest_sha256=%s\nsnapshot_owner_modes_sha256=%s\n' \
  "$timestamp" "$snapshot_identity" "$source_release" \
  "$(sha256sum "$destination/SHA256SUMS" | cut -d' ' -f1)" \
  "$(sha256sum "$destination/OWNER_MODES" | cut -d' ' -f1)" >"$receipt_staging"
chmod 0640 "$receipt_staging"
sync -f "$receipt_staging"
ln -- "$receipt_staging" "$identity_receipt" || {
  echo "identity receipt path was claimed concurrently" >&2
  exit 1
}
sync -f "$(dirname -- "$identity_receipt")"
rm -f -- "$receipt_staging"
rmdir -- "$receipt_lock"
trap - EXIT
rm -rf -- "$scratch"
echo "$destination"
