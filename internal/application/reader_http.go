package application

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxReaderSourceBytes  = 8 << 20
	maxReaderImages       = 200
	maxReaderCacheItems   = 64
	maxReaderCacheBytes   = 2 << 20
	maxReaderAltBytes     = 512
	maxReaderAudioBytes   = 256 << 20
	maxReaderItems        = 1000
	maxReaderSegments     = 10000
	maxReaderItemSegments = 2000
	maxReaderFieldBytes   = 8 << 10
	maxReaderTextBytes    = 64 << 10
	maxReaderTotalText    = 64 << 20
	maxReaderItemsPage    = 100
	maxReaderSegmentsPage = 100
)

type readerImageCache struct {
	signature string
	images    []map[string]any
	usedAt    time.Time
	bytes     int64
}

type readerParseCall struct {
	done   chan struct{}
	images []map[string]any
	err    error
}

var errReaderParseBusy = errors.New("Reader image parser is busy")

func (a *App) readerItems(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := readerPage(w, r, maxReaderItemsPage)
	if !ok {
		return
	}
	cursorTime, cursorID, hasCursor, ok := readerItemsCursor(w, r)
	if !ok {
		return
	}
	var rows *sql.Rows
	var err error
	if hasCursor {
		rows, err = a.db.QueryContext(r.Context(),
			"select "+readerItemRequestColumns+`
			 from reader_items
			 where uploaded_at < ? or (uploaded_at = ? and id > ?)
			 order by uploaded_at desc, id limit ?`,
			cursorTime, cursorTime, cursorID, limit)
	} else {
		rows, err = a.db.QueryContext(r.Context(),
			"select "+readerItemRequestColumns+
				" from reader_items order by uploaded_at desc, id limit ? offset ?", limit, offset)
	}
	if err != nil {
		internalError(w)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		item, err := scanMap(rows)
		if err != nil {
			internalError(w)
			return
		}
		parseWarnings(item)
		items = append(items, publicReaderItem(item))
	}
	if err := rows.Err(); err != nil {
		internalError(w)
		return
	}
	payload := map[string]any{"items": items}
	if len(items) == limit {
		last := items[len(items)-1]
		uploaded, uploadedOK := last["uploaded_at"].(float64)
		id, idOK := last["id"].(string)
		if uploadedOK && idOK {
			payload["next_cursor"] = base64.RawURLEncoding.EncodeToString(
				[]byte(strconv.FormatFloat(uploaded, 'g', 17, 64) + "\n" + id))
		} else {
			payload["next_offset"] = offset + len(items)
		}
	}
	writeJSON(w, payload)
}

func readerItemsCursor(w http.ResponseWriter, r *http.Request) (float64, string, bool, bool) {
	value := r.URL.Query().Get("cursor")
	if value == "" {
		return 0, "", false, true
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	parts := strings.Split(string(raw), "\n")
	if err != nil || len(parts) != 2 || !validRouteID(parts[1]) {
		http.Error(w, "invalid pagination cursor", http.StatusBadRequest)
		return 0, "", false, false
	}
	uploaded, err := strconv.ParseFloat(parts[0], 64)
	if err != nil || math.IsNaN(uploaded) || math.IsInf(uploaded, 0) ||
		uploaded < 0 || uploaded > 1e11 {
		http.Error(w, "invalid pagination cursor", http.StatusBadRequest)
		return 0, "", false, false
	}
	return uploaded, parts[1], true, true
}

func (a *App) readerItemSubroute(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/reader/items/"), "/")
	if len(parts) < 1 || len(parts) > 2 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || !validRouteID(id) {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "segments" {
		if _, err := a.readerItem(r.Context(), id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				http.NotFound(w, r)
			} else {
				http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
			}
			return
		}
		limit, offset, ok := readerPage(w, r, maxReaderSegmentsPage)
		if !ok {
			return
		}
		segments, err := a.readerSegmentsPage(r.Context(), id, limit, offset)
		if err != nil {
			internalError(w)
			return
		}
		public := make([]map[string]any, 0, len(segments))
		for _, segment := range segments {
			public = append(public, publicReaderSegment(segment))
		}
		payload := map[string]any{"item_id": id, "segments": public}
		if len(public) == limit {
			payload["next_offset"] = offset + len(public)
		}
		writeJSON(w, payload)
		return
	}
	if len(parts) == 2 && parts[1] == "images" {
		images, err := a.getImages(r.Context(), id)
		if err != nil {
			if errors.Is(err, errReaderParseBusy) {
				w.Header().Set("Retry-After", "2")
				http.Error(w, "Reader image parser is busy", http.StatusTooManyRequests)
			} else if errors.Is(err, sql.ErrNoRows) {
				http.NotFound(w, r)
			} else {
				http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
			}
			return
		}
		writeJSON(w, map[string]any{"item_id": id, "images": images})
		return
	}
	if len(parts) != 1 {
		http.NotFound(w, r)
		return
	}
	item, err := a.readerItem(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else {
			internalError(w)
		}
		return
	}
	writeJSON(w, map[string]any{"item": publicReaderItem(item)})
}

func readerPage(w http.ResponseWriter, r *http.Request, maximum int) (int, int, bool) {
	limit := maximum
	offset := 0
	var err error
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > maximum {
			http.Error(w, "invalid pagination limit", http.StatusBadRequest)
			return 0, 0, false
		}
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > maxReaderSegments {
			http.Error(w, "invalid pagination offset", http.StatusBadRequest)
			return 0, 0, false
		}
	}
	return limit, offset, true
}

func (a *App) getImages(ctx context.Context, id string) (images []map[string]any, err error) {
	item, err := a.readerItem(ctx, id)
	if err != nil {
		return nil, err
	}
	sourcePath, _ := item["source_path"].(string)
	if !containedPath(sourcePath, a.cfg.ReaderLibrary) ||
		!(strings.HasSuffix(strings.ToLower(sourcePath), ".html") || strings.HasSuffix(strings.ToLower(sourcePath), ".htm")) {
		return []map[string]any{}, nil
	}
	sourceInfo, err := rootedRegularInfo(a.readerRoot, a.cfg.ReaderLibrary, sourcePath)
	if err != nil {
		return nil, fmt.Errorf("Reader source is not a regular file")
	}
	if sourceInfo.Size() > maxReaderSourceBytes {
		return nil, fmt.Errorf("Reader source exceeds %d bytes", maxReaderSourceBytes)
	}
	imageDirectory := filepath.Join(fmt.Sprint(item["storage_dir"]), "images")
	signature := fmt.Sprintf("%s:%d:%d:%s", sourcePath, sourceInfo.Size(),
		sourceInfo.ModTime().UnixNano(), a.readerImageDirectorySignature(imageDirectory))
	a.readerImagesMu.Lock()
	if cached, ok := a.readerImages[id]; ok && cached.signature == signature {
		cached.usedAt = time.Now()
		a.readerImages[id] = cached
		a.readerImagesMu.Unlock()
		return cached.images, nil
	}
	if existing := a.readerParseCalls[id]; existing != nil {
		a.readerImagesMu.Unlock()
		select {
		case <-existing.done:
			return existing.images, existing.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &readerParseCall{done: make(chan struct{})}
	a.readerParseCalls[id] = call
	a.readerImagesMu.Unlock()
	defer func() {
		a.readerImagesMu.Lock()
		call.images, call.err = images, err
		delete(a.readerParseCalls, id)
		close(call.done)
		a.readerImagesMu.Unlock()
	}()
	select {
	case a.readerParses <- struct{}{}:
		defer func() { <-a.readerParses }()
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, errReaderParseBusy
	}
	sourceFile, sourceInfo, err := openRootedRegular(a.readerRoot, a.cfg.ReaderLibrary, sourcePath)
	if err != nil {
		return nil, fmt.Errorf("Reader source is not a regular file")
	}
	defer sourceFile.Close()
	if sourceInfo.Size() > maxReaderSourceBytes {
		return nil, fmt.Errorf("Reader source exceeds %d bytes", maxReaderSourceBytes)
	}
	signature = fmt.Sprintf("%s:%d:%d:%s", sourcePath, sourceInfo.Size(),
		sourceInfo.ModTime().UnixNano(), a.readerImageDirectorySignature(imageDirectory))
	a.readerImagesMu.Lock()
	if cached, ok := a.readerImages[id]; ok && cached.signature == signature {
		cached.usedAt = time.Now()
		a.readerImages[id] = cached
		a.readerImagesMu.Unlock()
		return cached.images, nil
	}
	a.readerImagesMu.Unlock()
	sourceData, err := io.ReadAll(io.LimitReader(sourceFile, maxReaderSourceBytes+1))
	if err != nil {
		return nil, err
	}
	if len(sourceData) > maxReaderSourceBytes {
		return nil, fmt.Errorf("Reader source exceeds %d bytes", maxReaderSourceBytes)
	}
	raw, base := string(sourceData), fmt.Sprint(item["source_url"])
	storage := fmt.Sprint(item["storage_dir"])
	imageRE := regexp.MustCompile(`(?is)<img\b([^>]*)>`)
	srcRE := regexp.MustCompile(`(?is)\bsrc=["']([^"']+)`)
	altRE := regexp.MustCompile(`(?is)\balt=["']([^"']*)`)
	figureRE := regexp.MustCompile(`(?i)\b(Figure\s+\d+)\b`)
	result := []map[string]any{}
	for index, match := range imageRE.FindAllStringSubmatch(raw, maxReaderImages) {
		srcMatch := srcRE.FindStringSubmatch(match[1])
		if srcMatch == nil {
			continue
		}
		remote := resolveURL(base, html.UnescapeString(srcMatch[1]))
		extension := filepath.Ext(urlPath(remote))
		if extension == "" {
			extension = ".png"
		}
		name := fmt.Sprintf("%03d%s", index, extension)
		local := filepath.Join(storage, "images", name)
		if !containedPath(local, a.cfg.ReaderLibrary) || !supportedImagePath(local) {
			continue
		}
		if _, imageErr := rootedRegularInfo(a.readerRoot, a.cfg.ReaderLibrary, local); imageErr != nil {
			continue
		}
		display := "/reader-image/" + url.PathEscape(id) + "/" + name
		alt := ""
		if match := altRE.FindStringSubmatch(match[1]); match != nil {
			alt = strings.Clone(strings.TrimSpace(html.UnescapeString(match[1])))
			if len(alt) > maxReaderAltBytes {
				alt = strings.Clone(alt[:maxReaderAltBytes])
			}
		}
		figure := fmt.Sprintf("Image %d", index+1)
		if match := figureRE.FindStringSubmatch(alt); match != nil {
			figure = "Figure " + strings.TrimSpace(strings.TrimPrefix(strings.ToLower(match[1]), "figure"))
		}
		if alt == "" {
			alt = figure
		}
		figure = strings.Clone(figure)
		alt = strings.Clone(alt)
		result = append(result, map[string]any{
			"index": index, "src": display, "alt": alt, "figure": figure,
		})
	}
	a.readerImagesMu.Lock()
	entryBytes := readerImageMetadataBytes(result)
	if existing, ok := a.readerImages[id]; ok {
		a.readerImageBytes -= existing.bytes
		delete(a.readerImages, id)
	}
	for len(a.readerImages) >= maxReaderCacheItems ||
		(len(a.readerImages) > 0 && a.readerImageBytes+entryBytes > maxReaderCacheBytes) {
		oldestID := ""
		var oldest time.Time
		for candidate, cached := range a.readerImages {
			if oldestID == "" || cached.usedAt.Before(oldest) {
				oldestID, oldest = candidate, cached.usedAt
			}
		}
		a.readerImageBytes -= a.readerImages[oldestID].bytes
		delete(a.readerImages, oldestID)
	}
	if entryBytes <= maxReaderCacheBytes {
		a.readerImages[id] = readerImageCache{
			signature: signature, images: result, usedAt: time.Now(), bytes: entryBytes,
		}
		a.readerImageBytes += entryBytes
	}
	a.readerImagesMu.Unlock()
	return result, nil
}

func (a *App) readerImageDirectorySignature(path string) string {
	relative, err := rootedRelative(a.cfg.ReaderLibrary, path)
	if err != nil {
		return "invalid"
	}
	info, err := a.readerRoot.Stat(relative)
	if err != nil {
		return "missing"
	}
	if !info.IsDir() {
		return "not-directory"
	}
	return fmt.Sprintf("%d:%d:%d", info.ModTime().UnixNano(), info.Size(), info.Mode().Perm())
}

func readerImageMetadataBytes(images []map[string]any) int64 {
	var total int64
	for _, image := range images {
		for _, key := range []string{"src", "alt", "figure"} {
			total += int64(len(fmt.Sprint(image[key])))
		}
		total += 32
	}
	return total
}

func (a *App) readerPlayback(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("item_id")
	if !validRouteID(id) {
		http.Error(w, "item_id required", http.StatusBadRequest)
		return
	}
	var segmentIndex, playing int
	var revision int64
	var position, updatedAt, duration float64
	err := a.db.QueryRowContext(r.Context(), `
select p.segment_index, p.position, p.playing, p.updated_at, p.revision, s.duration
from reader_playback p
join reader_segments s on s.item_id=p.item_id and s.segment_index=p.segment_index
where p.item_id=? and s.status='ready' and s.duration>0
  and p.position>=0 and p.position<=s.duration`, id).Scan(
		&segmentIndex, &position, &playing, &updatedAt, &revision, &duration)
	if err == nil && position >= duration {
		var next int
		nextErr := a.db.QueryRowContext(r.Context(), `
select segment_index from reader_segments
where item_id=? and segment_index>? and status='ready' and duration>0
order by segment_index limit 1`, id, segmentIndex).Scan(&next)
		if nextErr == nil {
			segmentIndex, position, playing = next, 0, 0
		} else if !errors.Is(nextErr, sql.ErrNoRows) {
			err = nextErr
		} else {
			playing = 0
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		position, playing = 0, 0
		hadPlayback := true
		revisionErr := a.db.QueryRowContext(r.Context(), `
select segment_index, updated_at, revision from reader_playback where item_id=?`,
			id).Scan(&segmentIndex, &updatedAt, &revision)
		if errors.Is(revisionErr, sql.ErrNoRows) {
			hadPlayback = false
			segmentIndex = -1
		} else if revisionErr != nil {
			err = revisionErr
		}
		if revisionErr == nil || !hadPlayback {
			err = a.db.QueryRowContext(r.Context(), `
select segment_index from reader_segments
where item_id=? and segment_index>? and status='ready' and duration>0
order by segment_index limit 1`, id, segmentIndex).Scan(&segmentIndex)
			if errors.Is(err, sql.ErrNoRows) {
				err = a.db.QueryRowContext(r.Context(), `
select segment_index from reader_segments
where item_id=? and status='ready' and duration>0
order by segment_index limit 1`, id).Scan(&segmentIndex)
			}
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		var exists int
		if itemErr := a.db.QueryRowContext(r.Context(), "select 1 from reader_items where id=?", id).Scan(&exists); errors.Is(itemErr, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else if itemErr != nil {
			internalError(w)
		} else {
			http.Error(w, "Reader item has no playable audio", http.StatusConflict)
		}
		return
	}
	if err != nil {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"item_id": id, "segment_index": segmentIndex, "position": position,
		"playing": playing != 0, "updated_at": updatedAt, "revision": revision,
	})
}

func (a *App) setReaderPlayback(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ItemID         string  `json:"item_id"`
		SegmentIndex   int     `json:"segment_index"`
		Position       float64 `json:"position"`
		Playing        bool    `json:"playing"`
		BaseRevision   int64   `json:"base_revision"`
		WriterID       string  `json:"writer_id"`
		WriterSequence int64   `json:"writer_sequence"`
	}
	if !decodeJSON(w, r, &request, false) {
		return
	}
	if !validRouteID(request.ItemID) || request.SegmentIndex < 0 ||
		request.BaseRevision < 0 || request.WriterSequence < 0 ||
		(request.WriterID != "" && (!temporaryStationIDPattern.MatchString(request.WriterID) ||
			request.WriterSequence == 0)) ||
		math.IsNaN(request.Position) ||
		math.IsInf(request.Position, 0) || request.Position < 0 {
		http.Error(w, "invalid Reader playback position", http.StatusBadRequest)
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()
	var duration float64
	if err := tx.QueryRowContext(r.Context(), `
select duration from reader_segments
where item_id=? and segment_index=? and status='ready' and duration>0`,
		request.ItemID, request.SegmentIndex).Scan(&duration); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Reader segment is not playable at that position", http.StatusBadRequest)
		} else {
			http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		}
		return
	}
	if request.Position > duration {
		http.Error(w, "Reader segment is not playable at that position", http.StatusBadRequest)
		return
	}
	if request.Position >= duration {
		var nextIndex int
		err := tx.QueryRowContext(r.Context(), `
select segment_index from reader_segments
where item_id=? and segment_index>? and status='ready' and duration>0
order by segment_index limit 1`, request.ItemID, request.SegmentIndex).Scan(&nextIndex)
		switch {
		case err == nil:
			request.SegmentIndex = nextIndex
			request.Position = 0
		case errors.Is(err, sql.ErrNoRows):
			request.Position = duration
			request.Playing = false
		default:
			http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
			return
		}
	}

	var currentRevision, currentWriterSequence int64
	var currentWriterID string
	err = tx.QueryRowContext(r.Context(),
		"select revision, writer_id, writer_sequence from reader_playback where item_id=?",
		request.ItemID).Scan(&currentRevision, &currentWriterID, &currentWriterSequence)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	sameWriter := request.WriterID != "" && request.WriterID == currentWriterID
	if request.BaseRevision != currentRevision && !sameWriter {
		http.Error(w, "Reader playback changed in another session", http.StatusConflict)
		return
	}
	if sameWriter && request.WriterSequence <= currentWriterSequence {
		playback, playbackErr := readerPlaybackFor(r.Context(), tx, request.ItemID)
		if playbackErr != nil {
			internalError(w)
			return
		}
		writeJSON(w, playback)
		return
	}

	now := unixTime(time.Now())
	var result sql.Result
	if missing {
		result, err = tx.ExecContext(r.Context(), `
insert into reader_playback(
	item_id, segment_index, position, playing, updated_at, revision, writer_id, writer_sequence
) values (?, ?, ?, ?, ?, 1, ?, ?)`,
			request.ItemID, request.SegmentIndex, request.Position, boolInt(request.Playing), now,
			request.WriterID, request.WriterSequence)
	} else {
		result, err = tx.ExecContext(r.Context(), `
update reader_playback set
	segment_index=?, position=?, playing=?, updated_at=?, revision=revision+1,
	writer_id=?, writer_sequence=?
where item_id=? and revision<?`,
			request.SegmentIndex, request.Position, boolInt(request.Playing), now,
			request.WriterID, request.WriterSequence, request.ItemID, maxRevisionValue-3)
	}
	if err != nil {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	playback, err := readerPlaybackFor(r.Context(), tx, request.ItemID)
	if err != nil {
		internalError(w)
		return
	}
	if err := tx.Commit(); err != nil {
		http.Error(w, "reader storage unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, playback)
}

func (a *App) readerMedia(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/reader-media/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	index, err := strconv.Atoi(strings.TrimSuffix(parts[1], filepath.Ext(parts[1])))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var path, status string
	if err := a.db.QueryRowContext(r.Context(), `
select coalesce(audio_path, ''), status
from reader_segments where item_id=? and segment_index=?`, id, index).Scan(&path, &status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else {
			internalError(w)
		}
		return
	}
	if status == "ready" && supportedAudioPath(path) && containedPath(path, a.cfg.ReaderLibrary) {
		servePrivateRange(w, r, a.readerRoot, a.cfg.ReaderLibrary, path)
		return
	}
	http.NotFound(w, r)
}

func (a *App) readerImage(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/reader-image/"), "/")
	if len(parts) != 2 || filepath.Base(parts[1]) != parts[1] {
		http.NotFound(w, r)
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	item, err := a.readerItem(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else {
			internalError(w)
		}
		return
	}
	storage, _ := item["storage_dir"].(string)
	path := filepath.Join(storage, "images", parts[1])
	if !safeReaderImage(path, a.cfg.ReaderLibrary) || !containedPath(path, filepath.Join(storage, "images")) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	serveRootContent(w, r, a.readerRoot, a.cfg.ReaderLibrary, path, "private, no-store", contentType(path))
}

func (a *App) readerSource(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/reader-source/"), "/")
	if len(parts) != 2 || parts[1] != "source" {
		http.NotFound(w, r)
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	item, err := a.readerItem(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.NotFound(w, r)
		} else {
			internalError(w)
		}
		return
	}
	path, _ := item["source_path"].(string)
	if !containedPath(path, a.cfg.ReaderLibrary) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	file, stat, err := openRootedRegular(a.readerRoot, a.cfg.ReaderLibrary, path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if stat.Size() <= 0 || stat.Size() > maxReaderSourceBytes {
		http.Error(w, "Reader source is outside the retained size limit", http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filepath.Base(path)))
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, filepath.Base(path)+".txt", stat.ModTime(), file)
}

func safeReaderImage(path, root string) bool {
	if !exists(path) || !containedPath(path, root) {
		return false
	}
	return supportedImagePath(path)
}
