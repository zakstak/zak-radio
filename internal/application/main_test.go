package application

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRepeatOneKeepsCurrentTrackAtEnd(t *testing.T) {
	app := newTestApp(t)

	station := postControlForTest(t, app, `{"action":"set_repeat_one","repeat_one":true}`)
	if repeatOne, _ := station["repeat_one"].(bool); !repeatOne {
		t.Fatalf("repeat_one = %v, want true", station["repeat_one"])
	}

	fixed := time.Unix(1_800_000_000, 0)
	freezeStationClockForTest(app.station, fixed)
	now := unixTime(fixed)
	if _, err := app.db.Exec(
		"update stations set position=10, playing=1, updated_at=?, track_changed_at=? where id=?",
		now-2,
		now-20,
		mainStationID,
	); err != nil {
		t.Fatal(err)
	}
	before, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Position != 10 || before.Revision != 2 {
		t.Fatalf("read-only snapshot = %#v", before)
	}
	if err := app.station.Advance(context.Background()); err != nil {
		t.Fatal(err)
	}

	station, err = app.stationState()
	if err != nil {
		t.Fatal(err)
	}
	if got := station["track_id"]; got != "one" {
		t.Fatalf("track_id = %v, want one", got)
	}
	if got := station["position"]; got != float64(2) {
		t.Fatalf("position = %v, want 2 seconds into the loop", got)
	}
}

func TestPlaybackAdvancesAtEndWhenRepeatOneIsOff(t *testing.T) {
	app := newTestApp(t)
	postControlForTest(t, app, `{"action":"set_repeat_one","repeat_one":false}`)

	fixed := time.Unix(1_800_000_000, 0)
	freezeStationClockForTest(app.station, fixed)
	now := unixTime(fixed)
	if _, err := app.db.Exec(
		"update stations set position=10, playing=1, updated_at=?, track_changed_at=? where id=?",
		now-2,
		now-20,
		mainStationID,
	); err != nil {
		t.Fatal(err)
	}
	if err := app.station.Advance(context.Background()); err != nil {
		t.Fatal(err)
	}

	station, err := app.stationState()
	if err != nil {
		t.Fatal(err)
	}
	if got := station["track_id"]; got != "two" {
		t.Fatalf("track_id = %v, want two", got)
	}
}

func TestRepeatOneRequiresExplicitState(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(`{"action":"set_repeat_one"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()

	app.apiControl(res, req)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
}

func TestShuffleIsStationModeAndControlsNext(t *testing.T) {
	app := newTestApp(t)

	station := postControlForTest(t, app, `{"action":"set_shuffle","shuffle":true}`)
	if shuffle, _ := station["shuffle"].(bool); !shuffle {
		t.Fatalf("shuffle = %v, want true", station["shuffle"])
	}
	before := station["track_id"]
	station = postControlForTest(t, app, `{"action":"next"}`)
	if station["track_id"] == before {
		t.Fatalf("shuffle next kept the same track %v", before)
	}
	if shuffle, _ := station["shuffle"].(bool); !shuffle {
		t.Fatal("shuffle mode was not preserved after next")
	}
}

func TestShuffleRequiresExplicitState(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(`{"action":"set_shuffle"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()

	app.apiControl(res, req)

	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
}

func TestStationQueueIsOrderedAndConsumedByNext(t *testing.T) {
	app := newTestApp(t)

	postControlForTest(t, app,
		`{"action":"add_to_queue","track_id":"one"}`)
	station := postControlForTest(t, app,
		`{"action":"play_next","track_id":"two"}`)
	queue, ok := station["queue"].([]any)
	if !ok || len(queue) != 2 || queue[0] != "two" || queue[1] != "one" {
		t.Fatalf("queue = %#v, want [two one]", station["queue"])
	}

	station = postControlForTest(t, app, `{"action":"next"}`)
	queue, _ = station["queue"].([]any)
	if station["track_id"] != "two" || len(queue) != 1 || queue[0] != "one" {
		t.Fatalf("first queued next = %#v", station)
	}

	station = postControlForTest(t, app, `{"action":"next"}`)
	queue, _ = station["queue"].([]any)
	if station["track_id"] != "one" || len(queue) != 0 {
		t.Fatalf("second queued next = %#v", station)
	}
}

func TestStationQueueIsConsumedAtNaturalTrackEnd(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_800_000_000, 0)
	freezeStationClockForTest(app.station, fixed)
	if _, err := app.station.Execute(context.Background(), Command{
		Action: "add_to_queue", TrackID: "two",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
update stations set track_id='one', position=0, playing=1, repeat_one=0,
	shuffle=0, updated_at=?, track_changed_at=? where id=?`,
		unixTime(fixed)-11, unixTime(fixed)-11, mainStationID); err != nil {
		t.Fatal(err)
	}

	if err := app.station.Advance(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != "two" || math.Abs(snapshot.Position-1) > 0.001 ||
		len(snapshot.Queue) != 0 {
		t.Fatalf("natural queued advance = %#v", snapshot)
	}
}

func TestTemporaryStationQueueIsIsolatedFromSharedStation(t *testing.T) {
	app := newTestApp(t)
	stationID, ownerToken, _, err := app.station.Create(
		context.Background(), "one", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	private, err := app.station.Execute(context.Background(), Command{
		StationID: stationID, OwnerToken: ownerToken,
		Action: "add_to_queue", TrackID: "two",
	})
	if err != nil {
		t.Fatal(err)
	}
	shared, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if len(private.Queue) != 1 || private.Queue[0] != "two" || len(shared.Queue) != 0 {
		t.Fatalf("private queue=%v shared queue=%v", private.Queue, shared.Queue)
	}
	private, err = app.station.Execute(context.Background(), Command{
		StationID: stationID, OwnerToken: ownerToken, Action: "next",
	})
	if err != nil {
		t.Fatal(err)
	}
	if private.TrackID != "two" || shared.TrackID != "one" {
		t.Fatalf("private next=%q shared track=%q", private.TrackID, shared.TrackID)
	}
}

func TestTemporaryStationIsIndependentAndOwnerControlled(t *testing.T) {
	app := newTestApp(t)
	mainBefore, err := app.stationState()
	if err != nil {
		t.Fatal(err)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/api/stations", strings.NewReader(
		`{"track_id":"two","idempotency_key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","owner_token":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`))
	createReq.Header.Set("Content-Type", "application/json")
	createRes := httptest.NewRecorder()
	app.createStation(createRes, createReq)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createRes.Code, createRes.Body.String())
	}
	var created struct {
		StationID  string `json:"station_id"`
		OwnerToken string `json:"owner_token"`
	}
	if err := json.NewDecoder(createRes.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.StationID == "" || created.OwnerToken == "" {
		t.Fatalf("create response omitted credentials: %+v", created)
	}

	listenerReq := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(
		`{"station_id":"`+created.StationID+`","action":"play"}`,
	))
	listenerReq.Header.Set("Content-Type", "application/json")
	listenerRes := httptest.NewRecorder()
	app.apiControl(listenerRes, listenerReq)
	if listenerRes.Code != http.StatusForbidden {
		t.Fatalf("listener control status = %d, want %d", listenerRes.Code, http.StatusForbidden)
	}

	ownerReq := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(
		`{"station_id":"`+created.StationID+`","owner_token":"`+created.OwnerToken+`","action":"play"}`,
	))
	ownerReq.Header.Set("Content-Type", "application/json")
	ownerRes := httptest.NewRecorder()
	app.apiControl(ownerRes, ownerReq)
	if ownerRes.Code != http.StatusOK {
		t.Fatalf("owner control status = %d, body = %s", ownerRes.Code, ownerRes.Body.String())
	}
	var temporary map[string]any
	if err := json.NewDecoder(ownerRes.Body).Decode(&temporary); err != nil {
		t.Fatal(err)
	}
	if temporary["track_id"] != "two" || temporary["playing"] != true {
		t.Fatalf("temporary station state = %#v", temporary)
	}

	mainAfter, err := app.stationState()
	if err != nil {
		t.Fatal(err)
	}
	if mainAfter["track_id"] != mainBefore["track_id"] || mainAfter["playing"] != mainBefore["playing"] {
		t.Fatalf("temporary control changed shared station: before=%#v after=%#v", mainBefore, mainAfter)
	}
}

func TestControlBroadcastsStationUpdate(t *testing.T) {
	app := newTestApp(t)
	events, unsubscribe := app.subscribe(mainStationID)
	defer unsubscribe()

	postControlForTest(t, app, `{"action":"play"}`)

	select {
	case payload := <-events:
		var station map[string]any
		if err := json.Unmarshal(payload, &station); err != nil {
			t.Fatal(err)
		}
		if station["station_id"] != mainStationID || station["playing"] != true {
			t.Fatalf("broadcast station = %#v", station)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for station broadcast")
	}
}

func TestLegacyStationsMigrateIntoUnifiedTable(t *testing.T) {
	cfg := newTestConfig(t)
	legacy, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`
create table station (
	id integer primary key, track_id text not null, position real not null,
	playing integer not null, updated_at real not null, track_changed_at real not null
);
insert into station values (1, 'two', 3.5, 1, 100, 90);
create table station_settings (id integer primary key, repeat_one integer not null);
insert into station_settings values (1, 1);
create table temporary_stations (
	station_id text primary key, owner_hash text not null, track_id text not null,
	position real not null, playing integer not null, repeat_one integer not null,
	shuffle integer not null, created_at real not null, updated_at real not null,
	track_changed_at real not null, expires_at real not null
);
insert into temporary_stations values
	('abcdef123456', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	 'one', 2, 0, 0, 1, 80, 100, 90, 9999999999);`)
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	var count int
	if err := app.db.QueryRow("select count(*) from stations").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("migrated station count = %d, want 1 after retiring unattributed temporary stations", count)
	}
	var track string
	var repeat, shuffle int
	if err := app.db.QueryRow("select track_id, repeat_one, shuffle from stations where id=?", mainStationID).Scan(&track, &repeat, &shuffle); err != nil {
		t.Fatal(err)
	}
	if track != "one" || repeat != 0 || shuffle != 1 {
		t.Fatalf("main migration = track %q repeat %d shuffle %d", track, repeat, shuffle)
	}
	if err := app.db.QueryRow("select count(*) from stations where id='abcdef123456'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("legacy temporary station without creator attribution survived schema 11")
	}
	for _, removed := range []string{"station", "station_settings", "temporary_stations"} {
		var found int
		if err := app.db.QueryRow("select count(*) from sqlite_master where type='table' and name=?", removed).Scan(&found); err != nil {
			t.Fatal(err)
		}
		if found != 0 {
			t.Fatalf("legacy table %q still exists", removed)
		}
	}
	var version int
	if err := app.db.QueryRow("pragma user_version").Scan(&version); err != nil || version != currentSchemaVersion {
		t.Fatalf("user_version = %d, err = %v", version, err)
	}
}

func TestStationPersistsAcrossRestart(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	postControlForTest(t, app, `{"action":"select","track_id":"two"}`)
	postControlForTest(t, app, `{"action":"set_shuffle","shuffle":true}`)
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	app, err = NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	state, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if state.TrackID != "two" || !state.Shuffle || state.Revision != 3 {
		t.Fatalf("restarted state = %#v", state)
	}
}

func TestExpiredStationCannotBeReadOrResurrected(t *testing.T) {
	app := newTestApp(t)
	request := httptest.NewRequest(http.MethodPost, "/api/stations", strings.NewReader(
		`{"track_id":"two","idempotency_key":"cccccccccccccccccccccccccccccccc","owner_token":"dddddddddddddddddddddddddddddddddddddddddddddddd"}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	app.createStation(response, request)
	var created struct {
		StationID  string `json:"station_id"`
		OwnerToken string `json:"owner_token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("update stations set expires_at=1 where id=?", created.StationID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.station.Snapshot(context.Background(), created.StationID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expired snapshot error = %v, want sql.ErrNoRows", err)
	}
	_, err := app.station.Execute(context.Background(), Command{
		StationID: created.StationID, OwnerToken: created.OwnerToken, Action: "play",
	})
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expired control error = %v, want sql.ErrNoRows", err)
	}
	var expires float64
	if err := app.db.QueryRow("select expires_at from stations where id=?", created.StationID).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if expires != 1 {
		t.Fatalf("expired station was extended to %v", expires)
	}
}

func TestBroadcastRevisionsIncreaseAfterCommit(t *testing.T) {
	app := newTestApp(t)
	events, unsubscribe := app.subscribe(mainStationID)
	defer unsubscribe()
	first := postControlForTest(t, app, `{"action":"play"}`)
	second := postControlForTest(t, app, `{"action":"pause"}`)
	if second["revision"].(float64) <= first["revision"].(float64) {
		t.Fatalf("response revisions did not increase: %v then %v", first["revision"], second["revision"])
	}
	select {
	case payload := <-events:
		var snapshot Snapshot
		if err := json.Unmarshal(payload, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Revision != int64(second["revision"].(float64)) {
			t.Fatalf("coalesced event revision = %d, want latest %v", snapshot.Revision, second["revision"])
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for revisioned event")
	}
}

func TestHTTPRoutesPreserveStationAndMediaContracts(t *testing.T) {
	app := newTestApp(t)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	for _, path := range []string{"/", "/library", "/library/", "/reader", "/reader/"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || string(body) != "<main>shared shell</main>" {
			t.Fatalf("page %s status=%d body=%q", path, response.StatusCode, body)
		}
		if got := response.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("page %s Cache-Control = %q", path, got)
		}
	}

	response, err := http.Get(server.URL + "/api/station")
	if err != nil {
		t.Fatal(err)
	}
	var station map[string]any
	if err := json.NewDecoder(response.Body).Decode(&station); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || station["station_id"] != mainStationID ||
		station["revision"] == nil || station["shuffle"] == nil || station["can_control"] != true {
		t.Fatalf("station response status=%d body=%#v", response.StatusCode, station)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("station Cache-Control = %q", got)
	}

	request, err := http.NewRequest(http.MethodGet, server.URL+"/media/one/audio", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-2")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent {
		t.Fatalf("range status = %d, want %d", response.StatusCode, http.StatusPartialContent)
	}
	if got := response.Header.Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges = %q", got)
	}
}

func TestTimedLyricsAreValidatedVersionedAndServed(t *testing.T) {
	cfg := newTestConfig(t)
	sidecarPath := filepath.Join(cfg.Archive, "tracks", "one", "lyrics.timed.json")
	sidecar := `{
  "version": 1,
  "track_id": "one",
  "audio_sha256": "6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b",
  "duration": 10,
  "language": "en",
  "quality": {
    "candidate_lines": 1,
    "aligned_lines": 1,
    "line_coverage": 1,
    "word_coverage": 1,
    "mean_confidence": 0.9
  },
  "cues": [{
    "start": 1,
    "end": 2,
    "section": "Verse",
    "text": "Hello",
    "words": [{"start": 1, "end": 2, "text": "Hello", "confidence": 0.9}]
  }]
}`
	if err := os.WriteFile(sidecarPath, []byte(sidecar), 0o644); err != nil {
		t.Fatal(err)
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	if !app.byID["one"].HasSyncedLyrics ||
		len(app.byID["one"].TimedLyricsSHA256) != 64 {
		t.Fatalf("timed lyric catalog state = %#v", app.byID["one"])
	}

	response := httptest.NewRecorder()
	app.apiTrackText(
		response,
		httptest.NewRequest(http.MethodGet, "/api/track/one?kind=timed_lyrics", nil),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("timed lyrics status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		TimedLyrics TimedLyrics `json:"timed_lyrics"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.TimedLyrics.TrackID != "one" ||
		len(payload.TimedLyrics.Cues) != 1 ||
		payload.TimedLyrics.Cues[0].Text != "Hello" {
		t.Fatalf("timed lyrics response = %#v", payload.TimedLyrics)
	}

	if err := os.WriteFile(sidecarPath, []byte(sidecar+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	app.apiTrackText(
		response,
		httptest.NewRequest(http.MethodGet, "/api/track/one?kind=timed_lyrics", nil),
	)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("tampered timed lyrics status = %d, want 500", response.Code)
	}
}

func TestImmutableTimedLyricsBundleIsUsedWithoutMutatingArchive(t *testing.T) {
	cfg := newTestConfig(t)
	cfg.TimedLyricsRoot = filepath.Join(filepath.Dir(cfg.MetadataRoot), "timed-lyrics")
	if err := os.Mkdir(cfg.TimedLyricsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	sidecarPath := filepath.Join(cfg.TimedLyricsRoot, "one.json")
	sidecar := `{
  "version": 1,
  "track_id": "one",
  "audio_sha256": "6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b",
  "duration": 10,
  "quality": {
    "candidate_lines": 1,
    "aligned_lines": 1,
    "line_coverage": 1,
    "word_coverage": 1,
    "mean_confidence": 0.9
  },
  "cues": [{"start": 1, "end": 2, "text": "Bundled line"}]
}`
	if err := os.WriteFile(sidecarPath, []byte(sidecar), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(cfg.TimedLyricsRoot, timedLyricsSubjects),
		[]byte(`{"tracks":{"one":{"title":"Observed subject"}}}`), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	track := app.byID["one"]
	if !track.HasSyncedLyrics || !track.TimedLyricsBundled {
		t.Fatalf("bundled timed lyric catalog state = %#v", track)
	}
	if track.Title != "Observed subject" {
		t.Fatalf("immutable subject title = %q", track.Title)
	}
	if _, err := os.Stat(
		filepath.Join(cfg.Archive, "tracks", "one", "lyrics.timed.json"),
	); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archive was unexpectedly changed: %v", err)
	}

	response := httptest.NewRecorder()
	app.apiTrackText(
		response,
		httptest.NewRequest(http.MethodGet, "/api/track/one?kind=timed_lyrics", nil),
	)
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), "Bundled line") {
		t.Fatalf("bundled timed lyrics status=%d body=%s",
			response.Code, response.Body.String())
	}
}

func TestCatalogRejectsTimedLyricsForDifferentAudio(t *testing.T) {
	cfg := newTestConfig(t)
	sidecar := `{
  "version": 1,
  "track_id": "one",
  "audio_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "duration": 10,
  "quality": {
    "candidate_lines": 1,
    "aligned_lines": 1,
    "line_coverage": 1,
    "word_coverage": 1,
    "mean_confidence": 1
  },
  "cues": [{"start": 1, "end": 2, "text": "Hello"}]
}`
	if err := os.WriteFile(
		filepath.Join(cfg.Archive, "tracks", "one", "lyrics.timed.json"),
		[]byte(sidecar), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := NewApp(cfg); err == nil ||
		!strings.Contains(err.Error(), "audio_sha256 does not match") {
		t.Fatalf("startup error = %v", err)
	}
}

func TestPlayerUsesSinglePlayPauseAndRepeatControls(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("static", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, id := range []string{`id="playPause"`, `id="repeatOne"`} {
		if !strings.Contains(html, id) {
			t.Fatalf("index.html is missing %s", id)
		}
	}
	for _, id := range []string{`id="play"`, `id="pause"`} {
		if strings.Contains(html, id) {
			t.Fatalf("index.html still contains separate control %s", id)
		}
	}
	for _, productDetail := range []string{
		`name="theme-color"`,
		`rel="icon"`,
		`href="/reader"`,
		`id="toast"`,
		`id="footerShortcut"`,
		`id="createStation"`,
		`id="toggleDetails"`,
		`id="promptPanel"`,
	} {
		if !strings.Contains(html, productDetail) {
			t.Fatalf("index.html is missing product detail %s", productDetail)
		}
	}
	for _, removed := range []string{`id="copyLyrics"`, `id="copyPrompt"`} {
		if strings.Contains(html, removed) {
			t.Fatalf("index.html still contains removed control %s", removed)
		}
	}
}

func TestTailwindV4BuildConfigured(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("static", "styles.tailwind.css"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), `@import "tailwindcss"`) {
		t.Fatal("Tailwind source is missing the v4 CSS import")
	}
	if !strings.Contains(string(source), "@apply") {
		t.Fatal("Tailwind source is missing the component layer")
	}
	for _, contentSource := range []string{`@source "./index.html"`, `@source "./app.js"`, `@source "./library.js"`, `@source "./reader.js"`} {
		if !strings.Contains(string(source), contentSource) {
			t.Fatalf("Tailwind source is missing %s", contentSource)
		}
	}

	packageJSON, err := os.ReadFile("package.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, dependency := range []string{`"tailwindcss": "4.3.3"`, `"@tailwindcss/cli": "4.3.3"`} {
		if !strings.Contains(string(packageJSON), dependency) {
			t.Fatalf("package.json is missing %s", dependency)
		}
	}

	output, err := os.ReadFile(filepath.Join("static", "styles.css"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), "tailwindcss v4.3.3") {
		t.Fatal("compiled stylesheet was not produced by Tailwind CSS v4.3.3")
	}
}

func TestSingleShellUsesSemanticTailwindAndLocalPreview(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("static", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(filepath.Join("static", "library.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	appScript, err := os.ReadFile(filepath.Join("static", "app.js"))
	if err != nil {
		t.Fatal(err)
	}
	js := string(script)
	allJS := string(appScript) + js
	for _, forbidden := range []string{"<style", "style="} {
		if strings.Contains(html, forbidden) {
			t.Fatalf("index.html contains forbidden inline styling %q", forbidden)
		}
	}
	for _, required := range []string{`href="/"`, `href="/library"`, `href="/reader"`, `class="library-page`, `id="audio"`, `/api/tracks`, `/media/`} {
		if !strings.Contains(html+allJS, required) {
			t.Fatalf("single-shell library is missing %q", required)
		}
	}
	if strings.Contains(js, "/api/control") || strings.Contains(js, "/api/stations") {
		t.Fatal("local library preview must not mutate radio station state")
	}
}

func newTestApp(t *testing.T) *App {
	t.Helper()
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	return app
}

func freezeStationClockForTest(station *StationService, fixed time.Time) {
	station.clockSample = fixed
	station.clock = func() time.Time { return fixed }
	station.monotonic = func() time.Time { return fixed }
}

func newTestConfig(t *testing.T) Config {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "data")
	archive := filepath.Join(root, "archive")
	staticDir := filepath.Join(base, "static")
	reader := filepath.Join(root, "reader")
	for _, dir := range []string{
		filepath.Join(archive, "tracks", "one"),
		filepath.Join(archive, "tracks", "two"),
		staticDir,
		reader,
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	index := `{"tracks":[` +
		`{"id":"one","title":"One","artist":"Zak","duration":10,"organized_dir":"tracks/one","audio_sha256":"6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b"},` +
		`{"id":"two","title":"Two","artist":"Zak","duration":8,"organized_dir":"tracks/two","audio_sha256":"6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b"}` +
		`]}`
	if err := os.WriteFile(filepath.Join(archive, "index.json"), []byte(index), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "curated-tracks.json"), []byte(`{"tracks":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		if err := os.WriteFile(filepath.Join(archive, "tracks", id, "audio.mp3"), []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<main>shared shell</main>"), 0o644); err != nil {
		t.Fatal(err)
	}

	return Config{
		MetadataRoot:     root,
		Archive:          archive,
		DBPath:           filepath.Join(root, "station.sqlite3"),
		ReaderLibrary:    reader,
		StaticDir:        staticDir,
		AllowedHosts:     "loopback,example.com",
		AllowedOrigins:   "loopback,http://example.com,https://example.com",
		TrustedProxies:   "192.0.2.0/24",
		TrustedIngress:   "192.0.2.0/24",
		ClientIPv6Prefix: 64,
	}
}

func postControlForTest(t *testing.T, app *App, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/control", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiControl(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var station map[string]any
	if err := json.NewDecoder(res.Body).Decode(&station); err != nil {
		t.Fatal(err)
	}
	return station
}
