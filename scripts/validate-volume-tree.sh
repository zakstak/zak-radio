#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 1 && ! -L "$1" ]] || {
  echo "usage: $0 RETAINED_VOLUME" >&2
  exit 2
}
case "$1" in
  /proc/self/fd/[0-9]*/. | /dev/fd/[0-9]*/.) volume_root="$1" ;;
  *) volume_root="$(realpath "$1")" ;;
esac
[[ -d "$volume_root" && "$volume_root" != "/" ]] || exit 2
command -v mountpoint >/dev/null || {
  echo "retained-volume validation requires mountpoint from util-linux" >&2
  exit 2
}
if find "$volume_root" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "retained volume contains unsupported links or special files" >&2
  exit 1
fi
while IFS= read -r -d '' retained_path; do
  [[ "$retained_path" != *\\* && "$retained_path" != *$'\n'* ]] || {
    echo "retained volume contains an unsupported filename" >&2
    exit 1
  }
done < <(find "$volume_root" -mindepth 1 -print0)
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_root/check-retained-budget.sh" "$volume_root"
if find "$volume_root" -type f -links +1 -print -quit | grep -q .; then
  echo "retained volume contains a hard-linked regular file" >&2
  exit 1
fi
root_device="$(stat -c '%d' "$volume_root")"
while IFS= read -r -d '' retained_path; do
  [[ "$(stat -c '%d' "$retained_path")" == "$root_device" ]] || {
    echo "retained volume crosses a filesystem device boundary" >&2
    exit 1
  }
  if mountpoint -q "$retained_path"; then
    echo "retained volume contains a nested mountpoint" >&2
    exit 1
  fi
done < <(find "$volume_root" -mindepth 1 -print0)
