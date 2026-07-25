#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: ZAK_RADIO_SOURCE_QUIESCED=1 $0 --source DATA_EXPORT --target EMPTY_VOLUME" >&2
  exit 2
}

[[ "${ZAK_RADIO_SOURCE_QUIESCED:-}" == "1" ]] || {
  echo "refusing import: set ZAK_RADIO_SOURCE_QUIESCED=1 only for a stopped service or immutable snapshot" >&2
  exit 2
}
[[ "$#" == 4 && "$1" == "--source" && "$3" == "--target" ]] || usage
source_root="$(realpath "$2")"
target_root="$(realpath -m "$4")"
[[ -d "$source_root" && "$source_root" != "/" && "$target_root" != "/" ]] || usage
case "$target_root/" in "$source_root/"*)
  echo "target must not be inside source export" >&2
  exit 2
  ;;
esac
case "$source_root/" in "$target_root/"*)
  echo "source export must not be inside target" >&2
  exit 2
  ;;
esac
[[ "$(id -u)" == "0" ]] || {
  echo "bootstrap must run as root so the Kiln runtime UID/GID can be provisioned" >&2
  exit 2
}
command -v realpath >/dev/null
command -v rsync >/dev/null
command -v sqlite3 >/dev/null
command -v setpriv >/dev/null
command -v sha256sum >/dev/null
command -v tar >/dev/null
command -v sync >/dev/null
command -v du >/dev/null
command -v df >/dev/null
command -v flock >/dev/null
tar --version | grep -F 'GNU tar' >/dev/null || {
  echo "bootstrap requires GNU tar for bounded sparse-file handling" >&2
  exit 2
}
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null
if ! python3 "$script_root/with-volume-lock.py" --verify "$source_root" 2>/dev/null; then
  unset ZAK_RADIO_VOLUME_ROOT_FD ZAK_RADIO_VOLUME_LOCK_FD
  exec python3 "$script_root/with-volume-lock.py" "$source_root" -- "$0" "$@"
fi
locked_source_root="/proc/self/fd/$ZAK_RADIO_VOLUME_ROOT_FD/."
"$script_root/validate-volume.sh" --migration-source "$locked_source_root"
if [[ -e "$target_root" && ! -d "$target_root" ]]; then
  echo "refusing import: target is not a directory: $target_root" >&2
  exit 2
fi
if [[ -d "$target_root" ]] &&
  find "$target_root" -mindepth 1 -print -quit | grep -q .; then
  echo "refusing import: target volume is not empty: $target_root" >&2
  exit 2
fi
target_preflight_identity=""
if [[ -d "$target_root" ]]; then
  target_preflight_identity="$(stat -Lc '%d:%i' "$target_root")"
fi
allocated_bytes="$(du -B1 -s "$locked_source_root" | awk '{print $1}')"
[[ "$allocated_bytes" =~ ^[0-9]+$ ]] || {
  echo "could not determine source allocation" >&2
  exit 1
}
target_anchor="$target_root"
while [[ ! -e "$target_anchor" ]]; do
  target_anchor="$(dirname -- "$target_anchor")"
done
target_available="$(df -B1 --output=avail "$target_anchor" | tail -n 1 | tr -d ' ')"
[[ "$target_available" =~ ^[0-9]+$ ]] || {
  echo "could not determine target free space" >&2
  exit 1
}
required_bytes=$((allocated_bytes + 128 * 1024 * 1024))
((target_available >= required_bytes)) || {
  echo "bootstrap requires $required_bytes free bytes; $target_available available" >&2
  exit 1
}
target_parent="$(dirname -- "$target_root")"
target_name="$(basename -- "$target_root")"
[[ -d "$target_parent" && ! -L "$target_parent" ]] || {
  echo "bootstrap requires an existing, unsymlinked direct target parent" >&2
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
  echo "bootstrap target parent must be stable, trusted, and not group/world writable" >&2
  exit 1
}
target_guard="$pinned_parent/.${target_name}.zak-radio-target.lock"
mkdir -m 0700 -- "$target_guard" 2>/dev/null || {
  echo "another operation owns the bootstrap target" >&2
  exit 1
}
trap 'rmdir -- "$target_guard" 2>/dev/null || true' EXIT

if [[ -n "$target_preflight_identity" ]]; then
  [[ ! -L "$target_root" &&
    "$(stat -Lc '%d:%i' "$target_root")" == "$target_preflight_identity" ]] || {
    echo "bootstrap target changed after preflight" >&2
    exit 1
  }
else
  mkdir -m 0750 -- "$pinned_parent/$target_name" || {
    echo "bootstrap target was created concurrently" >&2
    exit 1
  }
fi
exec {target_fd}<"$pinned_parent/$target_name"
pinned_target="/proc/self/fd/$target_fd/."
target_identity="$(stat -Lc '%d:%i' "$pinned_target")"
[[ "$(stat -Lc '%d:%i' "$target_root")" == "$target_identity" ]] || {
  echo "bootstrap target changed while it was being pinned" >&2
  exit 1
}
exec {target_lock_fd}>"$pinned_target/.zak-radio-volume.lock"
flock -n -x "$target_lock_fd" || {
  echo "bootstrap target became active during installation" >&2
  exit 1
}
export ZAK_RADIO_VOLUME_ROOT_FD="$target_fd"
export ZAK_RADIO_VOLUME_LOCK_FD="$target_lock_fd"
(
  cd "$locked_source_root"
  tar --sparse --numeric-owner --exclude='./.zak-radio-volume.lock' -cf - .
) | head -c $((11 * 1024 * 1024 * 1024)) |
  tar --sparse --numeric-owner -xf - -C "$pinned_target"
"$script_root/validate-volume-tree.sh" "$pinned_target"
"$script_root/provision-current-volume.sh" "$pinned_target"
if find -H "$pinned_target" \( ! -uid 65532 -o ! -gid 65532 \) -print -quit | grep -q .; then
  echo "target volume ownership provisioning failed" >&2
  exit 1
fi
"$script_root/validate-volume.sh" --migration-source "$pinned_target"
sync -f "$pinned_target"
[[ ! -L "$target_root" &&
  "$(stat -Lc '%d:%i' "$target_root")" == "$target_identity" ]] || {
  echo "bootstrap target pathname changed during installation" >&2
  exit 1
}
rmdir -- "$target_guard"
trap - EXIT
echo "bootstrapped $target_root from the quiesced export at $source_root"
