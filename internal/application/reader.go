package application

import (
	"context"
	"database/sql"
	"encoding/json"

	readermodel "zak-radio/internal/reader"
)

type ReaderItem = readermodel.Item
type ReaderSegment = readermodel.Segment

const readerItemRequestColumns = `
id, title, source_url, source_type, author, published_at, uploaded_at,
generated_at, status, voice, tts_backend, tts_speed, storage_dir, source_path,
total_duration, segment_count, audio_bytes, quality_score,
quality_warnings, cleanup_after`

const readerSegmentRequestColumns = `
segment_index, heading_path, kind, text, char_start, char_end,
duration, audio_bytes, audio_sha256, status`

func publicReaderItem(item ReaderItem) map[string]any {
	return readermodel.PublicItem(item)
}

func publicReaderSegment(segment ReaderSegment) map[string]any {
	return readermodel.PublicSegment(segment)
}

func (a *App) readerItem(ctx context.Context, id string) (ReaderItem, error) {
	rows, err := a.db.QueryContext(ctx,
		"select "+readerItemRequestColumns+" from reader_items where id=?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, sql.ErrNoRows
	}
	item, err := scanMap(rows)
	parseWarnings(item)
	return item, err
}

func (a *App) readerSegmentsFor(ctx context.Context, id string) ([]ReaderSegment, error) {
	return a.readerSegmentsPage(ctx, id, maxReaderItemSegments, 0)
}

func (a *App) readerSegmentsPage(ctx context.Context, id string, limit, offset int) ([]ReaderSegment, error) {
	rows, err := a.db.QueryContext(ctx,
		"select "+readerSegmentRequestColumns+
			" from reader_segments where item_id=? order by segment_index limit ? offset ?",
		id, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ReaderSegment{}
	for rows.Next() {
		segment, err := scanMap(rows)
		if err != nil {
			return nil, err
		}
		if raw, ok := segment["heading_path"].(string); ok {
			var headings []string
			if json.Unmarshal([]byte(raw), &headings) == nil {
				segment["heading_path"] = headings
			} else {
				segment["heading_path"] = []string{}
			}
		}
		result = append(result, segment)
	}
	return result, rows.Err()
}

func (a *App) readerPlaybackFor(ctx context.Context, id string) (map[string]any, error) {
	return readerPlaybackFor(ctx, a.db, id)
}

func readerPlaybackFor(ctx context.Context, q queryer, id string) (map[string]any, error) {
	var itemID string
	var segmentIndex int
	var position, updatedAt float64
	var playing int
	var revision int64
	if err := q.QueryRowContext(ctx, `
select item_id, segment_index, position, playing, updated_at, revision
from reader_playback where item_id=?`, id).Scan(
		&itemID, &segmentIndex, &position, &playing, &updatedAt, &revision,
	); err != nil {
		return nil, err
	}
	return map[string]any{
		"item_id": itemID, "segment_index": segmentIndex, "position": position,
		"playing": playing != 0, "updated_at": updatedAt, "revision": revision,
	}, nil
}
