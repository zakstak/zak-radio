#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 1 && -d "$1" && ! -L "$1" ]] || {
  echo "usage: $0 RETAINED_VOLUME" >&2
  exit 2
}

case "$1" in
  /proc/self/fd/[0-9]*/.|/dev/fd/[0-9]*/.) volume_root="$1" ;;
  *) volume_root="$(realpath "$1")" ;;
esac
entries="$(find "$volume_root" -mindepth 1 -printf . | wc -c)"
product_bytes=0
backup_bytes=0
while IFS= read -r -d '' size && IFS= read -r -d '' base; do
  if [[ "$base" =~ ^.+\.schema-v[0-9]+-[0-9a-f]{64}\.bak$ ||
        "$base" =~ ^.+\.migration-v[0-9]+\.backup-receipt$ ]]; then
    backup_bytes=$((backup_bytes + size))
  else
    product_bytes=$((product_bytes + size))
  fi
done < <(find "$volume_root" -type f -printf '%s\0%f\0')

product_limit=$((9 * 1024 * 1024 * 1024))
backup_limit=$((1 * 1024 * 1024 * 1024))
total_limit=$((product_limit + backup_limit))
total_bytes=$((product_bytes + backup_bytes))
[[ "$entries" -le 100000 &&
   "$product_bytes" -le "$product_limit" &&
   "$backup_bytes" -le "$backup_limit" &&
   "$total_bytes" -le "$total_limit" ]] || {
  echo "retained volume exceeds its entry, product, backup, or total apparent-byte budget" >&2
  exit 1
}
