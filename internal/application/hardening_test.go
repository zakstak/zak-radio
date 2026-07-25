package application

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNamespaceRootMappingDetection(t *testing.T) {
	for _, test := range []struct {
		name    string
		mapping string
		want    bool
		wantErr bool
	}{
		{"rootless", "         0       1000          1\n         1     100000      65536\n", true, false},
		{"host root", "         0          0 4294967295\n", false, false},
		{"missing root", "         1     100000      65536\n", false, true},
		{"malformed", "not a uid map\n", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := namespaceRootMapsToUnprivileged(strings.NewReader(test.mapping))
			if (err != nil) != test.wantErr || got != test.want {
				t.Fatalf("namespaceRootMapsToUnprivileged()=(%v, %v), want (%v, error=%v)",
					got, err, test.want, test.wantErr)
			}
		})
	}
}

func TestLoopbackHealthAllowsOnlyExplicitRootlessIngressPeer(t *testing.T) {
	handler := secureHTTPConfig(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
		"loopback",
		"loopback",
		"10.0.1.110",
		"10.0.1.110",
		64,
	)
	for _, test := range []struct {
		name       string
		remoteAddr string
		want       int
	}{
		{"Kiln rootless forwarder", "10.0.1.110:54321", http.StatusNoContent},
		{"untrusted peer", "10.0.1.111:54321", http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/health", nil)
			request.RemoteAddr = test.remoteAddr
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d, want %d; body=%s",
					response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestTrustedKilnProxyPreservesBrowserOriginThroughForwardedHost(t *testing.T) {
	handler := secureHTTPConfig(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
		"radio.example,loopback",
		"https://radio.example,loopback",
		"10.0.1.110",
		"10.0.1.110",
		64,
	)
	request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/control", nil)
	request.Host = "127.0.0.1:29279"
	request.RemoteAddr = "10.0.1.110:54321"
	request.Header.Set("Origin", "https://radio.example")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	request.Header.Set("X-Forwarded-Host", "radio.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d, want %d; body=%s",
			response.Code, http.StatusNoContent, response.Body.String())
	}
}

func TestForwardedHostRequiresTrustedProxyAndAllowedHost(t *testing.T) {
	handler := secureHTTPConfig(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
		"radio.example,loopback",
		"https://radio.example,loopback",
		"10.0.1.110",
		"*",
		64,
	)
	for _, test := range []struct {
		name          string
		remoteAddr    string
		forwardedHost string
		want          int
	}{
		{"untrusted proxy", "10.0.1.111:54321", "radio.example", http.StatusForbidden},
		{"disallowed host", "10.0.1.110:54321", "attacker.example", http.StatusMisdirectedRequest},
		{"multiple hosts", "10.0.1.110:54321", "radio.example, attacker.example", http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/api/control", nil)
			request.Host = "127.0.0.1:29279"
			request.RemoteAddr = test.remoteAddr
			request.Header.Set("Origin", "https://radio.example")
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			request.Header.Set("X-Forwarded-Host", test.forwardedHost)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d, want %d; body=%s",
					response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestReaderWriterSequenceMigrationDropsLegacyOrphans(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
create table reader_items (id text primary key);
create table reader_playback (
	item_id text primary key,
	segment_index integer not null default 0,
	position real not null default 0,
	playing integer not null default 0,
	updated_at real not null,
	revision integer not null default 0 check(revision >= 0)
);
insert into reader_items(id) values ('valid');
insert into reader_playback(item_id, updated_at) values
	('valid', 1), ('None', 2), ('null', 3);`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := addReaderPlaybackWriterSequence(context.Background(), tx); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`select count(*) from reader_playback`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("reader_playback retained %d rows, want only the valid row", count)
	}
	var itemID, writerID string
	var writerSequence int
	if err := db.QueryRow(`
select item_id, writer_id, writer_sequence from reader_playback`).
		Scan(&itemID, &writerID, &writerSequence); err != nil {
		t.Fatal(err)
	}
	if itemID != "valid" || writerID != "" || writerSequence != 0 {
		t.Fatalf("migrated playback=(%q, %q, %d)", itemID, writerID, writerSequence)
	}
}

func TestCatalogRejectsSubPrecisionDurationAndOversizedAudio(t *testing.T) {
	t.Run("duration", func(t *testing.T) {
		cfg := newTestConfig(t)
		indexPath := filepath.Join(cfg.Archive, "index.json")
		index, err := os.ReadFile(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		index = bytes.Replace(index, []byte(`"duration":10`), []byte(`"duration":1e-300`), 1)
		if err := os.WriteFile(indexPath, index, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "operational minimum") {
			t.Fatalf("sub-precision duration was accepted: %v", err)
		}
	})
	t.Run("duration maximum", func(t *testing.T) {
		cfg := newTestConfig(t)
		indexPath := filepath.Join(cfg.Archive, "index.json")
		index, err := os.ReadFile(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		index = bytes.Replace(index, []byte(`"duration":10`),
			[]byte(fmt.Sprintf(`"duration":%g`, maxStationDuration+1)), 1)
		if err := os.WriteFile(indexPath, index, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "operational maximum") {
			t.Fatalf("over-maximum duration was accepted: %v", err)
		}
	})
	t.Run("artifact size metadata", func(t *testing.T) {
		cfg := newTestConfig(t)
		audio := filepath.Join(cfg.Archive, "tracks", "one", "audio.mp3")
		if err := os.Truncate(audio, maxAudioArtifactBytes+1); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "per-artifact") {
			t.Fatalf("oversized audio was accepted: %v", err)
		}
	})
}

func TestStationNormalizationIsBoundedAcrossLargeElapsedCycles(t *testing.T) {
	app := newTestApp(t)
	row, err := readStation(context.Background(), app.db, mainStationID, 0)
	if err != nil {
		t.Fatal(err)
	}
	row.Playing = true
	row.Position = 0
	row.UpdatedAt = 0
	changed, err := app.station.normalizeElapsed(&row, 1e12)
	if err != nil || !changed || row.Position < 0 || row.Position >= app.station.duration(row.TrackID) {
		t.Fatalf("large elapsed normalization changed=%v row=%#v err=%v", changed, row, err)
	}
}

func TestReaderSameWriterSequencePreservesNewestLifecycleSave(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-sequence")
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/reader/playback", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.setReaderPlayback(res, req)
		return res
	}
	writer := strings.Repeat("a", 32)
	if res := post(fmt.Sprintf(`{"item_id":"reader-sequence","segment_index":0,"position":1,"playing":true,"base_revision":0,"writer_id":%q,"writer_sequence":1}`, writer)); res.Code != http.StatusOK {
		t.Fatalf("initial save status=%d body=%s", res.Code, res.Body.String())
	}
	if res := post(fmt.Sprintf(`{"item_id":"reader-sequence","segment_index":0,"position":4,"playing":false,"base_revision":0,"writer_id":%q,"writer_sequence":3}`, writer)); res.Code != http.StatusOK {
		t.Fatalf("newer same-writer save status=%d body=%s", res.Code, res.Body.String())
	}
	if res := post(fmt.Sprintf(`{"item_id":"reader-sequence","segment_index":0,"position":2,"playing":true,"base_revision":0,"writer_id":%q,"writer_sequence":2}`, writer)); res.Code != http.StatusOK {
		t.Fatalf("late older save status=%d body=%s", res.Code, res.Body.String())
	}
	var position float64
	var sequence int64
	if err := app.db.QueryRow(`
select position, writer_sequence from reader_playback where item_id='reader-sequence'`).
		Scan(&position, &sequence); err != nil {
		t.Fatal(err)
	}
	if position != 4 || sequence != 3 {
		t.Fatalf("late save regressed position=%v sequence=%d", position, sequence)
	}
	other := strings.Repeat("b", 32)
	if res := post(fmt.Sprintf(`{"item_id":"reader-sequence","segment_index":0,"position":3,"playing":false,"base_revision":0,"writer_id":%q,"writer_sequence":1}`, other)); res.Code != http.StatusConflict {
		t.Fatalf("genuinely stale writer status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestCanonicalSchemaRejectsUnexpectedTrigger(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(`
create trigger destructive after update of playing on stations
begin delete from reader_items; end`); err != nil {
		t.Fatal(err)
	}
	if err := validateCanonicalSchema(context.Background(), app.db); err == nil ||
		!strings.Contains(err.Error(), "trigger") {
		t.Fatalf("destructive trigger passed schema validation: %v", err)
	}
}

func TestCanonicalSchemaRejectsUnexpectedTable(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(`create table foreign_state(secret text)`); err != nil {
		t.Fatal(err)
	}
	if err := validateCanonicalSchema(context.Background(), app.db); err == nil ||
		!strings.Contains(err.Error(), "unexpected table") {
		t.Fatalf("unexpected table passed schema validation: %v", err)
	}
}

func TestRetainedAdmissionRejectsNumericBlob(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`update stations set position=x'00' where id='main'`); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := NewApp(cfg); err == nil {
		reopened.Close()
		t.Fatal("numeric BLOB passed retained-data admission")
	}
}

func TestLegacyPreflightRejectsOversizedFieldBeforeBackup(t *testing.T) {
	cfg := newTestConfig(t)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
create table station (
	id integer primary key, track_id text not null, position real not null,
	playing integer not null, updated_at real not null, track_changed_at real not null
);
insert into station values (1, ?, 0, 0, 1, 1)`,
		strings.Repeat("x", maxTrackTextBytes+1)); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if app, err := NewApp(cfg); err == nil {
		app.Close()
		t.Fatal("oversized legacy field reached migration")
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v*.bak")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 0 {
		t.Fatalf("preflight rejection created migration backup: %v", backups)
	}
}

func TestLegacyPreflightReadsCommittedWALBeforeBackup(t *testing.T) {
	cfg := newTestConfig(t)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`
pragma journal_mode=wal;
pragma wal_autocheckpoint=0;
create table station (
	id integer primary key, track_id text not null, position real not null,
	playing integer not null, updated_at real not null, track_changed_at real not null
);
insert into station values (1, ?, 0, 0, 1, 1)`,
		strings.Repeat("x", maxTrackTextBytes+1)); err != nil {
		t.Fatal(err)
	}
	if _, err := openDatabase(context.Background(), cfg.DBPath, cfg.MetadataRoot); err == nil {
		t.Fatal("oversized field committed only in WAL passed pre-migration admission")
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v*.bak")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 0 {
		t.Fatalf("WAL preflight rejection created migration backup: %v", backups)
	}
}

func TestOccupiedPortLeavesLegacyDatabaseUnmigrated(t *testing.T) {
	cfg := newTestConfig(t)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`create table legacy_marker(value text); insert into legacy_marker values ('unchanged')`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	binary := filepath.Join(t.TempDir(), "zak-radio")
	build := exec.Command("go", "build", "-o", binary, "./cmd/zak-radio")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build test binary: %v\n%s", err, output)
	}
	command := exec.Command(binary,
		"--host", "127.0.0.1", "--port", fmt.Sprint(port),
		"--archive", cfg.Archive, "--db", cfg.DBPath,
		"--reader-library", cfg.ReaderLibrary)
	command.Env = append(os.Environ(),
		"ZAK_RADIO_METADATA_ROOT="+cfg.MetadataRoot,
		"ZAK_RADIO_STATIC="+cfg.StaticDir)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("server unexpectedly acquired occupied port: %s", output)
	}
	after, err := os.ReadFile(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("occupied-port startup mutated the legacy database")
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v*.bak")
	if err != nil || len(backups) != 0 {
		t.Fatalf("occupied-port startup created migration backup=%v err=%v", backups, err)
	}
}

func TestStationClockNeverRegresses(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_900_000_000, 0)
	times := []time.Time{fixed, fixed.Add(10 * time.Second), fixed.Add(2 * time.Second)}
	index := 0
	app.station.clockMu.Lock()
	app.station.clockHigh = 0
	app.station.clockMu.Unlock()
	app.station.clock = func() time.Time {
		value := times[index]
		index++
		return value
	}
	monotonic := time.Unix(1, 0)
	app.station.clockSample = monotonic
	app.station.monotonic = func() time.Time { return monotonic }
	var serverTimes []float64
	for range times {
		snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
		if err != nil {
			t.Fatal(err)
		}
		serverTimes = append(serverTimes, snapshot.ServerTime)
	}
	if serverTimes[0] != unixTime(fixed) ||
		serverTimes[1] != unixTime(fixed.Add(10*time.Second)) ||
		serverTimes[2] != serverTimes[1] {
		t.Fatalf("logical clock regressed: %v", serverTimes)
	}
}

func TestLastRestartableRevisionCannotCommitInvalidTerminalState(t *testing.T) {
	app := newTestApp(t)
	boundary := maxRevisionValue - 3
	if _, err := app.db.Exec(
		"update stations set revision=? where id='main'", boundary); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/control",
		strings.NewReader(`{"station_id":"main","action":"set_shuffle","shuffle":true}`))
	request.Header.Set("Content-Type", "application/json")
	result := httptest.NewRecorder()
	app.apiControl(result, request)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("boundary station mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var revision int64
	var shuffle int
	if err := app.db.QueryRow(
		"select revision, shuffle from stations where id='main'").
		Scan(&revision, &shuffle); err != nil {
		t.Fatal(err)
	}
	if revision != boundary || shuffle != 1 {
		t.Fatalf("boundary station mutation committed revision=%d shuffle=%d",
			revision, shuffle)
	}
	health := httptest.NewRecorder()
	app.health(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("rejected boundary mutation damaged health: %d %s",
			health.Code, health.Body.String())
	}

	if _, err := app.db.Exec(`
update stations set revision=1 where id='main';
update app_metadata set value=? where key='track_stats_revision'`,
		strconv.FormatInt(boundary, 10)); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/like",
		strings.NewReader(`{"track_id":"one"}`))
	request.Header.Set("Content-Type", "application/json")
	result = httptest.NewRecorder()
	app.apiLike(result, request)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("boundary track-stat mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var likes int
	if err := app.db.QueryRow(
		"select count(*) from likes where track_id='one'").Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes != 0 {
		t.Fatal("like committed with boundary track-stat revision")
	}

	seedReaderItem(t, app, "boundary-reader")
	if _, err := app.db.Exec(`
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
	) values ('boundary-reader', 0, 0, 0, ?, ?, '', 0)`,
		unixTime(time.Now()), boundary); err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/reader/playback",
		strings.NewReader(fmt.Sprintf(
			`{"item_id":"boundary-reader","segment_index":0,"position":1,"playing":false,"base_revision":%d}`,
			boundary)))
	request.Header.Set("Content-Type", "application/json")
	result = httptest.NewRecorder()
	app.setReaderPlayback(result, request)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("boundary Reader mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var position float64
	if err := app.db.QueryRow(`
select revision, position from reader_playback where item_id='boundary-reader'`).
		Scan(&revision, &position); err != nil {
		t.Fatal(err)
	}
	if revision != boundary || position != 0 {
		t.Fatalf("boundary Reader mutation committed revision=%d position=%v",
			revision, position)
	}
}

func TestCatalogIdentityVersionsStationAndMedia(t *testing.T) {
	app := newTestApp(t)
	tracks := httptest.NewRecorder()
	app.apiTracks(tracks, httptest.NewRequest(http.MethodGet, "/api/tracks", nil))
	var payload struct {
		CatalogRevision string  `json:"catalog_revision"`
		Tracks          []Track `json:"tracks"`
	}
	if err := json.Unmarshal(tracks.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !sha256Pattern.MatchString(payload.CatalogRevision) ||
		payload.CatalogRevision != app.catalog.Revision {
		t.Fatalf("catalog revision=%q app=%q",
			payload.CatalogRevision, app.catalog.Revision)
	}
	snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.CatalogRevision != payload.CatalogRevision {
		t.Fatalf("station catalog revision=%q tracks=%q",
			snapshot.CatalogRevision, payload.CatalogRevision)
	}
	media := httptest.NewRecorder()
	app.media(media, httptest.NewRequest(http.MethodGet, "/media/one/audio", nil))
	wantETag := `"sha256-` + payload.Tracks[0].AudioSHA256 + `"`
	if media.Header().Get("ETag") != wantETag {
		t.Fatalf("media ETag=%q want=%q", media.Header().Get("ETag"), wantETag)
	}
}

func TestMigrationRejectsUnrelatedPreexistingBackup(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if _, err := app.db.Exec("pragma wal_checkpoint(truncate)"); err != nil {
		t.Fatal(err)
	}
	sourceDigest, err := fileSHA256(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	backup := fmt.Sprintf(
		"%s.schema-v%d-%s.bak", cfg.DBPath, currentSchemaVersion, sourceDigest)
	unrelated, err := sql.Open("sqlite", backup)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unrelated.Exec("create table unrelated(value text)"); err != nil {
		unrelated.Close()
		t.Fatal(err)
	}
	if err := unrelated.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := backupBeforeMigration(
		context.Background(), app.db, cfg.DBPath, cfg.MetadataRoot,
		currentSchemaVersion,
	); err == nil || !strings.Contains(err.Error(), "not an exact copy") {
		t.Fatalf("unrelated preexisting backup was adopted: %v", err)
	}
}

func TestMigrationFinalizationIsScopedAndRetryable(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	protected, err := backupBeforeMigration(
		context.Background(), app.db, cfg.DBPath, cfg.MetadataRoot,
		currentSchemaVersion,
	)
	if err != nil {
		app.Close()
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	obsolete := cfg.DBPath + ".schema-v0-" + strings.Repeat("b", 64) + ".bak"
	if err := os.Mkdir(obsolete, 0o700); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(
		filepath.Dir(cfg.DBPath),
		"other.sqlite3.schema-v0-"+strings.Repeat("c", 64)+".bak",
	)
	if err := os.WriteFile(unrelated, []byte("unrelated"), 0o600); err != nil {
		t.Fatal(err)
	}
	receipt := migrationBackupReceiptPath(cfg.DBPath)
	if err := clearMigrationBackupReceipt(context.Background(), cfg.DBPath); err == nil {
		t.Fatal("unsafe obsolete backup did not block finalization")
	}
	if _, err := os.Stat(receipt); err != nil {
		t.Fatalf("failed cleanup removed its retry receipt: %v", err)
	}
	if err := os.Remove(obsolete); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(obsolete, []byte("obsolete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := clearMigrationBackupReceipt(context.Background(), cfg.DBPath); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"protected": protected,
		"unrelated": unrelated,
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s backup was retired: %v", name, err)
		}
	}
	if _, err := os.Stat(obsolete); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("obsolete database backup survived: %v", err)
	}
	if _, err := os.Stat(receipt); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed cleanup retained receipt: %v", err)
	}
}

func TestRuntimeVolumeLockAllowsRollingDeploymentPeer(t *testing.T) {
	cfg := newTestConfig(t)
	first, err := acquireRuntimeVolumeLock(cfg.MetadataRoot)
	if err != nil {
		t.Fatal(err)
	}
	second, err := acquireRuntimeVolumeLock(cfg.MetadataRoot)
	if err != nil {
		first.Close()
		t.Fatalf("rolling deployment peer could not acquire runtime lock: %v", err)
	}
	if err := second.Close(); err != nil {
		first.Close()
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := acquireRuntimeVolumeLock(cfg.MetadataRoot)
	if err != nil {
		t.Fatalf("released lifecycle lock could not be reacquired: %v", err)
	}
	reopened.Close()
}

func TestInheritedVolumeLockRejectsUnrelatedDescriptor(t *testing.T) {
	root := t.TempDir()
	rootHandle, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer rootHandle.Close()
	unrelated, err := os.Open("/dev/null")
	if err != nil {
		t.Fatal(err)
	}
	defer unrelated.Close()
	command := exec.Command(
		"python3", "scripts/with-volume-lock.py", "--verify", root,
	)
	command.ExtraFiles = []*os.File{rootHandle, unrelated}
	command.Env = append(os.Environ(),
		"ZAK_RADIO_VOLUME_ROOT_FD=3",
		"ZAK_RADIO_VOLUME_LOCK_FD=4",
	)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("unrelated inherited lock descriptor was accepted: %s", output)
	}
}

func TestDirectVolumeValidationIncludesFilesystemAdmission(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(cfg.MetadataRoot, "unreferenced")
	second := filepath.Join(cfg.MetadataRoot, "unreferenced-hardlink")
	if err := os.WriteFile(first, []byte("retained"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(first, second); err != nil {
		t.Fatal(err)
	}
	if err := validateVolume(context.Background(), cfg.MetadataRoot); err == nil ||
		!strings.Contains(err.Error(), "hard-linked") {
		t.Fatalf("direct volume validation accepted hard links: %v", err)
	}
}

func TestLegacyPreflightRejectsGeneratedColumnsBeforeBackup(t *testing.T) {
	cfg := newTestConfig(t)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
create table station (
	id integer primary key,
	track_id text not null,
	position real not null,
	playing integer not null,
	updated_at real not null,
	track_changed_at real not null,
	expanded text generated always as (hex(zeroblob(1048576))) virtual
);
insert into station(id, track_id, position, playing, updated_at, track_changed_at)
values (1, 'one', 0, 0, 1, 1);
pragma user_version=0`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := preflightDatabase(
		context.Background(), cfg.DBPath, info.Size(),
	); err == nil || !strings.Contains(err.Error(), "generated or hidden") {
		t.Fatalf("generated legacy column passed bounded preflight: %v", err)
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v*.bak")
	if err != nil || len(backups) != 0 {
		t.Fatalf("generated-column rejection created backup=%v err=%v", backups, err)
	}
}

func TestReaderJSONFieldsRequireBoundedStringArrays(t *testing.T) {
	tests := []struct {
		name   string
		mutate string
	}{
		{"scalar warnings", `update reader_items set quality_warnings='"warning"' where id='shape'`},
		{"object warnings", `update reader_items set quality_warnings='{"warning":true}' where id='shape'`},
		{"malformed warnings", `update reader_items set quality_warnings='[' where id='shape'`},
		{"scalar heading", `update reader_segments set heading_path='"chapter"' where item_id='shape'`},
		{"object heading", `update reader_segments set heading_path='{"chapter":1}' where item_id='shape'`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := newTestConfig(t)
			app, err := NewApp(cfg)
			if err != nil {
				t.Fatal(err)
			}
			seedReaderItem(t, app, "shape")
			if _, err := app.db.Exec(test.mutate); err != nil {
				app.Close()
				t.Fatal(err)
			}
			if err := app.Close(); err != nil {
				t.Fatal(err)
			}
			if reopened, err := NewApp(cfg); err == nil {
				reopened.Close()
				t.Fatalf("startup accepted %s", test.name)
			}
		})
	}
}

func TestCatalogDecodersStopAtCardinalityLimit(t *testing.T) {
	var index strings.Builder
	index.WriteString(`{"tracks":[`)
	for item := 0; item <= maxCatalogTracks; item++ {
		if item > 0 {
			index.WriteByte(',')
		}
		index.WriteString(`{}`)
	}
	index.WriteString(`]}`)
	if _, err := decodeArchiveIndex([]byte(index.String())); err == nil ||
		!strings.Contains(err.Error(), "track count") {
		t.Fatalf("over-cardinality archive result=%v", err)
	}

	var curated strings.Builder
	curated.WriteString(`{"tracks":{`)
	for item := 0; item <= maxCatalogTracks; item++ {
		if item > 0 {
			curated.WriteByte(',')
		}
		fmt.Fprintf(&curated, "%q:{}", fmt.Sprintf("track-%d", item))
	}
	curated.WriteString(`}}`)
	if _, err := decodeCuratedFile([]byte(curated.String())); err == nil ||
		!strings.Contains(err.Error(), "track count") {
		t.Fatalf("over-cardinality curated result=%v", err)
	}
}

func TestRouteMethodMatrixDistinguishesKnownResources(t *testing.T) {
	app := newTestApp(t)
	tests := []struct {
		method, path string
		status       int
		allow        string
	}{
		{http.MethodPost, "/api/tracks", http.StatusMethodNotAllowed, "GET"},
		{http.MethodGet, "/api/stations", http.StatusMethodNotAllowed, "POST"},
		{http.MethodPut, "/api/station", http.StatusMethodNotAllowed, "GET"},
		{http.MethodHead, "/apix", http.StatusNotFound, ""},
		{http.MethodGet, "/api/not-a-resource", http.StatusNotFound, ""},
	}
	for _, test := range tests {
		request := httptest.NewRequest(test.method, test.path, nil)
		request.Host = "localhost"
		request.RemoteAddr = "127.0.0.1:1234"
		if test.method != http.MethodGet && test.method != http.MethodHead {
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "http://localhost")
			request.Header.Set("Sec-Fetch-Site", "same-origin")
		}
		result := httptest.NewRecorder()
		app.routes().ServeHTTP(result, request)
		if result.Code != test.status || result.Header().Get("Allow") != test.allow {
			t.Fatalf("%s %s status=%d allow=%q, want %d %q",
				test.method, test.path, result.Code, result.Header().Get("Allow"),
				test.status, test.allow)
		}
	}
}

func TestLoopbackSentinelIsNotALiteralAllowedHost(t *testing.T) {
	app := newTestApp(t)
	request := httptest.NewRequest(http.MethodGet, "/live", nil)
	request.Host = "loopback"
	request.RemoteAddr = "192.0.2.10:1234"
	result := httptest.NewRecorder()
	app.routes().ServeHTTP(result, request)
	if result.Code != http.StatusMisdirectedRequest {
		t.Fatalf("literal loopback Host status=%d body=%s",
			result.Code, result.Body.String())
	}
}

func TestMigrationBackupIsIdempotentAndUsesDurableReserve(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := backupBeforeMigration(
			context.Background(), app.db, cfg.DBPath, cfg.MetadataRoot,
			currentSchemaVersion,
		); err != nil {
			app.Close()
			t.Fatalf("protected backup attempt %d: %v", attempt+1, err)
		}
	}
	if _, err := app.db.Exec(
		"update stations set updated_at=updated_at+1 where id='main'"); err != nil {
		app.Close()
		t.Fatal(err)
	}
	if _, err := backupBeforeMigration(
		context.Background(), app.db, cfg.DBPath, cfg.MetadataRoot,
		currentSchemaVersion,
	); err == nil || !strings.Contains(err.Error(), "does not match the live source") {
		app.Close()
		t.Fatalf("stale same-version migration receipt was reused: %v", err)
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v*.bak")
	if err != nil || len(backups) != 1 {
		app.Close()
		t.Fatalf("idempotent backups=%v err=%v", backups, err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	usage, err := inspectRetainedTree(cfg.MetadataRoot)
	if err != nil {
		t.Fatal(err)
	}
	fillerBytes := maxRetainedProductBytes - usage.productBytes
	if fillerBytes <= 0 {
		t.Fatalf("fixture unexpectedly exhausts product budget: %#v", usage)
	}
	filler := filepath.Join(cfg.MetadataRoot, "capacity-filler")
	if err := os.WriteFile(filler, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(filler, fillerBytes); err != nil {
		t.Fatal(err)
	}
	if err := validateRetainedTreeBudget(cfg.MetadataRoot); err != nil {
		t.Fatalf("valid product-plus-backup budget rejected: %v", err)
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatalf("post-backup near-boundary volume did not restart: %v", err)
	}
	defer reopened.Close()
}

func TestPlayingAtExactEOFCanonicalizesBeforeCommit(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_900_000_000, 0)
	app.station.clockMu.Lock()
	app.station.clockHigh = unixTime(fixed)
	app.station.clockMu.Unlock()
	freezeStationClockForTest(app.station, fixed)
	if _, err := app.db.Exec(`
update stations set track_id='one', position=10, playing=0, updated_at=?,
	track_changed_at=? where id=?`, unixTime(fixed), unixTime(fixed)-10, mainStationID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.station.Execute(context.Background(), Command{Action: "play"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != "two" || snapshot.Position != 0 || !snapshot.Playing {
		t.Fatalf("exact-EOF play committed a transient state: %#v", snapshot)
	}
	var track string
	var position float64
	if err := app.db.QueryRow(
		`select track_id, position from stations where id=?`, mainStationID).
		Scan(&track, &position); err != nil {
		t.Fatal(err)
	}
	if track != "two" || position != 0 {
		t.Fatalf("exact-EOF persisted track=%q position=%v", track, position)
	}
}

func TestBroadcasterForgetReleasesTopicRevision(t *testing.T) {
	events := NewBroadcaster()
	events.PublishValue("expired", map[string]any{"revision": int64(7)})
	events.Forget("expired")
	_, retained := events.Revision("expired")
	if retained {
		t.Fatal("forgotten topic retained its revision high-water mark")
	}
}

func TestStationEventReconnectStartsFromCurrentRevision(t *testing.T) {
	app := newTestApp(t)
	server := httptest.NewServer(app.routes())
	defer server.Close()
	readInitial := func() Snapshot {
		t.Helper()
		ctx, cancel := context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			server.URL+"/api/station/events", nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		defer response.Body.Close()
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var snapshot Snapshot
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &snapshot) == nil &&
				snapshot.StationID == mainStationID {
				cancel()
				return snapshot
			}
		}
		cancel()
		t.Fatalf("station stream ended before its initial snapshot: %v", scanner.Err())
		return Snapshot{}
	}
	first := readInitial()
	if _, err := app.station.Execute(context.Background(), Command{Action: "play"}); err != nil {
		t.Fatal(err)
	}
	reconnected := readInitial()
	if reconnected.Revision <= first.Revision || !reconnected.Playing {
		t.Fatalf("reconnect first=%#v current=%#v", first, reconnected)
	}
}

func TestStartupReadinessWaitsForCompleteDigestAudit(t *testing.T) {
	cfg := newTestConfig(t)
	audio := filepath.Join(cfg.Archive, "tracks", "two", "audio.mp3")
	if err := os.WriteFile(audio, []byte("audip"), 0o644); err != nil {
		t.Fatal(err)
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	res := httptest.NewRecorder()
	app.health(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("corrupt startup media became ready: %d %s", res.Code, res.Body.String())
	}
}

func TestExternalHostsRequireAuthorizedIngressAndIPv6Buckets(t *testing.T) {
	called := false
	handler := secureHTTPConfig(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}), "radio.example", "https://radio.example", "10.0.0.2", "10.0.0.2", 64)
	for _, test := range []struct {
		remote string
		status int
	}{
		{"10.0.0.3:1234", http.StatusForbidden},
		{"10.0.0.2:1234", http.StatusNoContent},
	} {
		called = false
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = "radio.example"
		req.RemoteAddr = test.remote
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != test.status || called != (test.status == http.StatusNoContent) {
			t.Fatalf("peer %s status=%d called=%v", test.remote, res.Code, called)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "[2001:db8::10]:1234"
	if got := clientAddressWithPrefix(request, "", 64); got != "2001:db8::/64" {
		t.Fatalf("IPv6 client bucket=%q", got)
	}
	request.RemoteAddr = "[2001:db8::20]:1234"
	if got := clientAddressWithPrefix(request, "", 64); got != "2001:db8::/64" {
		t.Fatalf("rotated IPv6 client bucket=%q", got)
	}
}

func TestHealthUsesMaintainedReadinessSnapshot(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	res := httptest.NewRecorder()
	app.health(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("health status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Checks map[string]bool `json:"checks"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, check := range []string{"database_runtime", "journal", "writable"} {
		if !payload.Checks[check] {
			t.Fatalf("maintained readiness lost passing %s result: %#v", check, payload.Checks)
		}
	}
}

func TestTrailingOversizedJSONMapsToPayloadTooLarge(t *testing.T) {
	app := newTestApp(t)
	body := `{"track_id":"one"}` + strings.Repeat(" ", maxJSONBodyBytes)
	req := httptest.NewRequest(http.MethodPost, "/api/like", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiLike(res, req)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("trailing oversized JSON status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestStationEventStartsAreRateLimited(t *testing.T) {
	handler := secureHTTPConfig(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), "loopback", "loopback", "", "", 64)
	for attempt := 1; attempt <= 25; attempt++ {
		req := httptest.NewRequest(http.MethodGet, "/api/station/events", nil)
		req.Host = "localhost"
		req.RemoteAddr = "127.0.0.1:1234"
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		want := http.StatusNoContent
		if attempt == 25 {
			want = http.StatusTooManyRequests
		}
		if res.Code != want {
			t.Fatalf("event start %d status=%d want=%d body=%s",
				attempt, res.Code, want, res.Body.String())
		}
	}
}

func TestReaderSourceDownloadAndRetainedValidationAreBounded(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "bounded-source")
	if err := os.Truncate(source, maxReaderSourceBytes+1); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/reader-source/bounded-source/source", nil)
	res := httptest.NewRecorder()
	app.readerSource(res, req)
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("oversized source download status=%d body=%s", res.Code, res.Body.String())
	}
	if err := validateReaderVolume(
		context.Background(), app.db, app.readerRoot, app.cfg.ReaderLibrary,
	); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("oversized source passed retained validation: %v", err)
	}
}

func TestDeletedReaderArtifactCannotPinDigestReadiness(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "deleted-digest")
	var path string
	if err := app.db.QueryRow(`
select audio_path from reader_segments where item_id='deleted-digest'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	app.auditMu.Lock()
	app.digestFailures[path] = "reader_integrity"
	app.auditMu.Unlock()
	if _, err := app.db.Exec("delete from reader_items where id='deleted-digest'"); err != nil {
		t.Fatal(err)
	}
	app.auditAllIntegrity(context.Background())
	app.auditMu.Lock()
	_, retained := app.digestFailures[path]
	app.auditMu.Unlock()
	if retained {
		t.Fatal("deleted Reader artifact retained a digest failure")
	}
	if !app.integritySnapshot()["reader_integrity"] {
		t.Fatalf("deleted Reader artifact pinned readiness: %#v", app.integritySnapshot())
	}
}

func TestRecoveryScriptsNeverExecuteSuppliedPackageSource(t *testing.T) {
	for _, path := range []string{
		"scripts/backup-volume.sh",
		"scripts/migrate-volume-ownership.sh",
		"scripts/restore-volume.sh",
		"scripts/verify-ownership-receipt.sh",
		"scripts/verify-snapshot.sh",
	} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		if strings.Contains(text, "go run .") ||
			strings.Contains(text, "cd \"$sealed_package\"") &&
				strings.Contains(text, "--validate-volume") {
			t.Fatalf("%s executes supplied release-package source", path)
		}
	}
}

func TestReaderRetainedLimitsAndParseAdmission(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-limits")
	if _, err := app.db.Exec(`
update reader_segments set text=? where item_id='reader-limits'`,
		strings.Repeat("x", maxReaderTextBytes+1)); err != nil {
		t.Fatal(err)
	}
	if err := readerRelationalIntegrity(context.Background(), app.db); err == nil {
		t.Fatal("oversized Reader text passed retained-data validation")
	}
	if _, err := app.db.Exec(`
update reader_segments set text='Reader segment' where item_id='reader-limits'`); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte(`<img src="image.png" alt="image">`), 0o640); err != nil {
		t.Fatal(err)
	}
	app.readerParses <- struct{}{}
	app.readerParses <- struct{}{}
	defer func() {
		<-app.readerParses
		<-app.readerParses
	}()
	if _, err := app.getImages(context.Background(), "reader-limits"); !errors.Is(err, errReaderParseBusy) {
		t.Fatalf("saturated Reader parser error=%v", err)
	}
}
