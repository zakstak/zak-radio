#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [--output DIRECTORY] [--allowed-hosts HOSTS --allowed-origins ORIGINS --trusted-proxies NETWORKS --trusted-ingress NETWORKS]" >&2
  exit 2
}

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output=""
output_explicit=0
allowed_hosts="loopback"
allowed_origins="loopback"
trusted_proxies=""
trusted_ingress=""
deployment_configured=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output) [[ "$#" -ge 2 ]] || usage; output="$(realpath -m "$2")"; output_explicit=1; shift 2 ;;
    --allowed-hosts) [[ "$#" -ge 2 ]] || usage; allowed_hosts="$2"; deployment_configured=1; shift 2 ;;
    --allowed-origins) [[ "$#" -ge 2 ]] || usage; allowed_origins="$2"; deployment_configured=1; shift 2 ;;
    --trusted-proxies) [[ "$#" -ge 2 ]] || usage; trusted_proxies="$2"; deployment_configured=1; shift 2 ;;
    --trusted-ingress) [[ "$#" -ge 2 ]] || usage; trusted_ingress="$2"; deployment_configured=1; shift 2 ;;
    *) usage ;;
  esac
done
if [[ "$deployment_configured" == "1" ]] &&
   [[ "$allowed_hosts" == "loopback" || "$allowed_origins" == "loopback" ||
      -z "$trusted_proxies" || -z "$trusted_ingress" ]]; then
  echo "external packages require all four exact routing and ingress settings" >&2
  exit 2
fi
[[ "$allowed_hosts" =~ ^[A-Za-z0-9.,:_-]+$ ]] || usage
[[ "$allowed_origins" =~ ^[A-Za-z0-9.,:/_-]+$ ]] || usage
[[ -z "$trusted_proxies" || "$trusted_proxies" =~ ^[A-Fa-f0-9.,:/]+$ ]] || usage
[[ -z "$trusted_ingress" || "$trusted_ingress" =~ ^[A-Fa-f0-9.,:/]+$ ]] || usage
if [[ "$output_explicit" == "1" ]]; then
  [[ "$output" != "/" && "$output" != "$repo_root" ]] || usage
  case "$output/" in
    "$repo_root/static/"*) echo "package output must not be inside public static assets" >&2; exit 2 ;;
  esac
fi
case ",$allowed_hosts," in
  *,loopback,*) ;;
  *) allowed_hosts="$allowed_hosts,loopback" ;;
esac
case ",$allowed_origins," in
  *,loopback,*) ;;
  *) allowed_origins="$allowed_origins,loopback" ;;
esac
if find "$repo_root/static" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "static package inputs must contain only regular files and directories" >&2
  exit 1
fi

package_root="$repo_root/.apphost-packages"
staging_parent="$package_root"
if [[ "$output_explicit" == "1" ]]; then
  staging_parent="$(dirname -- "$output")"
fi
mkdir -p "$staging_parent"
staging="$(mktemp -d "$staging_parent/.zak-radio-apphost.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT

for file in .dockerignore Dockerfile apphost.vnext.toml go.mod go.sum package.json package-lock.json; do
  [[ -f "$repo_root/$file" && ! -L "$repo_root/$file" ]] || {
    echo "package input is not a regular file: $file" >&2
    exit 1
  }
  install -m 0640 "$repo_root/$file" "$staging/$file"
done
sed -i 's/^context = ".apphost-package"$/context = "."/' "$staging/apphost.vnext.toml"
[[ -d "$repo_root/cmd" ]] || {
  echo "Go command packages are missing" >&2
  exit 1
}
if find "$repo_root/cmd" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "Go command package inputs must contain only regular files and directories" >&2
  exit 1
fi
install -d -m 0750 "$staging/cmd"
rsync --archive "$repo_root/cmd/" "$staging/cmd/"
find "$staging/cmd" -type d -exec chmod 0755 {} +
find "$staging/cmd" -type f -exec chmod 0644 {} +
[[ -d "$repo_root/internal" ]] || {
  echo "internal Go packages are missing" >&2
  exit 1
}
if find "$repo_root/internal" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "internal Go package inputs must contain only regular files and directories" >&2
  exit 1
fi
install -d -m 0750 "$staging/internal"
rsync --archive "$repo_root/internal/" "$staging/internal/"
find "$staging/internal" -type d -exec chmod 0755 {} +
find "$staging/internal" -type f -exec chmod 0644 {} +
cat >"$staging/internal/application/sealed_routing_generated.go" <<EOF
package application

func init() {
	packagedRoutingSealed = true
	packagedAllowedHosts = "$allowed_hosts"
	packagedAllowedOrigins = "$allowed_origins"
	packagedTrustedProxies = "$trusted_proxies"
	packagedTrustedIngress = "$trusted_ingress"
}
EOF
[[ -d "$repo_root/vendor" ]] || {
  echo "offline package requires a generated Go vendor tree" >&2
  exit 1
}
if find "$repo_root/vendor" -mindepth 1 \
  \( -type l -o \( ! -type f ! -type d \) \) -print -quit | grep -q .; then
  echo "Go vendor inputs must contain only regular files and directories" >&2
  exit 1
fi
install -d -m 0750 "$staging/vendor"
rsync --archive "$repo_root/vendor/" "$staging/vendor/"
find "$staging/vendor" -type d -exec chmod 0755 {} +
find "$staging/vendor" -type f -exec chmod 0644 {} +
install -d -m 0750 "$staging/static"
rsync --archive --safe-links "$repo_root/static/" "$staging/static/"
find "$staging/static" -type d -exec chmod 0755 {} +
find "$staging/static" -type f -exec chmod 0644 {} +
touch "$staging/.zak-radio-apphost-package"
(
  cd "$staging"
  find . -type f \
    ! -path './.zak-radio-apphost-package' \
    ! -path './RELEASE' \
    ! -path './PACKAGE.SHA256SUMS' \
    -print0 |
    LC_ALL=C sort -z |
    xargs -0 sha256sum
) >"$staging/PACKAGE.SHA256SUMS"
release_id="$(sha256sum "$staging/PACKAGE.SHA256SUMS" | cut -d' ' -f1)"
printf '%s\n' "$release_id" >"$staging/RELEASE"
chmod 0640 "$staging/RELEASE" "$staging/PACKAGE.SHA256SUMS"

if [[ "$output_explicit" != "1" ]]; then
  output="$package_root/$release_id"
fi
parent="$(dirname -- "$output")"
mkdir -p "$parent"
if [[ -e "$output" ]]; then
  [[ -d "$output" && ! -L "$output" ]] || usage
  if find "$output" -mindepth 1 -print -quit | grep -q .; then
    [[ -f "$output/.zak-radio-apphost-package" ]] || {
      echo "refusing to replace non-generated package directory: $output" >&2
      exit 2
    }
    existing_release="$("$repo_root/scripts/verify-release-package.sh" "$output")"
    if [[ "$existing_release" == "$release_id" ]]; then
      rm -rf -- "$staging"
      trap - EXIT
      echo "$output/apphost.vnext.toml"
      exit 0
    fi
    {
      echo "refusing to replace immutable release package: $output"
      echo "choose a new --output directory or use the versioned default"
    } >&2
    exit 2
  else
    rmdir "$output"
  fi
fi
if [[ "$staging_parent" != "$parent" ]]; then
  final_staging="$(mktemp -d "$parent/.zak-radio-apphost.XXXXXX")"
  rmdir "$final_staging"
  mv -T "$staging" "$final_staging"
  staging="$final_staging"
fi
mv -T "$staging" "$output"
trap - EXIT
echo "$output/apphost.vnext.toml"
