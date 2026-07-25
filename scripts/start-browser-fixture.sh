#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
browser_port="${ZAK_RADIO_BROWSER_PORT:-28799}"
[[ "$browser_port" =~ ^[0-9]+$ &&
  "$browser_port" -ge 1024 && "$browser_port" -le 65535 ]] || {
  echo "ZAK_RADIO_BROWSER_PORT must be an integer from 1024 to 65535" >&2
  exit 2
}
fixture_root="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT INT TERM

archive="$fixture_root/archive"
mkdir -p "$archive/tracks/alpha" "$fixture_root/reader-library"
cp -- "$repo_root/tests/fixtures/tone.mp3" "$archive/tracks/alpha/audio.mp3"
audio_sha="$(sha256sum "$archive/tracks/alpha/audio.mp3" | cut -d' ' -f1)"
cat >"$archive/index.json" <<EOF
{"tracks":[{"id":"alpha","title":"Alpha Sunrise","artist":"Signal Garden","source":"fixture","created_at":"2026-07-01","batch_index":1,"duration":1.5,"play_count":1,"organized_dir":"tracks/alpha","audio_sha256":"$audio_sha"}]}
EOF
cat >"$fixture_root/curated-tracks.json" <<'EOF'
{"tracks":{"alpha":{"title":"Alpha Sunrise","artist":"Signal Garden","summary":"Browser behavior fixture."}}}
EOF

go build -trimpath -o "$fixture_root/zak-radio" "$repo_root/cmd/zak-radio"
ZAK_RADIO_METADATA_ROOT="$fixture_root" \
  ZAK_RADIO_ARCHIVE="$archive" \
  ZAK_RADIO_DB="$fixture_root/station.sqlite3" \
  ZAK_RADIO_READER_LIBRARY="$fixture_root/reader-library" \
  ZAK_RADIO_STATIC_DIR="$repo_root/static" \
  ZAK_RADIO_ALLOWED_HOSTS=loopback \
  ZAK_RADIO_ALLOWED_ORIGINS=loopback \
  ZAK_RADIO_TRUSTED_PROXIES='' \
  ZAK_RADIO_TRUSTED_INGRESS='' \
  "$fixture_root/zak-radio" --host 127.0.0.1 --port "$browser_port" &
server_pid="$!"
wait "$server_pid"
