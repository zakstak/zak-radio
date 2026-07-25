package application

import (
	"context"
	"database/sql"
)

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readStation(ctx context.Context, q queryer, id string, now float64) (Station, error) {
	var row Station
	var playing, repeatOne, shuffle int
	var saved int
	var expires sql.NullFloat64
	err := q.QueryRowContext(ctx, `
select id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
       created_at, updated_at, track_changed_at, expires_at, revision,
       exists(select 1 from station_definitions d where d.station_id=stations.id)
from stations
where id=? and (
	kind='shared' or expires_at>? or
	exists(select 1 from station_definitions d where d.station_id=stations.id)
)`, id, now).Scan(
		&row.ID, &row.Kind, &row.OwnerHash, &row.TrackID, &row.Position, &playing,
		&repeatOne, &shuffle, &row.CreatedAt, &row.UpdatedAt, &row.TrackChangedAt,
		&expires, &row.Revision, &saved)
	row.Playing, row.RepeatOne, row.Shuffle = playing != 0, repeatOne != 0, shuffle != 0
	row.Saved = saved != 0
	if expires.Valid {
		row.ExpiresAt = &expires.Float64
	}
	return row, err
}

func updateStation(ctx context.Context, tx *sql.Tx, row Station) error {
	result, err := tx.ExecContext(ctx, `
update stations set
	track_id=?, position=?, playing=?, repeat_one=?, shuffle=?, updated_at=?,
	track_changed_at=?, expires_at=?, revision=?
where id=? and revision=? and (
	kind='shared' or expires_at>? or
	exists(select 1 from station_definitions d where d.station_id=stations.id)
)`,
		row.TrackID, row.Position, boolInt(row.Playing), boolInt(row.RepeatOne),
		boolInt(row.Shuffle), row.UpdatedAt, row.TrackChangedAt, row.ExpiresAt,
		row.Revision, row.ID, row.Revision-1, row.UpdatedAt)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return sql.ErrNoRows
	}
	return nil
}
