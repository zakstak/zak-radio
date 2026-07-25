#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch_dir="$(mktemp -d)"
runtime_containers=()
ops_image=""
review_user_id="$(id -u)"
review_group_id="$(id -g)"
cleanup() {
  local container
  for container in "${runtime_containers[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  if [[ -n "$ops_image" && -d "$scratch_dir/runtime-volume" ]]; then
    docker run --rm --user 0:0 \
      --mount "type=bind,source=$scratch_dir/runtime-volume,target=/volume" \
      "$ops_image" \
      chown -R "$review_user_id:$review_group_id" /volume >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch_dir"
}
trap cleanup EXIT

cd "$repo_root"

echo "==> formatting"
unformatted="$(
  gofmt -l . |
    while IFS= read -r path; do
      case "$path" in
        ./node_modules/* | node_modules/*) ;;
        *) printf '%s\n' "$path" ;;
      esac
    done
)"
if [[ -n "$unformatted" ]]; then
  printf 'Go files need gofmt:\n%s\n' "$unformatted" >&2
  exit 1
fi

echo "==> Go tests (race detector)"
go test -race ./...

echo "==> Go vet"
go vet ./...

echo "==> Go build"
go build -trimpath -o "$scratch_dir/zak-radio" ./cmd/zak-radio

echo "==> Go vulnerability scan"
go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 \
  -mode=binary "$scratch_dir/zak-radio"

echo "==> repository secret scan"
gitleaks git . --redact --no-banner --log-opts='--all'

echo "==> frontend dependency audit"
npm audit --audit-level=high

echo "==> generated CSS"
npm exec -- tailwindcss \
  -i ./static/styles.tailwind.css \
  -o "$scratch_dir/styles.css" \
  --minify
cmp "$scratch_dir/styles.css" ./static/styles.css

echo "==> frontend syntax"
node --check static/platform.js
node --check static/app.js
node --check static/library.js
node --check static/reader.js

echo "==> frontend behavior and accessibility"
browser_port="$(
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
)"
[[ "$browser_port" =~ ^[0-9]+$ ]]
ZAK_RADIO_BROWSER_PORT="$browser_port" \
  ZAK_RADIO_PLAYWRIGHT_OUTPUT="$scratch_dir/playwright" \
  npm run test:browser

echo "==> operator shell syntax"
bash -n \
  scripts/backup-volume.sh \
  scripts/bootstrap-volume.sh \
  scripts/check-retained-budget.sh \
  scripts/migrate-volume-ownership.sh \
  scripts/prepare-kiln-package.sh \
  scripts/provision-current-volume.sh \
  scripts/restore-volume.sh \
  scripts/start-browser-fixture.sh \
  scripts/validate-volume.sh \
  scripts/validate-volume-tree.sh \
  scripts/verify-ownership-receipt.sh \
  scripts/verify-release-package.sh \
  scripts/verify-snapshot.sh

echo "==> Python syntax"
PYTHONPYCACHEPREFIX="$scratch_dir/pycache" \
  python3 -m py_compile \
  scripts/lyrics_harness.py scripts/lyrics-harness.py \
  scripts/generate-timed-lyrics.py scripts/generate-track-subjects.py \
  scripts/test_generate_timed_lyrics.py \
  scripts/verify-runtime.py scripts/test_verify_runtime.py \
  scripts/with-volume-lock.py
PYTHONPYCACHEPREFIX="$scratch_dir/pycache" \
  python3 scripts/test_generate_timed_lyrics.py
PYTHONPYCACHEPREFIX="$scratch_dir/pycache" \
  python3 scripts/test_verify_runtime.py
python3 -m json.tool testdata/lyrics-gold/manifest.json >/dev/null
python3 -m json.tool testdata/lyrics-gold/profile-v1.json >/dev/null

echo "==> static package inputs"
if find ./static -mindepth 1 \( -type l -o \( ! -type f ! -type d \) \) \
  -print -quit | grep -q .; then
  echo "static package input has an unsupported file type" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for privileged recovery and image validation" >&2
  exit 1
}

echo "==> privileged clean-install and recovery drill"
ops_image="$(docker build --quiet -f scripts/Dockerfile.test-tools scripts)"
docker run --rm --user 0:0 \
  --mount "type=bind,source=$repo_root,target=/work,readonly" \
  --workdir /work \
  --env GOCACHE=/tmp/go-build \
  --env GOMODCACHE=/tmp/go-mod \
  "$ops_image" \
  go test -v -run '^TestQuiescedVolumeBackupRestoreDrill$' ./internal/application

echo "==> minimal Kiln package and clean container build"
package_dir="$scratch_dir/kiln-package"
manifest="$(scripts/prepare-kiln-package.sh --output "$package_dir")"
[[ "$manifest" == "$package_dir/apphost.vnext.toml" ]]
release_id="$(cat "$package_dir/RELEASE")"
[[ "$release_id" =~ ^[0-9a-f]{64}$ ]]
[[ "$release_id" == "$(sha256sum "$package_dir/SOURCE.IDENTITY" | cut -d' ' -f1)" ]]
(cd "$package_dir" && sha256sum --check PACKAGE.SHA256SUMS)
if grep -q '^RUN ' "$package_dir/Dockerfile"; then
  echo "Kiln package Dockerfile must remain offline-only" >&2
  exit 1
fi
[[ ! -e "$package_dir/vendor" && ! -e "$package_dir/go.mod" &&
  ! -e "$package_dir/internal" ]]
while IFS= read -r -d '' path; do
  [[ "$(stat -c '%a' "$path")" == "644" ]] || {
    echo "packaged static file has unsafe mode: $path" >&2
    exit 1
  }
done < <(find "$package_dir/static" -type f -print0)
docker build --check --network=none "$package_dir"
image_id="$(docker build --quiet --network=none --pull=false "$package_dir")"
[[ "$(docker image inspect --format '{{.Config.User}}' "$image_id")" == "0:0" ]] || {
  echo "Kiln container runtime user is not rootless-container root" >&2
  exit 1
}
inspect_static_mode() {
  local inspected_image="$1"
  local label="$2"
  local container archive mode
  container="$(docker create "$inspected_image")"
  archive="$scratch_dir/$label.tar"
  docker export "$container" >"$archive"
  docker rm "$container" >/dev/null
  mode="$(tar -tvf "$archive" | awk '$NF=="static/reader.js" {print $1}')"
  [[ "$mode" == "-rw-r--r--" ]] || {
    echo "$label image reader.js mode is $mode, want -rw-r--r--" >&2
    exit 1
  }
}
inspect_static_mode "$image_id" "kiln-package"

echo "==> production image lifecycle and retained-state proof"
runtime_volume="$scratch_dir/runtime-volume"
runtime_archive="$runtime_volume/music-library"
install -d -m 0750 \
  "$runtime_archive/tracks/alpha" \
  "$runtime_volume/reader-library"
cp -- tests/fixtures/tone.mp3 "$runtime_archive/tracks/alpha/audio.mp3"
runtime_audio_sha="$(sha256sum "$runtime_archive/tracks/alpha/audio.mp3" | cut -d' ' -f1)"
printf '{"tracks":[{"id":"alpha","title":"Alpha Sunrise","artist":"Signal Garden","source":"fixture","created_at":"2026-07-01","batch_index":1,"duration":1.5,"play_count":1,"organized_dir":"tracks/alpha","audio_sha256":"%s"}]}\n' \
  "$runtime_audio_sha" >"$runtime_archive/index.json"
printf '{"tracks":{"alpha":{"title":"Alpha Sunrise","artist":"Signal Garden","summary":"Production image lifecycle fixture."}}}\n' \
  >"$runtime_volume/curated-tracks.json"
docker run --rm --user 0:0 \
  --mount "type=bind,source=$runtime_volume,target=/volume" \
  "$ops_image" sh -c '
      chown -R 65532:65532 /volume
      find /volume -type d -exec chmod 0750 {} +
      find /volume -type f -exec chmod 0640 {} +
    '

# A brand-new fixture has no retained database yet. Initialize it with the
# same immutable image while explicitly disabling only the pre-provisioned
# volume gate, then exercise the default production gate below.
bootstrap_container="$(
  docker run --detach \
    --user 65532:65532 \
    --env ZAK_RADIO_DROP_PRIVILEGES=0 \
    --env ZAK_RADIO_ALLOW_ROOTLESS_CONTAINER=0 \
    --env ZAK_RADIO_ARCHIVE=/data/zak-radio/music-library \
    --mount "type=bind,source=$runtime_volume,target=/data/zak-radio" \
    "$image_id"
)"
runtime_containers+=("$bootstrap_container")
database_ready=0
for _ in $(seq 1 100); do
  # The production volume is intentionally inaccessible to the invoking
  # host user after ownership provisioning, so use the process-ready log
  # instead of probing the database through the host mount.
  if docker logs "$bootstrap_container" 2>&1 | grep -q 'Listening on '; then
    database_ready=1
    break
  fi
  sleep 0.1
done
if [[ "$database_ready" != "1" ]]; then
  docker logs "$bootstrap_container" >&2
  exit 1
fi
docker stop --time 10 "$bootstrap_container" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$bootstrap_container")" == "0" ]]
docker run --rm --user 0:0 \
  --mount "type=bind,source=$repo_root,target=/work,readonly" \
  --mount "type=bind,source=$runtime_volume,target=/volume" \
  --workdir /work \
  "$ops_image" \
  scripts/provision-current-volume.sh /volume

runtime_port="$(
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
)"
[[ "$runtime_port" =~ ^[0-9]+$ ]]
runtime_container="$(
  docker run --detach \
    --user 65532:65532 \
    --env ZAK_RADIO_DROP_PRIVILEGES=1 \
    --env ZAK_RADIO_ALLOW_ROOTLESS_CONTAINER=0 \
    --env ZAK_RADIO_ARCHIVE=/data/zak-radio/music-library \
    --mount "type=bind,source=$runtime_volume,target=/data/zak-radio" \
    --network host \
    "$image_id" \
    --host 127.0.0.1 --port "$runtime_port"
)"
runtime_containers+=("$runtime_container")
runtime_base="http://127.0.0.1:$runtime_port"
runtime_ready=0
for _ in $(seq 1 100); do
  if curl --fail --silent --show-error "$runtime_base/health" >/dev/null 2>&1; then
    runtime_ready=1
    break
  fi
  sleep 0.1
done
if [[ "$runtime_ready" != "1" ]]; then
  docker logs "$runtime_container" >&2
  exit 1
fi
python3 scripts/verify-runtime.py \
  --base "$runtime_base" \
  --expected-tracks 1 \
  --expected-reader-items 0 \
  --expected-release "$release_id" \
  --deadline-seconds 60
curl --fail --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data '{"track_id":"alpha"}' \
  "$runtime_base/api/like" >"$scratch_dir/like-response.json"
grep -q '"liked":true' "$scratch_dir/like-response.json"

docker stop --time 10 "$runtime_container" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$runtime_container")" == "0" ]]
docker run --rm --user 0:0 \
  --mount "type=bind,source=$runtime_volume,target=/volume,readonly" \
  "$ops_image" \
  test -s /volume/station.sqlite3
docker start "$runtime_container" >/dev/null
runtime_ready=0
for _ in $(seq 1 100); do
  if curl --fail --silent --show-error "$runtime_base/health" >/dev/null 2>&1; then
    runtime_ready=1
    break
  fi
  sleep 0.1
done
[[ "$runtime_ready" == "1" ]]
python3 scripts/verify-runtime.py \
  --base "$runtime_base" \
  --expected-tracks 1 \
  --expected-reader-items 0 \
  --expected-release "$release_id" \
  --deadline-seconds 60
curl --fail --silent --show-error "$runtime_base/api/tracks" \
  >"$scratch_dir/restarted-tracks.json"
grep -q '"liked":true' "$scratch_dir/restarted-tracks.json"
docker stop --time 10 "$runtime_container" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$runtime_container")" == "0" ]]

echo "==> patch hygiene"
git diff --check

echo "checks: PASS"
