package application

import (
	_ "embed"
	"net/http"
)

//go:embed song_upload_openapi.json
var songUploadOpenAPI []byte

//go:embed ai.json
var songUploadAIGuide []byte

func (a *App) songUploadGuide(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodHead {
		_, _ = w.Write(songUploadAIGuide)
	}
}

func (a *App) songUploadSchema(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(songUploadOpenAPI)
}
