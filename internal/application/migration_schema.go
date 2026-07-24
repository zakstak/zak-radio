package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	_ "modernc.org/sqlite"
)

const currentSchemaVersion = 14

type migration struct {
	version int
	run     func(context.Context, *sql.Tx) error
}

func openDatabase(ctx context.Context, path, retainedRoot string) (*sql.DB, error) {
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		if err := preflightDatabase(ctx, path, info.Size()); err != nil {
			return nil, err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// PRAGMAs are connection-local. A single connection is ample for this small
	// service and ensures every query uses the configured connection.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, statement := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", statement, err)
		}
	}
	var journalMode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable WAL journal mode: %w", err)
	}
	if !strings.EqualFold(journalMode, "wal") {
		db.Close()
		return nil, fmt.Errorf("enable WAL journal mode: SQLite selected %q", journalMode)
	}
	if err := migrate(ctx, db, path, retainedRoot); err != nil {
		db.Close()
		return nil, err
	}
	if err := validateCanonicalSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func preflightDatabase(ctx context.Context, path string, size int64) error {
	return preflightDatabaseMode(ctx, path, size, false)
}

func preflightImmutableDatabase(ctx context.Context, path string, size int64) error {
	return preflightDatabaseMode(ctx, path, size, true)
}

func preflightDatabaseMode(
	ctx context.Context, path string, size int64, immutable bool,
) error {
	const maxDatabaseBytes = 512 << 20
	if size > maxDatabaseBytes {
		return fmt.Errorf("retained database exceeds %d bytes", maxDatabaseBytes)
	}
	var sidecarBytes int64
	for _, suffix := range []string{"-wal", "-shm"} {
		if info, err := os.Lstat(path + suffix); err == nil {
			if !info.Mode().IsRegular() || info.Size() > maxDatabaseBytes {
				return fmt.Errorf("retained SQLite sidecar %q is unsupported or oversized", suffix)
			}
			sidecarBytes += info.Size()
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if size+sidecarBytes > 2*maxDatabaseBytes {
		return fmt.Errorf("retained database and sidecars exceed preflight budget")
	}
	// Startup must consume committed WAL frames. Stopped-volume validation has
	// already rejected sidecars, so its immutable read cannot create new ones.
	databaseURL := (&url.URL{Scheme: "file", Path: path}).String() + "?mode=ro"
	if immutable {
		databaseURL += "&immutable=1"
	}
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var quick string
	if err := db.QueryRowContext(ctx, "pragma quick_check").Scan(&quick); err != nil || quick != "ok" {
		return fmt.Errorf("pre-migration SQLite quick_check=%q: %w", quick, err)
	}
	var version int
	if err := db.QueryRowContext(ctx, "pragma user_version").Scan(&version); err != nil {
		return err
	}
	if version > currentSchemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d",
			version, currentSchemaVersion)
	}
	if version == currentSchemaVersion {
		if err := validateCanonicalSchema(ctx, db); err != nil {
			return fmt.Errorf("pre-migration canonical schema: %w", err)
		}
		return nil
	}
	allowed := map[string]int64{
		"app_metadata": maxReaderItems, "likes": maxCatalogTracks,
		"reader_items": maxReaderItems, "reader_playback": maxReaderItems,
		"reader_segments": maxReaderSegments, "skip_counts": maxCatalogTracks,
		"station_creation_keys": maxTempStations,
		"stations":              maxTempStations + 1,
		"station":               maxTempStations + 1, "station_settings": maxTempStations + 1,
		"temporary_stations": maxTempStations, "skips": maxCatalogTracks * 100,
	}
	rows, err := db.QueryContext(ctx, `
select type, name, tbl_name, coalesce(sql, '')
from sqlite_master where name not like 'sqlite_%'
order by type, name`)
	if err != nil {
		return err
	}
	var tables []string
	for rows.Next() {
		var kind, name, table, statement string
		if err := rows.Scan(&kind, &name, &table, &statement); err != nil {
			rows.Close()
			return err
		}
		if kind != "table" {
			if !allowedLegacySchemaObject(version, kind, name, table, statement) {
				rows.Close()
				return fmt.Errorf(
					"pre-migration database contains unexpected %s %q", kind, name)
			}
			continue
		}
		if _, ok := allowed[name]; !ok {
			rows.Close()
			return fmt.Errorf("pre-migration database contains unexpected table %q", name)
		}
		tables = append(tables, name)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, table := range tables {
		var count int64
		if err := db.QueryRowContext(ctx,
			"select count(*) from "+quoteIdent(table)).Scan(&count); err != nil {
			return err
		}
		if count > allowed[table] {
			return fmt.Errorf("pre-migration table %q has %d rows, limit %d",
				table, count, allowed[table])
		}
		columns, err := db.QueryContext(ctx, "pragma table_xinfo("+quoteIdent(table)+")")
		if err != nil {
			return err
		}
		var names []string
		for columns.Next() {
			var cid, notNull, primaryKey, hidden int
			var name, columnType string
			var defaultValue any
			if err := columns.Scan(&cid, &name, &columnType, &notNull,
				&defaultValue, &primaryKey, &hidden); err != nil {
				columns.Close()
				return err
			}
			if hidden != 0 {
				columns.Close()
				return fmt.Errorf(
					"pre-migration table %q contains generated or hidden column %q",
					table, name)
			}
			names = append(names, name)
		}
		if err := columns.Close(); err != nil {
			return err
		}
		for _, name := range names {
			var maximum sql.NullInt64
			var containsNUL sql.NullInt64
			query := "select max(length(cast(" + quoteIdent(name) +
				" as blob))), max(instr(cast(" + quoteIdent(name) +
				" as text), char(0))) from " + quoteIdent(table)
			if err := db.QueryRowContext(ctx, query).Scan(&maximum, &containsNUL); err != nil {
				return err
			}
			if maximum.Valid && maximum.Int64 > maxTrackTextBytes {
				return fmt.Errorf("pre-migration table %q column %q exceeds field budget",
					table, name)
			}
			if containsNUL.Valid && containsNUL.Int64 > 0 {
				return fmt.Errorf("pre-migration table %q column %q contains NUL data",
					table, name)
			}
		}
	}
	if version < currentSchemaVersion && len(tables) > 0 {
		_, protected, err := existingProtectedBackup(ctx, path, version, "")
		if err != nil {
			return err
		}
		if err := ensureMigrationHeadroom(path, size+sidecarBytes, !protected); err != nil {
			return err
		}
	}
	return nil
}

func allowedLegacySchemaObject(version int, kind, name, table, statement string) bool {
	normalized := normalizeSchemaSQL(statement)
	switch kind {
	case "index":
		return version >= 2 && name == "stations_expiry" && table == "stations" &&
			normalized == "create index stations_expiry on stations(expires_at) where expires_at is not null"
	case "trigger":
		if version < 4 || name != "temporary_station_capacity" || table != "stations" {
			return false
		}
		base := normalizeSchemaSQL(`
create trigger temporary_station_capacity before insert on stations
when new.kind='temporary' and
	(select count(*) from stations where kind='temporary') >= 100
begin select raise(abort, 'temporary station capacity reached'); end`)
		creatorOptional := normalizeSchemaSQL(`
create trigger temporary_station_capacity before insert on stations
when new.kind='temporary' and (
	(select count(*) from stations where kind='temporary') >= 100 or
	(new.creator_bucket<>'' and
	 (select count(*) from stations
	  where kind='temporary' and creator_bucket=new.creator_bucket) >= 5)
)
begin select raise(abort, 'temporary station capacity reached'); end`)
		creatorRequired := normalizeSchemaSQL(`
create trigger temporary_station_capacity before insert on stations
when new.kind='temporary' and (
	(select count(*) from stations where kind='temporary') >= 100 or
	(select count(*) from stations
	 where kind='temporary' and creator_bucket=new.creator_bucket) >= 5
)
begin select raise(abort, 'temporary station capacity reached'); end`)
		switch {
		case version < 10:
			return normalized == base
		case version == 10:
			return normalized == creatorOptional
		default:
			return normalized == creatorRequired
		}
	default:
		return false
	}
}

func ensureMigrationHeadroom(path string, databaseBytes int64, includeBackup bool) error {
	const reserve = int64(64 * 1024 * 1024)
	const maxInt64 = int64(^uint64(0) >> 1)
	if databaseBytes < 0 ||
		(includeBackup && databaseBytes > (maxInt64-reserve)/2) ||
		(!includeBackup && databaseBytes > maxInt64-reserve) {
		return fmt.Errorf("migration size is outside the supported range")
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(filepath.Dir(path), &stat); err != nil {
		return fmt.Errorf("inspect migration filesystem headroom: %w", err)
	}
	available := int64(stat.Bavail) * int64(stat.Bsize)
	required := databaseBytes + reserve
	if includeBackup {
		required += databaseBytes
	}
	if available < required {
		return fmt.Errorf("migration requires %d available bytes, filesystem has %d",
			required, available)
	}
	return nil
}

func migrate(ctx context.Context, db *sql.DB, path, retainedRoot string) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > currentSchemaVersion {
		return fmt.Errorf("database schema version %d is newer than supported version %d", version, currentSchemaVersion)
	}
	if version < currentSchemaVersion {
		var tables int
		if err := db.QueryRowContext(ctx, `
select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'`).Scan(&tables); err != nil {
			return fmt.Errorf("inspect database before migration: %w", err)
		}
		if tables > 0 {
			if _, err := backupBeforeMigration(ctx, db, path, retainedRoot, version); err != nil {
				return err
			}
		}
	}
	migrations := []migration{
		{1, createAuxiliaryTables},
		{2, consolidateStations},
		{3, aggregateSkipCounts},
		{4, strengthenReaderAndStationData},
		{5, enforceStationIdentityAndTrackStats},
		{6, enforceRoutableTemporaryStations},
		{7, addReaderPlaybackRevision},
		{8, addReaderPlaybackWriterSequence},
		{9, addStationCreatorBuckets},
		{10, enforceStationCreatorCapacity},
		{11, enforceAttributedTemporaryStations},
		{12, enforceRevisionHeadroom},
		{13, reserveRevisionHeadroomAndClock},
		{14, addStationCreationIdempotency},
	}
	for _, item := range migrations {
		if item.version <= version {
			continue
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", item.version, err)
		}
		if err := item.run(ctx, tx); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d: %w", item.version, err)
		}
		if _, err := tx.ExecContext(ctx, "PRAGMA user_version = "+strconv.Itoa(item.version)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("set migration version %d: %w", item.version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %d: %w", item.version, err)
		}
	}
	return nil
}

func reserveRevisionHeadroomAndClock(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `
update stations set revision=1 where revision>=?;
update reader_playback set revision=0 where revision>=?;
update skip_counts set skip_count=0 where skip_count>=?;`,
		maxRevisionValue-2, maxRevisionValue-2, maxRevisionValue-2); err != nil {
		return err
	}
	var trackRaw string
	if err := tx.QueryRowContext(ctx,
		`select value from app_metadata where key='track_stats_revision'`).Scan(&trackRaw); err != nil {
		return err
	}
	trackRevision, err := strconv.ParseInt(trackRaw, 10, 64)
	if err != nil || trackRevision < 0 || trackRevision >= maxRevisionValue-2 {
		if _, err := tx.ExecContext(ctx,
			`update app_metadata set value='0' where key='track_stats_revision'`); err != nil {
			return err
		}
	}
	var retainedHigh sql.NullFloat64
	if err := tx.QueryRowContext(ctx, "select max(updated_at) from stations").Scan(&retainedHigh); err != nil {
		return err
	}
	high := retainedHigh.Float64
	var raw string
	err = tx.QueryRowContext(ctx,
		`select value from app_metadata where key='logical_clock_high'`).Scan(&raw)
	if err == nil {
		stored, parseErr := strconv.ParseFloat(raw, 64)
		if parseErr == nil && !math.IsNaN(stored) && !math.IsInf(stored, 0) &&
			stored >= 0 && stored <= 1e11 && stored > high {
			high = stored
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `
insert into app_metadata(key, value) values ('logical_clock_high', ?)
on conflict(key) do update set value=excluded.value`,
		strconv.FormatFloat(high, 'f', 6, 64))
	return err
}

func addStationCreationIdempotency(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
create table if not exists station_creation_keys (
	key_hash text primary key
		check(length(key_hash)=64 and key_hash not glob '*[^0-9a-f]*'),
	station_id text not null unique references stations(id) on delete cascade,
	owner_hash text not null
		check(length(owner_hash)=64 and owner_hash not glob '*[^0-9a-f]*'),
	created_at real not null
);`)
	return err
}

func enforceRevisionHeadroom(ctx context.Context, tx *sql.Tx) error {
	var value string
	err := tx.QueryRowContext(ctx,
		`select value from app_metadata where key='track_stats_revision'`).Scan(&value)
	revision, parseErr := strconv.ParseInt(value, 10, 64)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx,
			`insert into app_metadata(key, value) values ('track_stats_revision', '0')`); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if parseErr != nil || revision < 0 || revision >= maxRevisionValue-2 {
		if _, err := tx.ExecContext(ctx,
			`update app_metadata set value='0' where key='track_stats_revision'`); err != nil {
			return err
		}
	}
	for _, statement := range []string{
		`drop trigger if exists temporary_station_capacity;`,
		`create table reader_playback_v12 (
			item_id text primary key references reader_items(id) on delete cascade,
			segment_index integer not null default 0,
			position real not null default 0,
			playing integer not null default 0,
			updated_at real not null,
			revision integer not null default 0
				check(revision between 0 and 9007199254740990),
			writer_id text not null default '',
			writer_sequence integer not null default 0 check(writer_sequence >= 0)
		);`,
		`insert into reader_playback_v12
			(item_id, segment_index, position, playing, updated_at, revision,
			 writer_id, writer_sequence)
		 select item_id, segment_index, position, playing, updated_at,
		        case when revision between 0 and 9007199254740990 then revision else 0 end,
		        writer_id, writer_sequence
		 from reader_playback;`,
		`drop table reader_playback;`,
		`alter table reader_playback_v12 rename to reader_playback;`,
		`create table skip_counts_v12 (
			track_id text primary key,
			skip_count integer not null default 0
				check(skip_count between 0 and 9007199254740990)
		);`,
		`insert into skip_counts_v12(track_id, skip_count)
		 select track_id,
		        case when skip_count between 0 and 9007199254740990 then skip_count else 0 end
		 from skip_counts;`,
		`drop table skip_counts;`,
		`alter table skip_counts_v12 rename to skip_counts;`,
		`create table stations_v12 (
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
		);`,
		`insert into stations_v12
			(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
			 created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket)
		 select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, expires_at,
		        case when revision between 1 and 9007199254740990 then revision else 1 end,
		        creator_bucket
		 from stations;`,
		`drop table stations;`,
		`alter table stations_v12 rename to stations;`,
		`create index stations_expiry on stations(expires_at) where expires_at is not null;`,
		`create trigger temporary_station_capacity before insert on stations
			when new.kind='temporary' and (
				(select count(*) from stations where kind='temporary') >= 100 or
				(select count(*) from stations
				 where kind='temporary' and creator_bucket=new.creator_bucket) >= 5
			)
			begin select raise(abort, 'temporary station capacity reached'); end;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func enforceAttributedTemporaryStations(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`drop trigger if exists temporary_station_capacity;`,
		`create table stations_v11 (
			id text primary key,
			kind text not null check(kind in ('shared', 'temporary')),
			owner_hash text not null default '', track_id text not null,
			position real not null default 0, playing integer not null default 0,
			repeat_one integer not null default 0, shuffle integer not null default 0,
			created_at real not null, updated_at real not null, track_changed_at real not null,
			expires_at real, revision integer not null default 1,
			creator_bucket text not null default '',
			check((id='main' and kind='shared' and owner_hash='' and creator_bucket='' and expires_at is null) or
			      (id<>'main' and kind='temporary' and length(owner_hash)=64
			       and owner_hash not glob '*[^0-9a-f]*' and length(creator_bucket)=64
			       and creator_bucket not glob '*[^0-9a-f]*' and expires_at is not null
			       and length(id) in (12,32) and id not glob '*[^0-9a-f]*'))
		);`,
		`insert into stations_v11
			(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
			 created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket)
		 select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket
		 from stations
		 where id='main' or
		  (kind='temporary' and length(owner_hash)=64 and owner_hash not glob '*[^0-9a-f]*'
		   and length(creator_bucket)=64 and creator_bucket not glob '*[^0-9a-f]*');`,
		`drop table stations;`,
		`alter table stations_v11 rename to stations;`,
		`create index stations_expiry on stations(expires_at) where expires_at is not null;`,
		`create trigger temporary_station_capacity before insert on stations
			when new.kind='temporary' and (
				(select count(*) from stations where kind='temporary') >= 100 or
				(select count(*) from stations
				 where kind='temporary' and creator_bucket=new.creator_bucket) >= 5
			)
			begin select raise(abort, 'temporary station capacity reached'); end;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func addStationCreatorBuckets(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `
alter table stations add column creator_bucket text not null default '';`)
	return err
}

func enforceStationCreatorCapacity(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`drop trigger temporary_station_capacity;`,
		`create trigger temporary_station_capacity before insert on stations
			when new.kind='temporary' and (
				(select count(*) from stations where kind='temporary') >= 100 or
				(new.creator_bucket<>'' and
				 (select count(*) from stations
				  where kind='temporary' and creator_bucket=new.creator_bucket) >= 5)
			)
			begin select raise(abort, 'temporary station capacity reached'); end;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func addReaderPlaybackWriterSequence(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`create table reader_playback_v8 (
			item_id text primary key references reader_items(id) on delete cascade,
			segment_index integer not null default 0,
			position real not null default 0,
			playing integer not null default 0,
			updated_at real not null,
			revision integer not null default 0 check(revision >= 0),
			writer_id text not null default '',
			writer_sequence integer not null default 0 check(writer_sequence >= 0)
		);`,
		`insert into reader_playback_v8
			(item_id, segment_index, position, playing, updated_at, revision)
		 select item_id, segment_index, position, playing, updated_at, revision
		 from reader_playback;`,
		`drop table reader_playback;`,
		`alter table reader_playback_v8 rename to reader_playback;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func addReaderPlaybackRevision(ctx context.Context, tx *sql.Tx) error {
	var columns int
	if err := tx.QueryRowContext(ctx, `
select count(*) from pragma_table_info('reader_playback') where name='revision'`).Scan(&columns); err != nil {
		return err
	}
	if columns == 1 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `
alter table reader_playback add column revision integer not null default 0
	check(revision >= 0);`)
	return err
}

func enforceRoutableTemporaryStations(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`drop trigger if exists temporary_station_capacity;`,
		`create table stations_v6 (
			id text primary key,
			kind text not null check(kind in ('shared', 'temporary')),
			owner_hash text not null default '', track_id text not null,
			position real not null default 0, playing integer not null default 0,
			repeat_one integer not null default 0, shuffle integer not null default 0,
			created_at real not null, updated_at real not null, track_changed_at real not null,
			expires_at real, revision integer not null default 1,
			check((id='main' and kind='shared' and owner_hash='' and expires_at is null) or
			      (id<>'main' and kind='temporary' and owner_hash<>'' and expires_at is not null
			       and length(id) in (12,32) and id not glob '*[^0-9a-f]*'))
		);`,
		`insert into stations_v6 select * from stations where id='main' or
			(kind='temporary' and length(id) in (12,32) and id not glob '*[^0-9a-f]*');`,
		`drop table stations;`,
		`alter table stations_v6 rename to stations;`,
		`create index stations_expiry on stations(expires_at) where expires_at is not null;`,
		`create trigger temporary_station_capacity before insert on stations
			when new.kind='temporary' and
				(select count(*) from stations where kind='temporary') >= 100
			begin select raise(abort, 'temporary station capacity reached'); end;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func enforceStationIdentityAndTrackStats(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`drop trigger if exists temporary_station_capacity;`,
		`create table stations_v5 (
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
			check((id='main' and kind='shared' and owner_hash='' and expires_at is null) or
			      (id<>'main' and kind='temporary' and owner_hash<>'' and expires_at is not null))
		);`,
		`insert into stations_v5
			(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
			 created_at, updated_at, track_changed_at, expires_at, revision)
		 select id, 'shared', '', track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, null, revision
		 from stations where id='main';`,
		`insert into stations_v5
			(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
			 created_at, updated_at, track_changed_at, expires_at, revision)
		 select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
		        created_at, updated_at, track_changed_at, expires_at, revision
		 from stations where id<>'main' and kind='temporary';`,
		`drop table stations;`,
		`alter table stations_v5 rename to stations;`,
		`create index stations_expiry on stations(expires_at) where expires_at is not null;`,
		`create trigger temporary_station_capacity
			before insert on stations
			when new.kind='temporary' and
				(select count(*) from stations where kind='temporary') >= 100
			begin
				select raise(abort, 'temporary station capacity reached');
			end;`,
		`insert into app_metadata(key, value) values ('track_stats_revision', '0')
			on conflict(key) do nothing;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func strengthenReaderAndStationData(ctx context.Context, tx *sql.Tx) error {
	for _, statement := range []string{
		`alter table reader_segments add column audio_sha256 text not null default '';`,
		`create table app_metadata (
			key text primary key,
			value text not null
		);`,
		`create trigger temporary_station_capacity
		before insert on stations
		when new.kind='temporary' and
			(select count(*) from stations where kind='temporary') >= 100
		begin
			select raise(abort, 'temporary station capacity reached');
		end;`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}
