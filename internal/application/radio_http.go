package application

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func (a *App) apiTracks(w http.ResponseWriter, r *http.Request) {
	select {
	case a.trackReads <- struct{}{}:
		defer func() { <-a.trackReads }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "track catalogue is busy", http.StatusTooManyRequests)
		return
	}
	tracks, revision, err := a.tracksWithStats(r.Context())
	if err != nil {
		internalError(w)
		return
	}
	writeJSON(w, map[string]any{
		"tracks": tracks, "track_stats_revision": revision,
		"catalog_revision": a.catalog.Revision,
	})
}

func (a *App) tracksWithStats(ctx context.Context) ([]Track, int64, error) {
	likes, dislikes, skips := map[string]int{}, map[string]int{}, map[string]int{}
	tx, err := a.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	revision, err := readTrackStatsRevision(ctx, tx)
	if err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, "select track_id, liked, disliked from likes")
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var id string
		var liked, disliked int
		if err := rows.Scan(&id, &liked, &disliked); err != nil {
			rows.Close()
			return nil, 0, err
		}
		likes[id], dislikes[id] = liked, disliked
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	rows, err = tx.QueryContext(ctx, "select track_id, skip_count from skip_counts")
	if err != nil {
		return nil, 0, err
	}
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			rows.Close()
			return nil, 0, err
		}
		skips[id] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	out := make([]Track, len(a.tracks))
	copy(out, a.tracks)
	for i := range out {
		out[i].LikeCount, out[i].DislikeCount = likes[out[i].ID], dislikes[out[i].ID]
		out[i].Liked, out[i].Disliked = out[i].LikeCount > 0, out[i].DislikeCount > 0
		out[i].SkipCount = skips[out[i].ID]
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	return out, revision, nil
}

func (a *App) publishTrackStats(ctx context.Context) (map[string]any, error) {
	tracks, revision, err := a.tracksWithStats(ctx)
	if err != nil {
		return nil, err
	}
	stats := make([]map[string]any, 0, len(tracks))
	for _, track := range tracks {
		stats = append(stats, map[string]any{
			"track_id": track.ID,
			"liked":    track.Liked, "disliked": track.Disliked,
			"like_count": track.LikeCount, "dislike_count": track.DislikeCount,
			"skip_count": track.SkipCount,
		})
	}
	payload := map[string]any{"revision": revision, "tracks": stats}
	a.publishTrackStatsPayload(payload)
	return payload, nil
}

func (a *App) publishTrackStatsPayload(payload map[string]any) {
	raw, err := json.Marshal(payload)
	if err == nil {
		if revision, ok := trackEventRevision(raw); ok {
			a.storeTrackStatsCache(raw, revision)
		}
	}
	a.events.PublishValue("track-stats", payload)
}

func (a *App) storeTrackStatsCache(payload []byte, revision int64) {
	a.trackStatsMu.Lock()
	if len(a.trackStatsCache) == 0 || revision >= a.trackStatsRev {
		a.trackStatsCache = append(a.trackStatsCache[:0], payload...)
		a.trackStatsRev = revision
	}
	a.trackStatsMu.Unlock()
}

func (a *App) cachedTrackStats(revision int64) ([]byte, bool) {
	a.trackStatsMu.RLock()
	defer a.trackStatsMu.RUnlock()
	if len(a.trackStatsCache) == 0 || a.trackStatsRev != revision {
		return nil, false
	}
	return append([]byte(nil), a.trackStatsCache...), true
}

func (a *App) trackStatsPayload(ctx context.Context, q queryer) (map[string]any, error) {
	revision, err := readTrackStatsRevision(ctx, q)
	if err != nil {
		return nil, err
	}
	likes, dislikes, skips := map[string]int{}, map[string]int{}, map[string]int{}
	rows, err := q.QueryContext(ctx, "select track_id, liked, disliked from likes")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var liked, disliked int
		if err := rows.Scan(&id, &liked, &disliked); err != nil {
			rows.Close()
			return nil, err
		}
		likes[id], dislikes[id] = liked, disliked
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, "select track_id, skip_count from skip_counts")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var count int
		if err := rows.Scan(&id, &count); err != nil {
			rows.Close()
			return nil, err
		}
		skips[id] = count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	stats := make([]map[string]any, 0, len(a.tracks))
	for _, track := range a.tracks {
		stats = append(stats, map[string]any{
			"track_id": track.ID,
			"liked":    likes[track.ID] > 0, "disliked": dislikes[track.ID] > 0,
			"like_count": likes[track.ID], "dislike_count": dislikes[track.ID],
			"skip_count": skips[track.ID],
		})
	}
	return map[string]any{"revision": revision, "tracks": stats}, nil
}

func (a *App) apiStation(w http.ResponseWriter, r *http.Request) {
	id := normalizedStationID(r.URL.Query().Get("station_id"))
	if !validStationID(id) {
		http.Error(w, "invalid station id", http.StatusBadRequest)
		return
	}
	snapshot, err := a.station.Snapshot(r.Context(), id)
	if err != nil {
		stationError(w, err)
		return
	}
	canControl := id == mainStationID
	snapshot.CanControl = &canControl
	writeJSON(w, snapshot)
}

func (a *App) createStation(w http.ResponseWriter, r *http.Request) {
	var request struct {
		TrackID        string `json:"track_id"`
		IdempotencyKey string `json:"idempotency_key"`
		OwnerToken     string `json:"owner_token"`
	}
	if !decodeJSON(w, r, &request, true) {
		return
	}
	creator := tokenHash(clientAddressWithPrefix(
		r, a.cfg.TrustedProxies, a.cfg.ClientIPv6Prefix))
	id, token, expires, err := a.station.CreateIdempotent(
		r.Context(), request.TrackID, creator, request.IdempotencyKey, request.OwnerToken)
	if err != nil {
		stationError(w, err)
		return
	}
	writeJSONStatus(w, http.StatusCreated, map[string]any{
		"station_id": id, "owner_token": token, "expires_at": expires,
	})
}

func (a *App) apiControl(w http.ResponseWriter, r *http.Request) {
	var request struct {
		StationID  string   `json:"station_id"`
		OwnerToken string   `json:"owner_token"`
		Action     string   `json:"action"`
		TrackID    string   `json:"track_id"`
		Position   *float64 `json:"position"`
		RepeatOne  *bool    `json:"repeat_one"`
		Shuffle    *bool    `json:"shuffle"`
	}
	if !decodeJSON(w, r, &request, false) {
		return
	}
	snapshot, err := a.station.Execute(r.Context(), Command{
		StationID: request.StationID, OwnerToken: request.OwnerToken, Action: request.Action,
		TrackID: request.TrackID, Position: request.Position,
		RepeatOne: request.RepeatOne, Shuffle: request.Shuffle,
	})
	if err != nil {
		stationError(w, err)
		return
	}
	canControl := true
	snapshot.CanControl = &canControl
	publishContext, cancel := context.WithTimeout(a.ctx, 2*time.Second)
	_, _ = a.publishTrackStats(publishContext)
	cancel()
	writeJSON(w, snapshot)
}

func stationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "station not found or expired", http.StatusNotFound)
	case errors.Is(err, ErrForbidden):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, ErrCapacity):
		http.Error(w, err.Error(), http.StatusTooManyRequests)
	case errors.Is(err, ErrQueueFull):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, ErrInvalidCommand):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, "station storage unavailable", http.StatusInternalServerError)
	}
}

func (a *App) stationEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	id := normalizedStationID(r.URL.Query().Get("station_id"))
	if !validStationID(id) {
		http.Error(w, "invalid station id", http.StatusBadRequest)
		return
	}
	events, unsubscribe := a.events.Subscribe(id)
	defer unsubscribe()
	trackEvents, unsubscribeTracks := a.events.Subscribe("track-stats")
	defer unsubscribeTracks()
	initial, err := a.station.Snapshot(r.Context(), id)
	if err != nil {
		stationError(w, err)
		return
	}
	initialRevision := initial.Revision
	var trackRevision int64
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	refreshStreamDeadline(w)
	writeSSE(w, initial)
	if payload, revision, statsErr := a.currentTrackStatsEvent(r.Context()); statsErr == nil {
		trackRevision = revision
		fmt.Fprintf(w, "event: track\ndata: %s\n\n", payload)
	}
	flusher.Flush()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case payload := <-events:
			var lifecycle struct {
				Expired bool `json:"expired"`
			}
			if json.Unmarshal(payload, &lifecycle) == nil && lifecycle.Expired {
				refreshStreamDeadline(w)
				fmt.Fprint(w, "event: expired\ndata: {\"expired\":true}\n\n")
				flusher.Flush()
				return
			}
			var event Snapshot
			if json.Unmarshal(payload, &event) != nil || event.Revision <= initialRevision {
				continue
			}
			initialRevision = event.Revision
			refreshStreamDeadline(w)
			fmt.Fprintf(w, "event: station\ndata: %s\n\n", payload)
			flusher.Flush()
		case payload := <-trackEvents:
			revision, ok := trackEventRevision(payload)
			if !ok || revision <= trackRevision {
				continue
			}
			trackRevision = revision
			refreshStreamDeadline(w)
			fmt.Fprintf(w, "event: track\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := a.station.Snapshot(r.Context(), id); errors.Is(err, sql.ErrNoRows) {
				refreshStreamDeadline(w)
				fmt.Fprint(w, "event: expired\ndata: {\"expired\":true}\n\n")
				flusher.Flush()
				return
			} else if err != nil {
				return
			}
			if payload, revision, err := a.currentTrackStatsEvent(r.Context()); err == nil &&
				revision > trackRevision {
				trackRevision = revision
				refreshStreamDeadline(w)
				fmt.Fprintf(w, "event: track\ndata: %s\n\n", payload)
				flusher.Flush()
			}
			refreshStreamDeadline(w)
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		case <-a.ctx.Done():
			return
		}
	}
}

func trackEventRevision(payload []byte) (int64, bool) {
	var event struct {
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Revision < 0 {
		return 0, false
	}
	return event.Revision, true
}

func (a *App) currentTrackStatsEvent(ctx context.Context) ([]byte, int64, error) {
	revision, err := readTrackStatsRevision(ctx, a.db)
	if err != nil {
		return nil, 0, err
	}
	if payload, ok := a.cachedTrackStats(revision); ok {
		return payload, revision, nil
	}
	tx, err := a.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	payload, err := a.trackStatsPayload(ctx, tx)
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	revision, ok := trackEventRevision(raw)
	if !ok {
		return nil, 0, errors.New("track statistics have no revision")
	}
	a.storeTrackStatsCache(raw, revision)
	return raw, revision, nil
}

func refreshStreamDeadline(w http.ResponseWriter) {
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(30 * time.Second))
}

func writeSSE(w http.ResponseWriter, snapshot Snapshot) {
	payload, _ := json.Marshal(snapshot)
	fmt.Fprintf(w, "event: station\ndata: %s\n\n", payload)
}

func (a *App) apiReaction(w http.ResponseWriter, r *http.Request) {
	var request struct {
		TrackID  string `json:"track_id"`
		Reaction string `json:"reaction"`
	}
	if !decodeJSON(w, r, &request, false) {
		return
	}
	if a.byID[request.TrackID] == nil {
		http.Error(w, "unknown track", http.StatusBadRequest)
		return
	}
	if request.Reaction == "" {
		request.Reaction = "like"
	}
	if request.Reaction != "like" && request.Reaction != "dislike" {
		http.Error(w, "reaction must be like or dislike", http.StatusBadRequest)
		return
	}
	now := unixTime(time.Now())
	var liked, disliked int
	var revision int64
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		internalError(w)
		return
	}
	defer tx.Rollback()
	column := "liked"
	if request.Reaction == "dislike" {
		column = "disliked"
	}
	query := fmt.Sprintf(`
insert into likes(track_id, liked, updated_at, disliked) values (?, ?, ?, ?)
on conflict(track_id) do update set
	%s=%s+1, updated_at=excluded.updated_at
where %s<?
returning liked, disliked`, column, column, column)
	likeIncrement, dislikeIncrement := 0, 0
	if request.Reaction == "like" {
		likeIncrement = 1
	} else {
		dislikeIncrement = 1
	}
	if err := tx.QueryRowContext(r.Context(), query,
		request.TrackID, likeIncrement, now, dislikeIncrement,
		maxRevisionValue-3).Scan(&liked, &disliked); err != nil {
		internalError(w)
		return
	}
	var skips int
	if err := tx.QueryRowContext(r.Context(), "select coalesce((select skip_count from skip_counts where track_id=?), 0)", request.TrackID).Scan(&skips); err != nil {
		internalError(w)
		return
	}
	if err := tx.QueryRowContext(r.Context(), `
update app_metadata
set value=cast(value as integer)+1
where key='track_stats_revision' and cast(value as integer)<?
returning cast(value as integer)`, maxRevisionValue-3).Scan(&revision); err != nil {
		internalError(w)
		return
	}
	payload, err := a.trackStatsPayload(r.Context(), tx)
	if err != nil {
		internalError(w)
		return
	}
	payload["track_id"] = request.TrackID
	payload["liked"] = liked != 0
	payload["disliked"] = disliked != 0
	payload["like_count"] = liked
	payload["dislike_count"] = disliked
	payload["skip_count"] = skips
	payload["revision"] = revision
	if err := tx.Commit(); err != nil {
		internalError(w)
		return
	}
	a.publishTrackStatsPayload(payload)
	writeJSON(w, payload)
}

func (a *App) apiLike(w http.ResponseWriter, r *http.Request) {
	a.apiReaction(w, r)
}

func readTrackStatsRevision(ctx context.Context, q queryer) (int64, error) {
	var raw string
	if err := q.QueryRowContext(ctx,
		`select value from app_metadata where key='track_stats_revision'`).Scan(&raw); err != nil {
		return 0, err
	}
	revision, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || revision < 0 || revision >= maxRevisionValue-2 {
		return 0, fmt.Errorf("invalid track-stat revision %q", raw)
	}
	return revision, nil
}

func (a *App) apiTrackText(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/track/")
	track := a.byID[id]
	if track == nil {
		http.NotFound(w, r)
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "lyrics"
	}
	if kind == "timed_lyrics" {
		a.writeTimedLyrics(w, track)
		return
	}
	path := track.LyricsPath
	if kind == "prompt" {
		path = track.PromptPath
	} else if kind != "lyrics" {
		http.Error(w, "unsupported text kind", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"id": id, kind: a.readTrackText(path)})
}

func (a *App) writeTimedLyrics(w http.ResponseWriter, track *Track) {
	if track.TimedLyricsPath == "" {
		writeJSON(w, map[string]any{
			"id": track.ID, "timed_lyrics": nil,
		})
		return
	}
	data, err := readRootBytes(
		func() *os.Root {
			if track.TimedLyricsBundled {
				return a.timedLyricsRoot
			}
			return a.archiveRoot
		}(),
		func() string {
			if track.TimedLyricsBundled {
				return a.cfg.TimedLyricsRoot
			}
			return a.cfg.Archive
		}(),
		track.TimedLyricsPath, maxTimedLyricsBytes,
	)
	if err != nil ||
		fmt.Sprintf("%x", sha256.Sum256(data)) != track.TimedLyricsSHA256 {
		internalError(w)
		return
	}
	var payload json.RawMessage = data
	writeJSON(w, map[string]any{
		"id": track.ID, "timed_lyrics": &payload,
	})
}

func (a *App) readTrackText(path string) string {
	if path == "" {
		return ""
	}
	rootHandle, root := a.archiveRoot, a.cfg.Archive
	if !containedPath(path, root) {
		rootHandle, root = a.metadataRoot, a.cfg.MetadataRoot
	}
	file, stat, err := openRootedRegular(rootHandle, root, path)
	if err != nil || stat.Size() > 1<<20 {
		if file != nil {
			file.Close()
		}
		return ""
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return ""
	}
	return string(data)
}
