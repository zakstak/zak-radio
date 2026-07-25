#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 1 ]] || {
  echo "usage: $0 RETAINED_VOLUME" >&2
  exit 2
}
[[ "$(id -u)" == "0" ]] || {
  echo "current-runtime provisioning must run as root" >&2
  exit 2
}
volume_root="$(realpath "$1")"
[[ -d "$volume_root" && "$volume_root" != "/" &&
  -f "$volume_root/station.sqlite3" ]] || {
  echo "invalid retained volume" >&2
  exit 2
}
command -v setpriv >/dev/null
command -v sqlite3 >/dev/null
command -v python3 >/dev/null
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! python3 "$script_root/with-volume-lock.py" --verify "$volume_root" 2>/dev/null; then
  unset ZAK_RADIO_VOLUME_ROOT_FD ZAK_RADIO_VOLUME_LOCK_FD
  exec python3 "$script_root/with-volume-lock.py" "$volume_root" -- "$0" "$@"
fi
volume_fd="$ZAK_RADIO_VOLUME_ROOT_FD"
pinned_root="/proc/self/fd/$volume_fd/."
preflight_identity="$(stat -Lc '%d:%i' "$pinned_root")"
"$script_root/validate-volume-tree.sh" "$pinned_root"
volume_identity="$(stat -Lc '%d:%i' "$pinned_root")"
[[ "$volume_identity" == "$preflight_identity" &&
  "$(stat -Lc '%d:%i' "$volume_root")" == "$volume_identity" ]] || {
  echo "retained volume changed while it was being pinned" >&2
  exit 1
}

chown -R 65532:65532 "$pinned_root"
find -H "$pinned_root" -type d -exec chmod 0750 {} +
find -H "$pinned_root" -type f -exec chmod 0640 {} +

database_identity="$(stat -Lc '%d:%i' "$pinned_root/station.sqlite3")"
# The nested shell receives its volume path as literal $1.
# shellcheck disable=SC2016
setpriv --reuid=65532 --regid=65532 --clear-groups \
  sh -c '
    probe="$1/.zak-radio-runtime-probe"
    : >"$probe"
    rm -f -- "$probe"
    [[ ! -L "$1/station.sqlite3" ]] || exit 1
    sqlite3 "$1/station.sqlite3" \
      "begin immediate; update stations set revision=revision where id='\''main'\''; rollback;"
    sqlite3 "$1/station.sqlite3" "pragma wal_checkpoint(truncate);" >/dev/null
  ' bash "$pinned_root"
[[ ! -L "$pinned_root/station.sqlite3" &&
  "$(stat -Lc '%d:%i' "$pinned_root/station.sqlite3")" == "$database_identity" ]] || {
  echo "retained database changed during unprivileged SQLite preflight" >&2
  exit 1
}
for sidecar in "$pinned_root/station.sqlite3-wal" "$pinned_root/station.sqlite3-shm"; do
  [[ ! -e "$sidecar" || ! -s "$sidecar" ]] || {
    echo "runtime preflight left a non-empty SQLite sidecar" >&2
    exit 1
  }
  rm -f -- "$sidecar"
done
[[ ! -L "$volume_root" &&
  "$(stat -Lc '%d:%i' "$volume_root")" == "$volume_identity" ]] || {
  echo "retained volume pathname changed during provisioning" >&2
  exit 1
}
