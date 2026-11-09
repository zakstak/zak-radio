package application

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSongUploadAIGuide(t *testing.T) {
	app := newTestApp(t)
	handler := app.routes()
	for _, path := range []string{"/ai.json", "/.well-known/ai.json"} {
		for _, bearer := range []bool{false, true} {
			r := songKeyRequest(http.MethodGet, path, "", "")
			if bearer {
				r.Header.Set("Authorization", "Bearer "+songUploadKeyPrefix+"agent-reading-instructions")
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, r)
			if res.Code != 200 || !bytes.Equal(res.Body.Bytes(), songUploadAIGuide) || res.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("guide %s: %d %s", path, res.Code, res.Body.String())
			}
			var guide struct {
				Authentication struct {
					Scope string `json:"scope"`
				} `json:"authentication"`
				Upload struct {
					Fields map[string]struct {
						MaxBytes    int `json:"max_bytes"`
						MaxDuration int `json:"max_duration_seconds"`
					} `json:"fields"`
					Method string `json:"method"`
					Path   string `json:"path"`
				} `json:"upload"`
				OpenAPI string `json:"openapi"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &guide); err != nil {
				t.Fatal(err)
			}
			if guide.Authentication.Scope != songUploadKeyScope || guide.Upload.Method != http.MethodPost || guide.Upload.Path != "/api/tracks" || guide.OpenAPI != "/api/song-upload/openapi.json" ||
				guide.Upload.Fields["audio"].MaxBytes != maxSongAudioBytes || guide.Upload.Fields["lyrics"].MaxBytes != maxSongLyricsBytes || guide.Upload.Fields["audio"].MaxDuration != maxSongDuration {
				t.Fatal("agent instructions differ from the upload contract")
			}
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, songKeyRequest(http.MethodHead, path, "", ""))
		if res.Code != 200 || res.Body.Len() != 0 || res.Header().Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatalf("HEAD %s: %d", path, res.Code)
		}
	}
}
