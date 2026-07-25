#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--output DIRECTORY] [--goarch ARCH] [--timed-lyrics-root DIRECTORY] [--allowed-hosts HOSTS --allowed-origins ORIGINS --trusted-proxies NETWORKS --trusted-ingress NETWORKS]" >&2
  exit 2
}

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output=""
output_explicit=0
goarch="${ZAK_RADIO_KILN_GOARCH:-amd64}"
allowed_hosts="loopback"
allowed_origins="loopback"
trusted_proxies=""
trusted_ingress="*"
timed_lyrics_root=""
deployment_configured=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output)
      [[ "$#" -ge 2 ]] || usage
      output="$(realpath -m "$2")"
      output_explicit=1
      shift 2
      ;;
    --goarch)
      [[ "$#" -ge 2 ]] || usage
      goarch="$2"
      shift 2
      ;;
    --allowed-hosts)
      [[ "$#" -ge 2 ]] || usage
      allowed_hosts="$2"
      deployment_configured=1
      shift 2
      ;;
    --allowed-origins)
      [[ "$#" -ge 2 ]] || usage
      allowed_origins="$2"
      deployment_configured=1
      shift 2
      ;;
    --trusted-proxies)
      [[ "$#" -ge 2 ]] || usage
      trusted_proxies="$2"
      deployment_configured=1
      shift 2
      ;;
    --trusted-ingress)
      [[ "$#" -ge 2 ]] || usage
      trusted_ingress="$2"
      deployment_configured=1
      shift 2
      ;;
    --timed-lyrics-root)
      [[ "$#" -ge 2 ]] || usage
      timed_lyrics_root="$(realpath "$2")"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

if [[ -n "$timed_lyrics_root" ]]; then
  [[ -d "$timed_lyrics_root" && "$timed_lyrics_root" != "/" ]] || usage
  if find "$timed_lyrics_root" -mindepth 1 \
    \( -type l -o -type d -o \( ! -type f ! -type d \) -o \
    -type f ! -name '*.json' \) -print -quit | grep -q .; then
    echo "timed lyrics bundle must contain only flat regular JSON files" >&2
    exit 1
  fi
  while IFS= read -r name; do
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*[.]json$ ]] || {
      echo "timed lyrics bundle contains an unsafe track filename: $name" >&2
      exit 1
    }
  done < <(find "$timed_lyrics_root" -mindepth 1 -maxdepth 1 -type f -printf '%f\n')
fi

[[ "$goarch" =~ ^[a-z0-9]+$ ]] || usage
[[ "$allowed_hosts" =~ ^[A-Za-z0-9.,:_-]+$ ]] || usage
[[ "$allowed_origins" =~ ^[A-Za-z0-9.,:/_-]+$ ]] || usage
[[ -z "$trusted_proxies" || "$trusted_proxies" =~ ^[A-Fa-f0-9.,:/]+$ ]] || usage
[[ "$trusted_ingress" == "*" || "$trusted_ingress" =~ ^[A-Fa-f0-9.,:/]+$ ]] || usage

if [[ "$deployment_configured" == "1" ]] &&
  [[ "$allowed_hosts" == "loopback" || "$allowed_origins" == "loopback" ||
    -z "$trusted_proxies" || -z "$trusted_ingress" ]]; then
  echo "external packages require all four exact routing and ingress settings" >&2
  exit 2
fi

case ",$allowed_hosts," in
  *,loopback,*) ;;
  *) allowed_hosts="$allowed_hosts,loopback" ;;
esac
case ",$allowed_origins," in
  *,loopback,*) ;;
  *) allowed_origins="$allowed_origins,loopback" ;;
esac

if [[ "$output_explicit" == "1" ]]; then
  [[ "$output" != "/" && "$output" != "$repo_root" ]] || usage
  case "$output/" in
    "$repo_root/static/"*)
      echo "package output must not be inside public static assets" >&2
      exit 2
      ;;
  esac
fi

for source_dir in cmd internal static; do
  if find "$repo_root/$source_dir" -mindepth 1 \
    \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
    echo "$source_dir package inputs must contain only regular files and directories" >&2
    exit 1
  fi
done

scratch="$(mktemp -d)"
staging=""
cleanup() {
  rm -rf -- "$scratch"
  if [[ -n "$staging" && -d "$staging" ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup EXIT

source_identity="$scratch/SOURCE.IDENTITY"
(
  cd "$repo_root"
  {
    printf 'goos=linux\n'
    printf 'goarch=%s\n' "$goarch"
    printf 'allowed_hosts=%s\n' "$allowed_hosts"
    printf 'allowed_origins=%s\n' "$allowed_origins"
    printf 'trusted_proxies=%s\n' "$trusted_proxies"
    printf 'trusted_ingress=%s\n' "$trusted_ingress"
    if [[ -n "$timed_lyrics_root" ]]; then
      printf 'timed_lyrics=bundled\n'
      (
        cd "$timed_lyrics_root"
        find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
      )
    else
      printf 'timed_lyrics=none\n'
    fi
    {
      printf '%s\0' go.mod go.sum scripts/prepare-kiln-package.sh
      find cmd internal -type f ! -name '*_test.go' -print0
      find static -type f -print0
    } |
      LC_ALL=C sort -z |
      xargs -0 sha256sum
  }
) >"$source_identity"
release_id="$(sha256sum "$source_identity" | cut -d' ' -f1)"

package_root="$repo_root/.kiln-packages"
if [[ "$output_explicit" != "1" ]]; then
  output="$package_root/$release_id"
fi
staging_parent="$(dirname -- "$output")"
mkdir -p "$staging_parent"
staging="$(mktemp -d "$staging_parent/.zak-radio-kiln.XXXXXX")"

install -m 0644 "$source_identity" "$staging/SOURCE.IDENTITY"
schema_version="$(sed -n 's/^const currentSchemaVersion = //p' \
  "$repo_root/internal/application/migration_schema.go")"
[[ "$schema_version" =~ ^[0-9]+$ ]] || {
  echo "could not determine the application schema version" >&2
  exit 1
}
printf '%s\n' "$schema_version" >"$staging/SCHEMA_VERSION"

(
  cd "$repo_root"
  CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
    go build -mod=mod -trimpath \
    -ldflags="-s -w -X zak-radio/internal/application.releaseIdentity=$release_id" \
    -o "$scratch/zak-radio" ./cmd/zak-radio
)
chmod 0755 "$scratch/zak-radio"
tar --format=ustar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "$staging/zak-radio.tar.gz" -C "$scratch" zak-radio
chmod 0644 "$staging/zak-radio.tar.gz"

install -d -m 0755 "$staging/static"
rsync --archive --safe-links --exclude styles.tailwind.css \
  "$repo_root/static/" "$staging/static/"
find "$staging/static" -type d -exec chmod 0755 {} +
find "$staging/static" -type f -exec chmod 0644 {} +
install -d -m 0755 "$staging/timed-lyrics"
if [[ -n "$timed_lyrics_root" ]]; then
  rsync --archive --safe-links "$timed_lyrics_root/" "$staging/timed-lyrics/"
fi
find "$staging/timed-lyrics" -type f -exec chmod 0644 {} +

cat >"$staging/Dockerfile" <<EOF
FROM scratch

ADD zak-radio.tar.gz /
COPY static /static
COPY timed-lyrics /timed-lyrics

ENV ZAK_RADIO_METADATA_ROOT=/data/zak-radio \\
    ZAK_RADIO_ARCHIVE=/data/zak-radio/suno-organized-2026-06-27 \\
    ZAK_RADIO_DB=/data/zak-radio/station.sqlite3 \\
    ZAK_RADIO_READER_LIBRARY=/data/zak-radio/reader-library \\
    ZAK_RADIO_STATIC=/static \\
    ZAK_RADIO_TIMED_LYRICS=/timed-lyrics \\
    ZAK_RADIO_CLIENT_IPV6_PREFIX=64 \\
    ZAK_RADIO_DEFER_STARTUP_AUDIT=1 \\
    ZAK_RADIO_DROP_PRIVILEGES=0 \\
    ZAK_RADIO_ALLOW_ROOTLESS_CONTAINER=1

EXPOSE 8787
USER 0:0
ENTRYPOINT ["/zak-radio"]
CMD ["--host", "0.0.0.0", "--port", "8787", "--allowed-hosts", "$allowed_hosts", "--allowed-origins", "$allowed_origins", "--trusted-proxies", "$trusted_proxies", "--trusted-ingress", "$trusted_ingress"]
EOF
chmod 0644 "$staging/Dockerfile"

cat >"$staging/apphost.vnext.toml" <<'EOF'
schema = "apphost.vnext.manifest.v1"
name = "music"
shape = "web-service"
retention = "promoted"
owner = "saga"

[web-service]
context = "."
port = 8787
health-path = "/live"

[[volumes]]
mount-path = "/data/zak-radio"
retention = "retainOnDestroy"
backup-policy = "require"
shape = "directory"
size-limit-bytes = 10737418240
read-only = false
EOF
chmod 0644 "$staging/apphost.vnext.toml"

touch "$staging/.zak-radio-kiln-package"
printf '%s\n' "$release_id" >"$staging/RELEASE"
(
  cd "$staging"
  find . -type f \
    ! -path './.zak-radio-kiln-package' \
    ! -path './RELEASE' \
    ! -path './PACKAGE.SHA256SUMS' \
    -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum
) >"$staging/PACKAGE.SHA256SUMS"
chmod 0644 "$staging/RELEASE" "$staging/PACKAGE.SHA256SUMS"

if [[ -e "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || usage
  if find "$output" -mindepth 1 -print -quit | grep -q .; then
    [[ -f "$output/.zak-radio-kiln-package" ]] || {
      echo "refusing to replace non-generated package directory: $output" >&2
      exit 2
    }
    existing_release="$("$repo_root/scripts/verify-release-package.sh" "$output")"
    if [[ "$existing_release" == "$release_id" ]]; then
      echo "$output/apphost.vnext.toml"
      exit 0
    fi
    echo "refusing to replace immutable Kiln package: $output" >&2
    exit 2
  fi
  rmdir "$output"
fi

mv -T "$staging" "$output"
staging=""
echo "$output/apphost.vnext.toml"
