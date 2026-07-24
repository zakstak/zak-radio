#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: ZAK_RADIO_SERVICE_QUIESCED=1 $0 --volume RETAINED_VOLUME --backup SNAPSHOT --source-package MATCHING_RELEASE_PACKAGE --receipt NEW_RECEIPT --identity-receipt EXTERNAL_SNAPSHOT_RECEIPT" >&2
  exit 2
}

[[ "${ZAK_RADIO_SERVICE_QUIESCED:-}" == "1" ]] || {
  echo "refusing ownership migration: stop the service and set ZAK_RADIO_SERVICE_QUIESCED=1" >&2
  exit 2
}
[[ "$#" == 10 && "$1" == "--volume" && "$3" == "--backup" &&
   "$5" == "--source-package" && "$7" == "--receipt" &&
   "$9" == "--identity-receipt" ]] || usage
[[ "$(id -u)" == "0" ]] || {
  echo "ownership migration must run as root" >&2
  exit 2
}

volume_root="$(realpath "$2")"
[[ ! -L "$4" ]] || {
  echo "rollback snapshot must not be a symlink" >&2
  exit 2
}
backup_root="$(realpath "$4")"
source_package="$(realpath "$6")"
receipt="$(realpath -m "$8")"
identity_receipt="$(realpath "${10}")"
[[ -d "$volume_root" && -d "$backup_root" && -d "$source_package" &&
   ! -L "$source_package" &&
   "$volume_root" != "/" && "$backup_root" != "/" &&
   "$receipt" != "/" && ! -e "$receipt" &&
   -f "$identity_receipt" && ! -L "$identity_receipt" ]] || usage
case "$receipt/" in "$volume_root/"*) echo "receipt must be outside the retained volume" >&2; exit 2 ;; esac
case "$receipt/" in "$backup_root/"*) echo "receipt must be outside the rollback snapshot" >&2; exit 2 ;; esac
backup_store_root="$(dirname -- "$backup_root")"
case "$source_package/" in "$volume_root/"*|"$backup_store_root/"*)
  echo "source package must be outside the volume and rollback storage" >&2
  exit 2
;; esac
case "$identity_receipt" in "$backup_store_root"/*|"$volume_root"/*)
  echo "rollback identity receipt must be independently stored outside backup storage and volume" >&2
  exit 2
;; esac

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null
if ! python3 "$script_root/with-volume-lock.py" --verify "$volume_root" 2>/dev/null; then
  unset ZAK_RADIO_VOLUME_ROOT_FD ZAK_RADIO_VOLUME_LOCK_FD
  exec python3 "$script_root/with-volume-lock.py" "$volume_root" -- "$0" "$@"
fi
locked_volume_root="/proc/self/fd/$ZAK_RADIO_VOLUME_ROOT_FD/."
command -v setpriv >/dev/null
command -v ln >/dev/null
command -v sqlite3 >/dev/null
command -v sha256sum >/dev/null
command -v go >/dev/null
command -v tar >/dev/null
command -v sync >/dev/null
install -d -m 0750 "$(dirname -- "$receipt")"
receipt_lock="${receipt}.lock"
mkdir -m 0700 "$receipt_lock" 2>/dev/null || {
  echo "another operation owns the ownership receipt path" >&2
  exit 1
}
trap 'rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
[[ ! -e "$receipt" ]] || {
  echo "refusing to overwrite ownership receipt: $receipt" >&2
  exit 1
}
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"; rmdir -- "$receipt_lock" 2>/dev/null || true' EXIT
install -d -m 0700 "$scratch/package"
source_release="$("$script_root/verify-release-package.sh" "$source_package")"
(
  cd "$source_package"
  tar --numeric-owner -cf - .
) | head -c $((600 * 1024 * 1024)) |
  tar --numeric-owner -xf - -C "$scratch/package"
sealed_package="$scratch/package"
sealed_release="$("$script_root/verify-release-package.sh" "$sealed_package")"
[[ "$sealed_release" == "$source_release" ]] || {
  echo "source package changed while it was being sealed" >&2
  exit 1
}
rollback_identity="$("$script_root/verify-snapshot.sh" --snapshot "$backup_root" \
  --release-package "$sealed_package" --identity-receipt "$identity_receipt")"
"$script_root/validate-volume.sh" --migration-source "$locked_volume_root"

(
  cd "$locked_volume_root"
  find . -type f ! -name '.zak-radio-volume.lock' -print0 | sort -z | xargs -0 sha256sum
) >"$scratch/before.sha256"
cmp "$backup_root/SHA256SUMS" "$scratch/before.sha256" || {
  echo "rollback snapshot does not match the pre-migration retained volume" >&2
  exit 1
}
(cd "$locked_volume_root" && find . ! -name '.zak-radio-volume.lock' \
  -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort) >"$scratch/live.owner-modes"
cmp "$scratch/live.owner-modes" "$backup_root/OWNER_MODES" || {
  echo "rollback snapshot did not preserve numeric ownership and modes" >&2
  exit 1
}

receipt_intent="$(mktemp "$(dirname -- "$receipt")/.zak-radio-ownership-intent.XXXXXX")"
{
  echo "status=intent"
  echo "started_at=$(date -u +%Y%m%dT%H%M%S.%NZ)"
  echo "volume=$volume_root"
  echo "uid=65532"
  echo "gid=65532"
  echo "rollback_snapshot=$backup_root"
  echo "rollback_snapshot_identity=$rollback_identity"
  echo "rollback_identity_receipt=$identity_receipt"
  echo "rollback_manifest_sha256=$(sha256sum "$backup_root/SHA256SUMS" | cut -d' ' -f1)"
  echo "source_package=$source_package"
  echo "source_release=$source_release"
} >"$receipt_intent"
chmod 0640 "$receipt_intent"
sync -f "$receipt_intent"
ln -- "$receipt_intent" "$receipt" || {
  echo "ownership receipt path was claimed concurrently" >&2
  exit 1
}
sync -f "$(dirname -- "$receipt")"
intent_identity="$(stat -c '%d:%i' "$receipt")"
rm -f -- "$receipt_intent"

"$script_root/provision-current-volume.sh" "$locked_volume_root"
if find "$locked_volume_root" \( ! -uid 65532 -o ! -gid 65532 \) -print -quit | grep -q .; then
  echo "retained-volume ownership migration was incomplete" >&2
  exit 1
fi

"$script_root/validate-volume.sh" --migration-source "$locked_volume_root"
(
  cd "$locked_volume_root"
  find . -type f ! -name '.zak-radio-volume.lock' -print0 | sort -z | xargs -0 sha256sum
) >"$scratch/after.sha256"
cmp "$scratch/before.sha256" "$scratch/after.sha256"
(
  cd "$locked_volume_root"
  find . ! -name '.zak-radio-volume.lock' -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort
) >"$scratch/after.owner-modes"
sync -f "$locked_volume_root"
[[ ! -L "$volume_root" &&
   "$(stat -Lc '%d:%i' "$volume_root")" == "$(stat -Lc '%d:%i' "$locked_volume_root")" ]] || {
  echo "retained volume pathname changed during ownership migration" >&2
  exit 1
}

receipt_staging="$(mktemp "$(dirname -- "$receipt")/.zak-radio-ownership.XXXXXX")"
{
  echo "status=complete"
  echo "completed_at=$(date -u +%Y%m%dT%H%M%S.%NZ)"
  echo "volume=$volume_root"
  echo "uid=65532"
  echo "gid=65532"
  echo "content_manifest_sha256=$(sha256sum "$scratch/after.sha256" | cut -d' ' -f1)"
  echo "candidate_owner_modes_sha256=$(sha256sum "$scratch/after.owner-modes" | cut -d' ' -f1)"
  echo "rollback_snapshot=$backup_root"
  echo "rollback_snapshot_identity=$rollback_identity"
  echo "rollback_identity_receipt=$identity_receipt"
  echo "rollback_manifest_sha256=$(sha256sum "$backup_root/SHA256SUMS" | cut -d' ' -f1)"
  echo "source_package=$source_package"
  echo "source_release=$source_release"
} >"$receipt_staging"
chmod 0640 "$receipt_staging"
sync -f "$receipt_staging"
[[ -f "$receipt" && ! -L "$receipt" &&
   "$(stat -c '%d:%i' "$receipt")" == "$intent_identity" ]] || {
  echo "ownership intent receipt changed during migration" >&2
  exit 1
}
mv -T "$receipt_staging" "$receipt"
sync -f "$(dirname -- "$receipt")"
rmdir -- "$receipt_lock"
echo "$receipt"
