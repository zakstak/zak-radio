package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"zak-radio-apphost/internal/httpguard"
)

func TestMigrationSourceValidatorAdmitsSupportedProductionShapedLegacyVolume(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "music-library")
	reader := filepath.Join(root, "reader-library")
	static := t.TempDir()
	for _, directory := range []string{
		filepath.Join(archive, "tracks", "one"), reader,
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	media := []byte("legacy-production-media")
	digest := sha256.Sum256(media)
	if err := os.WriteFile(
		filepath.Join(archive, "tracks", "one", "audio.mp3"), media, 0o640,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(archive, "index.json"), []byte(fmt.Sprintf(
		`{"tracks":[{"id":"one","title":"One","duration":3,"organized_dir":"tracks/one","audio_sha256":"%x"}]}`,
		digest,
	)), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "curated-tracks.json"), []byte(`{"tracks":{}}`), 0o640,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(static, "index.html"), []byte("<main>fixture</main>"), 0o640,
	); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		MetadataRoot: root, Archive: archive,
		DBPath:        filepath.Join(root, "station.sqlite3"),
		ReaderLibrary: reader, StaticDir: static,
		AllowedHosts: "loopback", AllowedOrigins: "loopback",
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`pragma user_version=12; pragma wal_checkpoint(truncate);`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(cfg.DBPath + suffix); err != nil &&
			!errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
	if err := validateMigrationSourceVolume(context.Background(), root); err != nil {
		t.Fatalf("supported production-shaped legacy volume was rejected: %v", err)
	}
	migrated, err := NewApp(cfg)
	if err != nil {
		t.Fatalf("admitted legacy volume did not migrate: %v", err)
	}
	defer migrated.Close()
	var version int
	if err := migrated.db.QueryRow(`pragma user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != currentSchemaVersion {
		t.Fatalf("migrated schema=%d want=%d", version, currentSchemaVersion)
	}
}

func TestBootstrapAndBackupPreflightFreeSpaceBeforeTargetMutation(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("tmpfs recovery preflight requires root")
	}
	for _, dependency := range []string{"mount", "umount", "rsync", "sqlite3"} {
		if _, err := exec.LookPath(dependency); err != nil {
			t.Skipf("%s is unavailable", dependency)
		}
	}
	root := t.TempDir()
	source := filepath.Join(root, "source")
	archive := filepath.Join(source, "music-library")
	reader := filepath.Join(source, "reader-library")
	static := filepath.Join(root, "static")
	for _, directory := range []string{
		filepath.Join(archive, "tracks", "one"), reader, static,
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	media := []byte("free-space-fixture-media")
	digest := sha256.Sum256(media)
	files := map[string][]byte{
		filepath.Join(archive, "tracks", "one", "audio.mp3"): media,
		filepath.Join(archive, "index.json"): []byte(fmt.Sprintf(
			`{"tracks":[{"id":"one","title":"One","duration":3,"organized_dir":"tracks/one","audio_sha256":"%x"}]}`,
			digest,
		)),
		filepath.Join(source, "curated-tracks.json"):  []byte(`{"tracks":{}}`),
		filepath.Join(static, "index.html"):           []byte("<main>fixture</main>"),
		filepath.Join(source, "allocated-filler.bin"): bytes.Repeat([]byte{0x5a}, 2<<20),
	}
	for path, content := range files {
		if err := os.WriteFile(path, content, 0o640); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Config{
		MetadataRoot: source, Archive: archive,
		DBPath:        filepath.Join(source, "station.sqlite3"),
		ReaderLibrary: reader, StaticDir: static,
		AllowedHosts: "loopback", AllowedOrigins: "loopback",
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	mountRoot := filepath.Join(root, "small-filesystem")
	if err := os.Mkdir(mountRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(
		"mount", "-t", "tmpfs", "-o", "size=1m", "tmpfs", mountRoot,
	).CombinedOutput(); err != nil {
		t.Skipf("tmpfs mount unavailable: %v: %s", err, output)
	}
	t.Cleanup(func() {
		_ = exec.Command("umount", mountRoot).Run()
	})

	bootstrapTarget := filepath.Join(mountRoot, "bootstrap-target")
	bootstrap := exec.Command("scripts/bootstrap-volume.sh",
		"--source", source, "--target", bootstrapTarget)
	bootstrap.Env = append(os.Environ(), "ZAK_RADIO_SOURCE_QUIESCED=1")
	if output, err := bootstrap.CombinedOutput(); err == nil ||
		!strings.Contains(string(output), "free bytes") {
		t.Fatalf("bootstrap free-space preflight status=%v output=%s", err, output)
	}
	if _, err := os.Stat(bootstrapTarget); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed bootstrap created target before free-space gate: %v", err)
	}

	releasePackage := filepath.Join(root, "release-package")
	if output, err := exec.Command("scripts/prepare-apphost-package.sh",
		"--output", releasePackage).CombinedOutput(); err != nil {
		t.Fatalf("prepare release package: %v\n%s", err, output)
	}
	releaseBytes, err := os.ReadFile(filepath.Join(releasePackage, "RELEASE"))
	if err != nil {
		t.Fatal(err)
	}
	backupOutput := filepath.Join(mountRoot, "backups")
	identityReceipt := filepath.Join(root, "backup-identity")
	backup := exec.Command("scripts/backup-volume.sh",
		"--source", source, "--output", backupOutput,
		"--source-package", releasePackage,
		"--expected-runtime-release", strings.TrimSpace(string(releaseBytes)),
		"--identity-receipt", identityReceipt)
	backup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if output, err := backup.CombinedOutput(); err == nil ||
		!strings.Contains(string(output), "free bytes") {
		t.Fatalf("backup free-space preflight status=%v output=%s", err, output)
	}
	if _, err := os.Stat(backupOutput); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed backup created output before free-space gate: %v", err)
	}
	if _, err := os.Stat(identityReceipt); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed backup published identity receipt: %v", err)
	}
}

func TestStoppedVolumeValidatorRejectsReadyReaderWithoutAudioPath(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "missing-ready-audio")
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
update reader_segments set audio_path=null
where item_id='missing-ready-audio' and status='ready'`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := validateVolume(context.Background(), cfg.MetadataRoot); err == nil {
		t.Fatal("stopped-volume validator accepted ready Reader audio without a path")
	}
	if reopened, err := NewApp(cfg); err == nil {
		reopened.Close()
		t.Fatal("startup accepted ready Reader audio without a path")
	}
}

func TestStartupRejectsMissingOrMalformedTrackStatsRevision(t *testing.T) {
	for _, mutation := range []string{
		"delete from app_metadata where key='track_stats_revision'",
		"update app_metadata set value='9223372036854775807' where key='track_stats_revision'",
	} {
		t.Run(strings.Fields(mutation)[0], func(t *testing.T) {
			cfg := newTestConfig(t)
			app, err := NewApp(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := app.Close(); err != nil {
				t.Fatal(err)
			}
			db, err := sql.Open("sqlite", cfg.DBPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(mutation); err != nil {
				db.Close()
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			if reopened, err := NewApp(cfg); err == nil {
				reopened.Close()
				t.Fatal("startup accepted an unusable track-stat revision")
			}
		})
	}
}

func TestReaderRoutesDistinguishUnknownRouteAndStorageFailure(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-route")
	for _, path := range []string{
		"/api/reader/items/reader-route/bogus",
		"/api/reader/items/reader-route/segments/extra",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		app.readerItemSubroute(res, req)
		if res.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d body=%s", path, res.Code, res.Body.String())
		}
	}
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/reader/items/reader-route", nil)
	res := httptest.NewRecorder()
	app.readerItemSubroute(res, req)
	if res.Code != http.StatusInternalServerError {
		t.Fatalf("closed DB status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestReaderPathsRebaseAcrossRetainedVolumeMove(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "reader-move")
	oldStorage := filepath.Join(string(filepath.Separator), "retired-mount", "reader-move")
	if _, err := app.db.Exec(`
update reader_items
set storage_dir=?, source_path=?, normalized_text_path=?, manifest_path=?
where id='reader-move'`,
		oldStorage, filepath.Join(oldStorage, "source.html"), filepath.Join(oldStorage, "source.html"),
		filepath.Join(oldStorage, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
update reader_segments set audio_path=? where item_id='reader-move'`,
		filepath.Join(oldStorage, "audio", "0.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var storage, source, audio string
	if err := reopened.db.QueryRow(`
select i.storage_dir, i.source_path, s.audio_path
from reader_items i join reader_segments s on s.item_id=i.id
where i.id='reader-move'`).Scan(&storage, &source, &audio); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{storage, source, audio} {
		if !containedPath(path, cfg.ReaderLibrary) {
			t.Fatalf("rebased path escaped Reader root: %s", path)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/reader-media/reader-move/0.mp3", nil)
	res := httptest.NewRecorder()
	reopened.readerMedia(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("rebased media status=%d body=%s", res.Code, res.Body.String())
	}
	req = httptest.NewRequest(http.MethodGet, "/reader-source/reader-move/source", nil)
	res = httptest.NewRecorder()
	reopened.readerSource(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("rebased source status=%d body=%s", res.Code, res.Body.String())
	}
	backups, err := filepath.Glob(
		fmt.Sprintf("%s.schema-v%d-*.bak", cfg.DBPath, currentSchemaVersion))
	if err != nil || len(backups) == 0 {
		t.Fatalf("Reader rebase backup=%v err=%v", backups, err)
	}
}

func TestReaderPathsRebasePreservesNestedHierarchy(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	source := seedReaderItem(t, app, "reader-nested")
	originalStorage := filepath.Dir(source)
	nestedStorage := filepath.Join(cfg.ReaderLibrary, "collection", "reader-nested")
	if err := os.MkdirAll(filepath.Dir(nestedStorage), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(originalStorage, nestedStorage); err != nil {
		t.Fatal(err)
	}
	legacyStorage := filepath.Join(string(filepath.Separator), "retired", "reader-library", "collection", "reader-nested")
	if _, err := app.db.Exec(`
update reader_items
set storage_dir=?, source_path=?, normalized_text_path=?, manifest_path=?
where id='reader-nested'`,
		legacyStorage, filepath.Join(legacyStorage, "source.html"), filepath.Join(legacyStorage, "source.html"),
		filepath.Join(legacyStorage, "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("update reader_segments set audio_path=? where item_id='reader-nested'",
		filepath.Join(legacyStorage, "audio", "0.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var got string
	if err := reopened.db.QueryRow("select storage_dir from reader_items where id='reader-nested'").Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != nestedStorage {
		t.Fatalf("nested storage=%q, want %q", got, nestedStorage)
	}
}

func TestReaderPathRebaseRejectsDestinationCollisionWithoutMutation(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "reader-a")
	seedReaderItem(t, app, "reader-b")
	legacyRoot := filepath.Join(string(filepath.Separator), "retired", "reader-library")
	legacyStorage := filepath.Join(legacyRoot, "shared")
	if _, err := app.db.Exec("update app_metadata set value=? where key='reader_root'", legacyRoot); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"reader-a", "reader-b"} {
		if _, err := app.db.Exec("update reader_items set storage_dir=? where id=?", legacyStorage, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := NewApp(cfg); err == nil {
		reopened.Close()
		t.Fatal("Reader destination collision was accepted")
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow("select count(*) from reader_items where storage_dir=?", legacyStorage).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("failed rebase mutated %d legacy rows, want 2", 2-count)
	}
}

func TestHealthFailsWithoutMainStation(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec("delete from stations where id='main'"); err != nil {
		t.Fatal(err)
	}
	app.refreshIntegrity(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	res := httptest.NewRecorder()
	app.health(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("health status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Checks map[string]bool `json:"checks"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Checks["writable"] {
		t.Fatalf("health checks did not detect missing main: %#v", payload.Checks)
	}
}

func TestHealthFailsAfterPartialMediaLoss(t *testing.T) {
	t.Run("non-first music track", func(t *testing.T) {
		app := newTestApp(t)
		if err := os.Remove(app.byID["two"].AudioPath); err != nil {
			t.Fatal(err)
		}
		app.auditAllIntegrity(context.Background())
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		res := httptest.NewRecorder()
		app.health(res, req)
		if res.Code != http.StatusServiceUnavailable {
			t.Fatalf("health status=%d body=%s", res.Code, res.Body.String())
		}
	})
	t.Run("Reader segment", func(t *testing.T) {
		app := newTestApp(t)
		seedReaderItem(t, app, "reader-health")
		var audio string
		if err := app.db.QueryRow("select audio_path from reader_segments where item_id='reader-health'").Scan(&audio); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(audio); err != nil {
			t.Fatal(err)
		}
		app.auditAllIntegrity(context.Background())
		req := httptest.NewRequest(http.MethodGet, "/health", nil)
		res := httptest.NewRecorder()
		app.health(res, req)
		if res.Code != http.StatusServiceUnavailable {
			t.Fatalf("health status=%d body=%s", res.Code, res.Body.String())
		}
	})
	t.Run("same-size music corruption", func(t *testing.T) {
		app := newTestApp(t)
		path := app.byID["one"].AudioPath
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, int(info.Size())), 0o640); err != nil {
			t.Fatal(err)
		}
		app.auditAllIntegrity(context.Background())
		if app.integritySnapshot()["media"] {
			t.Fatal("same-size music corruption passed readiness")
		}
	})
	t.Run("same-size Reader corruption", func(t *testing.T) {
		app := newTestApp(t)
		seedReaderItem(t, app, "reader-corrupt")
		var path string
		if err := app.db.QueryRow(`
select audio_path from reader_segments where item_id='reader-corrupt'`).Scan(&path); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, bytes.Repeat([]byte{'x'}, int(info.Size())), 0o640); err != nil {
			t.Fatal(err)
		}
		app.auditAllIntegrity(context.Background())
		if app.integritySnapshot()["reader_integrity"] {
			t.Fatal("same-size Reader corruption passed readiness")
		}
	})
	t.Run("catalog deletion", func(t *testing.T) {
		app := newTestApp(t)
		if err := os.Remove(filepath.Join(app.cfg.MetadataRoot, "curated-tracks.json")); err != nil {
			t.Fatal(err)
		}
		app.refreshIntegrity(context.Background())
		if app.integritySnapshot()["catalog"] {
			t.Fatal("missing startup catalog passed readiness")
		}
	})
	t.Run("Reader source deletion", func(t *testing.T) {
		app := newTestApp(t)
		source := seedReaderItem(t, app, "reader-source-health")
		if err := os.Remove(source); err != nil {
			t.Fatal(err)
		}
		app.refreshIntegrity(context.Background())
		if app.integritySnapshot()["reader_integrity"] {
			t.Fatal("missing Reader source artifact passed readiness")
		}
	})
}

func TestMediaOpenRejectsPostStartupSymlinkSwap(t *testing.T) {
	app := newTestApp(t)
	path := app.byID["one"].AudioPath
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.mp3")
	if err := os.WriteFile(outside, []byte("outside-marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/media/one/audio", nil)
	res := httptest.NewRecorder()
	app.media(res, req)
	if res.Code != http.StatusNotFound || strings.Contains(res.Body.String(), "outside-marker") {
		t.Fatalf("symlink swap status=%d body=%q", res.Code, res.Body.String())
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	done := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/media/one/audio", nil)
		res := httptest.NewRecorder()
		app.media(res, req)
		done <- res.Code
	}()
	select {
	case status := <-done:
		if status != http.StatusNotFound {
			t.Fatalf("FIFO status=%d", status)
		}
	case <-time.After(time.Second):
		t.Fatal("media handler blocked on FIFO")
	}
}

func TestPrivateReaderMediaCachePolicy(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-private")
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req := httptest.NewRequest(method, "/reader-media/reader-private/0.mp3", nil)
		res := httptest.NewRecorder()
		app.readerMedia(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s Reader media status=%d", method, res.Code)
		}
		if got := res.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("%s Reader Cache-Control=%q", method, got)
		}
		if got := res.Header().Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
			t.Fatalf("%s Reader CORP=%q", method, got)
		}
	}
}

func TestPrivateMusicMediaCachePolicy(t *testing.T) {
	app := newTestApp(t)
	cover := filepath.Join(app.cfg.MetadataRoot, "cover.jpg")
	if err := os.WriteFile(cover, []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}
	app.byID["one"].CoverPath = cover
	app.byID["one"].HasCover = true
	for _, endpoint := range []string{"audio", "cover"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			req := httptest.NewRequest(method, "/media/one/"+endpoint, nil)
			res := httptest.NewRecorder()
			app.media(res, req)
			if res.Code != http.StatusOK {
				t.Fatalf("%s %s status=%d", method, endpoint, res.Code)
			}
			if got := res.Header().Get("Cache-Control"); got != "private, max-age=86400" {
				t.Fatalf("%s %s Cache-Control=%q", method, endpoint, got)
			}
			if got := res.Header().Get("Cross-Origin-Resource-Policy"); got != "same-origin" {
				t.Fatalf("%s %s CORP=%q", method, endpoint, got)
			}
		}
	}
}

func TestTrustedProxyClientIdentity(t *testing.T) {
	trusted := httptest.NewRequest(http.MethodGet, "/", nil)
	trusted.RemoteAddr = "10.2.3.4:12345"
	trusted.Header.Set("X-Real-IP", "192.0.2.10")
	if got := clientAddress(trusted, "10.0.0.0/8"); got != "192.0.2.10" {
		t.Fatalf("trusted proxy identity=%q", got)
	}
	untrusted := httptest.NewRequest(http.MethodGet, "/", nil)
	untrusted.RemoteAddr = "203.0.113.5:54321"
	untrusted.Header.Set("X-Real-IP", "192.0.2.11")
	if got := clientAddress(untrusted, "10.0.0.0/8"); got != "203.0.113.5" {
		t.Fatalf("untrusted spoof identity=%q", got)
	}
}

func TestListenerRejectsEveryMalformedTrustedProxyToken(t *testing.T) {
	for _, proxies := range []string{
		"172.16.0.0/12,not-a-network",
		"172.16.0.1,",
		",172.16.0.1",
		"172.16.0.0/99",
	} {
		if err := validateListenerConfig(Config{
			Port: 8787, AllowedHosts: "loopback,music.example", TrustedProxies: proxies,
		}); err == nil {
			t.Fatalf("malformed trusted proxies %q were accepted", proxies)
		}
	}
}

func TestMediaRejectsMultipleRanges(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "range-reader")
	for _, test := range []struct {
		path string
		size int64
	}{
		{"/media/one/audio", mustFileSize(t, app.byID["one"].AudioPath)},
		{"/reader-media/range-reader/0.mp3",
			mustFileSize(t, filepath.Join(app.cfg.ReaderLibrary, "range-reader", "audio", "0.mp3"))},
	} {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		req.Host = "localhost"
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Range", "bytes=0-1,3-4")
		res := httptest.NewRecorder()
		app.routes().ServeHTTP(res, req)
		if res.Code != http.StatusRequestedRangeNotSatisfiable ||
			res.Header().Get("Content-Range") != fmt.Sprintf("bytes */%d", test.size) {
			t.Fatalf("%s multi-range status=%d range=%q body=%s",
				test.path, res.Code, res.Header().Get("Content-Range"), res.Body.String())
		}
	}
}

func mustFileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func TestMiddlewareRejectsMultipleRangesForEveryFileSurface(t *testing.T) {
	for _, path := range []string{
		"/", "/library", "/reader", "/static/app.js", "/media/one/cover",
		"/reader-image/item/000.png", "/reader-source/item/source",
	} {
		called := false
		handler := secureHTTP(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			called = true
		}), "loopback", "loopback", "")
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Host = "localhost"
		req.Header.Set("Range", "bytes=0-0,2-2")
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusRequestedRangeNotSatisfiable || called {
			t.Fatalf("%s multi-range status=%d called=%v", path, res.Code, called)
		}
	}
}

func TestDataRootsRejectSymlinkedMetadata(t *testing.T) {
	cfg := newTestConfig(t)
	target := cfg.MetadataRoot
	link := filepath.Join(t.TempDir(), "metadata-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	cfg.MetadataRoot = link
	cfg.Archive = filepath.Join(link, filepath.Base(cfg.Archive))
	cfg.DBPath = filepath.Join(link, filepath.Base(cfg.DBPath))
	cfg.ReaderLibrary = filepath.Join(link, filepath.Base(cfg.ReaderLibrary))
	if err := validateDataPaths(cfg); err == nil {
		t.Fatal("symlinked metadata root was accepted")
	}
}

func TestStartupRejectsHardLinkedAndOverBudgetRetainedTrees(t *testing.T) {
	t.Run("hard link", func(t *testing.T) {
		cfg := newTestConfig(t)
		external := filepath.Join(t.TempDir(), "external")
		if err := os.WriteFile(external, []byte("external"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(external, filepath.Join(cfg.MetadataRoot, "outward")); err != nil {
			t.Fatal(err)
		}
		if app, err := NewApp(cfg); err == nil {
			app.Close()
			t.Fatal("startup accepted an outward hard link")
		}
		info, err := os.Stat(external)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("external inode changed: info=%v err=%v", info, err)
		}
	})
	t.Run("apparent bytes", func(t *testing.T) {
		cfg := newTestConfig(t)
		oversized := filepath.Join(cfg.MetadataRoot, "oversized-sparse")
		if err := os.WriteFile(oversized, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(oversized, maxRetainedVolumeBytes+1); err != nil {
			t.Fatal(err)
		}
		if app, err := NewApp(cfg); err == nil {
			app.Close()
			t.Fatal("startup accepted an over-budget retained tree")
		}
	})
}

func TestStaticAndMetadataRootsMustBeDisjoint(t *testing.T) {
	cfg := newTestConfig(t)
	cfg.StaticDir = cfg.MetadataRoot
	if err := validateDataPaths(cfg); err == nil {
		t.Fatal("metadata root was accepted as public static root")
	}
	cfg = newTestConfig(t)
	cfg.StaticDir = filepath.Dir(cfg.MetadataRoot)
	if err := validateDataPaths(cfg); err == nil {
		t.Fatal("metadata parent was accepted as public static root")
	}
}

func TestVolumeValidationRejectsSQLiteSidecarsInProcess(t *testing.T) {
	database := filepath.Join(t.TempDir(), "station.sqlite3")
	if err := os.WriteFile(database, []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(database+"-wal", []byte("committed"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rejectSQLiteSidecars(database); err == nil {
		t.Fatal("non-empty SQLite WAL was accepted")
	}
}

func TestTemporaryStationIDsUseModernEntropyAndRejectMalformedInput(t *testing.T) {
	app := newTestApp(t)
	id, _, _, err := app.station.Create(context.Background(), "one", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 32 || !temporaryStationIDPattern.MatchString(id) {
		t.Fatalf("temporary station id=%q", id)
	}
	app.cancel()
	app.wg.Wait()
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/api/station?station_id="+strings.Repeat("a", 4096), nil)
	res := httptest.NewRecorder()
	app.apiStation(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("malformed station status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestReaderImagesRejectOversizedAndNonRegularSource(t *testing.T) {
	for _, test := range []struct {
		name    string
		replace func(string) error
	}{
		{
			name: "oversized",
			replace: func(path string) error {
				return os.WriteFile(path, make([]byte, maxReaderSourceBytes+1), 0o600)
			},
		},
		{
			name: "directory",
			replace: func(path string) error {
				if err := os.Remove(path); err != nil {
					return err
				}
				return os.Mkdir(path, 0o700)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := newTestApp(t)
			source := seedReaderItem(t, app, "reader-images")
			if err := test.replace(source); err != nil {
				t.Fatal(err)
			}
			if _, err := app.getImages(context.Background(), "reader-images"); err == nil {
				t.Fatal("unsafe Reader source was accepted")
			}
		})
	}
}

func TestReaderImagesAreCachedAndInvalidatedBySourceChange(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-image-cache")
	imageDir := filepath.Join(filepath.Dir(source), "images")
	if err := os.MkdirAll(imageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, "000.png"), []byte("image-zero"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`<img src="zero.png" alt="zero">`), 0o640); err != nil {
		t.Fatal(err)
	}
	first, err := app.getImages(context.Background(), "reader-image-cache")
	if err != nil || len(first) != 1 {
		t.Fatalf("first images=%#v err=%v", first, err)
	}
	second, err := app.getImages(context.Background(), "reader-image-cache")
	if err != nil || len(second) != 1 || len(app.readerImages) != 1 {
		t.Fatalf("cached images=%#v cache=%d err=%v", second, len(app.readerImages), err)
	}
	if err := os.Remove(filepath.Join(imageDir, "000.png")); err != nil {
		t.Fatal(err)
	}
	missing, err := app.getImages(context.Background(), "reader-image-cache")
	if err != nil || len(missing) != 0 {
		t.Fatalf("artifact deletion images=%#v err=%v", missing, err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, "000.png"), []byte("image-zero"), 0o640); err != nil {
		t.Fatal(err)
	}
	restored, err := app.getImages(context.Background(), "reader-image-cache")
	if err != nil || len(restored) != 1 {
		t.Fatalf("artifact creation images=%#v err=%v", restored, err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, "001.png"), []byte("image-one"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source,
		[]byte(`<img src="zero.png" alt="zero"><img src="one.png" alt="one">`), 0o640); err != nil {
		t.Fatal(err)
	}
	updated, err := app.getImages(context.Background(), "reader-image-cache")
	if err != nil || len(updated) != 2 || len(app.readerImages) != 1 {
		t.Fatalf("updated images=%#v cache=%d err=%v", updated, len(app.readerImages), err)
	}
}

func TestReaderIDAdmissionMatchesPlaybackRoutes(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", maxRouteIDBytes+1)
	seedReaderItem(t, app, id)

	req := httptest.NewRequest(http.MethodGet, "/api/reader/items/"+id, nil)
	res := httptest.NewRecorder()
	app.readerItemSubroute(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("oversized Reader detail status=%d body=%s", res.Code, res.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "/api/reader/playback",
		strings.NewReader(fmt.Sprintf(`{"item_id":%q,"segment_index":0,"position":0,"playing":false,"base_revision":0}`,
			id)))
	req.Header.Set("Content-Type", "application/json")
	res = httptest.NewRecorder()
	app.setReaderPlayback(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("oversized Reader playback status=%d body=%s", res.Code, res.Body.String())
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := NewApp(cfg); err == nil {
		reopened.Close()
		t.Fatal("startup admitted a Reader item whose id is rejected by playback routes")
	}
}

func TestReaderImageCacheIsBounded(t *testing.T) {
	app := newTestApp(t)
	for index := 0; index < maxReaderCacheItems+3; index++ {
		id := fmt.Sprintf("reader-cache-%03d", index)
		seedReaderItem(t, app, id)
		if _, err := app.getImages(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	if len(app.readerImages) != maxReaderCacheItems {
		t.Fatalf("Reader image cache retained %d entries, want %d", len(app.readerImages), maxReaderCacheItems)
	}
}

func TestHostAndOriginAllowlistRejectsRebinding(t *testing.T) {
	app := newTestApp(t)
	for _, method := range []string{http.MethodGet, http.MethodOptions, http.MethodPost} {
		req := httptest.NewRequest(method, "/api/control", strings.NewReader(`{"action":"play"}`))
		req.Host = "attacker.example"
		req.Header.Set("Origin", "http://attacker.example")
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.routes().ServeHTTP(res, req)
		if res.Code != http.StatusMisdirectedRequest {
			t.Fatalf("%s rebinding status=%d body=%s", method, res.Code, res.Body.String())
		}
	}
}

func TestListenerConfigurationFailsClosed(t *testing.T) {
	for _, value := range []string{"invalid", "0", "-1", "65536"} {
		t.Run("environment "+value, func(t *testing.T) {
			t.Setenv("ZAK_RADIO_PORT", value)
			if _, err := defaultConfig(); err == nil {
				t.Fatalf("invalid environment port %q was accepted", value)
			}
		})
	}
	for _, port := range []int{0, -1, 65536} {
		if err := validateListenerConfig(Config{Port: port, AllowedHosts: "loopback"}); err == nil {
			t.Fatalf("invalid listener port %d was accepted", port)
		}
	}
	if err := validateListenerConfig(Config{
		Port: 8787, AllowedHosts: "loopback,music.example", TrustedProxies: "",
	}); err == nil {
		t.Fatal("external deployment without trusted proxy identity was accepted")
	}
	if err := validateListenerConfig(Config{
		Port: 8787, AllowedHosts: "loopback,music.example",
		TrustedProxies: "172.16.0.0/12", TrustedIngress: "172.16.0.2",
	}); err != nil {
		t.Fatalf("validated external listener rejected: %v", err)
	}
}

func TestCrossSitePrivateReadsAreRejectedBeforeHandlers(t *testing.T) {
	for _, site := range []string{"cross-site", "same-site"} {
		for _, path := range []string{
			"/health",
			"/api/station/events?station_id=main",
			"/media/one/audio",
			"/reader-media/item/0.mp3",
			"/reader-image/item/0.png",
			"/reader-source/item/source",
		} {
			called := false
			handler := secureHTTP(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				called = true
			}), "loopback", "loopback", "")
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Host = "localhost"
			req.Header.Set("Sec-Fetch-Site", site)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != http.StatusForbidden || called {
				t.Fatalf("%s %s status=%d called=%v", site, path, res.Code, called)
			}
		}
	}
	called := false
	handler := secureHTTP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}), "loopback", "loopback", "")
	req := httptest.NewRequest(http.MethodGet, "/media/one/audio", nil)
	req.Host = "localhost"
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusNoContent || !called {
		t.Fatalf("headerless verifier request status=%d called=%v", res.Code, called)
	}
}

func TestStreamAndRateLimiterStateIsBounded(t *testing.T) {
	streams := httpguard.NewStreamLimiter(0, 16)
	var releases []func()
	for index := 0; index < 16; index++ {
		release, ok := streams.Acquire("client")
		if !ok {
			t.Fatalf("stream %d unexpectedly rejected", index)
		}
		releases = append(releases, release)
	}
	if _, ok := streams.Acquire("client"); ok {
		t.Fatal("seventeenth per-client stream was accepted")
	}
	otherRelease, ok := streams.Acquire("other-client")
	if !ok {
		t.Fatal("one saturated client rejected a distinct trusted client")
	}
	otherRelease()
	for _, release := range releases {
		release()
	}
	if total, clients := streams.Active(); total != 0 || clients != 0 {
		t.Fatalf("stream capacity leaked: total=%d clients=%d", total, clients)
	}
	content := httpguard.NewStreamLimiter(2, 1)
	release, ok := content.Acquire("reader")
	if !ok {
		t.Fatal("first content stream was rejected")
	}
	if _, ok := content.Acquire("reader"); ok {
		t.Fatal("per-client content stream limit was ignored")
	}
	release()
	release, ok = content.Acquire("reader")
	if !ok {
		t.Fatal("released content capacity was not reusable")
	}
	release()
	for _, path := range []string{
		"/health", "/library/", "/reader/", "/api/station", "/api/reader/playback", "/media/one/audio",
		"/reader-media/id/0.mp3", "/reader-image/id/0.png", "/reader-source/id/source",
	} {
		if !isContentRoute(path) {
			t.Fatalf("content route %q is not limited", path)
		}
	}

	limiter := httpguard.NewRequestLimiter()
	for index := 0; index < 5000; index++ {
		limiter.Allow(fmt.Sprintf("client-%d", index), "/api/control", 1, time.Hour)
	}
	if entries := limiter.EntryCount(); entries > 4096 {
		t.Fatalf("rate limiter retained %d entries", entries)
	}
}

func TestDBBackedReadAdmissionRejectsBeforeHandlerQueueGrowth(t *testing.T) {
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	handler := secureHTTP(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}), "loopback", "loopback", "")
	var wait sync.WaitGroup
	for range 4 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			request := httptest.NewRequest(http.MethodGet,
				"/api/station?station_id=main", nil)
			request.Host = "localhost"
			handler.ServeHTTP(httptest.NewRecorder(), request)
		}()
	}
	for range 4 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("admitted DB-backed read did not reach the handler")
		}
	}
	request := httptest.NewRequest(http.MethodGet,
		"/api/station?station_id=main", nil)
	request.Host = "localhost"
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusTooManyRequests {
		t.Fatalf("fifth DB-backed read status=%d body=%s",
			result.Code, result.Body.String())
	}
	close(release)
	wait.Wait()
}

func TestWriteAdmissionRejectsBeforeHandlerQueueGrowth(t *testing.T) {
	entered := make(chan struct{}, 32)
	release := make(chan struct{})
	handler := secureHTTPConfig(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}), "loopback", "loopback", "", "*", 64)
	var wait sync.WaitGroup
	for index := 0; index < 32; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			request := httptest.NewRequest(http.MethodPost, "/api/control",
				strings.NewReader(`{"action":"play"}`))
			request.Host = "localhost"
			request.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", index+1)
			handler.ServeHTTP(httptest.NewRecorder(), request)
		}(index)
	}
	for range 32 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("admitted write did not reach the handler")
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/control",
		strings.NewReader(`{"action":"play"}`))
	request.Host = "localhost"
	request.RemoteAddr = "198.51.100.1:1234"
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusTooManyRequests {
		t.Fatalf("write beyond global capacity status=%d body=%s",
			result.Code, result.Body.String())
	}
	close(release)
	wait.Wait()
}

func TestRetainedTreeValidationRequiresMountpointTool(t *testing.T) {
	fakeBin := t.TempDir()
	for _, command := range []string{"bash", "realpath"} {
		path, err := exec.LookPath(command)
		if err != nil {
			t.Skipf("%s is unavailable", command)
		}
		if err := os.Symlink(path, filepath.Join(fakeBin, command)); err != nil {
			t.Fatal(err)
		}
	}
	volume := t.TempDir()
	command := exec.Command("scripts/validate-volume-tree.sh", volume)
	command.Env = []string{"PATH=" + fakeBin}
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "mountpoint") {
		t.Fatalf("missing mountpoint status=%v output=%s", err, output)
	}
}
