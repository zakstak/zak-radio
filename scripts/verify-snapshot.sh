#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --snapshot SNAPSHOT_DIRECTORY [--release-package PACKAGE_DIRECTORY] [--identity-receipt EXTERNAL_RECEIPT]" >&2
  exit 2
}

[[ "$#" -ge 2 && "$1" == "--snapshot" ]] || usage
[[ ! -L "$2" ]] || {
  echo "snapshot root must not be a symlink" >&2
  exit 1
}
snapshot="$(realpath "$2")"
release_package=""
identity_receipt=""
shift 2
while [[ "$#" -gt 0 ]]; do
  [[ "$#" -ge 2 ]] || usage
  case "$1" in
    --release-package)
      [[ -z "$release_package" && ! -L "$2" ]] || usage
      release_package="$(realpath "$2")"
      ;;
    --identity-receipt)
      [[ -z "$identity_receipt" && ! -L "$2" ]] || usage
      identity_receipt="$(realpath "$2")"
      ;;
    *) usage ;;
  esac
  shift 2
done
[[ "$snapshot" != "/" && -d "$snapshot" ]] || usage
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v sqlite3 >/dev/null || {
  echo "snapshot verification requires sqlite3" >&2
  exit 2
}
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
release_file=""
if [[ -n "$release_package" ]]; then
  command -v go >/dev/null || {
    echo "release-bound snapshot verification requires Go" >&2
    exit 2
  }
  [[ -d "$release_package" && ! -L "$release_package" ]] || usage
  case "$release_package/" in "$snapshot/"*)
    echo "release package must be outside the snapshot" >&2
    exit 1
  ;; esac
  original_release="$("$script_root/verify-release-package.sh" "$release_package")"
  install -d -m 0700 "$scratch/package"
  (
    cd "$release_package"
    tar --numeric-owner -cf - .
  ) | head -c $((600 * 1024 * 1024)) |
    tar --numeric-owner -xf - -C "$scratch/package"
  release_package="$scratch/package"
  sealed_release="$("$script_root/verify-release-package.sh" "$release_package")"
  [[ "$sealed_release" == "$original_release" ]] || {
    echo "release package changed while it was being sealed" >&2
    exit 1
  }
  release_file="$release_package/RELEASE"
fi
if [[ -n "$identity_receipt" ]]; then
  [[ -f "$identity_receipt" && ! -L "$identity_receipt" &&
     "$(stat -c '%s' "$identity_receipt")" -le 4096 ]] || usage
  case "$identity_receipt" in "$snapshot"/*)
    echo "identity receipt must be outside the snapshot" >&2
    exit 1
  ;; esac
fi
for required in "$snapshot" "$snapshot/volume" "$snapshot/RECEIPT" \
  "$snapshot/SHA256SUMS" "$snapshot/OWNER_MODES"; do
  [[ ! -L "$required" ]] || {
    echo "snapshot control paths must not be symlinks" >&2
    exit 1
  }
done
[[ -d "$snapshot/volume" && -f "$snapshot/RECEIPT" &&
   -f "$snapshot/SHA256SUMS" && -f "$snapshot/OWNER_MODES" ]] || usage
if find "$snapshot" -maxdepth 1 -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "snapshot contains unsupported control links or special files" >&2
  exit 1
fi
[[ "$(find "$snapshot" -maxdepth 1 -mindepth 1 -printf . | wc -c)" == "4" ]] || {
  echo "snapshot top-level inventory is not canonical" >&2
  exit 1
}
for control in RECEIPT SHA256SUMS OWNER_MODES; do
  size="$(stat -c '%s' "$snapshot/$control")"
  case "$control" in
    RECEIPT) maximum=4096 ;;
    *) maximum=$((16 * 1024 * 1024)) ;;
  esac
  [[ "$size" -le "$maximum" ]] || {
    echo "snapshot control file $control exceeds its size budget" >&2
    exit 1
  }
done
"$script_root/check-retained-budget.sh" "$snapshot/volume"
"$script_root/validate-volume-tree.sh" "$snapshot/volume"
[[ "$(wc -l <"$snapshot/SHA256SUMS")" -le 100000 &&
   "$(wc -l <"$snapshot/OWNER_MODES")" -le 100001 ]] || {
  echo "snapshot control manifests exceed their line budget" >&2
  exit 1
}

: >"$scratch/manifest-paths"
while IFS= read -r line; do
  [[ "$line" =~ ^[0-9a-f]{64}\ \ \./[^/].*$ ]] || {
    echo "snapshot checksum manifest contains an invalid entry" >&2
    exit 1
  }
  path="${line:66}"
  [[ "$path" != /* && "$path" != *"/../"* && "$path" != "../"* &&
     "$path" != *"/./"* && "$path" != *\\* ]] || {
    echo "snapshot checksum path escapes or is not normalized" >&2
    exit 1
  }
  printf '%s\0' "$path" >>"$scratch/manifest-paths"
done <"$snapshot/SHA256SUMS"
cmp -s \
  <(cd "$snapshot/volume" && find . -type f -print0 | LC_ALL=C sort -z) \
  <(LC_ALL=C sort -z "$scratch/manifest-paths") || {
  echo "snapshot checksum manifest does not cover every regular file" >&2
  exit 1
}
(cd "$snapshot/volume" && sha256sum --check "$snapshot/SHA256SUMS" >/dev/null)
(cd "$snapshot/volume" && find . -printf '%P\t%U:%G\t%m\n' | LC_ALL=C sort) \
  >"$scratch/actual-owner-modes"
cmp "$snapshot/OWNER_MODES" "$scratch/actual-owner-modes" >/dev/null || {
  echo "snapshot owner/mode manifest does not match the retained volume" >&2
  exit 1
}

created="$(sed -n 's/^created_at=//p' "$snapshot/RECEIPT")"
schema="$(sed -n 's/^schema_version=//p' "$snapshot/RECEIPT")"
source_release="$(sed -n 's/^source_release=//p' "$snapshot/RECEIPT")"
identity="$(sed -n 's/^snapshot_identity=//p' "$snapshot/RECEIPT")"
[[ "$created" =~ ^[0-9]{8}T[0-9]{6}\.[0-9]{9}Z$ &&
   "$schema" =~ ^[0-9]+$ && "$source_release" =~ ^[0-9a-f]{64}$ &&
   "$identity" =~ ^[0-9a-f]{64}$ ]] || {
  echo "snapshot receipt is incomplete" >&2
  exit 1
}
database_schema="$(
  sqlite3 "file:$snapshot/volume/station.sqlite3?immutable=1" 'pragma user_version;'
)"
[[ "$database_schema" == "$schema" ]] || {
  echo "snapshot receipt schema $schema does not match retained database schema $database_schema" >&2
  exit 1
}
computed="$(
  {
    cat "$snapshot/SHA256SUMS"
    cat "$snapshot/OWNER_MODES"
    printf 'created_at=%s\nschema_version=%s\nsource_release=%s\n' \
      "$created" "$schema" "$source_release"
  } | sha256sum | cut -d' ' -f1
)"
[[ "$computed" == "$identity" ]] || {
  echo "snapshot identity does not match contents, owners, modes, and release" >&2
  exit 1
}
if [[ -n "$release_package" ]]; then
  expected="$(tr -d '\r\n' <"$release_file")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$expected" == "$source_release" ]] || {
    echo "snapshot source release does not match the expected package" >&2
    exit 1
  }
fi
if [[ -n "$identity_receipt" ]]; then
  recorded_identity="$(sed -n 's/^snapshot_identity=//p' "$identity_receipt")"
  recorded_release="$(sed -n 's/^source_release=//p' "$identity_receipt")"
  recorded_manifest="$(sed -n 's/^snapshot_manifest_sha256=//p' "$identity_receipt")"
  recorded_modes="$(sed -n 's/^snapshot_owner_modes_sha256=//p' "$identity_receipt")"
  [[ "$recorded_identity" == "$identity" &&
     "$recorded_release" == "$source_release" &&
     "$recorded_manifest" == "$(sha256sum "$snapshot/SHA256SUMS" | cut -d' ' -f1)" &&
     "$recorded_modes" == "$(sha256sum "$snapshot/OWNER_MODES" | cut -d' ' -f1)" ]] || {
    echo "snapshot does not match its independently retained identity receipt" >&2
    exit 1
  }
fi
if [[ -n "$release_package" ]]; then
  package_schema="$(
    sed -n 's/^const currentSchemaVersion = //p' \
      "$release_package/internal/application/migration_schema.go"
  )"
  [[ "$package_schema" =~ ^[0-9]+$ && "$schema" == "$package_schema" ]] || {
    echo "snapshot schema does not match the verified release package" >&2
    exit 1
  }
  "$script_root/validate-volume.sh" --migration-source "$snapshot/volume"
else
  trusted_current_schema="$(
    sed -n 's/^const currentSchemaVersion = //p' \
      "$script_root/../internal/application/migration_schema.go"
  )"
  [[ "$trusted_current_schema" =~ ^[0-9]+$ ]] || {
    echo "trusted validator schema could not be determined" >&2
    exit 1
  }
  if [[ "$schema" == "$trusted_current_schema" ]]; then
    "$script_root/validate-volume.sh" "$snapshot/volume"
  else
    "$script_root/validate-volume.sh" --migration-source "$snapshot/volume"
  fi
fi
printf '%s\n' "$identity"
