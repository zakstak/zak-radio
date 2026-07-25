#!/usr/bin/env bash
set -euo pipefail

validation_flag="--validate-volume"
if [[ "$#" == 2 && "$1" == "--migration-source" ]]; then
  validation_flag="--validate-migration-source-volume"
  shift
fi
[[ "$#" == 1 ]] || {
  echo "usage: $0 [--migration-source] RETAINED_VOLUME" >&2
  exit 2
}

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
script_root="$repo_root/scripts"
case "$1" in
  /proc/self/fd/[0-9]*/. | /dev/fd/[0-9]*/.) volume_root="$1" ;;
  *) volume_root="$(realpath "$1")" ;;
esac
[[ -d "$volume_root" && "$volume_root" != "/" ]] || {
  echo "invalid retained volume root" >&2
  exit 2
}

"$script_root/validate-volume-tree.sh" "$volume_root"

for sqlite_sidecar in station.sqlite3-wal station.sqlite3-shm; do
  if [[ -s "$volume_root/$sqlite_sidecar" ]]; then
    echo "retained volume contains a non-empty SQLite sidecar: $sqlite_sidecar" >&2
    exit 1
  fi
done

go run "$repo_root/cmd/zak-radio" "$validation_flag" "$volume_root" >/dev/null
