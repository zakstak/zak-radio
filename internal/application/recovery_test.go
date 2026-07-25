package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestKilnPackagePreparationIsMinimalRepeatableAndPrivate(t *testing.T) {
	for _, dependency := range []string{"go", "rsync", "tar"} {
		if _, err := exec.LookPath(dependency); err != nil {
			t.Skipf("%s is unavailable", dependency)
		}
	}
	output := filepath.Join(t.TempDir(), "package")
	for attempt := 0; attempt < 2; attempt++ {
		result, err := exec.Command(
			"scripts/prepare-kiln-package.sh", "--output", output,
		).CombinedOutput()
		if err != nil {
			t.Fatalf("package attempt %d failed: %v\n%s", attempt+1, err, result)
		}
		if strings.TrimSpace(string(result)) != filepath.Join(output, "apphost.vnext.toml") {
			t.Fatalf("package attempt %d returned %q", attempt+1, result)
		}
	}
	if _, err := os.Stat(filepath.Join(output, ".zak-radio-kiln-package")); err != nil {
		t.Fatal("generated package marker is missing")
	}
	localRelease, err := os.ReadFile(filepath.Join(output, "RELEASE"))
	if err != nil || !sha256Pattern.MatchString(strings.TrimSpace(string(localRelease))) {
		t.Fatalf("local package release=%q err=%v", localRelease, err)
	}
	sourceIdentity, err := os.ReadFile(filepath.Join(output, "SOURCE.IDENTITY"))
	if err != nil {
		t.Fatal(err)
	}
	sourceDigest := sha256.Sum256(sourceIdentity)
	if fmt.Sprintf("%x", sourceDigest) != strings.TrimSpace(string(localRelease)) {
		t.Fatal("release does not bind the packaged source identity")
	}
	for _, unnecessary := range []string{"cmd", "internal", "vendor", "go.mod", "go.sum"} {
		if _, err := os.Stat(filepath.Join(output, unnecessary)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("minimal Kiln package contains %s: %v", unnecessary, err)
		}
	}
	if result, err := exec.Command(
		"scripts/verify-release-package.sh", output,
	).CombinedOutput(); err != nil {
		t.Fatalf("minimal package verification failed: %v\n%s", err, result)
	}

	external := filepath.Join(t.TempDir(), "external-package")
	result, err := exec.Command(
		"scripts/prepare-kiln-package.sh",
		"--output", external,
		"--allowed-hosts", "music.example,radio.example",
		"--allowed-origins", "https://music.example,https://radio.example",
		"--trusted-proxies", "10.0.0.2",
		"--trusted-ingress", "10.0.0.2",
	).CombinedOutput()
	if err != nil {
		t.Fatalf("external package failed: %v\n%s", err, result)
	}
	externalRelease, err := os.ReadFile(filepath.Join(external, "RELEASE"))
	if err != nil || strings.TrimSpace(string(externalRelease)) == strings.TrimSpace(string(localRelease)) {
		t.Fatalf("routing configuration did not change release identity: %q %q err=%v",
			localRelease, externalRelease, err)
	}
	dockerfile, err := os.ReadFile(filepath.Join(external, "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"FROM scratch",
		"ADD zak-radio.tar.gz /",
		`"--allowed-hosts", "music.example,radio.example,loopback"`,
		`"--allowed-origins", "https://music.example,https://radio.example,loopback"`,
		`"--trusted-proxies", "10.0.0.2"`,
		`"--trusted-ingress", "10.0.0.2"`,
	} {
		if !bytes.Contains(dockerfile, []byte(expected)) {
			t.Fatalf("external package omitted %q", expected)
		}
	}
	if bytes.Contains(dockerfile, []byte("RUN ")) {
		t.Fatal("Kiln package compiles or downloads dependencies inside the container build")
	}
	if info, err := os.Stat(filepath.Join(external, "zak-radio.tar.gz")); err != nil {
		t.Fatal(err)
	} else if info.Size() > 8<<20 {
		t.Fatalf("compressed executable exceeds Kiln's per-file limit: %d", info.Size())
	}

	nestedControl := filepath.Join(external, "static", "RELEASE")
	if err := os.WriteFile(nestedControl, []byte("runtime asset\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeTestPackageManifest(t, external)
	if result, err := exec.Command(
		"scripts/verify-release-package.sh", external,
	).CombinedOutput(); err != nil {
		t.Fatalf("package with hashed nested reserved name failed: %v\n%s", err, result)
	}
	if err := os.WriteFile(nestedControl, []byte("mutated asset\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if result, err := exec.Command(
		"scripts/verify-release-package.sh", external,
	).CombinedOutput(); err == nil {
		t.Fatalf("mutated nested reserved-name file passed verification: %s", result)
	}

	replace := exec.Command(
		"scripts/prepare-kiln-package.sh",
		"--output", output,
		"--allowed-hosts", "music.example",
		"--allowed-origins", "https://music.example",
		"--trusted-proxies", "10.0.0.2",
		"--trusted-ingress", "10.0.0.2",
	)
	if result, err := replace.CombinedOutput(); err == nil ||
		!strings.Contains(string(result), "immutable Kiln package") {
		t.Fatalf("different release replaced an existing package: err=%v output=%s", err, result)
	}
	preservedRelease, err := os.ReadFile(filepath.Join(output, "RELEASE"))
	if err != nil || !bytes.Equal(preservedRelease, localRelease) {
		t.Fatalf("existing release was not preserved: %q err=%v", preservedRelease, err)
	}
	partial := exec.Command(
		"scripts/prepare-kiln-package.sh",
		"--output", filepath.Join(t.TempDir(), "partial"),
		"--allowed-hosts", "music.example",
	)
	if result, err := partial.CombinedOutput(); err == nil {
		t.Fatalf("partial external package was accepted: %s", result)
	}
	staticOutput := filepath.Join("static", ".review-package-rejected")
	if _, err := os.Stat(staticOutput); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reserved test path already exists: %v", err)
	}
	if result, err := exec.Command(
		"scripts/prepare-kiln-package.sh", "--output", staticOutput,
	).CombinedOutput(); err == nil {
		t.Fatalf("package inside static was accepted: %s", result)
	}
	if _, err := os.Stat(staticOutput); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected package created public output: %v", err)
	}
}

func writeTestPackageManifest(t *testing.T, root string) {
	t.Helper()
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		switch filepath.ToSlash(relative) {
		case "RELEASE", "PACKAGE.SHA256SUMS", ".zak-radio-kiln-package":
			return nil
		}
		paths = append(paths, relative)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(paths)
	var manifest bytes.Buffer
	for _, relative := range paths {
		data, err := os.ReadFile(filepath.Join(root, relative))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		fmt.Fprintf(&manifest, "%x  ./%s\n", digest, filepath.ToSlash(relative))
	}
	manifestPath := filepath.Join(root, "PACKAGE.SHA256SUMS")
	if err := os.WriteFile(manifestPath, manifest.Bytes(), 0o640); err != nil {
		t.Fatal(err)
	}
}

func TestBackupRejectsOutputInsideReleasePackage(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "volume")
	pkg := filepath.Join(root, "release-package")
	if err := os.MkdirAll(source, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(pkg, 0o750); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("scripts/backup-volume.sh",
		"--source", source,
		"--output", filepath.Join(pkg, "backups"),
		"--source-package", pkg,
		"--expected-runtime-release", strings.Repeat("a", 64),
		"--identity-receipt", filepath.Join(root, "receipt"))
	command.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "outside the immutable source package") {
		t.Fatalf("package-contained backup output status=%v output=%s", err, output)
	}
}

func TestRestoreRejectsReceiptEqualToTargetBeforeCreation(t *testing.T) {
	root := t.TempDir()
	backup := filepath.Join(root, "snapshot")
	releasePackage := filepath.Join(root, "release")
	identity := filepath.Join(root, "identity")
	target := filepath.Join(root, "target")
	for _, dir := range []string{backup, releasePackage} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(identity, []byte("identity"), 0o640); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("scripts/restore-volume.sh",
		"--backup", backup, "--target", target,
		"--ownership", "current", "--receipt", target,
		"--release-package", releasePackage, "--identity-receipt", identity)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("restore accepted target equal to receipt: %s", output)
	}
	if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("rejected restore created target/receipt path: %v", statErr)
	}
}

func TestMaintenanceReceiptsUseAtomicDirectoryLocksAndNoReplacePublication(t *testing.T) {
	for _, path := range []string{
		"scripts/backup-volume.sh",
		"scripts/restore-volume.sh",
		"scripts/migrate-volume-ownership.sh",
	} {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, required := range []string{`mkdir -m 0700 "$receipt_lock"`, "ln --"} {
			if !bytes.Contains(source, []byte(required)) {
				t.Fatalf("%s lacks %q receipt protection", path, required)
			}
		}
	}
}

func TestKilnPackageRejectsStaticSymlink(t *testing.T) {
	link := filepath.Join("static", ".review-package-symlink")
	if err := os.Symlink("app.js", link); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	command := exec.Command("scripts/prepare-kiln-package.sh",
		"--output", filepath.Join(t.TempDir(), "package"))
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("package accepted a static symlink: %s", output)
	}
}

func TestStartupRejectsForeignKeyDamageBeforeReadiness(t *testing.T) {
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
	if _, err := db.Exec(`
pragma foreign_keys=off;
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
) values('orphan', 0, 0, 0, 1, 0, '', 0)`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if damaged, err := NewApp(cfg); err == nil {
		damaged.Close()
		t.Fatal("startup accepted a retained database with a foreign-key failure")
	}
}

func TestStartupRejectsOversizedHiddenReaderFieldsBeforeReconciliation(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "oversized-hidden")
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
update reader_items set notes=printf('%*s', ? + 1, 'x') where id='oversized-hidden'
`, maxReaderTextBytes); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if damaged, err := NewApp(cfg); err == nil {
		damaged.Close()
		t.Fatal("startup accepted an oversized hidden Reader field")
	}
}

func TestStartupRejectsReaderTextOverByteBudgetOrContainingNUL(t *testing.T) {
	for _, test := range []struct {
		name string
		text string
	}{
		{name: "multibyte", text: strings.Repeat("😀", maxReaderTextBytes/4+1)},
		{name: "embedded NUL", text: "\x00" + strings.Repeat("a", 32)},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := newTestConfig(t)
			app, err := NewApp(cfg)
			if err != nil {
				t.Fatal(err)
			}
			seedReaderItem(t, app, "reader-byte-budget")
			if _, err := app.db.Exec(
				"update reader_segments set text=? where item_id='reader-byte-budget'", test.text); err != nil {
				t.Fatal(err)
			}
			if err := app.Close(); err != nil {
				t.Fatal(err)
			}
			if reopened, err := NewApp(cfg); err == nil {
				reopened.Close()
				t.Fatal("startup accepted Reader text outside its byte/NUL budget")
			}
		})
	}
}

func TestLegacyPreflightRejectsNULPrefixedText(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "legacy-nul")
	if _, err := app.db.Exec(`
update reader_segments set text=char(0)||printf('%*s', ?, 'x') where item_id='legacy-nul';
pragma user_version=12`, maxReaderTextBytes+1); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := preflightDatabase(context.Background(), cfg.DBPath, info.Size()); err == nil {
		t.Fatal("legacy preflight accepted NUL-prefixed oversized text")
	}
}

func TestHealthPromptlyDetectsClosedDatabase(t *testing.T) {
	app := newTestApp(t)
	app.cancel()
	app.wg.Wait()
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/health", nil)
	result := httptest.NewRecorder()
	app.health(result, request)
	if result.Code != http.StatusServiceUnavailable {
		t.Fatalf("health after database closure status=%d body=%s",
			result.Code, result.Body.String())
	}
}

func TestMigrationHeadroomRejectsImpossibleAvailableSpace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "station.sqlite3")
	if err := ensureMigrationHeadroom(path, 1<<62, true); err == nil {
		t.Fatal("migration headroom accepted an impossible database size")
	}
}

func TestRevisionHeadroomIntegrityRejectsPenultimateCounters(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *App)
	}{
		{
			name: "station",
			mutate: func(t *testing.T, app *App) {
				if _, err := app.db.Exec(
					"update stations set revision=? where id='main'",
					maxRevisionValue-1); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "reader playback",
			mutate: func(t *testing.T, app *App) {
				if _, err := app.db.Exec("pragma foreign_keys=off"); err != nil {
					t.Fatal(err)
				}
				if _, err := app.db.Exec(`
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
) values ('missing', 0, 0, 0, 1, ?, '', 0)`, maxRevisionValue-1); err != nil {
					t.Fatal(err)
				}
				if _, err := app.db.Exec("pragma foreign_keys=on"); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "skip count",
			mutate: func(t *testing.T, app *App) {
				if _, err := app.db.Exec(
					"insert into skip_counts(track_id, skip_count) values ('one', ?)",
					maxRevisionValue-1); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "track stats",
			mutate: func(t *testing.T, app *App) {
				if _, err := app.db.Exec(`
update app_metadata set value=? where key='track_stats_revision'`,
					strconv.FormatInt(maxRevisionValue-1, 10)); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := newTestApp(t)
			test.mutate(t, app)
			if err := revisionHeadroomIntegrity(
				context.Background(), app.db); err == nil {
				t.Fatal("penultimate counter was reported writable")
			}
		})
	}
}

func TestShuffledCatchUpIsAllocationAndStepBounded(t *testing.T) {
	const tracks = maxCatalogTracks
	catalog := Catalog{
		Tracks:    make([]Track, tracks),
		ByID:      make(map[string]*Track, tracks),
		IndexByID: make(map[string]int, tracks),
	}
	for index := range catalog.Tracks {
		catalog.Tracks[index] = Track{
			ID:       fmt.Sprintf("track-%04d", index),
			Duration: minTrackDuration,
		}
		catalog.ByID[catalog.Tracks[index].ID] = &catalog.Tracks[index]
		catalog.IndexByID[catalog.Tracks[index].ID] = index
	}
	randomCalls := 0
	service := &StationService{
		catalog: catalog,
		randomIndex: func(n int) int {
			randomCalls++
			return n / 2
		},
	}
	run := func() {
		randomCalls = 0
		row := Station{
			TrackID:   catalog.Tracks[0].ID,
			Playing:   true,
			Shuffle:   true,
			UpdatedAt: 1,
		}
		changed, err := service.normalizeElapsed(&row, 100_000)
		if err != nil || !changed {
			t.Fatalf("normalize shuffled catch-up: changed=%v err=%v", changed, err)
		}
		if randomCalls > maxShuffleCatchUpSteps+1 {
			t.Fatalf("shuffle catch-up used %d random steps", randomCalls)
		}
	}
	run()
	if allocations := testing.AllocsPerRun(10, run); allocations > 1 {
		t.Fatalf("shuffle catch-up allocated %.1f objects per run", allocations)
	}
}

func TestInterruptedMigrationArtifactsAreCleanedBeforeAdmission(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "station.sqlite3")
	paths := []string{
		filepath.Join(root, ".zak-radio-migration-backup-orphan"),
		filepath.Join(root, ".zak-radio-migration-receipt-orphan"),
	}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cleanupMigrationTemporaryFiles(database); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("interrupted artifact remains at %s: %v", path, err)
		}
	}
	unsafe := filepath.Join(root, ".zak-radio-migration-backup-unsafe")
	if err := os.Symlink("target", unsafe); err != nil {
		t.Fatal(err)
	}
	if err := cleanupMigrationTemporaryFiles(database); err == nil {
		t.Fatal("cleanup accepted a symlinked interrupted artifact")
	}
}

func TestShellRetainedBudgetMatchesProductAndBackupReserves(t *testing.T) {
	root := t.TempDir()
	product := filepath.Join(root, "product.bin")
	backup := filepath.Join(root,
		"station.sqlite3.schema-v12-"+strings.Repeat("a", 64)+".bak")
	if err := os.WriteFile(product, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(product, 9*1024*1024*1024); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(backup, 1024*1024*1024); err != nil {
		t.Fatal(err)
	}
	check := exec.Command("bash", "scripts/check-retained-budget.sh", root)
	if output, err := check.CombinedOutput(); err != nil {
		t.Fatalf("valid 9 GiB + 1 GiB retained budget rejected: %v\n%s", err, output)
	}
	if err := os.Truncate(product, 9*1024*1024*1024+1); err != nil {
		t.Fatal(err)
	}
	check = exec.Command("bash", "scripts/check-retained-budget.sh", root)
	if err := check.Run(); err == nil {
		t.Fatal("product category overflow was accepted")
	}
	if err := os.Truncate(product, 9*1024*1024*1024); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(backup, 1024*1024*1024+1); err != nil {
		t.Fatal(err)
	}
	check = exec.Command("bash", "scripts/check-retained-budget.sh", root)
	if err := check.Run(); err == nil {
		t.Fatal("backup category overflow was accepted")
	}
}

func TestQuiescedVolumeBackupRestoreDrill(t *testing.T) {
	for _, dependency := range []string{"sqlite3", "rsync", "sha256sum"} {
		if _, err := exec.LookPath(dependency); err != nil {
			t.Skipf("%s is unavailable", dependency)
		}
	}
	root := t.TempDir()
	releasePackage := filepath.Join(root, "release-package")
	if output, err := exec.Command("scripts/prepare-kiln-package.sh",
		"--output", releasePackage).CombinedOutput(); err != nil {
		t.Fatalf("prepare release package: %v\n%s", err, output)
	}
	releaseFile := filepath.Join(releasePackage, "RELEASE")
	releaseBytes, err := os.ReadFile(releaseFile)
	if err != nil {
		t.Fatal(err)
	}
	releaseID := strings.TrimSpace(string(releaseBytes))
	identityReceipt := filepath.Join(root, "snapshot-identity-receipt")
	secondIdentityReceipt := filepath.Join(root, "second-snapshot-identity-receipt")
	source := filepath.Join(root, "source")
	output := filepath.Join(root, "backups")
	target := filepath.Join(root, "restored")
	for _, dir := range []string{
		source,
		filepath.Join(source, "music-library"),
		filepath.Join(source, "music-library", "tracks", "one"),
		filepath.Join(source, "reader-library"),
	} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	media := "trusted-media"
	mediaSum := sha256.Sum256([]byte(media))
	for path, data := range map[string]string{
		filepath.Join(source, "curated-tracks.json"): `{"tracks":{}}`,
		filepath.Join(source, "music-library", "index.json"): fmt.Sprintf(
			`{"tracks":[{"id":"one","title":"One","duration":3,"organized_dir":"tracks/one","audio_sha256":"%x"}]}`,
			mediaSum),
		filepath.Join(source, "music-library", "tracks", "one", "audio.mp3"): media,
	} {
		if err := os.WriteFile(path, []byte(data), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("test"), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		MetadataRoot:   source,
		Archive:        filepath.Join(source, "music-library"),
		DBPath:         filepath.Join(source, "station.sqlite3"),
		ReaderLibrary:  filepath.Join(source, "reader-library"),
		StaticDir:      staticDir,
		AllowedHosts:   "loopback",
		AllowedOrigins: "loopback",
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "backup-reader")
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
pragma journal_mode=wal;
insert into app_metadata(key, value) values ('proof', 'committed-in-wal')
on conflict(key) do update set value=excluded.value;`); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	mismatchedBackup := exec.Command("scripts/backup-volume.sh",
		"--source", source, "--output", output,
		"--source-package", releasePackage,
		"--expected-runtime-release", strings.Repeat("f", 64),
		"--identity-receipt", filepath.Join(root, "mismatched-release-receipt"))
	mismatchedBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := mismatchedBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted a package that did not match runtime identity: %s", result)
	}
	externalHardlink := filepath.Join(root, "external-hardlink")
	if err := os.WriteFile(externalHardlink, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	insideHardlink := filepath.Join(source, "outward-hardlink")
	if err := os.Link(externalHardlink, insideHardlink); err != nil {
		t.Fatal(err)
	}
	hardlinkBackup := exec.Command("scripts/backup-volume.sh",
		"--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", filepath.Join(root, "hardlink-receipt"))
	hardlinkBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := hardlinkBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted an outward hard link: %s", result)
	}
	info, err := os.Stat(externalHardlink)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("external hard link mode was mutated to %v", info.Mode())
	}
	if err := os.Remove(insideHardlink); err != nil {
		t.Fatal(err)
	}
	oversized := filepath.Join(source, "oversized-sparse")
	if err := os.WriteFile(oversized, nil, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(oversized, maxRetainedVolumeBytes+1); err != nil {
		t.Fatal(err)
	}
	oversizedTarget := filepath.Join(root, "oversized-bootstrap-target")
	oversizedBootstrap := exec.Command("scripts/bootstrap-volume.sh",
		"--source", source, "--target", oversizedTarget)
	oversizedBootstrap.Env = append(os.Environ(), "ZAK_RADIO_SOURCE_QUIESCED=1")
	if result, err := oversizedBootstrap.CombinedOutput(); err == nil {
		t.Fatalf("bootstrap accepted an oversized retained tree: %s", result)
	}
	if _, err := os.Stat(oversizedTarget); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("oversized bootstrap created its target: %v", err)
	}
	if err := os.Remove(oversized); err != nil {
		t.Fatal(err)
	}
	backup := exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", identityReceipt)
	backup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	backupOutput, err := backup.CombinedOutput()
	if err != nil {
		t.Fatalf("backup failed: %v\n%s", err, backupOutput)
	}
	snapshot := strings.TrimSpace(string(backupOutput))
	secondBackup := exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", secondIdentityReceipt)
	secondBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	secondOutput, err := secondBackup.CombinedOutput()
	if err != nil {
		t.Fatalf("second backup failed: %v\n%s", err, secondOutput)
	}
	secondSnapshot := strings.TrimSpace(string(secondOutput))
	if secondSnapshot == snapshot {
		t.Fatalf("rapid backups collided at %q", snapshot)
	}
	packageReceiptTarget := filepath.Join(root, "package-receipt-target")
	packageReceiptRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", packageReceiptTarget,
		"--ownership", "preserve",
		"--receipt", filepath.Join(releasePackage, "operator-receipt"),
		"--release-package", releasePackage, "--identity-receipt", identityReceipt)
	if result, err := packageReceiptRestore.CombinedOutput(); err == nil {
		t.Fatalf("restore accepted a receipt inside its release package: %s", result)
	}
	if _, err := os.Stat(packageReceiptTarget); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("package-receipt restore created its target: %v", err)
	}
	standaloneTarget := filepath.Join(root, "standalone-release-target")
	standaloneRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", standaloneTarget,
		"--ownership", "preserve", "--receipt", standaloneTarget+".receipt",
		"--release-file", releaseFile, "--identity-receipt", identityReceipt)
	if output, err := standaloneRestore.CombinedOutput(); err == nil {
		t.Fatalf("restore accepted a standalone release file: %s", output)
	}
	insideStoreReceipt := filepath.Join(output, "forged-identity-receipt")
	receiptBytes, err := os.ReadFile(identityReceipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(insideStoreReceipt, receiptBytes, 0o640); err != nil {
		t.Fatal(err)
	}
	insideStoreTarget := filepath.Join(root, "inside-store-receipt-target")
	insideStoreRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", insideStoreTarget,
		"--ownership", "preserve", "--receipt", insideStoreTarget+".receipt",
		"--release-package", releasePackage, "--identity-receipt", insideStoreReceipt)
	if result, err := insideStoreRestore.CombinedOutput(); err == nil {
		t.Fatalf("restore accepted a backup-store identity receipt: %s", result)
	}
	padding := filepath.Join(snapshot, "PADDING")
	if err := os.WriteFile(padding, []byte("unbound"), 0o640); err != nil {
		t.Fatal(err)
	}
	paddingTarget := filepath.Join(root, "padding-target")
	paddingRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", paddingTarget,
		"--ownership", "preserve", "--receipt", paddingTarget+".receipt",
		"--release-package", releasePackage, "--identity-receipt", identityReceipt)
	if result, err := paddingRestore.CombinedOutput(); err == nil {
		t.Fatalf("restore accepted unbound top-level padding: %s", result)
	}
	if err := os.Remove(padding); err != nil {
		t.Fatal(err)
	}
	unsupported := filepath.Join(source, "unsupported-link")
	if err := os.Symlink("curated-tracks.json", unsupported); err != nil {
		t.Fatal(err)
	}
	rejectedBackup := exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", filepath.Join(root, "rejected-link-receipt"))
	rejectedBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := rejectedBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted a symlink: %s", result)
	}
	if err := os.Remove(unsupported); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(source, "unsupported-fifo")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	rejectedBackup = exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", filepath.Join(root, "rejected-fifo-receipt"))
	rejectedBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := rejectedBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted a FIFO: %s", result)
	}
	if err := os.Remove(fifo); err != nil {
		t.Fatal(err)
	}
	unsupportedName := filepath.Join(source, `name\with-backslash`)
	if err := os.WriteFile(unsupportedName, []byte("unsupported"), 0o640); err != nil {
		t.Fatal(err)
	}
	rejectedBackup = exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", filepath.Join(root, "rejected-name-receipt"))
	rejectedBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := rejectedBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted an unsupported filename: %s", result)
	}
	if err := os.Remove(unsupportedName); err != nil {
		t.Fatal(err)
	}
	audioPath := filepath.Join(source, "music-library", "tracks", "one", "audio.mp3")
	if err := os.Remove(audioPath); err != nil {
		t.Fatal(err)
	}
	rejectedBackup = exec.Command("scripts/backup-volume.sh", "--source", source, "--output", output,
		"--source-package", releasePackage, "--expected-runtime-release", releaseID,
		"--identity-receipt", filepath.Join(root, "rejected-media-receipt"))
	rejectedBackup.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
	if result, err := rejectedBackup.CombinedOutput(); err == nil {
		t.Fatalf("backup accepted missing indexed media: %s", result)
	}
	if err := os.WriteFile(audioPath, []byte(media), 0o640); err != nil {
		t.Fatal(err)
	}
	for _, overlap := range []struct {
		name    string
		command *exec.Cmd
		target  string
	}{
		{
			name: "restore target inside snapshot",
			command: exec.Command("scripts/restore-volume.sh",
				"--backup", snapshot, "--target", filepath.Join(snapshot, "inside"),
				"--ownership", "preserve", "--receipt", filepath.Join(root, "overlap-receipt"),
				"--release-package", releasePackage, "--identity-receipt", identityReceipt),
			target: filepath.Join(snapshot, "inside"),
		},
		{
			name: "bootstrap target inside source",
			command: func() *exec.Cmd {
				command := exec.Command("scripts/bootstrap-volume.sh", "--source", source, "--target", filepath.Join(source, "inside"))
				command.Env = append(os.Environ(), "ZAK_RADIO_SOURCE_QUIESCED=1")
				return command
			}(),
			target: filepath.Join(source, "inside"),
		},
	} {
		t.Run(overlap.name, func(t *testing.T) {
			if output, err := overlap.command.CombinedOutput(); err == nil {
				t.Fatalf("overlap accepted: %s", output)
			}
			if _, err := os.Stat(overlap.target); !os.IsNotExist(err) {
				t.Fatalf("overlap created target %q: %v", overlap.target, err)
			}
		})
	}
	malformed := filepath.Join(root, "malformed-snapshot")
	if err := os.MkdirAll(filepath.Join(malformed, "volume"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(malformed, "volume", "marker"), []byte("marker"), 0o640); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("marker"))
	if err := os.WriteFile(filepath.Join(malformed, "SHA256SUMS"),
		[]byte(fmt.Sprintf("%x  ./marker\n", sum)), 0o640); err != nil {
		t.Fatal(err)
	}
	malformedTarget := filepath.Join(root, "malformed-target")
	malformedRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", malformed, "--target", malformedTarget,
		"--ownership", "preserve", "--receipt", malformedTarget+".receipt",
		"--release-package", releasePackage, "--identity-receipt", identityReceipt)
	if output, err := malformedRestore.CombinedOutput(); err == nil {
		t.Fatalf("malformed restore accepted: %s", output)
	}
	if _, err := os.Stat(malformedTarget); !os.IsNotExist(err) {
		t.Fatalf("malformed restore created target: %v", err)
	}
	restore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", target,
		"--ownership", "preserve", "--receipt", target+".restore-receipt",
		"--release-package", releasePackage, "--identity-receipt", identityReceipt)
	if restoreOutput, err := restore.CombinedOutput(); err != nil {
		t.Fatalf("restore failed: %v\n%s", err, restoreOutput)
	}
	restored, err := sql.Open("sqlite", filepath.Join(target, "station.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var proof, check string
	if err := restored.QueryRow(
		"select value from app_metadata where key='proof'").Scan(&proof); err != nil {
		t.Fatal(err)
	}
	if err := restored.QueryRow("pragma quick_check").Scan(&check); err != nil {
		t.Fatal(err)
	}
	if proof != "committed-in-wal" || check != "ok" {
		t.Fatalf("restored proof=%q quick_check=%q", proof, check)
	}
	if data, err := os.ReadFile(filepath.Join(target, "music-library", "tracks", "one", "audio.mp3")); err != nil || string(data) != media {
		t.Fatalf("restored media=%q err=%v", data, err)
	}
	secondTarget := filepath.Join(root, "restored-again")
	repeatRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", snapshot, "--target", secondTarget,
		"--ownership", "preserve", "--receipt", secondTarget+".restore-receipt",
		"--release-package", releasePackage, "--identity-receipt", identityReceipt)
	if output, err := repeatRestore.CombinedOutput(); err != nil {
		t.Fatalf("repeat restore mutated its snapshot: %v\n%s", err, output)
	}
	if os.Geteuid() == 0 {
		rootfulRoot, err := os.MkdirTemp("", "zak-radio-rootful-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(rootfulRoot) })
		if err := os.Chmod(rootfulRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		bootstrapTarget := filepath.Join(rootfulRoot, "bootstrapped-current")
		bootstrap := exec.Command("scripts/bootstrap-volume.sh",
			"--source", source, "--target", bootstrapTarget)
		bootstrap.Env = append(os.Environ(), "ZAK_RADIO_SOURCE_QUIESCED=1")
		if output, err := bootstrap.CombinedOutput(); err != nil {
			t.Fatalf("rootful bootstrap failed: %v\n%s", err, output)
		}
		if output, err := exec.Command(
			"scripts/validate-volume.sh", bootstrapTarget).CombinedOutput(); err != nil {
			t.Fatalf("bootstrapped volume validation failed: %v\n%s", err, output)
		}
		currentTarget := filepath.Join(rootfulRoot, "restored-current")
		currentReceipt := filepath.Join(root, "current-rootful-restore-receipt")
		currentRestore := exec.Command("scripts/restore-volume.sh",
			"--backup", snapshot, "--target", currentTarget,
			"--ownership", "current", "--receipt", currentReceipt,
			"--release-package", releasePackage, "--identity-receipt", identityReceipt)
		if output, err := currentRestore.CombinedOutput(); err != nil {
			t.Fatalf("rootful current-ownership restore failed: %v\n%s", err, output)
		}
		if err := filepath.WalkDir(currentTarget, func(path string, _ os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok {
				return fmt.Errorf("%s has no Unix ownership", path)
			}
			if stat.Uid != 65532 || stat.Gid != 65532 {
				return fmt.Errorf("%s owner=%d:%d", path, stat.Uid, stat.Gid)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}

		migrationTarget := filepath.Join(rootfulRoot, "migration-candidate")
		migrationRestore := exec.Command("scripts/restore-volume.sh",
			"--backup", snapshot, "--target", migrationTarget,
			"--ownership", "preserve", "--receipt", filepath.Join(root, "migration-restore-receipt"),
			"--release-package", releasePackage, "--identity-receipt", identityReceipt)
		if output, err := migrationRestore.CombinedOutput(); err != nil {
			t.Fatalf("migration candidate restore failed: %v\n%s", err, output)
		}
		ownershipReceipt := filepath.Join(root, "ownership-receipt")
		migrate := exec.Command("scripts/migrate-volume-ownership.sh",
			"--volume", migrationTarget, "--backup", snapshot,
			"--source-package", releasePackage,
			"--receipt", ownershipReceipt, "--identity-receipt", identityReceipt)
		migrate.Env = append(os.Environ(), "ZAK_RADIO_SERVICE_QUIESCED=1")
		if output, err := migrate.CombinedOutput(); err != nil {
			t.Fatalf("rootful ownership migration failed: %v\n%s", err, output)
		}
		verify := exec.Command("scripts/verify-ownership-receipt.sh",
			"--volume", migrationTarget, "--receipt", ownershipReceipt)
		if output, err := verify.CombinedOutput(); err != nil {
			t.Fatalf("ownership receipt verification failed: %v\n%s", err, output)
		}
		modeProbe := filepath.Join(migrationTarget, "curated-tracks.json")
		if err := os.Chmod(modeProbe, 0o600); err != nil {
			t.Fatal(err)
		}
		verifyDrift := exec.Command("scripts/verify-ownership-receipt.sh",
			"--volume", migrationTarget, "--receipt", ownershipReceipt)
		if output, err := verifyDrift.CombinedOutput(); err == nil {
			t.Fatalf("ownership receipt accepted mode-only drift: %s", output)
		}
		if err := os.Chmod(modeProbe, 0o640); err != nil {
			t.Fatal(err)
		}
		t.Log("rootful bootstrap, current restore, ownership migration, and receipt verification passed")
	}
	newerDB, err := sql.Open("sqlite", filepath.Join(secondSnapshot, "volume", "station.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newerDB.Exec("pragma user_version=999"); err != nil {
		newerDB.Close()
		t.Fatal(err)
	}
	if err := newerDB.Close(); err != nil {
		t.Fatal(err)
	}
	writeSnapshotChecksums(t, secondSnapshot)
	rewriteSnapshotReceipt(t, secondSnapshot, 999)
	newerTarget := filepath.Join(root, "newer-schema-target")
	newerRestore := exec.Command("scripts/restore-volume.sh",
		"--backup", secondSnapshot, "--target", newerTarget,
		"--ownership", "preserve", "--receipt", newerTarget+".receipt",
		"--release-package", releasePackage, "--identity-receipt", secondIdentityReceipt)
	if output, err := newerRestore.CombinedOutput(); err == nil {
		t.Fatalf("newer schema restore was accepted: %s", output)
	}
	if _, err := os.Stat(newerTarget); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected newer schema created target: %v", err)
	}
}

func writeSnapshotChecksums(t *testing.T, snapshot string) {
	t.Helper()
	volume := filepath.Join(snapshot, "volume")
	lines := []string{}
	if err := filepath.WalkDir(volume, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(volume, path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		lines = append(lines, fmt.Sprintf("%x  ./%s\n", sum, filepath.ToSlash(relative)))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sort.Strings(lines)
	if err := os.WriteFile(filepath.Join(snapshot, "SHA256SUMS"), []byte(strings.Join(lines, "")), 0o640); err != nil {
		t.Fatal(err)
	}
}

func rewriteSnapshotReceipt(t *testing.T, snapshot string, schema int) {
	t.Helper()
	receiptPath := filepath.Join(snapshot, "RECEIPT")
	original, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	field := func(name string) string {
		for _, line := range strings.Split(string(original), "\n") {
			if strings.HasPrefix(line, name+"=") {
				return strings.TrimPrefix(line, name+"=")
			}
		}
		return ""
	}
	created, sourceRelease := field("created_at"), field("source_release")
	if created == "" || sourceRelease == "" {
		t.Fatal("snapshot receipt lacks source fields")
	}
	checksums, err := os.ReadFile(filepath.Join(snapshot, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	ownerModes, err := os.ReadFile(filepath.Join(snapshot, "OWNER_MODES"))
	if err != nil {
		t.Fatal(err)
	}
	fields := fmt.Sprintf("created_at=%s\nschema_version=%d\nsource_release=%s\n",
		created, schema, sourceRelease)
	identityInput := append(append(append([]byte{}, checksums...), ownerModes...), []byte(fields)...)
	identity := sha256.Sum256(identityInput)
	if err := os.WriteFile(receiptPath,
		[]byte(fields+fmt.Sprintf("snapshot_identity=%x\n", identity)), 0o640); err != nil {
		t.Fatal(err)
	}
}
