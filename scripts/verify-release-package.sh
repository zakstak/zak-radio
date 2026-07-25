#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 1 && ! -L "$1" ]] || {
  echo "usage: $0 RELEASE_PACKAGE_DIRECTORY" >&2
  exit 2
}
package_root="$(realpath "$1")"
[[ -d "$package_root" && "$package_root" != "/" ]] || exit 2
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_root/validate-volume-tree.sh" "$package_root"
for control in RELEASE PACKAGE.SHA256SUMS SOURCE.IDENTITY SCHEMA_VERSION \
  Dockerfile apphost.vnext.toml zak-radio.tar.gz .zak-radio-kiln-package; do
  [[ -f "$package_root/$control" && ! -L "$package_root/$control" ]] || {
    echo "release package control is missing or unsafe: $control" >&2
    exit 1
  }
done
if find "$package_root" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "release package contains unsupported links or special files" >&2
  exit 1
fi
entries="$(find "$package_root" -mindepth 1 -printf . | wc -c)"
bytes="$(find "$package_root" -type f -printf '%s\n' |
  awk '{ total += $1 } END { print total + 0 }')"
[[ "$entries" -le 10000 && "$bytes" -le $((512 * 1024 * 1024)) &&
  "$(stat -c '%s' "$package_root/PACKAGE.SHA256SUMS")" -le $((16 * 1024 * 1024)) &&
  "$(stat -c '%s' "$package_root/RELEASE")" -le 4096 ]] || {
  echo "release package exceeds its entry or byte budget" >&2
  exit 1
}
if find "$package_root" -type f -size +8388608c -print -quit | grep -q .; then
  echo "release package contains a file larger than Kiln's 8 MiB upload limit" >&2
  exit 1
fi
release="$(tr -d '\r\n' <"$package_root/RELEASE")"
[[ "$release" =~ ^[0-9a-f]{64}$ &&
  "$release" == "$(sha256sum "$package_root/SOURCE.IDENTITY" | cut -d' ' -f1)" ]] || {
  echo "release package identity is invalid" >&2
  exit 1
}
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
archive_listing="$(tar -tzf "$package_root/zak-radio.tar.gz")"
[[ "$archive_listing" == "zak-radio" ]] || {
  echo "release package executable archive has an unsafe inventory" >&2
  exit 1
}
mkdir "$scratch/executable"
tar -xzf "$package_root/zak-radio.tar.gz" -C "$scratch/executable"
[[ -f "$scratch/executable/zak-radio" && -x "$scratch/executable/zak-radio" ]] || {
  echo "release package executable archive is invalid" >&2
  exit 1
}
: >"$scratch/manifest-paths"
while IFS= read -r line; do
  [[ "$line" =~ ^[0-9a-f]{64}\ \ \./[^/].*$ ]] || {
    echo "release package manifest contains an invalid entry" >&2
    exit 1
  }
  package_path="${line:66}"
  [[ "$package_path" != /* && "$package_path" != *"/../"* &&
    "$package_path" != "../"* && "$package_path" != *"/./"* &&
    "$package_path" != *\\* && "$package_path" != *$'\n'* ]] || {
    echo "release package manifest path escapes or is not normalized" >&2
    exit 1
  }
  printf '%s\0' "$package_path" >>"$scratch/manifest-paths"
done <"$package_root/PACKAGE.SHA256SUMS"
cmp -s \
  <(cd "$package_root" && find . -type f ! -path './RELEASE' \
    ! -path './PACKAGE.SHA256SUMS' ! -path './.zak-radio-kiln-package' \
    -print0 | LC_ALL=C sort -z) \
  <(LC_ALL=C sort -z "$scratch/manifest-paths") || {
  echo "release package inventory does not match its manifest" >&2
  exit 1
}
(cd "$package_root" && sha256sum --check PACKAGE.SHA256SUMS >/dev/null)
printf '%s\n' "$release"
