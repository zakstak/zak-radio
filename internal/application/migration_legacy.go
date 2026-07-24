package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

func aggregateSkipCounts(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
create table skip_counts (
	track_id text primary key,
	skip_count integer not null default 0 check(skip_count >= 0)
);`); err != nil {
		return err
	}
	if exists, err := tableExists(ctx, tx, "skips"); err != nil {
		return err
	} else if exists {
		if _, err := tx.ExecContext(ctx, `
insert into skip_counts(track_id, skip_count)
select track_id, count(*) from skips group by track_id;`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "drop table skips"); err != nil {
			return err
		}
	}
	return nil
}

func createAuxiliaryTables(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
create table if not exists likes (
	track_id text primary key, liked integer not null default 0, updated_at real not null
);
create table if not exists skips (
	id integer primary key autoincrement, track_id text not null, skipped_at real not null, elapsed real not null
);
create table if not exists reader_items (
	id text primary key, title text not null, source_url text, source_type text not null,
	source_hash text not null, author text, published_at text, uploaded_at real not null,
	generated_at real, status text not null default 'draft', voice text not null default 'saga_nb_readable',
	tts_backend text not null default 'kokoro', tts_speed real, storage_dir text not null,
	source_path text not null, normalized_text_path text not null, manifest_path text not null,
	total_duration real not null default 0, segment_count integer not null default 0,
	audio_bytes integer not null default 0, extractor_version text not null, quality_score real,
	quality_warnings text not null default '[]', cleanup_after real, notes text
);
create table if not exists reader_segments (
	id integer primary key autoincrement,
	item_id text not null references reader_items(id) on delete cascade,
	segment_index integer not null, heading_path text not null default '[]', kind text not null,
	text text not null, char_start integer not null, char_end integer not null, audio_path text,
	duration real not null default 0, audio_bytes integer not null default 0,
	status text not null default 'pending', unique(item_id, segment_index)
);
create table if not exists reader_playback (
	item_id text primary key references reader_items(id) on delete cascade,
	segment_index integer not null default 0, position real not null default 0,
	playing integer not null default 0, updated_at real not null
);`)
	return err
}

func consolidateStations(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
drop table if exists stations_migrating;
create table stations_migrating (
	id text primary key,
	kind text not null check(kind in ('shared', 'temporary')),
	owner_hash text not null default '',
	track_id text not null,
	position real not null default 0,
	playing integer not null default 0,
	repeat_one integer not null default 0,
	shuffle integer not null default 0,
	created_at real not null,
	updated_at real not null,
	track_changed_at real not null,
	expires_at real,
	revision integer not null default 1,
	check((kind = 'shared' and owner_hash = '' and expires_at is null) or
	      (kind = 'temporary' and owner_hash <> '' and expires_at is not null))
);`); err != nil {
		return err
	}

	// Copy any already-unified or experimental `stations` table first, then let
	// the canonical legacy tables replace matching IDs.
	if exists, err := tableExists(ctx, tx, "stations"); err != nil {
		return err
	} else if exists {
		if err := copyStationTable(ctx, tx, false); err != nil {
			return err
		}
	}
	if exists, err := tableExists(ctx, tx, "station"); err != nil {
		return err
	} else if exists {
		if err := copyMainStation(ctx, tx); err != nil {
			return err
		}
	}
	if exists, err := tableExists(ctx, tx, "temporary_stations"); err != nil {
		return err
	} else if exists {
		if err := copyStationTable(ctx, tx, true); err != nil {
			return err
		}
	}
	for _, table := range []string{"stations", "station", "station_settings", "temporary_stations"} {
		if _, err := tx.ExecContext(ctx, "drop table if exists "+quoteIdent(table)); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
alter table stations_migrating rename to stations;
create index stations_expiry on stations(expires_at) where expires_at is not null;`); err != nil {
		return err
	}
	return nil
}

func copyMainStation(ctx context.Context, tx *sql.Tx) error {
	rows, err := queryMaps(ctx, tx, "station")
	if err != nil {
		return err
	}
	var settings map[string]any
	if ok, err := tableExists(ctx, tx, "station_settings"); err != nil {
		return err
	} else if ok {
		values, err := queryMaps(ctx, tx, "station_settings")
		if err != nil {
			return err
		}
		if len(values) > 0 {
			settings = values[0]
		}
	}
	for _, row := range rows {
		if id := stringValue(row, "id", "station_id"); id != "" && id != "1" && id != mainStationID {
			continue
		}
		trackID := stringValue(row, "track_id", "current_track_id")
		if trackID == "" {
			return errors.New("legacy station row has no track_id")
		}
		updated := floatValue(row, "updated_at")
		changed := floatValue(row, "track_changed_at")
		if changed == 0 {
			changed = updated
		}
		created := floatValue(row, "created_at")
		if created == 0 {
			created = changed
		}
		repeat := boolValue(row, "repeat_one")
		shuffle := boolValue(row, "shuffle")
		if settings != nil {
			repeat = boolValue(settings, "repeat_one")
			shuffle = boolValue(settings, "shuffle")
		}
		if err := insertMigratedStation(ctx, tx, migratedStation{
			ID: mainStationID, Kind: "shared", TrackID: trackID, Position: floatValue(row, "position"),
			Playing: boolValue(row, "playing"), RepeatOne: repeat, Shuffle: shuffle,
			CreatedAt: created, UpdatedAt: updated, TrackChangedAt: changed, Revision: intValue(row, "revision"),
		}); err != nil {
			return err
		}
	}
	return nil
}

func copyStationTable(ctx context.Context, tx *sql.Tx, forceTemporary bool) error {
	rows, err := queryMaps(ctx, tx, map[bool]string{true: "temporary_stations", false: "stations"}[forceTemporary])
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := stringValue(row, "id", "station_id")
		if id == "" {
			return errors.New("legacy station row has no id")
		}
		kind := stringValue(row, "kind")
		if forceTemporary || (kind == "" && id != mainStationID && id != "1") {
			kind = "temporary"
		}
		if kind == "" || id == "1" {
			kind, id = "shared", mainStationID
		}
		trackID := stringValue(row, "track_id", "current_track_id")
		if trackID == "" {
			return fmt.Errorf("legacy station %q has no track_id", id)
		}
		updated, changed := floatValue(row, "updated_at"), floatValue(row, "track_changed_at")
		if changed == 0 {
			changed = updated
		}
		created := floatValue(row, "created_at")
		if created == 0 {
			created = changed
		}
		station := migratedStation{
			ID: id, Kind: kind, OwnerHash: stringValue(row, "owner_hash"), TrackID: trackID,
			Position: floatValue(row, "position"), Playing: boolValue(row, "playing"),
			RepeatOne: boolValue(row, "repeat_one"), Shuffle: boolValue(row, "shuffle"),
			CreatedAt: created, UpdatedAt: updated, TrackChangedAt: changed,
			ExpiresAt: nullableFloat(row, "expires_at"), Revision: intValue(row, "revision"),
		}
		if kind == "shared" {
			station.OwnerHash, station.ExpiresAt = "", nil
		} else if station.OwnerHash == "" || station.ExpiresAt == nil {
			return fmt.Errorf("temporary station %q lacks owner_hash or expires_at", id)
		}
		if err := insertMigratedStation(ctx, tx, station); err != nil {
			return err
		}
	}
	return nil
}

type migratedStation struct {
	ID, Kind, OwnerHash, TrackID         string
	Position                             float64
	Playing, RepeatOne, Shuffle          bool
	CreatedAt, UpdatedAt, TrackChangedAt float64
	ExpiresAt                            *float64
	Revision                             int64
}

func insertMigratedStation(ctx context.Context, tx *sql.Tx, s migratedStation) error {
	if s.Revision < 1 {
		s.Revision = 1
	}
	_, err := tx.ExecContext(ctx, `
insert into stations_migrating
	(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	 created_at, updated_at, track_changed_at, expires_at, revision)
values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict(id) do update set
	kind=excluded.kind, owner_hash=excluded.owner_hash, track_id=excluded.track_id,
	position=excluded.position, playing=excluded.playing, repeat_one=excluded.repeat_one,
	shuffle=excluded.shuffle, created_at=excluded.created_at, updated_at=excluded.updated_at,
	track_changed_at=excluded.track_changed_at, expires_at=excluded.expires_at,
	revision=excluded.revision`,
		s.ID, s.Kind, s.OwnerHash, s.TrackID, s.Position, boolInt(s.Playing),
		boolInt(s.RepeatOne), boolInt(s.Shuffle), s.CreatedAt, s.UpdatedAt,
		s.TrackChangedAt, s.ExpiresAt, s.Revision)
	return err
}

func tableExists(ctx context.Context, tx *sql.Tx, name string) (bool, error) {
	var found string
	err := tx.QueryRowContext(ctx, `select name from sqlite_master where type='table' and name=?`, name).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func queryMaps(ctx context.Context, tx *sql.Tx, table string) ([]map[string]any, error) {
	columnRows, err := tx.QueryContext(ctx, "pragma table_xinfo("+quoteIdent(table)+")")
	if err != nil {
		return nil, err
	}
	var admitted []string
	for columnRows.Next() {
		var cid, notNull, primaryKey, hidden int
		var name, columnType string
		var defaultValue any
		if err := columnRows.Scan(
			&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey, &hidden,
		); err != nil {
			columnRows.Close()
			return nil, err
		}
		if hidden != 0 {
			columnRows.Close()
			return nil, fmt.Errorf(
				"legacy table %q contains generated or hidden column %q", table, name)
		}
		admitted = append(admitted, quoteIdent(name))
	}
	if err := columnRows.Close(); err != nil {
		return nil, err
	}
	if len(admitted) == 0 {
		return nil, fmt.Errorf("legacy table %q has no admitted columns", table)
	}
	rows, err := tx.QueryContext(ctx,
		"select "+strings.Join(admitted, ",")+" from "+quoteIdent(table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []map[string]any
	for rows.Next() {
		row, err := scanMap(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func quoteIdent(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func stringValue(row map[string]any, names ...string) string {
	for _, name := range names {
		if value, ok := row[name]; ok && value != nil {
			return fmt.Sprint(value)
		}
	}
	return ""
}

func floatValue(row map[string]any, names ...string) float64 {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return asFloat(value)
		}
	}
	return 0
}

func nullableFloat(row map[string]any, name string) *float64 {
	value, ok := row[name]
	if !ok || value == nil {
		return nil
	}
	result := asFloat(value)
	return &result
}

func intValue(row map[string]any, name string) int64 {
	return int64(floatValue(row, name))
}

func boolValue(row map[string]any, name string) bool {
	return intValue(row, name) != 0
}
