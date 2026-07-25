#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --backup SNAPSHOT_DIRECTORY --target EMPTY_VOLUME --ownership current|preserve --receipt RECEIPT_FILE --release-package VERIFIED_PACKAGE_DIRECTORY --identity-receipt EXTERNAL_RECEIPT" >&2
  exit 2
}

[[ "$#" == 12 && "$1" == "--backup" && "$3" == "--target" &&
  "$5" == "--ownership" && "$7" == "--receipt" &&
  "$9" == "--release-package" && "${11}" == "--identity-receipt" ]] || usage
[[ ! -L "$2" && ! -L "${10}" && ! -L "${12}" ]] || {
  echo "snapshot, release package, and identity receipt must not be symlinks" >&2
  exit 2
}
backup_root="$(realpath "$2")"
target_root="$(realpath -m "$4")"
ownership_mode="$6"
receipt_path="$(realpath -m "$8")"
release_package="$(realpath "${10}")"
release_file="$release_package/RELEASE"
identity_receipt="$(realpath "${12}")"
[[ "$ownership_mode" == "current" || "$ownership_mode" == "preserve" ]] || usage
[[ -d "$backup_root" && -d "$release_package" && ! -L "$release_package" &&
  -f "$release_file" && ! -L "$release_file" &&
  -f "$identity_receipt" && ! -L "$identity_receipt" &&
  "$backup_root" != "/" && "$target_root" != "/" &&
  "$receipt_path" != "/" && "$receipt_path" != "$target_root" ]] || usage
case "$target_root/" in "$backup_root/"*)
  echo "target must not be inside snapshot" >&2
  exit 2
  ;;
esac
case "$backup_root/" in "$target_root/"*)
  echo "snapshot must not be inside target" >&2
  exit 2
  ;;
esac
case "$receipt_path" in "$backup_root"/* | "$target_root"/* | "$release_package"/*)
  echo "restore receipt must be outside snapshot, target, and release package" >&2
  exit 2
  ;;
esac
backup_store_root="$(dirname -- "$backup_root")"
case "$release_package/" in "$backup_store_root/"* | "$target_root/"*)
  echo "release package must be outside backup storage and target" >&2
  exit 2
  ;;
esac
case "$identity_receipt" in "$backup_store_root"/* | "$target_root"/* | "$release_package"/*)
  echo "identity receipt must be independently stored outside backup, target, and release package" >&2
  exit 2
  ;;
esac
[[ ! -e "$receipt_path" ]] || {
  echo "refusing to overwrite restore receipt: $receipt_path" >&2
  exit 2
}

command -v realpath >/dev/null
command -v rsync >/dev/null
command -v sqlite3 >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null
command -v go >/dev/null
command -v ln >/dev/null
command -v sync >/dev/null
command -v du >/dev/null
command -v df >/dev/null
command -v flock >/dev/null
tar --version | grep -F 'GNU tar' >/dev/null || {
  echo "restore requires GNU tar for bounded archive handling" >&2
  exit 2
}
if [[ "$ownership_mode" == "current" ]]; then
  [[ "$(id -u)" == "0" ]] || {
    echo "current-runtime ownership provisioning requires root" >&2
    exit 2
  }
  command -v setpriv >/dev/null
fi
install -d -m 0750 "$(dirname -- "$receipt_path")"
receipt_lock="${receipt_path}.lock"
mkdir -m 0700 "$receipt_lock" 2>/dev/null || {
  echo "another operation owns the restore receipt path" >&2
  exit 1
}
target_guard=""
trap '[[ -z "${target_guard:-}" ]] || rmdir -- "$target_guard" 2>/dev/null || true; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
[[ ! -e "$receipt_path" ]] || {
  echo "refusing to overwrite restore receipt: $receipt_path" >&2
  exit 1
}
if [[ -e "$target_root" && ! -d "$target_root" ]]; then
  echo "refusing restore: target is not a directory: $target_root" >&2
  exit 2
fi
if [[ -d "$target_root" ]] && find "$target_root" -mindepth 1 -print -quit | grep -q .; then
  echo "refusing restore: target volume is not empty: $target_root" >&2
  exit 2
fi
target_preflight_identity=""
if [[ -d "$target_root" ]]; then
  target_preflight_identity="$(stat -Lc '%d:%i' "$target_root")"
fi

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_root/verify-release-package.sh" "$release_package" >/dev/null
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"; [[ -z "${target_guard:-}" ]] || rmdir -- "$target_guard" 2>/dev/null || true; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
install -d -m 0700 "$scratch/package" "$scratch/snapshot"
(
  cd "$release_package"
  tar --numeric-owner -cf - .
) | head -c $((600 * 1024 * 1024)) |
  tar --numeric-owner -xf - -C "$scratch/package"
sealed_package="$scratch/package"
package_release="$("$script_root/verify-release-package.sh" "$sealed_package")"
release_file="$sealed_package/RELEASE"
"$script_root/verify-snapshot.sh" \
  --snapshot "$backup_root" --release-package "$sealed_package" \
  --identity-receipt "$identity_receipt" >/dev/null

# A sparse retained database can have a very large logical size while consuming
# little storage. Gate on allocated bytes and account for both the immutable
# scratch seal and the restored target before mutating the target filesystem.
allocated_bytes="$(du -B1 -s "$backup_root/volume" | awk '{print $1}')"
[[ "$allocated_bytes" =~ ^[0-9]+$ ]] || {
  echo "could not determine snapshot allocation" >&2
  exit 1
}
space_overhead=$((128 * 1024 * 1024))
filesystem_anchor() {
  local candidate="$1"
  while [[ ! -e "$candidate" ]]; do
    candidate="$(dirname -- "$candidate")"
  done
  printf '%s\n' "$candidate"
}
target_anchor="$(filesystem_anchor "$target_root")"
scratch_available="$(df -B1 --output=avail "$scratch" | tail -n 1 | tr -d ' ')"
target_available="$(df -B1 --output=avail "$target_anchor" | tail -n 1 | tr -d ' ')"
[[ "$scratch_available" =~ ^[0-9]+$ && "$target_available" =~ ^[0-9]+$ ]] || {
  echo "could not determine restore free space" >&2
  exit 1
}
scratch_required=$((allocated_bytes + space_overhead))
target_required=$((allocated_bytes + space_overhead))
if [[ "$(stat -c '%d' "$scratch")" == "$(stat -c '%d' "$target_anchor")" ]]; then
  combined_required=$((scratch_required + target_required))
  ((scratch_available >= combined_required)) || {
    echo "restore requires $combined_required free bytes for scratch and target; $scratch_available available" >&2
    exit 1
  }
else
  ((scratch_available >= scratch_required)) || {
    echo "restore scratch requires $scratch_required free bytes; $scratch_available available" >&2
    exit 1
  }
  ((target_available >= target_required)) || {
    echo "restore target requires $target_required free bytes; $target_available available" >&2
    exit 1
  }
fi

# Seal the untrusted snapshot before validating it so later source mutations
# cannot change the bytes selected for restore. The byte limiter bounds scratch
# growth even if the source changes after the preflight.
(
  cd "$backup_root"
  tar --sparse --numeric-owner -cf - volume RECEIPT SHA256SUMS OWNER_MODES
) | head -c $((11 * 1024 * 1024 * 1024)) |
  tar --sparse --numeric-owner -xf - -C "$scratch/snapshot"
sealed="$scratch/snapshot"
snapshot_identity="$(
  "$script_root/verify-snapshot.sh" \
    --snapshot "$sealed" --release-package "$sealed_package" \
    --identity-receipt "$identity_receipt"
)"
source_release="$(sed -n 's/^source_release=//p' "$sealed/RECEIPT")"
database_schema="$(sqlite3 "file:$sealed/volume/station.sqlite3?immutable=1" 'pragma user_version;')"
max_schema="$(tr -d '\r\n' <"$sealed_package/SCHEMA_VERSION")"
[[ "$max_schema" =~ ^[0-9]+$ && "$database_schema" == "$max_schema" ]] || {
  echo "snapshot schema $database_schema is incompatible with this release (requires $max_schema)" >&2
  exit 1
}

target_parent="$(dirname -- "$target_root")"
target_name="$(basename -- "$target_root")"
[[ -d "$target_parent" && ! -L "$target_parent" ]] || {
  echo "restore requires an existing, unsymlinked direct target parent" >&2
  exit 1
}
exec {target_parent_fd}<"$target_parent"
pinned_parent="/proc/self/fd/$target_parent_fd/."
parent_identity="$(stat -Lc '%d:%i' "$pinned_parent")"
parent_uid="$(stat -Lc '%u' "$pinned_parent")"
parent_mode="$(stat -Lc '%a' "$pinned_parent")"
[[ "$(stat -Lc '%d:%i' "$target_parent")" == "$parent_identity" &&
("$parent_uid" == "0" || "$parent_uid" == "$(id -u)") &&
$((8#$parent_mode & 8#022)) == 0 ]] || {
  echo "restore target parent must be stable, trusted, and not group/world writable" >&2
  exit 1
}
target_guard="$pinned_parent/.${target_name}.zak-radio-target.lock"
mkdir -m 0700 -- "$target_guard" 2>/dev/null || {
  echo "another operation owns the restore target" >&2
  exit 1
}
trap 'rm -rf -- "$scratch"; [[ -z "${target_guard:-}" ]] || rmdir -- "$target_guard" 2>/dev/null || true; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT

if [[ -n "$target_preflight_identity" ]]; then
  [[ ! -L "$target_root" &&
    "$(stat -Lc '%d:%i' "$target_root")" == "$target_preflight_identity" ]] || {
    echo "restore target changed after preflight" >&2
    exit 1
  }
else
  mkdir -m 0750 -- "$pinned_parent/$target_name" || {
    echo "restore target was created concurrently" >&2
    exit 1
  }
fi
exec {target_fd}<"$pinned_parent/$target_name"
pinned_target="/proc/self/fd/$target_fd/."
target_identity="$(stat -Lc '%d:%i' "$pinned_target")"
[[ "$(stat -Lc '%d:%i' "$target_root")" == "$target_identity" ]] || {
  echo "restore target changed while it was being pinned" >&2
  exit 1
}
exec {target_lock_fd}>"$pinned_target/.zak-radio-volume.lock"
flock -n -x "$target_lock_fd" || {
  echo "restore target became active during installation" >&2
  exit 1
}
export ZAK_RADIO_VOLUME_ROOT_FD="$target_fd"
export ZAK_RADIO_VOLUME_LOCK_FD="$target_lock_fd"
rsync --archive --numeric-ids --sparse --exclude='.zak-radio-volume.lock' \
  "$sealed/volume/" "$pinned_target/"
if [[ "$ownership_mode" == "current" ]]; then
  "$script_root/provision-current-volume.sh" "$pinned_target"
else
  cmp -s \
    <(cd "$pinned_target" && find . ! -name '.zak-radio-volume.lock' \
      -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort) \
    "$sealed/OWNER_MODES" || {
    echo "preserved restore owner/mode inventory does not match the sealed snapshot" >&2
    exit 1
  }
fi
"$script_root/validate-volume-tree.sh" "$pinned_target"
"$script_root/validate-volume.sh" --migration-source "$pinned_target"
(
  cd "$pinned_target"
  sha256sum --check "$sealed/SHA256SUMS"
)
cmp -s \
  <(cd "$pinned_target" && find . -type f ! -name '.zak-radio-volume.lock' -print0 | LC_ALL=C sort -z) \
  <(cd "$sealed/volume" && find . -type f ! -name '.zak-radio-volume.lock' -print0 | LC_ALL=C sort -z) || {
  echo "restored target inventory does not match the sealed snapshot" >&2
  exit 1
}
sync -f "$pinned_target"
[[ ! -L "$target_root" &&
  "$(stat -Lc '%d:%i' "$target_root")" == "$target_identity" ]] || {
  echo "restore target pathname changed during installation" >&2
  exit 1
}

receipt_staging="$(mktemp "$(dirname -- "$receipt_path")/.zak-radio-restore.XXXXXX")"
trap 'rm -rf -- "$scratch"; rm -f -- "$receipt_staging"; [[ -z "${target_guard:-}" ]] || rmdir -- "$target_guard" 2>/dev/null || true; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
root_owner="$(stat -Lc '%u:%g' "$pinned_target")"
validator_source_sha256="$(
  {
    sha256sum "$script_root/../internal/application/migration_schema.go"
    sha256sum "$script_root/../internal/application/volume_validation.go"
  } | sha256sum | cut -d' ' -f1
)"
printf 'restored_at=%s\nsnapshot=%s\ntarget=%s\nownership_mode=%s\nroot_owner=%s\nschema_version=%s\nsource_release=%s\ncompatible_release=%s\nvalidator_source_sha256=%s\nsnapshot_identity=%s\nsnapshot_manifest_sha256=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$backup_root" "$target_root" \
  "$ownership_mode" "$root_owner" "$database_schema" "$source_release" \
  "$package_release" "$validator_source_sha256" "$snapshot_identity" \
  "$(sha256sum "$sealed/SHA256SUMS" | cut -d' ' -f1)" >"$receipt_staging"
chmod 0640 "$receipt_staging"
sync -f "$receipt_staging"
ln -- "$receipt_staging" "$receipt_path" || {
  echo "restore receipt path was claimed concurrently" >&2
  exit 1
}
sync -f "$(dirname -- "$receipt_path")"
rm -f -- "$receipt_staging"
rmdir -- "$receipt_lock"
rmdir -- "$target_guard"
target_guard=""
echo "restored $backup_root into $target_root"
trap - EXIT
rm -rf -- "$scratch"
