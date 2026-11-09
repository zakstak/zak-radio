package application

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func songKeyRequest(method, path, user, body string) *http.Request {
	r := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.8:1234"
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("Content-Type", "application/json")
	if user != "" {
		r.Header.Set("X-Test-SSO-User", user)
	}
	return r
}

func createSongKeyForTest(t *testing.T, handler http.Handler, user, body string) (songUploadKey, string) {
	t.Helper()
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, songKeyRequest(http.MethodPost, "/api/song-upload/keys", user, body))
	if res.Code != http.StatusCreated {
		t.Fatalf("create key: %d %s", res.Code, res.Body.String())
	}
	var result struct {
		Token string        `json:"token"`
		Key   songUploadKey `json:"key"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if res.Header().Get("Cache-Control") != "no-store" || result.Key.Scope != songUploadKeyScope || len(result.Token) != len(songUploadKeyPrefix)+64 {
		t.Fatal("invalid key response or cache policy")
	}
	return result.Key, result.Token
}

func assertSongAPIError(t *testing.T, res *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var payload struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatalf("error is not JSON: %d %s", res.Code, res.Body.String())
	}
	if res.Code != status || payload.Error.Code != code || payload.Error.Message == "" || !strings.HasPrefix(res.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("want %d %s, got %d %s", status, code, res.Code, res.Body.String())
	}
}

func TestSongUploadKeyOwnershipAndRevocation(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	handler := app.routes()
	key, token := createSongKeyForTest(t, handler, "alice", `{"name":"My agent"}`)
	if key.ExpiresAt-key.CreatedAt != defaultSongKeyDays*secondsPerDay {
		t.Fatal("wrong default expiry")
	}
	var stored, owner string
	if err := app.db.QueryRow(`select token_hash,owner_hash from song_upload_keys where id=?`, key.ID).Scan(&stored, &owner); err != nil {
		t.Fatal(err)
	}
	if stored != tokenHash(token) || owner != tokenHash("alice") || stored == token {
		t.Fatal("database did not hash the secret and owner")
	}
	list := httptest.NewRecorder()
	handler.ServeHTTP(list, songKeyRequest(http.MethodGet, "/api/song-upload/keys", "alice", ""))
	if list.Code != 200 || !strings.Contains(list.Body.String(), key.ID) {
		t.Fatalf("own key missing: %s", list.Body.String())
	}
	for _, private := range []string{token, stored, owner, "token_hash", "owner_hash", `"token"`} {
		if strings.Contains(list.Body.String(), private) {
			t.Fatal("key list exposed private credentials")
		}
	}
	other := httptest.NewRecorder()
	handler.ServeHTTP(other, songKeyRequest(http.MethodGet, "/api/song-upload/keys", "bob", ""))
	if other.Code != 200 || strings.Contains(other.Body.String(), key.ID) {
		t.Fatal("key list crossed users")
	}
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, songKeyRequest(http.MethodDelete, "/api/song-upload/keys/"+key.ID, "bob", ""))
	assertSongAPIError(t, denied, 404, "key_not_found")
	access := func(want bool) {
		t.Helper()
		r := songKeyRequest(http.MethodGet, "/api/song-upload", "", "")
		r.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, r)
		var capability struct {
			CanUpload     bool `json:"can_upload"`
			CanManageKeys bool `json:"can_manage_keys"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &capability); err != nil || res.Code != 200 || capability.CanUpload != want || capability.CanManageKeys {
			t.Fatalf("capability: %d %s", res.Code, res.Body.String())
		}
	}
	access(true)
	revoked := httptest.NewRecorder()
	handler.ServeHTTP(revoked, songKeyRequest(http.MethodDelete, "/api/song-upload/keys/"+key.ID, "alice", ""))
	if revoked.Code != 200 {
		t.Fatalf("revoke: %d %s", revoked.Code, revoked.Body.String())
	}
	access(false)
	r := songUploadRequest(t, nil, "song.mp3", nil)
	r.Header.Del("X-Test-SSO-User")
	r.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, r)
	assertSongAPIError(t, res, 401, "unauthorized")
}

func TestSongUploadKeyCannotControlOrManageKeys(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	handler := app.routes()
	key, token := createSongKeyForTest(t, handler, "alice", `{"name":"Agent","expires_in_days":1}`)
	for _, tc := range []struct {
		method, path, code string
		status             int
	}{
		{http.MethodGet, "/api/song-upload/keys", "sign_in_required", 401},
		{http.MethodPost, "/api/song-upload/keys", "sign_in_required", 401},
		{http.MethodDelete, "/api/song-upload/keys/" + key.ID, "sign_in_required", 401},
		{http.MethodPost, "/api/control", "insufficient_scope", 403},
		{http.MethodPost, "/api/stations", "insufficient_scope", 403},
		{http.MethodDelete, "/api/stations/main", "insufficient_scope", 403},
		{http.MethodPatch, "/api/stations/main", "insufficient_scope", 403},
		{http.MethodPost, "/api/reaction", "insufficient_scope", 403},
		{http.MethodPost, "/api/reader/playback", "insufficient_scope", 403},
		{http.MethodGet, "/api/tracks", "insufficient_scope", 403},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := songKeyRequest(tc.method, tc.path, "alice", `{"name":"Another"}`)
			r.Header.Set("Authorization", "Bearer "+token)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, r)
			assertSongAPIError(t, res, tc.status, tc.code)
		})
	}
}

func TestSongUploadKeyRejectsInvalidCredentialsWithoutSSOFallback(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	handler := app.routes()
	key, token := createSongKeyForTest(t, handler, "alice", `{"name":"Agent"}`)
	for _, values := range [][]string{
		{""}, {"Basic " + token}, {"Bearer"}, {"Bearer invalid"},
		{"Bearer " + songUploadKeyPrefix + strings.Repeat("0", 64)},
		{"Bearer " + token + ", Bearer " + token}, {"Bearer " + token, "Bearer " + token},
	} {
		r := songUploadRequest(t, nil, "song.mp3", nil) // Keep SSO to catch fallback.
		r.Header["Authorization"] = values
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, r)
		assertSongAPIError(t, res, 401, "unauthorized")
		if res.Header().Get("WWW-Authenticate") == "" {
			t.Fatal("missing bearer challenge")
		}
	}
	if _, err := app.db.Exec(`update song_upload_keys set created_at=?,expires_at=? where id=?`, time.Now().Unix()-200, time.Now().Unix()-100, key.ID); err != nil {
		t.Fatal(err)
	}
	for _, disabled := range []bool{false, true} {
		if disabled {
			app.cfg.UploadIdentityHeader = ""
			if _, err := app.db.Exec(`update song_upload_keys set expires_at=? where id=?`, time.Now().Unix()+100, key.ID); err != nil {
				t.Fatal(err)
			}
		}
		r := songUploadRequest(t, nil, "song.mp3", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, r)
		assertSongAPIError(t, res, 401, "unauthorized")
	}
}

func TestSongUploadKeyValidationAndAdmission(t *testing.T) {
	app := newTestApp(t)
	app.cfg.UploadIdentityHeader = "X-Test-SSO-User"
	handler := app.routes()
	for _, body := range []string{
		`{}`, `{"name":" "}`, `{"name":"line\nbreak"}`, `{"name":"agent","expires_in_days":-1}`,
		`{"name":"agent","expires_in_days":91}`, `{"name":"agent","expires_in_days":0}`, `{"name":"` + strings.Repeat("x", 81) + `"}`,
		`{"name":"agent","scope":"admin"}`, `{"name":"agent"} {}`, `null`,
	} {
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, songKeyRequest(http.MethodPost, "/api/song-upload/keys", "alice", body))
		if res.Code != 400 || !json.Valid(res.Body.Bytes()) {
			t.Fatalf("invalid body accepted: %d %s", res.Code, res.Body.String())
		}
	}
	for i := range maxUserSongUploadKeys {
		createSongKeyForTest(t, handler, "alice", fmt.Sprintf(`{"name":"Agent %d","expires_in_days":90}`, i))
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, songKeyRequest(http.MethodPost, "/api/song-upload/keys", "alice", `{"name":"Excess"}`))
	assertSongAPIError(t, res, 429, "key_limit")
	createSongKeyForTest(t, handler, "bob", `{"name":"Own budget"}`)
	crossOrigin := songKeyRequest(http.MethodDelete, "/api/song-upload/keys/"+strings.Repeat("a", 32), "alice", "")
	crossOrigin.Header.Set("Origin", "https://evil.example")
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, crossOrigin)
	assertSongAPIError(t, res, 403, "forbidden")
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, songKeyRequest(http.MethodPost, "/api/song-upload/keys", "", `{"name":"No login"}`))
	assertSongAPIError(t, res, 401, "sign_in_required")
	for range 21 {
		res = httptest.NewRecorder()
		handler.ServeHTTP(res, songKeyRequest(http.MethodPost, "/api/song-upload/keys", "alice", `{}`))
	}
	assertSongAPIError(t, res, 429, "too_many_requests")
	if res.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry interval")
	}
}

func TestSongUploadBearerHTTPAndRestart(t *testing.T) {
	cfg := newTestConfig(t)
	cfg.UploadIdentityHeader = "X-Test-SSO-User"
	cfg.TrustedProxies = "127.0.0.1/32"
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if app != nil {
			_ = app.Close()
		}
	}()
	_, token, _, err := app.createSongUploadKey(context.Background(), tokenHash("alice"), "HTTP agent", 30)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.routes())
	defer server.Close()
	client := server.Client()
	upload := func(data []byte) *http.Response {
		t.Helper()
		r := songUploadRequest(t, data, "song.mp3", map[string]string{"title": "Agent song", "artist": "Listener"})
		r.URL.Scheme = "http"
		r.URL.Host = strings.TrimPrefix(server.URL, "http://")
		r.Host = r.URL.Host
		r.RequestURI = ""
		r.Header.Del("Origin")
		r.Header.Del("X-Test-SSO-User")
		r.Header.Set("Authorization", "Bearer "+token)
		res, requestErr := client.Do(r)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		return res
	}
	audio := songAudioFixture(t)
	res := upload(audio)
	var created struct {
		Track struct {
			ID string `json:"id"`
		} `json:"track"`
	}
	if err = json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 201 || created.Track.ID == "" {
		t.Fatalf("bearer upload status %d", res.StatusCode)
	}
	res = upload(audio)
	var duplicate struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		ExistingTrackID string `json:"existing_track_id"`
	}
	if err = json.NewDecoder(res.Body).Decode(&duplicate); err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 409 || duplicate.Error.Code != "duplicate_audio" || duplicate.ExistingTrackID != created.Track.ID {
		t.Fatal("retry did not identify existing song")
	}
	res = upload([]byte("invalid MP3"))
	data, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil || res.StatusCode != 400 || !strings.Contains(string(data), `"code":"invalid_audio"`) {
		t.Fatalf("invalid audio: %d %s", res.StatusCode, data)
	}
	server.Close()
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	app = nil
	app, err = NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	r := songKeyRequest(http.MethodGet, "/api/song-upload", "", "")
	r.Header.Set("Authorization", "Bearer "+token)
	allowed, err := app.canUploadSong(r)
	if err != nil || !allowed || app.catalogSnapshot().ByID[created.Track.ID] == nil {
		t.Fatalf("key/song lost on restart: %v", err)
	}
}

func TestSongUploadKeyBudgetsAndExpiredCleanup(t *testing.T) {
	app := newTestApp(t)
	now := time.Now().Unix()
	_, err := app.db.Exec(`with recursive n(i) as (select 1 union all select i+1 from n where i<?)
 insert into song_upload_keys(id,token_hash,owner_hash,name,created_at,expires_at)
 select printf('%032x',i),printf('%064x',i),printf('%064x',i),'Agent',?,? from n`, maxSongUploadKeys, now-200, now+200)
	if err != nil {
		t.Fatal(err)
	}
	if err = songUploadKeyIntegrity(context.Background(), app.db); err != nil {
		t.Fatal(err)
	}
	_, _, status, err := app.createSongUploadKey(context.Background(), tokenHash("new owner"), "Agent", 30)
	if status != 429 || err == nil {
		t.Fatal("global key budget was not enforced")
	}
	if _, err = app.db.Exec(`update song_upload_keys set expires_at=?`, now-100); err != nil {
		t.Fatal(err)
	}
	_, _, status, err = app.createSongUploadKey(context.Background(), tokenHash("new owner"), "Agent", 30)
	if status != 201 || err != nil {
		t.Fatalf("expired keys consumed budget: %d %v", status, err)
	}
	var count int
	if err := app.db.QueryRow(`select count(*) from song_upload_keys`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired keys not removed: %d %v", count, err)
	}
}

func TestSongUploadKeyRetainedValidation(t *testing.T) {
	app := newTestApp(t)
	_, _, status, err := app.createSongUploadKey(context.Background(), tokenHash("alice"), "Agent", 30)
	if status != 201 || err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`update song_upload_keys set name=char(10)||'Agent'`,
		`update song_upload_keys set name=' Agent '`,
		`update song_upload_keys set expires_at=created_at+` + fmt.Sprint((maxSongKeyDays+1)*secondsPerDay),
	} {
		if _, err = app.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
		if err := songUploadKeyIntegrity(context.Background(), app.db); err == nil {
			t.Fatal("invalid retained key was admitted")
		}
		if _, err := app.db.Exec(`update song_upload_keys set name='Agent',expires_at=created_at+86400`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSongUploadKeyMigrationFromSchema18(t *testing.T) {
	cfg := newTestConfig(t)
	app, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app.cancel()
	app.wg.Wait()
	for _, statement := range []string{`drop table song_upload_keys`, `pragma user_version=18`, `update stations set track_id='two' where id='main'`} {
		if _, err = app.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err = app.Close(); err != nil {
		t.Fatal(err)
	}
	digest, err := fileSHA256(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	app, err = NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = app.Close() }()
	var version int
	var preserved string
	if err = app.db.QueryRow(`pragma user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err = app.db.QueryRow(`select track_id from stations where id='main'`).Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if version != 19 || preserved != "two" {
		t.Fatalf("migration version=%d preserved=%s", version, preserved)
	}
	if err = songUploadKeyIntegrity(context.Background(), app.db); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(cfg.DBPath + ".schema-v18-*.bak")
	if err != nil || len(backups) != 1 {
		t.Fatalf("migration backup missing: %v %v", backups, err)
	}
	backupDigest, err := fileSHA256(backups[0])
	if err != nil || backupDigest != digest {
		t.Fatal("backup does not match schema-18 database")
	}
	backup, err := sql.Open("sqlite", "file:"+backups[0]+"?mode=ro&immutable=1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = backup.Close() }()
	if err = backup.QueryRow(`pragma user_version`).Scan(&version); err != nil || version != 18 {
		t.Fatalf("backup version=%d %v", version, err)
	}
}

func TestSongUploadOpenAPIMatchesLimits(t *testing.T) {
	app := newTestApp(t)
	res := httptest.NewRecorder()
	app.routes().ServeHTTP(res, songKeyRequest(http.MethodGet, "/api/song-upload/openapi.json", "", ""))
	var schema struct {
		Paths   map[string]map[string]json.RawMessage `json:"paths"`
		OpenAPI string                                `json:"openapi"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &schema); err != nil {
		t.Fatal(err)
	}
	if res.Code != 200 || schema.OpenAPI != "3.0.3" || schema.Paths["/api/tracks"]["post"] == nil || schema.Paths["/api/song-upload"]["get"] == nil || len(schema.Paths) != 2 {
		t.Fatal("incomplete agent schema")
	}
	var capabilities struct {
		Responses map[string]struct {
			Content map[string]struct {
				Schema struct {
					Properties map[string]struct {
						Example int `json:"example"`
					} `json:"properties"`
				} `json:"schema"`
			} `json:"content"`
		} `json:"responses"`
	}
	if err := json.Unmarshal(schema.Paths["/api/song-upload"]["get"], &capabilities); err != nil {
		t.Fatal(err)
	}
	properties := capabilities.Responses["200"].Content["application/json"].Schema.Properties
	for name, limit := range map[string]int{"max_audio_bytes": maxSongAudioBytes, "max_lyrics_bytes": maxSongLyricsBytes, "max_duration_seconds": maxSongDuration} {
		if properties[name].Example != limit {
			t.Errorf("schema %s=%d, want %d", name, properties[name].Example, limit)
		}
	}
}
