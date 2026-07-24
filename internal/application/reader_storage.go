package application

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type readerStorageItem struct {
	id, status, oldStorage, storage, source, normalized, manifest string
}

type readerStorageSegment struct {
	id                                                 int64
	audioBytes                                         int64
	itemID, status, audio, audioSHA256, originalSHA256 string
}

// reconcileReaderStorage makes persisted Reader paths portable across retained
// volume mount changes. Every mutation is protected by a validated SQLite
// backup, and ready audio receives a durable digest independent of its file.
func reconcileReaderStorage(
	ctx context.Context, db *sql.DB, dbPath, metadataRoot, root string,
) error {
	var storedRoot string
	metadataErr := db.QueryRowContext(ctx, "select value from app_metadata where key='reader_root'").Scan(&storedRoot)
	if metadataErr != nil && metadataErr != sql.ErrNoRows {
		return fmt.Errorf("read prior Reader root: %w", metadataErr)
	}
	rows, err := db.QueryContext(ctx, `
select id, status, storage_dir, source_path, normalized_text_path, manifest_path
from reader_items order by id`)
	if err != nil {
		return fmt.Errorf("inspect Reader storage: %w", err)
	}
	var items []readerStorageItem
	itemIndex := map[string]int{}
	destinations := map[string]string{}
	for rows.Next() {
		var item readerStorageItem
		if err := rows.Scan(&item.id, &item.status, &item.oldStorage, &item.source, &item.normalized, &item.manifest); err != nil {
			rows.Close()
			return fmt.Errorf("inspect Reader item: %w", err)
		}
		if !validRouteID(item.id) {
			rows.Close()
			return fmt.Errorf("Reader item %q has an unroutable id", item.id)
		}
		if containedPath(item.oldStorage, root) {
			item.storage = filepath.Clean(item.oldStorage)
		} else {
			oldRoot := storedRoot
			if oldRoot == "" || !inside(item.oldStorage, oldRoot) {
				oldRoot, err = inferLegacyReaderRoot(item.id, item.oldStorage)
				if err != nil {
					rows.Close()
					return err
				}
			}
			relative, relErr := filepath.Rel(filepath.Clean(oldRoot), filepath.Clean(item.oldStorage))
			if relErr != nil || relative == "." || relative == ".." ||
				strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
				rows.Close()
				return fmt.Errorf("Reader item %q storage is not beneath prior Reader root", item.id)
			}
			item.storage = filepath.Join(root, relative)
		}
		destinationKey := filepath.Clean(item.storage)
		if existing := destinations[destinationKey]; existing != "" && existing != item.id {
			rows.Close()
			return fmt.Errorf("Reader items %q and %q map to the same storage directory", existing, item.id)
		}
		destinations[destinationKey] = item.id
		var pathErr error
		item.source, pathErr = relocateReaderPath(item.oldStorage, item.storage, item.source)
		if pathErr == nil {
			item.normalized, pathErr = relocateReaderPath(item.oldStorage, item.storage, item.normalized)
		}
		if pathErr == nil {
			item.manifest, pathErr = relocateReaderPath(item.oldStorage, item.storage, item.manifest)
		}
		if pathErr != nil || !containedPath(item.storage, root) {
			rows.Close()
			return fmt.Errorf("Reader item %q cannot be safely rebased: %w", item.id, pathErr)
		}
		if !regularFile(item.source) {
			rows.Close()
			return fmt.Errorf("Reader item %q source is missing after rebase", item.id)
		}
		items = append(items, item)
		itemIndex[item.id] = len(items) - 1
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("inspect Reader storage: %w", err)
	}

	rows, err = db.QueryContext(ctx, `
select id, item_id, status, coalesce(audio_path, ''), audio_bytes, audio_sha256
from reader_segments order by item_id, segment_index`)
	if err != nil {
		return fmt.Errorf("inspect Reader audio: %w", err)
	}
	var segments []readerStorageSegment
	for rows.Next() {
		var segment readerStorageSegment
		if err := rows.Scan(&segment.id, &segment.itemID, &segment.status,
			&segment.audio, &segment.audioBytes, &segment.audioSHA256); err != nil {
			rows.Close()
			return fmt.Errorf("inspect Reader audio: %w", err)
		}
		segment.originalSHA256 = segment.audioSHA256
		index, ok := itemIndex[segment.itemID]
		if !ok {
			rows.Close()
			return fmt.Errorf("Reader segment %d has no item", segment.id)
		}
		item := &items[index]
		if segment.audio != "" {
			segment.audio, err = relocateReaderPath(item.oldStorage, item.storage, segment.audio)
			if err != nil || !containedPath(segment.audio, root) {
				rows.Close()
				return fmt.Errorf("Reader segment %d cannot be safely rebased: %w", segment.id, err)
			}
		}
		if segment.status == "ready" {
			if !supportedAudioPath(segment.audio) {
				rows.Close()
				return fmt.Errorf("Reader segment %d has an unsupported audio type", segment.id)
			}
			if !regularFile(segment.audio) {
				rows.Close()
				return fmt.Errorf("Reader segment %d is ready but audio is missing", segment.id)
			}
			info, statErr := os.Stat(segment.audio)
			if statErr != nil || info.Size() != segment.audioBytes ||
				info.Size() <= 0 || info.Size() > maxReaderAudioBytes {
				rows.Close()
				return fmt.Errorf("Reader segment %d exceeds or disagrees with its audio budget", segment.id)
			}
			if segment.audioSHA256 == "" {
				segment.audioSHA256, err = fileSHA256(segment.audio)
				if err != nil {
					rows.Close()
					return fmt.Errorf("digest Reader segment %d: %w", segment.id, err)
				}
			}
			if !sha256Pattern.MatchString(strings.ToLower(segment.audioSHA256)) {
				rows.Close()
				return fmt.Errorf("Reader segment %d has an invalid audio digest", segment.id)
			}
		}
		segments = append(segments, segment)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("inspect Reader audio: %w", err)
	}

	changed := metadataErr != nil || filepath.Clean(storedRoot) != filepath.Clean(root)
	for _, item := range items {
		changed = changed || filepath.Clean(item.oldStorage) != filepath.Clean(item.storage)
	}
	for _, segment := range segments {
		changed = changed || segment.audioSHA256 != segment.originalSHA256
	}
	if !changed {
		return nil
	}
	if len(items) > 0 {
		if _, err := backupBeforeMigration(
			ctx, db, dbPath, metadataRoot, currentSchemaVersion,
		); err != nil {
			return fmt.Errorf("protect Reader path migration: %w", err)
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range items {
		if _, err := tx.ExecContext(ctx, `
update reader_items
set storage_dir=?, source_path=?, normalized_text_path=?, manifest_path=?
where id=?`, item.storage, item.source, item.normalized, item.manifest, item.id); err != nil {
			return fmt.Errorf("rebase Reader item %q: %w", item.id, err)
		}
	}
	for _, segment := range segments {
		if _, err := tx.ExecContext(ctx, `
update reader_segments set audio_path=nullif(?, ''), audio_sha256=? where id=?`,
			segment.audio, strings.ToLower(segment.audioSHA256), segment.id); err != nil {
			return fmt.Errorf("rebase Reader segment %d: %w", segment.id, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
insert into app_metadata(key, value) values ('reader_root', ?)
on conflict(key) do update set value=excluded.value`, root); err != nil {
		return err
	}
	return tx.Commit()
}

func inferLegacyReaderRoot(itemID, storage string) (string, error) {
	cleaned := filepath.Clean(storage)
	volume := filepath.VolumeName(cleaned)
	parts := strings.Split(strings.TrimPrefix(cleaned, volume+string(filepath.Separator)), string(filepath.Separator))
	for index := len(parts) - 1; index >= 0; index-- {
		if parts[index] != "reader-library" {
			continue
		}
		prefix := filepath.Join(parts[:index+1]...)
		if volume != "" {
			return volume + string(filepath.Separator) + prefix, nil
		}
		return string(filepath.Separator) + prefix, nil
	}
	if filepath.Base(cleaned) == itemID {
		return filepath.Dir(cleaned), nil
	}
	return "", fmt.Errorf("Reader item %q has an ambiguous legacy storage root", itemID)
}

func relocateReaderPath(oldStorage, newStorage, path string) (string, error) {
	if path == "" {
		return "", nil
	}
	relative, err := filepath.Rel(filepath.Clean(oldStorage), filepath.Clean(path))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("path %q escapes storage_dir", path)
	}
	result := filepath.Join(newStorage, relative)
	if !containedPath(result, newStorage) {
		return "", fmt.Errorf("path %q escapes rebased storage_dir", path)
	}
	return result, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
