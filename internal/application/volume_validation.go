package application

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var descriptorVolumeRoot = regexp.MustCompile(`^/(?:proc/self|dev)/fd/[0-9]+$`)

func validateVolumeDataPaths(cfg Config) error {
	if !descriptorVolumeRoot.MatchString(filepath.Clean(cfg.MetadataRoot)) {
		return validateDataPaths(cfg)
	}
	info, err := os.Stat(cfg.MetadataRoot)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("metadata descriptor root is not a directory")
	}
	for name, path := range map[string]string{
		"archive": cfg.Archive, "database": cfg.DBPath,
		"Reader library": cfg.ReaderLibrary,
	} {
		if !lexicallyInside(filepath.Clean(path), filepath.Clean(cfg.MetadataRoot)) {
			return fmt.Errorf("%s must remain beneath metadata descriptor root", name)
		}
	}
	return nil
}

func validateVolume(ctx context.Context, root string) error {
	root, err := filepath.Abs(root)
	if err != nil || root == string(filepath.Separator) {
		return fmt.Errorf("invalid retained volume root")
	}
	if err := validateRetainedTreeBudget(root); err != nil {
		return fmt.Errorf("validate retained-volume budget: %w", err)
	}
	cfg := Config{
		MetadataRoot:  root,
		Archive:       filepath.Join(root, "music-library"),
		DBPath:        filepath.Join(root, "station.sqlite3"),
		ReaderLibrary: filepath.Join(root, "reader-library"),
	}
	if err := validateVolumeDataPaths(cfg); err != nil {
		return fmt.Errorf("validate retained paths: %w", err)
	}
	if err := rejectSQLiteSidecars(cfg.DBPath); err != nil {
		return err
	}
	archiveRoot, err := os.OpenRoot(cfg.Archive)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer archiveRoot.Close()
	metadataRoot, err := os.OpenRoot(cfg.MetadataRoot)
	if err != nil {
		return fmt.Errorf("open metadata: %w", err)
	}
	defer metadataRoot.Close()
	readerRoot, err := os.OpenRoot(cfg.ReaderLibrary)
	if err != nil {
		return fmt.Errorf("open Reader library: %w", err)
	}
	defer readerRoot.Close()

	catalog, err := loadCatalog(cfg, archiveRoot, metadataRoot, nil)
	if err != nil {
		return err
	}
	for _, track := range catalog.Tracks {
		if err := verifyRootedDigest(archiveRoot, cfg.Archive, track.AudioPath, track.AudioBytes, track.AudioSHA256); err != nil {
			return fmt.Errorf("track %q: %w", track.ID, err)
		}
		if track.HasCover {
			coverRoot, coverRootPath := archiveRoot, cfg.Archive
			if containedPath(track.CoverPath, cfg.MetadataRoot) {
				coverRoot, coverRootPath = metadataRoot, cfg.MetadataRoot
			}
			if err := verifyRootedDigest(
				coverRoot, coverRootPath, track.CoverPath,
				track.CoverBytes, track.CoverSHA256,
			); err != nil {
				return fmt.Errorf("track %q cover: %w", track.ID, err)
			}
		}
	}

	databaseURL := (&url.URL{Scheme: "file", Path: cfg.DBPath}).String() + "?mode=ro&immutable=1"
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return fmt.Errorf("open retained database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var version int
	if err := db.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return fmt.Errorf("read retained schema: %w", err)
	}
	if version != currentSchemaVersion {
		return fmt.Errorf("retained schema is %d, want %d", version, currentSchemaVersion)
	}
	var quickCheck string
	if err := db.QueryRowContext(ctx, "pragma quick_check").Scan(&quickCheck); err != nil || quickCheck != "ok" {
		return fmt.Errorf("retained SQLite quick_check=%q: %w", quickCheck, err)
	}
	foreignKeys, err := db.QueryContext(ctx, "pragma foreign_key_check")
	if err != nil {
		return fmt.Errorf("inspect retained SQLite foreign keys: %w", err)
	}
	if foreignKeys.Next() {
		var table, parent string
		var rowID any
		var foreignKeyID int
		if err := foreignKeys.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			foreignKeys.Close()
			return fmt.Errorf("inspect retained SQLite foreign key failure: %w", err)
		}
		foreignKeys.Close()
		return fmt.Errorf("retained SQLite has a foreign key failure in %q row %v referencing %q constraint %d", table, rowID, parent, foreignKeyID)
	}
	if err := foreignKeys.Close(); err != nil {
		return fmt.Errorf("inspect retained SQLite foreign keys: %w", err)
	}
	if err := validateCanonicalSchema(ctx, db); err != nil {
		return err
	}
	if err := retainedAdmissionIntegrity(ctx, db); err != nil {
		return fmt.Errorf("retained-data admission: %w", err)
	}
	if err := validateReaderVolume(ctx, db, readerRoot, cfg.ReaderLibrary); err != nil {
		return err
	}
	if err := readerRelationalIntegrity(ctx, db); err != nil {
		return fmt.Errorf("retained Reader relationships: %w", err)
	}
	var mainRows int
	if err := db.QueryRowContext(ctx, `
select count(*) from stations where id='main' and kind='shared'`).Scan(&mainRows); err != nil || mainRows != 1 {
		return fmt.Errorf("retained database has %d main station rows: %w", mainRows, err)
	}
	if err := rejectSQLiteSidecars(cfg.DBPath); err != nil {
		return err
	}
	return nil
}

// validateMigrationSourceVolume is the stopped-volume admission gate used
// before a supported legacy database is copied or backed up. It deliberately
// does not mutate or migrate the database; the candidate performs that work
// only after the source snapshot has been sealed.
func validateMigrationSourceVolume(ctx context.Context, root string) error {
	root, err := filepath.Abs(root)
	if err != nil || root == string(filepath.Separator) {
		return fmt.Errorf("invalid retained volume root")
	}
	cfg := Config{
		MetadataRoot:  root,
		Archive:       filepath.Join(root, "music-library"),
		DBPath:        filepath.Join(root, "station.sqlite3"),
		ReaderLibrary: filepath.Join(root, "reader-library"),
	}
	if err := validateVolumeDataPaths(cfg); err != nil {
		return fmt.Errorf("validate retained paths: %w", err)
	}
	if err := validateRetainedTreeBudget(root); err != nil {
		return fmt.Errorf("validate retained-volume budget: %w", err)
	}
	if err := rejectSQLiteSidecars(cfg.DBPath); err != nil {
		return err
	}
	databaseInfo, err := os.Lstat(cfg.DBPath)
	if err != nil || !databaseInfo.Mode().IsRegular() || databaseInfo.Size() <= 0 {
		return fmt.Errorf("migration source has no regular retained database")
	}
	archiveRoot, err := os.OpenRoot(cfg.Archive)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer archiveRoot.Close()
	metadataRoot, err := os.OpenRoot(cfg.MetadataRoot)
	if err != nil {
		return fmt.Errorf("open metadata: %w", err)
	}
	defer metadataRoot.Close()
	readerRoot, err := os.OpenRoot(cfg.ReaderLibrary)
	if err != nil {
		return fmt.Errorf("open Reader library: %w", err)
	}
	defer readerRoot.Close()
	catalog, err := loadCatalog(cfg, archiveRoot, metadataRoot, nil)
	if err != nil {
		return err
	}
	for _, track := range catalog.Tracks {
		if err := verifyRootedDigest(
			archiveRoot, cfg.Archive, track.AudioPath,
			track.AudioBytes, track.AudioSHA256,
		); err != nil {
			return fmt.Errorf("track %q: %w", track.ID, err)
		}
		if track.HasCover {
			coverRoot, coverRootPath := archiveRoot, cfg.Archive
			if containedPath(track.CoverPath, cfg.MetadataRoot) {
				coverRoot, coverRootPath = metadataRoot, cfg.MetadataRoot
			}
			if err := verifyRootedDigest(
				coverRoot, coverRootPath, track.CoverPath,
				track.CoverBytes, track.CoverSHA256,
			); err != nil {
				return fmt.Errorf("track %q cover: %w", track.ID, err)
			}
		}
	}

	databaseURL := (&url.URL{Scheme: "file", Path: cfg.DBPath}).String() +
		"?mode=ro&immutable=1"
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration source database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var version int
	if err := db.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return fmt.Errorf("read migration source schema: %w", err)
	}
	if version == currentSchemaVersion {
		return validateVolume(ctx, root)
	}
	if version < 0 || version >= currentSchemaVersion {
		return fmt.Errorf("migration source schema %d is unsupported", version)
	}
	if err := preflightImmutableDatabase(ctx, cfg.DBPath, databaseInfo.Size()); err != nil {
		return fmt.Errorf("migration-source database: %w", err)
	}
	if err := validateLegacyReaderVolume(
		ctx, db, readerRoot, cfg.ReaderLibrary, version,
	); err != nil {
		return fmt.Errorf("migration-source Reader storage: %w", err)
	}
	return nil
}

func validateLegacyReaderVolume(
	ctx context.Context, db *sql.DB, readerRoot *os.Root, root string, version int,
) error {
	if version >= 4 {
		return validateReaderVolume(ctx, db, readerRoot, root)
	}
	var tables int
	if err := db.QueryRowContext(ctx, `
select count(*) from sqlite_master
where type='table' and name in ('reader_items','reader_segments')`).Scan(&tables); err != nil {
		return err
	}
	if tables == 0 {
		return nil
	}
	if tables != 2 {
		return fmt.Errorf("legacy Reader tables are incomplete")
	}
	type storageMapping struct {
		old, current string
	}
	storageByItem := make(map[string]storageMapping)
	rows, err := db.QueryContext(ctx, `
select id, storage_dir, source_path, normalized_text_path, manifest_path
from reader_items`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, storage, source, normalized, manifest string
		if err := rows.Scan(&id, &storage, &source, &normalized, &manifest); err != nil {
			rows.Close()
			return err
		}
		currentStorage, err := virtualReaderStorage(id, storage, "", root)
		if !validRouteID(id) || err != nil {
			rows.Close()
			return fmt.Errorf("legacy Reader item %q has invalid storage", id)
		}
		storageByItem[id] = storageMapping{old: storage, current: currentStorage}
		for _, path := range []string{source, normalized, manifest} {
			currentPath, err := relocateReaderPath(storage, currentStorage, path)
			if err != nil {
				rows.Close()
				return err
			}
			if _, err := rootedRegularInfo(readerRoot, root, currentPath); err != nil {
				rows.Close()
				return fmt.Errorf("legacy Reader item %q artifact: %w", id, err)
			}
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	rows, err = db.QueryContext(ctx, `
select item_id, status, coalesce(audio_path, ''), audio_bytes from reader_segments`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, status, path string
		var bytes int64
		if err := rows.Scan(&id, &status, &path, &bytes); err != nil {
			rows.Close()
			return err
		}
		if status != "ready" {
			continue
		}
		mapping, ok := storageByItem[id]
		if !ok || path == "" || !supportedAudioPath(path) ||
			bytes <= 0 || bytes > maxReaderAudioBytes {
			rows.Close()
			return fmt.Errorf("legacy Reader item %q has invalid ready audio metadata", id)
		}
		currentPath, err := relocateReaderPath(mapping.old, mapping.current, path)
		if err != nil {
			rows.Close()
			return err
		}
		info, err := rootedRegularInfo(readerRoot, root, currentPath)
		if err != nil || info.Size() != bytes {
			rows.Close()
			return fmt.Errorf("legacy Reader item %q audio is missing or changed", id)
		}
	}
	return rows.Close()
}

func validateCanonicalSchema(ctx context.Context, db *sql.DB) error {
	expectedTables := map[string][]string{
		"app_metadata":          {"key", "value"},
		"likes":                 {"track_id", "liked", "updated_at"},
		"reader_items":          {"id", "title", "source_url", "source_type", "source_hash", "author", "published_at", "uploaded_at", "generated_at", "status", "voice", "tts_backend", "tts_speed", "storage_dir", "source_path", "normalized_text_path", "manifest_path", "total_duration", "segment_count", "audio_bytes", "extractor_version", "quality_score", "quality_warnings", "cleanup_after", "notes"},
		"reader_playback":       {"item_id", "segment_index", "position", "playing", "updated_at", "revision", "writer_id", "writer_sequence"},
		"reader_segments":       {"id", "item_id", "segment_index", "heading_path", "kind", "text", "char_start", "char_end", "audio_path", "duration", "audio_bytes", "status", "audio_sha256"},
		"skip_counts":           {"track_id", "skip_count"},
		"station_creation_keys": {"key_hash", "station_id", "owner_hash", "created_at"},
		"station_queue":         {"station_id", "position", "track_id"},
		"stations":              {"id", "kind", "owner_hash", "track_id", "position", "playing", "repeat_one", "shuffle", "created_at", "updated_at", "track_changed_at", "expires_at", "revision", "creator_bucket"},
	}
	expectedTableSQL := map[string]string{
		"app_metadata": `create table app_metadata (
			key text primary key,
			value text not null
		)`,
		"likes": `create table likes (
			track_id text primary key, liked integer not null default 0, updated_at real not null
		)`,
		"reader_items": `create table reader_items (
			id text primary key, title text not null, source_url text, source_type text not null,
			source_hash text not null, author text, published_at text, uploaded_at real not null,
			generated_at real, status text not null default 'draft', voice text not null default 'saga_nb_readable',
			tts_backend text not null default 'kokoro', tts_speed real, storage_dir text not null,
			source_path text not null, normalized_text_path text not null, manifest_path text not null,
			total_duration real not null default 0, segment_count integer not null default 0,
			audio_bytes integer not null default 0, extractor_version text not null, quality_score real,
			quality_warnings text not null default '[]', cleanup_after real, notes text
		)`,
		"reader_playback": `create table reader_playback (
			item_id text primary key references reader_items(id) on delete cascade,
			segment_index integer not null default 0,
			position real not null default 0,
			playing integer not null default 0,
			updated_at real not null,
			revision integer not null default 0
				check(revision between 0 and 9007199254740990),
			writer_id text not null default '',
			writer_sequence integer not null default 0 check(writer_sequence >= 0)
		)`,
		"reader_segments": `create table reader_segments (
			id integer primary key autoincrement,
			item_id text not null references reader_items(id) on delete cascade,
			segment_index integer not null, heading_path text not null default '[]', kind text not null,
			text text not null, char_start integer not null, char_end integer not null, audio_path text,
			duration real not null default 0, audio_bytes integer not null default 0,
			status text not null default 'pending', audio_sha256 text not null default '', unique(item_id, segment_index)
		)`,
		"skip_counts": `create table skip_counts (
			track_id text primary key,
			skip_count integer not null default 0
				check(skip_count between 0 and 9007199254740990)
		)`,
		"station_creation_keys": `create table station_creation_keys (
			key_hash text primary key
				check(length(key_hash)=64 and key_hash not glob '*[^0-9a-f]*'),
			station_id text not null unique references stations(id) on delete cascade,
			owner_hash text not null
				check(length(owner_hash)=64 and owner_hash not glob '*[^0-9a-f]*'),
			created_at real not null
		)`,
		"station_queue": `create table station_queue (
			station_id text not null references stations(id) on delete cascade,
			position integer not null check(position between 0 and 99),
			track_id text not null,
			primary key(station_id, position)
		)`,
		"stations": `create table stations (
			id text primary key,
			kind text not null check(kind in ('shared', 'temporary')),
			owner_hash text not null default '', track_id text not null,
			position real not null default 0, playing integer not null default 0,
			repeat_one integer not null default 0, shuffle integer not null default 0,
			created_at real not null, updated_at real not null, track_changed_at real not null,
			expires_at real, revision integer not null default 1
				check(revision between 1 and 9007199254740990),
			creator_bucket text not null default '',
			check((id='main' and kind='shared' and owner_hash='' and creator_bucket='' and expires_at is null) or
			      (id<>'main' and kind='temporary' and length(owner_hash)=64
			       and owner_hash not glob '*[^0-9a-f]*' and length(creator_bucket)=64
			       and creator_bucket not glob '*[^0-9a-f]*' and expires_at is not null
			       and length(id) in (12,32) and id not glob '*[^0-9a-f]*'))
		)`,
	}
	for name, statement := range expectedTableSQL {
		expectedTableSQL[name] = normalizeSchemaSQL(statement)
	}
	rows, err := db.QueryContext(ctx, `
select type, name, tbl_name, coalesce(sql, '')
from sqlite_master where name not like 'sqlite_%'
order by type, name`)
	if err != nil {
		return fmt.Errorf("inspect retained schema objects: %w", err)
	}
	seenTables := make(map[string]bool)
	seenIndex, seenTrigger := false, false
	for rows.Next() {
		var kind, name, table, statement string
		if err := rows.Scan(&kind, &name, &table, &statement); err != nil {
			rows.Close()
			return err
		}
		normalized := normalizeSchemaSQL(statement)
		switch kind {
		case "table":
			if _, ok := expectedTables[name]; !ok {
				rows.Close()
				return fmt.Errorf("retained schema contains unexpected table %q", name)
			}
			seenTables[name] = true
			if normalized != expectedTableSQL[name] {
				rows.Close()
				return fmt.Errorf("retained table %q definition is not canonical", name)
			}
		case "index":
			if name != "stations_expiry" || table != "stations" ||
				normalized != "create index stations_expiry on stations(expires_at) where expires_at is not null" {
				rows.Close()
				return fmt.Errorf("retained schema contains non-canonical index %q", name)
			}
			seenIndex = true
		case "trigger":
			const capacityTrigger = "create trigger temporary_station_capacity before insert on stations " +
				"when new.kind='temporary' and ( " +
				"(select count(*) from stations where kind='temporary') >= 100 or " +
				"(select count(*) from stations " +
				"where kind='temporary' and creator_bucket=new.creator_bucket) >= 5 ) " +
				"begin select raise(abort, 'temporary station capacity reached'); end"
			if name != "temporary_station_capacity" || table != "stations" ||
				normalized != capacityTrigger {
				rows.Close()
				return fmt.Errorf("retained schema contains non-canonical trigger %q", name)
			}
			seenTrigger = true
		default:
			rows.Close()
			return fmt.Errorf("retained schema contains unexpected %s %q", kind, name)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(seenTables) != len(expectedTables) || !seenIndex || !seenTrigger {
		return fmt.Errorf("retained schema is missing canonical objects")
	}
	for table, expected := range expectedTables {
		columns, err := db.QueryContext(ctx, "pragma table_info("+table+")")
		if err != nil {
			return fmt.Errorf("inspect retained table %q: %w", table, err)
		}
		actual := []string{}
		for columns.Next() {
			var cid, notNull, primaryKey int
			var name, columnType string
			var defaultValue any
			if err := columns.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
				columns.Close()
				return err
			}
			actual = append(actual, name)
		}
		if err := columns.Close(); err != nil {
			return err
		}
		if strings.Join(actual, "\x00") != strings.Join(expected, "\x00") {
			return fmt.Errorf("retained table %q columns are not canonical", table)
		}
	}
	return nil
}

func normalizeSchemaSQL(statement string) string {
	statement = strings.ToLower(strings.ReplaceAll(statement, `"`, ""))
	return strings.Join(strings.Fields(statement), " ")
}

func rejectSQLiteSidecars(database string) error {
	for _, suffix := range []string{"-wal", "-shm"} {
		info, err := os.Stat(database + suffix)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect retained SQLite sidecar: %w", err)
		}
		if info.Size() > 0 {
			return fmt.Errorf("retained volume contains non-empty SQLite sidecar %s", filepath.Base(database+suffix))
		}
	}
	return nil
}

func validateReaderVolume(ctx context.Context, db *sql.DB, readerRoot *os.Root, root string) error {
	var storedRoot string
	if err := db.QueryRowContext(ctx,
		"select value from app_metadata where key='reader_root'").Scan(&storedRoot); err != nil &&
		!errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect retained Reader root: %w", err)
	}
	type storageMapping struct {
		old, current string
	}
	storageByItem := make(map[string]storageMapping)
	rows, err := db.QueryContext(ctx, `
select id, storage_dir, source_path, normalized_text_path, manifest_path from reader_items`)
	if err != nil {
		return fmt.Errorf("inspect retained Reader items: %w", err)
	}
	for rows.Next() {
		var id, storage, source, normalized, manifest string
		if err := rows.Scan(&id, &storage, &source, &normalized, &manifest); err != nil {
			rows.Close()
			return err
		}
		currentStorage, err := virtualReaderStorage(id, storage, storedRoot, root)
		if !validRouteID(id) || err != nil {
			rows.Close()
			return fmt.Errorf("Reader item %q has invalid identity or storage", id)
		}
		storageByItem[id] = storageMapping{old: storage, current: currentStorage}
		for artifactIndex, path := range []string{source, normalized, manifest} {
			currentPath, pathErr := relocateReaderPath(storage, currentStorage, path)
			if pathErr != nil {
				rows.Close()
				return fmt.Errorf("Reader item %q artifact path: %w", id, pathErr)
			}
			info, err := rootedRegularInfo(readerRoot, root, currentPath)
			if err != nil {
				rows.Close()
				return fmt.Errorf("Reader item %q artifact %q: %w", id, filepath.Base(path), err)
			}
			if artifactIndex == 0 && (info.Size() <= 0 || info.Size() > maxReaderSourceBytes) {
				rows.Close()
				return fmt.Errorf("Reader item %q source is outside the retained size limit", id)
			}
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	rows, err = db.QueryContext(ctx, `
select item_id, status, coalesce(audio_path, ''), audio_bytes, audio_sha256
from reader_segments`)
	if err != nil {
		return fmt.Errorf("inspect retained Reader segments: %w", err)
	}
	for rows.Next() {
		var id, status, path, digest string
		var bytes int64
		if err := rows.Scan(&id, &status, &path, &bytes, &digest); err != nil {
			rows.Close()
			return err
		}
		if path == "" && status != "ready" {
			continue
		}
		if status == "ready" && (path == "" || !supportedAudioPath(path) ||
			!sha256Pattern.MatchString(digest) || bytes <= 0 || bytes > maxReaderAudioBytes) {
			rows.Close()
			return fmt.Errorf("Reader item %q has invalid ready audio metadata", id)
		}
		if path != "" {
			mapping, ok := storageByItem[id]
			if !ok {
				rows.Close()
				return fmt.Errorf("Reader segment for %q has no storage mapping", id)
			}
			currentPath, pathErr := relocateReaderPath(mapping.old, mapping.current, path)
			if pathErr != nil {
				rows.Close()
				return fmt.Errorf("Reader item %q audio path: %w", id, pathErr)
			}
			if err := verifyRootedDigest(readerRoot, root, currentPath, bytes, digest); err != nil {
				rows.Close()
				return fmt.Errorf("Reader item %q audio: %w", id, err)
			}
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return nil
}

func virtualReaderStorage(id, storage, storedRoot, inspectedRoot string) (string, error) {
	if containedPath(storage, inspectedRoot) {
		resolvedRoot, rootErr := filepath.EvalSymlinks(inspectedRoot)
		resolvedStorage, storageErr := filepath.EvalSymlinks(storage)
		relative, relativeErr := filepath.Rel(resolvedRoot, resolvedStorage)
		if rootErr != nil || storageErr != nil || relativeErr != nil ||
			relative == ".." ||
			strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
			filepath.IsAbs(relative) {
			return "", fmt.Errorf("storage cannot be rebound to the inspected Reader root")
		}
		return filepath.Join(inspectedRoot, relative), nil
	}
	oldRoot := storedRoot
	if oldRoot == "" || !inside(storage, oldRoot) {
		var err error
		oldRoot, err = inferLegacyReaderRoot(id, storage)
		if err != nil {
			return "", err
		}
	}
	relative, err := filepath.Rel(filepath.Clean(oldRoot), filepath.Clean(storage))
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("storage is not beneath the persisted Reader root")
	}
	current := filepath.Join(inspectedRoot, relative)
	if !containedPath(current, inspectedRoot) {
		return "", fmt.Errorf("rebased storage escapes the inspected Reader root")
	}
	return current, nil
}

func verifyRootedDigest(rootHandle *os.Root, root, path string, expectedBytes int64, expectedDigest string) error {
	return verifyRootedDigestContext(context.Background(), rootHandle, root, path, expectedBytes, expectedDigest)
}

func verifyRootedDigestContext(ctx context.Context, rootHandle *os.Root, root, path string, expectedBytes int64, expectedDigest string) error {
	file, stat, err := openRootedRegular(rootHandle, root, path)
	if err != nil {
		return err
	}
	defer file.Close()
	if stat.Size() != expectedBytes {
		return fmt.Errorf("%s size is %d, want %d", filepath.Base(path), stat.Size(), expectedBytes)
	}
	hash := sha256.New()
	buffer := make([]byte, 64<<10)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		count, readErr := file.Read(buffer)
		if count > 0 {
			if _, err := hash.Write(buffer[:count]); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expectedDigest) {
		return fmt.Errorf("%s digest mismatch", filepath.Base(path))
	}
	return nil
}

func rootedDigest(rootHandle *os.Root, root, path string) (string, error) {
	file, _, err := openRootedRegular(rootHandle, root, path)
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
