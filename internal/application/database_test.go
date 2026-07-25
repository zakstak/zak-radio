package application

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMigrationNormalizesCanonicalStationIdentity(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app.cancel()
	app.wg.Wait()
	now := unixTime(time.Now())
	for _, statement := range []string{
		`drop trigger temporary_station_capacity`,
		`create table stations_v4 (
			id text primary key, kind text not null, owner_hash text not null default '',
			track_id text not null, position real not null default 0,
			playing integer not null default 0, repeat_one integer not null default 0,
			shuffle integer not null default 0, created_at real not null, updated_at real not null,
			track_changed_at real not null, expires_at real, revision integer not null default 1,
			check((kind='shared' and owner_hash='' and expires_at is null) or
			      (kind='temporary' and owner_hash<>'' and expires_at is not null))
		)`,
		`insert into stations_v4
		 select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, expires_at, revision from stations`,
		`drop table stations`,
		`alter table stations_v4 rename to stations`,
	} {
		if _, err := app.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.db.Exec(`
update stations set kind='temporary', owner_hash='owner', expires_at=? where id='main'`, now+100); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into stations(id, kind, owner_hash, track_id, created_at, updated_at, track_changed_at)
values ('aux-shared', 'shared', '', 'one', ?, ?, ?)`, now, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("pragma user_version=4"); err != nil {
		t.Fatal(err)
	}
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var kind, owner string
	var expires any
	if err := reopened.db.QueryRow("select kind, owner_hash, expires_at from stations where id='main'").
		Scan(&kind, &owner, &expires); err != nil {
		t.Fatal(err)
	}
	if kind != "shared" || owner != "" || expires != nil {
		t.Fatalf("normalized main kind=%q owner=%q expires=%v", kind, owner, expires)
	}
	var auxiliaries int
	if err := reopened.db.QueryRow("select count(*) from stations where id='aux-shared'").Scan(&auxiliaries); err != nil {
		t.Fatal(err)
	}
	if auxiliaries != 0 {
		t.Fatal("auxiliary shared station survived migration")
	}
}

func TestMigrationDropsUnroutableTemporaryStations(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app.cancel()
	app.wg.Wait()
	now := unixTime(time.Now())
	for _, statement := range []string{
		`drop trigger temporary_station_capacity`,
		`create table stations_v5 (
			id text primary key, kind text not null check(kind in ('shared', 'temporary')),
			owner_hash text not null default '', track_id text not null,
			position real not null default 0, playing integer not null default 0,
			repeat_one integer not null default 0, shuffle integer not null default 0,
			created_at real not null, updated_at real not null, track_changed_at real not null,
			expires_at real, revision integer not null default 1,
			check((id='main' and kind='shared' and owner_hash='' and expires_at is null) or
			      (id<>'main' and kind='temporary' and owner_hash<>'' and expires_at is not null))
		)`,
		`insert into stations_v5
		 select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, expires_at, revision from stations`,
		`drop table stations`,
		`alter table stations_v5 rename to stations`,
	} {
		if _, err := app.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.db.Exec(`
insert into stations(id, kind, owner_hash, track_id, created_at, updated_at, track_changed_at, expires_at)
values ('guest', 'temporary', 'owner', 'one', ?, ?, ?, ?)`, now, now, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("pragma user_version=5"); err != nil {
		t.Fatal(err)
	}
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	for _, root := range []*os.Root{app.archiveRoot, app.metadataRoot, app.readerRoot, app.staticRoot} {
		_ = root.Close()
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var invalid int
	if err := reopened.db.QueryRow("select count(*) from stations where id='guest'").Scan(&invalid); err != nil {
		t.Fatal(err)
	}
	if invalid != 0 {
		t.Fatal("unroutable temporary station survived schema 6 migration")
	}
}

func TestStationSchemaRejectsInvalidAuxiliarySharedRow(t *testing.T) {
	app := newTestApp(t)
	now := unixTime(time.Now())
	if _, err := app.db.Exec("update stations set track_id='two' where id='main'"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into stations(id, kind, owner_hash, track_id, created_at, updated_at, track_changed_at, revision)
values ('aux', 'shared', '', 'removed-track', ?, ?, ?, 1)`, now, now, now); err == nil {
		t.Fatal("auxiliary shared station was accepted")
	}
	if err := app.station.EnsureMain(context.Background()); err != nil {
		t.Fatal(err)
	}
	var track string
	if err := app.db.QueryRow("select track_id from stations where id='main'").Scan(&track); err != nil {
		t.Fatal(err)
	}
	if track != "two" {
		t.Fatalf("main track=%q, want two", track)
	}
}

func TestReaderPlaybackChoosesAndReconcilesPlayableSegment(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-playable")
	audio := filepath.Join(app.cfg.ReaderLibrary, "reader-playable", "audio", "0.mp3")
	if _, err := app.db.Exec("update reader_segments set status='pending' where item_id=?", "reader-playable"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_segments(
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values (?, 3, '[]', 'paragraph', 'Ready', 0, 5, ?, 10, ?, 'ready',
	'032db9910de40cf69f572de7b42c639d4ea8afbb52d114f57ac42e902ad0d3af')`,
		"reader-playable", audio, len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	get := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/reader/playback?item_id=reader-playable", nil)
		res := httptest.NewRecorder()
		app.readerPlayback(res, req)
		return res
	}
	res := get()
	if res.Code != http.StatusOK {
		t.Fatalf("first playback status=%d body=%s", res.Code, res.Body.String())
	}
	var playback map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &playback); err != nil {
		t.Fatal(err)
	}
	if playback["segment_index"] != float64(3) {
		t.Fatalf("initial segment=%v, want 3", playback["segment_index"])
	}
	var playbackRows int
	if err := app.db.QueryRow("select count(*) from reader_playback").Scan(&playbackRows); err != nil {
		t.Fatal(err)
	}
	if playbackRows != 0 {
		t.Fatalf("playback GET created %d rows", playbackRows)
	}
	if _, err := app.db.Exec("delete from reader_segments where item_id=? and segment_index=3", "reader-playable"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("update reader_segments set status='ready' where item_id=?", "reader-playable"); err != nil {
		t.Fatal(err)
	}
	res = get()
	if res.Code != http.StatusOK {
		t.Fatalf("reconciled playback status=%d body=%s", res.Code, res.Body.String())
	}
	if err := json.Unmarshal(res.Body.Bytes(), &playback); err != nil {
		t.Fatal(err)
	}
	if playback["segment_index"] != float64(0) {
		t.Fatalf("reconciled segment=%v, want 0", playback["segment_index"])
	}
	if _, err := app.db.Exec("update reader_segments set status='pending' where item_id=?", "reader-playable"); err != nil {
		t.Fatal(err)
	}
	if res = get(); res.Code != http.StatusConflict {
		t.Fatalf("unplayable status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestHEADDoesNotStreamOrCreateReaderPlayback(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-head")
	for _, path := range []string{
		"/api/station/events",
		"/api/reader/playback?item_id=reader-head",
	} {
		req := httptest.NewRequest(http.MethodHead, path, nil)
		res := httptest.NewRecorder()
		app.routes().ServeHTTP(res, req)
		if res.Code != http.StatusMethodNotAllowed {
			t.Fatalf("HEAD %s status=%d", path, res.Code)
		}
	}
	var rows int
	if err := app.db.QueryRow("select count(*) from reader_playback").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("HEAD created %d playback rows", rows)
	}
	if count := app.events.SubscriberCount(); count != 0 {
		t.Fatalf("HEAD left %d subscribers", count)
	}
}

func TestTemporaryStationCapacityIsDatabaseAtomic(t *testing.T) {
	app := newTestApp(t)
	now := unixTime(time.Now())
	for index := 0; index < maxTempStations-1; index++ {
		if _, err := app.db.Exec(`
insert into stations(
	id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket
) values (?, 'temporary', ?, 'one', 0, 0, 0, 0, ?, ?, ?, ?, 1, ?)`,
			fmt.Sprintf("%012x", index+1), strings.Repeat("a", 64),
			now, now, now, now+3600, fmt.Sprintf("%064x", index+1000)); err != nil {
			t.Fatal(err)
		}
	}
	secondDB, err := openDatabase(context.Background(), app.cfg.DBPath, app.cfg.MetadataRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer secondDB.Close()
	other := NewStationService(secondDB, app.catalog, NewBroadcaster())
	services := []*StationService{app.station, other}
	errorsSeen := make(chan error, 2)
	var wg sync.WaitGroup
	for _, service := range services {
		wg.Add(1)
		go func(service *StationService) {
			defer wg.Done()
			_, _, _, err := service.Create(context.Background(), "one", strings.Repeat("a", 64))
			errorsSeen <- err
		}(service)
	}
	wg.Wait()
	close(errorsSeen)
	var success, capacity int
	for err := range errorsSeen {
		if err == nil {
			success++
		} else if errors.Is(err, ErrCapacity) {
			capacity++
		} else {
			t.Fatalf("unexpected create error: %v", err)
		}
	}
	if success != 1 || capacity != 1 {
		t.Fatalf("create results success=%d capacity=%d", success, capacity)
	}
	var count int
	if err := app.db.QueryRow("select count(*) from stations where kind='temporary'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != maxTempStations {
		t.Fatalf("temporary count=%d, want %d", count, maxTempStations)
	}
}

func TestExpiredStationImmediatelyNotifiesSubscribers(t *testing.T) {
	app := newTestApp(t)
	id, _, _, err := app.station.Create(context.Background(), "one", tokenHash("creator"))
	if err != nil {
		t.Fatal(err)
	}
	events, unsubscribe := app.events.Subscribe(id)
	defer unsubscribe()
	if _, err := app.db.Exec("update stations set expires_at=0 where id=?", id); err != nil {
		t.Fatal(err)
	}
	if err := app.station.deleteExpired(context.Background(), app.station.logicalNow()); err != nil {
		t.Fatal(err)
	}
	select {
	case payload := <-events:
		var event struct {
			Expired bool `json:"expired"`
		}
		if err := json.Unmarshal(payload, &event); err != nil || !event.Expired {
			t.Fatalf("expiry event=%s err=%v", payload, err)
		}
	case <-time.After(time.Second):
		t.Fatal("expired station subscriber was not notified")
	}
}

func TestTemporaryStationCreatorQuotaIsDatabaseAtomic(t *testing.T) {
	app := newTestApp(t)
	now := unixTime(time.Now())
	bucket := strings.Repeat("b", 64)
	for index := 0; index < maxCreatorStations-1; index++ {
		if _, err := app.db.Exec(`
insert into stations(
	id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket
) values (?, 'temporary', ?, 'one', 0, 0, 0, 0, ?, ?, ?, ?, 1, ?)`,
			fmt.Sprintf("%012x", index+1), strings.Repeat("a", 64),
			now, now, now, now+3600, bucket); err != nil {
			t.Fatal(err)
		}
	}
	secondDB, err := openDatabase(context.Background(), app.cfg.DBPath, app.cfg.MetadataRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer secondDB.Close()
	services := []*StationService{
		app.station,
		NewStationService(secondDB, app.catalog, NewBroadcaster()),
	}
	results := make(chan error, len(services))
	var wg sync.WaitGroup
	for _, service := range services {
		wg.Add(1)
		go func(service *StationService) {
			defer wg.Done()
			_, _, _, err := service.Create(context.Background(), "one", bucket)
			results <- err
		}(service)
	}
	wg.Wait()
	close(results)
	var success, capacity int
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrCapacity):
			capacity++
		default:
			t.Fatalf("unexpected creator-quota error: %v", err)
		}
	}
	if success != 1 || capacity != 1 {
		t.Fatalf("creator quota results success=%d capacity=%d", success, capacity)
	}
}

func TestTemporaryStationsRequireAttributedCreatorBuckets(t *testing.T) {
	app := newTestApp(t)
	now := unixTime(time.Now())
	_, err := app.db.Exec(`
insert into stations(
	id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket
) values ('abcdef123456', 'temporary', ?, 'one', 0, 0, 0, 0, ?, ?, ?, ?, 1, '')`,
		strings.Repeat("a", 64), now, now, now, now+3600)
	if err == nil {
		t.Fatal("schema accepted a temporary station without creator attribution")
	}
}

func TestRevisionHeadroomRejectsOverflowingMutations(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(
		"update stations set revision=? where id='main'", maxRevisionValue); err != nil {
		t.Fatal(err)
	}
	control := httptest.NewRequest(http.MethodPost, "/api/control",
		strings.NewReader(`{"station_id":"main","action":"set_shuffle","shuffle":true}`))
	control.Header.Set("Content-Type", "application/json")
	result := httptest.NewRecorder()
	app.apiControl(result, control)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("terminal station revision mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var stationRevision int64
	var shuffle int
	if err := app.db.QueryRow(
		"select revision, shuffle from stations where id='main'").
		Scan(&stationRevision, &shuffle); err != nil {
		t.Fatal(err)
	}
	if stationRevision != maxRevisionValue || shuffle != 1 {
		t.Fatalf("terminal station mutation committed revision=%d shuffle=%d",
			stationRevision, shuffle)
	}
	app.refreshIntegrity(context.Background())
	if checks := app.integritySnapshot(); checks["database"] || checks["writable"] {
		t.Fatalf("terminal station revision remained ready: %#v", checks)
	}

	if _, err := app.db.Exec(
		"update app_metadata set value=? where key='track_stats_revision'",
		strconv.FormatInt(maxRevisionValue, 10)); err != nil {
		t.Fatal(err)
	}
	like := httptest.NewRequest(http.MethodPost, "/api/like",
		strings.NewReader(`{"track_id":"one"}`))
	like.Header.Set("Content-Type", "application/json")
	result = httptest.NewRecorder()
	app.apiLike(result, like)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("terminal track revision mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var likes int
	if err := app.db.QueryRow(
		"select count(*) from likes where track_id='one'").Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes != 0 {
		t.Fatal("like committed despite exhausted track-stat revision")
	}

	if _, err := app.db.Exec(`
update stations set revision=1, track_id='one', position=0, playing=0 where id='main';
update app_metadata set value='0' where key='track_stats_revision';
insert into skip_counts(track_id, skip_count) values ('one', ?)
on conflict(track_id) do update set skip_count=excluded.skip_count`,
		maxRevisionValue); err != nil {
		t.Fatal(err)
	}
	control = httptest.NewRequest(http.MethodPost, "/api/control",
		strings.NewReader(`{"station_id":"main","action":"next"}`))
	control.Header.Set("Content-Type", "application/json")
	result = httptest.NewRecorder()
	app.apiControl(result, control)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("terminal skip-count mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var skipCount, trackRevision int64
	var trackID string
	if err := app.db.QueryRow(`
select s.skip_count, cast(m.value as integer), st.track_id
from skip_counts s, app_metadata m, stations st
where s.track_id='one' and m.key='track_stats_revision' and st.id='main'`).
		Scan(&skipCount, &trackRevision, &trackID); err != nil {
		t.Fatal(err)
	}
	if skipCount != maxRevisionValue || trackRevision != 0 || trackID != "one" {
		t.Fatalf("terminal skip mutation committed skip=%d track_revision=%d track=%q",
			skipCount, trackRevision, trackID)
	}

	seedReaderItem(t, app, "revision-reader")
	if _, err := app.db.Exec(`
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
) values ('revision-reader', 0, 0, 0, ?, ?, '', 0)`,
		unixTime(time.Now()), maxRevisionValue); err != nil {
		t.Fatal(err)
	}
	reader := httptest.NewRequest(http.MethodPost, "/api/reader/playback",
		strings.NewReader(fmt.Sprintf(
			`{"item_id":"revision-reader","segment_index":0,"position":1,"playing":false,"base_revision":%d}`,
			maxRevisionValue)))
	reader.Header.Set("Content-Type", "application/json")
	result = httptest.NewRecorder()
	app.setReaderPlayback(result, reader)
	if result.Code != http.StatusInternalServerError {
		t.Fatalf("terminal Reader revision mutation status=%d body=%s",
			result.Code, result.Body.String())
	}
	var readerRevision int64
	var readerPosition float64
	if err := app.db.QueryRow(`
select revision, position from reader_playback where item_id='revision-reader'`).
		Scan(&readerRevision, &readerPosition); err != nil {
		t.Fatal(err)
	}
	if readerRevision != maxRevisionValue || readerPosition != 0 {
		t.Fatalf("terminal Reader mutation committed revision=%d position=%v",
			readerRevision, readerPosition)
	}
	app.refreshIntegrity(context.Background())
	if checks := app.integritySnapshot(); checks["database"] || checks["writable"] {
		t.Fatalf("terminal Reader revision remained ready: %#v", checks)
	}
}

func TestMigrationReservesRevisionHeadroomAndLogicalClock(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	seedReaderItem(t, app, "migration-headroom")
	if _, err := app.db.Exec(`
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
) values ('migration-headroom', 0, 0, 0, ?, 0, '', 0)`, unixTime(time.Now())); err != nil {
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
update stations set revision=? where id='main';
update reader_playback set revision=? where item_id='migration-headroom';
update app_metadata set value=? where key='track_stats_revision';
insert into skip_counts(track_id, skip_count) values ('one', ?)
on conflict(track_id) do update set skip_count=excluded.skip_count;
delete from app_metadata where key='logical_clock_high';
pragma user_version=12;`,
		maxRevisionValue, maxRevisionValue,
		strconv.FormatInt(maxRevisionValue, 10), maxRevisionValue); err != nil {
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
	if err := preflightImmutableDatabase(
		context.Background(), cfg.DBPath, info.Size(),
	); err != nil {
		t.Fatalf("supported legacy database was rejected before candidate migration: %v", err)
	}
	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var stationRevision, readerRevision, trackRevision, skipCount int64
	var logicalRaw string
	if err := reopened.db.QueryRow(`
select s.revision, p.revision, cast(m.value as integer), sk.skip_count,
       (select value from app_metadata where key='logical_clock_high')
from stations s, reader_playback p, app_metadata m, skip_counts sk
where s.id='main' and p.item_id='migration-headroom'
  and m.key='track_stats_revision' and sk.track_id='one'`).
		Scan(&stationRevision, &readerRevision, &trackRevision, &skipCount, &logicalRaw); err != nil {
		t.Fatal(err)
	}
	logical, parseErr := strconv.ParseFloat(logicalRaw, 64)
	if stationRevision != 1 || readerRevision != 0 || trackRevision != 0 || skipCount != 0 ||
		parseErr != nil || logical <= 0 {
		t.Fatalf("migration headroom station=%d reader=%d track=%d skip=%d logical=%q err=%v",
			stationRevision, readerRevision, trackRevision, skipCount, logicalRaw, parseErr)
	}
}

func TestTemporaryStationCreationFailsBeforeTimestampHeadroomIsExhausted(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(`
update app_metadata set value=? where key='logical_clock_high'`,
		strconv.FormatFloat(maxRetainedTimestamp, 'f', 0, 64)); err != nil {
		t.Fatal(err)
	}
	service := NewStationService(app.db, app.catalog, NewBroadcaster())
	fixed := time.Unix(2_000_000_000, 0)
	service.clockSample = fixed
	service.clock = func() time.Time { return fixed }
	service.monotonic = func() time.Time { return fixed }
	if _, _, _, err := service.Create(
		context.Background(), "one", strings.Repeat("c", 64),
	); err == nil || !strings.Contains(err.Error(), "timestamp headroom") {
		t.Fatalf("temporary station was accepted at timestamp ceiling: %v", err)
	}
	var temporary int
	if err := app.db.QueryRow(
		`select count(*) from stations where kind='temporary'`).Scan(&temporary); err != nil {
		t.Fatal(err)
	}
	if temporary != 0 {
		t.Fatalf("timestamp-ceiling create persisted %d temporary stations", temporary)
	}
	if err := retainedAdmissionIntegrity(context.Background(), app.db); err != nil {
		t.Fatalf("rejected timestamp-ceiling write poisoned restart admission: %v", err)
	}
}

func TestCatalogTurnoverReconcilesAuxiliaryStatisticsBeforeServing(t *testing.T) {
	app := newTestApp(t)
	tx, err := app.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	likes, err := tx.Prepare(
		`insert into likes(track_id, liked, updated_at) values (?, 1, 1)`)
	if err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	skips, err := tx.Prepare(
		`insert into skip_counts(track_id, skip_count) values (?, 1)`)
	if err != nil {
		likes.Close()
		tx.Rollback()
		t.Fatal(err)
	}
	for index := 0; index < maxCatalogTracks; index++ {
		id := fmt.Sprintf("removed-%04d", index)
		if _, err := likes.Exec(id); err != nil {
			likes.Close()
			skips.Close()
			tx.Rollback()
			t.Fatal(err)
		}
		if _, err := skips.Exec(id); err != nil {
			likes.Close()
			skips.Close()
			tx.Rollback()
			t.Fatal(err)
		}
	}
	likes.Close()
	skips.Close()
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	service := NewStationService(app.db, app.catalog, NewBroadcaster())
	if err := service.EnsureMain(context.Background()); err != nil {
		t.Fatal(err)
	}
	var likeRows, skipRows int
	if err := app.db.QueryRow(`select count(*) from likes`).Scan(&likeRows); err != nil {
		t.Fatal(err)
	}
	if err := app.db.QueryRow(`select count(*) from skip_counts`).Scan(&skipRows); err != nil {
		t.Fatal(err)
	}
	if likeRows != 0 || skipRows != 0 {
		t.Fatalf("stale statistics survived catalog reconciliation: likes=%d skips=%d",
			likeRows, skipRows)
	}
	if _, err := service.Execute(context.Background(), Command{Action: "next"}); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/like",
		strings.NewReader(`{"track_id":"one"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.apiLike(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("current-track like status=%d body=%s", response.Code, response.Body.String())
	}
	if err := retainedAdmissionIntegrity(context.Background(), app.db); err != nil {
		t.Fatalf("post-reconciliation writes exceeded restart budgets: %v", err)
	}
}

func TestLegacyPreflightRejectsUnexpectedTriggerBeforeMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
pragma user_version=2;
create table stations(id text primary key, revision integer);
create trigger unexpected_marker after update on stations
begin select 1; end;`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := preflightImmutableDatabase(
		context.Background(), path, info.Size(),
	); err == nil || !strings.Contains(err.Error(), `unexpected trigger "unexpected_marker"`) {
		t.Fatalf("unexpected legacy trigger passed read-only preflight: %v", err)
	}
	check, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var version int
	if err := check.QueryRow(`pragma user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("preflight mutated legacy database version: %d", version)
	}
}
