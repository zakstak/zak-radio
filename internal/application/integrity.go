package application

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type integrityArtifact struct {
	path   string
	bytes  int64
	digest string
}

type retainedDigest struct {
	root     *os.Root
	rootPath string
	path     string
	digest   string
}

type digestAudit struct {
	category string
	root     *os.Root
	rootPath string
	artifact integrityArtifact
}

func pendingIntegrityChecks() map[string]bool {
	return map[string]bool{
		"catalog":          false,
		"database":         false,
		"database_runtime": false,
		"journal":          false,
		"media":            false,
		"reader_integrity": false,
		"static":           false,
		"writable":         false,
	}
}

func (a *App) integrityLoop(ctx context.Context, interval time.Duration) {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			cycle, cancel := context.WithTimeout(ctx, 30*time.Second)
			a.auditOneIntegrity(cycle)
			a.refreshIntegrity(cycle)
			cancel()
			timer.Reset(interval)
		case <-ctx.Done():
			return
		}
	}
}

func (a *App) integritySnapshot() map[string]bool {
	a.integrityMu.RLock()
	defer a.integrityMu.RUnlock()
	result := make(map[string]bool, len(a.integrity))
	for name, passed := range a.integrity {
		result[name] = passed
	}
	return result
}

func (a *App) refreshIntegrity(ctx context.Context) {
	checks := map[string]bool{
		"catalog": len(a.tracks) > 0,
	}
	for _, artifact := range a.catalogDigests {
		digest, digestErr := rootedDigest(artifact.root, artifact.rootPath, artifact.path)
		if digestErr != nil || digest != artifact.digest {
			checks["catalog"] = false
			break
		}
	}
	_, err := rootedRegularInfo(a.staticRoot, a.cfg.StaticDir, filepath.Join(a.cfg.StaticDir, "index.html"))
	checks["static"] = err == nil
	checks["media"] = checks["catalog"]
	for _, track := range a.tracks {
		stat, statErr := rootedRegularInfo(a.archiveRoot, a.cfg.Archive, track.AudioPath)
		if statErr != nil || stat.Size() != track.AudioBytes {
			checks["media"] = false
			break
		}
		if track.HasCover {
			coverRoot, coverRootPath := a.archiveRoot, a.cfg.Archive
			if containedPath(track.CoverPath, a.cfg.MetadataRoot) {
				coverRoot, coverRootPath = a.metadataRoot, a.cfg.MetadataRoot
			}
			coverStat, coverErr := rootedRegularInfo(
				coverRoot, coverRootPath, track.CoverPath)
			if coverErr != nil || coverStat.Size() != track.CoverBytes {
				checks["media"] = false
				break
			}
		}
	}

	readerOK := readerRelationalIntegrity(ctx, a.db) == nil
	if readerOK {
		rows, queryErr := a.db.QueryContext(ctx, `
select source_path, normalized_text_path, manifest_path from reader_items`)
		if queryErr != nil {
			readerOK = false
		} else {
			for rows.Next() {
				var source, normalized, manifest string
				if rows.Scan(&source, &normalized, &manifest) != nil {
					readerOK = false
					break
				}
				for _, path := range []string{source, normalized, manifest} {
					if _, err := rootedRegularInfo(a.readerRoot, a.cfg.ReaderLibrary, path); err != nil {
						readerOK = false
						break
					}
				}
				if !readerOK {
					break
				}
			}
			if rows.Err() != nil {
				readerOK = false
			}
			rows.Close()
		}
	}

	artifacts := []integrityArtifact{}
	if readerOK {
		rows, queryErr := a.db.QueryContext(ctx, `
select audio_path, audio_bytes, audio_sha256 from reader_segments where status='ready'`)
		if queryErr != nil {
			readerOK = false
		} else {
			for rows.Next() {
				var artifact integrityArtifact
				if rows.Scan(&artifact.path, &artifact.bytes, &artifact.digest) != nil ||
					!supportedAudioPath(artifact.path) ||
					!strings.HasPrefix(filepath.Clean(artifact.path), filepath.Clean(a.cfg.ReaderLibrary)+string(filepath.Separator)) {
					readerOK = false
					break
				}
				artifacts = append(artifacts, artifact)
			}
			if rows.Err() != nil {
				readerOK = false
			}
			rows.Close()
		}
	}
	if readerOK {
		for _, artifact := range artifacts {
			stat, statErr := rootedRegularInfo(a.readerRoot, a.cfg.ReaderLibrary, artifact.path)
			if statErr != nil || stat.Size() != artifact.bytes {
				readerOK = false
				break
			}
		}
	}
	checks["reader_integrity"] = readerOK
	var version int
	checks["database"] = a.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version) == nil &&
		version == currentSchemaVersion && databaseStructuralIntegrity(ctx, a.db) == nil &&
		validateCanonicalSchema(ctx, a.db) == nil
	checks["database_runtime"] = checks["database"]
	var journal string
	checks["journal"] = a.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal) == nil &&
		strings.EqualFold(journal, "wal")
	checks["writable"] = false
	if checks["database"] {
		probeContext, cancel := context.WithTimeout(ctx, 2*time.Second)
		tx, err := a.db.BeginTx(probeContext, nil)
		if err == nil {
			result, execErr := tx.ExecContext(probeContext,
				"update stations set revision=revision where id=?", mainStationID)
			err = execErr
			if err == nil {
				affected, affectedErr := result.RowsAffected()
				err = affectedErr
				if err == nil && affected != 1 {
					err = fmt.Errorf("main station rows affected: %d", affected)
				}
			}
			_ = tx.Rollback()
		}
		cancel()
		checks["writable"] = err == nil
	}
	a.auditMu.Lock()
	for _, category := range a.digestFailures {
		checks[category] = false
	}
	a.auditMu.Unlock()

	a.integrityMu.Lock()
	a.integrity = checks
	a.integrityMu.Unlock()
}

func databaseStructuralIntegrity(ctx context.Context, q queryer) error {
	var quick string
	if err := q.QueryRowContext(ctx, "pragma quick_check").Scan(&quick); err != nil {
		return fmt.Errorf("SQLite quick_check: %w", err)
	}
	if quick != "ok" {
		return fmt.Errorf("SQLite quick_check=%q", quick)
	}
	rows, err := q.QueryContext(ctx, "pragma foreign_key_check")
	if err != nil {
		return fmt.Errorf("SQLite foreign_key_check: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID any
		var foreignKeyID int
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return err
		}
		return fmt.Errorf("foreign key failure in %s row %v referencing %s constraint %d",
			table, rowID, parent, foreignKeyID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return revisionHeadroomIntegrity(ctx, q)
}

func revisionHeadroomIntegrity(ctx context.Context, q queryer) error {
	var exhausted int
	if err := q.QueryRowContext(ctx, `
select
	(select count(*) from stations where typeof(revision)<>'integer' or revision<1 or revision>=?) +
	(select count(*) from reader_playback where typeof(revision)<>'integer' or revision<0 or revision>=?) +
	(select count(*) from skip_counts where typeof(skip_count)<>'integer' or skip_count<0 or skip_count>=?)`,
		maxRevisionValue-2, maxRevisionValue-2, maxRevisionValue-2).Scan(&exhausted); err != nil {
		return err
	}
	if exhausted != 0 {
		return fmt.Errorf("%d retained counters have no safe increment headroom", exhausted)
	}
	if _, err := readTrackStatsRevision(ctx, q); err != nil {
		return fmt.Errorf("track-stat revision headroom: %w", err)
	}
	var raw string
	if err := q.QueryRowContext(ctx,
		`select value from app_metadata where key='logical_clock_high'`).Scan(&raw); err != nil {
		return fmt.Errorf("logical clock high-water mark: %w", err)
	}
	high, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(high) || math.IsInf(high, 0) ||
		high < 0 || high > maxRetainedTimestamp {
		return fmt.Errorf("logical clock high-water mark %q is invalid", raw)
	}
	return nil
}

// retainedAdmissionIntegrity is deliberately allocation-light. It runs before
// Reader path reconciliation so hostile-but-canonical SQLite contents cannot
// make startup build unbounded collections or hash oversized legacy artifacts.
func retainedAdmissionIntegrity(ctx context.Context, q queryer) error {
	var items, segments, textBytes int64
	if err := q.QueryRowContext(ctx, `
select
	(select count(*) from reader_items),
	(select count(*) from reader_segments),
	(select coalesce(sum(length(cast(text as blob))), 0) from reader_segments)
`).Scan(&items, &segments, &textBytes); err != nil {
		return err
	}
	if items > maxReaderItems || segments > maxReaderSegments || textBytes > maxReaderTotalText {
		return fmt.Errorf("Reader retained-data budget exceeded: items=%d segments=%d text=%d",
			items, segments, textBytes)
	}
	var invalid int
	if err := q.QueryRowContext(ctx, `
select count(*) from reader_items where
	typeof(id)<>'text' or typeof(title)<>'text' or typeof(source_type)<>'text' or
	typeof(source_hash)<>'text' or typeof(status)<>'text' or typeof(voice)<>'text' or
	typeof(tts_backend)<>'text' or typeof(storage_dir)<>'text' or
	typeof(source_path)<>'text' or typeof(normalized_text_path)<>'text' or
	typeof(manifest_path)<>'text' or typeof(extractor_version)<>'text' or
	typeof(quality_warnings)<>'text' or
	typeof(uploaded_at) not in ('integer','real') or uploaded_at<0 or uploaded_at>? or
	(generated_at is not null and (typeof(generated_at) not in ('integer','real') or generated_at<0 or generated_at>?)) or
	(tts_speed is not null and (typeof(tts_speed) not in ('integer','real') or tts_speed<=0 or tts_speed>10)) or
	typeof(total_duration) not in ('integer','real') or total_duration<0 or total_duration>1e9 or
	typeof(segment_count)<>'integer' or segment_count<0 or segment_count>? or
	typeof(audio_bytes)<>'integer' or
	(quality_score is not null and (typeof(quality_score) not in ('integer','real') or abs(quality_score)>1e6)) or
	(cleanup_after is not null and (typeof(cleanup_after) not in ('integer','real') or cleanup_after<0 or cleanup_after>?)) or
	length(cast(id as blob))>? or length(cast(title as blob))>? or
	length(cast(coalesce(source_url,'') as blob))>? or
	length(cast(source_type as blob))>? or length(cast(source_hash as blob))>? or
	length(cast(coalesce(author,'') as blob))>? or
	length(cast(coalesce(published_at,'') as blob))>? or length(cast(status as blob))>? or
	length(cast(voice as blob))>? or length(cast(tts_backend as blob))>? or
	length(cast(storage_dir as blob))>? or length(cast(source_path as blob))>? or
	length(cast(normalized_text_path as blob))>? or length(cast(manifest_path as blob))>? or
	length(cast(extractor_version as blob))>? or length(cast(quality_warnings as blob))>? or
	length(cast(coalesce(notes,'') as blob))>? or
	instr(id,char(0))>0 or instr(title,char(0))>0 or
	instr(coalesce(source_url,''),char(0))>0 or instr(source_type,char(0))>0 or
	instr(source_hash,char(0))>0 or instr(coalesce(author,''),char(0))>0 or
	instr(coalesce(published_at,''),char(0))>0 or instr(status,char(0))>0 or
	instr(voice,char(0))>0 or instr(tts_backend,char(0))>0 or
	instr(storage_dir,char(0))>0 or instr(source_path,char(0))>0 or
	instr(normalized_text_path,char(0))>0 or instr(manifest_path,char(0))>0 or
	instr(extractor_version,char(0))>0 or instr(quality_warnings,char(0))>0 or
	instr(coalesce(notes,''),char(0))>0 or audio_bytes<0 or audio_bytes>?
`, maxRetainedTimestamp, maxRetainedTimestamp, maxReaderItemSegments,
		maxRetainedTimestamp, maxRouteIDBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderTextBytes, maxReaderAudioBytes*maxReaderItemSegments,
	).Scan(&invalid); err != nil {
		return err
	}
	if invalid != 0 {
		return fmt.Errorf("%d Reader items exceed type or field budgets", invalid)
	}
	if err := q.QueryRowContext(ctx, `
select count(*) from reader_segments where
	typeof(id)<>'integer' or typeof(segment_index)<>'integer' or
	segment_index<0 or segment_index>=? or
	typeof(item_id)<>'text' or typeof(heading_path)<>'text' or typeof(kind)<>'text' or
	typeof(text)<>'text' or typeof(status)<>'text' or
	typeof(coalesce(audio_path,''))<>'text' or typeof(audio_sha256)<>'text' or
	typeof(char_start)<>'integer' or typeof(char_end)<>'integer' or
	char_start<0 or char_end<char_start or char_end>1e9 or
	typeof(duration) not in ('integer','real') or duration<0 or duration>1e9 or
	typeof(audio_bytes)<>'integer' or
	length(cast(item_id as blob))>? or length(cast(heading_path as blob))>? or
	length(cast(kind as blob))>? or length(cast(text as blob))>? or
	length(cast(coalesce(audio_path,'') as blob))>? or length(cast(status as blob))>? or
	length(cast(audio_sha256 as blob))>? or
	instr(item_id,char(0))>0 or instr(heading_path,char(0))>0 or
	instr(kind,char(0))>0 or instr(text,char(0))>0 or
	instr(coalesce(audio_path,''),char(0))>0 or instr(status,char(0))>0 or
	instr(audio_sha256,char(0))>0 or
	audio_bytes<0 or audio_bytes>?
`, maxReaderItemSegments, maxRouteIDBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderTextBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderAudioBytes).Scan(&invalid); err != nil {
		return err
	}
	if invalid != 0 {
		return fmt.Errorf("%d Reader segments exceed type or field budgets", invalid)
	}
	if err := validateReaderJSONShapes(ctx, q); err != nil {
		return err
	}
	if err := q.QueryRowContext(ctx, `
select
	(select count(*) from reader_playback where
		typeof(item_id)<>'text' or length(cast(item_id as blob))>? or instr(item_id,char(0))>0 or
		typeof(segment_index)<>'integer' or segment_index<0 or segment_index>=? or
		typeof(position) not in ('integer','real') or position<0 or position>1e9 or
		typeof(playing)<>'integer' or playing not in (0,1) or
		typeof(updated_at) not in ('integer','real') or updated_at<0 or updated_at>? or
		typeof(revision)<>'integer' or revision<0 or revision>=? or
		typeof(writer_id)<>'text' or length(cast(writer_id as blob))>128 or instr(writer_id,char(0))>0 or
		typeof(writer_sequence)<>'integer' or writer_sequence<0) +
	(select count(*) from stations where
		typeof(id)<>'text' or length(cast(id as blob))>64 or instr(id,char(0))>0 or typeof(kind)<>'text' or
		typeof(owner_hash)<>'text' or length(cast(owner_hash as blob))>64 or instr(owner_hash,char(0))>0 or
		(kind='temporary' and (length(cast(owner_hash as blob))<>64 or owner_hash glob '*[^0-9a-f]*')) or
		typeof(creator_bucket)<>'text' or length(cast(creator_bucket as blob))>64 or instr(creator_bucket,char(0))>0 or
		(kind='shared' and creator_bucket<>'') or
		(kind='temporary' and
		 (length(cast(creator_bucket as blob))<>64 or creator_bucket glob '*[^0-9a-f]*')) or
		typeof(track_id)<>'text' or length(cast(track_id as blob))>? or instr(track_id,char(0))>0 or
		typeof(position) not in ('integer','real') or position<0 or position>1e9 or
		typeof(playing)<>'integer' or playing not in (0,1) or
		typeof(repeat_one)<>'integer' or repeat_one not in (0,1) or
		typeof(shuffle)<>'integer' or shuffle not in (0,1) or
		typeof(created_at) not in ('integer','real') or created_at<0 or created_at>? or
		typeof(updated_at) not in ('integer','real') or updated_at<0 or updated_at>? or
		typeof(track_changed_at) not in ('integer','real') or track_changed_at<0 or track_changed_at>? or
		(expires_at is not null and (typeof(expires_at) not in ('integer','real') or expires_at<0 or expires_at>?)) or
		typeof(revision)<>'integer' or revision<1 or revision>=? ) +
	(case when (select count(*) from stations)>? then 1 else 0 end) +
		(select count(*) from station_creation_keys where
			typeof(key_hash)<>'text' or length(key_hash)<>64 or key_hash glob '*[^0-9a-f]*' or
			typeof(station_id)<>'text' or length(cast(station_id as blob))>64 or
			typeof(owner_hash)<>'text' or length(owner_hash)<>64 or owner_hash glob '*[^0-9a-f]*' or
			typeof(created_at) not in ('integer','real') or created_at<0 or created_at>? or
			not exists (select 1 from stations s where s.id=station_id and
				s.kind='temporary' and s.owner_hash=station_creation_keys.owner_hash)) +
		(case when (select count(*) from station_creation_keys)>? then 1 else 0 end) +
		(select count(*) from station_queue where
			typeof(station_id)<>'text' or length(cast(station_id as blob))>64 or
			instr(station_id,char(0))>0 or
			typeof(position)<>'integer' or position<0 or position>=? or
			typeof(track_id)<>'text' or length(cast(track_id as blob))>? or
			instr(track_id,char(0))>0 or
			not exists (select 1 from stations s where s.id=station_id)) +
		(case when (select count(*) from station_queue)>? then 1 else 0 end)
	`, maxRouteIDBytes, maxReaderItemSegments, maxRetainedTimestamp, maxRevisionValue-2,
		maxRouteIDBytes, maxRetainedTimestamp, maxRetainedTimestamp,
		maxRetainedTimestamp, maxRetainedTimestamp, maxRevisionValue-2,
		maxTempStations+1, maxRetainedTimestamp, maxTempStations,
		maxStationQueue, maxRouteIDBytes,
		maxStationQueue*(maxTempStations+1)).Scan(&invalid); err != nil {
		return err
	}
	if invalid != 0 {
		return fmt.Errorf("retained playback or station rows exceed type, field, or cardinality budgets")
	}
	if err := q.QueryRowContext(ctx, `
select
	(select count(*) from likes where length(cast(track_id as blob))>? or
		instr(track_id,char(0))>0 or typeof(track_id)<>'text' or
		typeof(liked)<>'integer' or liked not in (0,1) or
		typeof(updated_at) not in ('integer','real') or updated_at<0 or updated_at>?) +
	(select count(*) from skip_counts where length(cast(track_id as blob))>? or
		instr(track_id,char(0))>0 or typeof(track_id)<>'text' or
		typeof(skip_count)<>'integer' or skip_count<0 or skip_count>=?) +
	(case when (select count(*) from likes)>? then 1 else 0 end) +
	(case when (select count(*) from skip_counts)>? then 1 else 0 end) +
	(select count(*) from app_metadata where length(cast(key as blob))>? or
		length(cast(value as blob))>? or instr(key,char(0))>0 or instr(value,char(0))>0 or
		typeof(key)<>'text' or typeof(value)<>'text') +
	(case when (select count(*) from app_metadata)>32 then 1 else 0 end) +
	(select count(*) from reader_playback where length(cast(item_id as blob))>? or
		length(cast(writer_id as blob))>128 or instr(item_id,char(0))>0 or
		instr(writer_id,char(0))>0 or typeof(item_id)<>'text' or typeof(writer_id)<>'text')
`, maxRouteIDBytes, maxRetainedTimestamp, maxRouteIDBytes, maxRevisionValue-2,
		maxCatalogTracks, maxCatalogTracks,
		maxReaderFieldBytes, maxReaderFieldBytes, maxRouteIDBytes).Scan(&invalid); err != nil {
		return err
	}
	if invalid != 0 {
		return fmt.Errorf("retained auxiliary tables exceed type, field, or cardinality budgets")
	}
	if _, err := readTrackStatsRevision(ctx, q); err != nil {
		return fmt.Errorf("retained track-stat revision: %w", err)
	}
	return nil
}

func validateReaderJSONShapes(ctx context.Context, q queryer) error {
	for _, check := range []struct {
		query string
		name  string
	}{
		{`select id, quality_warnings from reader_items order by id`, "quality_warnings"},
		{`select cast(id as text), heading_path from reader_segments order by id`, "heading_path"},
	} {
		rows, err := q.QueryContext(ctx, check.query)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, raw string
			if err := rows.Scan(&id, &raw); err != nil {
				rows.Close()
				return err
			}
			trimmed := strings.TrimSpace(raw)
			var values []string
			if !strings.HasPrefix(trimmed, "[") ||
				json.Unmarshal([]byte(trimmed), &values) != nil ||
				len(values) > maxReaderItemSegments {
				rows.Close()
				return fmt.Errorf("Reader %s %q is not a bounded string array", check.name, id)
			}
			for _, value := range values {
				if len(value) > maxReaderFieldBytes || strings.ContainsRune(value, '\x00') {
					rows.Close()
					return fmt.Errorf("Reader %s %q contains an invalid value", check.name, id)
				}
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

func readerRelationalIntegrity(ctx context.Context, q queryer) error {
	var items, segments, textBytes int64
	if err := q.QueryRowContext(ctx, `
select
	(select count(*) from reader_items),
	(select count(*) from reader_segments),
	(select coalesce(sum(length(cast(text as blob))), 0) from reader_segments)
`).Scan(&items, &segments, &textBytes); err != nil {
		return err
	}
	if items > maxReaderItems || segments > maxReaderSegments || textBytes > maxReaderTotalText {
		return fmt.Errorf("Reader retained-data budget exceeded: items=%d segments=%d text=%d",
			items, segments, textBytes)
	}
	var oversizedItems int
	if err := q.QueryRowContext(ctx, `
select count(*) from reader_items
where length(cast(id as blob))>? or length(cast(title as blob))>? or
	length(cast(coalesce(source_url,'') as blob))>? or
	length(cast(source_type as blob))>? or length(cast(coalesce(author,'') as blob))>? or
	length(cast(voice as blob))>? or length(cast(tts_backend as blob))>? or
	length(cast(quality_warnings as blob))>? or instr(id,char(0))>0 or
	instr(title,char(0))>0 or instr(coalesce(source_url,''),char(0))>0 or
	(select count(*) from reader_segments s where s.item_id=reader_items.id)>?
`, maxRouteIDBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderFieldBytes,
		maxReaderFieldBytes, maxReaderFieldBytes, maxReaderItemSegments).Scan(&oversizedItems); err != nil {
		return err
	}
	if oversizedItems != 0 {
		return fmt.Errorf("%d Reader items exceed retained-data limits", oversizedItems)
	}
	var invalidSegments int
	if err := q.QueryRowContext(ctx, `
select count(*) from reader_segments
where length(cast(text as blob))>? or length(cast(heading_path as blob))>? or
	instr(text,char(0))>0 or instr(heading_path,char(0))>0 or
	(status='ready' and (
	audio_bytes<=0 or duration<=0 or length(cast(audio_sha256 as blob))<>64 or
	audio_bytes>? or audio_sha256 glob '*[^0-9a-f]*'
))`, maxReaderTextBytes, maxReaderFieldBytes, maxReaderAudioBytes).Scan(&invalidSegments); err != nil {
		return err
	}
	if invalidSegments != 0 {
		return fmt.Errorf("%d ready Reader segments violate audio invariants", invalidSegments)
	}
	var invalidItems int
	if err := q.QueryRowContext(ctx, `
select count(*) from reader_items i
where i.status='ready' and (
	i.segment_count<>(select count(*) from reader_segments s where s.item_id=i.id) or
	i.audio_bytes<>coalesce((select sum(s.audio_bytes) from reader_segments s
		where s.item_id=i.id and s.status='ready'), 0) or
	abs(i.total_duration-coalesce((select sum(s.duration) from reader_segments s
		where s.item_id=i.id and s.status='ready'), 0))>0.001 or
	(i.segment_count>0 and (
		(select min(s.segment_index) from reader_segments s where s.item_id=i.id)<>0 or
		(select max(s.segment_index) from reader_segments s where s.item_id=i.id)<>i.segment_count-1
	))
)`).Scan(&invalidItems); err != nil {
		return err
	}
	if invalidItems != 0 {
		return fmt.Errorf("%d ready Reader items violate aggregate invariants", invalidItems)
	}
	return nil
}

func (a *App) digestAudits(ctx context.Context) ([]digestAudit, bool) {
	result := make([]digestAudit, 0, len(a.tracks))
	for _, track := range a.tracks {
		result = append(result, digestAudit{
			category: "media", root: a.archiveRoot, rootPath: a.cfg.Archive,
			artifact: integrityArtifact{
				path: track.AudioPath, bytes: track.AudioBytes, digest: track.AudioSHA256,
			},
		})
		if track.HasCover {
			coverRoot, coverRootPath := a.archiveRoot, a.cfg.Archive
			if containedPath(track.CoverPath, a.cfg.MetadataRoot) {
				coverRoot, coverRootPath = a.metadataRoot, a.cfg.MetadataRoot
			}
			result = append(result, digestAudit{
				category: "media", root: coverRoot, rootPath: coverRootPath,
				artifact: integrityArtifact{
					path: track.CoverPath, bytes: track.CoverBytes,
					digest: track.CoverSHA256,
				},
			})
		}
	}
	rows, err := a.db.QueryContext(ctx, `
select audio_path, audio_bytes, audio_sha256 from reader_segments where status='ready'`)
	if err != nil {
		return result, false
	}
	defer rows.Close()
	for rows.Next() {
		var artifact integrityArtifact
		if rows.Scan(&artifact.path, &artifact.bytes, &artifact.digest) == nil {
			result = append(result, digestAudit{
				category: "reader_integrity", root: a.readerRoot,
				rootPath: a.cfg.ReaderLibrary, artifact: artifact,
			})
		}
	}
	return result, rows.Err() == nil
}

func (a *App) auditOneIntegrity(ctx context.Context) {
	audits, complete := a.digestAudits(ctx)
	if len(audits) == 0 || ctx.Err() != nil {
		return
	}
	if complete {
		a.pruneDigestFailures(audits)
	}
	a.auditMu.Lock()
	index := a.auditIndex % len(audits)
	a.auditIndex = (index + 1) % len(audits)
	a.auditMu.Unlock()
	a.applyDigestAudit(ctx, audits[index])
}

func (a *App) applyDigestAudit(ctx context.Context, audit digestAudit) {
	err := verifyRootedDigestContext(ctx, audit.root, audit.rootPath, audit.artifact.path,
		audit.artifact.bytes, audit.artifact.digest)
	if err != nil && audit.category == "reader_integrity" &&
		!a.readerDigestAuditCurrent(ctx, audit.artifact) {
		err = nil
	}
	a.auditMu.Lock()
	if err == nil {
		delete(a.digestFailures, audit.artifact.path)
	} else {
		a.digestFailures[audit.artifact.path] = audit.category
	}
	a.auditMu.Unlock()
}

func (a *App) auditAllIntegrity(ctx context.Context) {
	audits, complete := a.digestAudits(ctx)
	if complete {
		a.pruneDigestFailures(audits)
	}
	for _, audit := range audits {
		if ctx.Err() != nil {
			break
		}
		a.applyDigestAudit(ctx, audit)
	}
	a.refreshIntegrity(ctx)
}

func (a *App) readerDigestAuditCurrent(ctx context.Context, artifact integrityArtifact) bool {
	var matches int
	err := a.db.QueryRowContext(ctx, `
select count(*) from reader_segments
where status='ready' and audio_path=? and audio_bytes=? and audio_sha256=?`,
		artifact.path, artifact.bytes, artifact.digest).Scan(&matches)
	return err == nil && matches == 1
}

func (a *App) pruneDigestFailures(audits []digestAudit) {
	current := make(map[string]struct{}, len(audits))
	for _, audit := range audits {
		current[audit.artifact.path] = struct{}{}
	}
	a.auditMu.Lock()
	for path := range a.digestFailures {
		if _, exists := current[path]; !exists {
			delete(a.digestFailures, path)
		}
	}
	a.auditMu.Unlock()
}
