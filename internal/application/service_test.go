package application

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type failingListener struct{}

func (failingListener) Accept() (net.Conn, error) {
	return nil, errors.New("injected accept failure")
}
func (failingListener) Close() error   { return nil }
func (failingListener) Addr() net.Addr { return &net.TCPAddr{} }

func TestUnexpectedServeFailurePropagates(t *testing.T) {
	server := &http.Server{Handler: http.NotFoundHandler()}
	stopped := make(chan struct{})
	err := serveUntilStopped(server, failingListener{}, stopped)
	if err == nil || !strings.Contains(err.Error(), "injected accept failure") {
		t.Fatalf("unexpected serve result: %v", err)
	}
}

func TestShutdownTimeoutForcesHandlersClosedAndReturnsError(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	exited := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(
		_ http.ResponseWriter, request *http.Request,
	) {
		close(entered)
		<-request.Context().Done()
		close(exited)
	})}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		_, _ = http.Get("http://" + listener.Addr().String())
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("blocked handler was not entered")
	}
	if err := shutdownHTTPServer(server, 20*time.Millisecond); err == nil {
		t.Fatal("shutdown timeout returned success")
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("forced server close did not release the blocked handler")
	}
	<-requestDone
	<-serveDone
}

func TestModeChangesPreserveEffectivePlayhead(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_800_000_000, 0)
	clockNow := fixed
	app.station.clockSample = clockNow
	app.station.clock = func() time.Time { return clockNow }
	app.station.monotonic = func() time.Time { return clockNow }
	if _, err := app.db.Exec(`
update stations set position=2, playing=1, updated_at=?, track_changed_at=?
where id=?`, unixTime(fixed)-5, unixTime(fixed)-7, mainStationID); err != nil {
		t.Fatal(err)
	}
	station := postControlForTest(t, app, `{"action":"set_shuffle","shuffle":true}`)
	if got := station["position"]; got != float64(7) {
		t.Fatalf("shuffle position = %v, want 7", got)
	}
	clockNow = fixed.Add(2 * time.Second)
	station = postControlForTest(t, app, `{"action":"set_repeat_one","repeat_one":true}`)
	if got := station["position"]; got != float64(9) {
		t.Fatalf("repeat position = %v, want 9", got)
	}
}

func TestStationClockHighWaterSurvivesServiceRestart(t *testing.T) {
	app := newTestApp(t)
	stationID, ownerToken, _, err := app.station.Create(
		context.Background(), "one", strings.Repeat("b", 64))
	if err != nil {
		t.Fatal(err)
	}
	retained := float64(1_900_000_000)
	retainedExpiry := retained + tempStationLife.Seconds()
	if _, err := app.db.Exec(`
update stations set position=2, playing=1, updated_at=?, track_changed_at=?,
	expires_at=? where id=?`,
		retained, retained-10, retainedExpiry, stationID); err != nil {
		t.Fatal(err)
	}
	restarted := NewStationService(app.db, app.catalog, NewBroadcaster())
	restarted.clock = func() time.Time {
		return time.Unix(int64(retained)-100, 0)
	}
	monotonic := time.Unix(10, 0)
	restarted.clockSample = monotonic
	restarted.monotonic = func() time.Time { return monotonic }
	enabled := true
	snapshot, err := restarted.Execute(context.Background(), Command{
		StationID: stationID, OwnerToken: ownerToken,
		Action: "set_shuffle", Shuffle: &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Position != 2 {
		t.Fatalf("restart with a rolled-back clock advanced position to %v", snapshot.Position)
	}
	if snapshot.ExpiresAt == nil || *snapshot.ExpiresAt < retainedExpiry {
		t.Fatalf("restart shortened temporary expiry from %v to %v",
			retainedExpiry, snapshot.ExpiresAt)
	}
	monotonic = monotonic.Add(5 * time.Second)
	advanced, err := restarted.Snapshot(context.Background(), stationID)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(advanced.ServerTime-(retained+5)) > 0.001 ||
		math.Abs(advanced.Position-7) > 0.001 {
		t.Fatalf("monotonic elapsed time did not advance rolled-back wall time: %#v", advanced)
	}
	if err := restarted.persistLogicalClock(context.Background()); err != nil {
		t.Fatal(err)
	}
	secondRestart := NewStationService(app.db, app.catalog, NewBroadcaster())
	secondRestart.clock = func() time.Time {
		return time.Unix(int64(retained)-100, 0)
	}
	secondMonotonic := time.Unix(20, 0)
	secondRestart.clockSample = secondMonotonic
	secondRestart.monotonic = func() time.Time { return secondMonotonic }
	afterSecondRestart, err := secondRestart.Snapshot(context.Background(), stationID)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(afterSecondRestart.ServerTime-(retained+5)) > 0.001 ||
		math.Abs(afterSecondRestart.Position-7) > 0.001 {
		t.Fatalf("persisted logical clock regressed across a second restart: %#v",
			afterSecondRestart)
	}
}

func TestCommandsNormalizeElapsedTrackBoundaries(t *testing.T) {
	for _, test := range []struct {
		name        string
		repeatOne   bool
		action      string
		wantTrack   string
		wantPos     float64
		wantPlaying bool
	}{
		{name: "pause advances", action: "pause", wantTrack: "two", wantPos: 2},
		{name: "repeat pause wraps", repeatOne: true, action: "pause", wantTrack: "one", wantPos: 2},
		{name: "next uses effective track", action: "next", wantTrack: "one", wantPos: 0, wantPlaying: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := newTestApp(t)
			fixed := time.Unix(1_800_000_000, 0)
			freezeStationClockForTest(app.station, fixed)
			if _, err := app.db.Exec(`
update stations set track_id='one', position=0, playing=1, repeat_one=?,
	updated_at=?, track_changed_at=? where id=?`,
				boolInt(test.repeatOne), unixTime(fixed)-12, unixTime(fixed)-12, mainStationID); err != nil {
				t.Fatal(err)
			}
			snapshot, err := app.station.Execute(context.Background(), Command{Action: test.action})
			if err != nil {
				t.Fatal(err)
			}
			if snapshot.TrackID != test.wantTrack || math.Abs(snapshot.Position-test.wantPos) > 0.001 ||
				snapshot.Playing != test.wantPlaying {
				t.Fatalf("normalized command snapshot=%#v", snapshot)
			}
		})
	}
}

func TestAdvanceConsumesMultipleTrackBoundaries(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_800_000_000, 0)
	freezeStationClockForTest(app.station, fixed)
	if _, err := app.db.Exec(`
update stations set track_id='one', position=0, playing=1, repeat_one=0,
	shuffle=0, updated_at=?, track_changed_at=? where id=?`,
		unixTime(fixed)-22, unixTime(fixed)-22, mainStationID); err != nil {
		t.Fatal(err)
	}
	if err := app.station.Advance(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != "one" || snapshot.Position != 4 {
		t.Fatalf("multi-boundary snapshot = %#v, want track one at 4s", snapshot)
	}
}

func TestStartupReconcilesRemovedCurrentTrack(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec("update stations set track_id='removed', playing=1 where id=?", mainStationID); err != nil {
		t.Fatal(err)
	}
	if err := app.Close(); err != nil {
		t.Fatal(err)
	}
	app, err = NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != "one" || snapshot.Playing {
		t.Fatalf("reconciled snapshot = %#v", snapshot)
	}
}

func TestCatalogRejectsDuplicateAndEscapingMedia(t *testing.T) {
	t.Run("oversized route id", func(t *testing.T) {
		cfg := newTestConfig(t)
		index := fmt.Sprintf(
			`{"tracks":[{"id":%q,"title":"One","duration":10,"organized_dir":"tracks/one","audio_sha256":"6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b"}]}`,
			strings.Repeat("a", maxRouteIDBytes+1))
		if err := os.WriteFile(filepath.Join(cfg.Archive, "index.json"), []byte(index), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "route-safe") {
			t.Fatalf("oversized catalog id error = %v", err)
		}
	})
	t.Run("empty audio", func(t *testing.T) {
		cfg := newTestConfig(t)
		audio := filepath.Join(cfg.Archive, "tracks", "one", "audio.mp3")
		if err := os.WriteFile(audio, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "audio.mp3 is empty") {
			t.Fatalf("empty audio error = %v", err)
		}
	})
	t.Run("duplicate", func(t *testing.T) {
		cfg := newTestConfig(t)
		index := `{"tracks":[` +
			`{"id":"one","title":"One","duration":10,"organized_dir":"tracks/one","audio_sha256":"6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b"},` +
			`{"id":"one","title":"Again","duration":8,"organized_dir":"tracks/two","audio_sha256":"6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b"}]}`
		if err := os.WriteFile(filepath.Join(cfg.Archive, "index.json"), []byte(index), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Fatalf("duplicate catalog error = %v", err)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		cfg := newTestConfig(t)
		audio := filepath.Join(cfg.Archive, "tracks", "one", "audio.mp3")
		if err := os.Remove(audio); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(outside, []byte("outside-marker"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, audio); err != nil {
			t.Fatal(err)
		}
		if _, err := NewApp(cfg); err == nil ||
			(!strings.Contains(err.Error(), "outside archive") &&
				!strings.Contains(err.Error(), "unsupported file type")) {
			t.Fatalf("symlink catalog error = %v", err)
		}
	})
}

func TestConcurrentLikesAccumulateAtomically(t *testing.T) {
	app := newTestApp(t)
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/like", strings.NewReader(`{"track_id":"one"}`))
			req.Header.Set("Content-Type", "application/json")
			res := httptest.NewRecorder()
			app.apiLike(res, req)
			statuses <- res.Code
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("like status = %d", status)
		}
	}
	var liked int
	if err := app.db.QueryRow("select liked from likes where track_id='one'").Scan(&liked); err != nil {
		t.Fatal(err)
	}
	if liked != 2 {
		t.Fatalf("two likes left count=%d, want 2", liked)
	}
}

func TestConcurrentLikeResponsesAreRevisionConsistent(t *testing.T) {
	app := newTestApp(t)
	type result struct {
		status    int
		revision  int64
		liked     bool
		likeCount int
		tracks    []struct {
			TrackID   string `json:"track_id"`
			Liked     bool   `json:"liked"`
			LikeCount int    `json:"like_count"`
		}
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/like", strings.NewReader(`{"track_id":"one"}`))
			req.Header.Set("Content-Type", "application/json")
			res := httptest.NewRecorder()
			app.apiLike(res, req)
			value := result{status: res.Code}
			var payload struct {
				Revision  int64 `json:"revision"`
				Liked     bool  `json:"liked"`
				LikeCount int   `json:"like_count"`
				Tracks    []struct {
					TrackID   string `json:"track_id"`
					Liked     bool   `json:"liked"`
					LikeCount int    `json:"like_count"`
				} `json:"tracks"`
			}
			if json.Unmarshal(res.Body.Bytes(), &payload) == nil {
				value.revision, value.liked, value.likeCount, value.tracks =
					payload.Revision, payload.Liked, payload.LikeCount, payload.Tracks
			}
			results <- value
		}()
	}
	wg.Wait()
	close(results)
	byRevision := map[int64]result{}
	for value := range results {
		if value.status != http.StatusOK || len(value.tracks) != len(app.tracks) {
			t.Fatalf("like response=%#v", value)
		}
		byRevision[value.revision] = value
	}
	for revision, wantCount := range map[int64]int{1: 1, 2: 2} {
		value, ok := byRevision[revision]
		if !ok {
			t.Fatalf("missing revision %d in %#v", revision, byRevision)
		}
		var trackLiked bool
		var trackLikeCount int
		for _, track := range value.tracks {
			if track.TrackID == "one" {
				trackLiked = track.Liked
				trackLikeCount = track.LikeCount
			}
		}
		if !value.liked || !trackLiked ||
			value.likeCount != wantCount || trackLikeCount != wantCount {
			t.Fatalf("revision %d response=%#v", revision, value)
		}
	}
}

func TestReaderPlaybackValidatesAndInitializesAtomically(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-one")
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/reader/playback?item_id=reader-one", nil)
			res := httptest.NewRecorder()
			app.readerPlayback(res, req)
			statuses <- res.Code
		}()
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("playback GET status = %d", status)
		}
	}
	var rows int
	if err := app.db.QueryRow("select count(*) from reader_playback").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("playback GET created %d rows", rows)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/reader/playback", strings.NewReader(
		`{"item_id":"reader-one","segment_index":-1,"position":0,"playing":true}`,
	))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.setReaderPlayback(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("invalid playback status = %d, body=%s", res.Code, res.Body.String())
	}
}

func TestMediaHEADAndSecurityBoundaries(t *testing.T) {
	app := newTestApp(t)
	server := httptest.NewServer(app.routes())
	defer server.Close()

	req, err := http.NewRequest(http.MethodHead, server.URL+"/media/one/audio", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Accept-Ranges") != "bytes" ||
		response.ContentLength != 5 || len(body) != 0 {
		t.Fatalf("HEAD status=%d ranges=%q length=%d body=%d",
			response.StatusCode, response.Header.Get("Accept-Ranges"), response.ContentLength, len(body))
	}

	evil := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(`{"action":"play"}`))
	evil.Host = "radio.example"
	evil.Header.Set("Origin", "https://evil.example")
	evil.Header.Set("Content-Type", "application/json")
	evilRes := httptest.NewRecorder()
	app.routes().ServeHTTP(evilRes, evil)
	if evilRes.Code != http.StatusMisdirectedRequest {
		t.Fatalf("cross-origin status = %d", evilRes.Code)
	}

	large := `{"action":"play","owner_token":"` + strings.Repeat("x", maxJSONBodyBytes) + `"}`
	largeReq := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(large))
	largeReq.Header.Set("Content-Type", "application/json")
	largeRes := httptest.NewRecorder()
	app.routes().ServeHTTP(largeRes, largeReq)
	if largeRes.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d, body=%s", largeRes.Code, largeRes.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/", nil)
	getRes := httptest.NewRecorder()
	app.routes().ServeHTTP(getRes, getReq)
	if !strings.Contains(getRes.Header().Get("Content-Security-Policy"), "object-src 'none'") ||
		getRes.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("security headers = %#v", getRes.Header())
	}
}

func TestStationCreationIsRateLimited(t *testing.T) {
	app := newTestApp(t)
	handler := app.routes()
	for i := 1; i <= maxCreatorStations+1; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/stations", strings.NewReader(fmt.Sprintf(
			`{"track_id":"one","idempotency_key":"%064x","owner_token":"%048x"}`, i, i)))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "192.0.2.20:4000"
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if i <= maxCreatorStations && res.Code != http.StatusCreated {
			t.Fatalf("creation %d status = %d, body=%s", i, res.Code, res.Body.String())
		}
		if i == maxCreatorStations+1 && res.Code != http.StatusTooManyRequests {
			t.Fatalf("creation %d status = %d, want 429", i, res.Code)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/stations", strings.NewReader(
		`{"track_id":"one","idempotency_key":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","owner_token":"ffffffffffffffffffffffffffffffffffffffffffffffff"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "192.0.2.21:4000"
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("distinct creator status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestStationCreationRetriesAreIdempotent(t *testing.T) {
	app := newTestApp(t)
	idempotencyKey := "0123456789abcdef0123456789abcdef"
	ownerToken := "0123456789abcdef0123456789abcdef0123456789abcdef"
	creator := tokenHash("idempotent-creator")
	type result struct {
		id, token string
		err       error
	}
	create := func() result {
		id, token, _, err := app.station.CreateIdempotent(
			context.Background(), "one", creator, idempotencyKey, ownerToken)
		return result{id: id, token: token, err: err}
	}
	const retries = 8
	results := make(chan result, retries)
	var group sync.WaitGroup
	for range retries {
		group.Add(1)
		go func() {
			defer group.Done()
			results <- create()
		}()
	}
	group.Wait()
	close(results)
	var first result
	for value := range results {
		if value.err != nil {
			t.Fatalf("idempotent creation failed: %v", value.err)
		}
		if first.id == "" {
			first = value
		} else if value.id != first.id || value.token != first.token {
			t.Fatalf("retry returned different credentials: first=%#v value=%#v", first, value)
		}
	}
	var stations, keys int
	if err := app.db.QueryRow(
		"select count(*) from stations where kind='temporary'").Scan(&stations); err != nil {
		t.Fatal(err)
	}
	if err := app.db.QueryRow(
		"select count(*) from station_creation_keys").Scan(&keys); err != nil {
		t.Fatal(err)
	}
	if stations != 1 || keys != 1 {
		t.Fatalf("idempotent retries created stations=%d keys=%d", stations, keys)
	}
	changedCreator := tokenHash("same-browser-new-network")
	if id, token, _, err := app.station.CreateIdempotent(
		context.Background(), "one", changedCreator, idempotencyKey, ownerToken,
	); err != nil || id != first.id || token != first.token {
		t.Fatalf("network change broke idempotent retry: id=%q token=%q err=%v",
			id, token, err)
	}

	if _, _, _, err := app.station.CreateIdempotent(
		context.Background(), "one", creator, idempotencyKey,
		"ffffffffffffffffffffffffffffffffffffffffffffffff",
	); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("idempotency key accepted different owner token: %v", err)
	}
}

func TestHealthFailsWhenDatabaseFails(t *testing.T) {
	app := newTestApp(t)
	app.cancel()
	app.wg.Wait()
	if err := app.db.Close(); err != nil {
		t.Fatal(err)
	}
	app.refreshIntegrity(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	res := httptest.NewRecorder()
	app.health(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("health status = %d, body=%s", res.Code, res.Body.String())
	}
}

func TestReaderPublicDTOAndSourceAreSafe(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-safe")

	req := httptest.NewRequest(http.MethodGet, "/api/reader/items/reader-safe", nil)
	res := httptest.NewRecorder()
	app.readerItemSubroute(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("item status = %d, body=%s", res.Code, res.Body.String())
	}
	var payload map[string]map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"source_path", "storage_dir", "manifest_path", "source_hash", "notes"} {
		if _, exists := payload["item"][forbidden]; exists {
			t.Fatalf("public item exposed %q", forbidden)
		}
	}

	sourceReq := httptest.NewRequest(http.MethodGet, "/reader-source/reader-safe/source", nil)
	sourceRes := httptest.NewRecorder()
	app.readerSource(sourceRes, sourceReq)
	if sourceRes.Code != http.StatusOK ||
		sourceRes.Header().Get("Content-Type") != "text/plain; charset=utf-8" ||
		!strings.Contains(sourceRes.Header().Get("Content-Disposition"), "attachment") ||
		sourceRes.Header().Get("Content-Security-Policy") != "sandbox" ||
		sourceRes.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("source status=%d headers=%#v path=%s", sourceRes.Code, sourceRes.Header(), source)
	}
}

func TestMigrationCreatesValidatedBackup(t *testing.T) {
	cfg := newTestConfig(t)
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`create table station (
		id integer primary key, track_id text not null, position real not null,
		playing integer not null, updated_at real not null, track_changed_at real not null
	); insert into station values (1, 'one', 0, 0, 1, 1);`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v0-*.bak")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 {
		t.Fatalf("migration backups = %v", backups)
	}
	check, err := sql.Open("sqlite", backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var result string
	if err := check.QueryRow("PRAGMA quick_check").Scan(&result); err != nil || result != "ok" {
		t.Fatalf("backup quick_check = %q, err=%v", result, err)
	}
}

func seedReaderItem(t *testing.T, app *App, id string) string {
	t.Helper()
	storage := filepath.Join(app.cfg.ReaderLibrary, id)
	if err := os.MkdirAll(filepath.Join(storage, "audio"), 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(storage, "source.html")
	audio := filepath.Join(storage, "audio", "0.mp3")
	if err := os.WriteFile(source, []byte(`<script>window.parent.pwned=true</script>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(audio, []byte("reader-audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, "manifest.json"), []byte(`{"ok":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_items (
	id, title, source_url, source_type, source_hash, author, published_at,
	uploaded_at, generated_at, status, voice, tts_backend, tts_speed,
	storage_dir, source_path, normalized_text_path, manifest_path,
	total_duration, segment_count, audio_bytes, extractor_version,
	quality_score, quality_warnings, cleanup_after, notes
) values (?, 'Reader', 'https://example.test', 'html', 'secret-hash', '', '',
	1, 1, 'ready', 'voice', 'tts', 1, ?, ?, ?, ?, 10, 1, ?, 'v1', 1, '[]', null, 'private')`,
		id, storage, source, source, filepath.Join(storage, "manifest.json"), len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_segments (
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values (?, 0, '[]', 'paragraph', 'Reader text', 0, 11, ?, 10, ?, 'ready',
	'032db9910de40cf69f572de7b42c639d4ea8afbb52d114f57ac42e902ad0d3af')`,
		id, audio, len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	return source
}

func TestReaderItemCursorIsStableAcrossNewInsertions(t *testing.T) {
	app := newTestApp(t)
	for index, id := range []string{"reader-old", "reader-middle", "reader-new"} {
		seedReaderItem(t, app, id)
		if _, err := app.db.Exec("update reader_items set uploaded_at=? where id=?",
			(index+1)*10, id); err != nil {
			t.Fatal(err)
		}
	}
	page := func(path string) struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		NextCursor string `json:"next_cursor"`
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		app.readerItems(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, res.Code, res.Body.String())
		}
		var payload struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			NextCursor string `json:"next_cursor"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	first := page("/api/reader/items?limit=2")
	if len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first cursor page=%#v", first)
	}
	seedReaderItem(t, app, "reader-inserted")
	if _, err := app.db.Exec(
		"update reader_items set uploaded_at=40 where id='reader-inserted'"); err != nil {
		t.Fatal(err)
	}
	second := page("/api/reader/items?limit=2&cursor=" + first.NextCursor)
	seen := map[string]bool{}
	for _, item := range append(first.Items, second.Items...) {
		if seen[item.ID] {
			t.Fatalf("cursor traversal duplicated %q", item.ID)
		}
		seen[item.ID] = true
	}
	for _, id := range []string{"reader-old", "reader-middle", "reader-new"} {
		if !seen[id] {
			t.Fatalf("cursor traversal omitted retained item %q: %#v", id, seen)
		}
	}
	if seen["reader-inserted"] {
		t.Fatalf("cursor traversal incorporated a newer insertion mid-snapshot: %#v", seen)
	}
}

func TestLikePublishesFreshSnapshot(t *testing.T) {
	app := newTestApp(t)
	events, unsubscribe := app.events.Subscribe("track-stats")
	defer unsubscribe()
	req := httptest.NewRequest(http.MethodPost, "/api/like", strings.NewReader(`{"track_id":"one"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiLike(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("like status=%d body=%s", res.Code, res.Body.String())
	}
	var response struct {
		Revision int64 `json:"revision"`
		Tracks   []struct {
			TrackID string `json:"track_id"`
			Liked   bool   `json:"liked"`
		} `json:"tracks"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Revision == 0 || len(response.Tracks) != len(app.tracks) {
		t.Fatalf("like response is not a complete revision: %#v", response)
	}
	select {
	case payload := <-events:
		var event struct {
			Revision int64 `json:"revision"`
			Tracks   []struct {
				TrackID   string `json:"track_id"`
				Liked     bool   `json:"liked"`
				SkipCount int    `json:"skip_count"`
			} `json:"tracks"`
		}
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatal(err)
		}
		var liked bool
		for _, stat := range event.Tracks {
			if stat.TrackID == "one" {
				liked = stat.Liked
			}
		}
		if !liked || event.Revision == 0 {
			t.Fatalf("published track stats=%#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("like did not publish a track-stat event")
	}
}

func TestReaderPlaybackRejectsStaleWrites(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-ordered")
	post := func(position float64, baseRevision int64) *httptest.ResponseRecorder {
		body := fmt.Sprintf(
			`{"item_id":"reader-ordered","segment_index":0,"position":%g,"playing":true,"base_revision":%d}`,
			position, baseRevision)
		req := httptest.NewRequest(http.MethodPost, "/api/reader/playback", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.setReaderPlayback(res, req)
		return res
	}
	if res := post(8, 0); res.Code != http.StatusOK {
		t.Fatalf("new playback status=%d body=%s", res.Code, res.Body.String())
	}
	if res := post(2, 0); res.Code != http.StatusConflict {
		t.Fatalf("stale playback status=%d body=%s", res.Code, res.Body.String())
	}
	var position float64
	var revision int64
	if err := app.db.QueryRow(`
select position, revision from reader_playback where item_id='reader-ordered'`).
		Scan(&position, &revision); err != nil {
		t.Fatal(err)
	}
	if position != 8 || revision != 1 {
		t.Fatalf("stale save overwrote playback: position=%g revision=%d", position, revision)
	}
	if res := post(3, 1); res.Code != http.StatusOK {
		t.Fatalf("current playback status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestReaderPlaybackNormalizesExactSegmentEnds(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-ends")
	audio := filepath.Join(filepath.Dir(source), "audio", "1.mp3")
	if err := os.WriteFile(audio, []byte("reader-audio"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_segments (
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values ('reader-ends', 1, '[]', 'paragraph', 'Second', 12, 18, ?, 10, ?, 'ready',
	'032db9910de40cf69f572de7b42c639d4ea8afbb52d114f57ac42e902ad0d3af')`,
		audio, len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	post := func(index int, position float64, revision int64) map[string]any {
		body := fmt.Sprintf(
			`{"item_id":"reader-ends","segment_index":%d,"position":%g,"playing":true,"base_revision":%d}`,
			index, position, revision)
		req := httptest.NewRequest(http.MethodPost, "/api/reader/playback", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.setReaderPlayback(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("playback status=%d body=%s", res.Code, res.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	middle := post(0, 10, 0)
	if middle["segment_index"] != float64(1) || middle["position"] != float64(0) ||
		middle["playing"] != true || middle["revision"] != float64(1) {
		t.Fatalf("middle exact-end playback=%#v", middle)
	}
	final := post(1, 10, 1)
	if final["segment_index"] != float64(1) || final["position"] != float64(10) ||
		final["playing"] != false || final["revision"] != float64(2) {
		t.Fatalf("final exact-end playback=%#v", final)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/reader/playback?item_id=reader-ends", nil)
	res := httptest.NewRecorder()
	app.readerPlayback(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("exact-end GET status=%d body=%s", res.Code, res.Body.String())
	}
	var restored map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	if restored["segment_index"] != float64(1) || restored["position"] != float64(10) ||
		restored["playing"] != false || restored["revision"] != float64(2) {
		t.Fatalf("restored exact-end playback=%#v", restored)
	}
}

func TestReaderPlaybackFallbackPreservesRevision(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-fallback-revision")
	audio := filepath.Join(filepath.Dir(source), "audio", "1.mp3")
	if err := os.WriteFile(audio, []byte("reader-audio"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_segments (
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values ('reader-fallback-revision', 1, '[]', 'paragraph', 'Fallback', 12, 20, ?, 10, ?, 'ready',
	'032db9910de40cf69f572de7b42c639d4ea8afbb52d114f57ac42e902ad0d3af')`,
		audio, len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	post := func(index int, position float64, revision int64) *httptest.ResponseRecorder {
		body := fmt.Sprintf(
			`{"item_id":"reader-fallback-revision","segment_index":%d,"position":%g,"playing":true,"base_revision":%d}`,
			index, position, revision)
		req := httptest.NewRequest(http.MethodPost, "/api/reader/playback", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.setReaderPlayback(res, req)
		return res
	}
	if res := post(0, 4, 0); res.Code != http.StatusOK {
		t.Fatalf("initial playback status=%d body=%s", res.Code, res.Body.String())
	}
	if _, err := app.db.Exec(`
update reader_segments set status='pending' where item_id='reader-fallback-revision' and segment_index=0`); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/api/reader/playback?item_id=reader-fallback-revision", nil)
	res := httptest.NewRecorder()
	app.readerPlayback(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("fallback GET status=%d body=%s", res.Code, res.Body.String())
	}
	var fallback map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &fallback); err != nil {
		t.Fatal(err)
	}
	if fallback["segment_index"] != float64(1) || fallback["revision"] != float64(1) {
		t.Fatalf("fallback playback=%#v", fallback)
	}
	if res := post(1, 2, 1); res.Code != http.StatusOK {
		t.Fatalf("fallback save status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestFreshReaderPlaybackStartsAtFirstReadySegment(t *testing.T) {
	app := newTestApp(t)
	source := seedReaderItem(t, app, "reader-fresh")
	audio := filepath.Join(filepath.Dir(source), "audio", "1.mp3")
	if err := os.WriteFile(audio, []byte("reader-audio"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_segments (
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values ('reader-fresh', 1, '[]', 'paragraph', 'Second', 12, 20, ?, 10, ?, 'ready',
	'032db9910de40cf69f572de7b42c639d4ea8afbb52d114f57ac42e902ad0d3af')`,
		audio, len("reader-audio")); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet,
		"/api/reader/playback?item_id=reader-fresh", nil)
	res := httptest.NewRecorder()
	app.readerPlayback(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("fresh playback status=%d body=%s", res.Code, res.Body.String())
	}
	var playback map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &playback); err != nil {
		t.Fatal(err)
	}
	if playback["segment_index"] != float64(0) || playback["position"] != float64(0) ||
		playback["playing"] != false || playback["revision"] != float64(0) {
		t.Fatalf("fresh playback skipped the first segment: %#v", playback)
	}
}

func TestBroadcasterDropsLateLowerRevision(t *testing.T) {
	events := NewBroadcaster()
	pending, unsubscribe := events.Subscribe("track-stats")
	defer unsubscribe()
	events.PublishValue("track-stats", map[string]any{"revision": int64(2), "liked": true})
	events.PublishValue("track-stats", map[string]any{"revision": int64(1), "liked": false})
	var payload map[string]any
	if err := json.Unmarshal(<-pending, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["revision"] != float64(2) || payload["liked"] != true {
		t.Fatalf("late lower revision replaced current payload: %#v", payload)
	}
}

func TestTrackStatsCoalesceCompleteCatalogState(t *testing.T) {
	app := newTestApp(t)
	events, unsubscribe := app.events.Subscribe("track-stats")
	defer unsubscribe()
	for _, id := range []string{"one", "two"} {
		req := httptest.NewRequest(http.MethodPost, "/api/like",
			strings.NewReader(fmt.Sprintf(`{"track_id":%q}`, id)))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.apiLike(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("like %s status=%d body=%s", id, res.Code, res.Body.String())
		}
	}
	select {
	case payload := <-events:
		var event struct {
			Revision int64 `json:"revision"`
			Tracks   []struct {
				TrackID string `json:"track_id"`
				Liked   bool   `json:"liked"`
			} `json:"tracks"`
		}
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatal(err)
		}
		liked := map[string]bool{}
		for _, track := range event.Tracks {
			liked[track.TrackID] = track.Liked
		}
		if event.Revision != 2 || !liked["one"] || !liked["two"] {
			t.Fatalf("coalesced track stats=%#v liked=%#v", event, liked)
		}
	case <-time.After(time.Second):
		t.Fatal("missing coalesced track stats")
	}
}

func TestEarlySkipPublishesTrackStats(t *testing.T) {
	app := newTestApp(t)
	events, unsubscribe := app.events.Subscribe("track-stats")
	defer unsubscribe()
	req := httptest.NewRequest(http.MethodPost, "/api/control", strings.NewReader(`{"action":"next"}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiControl(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("next status=%d body=%s", res.Code, res.Body.String())
	}
	select {
	case payload := <-events:
		var event struct {
			Revision int64 `json:"revision"`
			Tracks   []struct {
				TrackID   string `json:"track_id"`
				SkipCount int    `json:"skip_count"`
			} `json:"tracks"`
		}
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatal(err)
		}
		var skips int
		for _, track := range event.Tracks {
			if track.TrackID == "one" {
				skips = track.SkipCount
			}
		}
		if event.Revision != 1 || skips != 1 {
			t.Fatalf("early-skip track stats=%#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("missing early-skip track stats")
	}
}

func TestCompletedShortTrackDoesNotCountAsEarlySkip(t *testing.T) {
	app := newTestApp(t)
	fixed := time.Unix(1_800_000_000, 0)
	freezeStationClockForTest(app.station, fixed)
	app.station.catalog.ByID["one"].Duration = float64(4)
	if _, err := app.db.Exec(`
update stations set track_id='one', position=0, playing=1, updated_at=?, track_changed_at=?
where id=?`, unixTime(fixed)-4, unixTime(fixed)-4, mainStationID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.station.Execute(context.Background(), Command{Action: "next"}); err != nil {
		t.Fatal(err)
	}
	var skips int
	if err := app.db.QueryRow(`
select coalesce((select skip_count from skip_counts where track_id='one'), 0)`).Scan(&skips); err != nil {
		t.Fatal(err)
	}
	if skips != 0 {
		t.Fatalf("completed short track counted as %d early skips", skips)
	}
}
