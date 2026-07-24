#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 4 && "$1" == "--volume" && "$3" == "--receipt" ]] || {
  echo "usage: $0 --volume RETAINED_VOLUME --receipt OWNERSHIP_RECEIPT" >&2
  exit 2
}
volume_root="$(realpath "$2")"
receipt="$(realpath "$4")"
[[ -d "$volume_root" && -f "$receipt" && ! -L "$receipt" &&
   "$(stat -c '%s' "$receipt")" -le 16384 && "$volume_root" != "/" ]] || exit 2

status="$(sed -n 's/^status=//p' "$receipt")"
recorded_volume="$(sed -n 's/^volume=//p' "$receipt")"
recorded_manifest="$(sed -n 's/^content_manifest_sha256=//p' "$receipt")"
recorded_owner_modes="$(sed -n 's/^candidate_owner_modes_sha256=//p' "$receipt")"
rollback_snapshot="$(sed -n 's/^rollback_snapshot=//p' "$receipt")"
rollback_snapshot_identity="$(sed -n 's/^rollback_snapshot_identity=//p' "$receipt")"
rollback_identity_receipt="$(sed -n 's/^rollback_identity_receipt=//p' "$receipt")"
rollback_manifest="$(sed -n 's/^rollback_manifest_sha256=//p' "$receipt")"
source_package="$(sed -n 's/^source_package=//p' "$receipt")"
source_release="$(sed -n 's/^source_release=//p' "$receipt")"
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rollback_store_root="$(dirname -- "$rollback_snapshot")"
case "$source_package/" in "$rollback_store_root/"*|"$volume_root/"*)
  echo "source package is not independent of rollback storage and volume" >&2
  exit 1
;; esac
case "$rollback_identity_receipt" in "$rollback_store_root"/*|"$volume_root"/*)
  echo "rollback identity receipt is not independently stored" >&2
  exit 1
;; esac
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
install -d -m 0700 "$scratch/package"
(
  cd "$source_package"
  tar --numeric-owner -cf - .
) | head -c $((600 * 1024 * 1024)) |
  tar --numeric-owner -xf - -C "$scratch/package"
sealed_package="$scratch/package"
sealed_release="$("$script_root/verify-release-package.sh" "$sealed_package")"
[[ "$status" == "complete" && "$recorded_volume" == "$volume_root" &&
   "$recorded_manifest" =~ ^[0-9a-f]{64}$ &&
   "$recorded_owner_modes" =~ ^[0-9a-f]{64}$ &&
   -d "$rollback_snapshot" && ! -L "$rollback_snapshot" &&
   -d "$source_package" && ! -L "$source_package" &&
   "$source_release" == "$sealed_release" &&
   -f "$rollback_identity_receipt" && ! -L "$rollback_identity_receipt" &&
   "$rollback_snapshot_identity" == "$("$script_root/verify-snapshot.sh" \
     --snapshot "$rollback_snapshot" --release-package "$sealed_package" \
     --identity-receipt "$rollback_identity_receipt")" &&
   "$rollback_manifest" == "$(sha256sum "$rollback_snapshot/SHA256SUMS" | cut -d' ' -f1)" ]] || {
  echo "ownership receipt is incomplete or does not match its rollback snapshot" >&2
  exit 1
}
"$script_root/validate-volume.sh" "$volume_root"
actual_manifest="$(
  cd "$volume_root"
  find . -type f ! -name '.zak-radio-volume.lock' -print0 |
    sort -z | xargs -0 sha256sum |
    sha256sum | cut -d' ' -f1
)"
[[ "$actual_manifest" == "$recorded_manifest" ]] || {
  echo "ownership receipt does not match the candidate retained volume" >&2
  exit 1
}
actual_owner_modes="$(
  cd "$volume_root"
  find . ! -name '.zak-radio-volume.lock' \
    -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort |
    sha256sum | cut -d' ' -f1
)"
[[ "$actual_owner_modes" == "$recorded_owner_modes" ]] || {
  echo "ownership receipt does not match candidate owners and modes" >&2
  exit 1
}
if find "$volume_root" \( ! -uid 65532 -o ! -gid 65532 \) -print -quit | grep -q .; then
  echo "candidate retained volume is not owned by 65532:65532" >&2
  exit 1
fi
if find "$volume_root" -mindepth 1 \( -type l -o \( ! -type f ! -type d \) \) \
  -print -quit | grep -q .; then
  echo "candidate retained volume contains unsupported links or special files" >&2
  exit 1
fi
echo "ownership receipt verified"
