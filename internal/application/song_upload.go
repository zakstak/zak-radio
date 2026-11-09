package application

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	catalogmodel "zak-radio/internal/catalog"
	"zak-radio/internal/httpguard"
)

const (
	maxSongAudioBytes  = 32 << 20
	maxSongLyricsBytes = 64 << 10
	maxSongDuration    = 20 * 60
	maxSongUploadBytes = maxSongAudioBytes + maxSongLyricsBytes + (16 << 10)
)

type songSubmission struct {
	title, artist, lyrics string
	audio                 []byte
}

func (a *App) catalogSnapshot() catalogmodel.Catalog {
	a.catalogMu.RLock()
	defer a.catalogMu.RUnlock()
	return a.catalog // Published catalogs and their maps/slices are immutable.
}

func (a *App) songUploadUser(r *http.Request) string {
	return httpguard.AuthenticatedUser(r, a.cfg.TrustedProxies, a.cfg.UploadIdentityHeader)
}

func (a *App) songUploadAccess(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	allowed, err := a.canUploadSong(r)
	if err != nil {
		httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
		return
	}
	writeJSON(w, map[string]any{
		"can_manage_keys":      a.songUploadUser(r) != "" && len(r.Header.Values("Authorization")) == 0,
		"schema_url":           "/api/song-upload/openapi.json",
		"enabled":              a.cfg.UploadIdentityHeader != "",
		"can_upload":           allowed,
		"max_audio_bytes":      maxSongAudioBytes,
		"max_lyrics_bytes":     maxSongLyricsBytes,
		"max_duration_seconds": maxSongDuration,
	})
}

func (a *App) addSong(w http.ResponseWriter, r *http.Request) {
	allowed, authErr := a.canUploadSong(r)
	if authErr != nil {
		httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
		return
	}
	if !allowed {
		w.Header().Set("WWW-Authenticate", `Bearer realm="song-uploads"`)
		httpguard.Error(w, r, http.StatusUnauthorized, "unauthorized", "Sign in or provide a valid upload API key.")
		return
	}
	select {
	case a.songUploads <- struct{}{}:
		defer func() { <-a.songUploads }()
	default:
		w.Header().Set("Retry-After", "5")
		httpguard.Error(w, r, http.StatusTooManyRequests, "upload_busy", "Another song is being added. Try again shortly.")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, maxSongUploadBytes)
	defer func() { _ = r.Body.Close() }()
	submission, err := readSongSubmission(r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		status := http.StatusBadRequest
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		code := "invalid_request"
		if status == http.StatusRequestEntityTooLarge {
			code = "payload_too_large"
		}
		httpguard.Error(w, r, status, code, err.Error())
		return
	}
	duration, err := validateSongMP3(r.Context(), submission.audio)
	if err != nil {
		httpguard.Error(w, r, http.StatusBadRequest, "invalid_audio", err.Error())
		return
	}
	track, status, err := a.storeSong(r.Context(), submission, duration)
	if err != nil {
		var duplicate *duplicateSongError
		if errors.As(err, &duplicate) {
			writeJSONStatus(w, status, map[string]any{"error": map[string]string{"code": "duplicate_audio", "message": err.Error()}, "existing_track_id": duplicate.Track.ID})
			return
		}
		if status == http.StatusInternalServerError {
			log.Printf("add song: %v", err)
			httpguard.Error(w, r, status, "storage_unavailable", "Song storage is unavailable. Try again shortly.")
		} else {
			code := "catalog_conflict"
			if status == http.StatusInsufficientStorage {
				code = "storage_full"
			}
			httpguard.Error(w, r, status, code, err.Error())
		}
		return
	}
	a.events.PublishValue("catalog", map[string]string{"catalog_revision": a.catalogSnapshot().Revision})
	w.Header().Set("Location", "/media/"+track.ID+"/audio")
	writeJSONStatus(w, http.StatusCreated, map[string]any{"track": track})
}

func readSongSubmission(r *http.Request) (songSubmission, error) {
	result := songSubmission{}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return result, errors.New("choose an MP3 file and submit the song form")
	}
	reader, err := r.MultipartReader()
	if err != nil {
		return result, errors.New("the song form is incomplete")
	}
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return result, fmt.Errorf("read song form: %w", err)
		}
		name := part.FormName()
		if seen[name] {
			return result, fmt.Errorf("only one %s field is allowed", name)
		}
		seen[name] = true
		limit := int64(512)
		switch name {
		case "title", "artist":
			if part.FileName() != "" {
				return result, errors.New("title and artist must be text")
			}
		case "lyrics":
			limit = maxSongLyricsBytes
		case "audio":
			if !strings.EqualFold(filepath.Ext(part.FileName()), ".mp3") {
				return result, errors.New("audio must be an MP3 file ending in .mp3")
			}
			limit = maxSongAudioBytes
		default:
			return result, errors.New("the song form contains an unsupported field")
		}
		data, err := io.ReadAll(io.LimitReader(part, limit+1))
		if err != nil {
			return result, fmt.Errorf("read %s: %w", name, err)
		}
		if int64(len(data)) > limit {
			return result, &http.MaxBytesError{Limit: limit}
		}
		switch name {
		case "audio":
			result.audio = data
		case "title":
			result.title = strings.TrimSpace(string(data))
		case "artist":
			result.artist = strings.TrimSpace(string(data))
		case "lyrics":
			result.lyrics = strings.TrimSpace(string(data))
		}
	}
	for name, value := range map[string]string{"title": result.title, "artist": result.artist} {
		if value == "" || utf8.RuneCountInString(value) > 120 || !validSongText(value, false) {
			return result, fmt.Errorf("%s is required and must contain 1–120 characters on one line", name)
		}
	}
	if !validSongText(result.lyrics, true) {
		return result, errors.New("lyrics must be UTF-8 text without control characters")
	}
	if len(result.audio) == 0 {
		return result, errors.New("choose a nonempty MP3 file, up to 32 MiB")
	}
	return result, nil
}

func validSongText(text string, multiline bool) bool {
	if !utf8.ValidString(text) {
		return false
	}
	for _, ch := range text {
		if !unicode.IsControl(ch) {
			continue
		}
		if multiline && (ch == '\n' || ch == '\r' || ch == '\t') {
			continue
		}
		return false
	}
	return true
}

// storeSong publishes the complete directory before atomically replacing the
// index. A crash can leave an unreferenced directory, never a partial song in
// the catalog. Existing index fields and curated metadata are preserved.
func (a *App) storeSong(ctx context.Context, submission songSubmission, duration float64) (catalogmodel.Track, int, error) {
	fail := func(err error) (catalogmodel.Track, int, error) {
		return catalogmodel.Track{}, http.StatusInternalServerError, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(submission.audio))
	for _, track := range a.catalog.Tracks {
		if track.AudioSHA256 == digest {
			return catalogmodel.Track{}, http.StatusConflict, &duplicateSongError{Track: track}
		}
	}
	if len(a.catalog.Tracks) >= maxCatalogTracks {
		return catalogmodel.Track{}, http.StatusConflict, errors.New("the library is full. Ask the service owner to free space")
	}
	usage, err := inspectRetainedTree(a.cfg.MetadataRoot)
	if err != nil {
		return fail(err)
	}
	// Reserve the largest allowed index replacement and space for SQLite writes.
	if usage.productBytes+int64(len(submission.audio)+len(submission.lyrics))+maxCatalogJSONBytes+(16<<20) > maxRetainedProductBytes || usage.entries+8 >= maxRetainedVolumeEntries {
		return catalogmodel.Track{}, http.StatusInsufficientStorage, errors.New("the library does not have enough free storage for this song")
	}
	indexPath := filepath.Join(a.cfg.Archive, "index.json")
	oldIndex, err := readRootBytes(a.archiveRoot, a.cfg.Archive, indexPath, maxCatalogJSONBytes)
	if err != nil {
		return fail(err)
	}
	for _, artifact := range a.catalogDigests {
		actual, digestErr := rootedDigest(artifact.root, artifact.rootPath, artifact.path)
		if digestErr != nil || actual != artifact.digest {
			return fail(errors.New("catalog changed outside the service"))
		}
	}
	var index map[string]json.RawMessage
	if err = json.Unmarshal(oldIndex, &index); err != nil {
		return fail(err)
	}
	var items []json.RawMessage
	if err = json.Unmarshal(index["tracks"], &items); err != nil {
		return fail(err)
	}
	nonce, err := randomHex(16)
	if err != nil {
		return fail(err)
	}
	id := "upload-" + nonce
	dir := filepath.Join("uploads", "Listener songs", id)
	if err = a.archiveRoot.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return fail(err)
	}
	if err = a.archiveRoot.Mkdir(dir, 0o755); err != nil {
		return fail(err)
	}
	published := false
	defer func() {
		if !published {
			_ = a.archiveRoot.RemoveAll(dir)
		}
	}()
	if err = writeSongFile(a.archiveRoot, filepath.Join(dir, "audio.mp3"), submission.audio); err != nil {
		return fail(err)
	}
	if submission.lyrics != "" {
		if err = writeSongFile(a.archiveRoot, filepath.Join(dir, "lyrics.md"), []byte(submission.lyrics)); err != nil {
			return fail(err)
		}
	}
	item := catalogmodel.ArchiveItem{
		ID: id, Title: submission.title, Artist: submission.artist, Source: "Listener upload",
		Duration: duration, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		OrganizedDir: filepath.ToSlash(dir), AudioSHA256: digest,
	}
	rawItem, err := json.Marshal(item)
	if err != nil {
		return fail(err)
	}
	items = append(items, rawItem)
	index["tracks"], err = json.Marshal(items)
	if err != nil {
		return fail(err)
	}
	indexData, err := json.Marshal(index)
	if err != nil {
		return fail(err)
	}
	if len(indexData) > maxCatalogJSONBytes {
		return catalogmodel.Track{}, http.StatusConflict, errors.New("the library metadata is full")
	}
	candidate, err := loadCatalogIndex(a.cfg, a.archiveRoot, a.metadataRoot, a.timedLyricsRoot, indexData)
	if err != nil {
		return catalogmodel.Track{}, http.StatusConflict, fmt.Errorf("this song exceeds the library's format or text limits: %w", err)
	}
	if err = ctx.Err(); err != nil {
		return fail(err)
	}
	// Flush each ancestor before the index can refer to the new files.
	for _, path := range []string{dir, filepath.Dir(dir), "uploads", "."} {
		if err = syncSongDirectory(a.archiveRoot, path); err != nil {
			return fail(err)
		}
	}
	tempIndex := ".song-index-" + nonce
	defer func() { _ = a.archiveRoot.Remove(tempIndex) }()
	if err = writeSongFile(a.archiveRoot, tempIndex, indexData); err != nil {
		return fail(err)
	}
	// Station readers hold this mutex through their operations. Publication also
	// invalidates the search cache so live filter stations include the new song.
	a.station.mu.Lock()
	defer a.station.mu.Unlock()
	a.catalogMu.Lock()
	defer a.catalogMu.Unlock()
	if err = a.archiveRoot.Rename(tempIndex, "index.json"); err != nil {
		return fail(err)
	}
	published = true
	a.catalog = candidate
	a.station.catalog = candidate
	a.station.searchOnce = sync.Once{}
	a.station.searchEntries = nil
	for i := range a.catalogDigests {
		if a.catalogDigests[i].path == indexPath {
			a.catalogDigests[i].digest = fmt.Sprintf("%x", sha256.Sum256(indexData))
		}
	}
	a.trackStatsMu.Lock()
	a.trackStatsCache = nil
	a.trackStatsMu.Unlock()
	if err = syncSongDirectory(a.archiveRoot, "."); err != nil {
		return fail(err)
	}
	return *candidate.ByID[id], http.StatusCreated, nil
}

func writeSongFile(root *os.Root, path string, data []byte) error {
	file, err := root.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	return errors.Join(writeErr, file.Close())
}

func syncSongDirectory(root *os.Root, path string) error {
	file, err := root.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

type duplicateSongError struct{ Track catalogmodel.Track }

func (e *duplicateSongError) Error() string {
	return fmt.Sprintf("this audio file is already in the library as %q", e.Track.Title)
}
