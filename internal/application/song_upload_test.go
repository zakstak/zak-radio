package application

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	appconfig "zak-radio/internal/config"
	stationmodel "zak-radio/internal/station"
)

func songAudioFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("internal/application/testdata/upload.mp3")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func songUploadRequest(t *testing.T, data []byte, filename string, fields map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := form.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := form.CreateFormFile("audio", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://example.com/api/tracks", &body)
	request.RemoteAddr = "192.0.2.8:1234"
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.Header.Set("Origin", "http://example.com")
	request.Header.Set("X-Test-SSO-User", "listener")
	return request
}

func TestSongUploadRequiresTrustedSignedInUser(t *testing.T) {
	cases := []struct {
		name, header, user, remote, origin string
		status                             int
	}{
		{"disabled", "", "listener", "192.0.2.8:1234", "http://example.com", 401},
		{"signed out", "X-Test-SSO-User", "", "192.0.2.8:1234", "http://example.com", 401},
		{"spoofed direct identity", "X-Test-SSO-User", "listener", "127.0.0.1:1234", "http://example.com", 403},
		{"spoofed loopback identity", "X-Test-SSO-User", "listener", "127.0.0.1:1234", "http://127.0.0.1", 401},
		{"cross origin", "X-Test-SSO-User", "listener", "192.0.2.8:1234", "https://evil.example", 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(t)
			app.cfg.UploadIdentityHeader = tc.header
			req := songUploadRequest(t, nil, "test.mp3", nil)
			req.RemoteAddr = tc.remote
			if strings.Contains(tc.name, "loopback") {
				req.Host = "127.0.0.1"
			}
			req.Header.Set("Origin", tc.origin)
			req.Header.Set("X-Test-SSO-User", tc.user)
			res := httptest.NewRecorder()
			app.routes().ServeHTTP(res, req)
			if res.Code != tc.status {
				t.Fatalf("status %d: %s", res.Code, res.Body.String())
			}
			if len(app.catalogSnapshot().Tracks) != 2 {
				t.Fatal("unauthorized request changed library")
			}
		})
	}
}

func TestSongUploadPublishesPlayablePersistentSong(t *testing.T) {
	cfg := newTestConfig(t)
	cfg.UploadIdentityHeader = "X-Test-SSO-User"
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if app != nil {
			_ = app.Close()
		}
	}()
	// Keep unknown archive metadata byte-for-byte as JSON values.
	path := filepath.Join(cfg.Archive, "index.json")
	data, _ := os.ReadFile(path)
	var index map[string]json.RawMessage
	if err = json.Unmarshal(data, &index); err != nil {
		t.Fatal(err)
	}
	index["archive_note"] = json.RawMessage(`{"keep":true}`)
	data, _ = json.Marshal(index)
	if err = os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	// Deliberately changing the catalog after startup is refused.
	audio := songAudioFixture(t)
	request := func() *http.Request {
		return songUploadRequest(t, audio, "My song.MP3", map[string]string{"title": "Café lights", "artist": "A listener", "lyrics": "[Chorus]\nCity lights"})
	}
	res := httptest.NewRecorder()
	app.routes().ServeHTTP(res, request())
	if res.Code != 500 {
		t.Fatalf("external mutation accepted: %d %s", res.Code, res.Body.String())
	}
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	app = nil
	app, err = NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	oldRevision := app.catalogSnapshot().Revision
	// Prime filter search before upload, then ensure its cache is invalidated.
	app.station.mu.Lock()
	app.station.searchIndex()
	app.station.mu.Unlock()
	events, unsubscribe := app.events.Subscribe("catalog")
	defer unsubscribe()
	res = httptest.NewRecorder()
	app.routes().ServeHTTP(res, request())
	if res.Code != 201 {
		t.Fatalf("upload status %d: %s", res.Code, res.Body.String())
	}
	var payload struct {
		Track map[string]any `json:"track"`
	}
	if err = json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	id := payload.Track["id"].(string)
	track := app.catalogSnapshot().ByID[id]
	if track == nil || track.Title != "Café lights" || track.Artist != "A listener" || !track.HasLyrics || track.AudioSHA256 != fmt.Sprintf("%x", sha256.Sum256(audio)) || asFloat(track.Duration) < .35 || oldRevision == app.catalogSnapshot().Revision {
		t.Fatalf("wrong uploaded track: %#v", track)
	}
	select {
	case <-events:
	default:
		t.Fatal("catalog update not broadcast")
	}
	media := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/media/"+id+"/audio", nil)
	req.Header.Set("Range", "bytes=0-7")
	app.media(media, req)
	if media.Code != 206 || !bytes.Equal(media.Body.Bytes(), audio[:8]) {
		t.Fatalf("media status %d", media.Code)
	}
	lyrics := httptest.NewRecorder()
	app.apiTrackText(lyrics, httptest.NewRequest(http.MethodGet, "/api/track/"+id, nil))
	if !strings.Contains(lyrics.Body.String(), "City lights") {
		t.Fatal("lyrics missing")
	}
	if _, err = app.station.Execute(context.Background(), stationmodel.Command{Action: "select", TrackID: id}); err != nil {
		t.Fatalf("new song not playable by Radio: %v", err)
	}
	app.station.mu.Lock()
	found := app.station.searchTrackIDs([]string{id}, "cafe")
	app.station.mu.Unlock()
	if len(found) != 1 {
		t.Fatal("new song missing from station search")
	}
	app.auditAllIntegrity(context.Background())
	for check, ok := range app.integritySnapshot() {
		if !ok {
			t.Errorf("integrity %s failed", check)
		}
	}
	dup := httptest.NewRecorder()
	app.routes().ServeHTTP(dup, request())
	if dup.Code != 409 || len(app.catalogSnapshot().Tracks) != 3 {
		t.Fatalf("duplicate status %d: %s", dup.Code, dup.Body.String())
	}
	persisted, _ := os.ReadFile(path)
	if !bytes.Contains(persisted, []byte(`"archive_note":{"keep":true}`)) {
		t.Fatal("existing metadata discarded")
	}
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	app = nil
	restarted, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app = restarted
	if app.catalogSnapshot().ByID[id] == nil || len(app.catalogSnapshot().Tracks) != 3 {
		t.Fatal("upload lost after restart")
	}
}

func TestSongUploadRejectsInvalidFormatWithoutChangingCatalog(t *testing.T) {
	audio := songAudioFixture(t)
	cases := []struct {
		fields         map[string]string
		name, filename string
		audio          []byte
		status         int
	}{
		{name: "missing title", filename: "song.mp3", audio: audio, fields: map[string]string{"artist": "Listener"}, status: 400},
		{name: "missing artist", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song"}, status: 400},
		{name: "long title", filename: "song.mp3", audio: audio, fields: map[string]string{"title": strings.Repeat("x", 121), "artist": "Listener"}, status: 400},
		{name: "multiline title", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song\nFake", "artist": "Listener"}, status: 400},
		{name: "invalid UTF8", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song", "artist": string([]byte{255})}, status: 400},
		{name: "control lyrics", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song", "artist": "Listener", "lyrics": "bad\x00text"}, status: 400},
		{name: "large lyrics", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song", "artist": "Listener", "lyrics": strings.Repeat("x", maxSongLyricsBytes+1)}, status: 413},
		{name: "unexpected field", filename: "song.mp3", audio: audio, fields: map[string]string{"title": "Song", "artist": "Listener", "organized_dir": "../escape"}, status: 400},
		{name: "not MP3", filename: "song.mp3", audio: []byte("fake MP3"), fields: map[string]string{"title": "Song", "artist": "Listener"}, status: 400},
		{name: "wrong extension", filename: "song.wav", audio: audio, fields: map[string]string{"title": "Song", "artist": "Listener"}, status: 400},
		{name: "truncated MP3", filename: "song.mp3", audio: audio[:len(audio)-20], fields: map[string]string{"title": "Song", "artist": "Listener"}, status: 400},
	}
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	before, _ := os.ReadFile(filepath.Join(app.cfg.Archive, "index.json"))
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := httptest.NewRecorder()
			app.routes().ServeHTTP(res, songUploadRequest(t, tc.audio, tc.filename, tc.fields))
			if res.Code != tc.status {
				t.Fatalf("status %d: %s", res.Code, res.Body.String())
			}
			after, _ := os.ReadFile(filepath.Join(app.cfg.Archive, "index.json"))
			if !bytes.Equal(before, after) || len(app.catalogSnapshot().Tracks) != 2 {
				t.Fatal("invalid song changed catalog")
			}
		})
	}
}

func TestSongUploadConcurrentReadersAndDuplicateWriters(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	audio := songAudioFixture(t)
	done := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 3; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				_, _ = app.station.Snapshot(ctx, mainStationID)
				_, _ = app.station.ListSaved(ctx)
				_, _, _ = app.tracksWithStats(ctx, app.catalogSnapshot())
				cancel()
			}
		}()
	}
	var writers sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		req := songUploadRequest(t, audio, "song.mp3", map[string]string{"title": "Concurrent song", "artist": "Listener"})
		writers.Add(1)
		go func() {
			defer writers.Done()
			res := httptest.NewRecorder()
			app.routes().ServeHTTP(res, req)
			codes <- res.Code
		}()
	}
	writers.Wait()
	close(done)
	readers.Wait()
	close(codes)
	successes := 0
	for code := range codes {
		if code == 201 {
			successes++
		} else if code != 409 && code != 429 {
			t.Errorf("unexpected status %d", code)
		}
	}
	if successes != 1 || len(app.catalogSnapshot().Tracks) != 3 {
		t.Fatal("concurrent writers did not publish exactly one song")
	}
}

func TestSongUploadBodyAndLibraryLimits(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	req := songUploadRequest(t, bytes.Repeat([]byte{'x'}, maxSongAudioBytes+1), "huge.mp3", map[string]string{"title": "Song", "artist": "Listener"})
	res := httptest.NewRecorder()
	app.routes().ServeHTTP(res, req)
	if res.Code != 413 {
		t.Fatalf("oversized upload status %d", res.Code)
	}
	// A storage failure must leave the original index playable.
	uploads := filepath.Join(app.cfg.Archive, "uploads", "Listener songs")
	if err := os.MkdirAll(uploads, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(app.cfg.Archive, 0o555); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(app.cfg.Archive, 0o755) }()
	res = httptest.NewRecorder()
	app.routes().ServeHTTP(res, songUploadRequest(t, songAudioFixture(t), "song.mp3", map[string]string{"title": "Song", "artist": "Listener"}))
	if res.Code != 500 {
		t.Fatalf("failed storage status %d: %s", res.Code, res.Body.String())
	}
	if len(app.catalogSnapshot().Tracks) != 2 {
		t.Fatal("failed storage published track")
	}
	entries, err := os.ReadDir(uploads)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed index write left media behind: %v %v", entries, err)
	}
}

func TestSongUploadIdentityConfiguration(t *testing.T) {
	for _, header := range []string{"Cookie", "X-Real-IP", "X-Forwarded-Host", "X-Kiln-Ingress", "X-Bad\nHeader"} {
		if _, err := (appconfig.Config{UploadIdentityHeader: header, TrustedProxies: "192.0.2.8"}).Normalized(); err == nil {
			t.Errorf("unsafe header accepted: %q", header)
		}
	}
	if _, err := (appconfig.Config{UploadIdentityHeader: "X-Test-SSO-User"}).Normalized(); err == nil {
		t.Fatal("identity enabled without trusted peer")
	}
}

// Make sure multipart failures preserve admission limits even for streamed bodies.
func TestSongUploadRejectsTruncatedMultipart(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	req := songUploadRequest(t, songAudioFixture(t), "song.mp3", map[string]string{"title": "Song", "artist": "Listener"})
	data, _ := io.ReadAll(req.Body)
	req.Body = io.NopCloser(bytes.NewReader(data[:len(data)-10]))
	res := httptest.NewRecorder()
	app.routes().ServeHTTP(res, req)
	if res.Code != 400 || len(app.catalogSnapshot().Tracks) != 2 {
		t.Fatalf("truncated form status %d", res.Code)
	}
}

func TestSongUploadOverHTTPNotifiesConnectedListeners(t *testing.T) {
	cfg := newTestConfig(t)
	cfg.TrustedProxies = "127.0.0.1"
	cfg.UploadIdentityHeader = "X-Test-SSO-User"
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = app.Close() }()
	server := httptest.NewServer(app.routes())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	streamRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/station/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := server.Client().Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Body.Close() }()
	scanner := bufio.NewScanner(stream.Body)
	// Wait until subscribed and the initial state has reached the HTTP client.
	if !scanner.Scan() || scanner.Text() != "event: station" {
		t.Fatalf("no initial station event: %v", scanner.Err())
	}
	req := songUploadRequest(t, songAudioFixture(t), "song.mp3", map[string]string{"title": "HTTP song", "artist": "Listener"})
	req.URL.Scheme, req.URL.Host = "http", strings.TrimPrefix(server.URL, "http://")
	req.Host = req.URL.Host
	req.RequestURI = ""
	req.Header.Set("Origin", server.URL)
	response, err := server.Client().Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 201 {
		t.Fatalf("HTTP upload status %d", response.StatusCode)
	}
	for scanner.Scan() {
		if scanner.Text() == "event: catalog" {
			return
		}
	}
	t.Fatalf("connected listener missed catalog update: %v", scanner.Err())
}
