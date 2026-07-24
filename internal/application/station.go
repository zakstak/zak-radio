package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	stationmodel "zak-radio-apphost/internal/station"
)

var temporaryStationIDPattern = regexp.MustCompile(`^[a-f0-9]{12}(?:[a-f0-9]{20})?$`)

const (
	mainStationID          = "main"
	tempStationLife        = 24 * time.Hour
	earlySkipSeconds       = 6.0
	maxTempStations        = 100
	maxCreatorStations     = 5
	maxNormalizeSteps      = 10000
	maxShuffleCatchUpSteps = 64
	maxRetainedTimestamp   = 1e11
	// Revisions cross the JSON boundary, so keep every emitted value within
	// JavaScript's exact-integer range as well as SQLite's integer range.
	maxRevisionValue = int64(9007199254740990)
)

type Station = stationmodel.Station
type Snapshot = stationmodel.Snapshot
type Command = stationmodel.Command
type Clock = stationmodel.Clock
type RandomIndex = stationmodel.RandomIndex

type StationService struct {
	db          *sql.DB
	catalog     Catalog
	clock       Clock
	monotonic   Clock
	randomIndex RandomIndex
	events      *Broadcaster
	mu          sync.Mutex
	clockMu     sync.Mutex
	clockHigh   float64
	clockSample time.Time
}

func NewStationService(db *sql.DB, catalog Catalog, events *Broadcaster) *StationService {
	if len(catalog.IndexByID) != len(catalog.Tracks) {
		catalog.IndexByID = make(map[string]int, len(catalog.Tracks))
		for index := range catalog.Tracks {
			catalog.IndexByID[catalog.Tracks[index].ID] = index
		}
	}
	sample := time.Now()
	service := &StationService{
		db: db, catalog: catalog, events: events, clock: time.Now,
		monotonic: time.Now, clockSample: sample,
		randomIndex: func(n int) int {
			var raw [8]byte
			if _, err := rand.Read(raw[:]); err != nil {
				return int(time.Now().UnixNano() % int64(n))
			}
			var value uint64
			for _, b := range raw {
				value = value<<8 | uint64(b)
			}
			return int(value % uint64(n))
		},
	}
	var retainedHigh sql.NullFloat64
	if err := db.QueryRow(`select max(updated_at) from stations`).Scan(&retainedHigh); err == nil &&
		retainedHigh.Valid && retainedHigh.Float64 > 0 {
		service.clockHigh = retainedHigh.Float64
	}
	var retainedClock string
	if err := db.QueryRow(`
select value from app_metadata where key='logical_clock_high'`).Scan(&retainedClock); err == nil {
		if high, parseErr := strconv.ParseFloat(retainedClock, 64); parseErr == nil &&
			high > service.clockHigh {
			service.clockHigh = high
		}
	}
	return service
}

func (s *StationService) EnsureMain(ctx context.Context) error {
	if len(s.catalog.Tracks) == 0 {
		return errors.New("catalog has no playable tracks")
	}
	now := s.logicalNow()
	if _, err := s.db.ExecContext(ctx, `
insert into stations
	(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	 created_at, updated_at, track_changed_at, expires_at, revision)
values (?, 'shared', '', ?, 0, 0, 0, 0, ?, ?, ?, null, 1)
on conflict(id) do nothing`, mainStationID, s.catalog.Tracks[0].ID, now, now, now); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, "select id, kind, track_id from stations")
	if err != nil {
		return err
	}
	var invalidMain bool
	var invalidAuxiliary []string
	for rows.Next() {
		var id, kind, trackID string
		if err := rows.Scan(&id, &kind, &trackID); err != nil {
			rows.Close()
			return err
		}
		if s.catalog.ByID[trackID] != nil {
			continue
		}
		if id == mainStationID {
			invalidMain = true
		} else {
			invalidAuxiliary = append(invalidAuxiliary, id)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if invalidMain {
		result, err := s.db.ExecContext(ctx, `
update stations set track_id=?, position=0, playing=0, updated_at=?,
	track_changed_at=?, revision=revision+1 where id=? and revision<?`,
			s.catalog.Tracks[0].ID, now, now, mainStationID, maxRevisionValue-3)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return errors.New("main station revision has no safe increment headroom")
		}
	}
	for _, id := range invalidAuxiliary {
		if _, err := s.db.ExecContext(ctx, "delete from stations where id=?", id); err != nil {
			return err
		}
	}
	return s.reconcileCatalogStatistics(ctx)
}

func (s *StationService) Snapshot(ctx context.Context, stationID string) (Snapshot, error) {
	if !validStationID(normalizedStationID(stationID)) {
		return Snapshot{}, ErrInvalidCommand
	}
	now := s.logicalNow()
	row, err := readStation(ctx, s.db, normalizedStationID(stationID), now)
	if err != nil {
		return Snapshot{}, err
	}
	return s.snapshot(ctx, s.db, row, now)
}

func (s *StationService) Create(
	ctx context.Context, trackID, creatorBucket string,
) (string, string, float64, error) {
	key, err := randomHex(16)
	if err != nil {
		return "", "", 0, err
	}
	token, err := randomHex(24)
	if err != nil {
		return "", "", 0, err
	}
	return s.CreateIdempotent(ctx, trackID, creatorBucket, key, token)
}

func (s *StationService) CreateIdempotent(
	ctx context.Context, trackID, creatorBucket, idempotencyKey, ownerToken string,
) (string, string, float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if trackID == "" && len(s.catalog.Tracks) > 0 {
		trackID = s.catalog.Tracks[0].ID
	}
	if s.catalog.ByID[trackID] == nil {
		return "", "", 0, fmt.Errorf("%w: unknown track", ErrInvalidCommand)
	}
	if !validCreateSecret(idempotencyKey, 32, 128) ||
		!validCreateSecret(ownerToken, 48, 48) {
		return "", "", 0, fmt.Errorf(
			"%w: idempotency_key and owner_token must be bounded lowercase hex",
			ErrInvalidCommand)
	}
	now := s.logicalNow()
	if err := validateStationWriteTime(now, true); err != nil {
		return "", "", 0, err
	}
	if err := s.deleteExpired(ctx, now); err != nil {
		return "", "", 0, err
	}
	ownerHash := tokenHash(ownerToken)
	keyHash := tokenHash(idempotencyKey)
	var existingID, existingOwnerHash string
	var existingExpires float64
	err := s.db.QueryRowContext(ctx, `
select k.station_id, k.owner_hash, s.expires_at
from station_creation_keys k join stations s on s.id=k.station_id
where k.key_hash=?`, keyHash).Scan(&existingID, &existingOwnerHash, &existingExpires)
	if err == nil {
		if subtle.ConstantTimeCompare([]byte(existingOwnerHash), []byte(ownerHash)) != 1 {
			return "", "", 0, fmt.Errorf("%w: idempotency key was reused", ErrInvalidCommand)
		}
		return existingID, ownerToken, existingExpires, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", 0, err
	}
	id, err := randomHex(16)
	if err != nil {
		return "", "", 0, err
	}
	var count int
	if err := s.db.QueryRowContext(ctx, "select count(*) from stations where kind='temporary'").Scan(&count); err != nil {
		return "", "", 0, err
	}
	if count >= maxTempStations {
		return "", "", 0, ErrCapacity
	}
	if creatorBucket == "" {
		return "", "", 0, fmt.Errorf("%w: creator identity is required", ErrInvalidCommand)
	}
	if err := s.db.QueryRowContext(ctx, `
select count(*) from stations where kind='temporary' and creator_bucket=?`,
		creatorBucket).Scan(&count); err != nil {
		return "", "", 0, err
	}
	if count >= maxCreatorStations {
		return "", "", 0, ErrCapacity
	}
	expires := now + tempStationLife.Seconds()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", 0, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
insert into stations
	(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	 created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket)
values (?, 'temporary', ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, 1, ?)`,
		id, ownerHash, trackID, now, now, now, expires, creatorBucket)
	if err != nil && strings.Contains(err.Error(), "temporary station capacity reached") {
		err = ErrCapacity
	}
	if err != nil {
		return "", "", 0, err
	}
	if _, err := tx.ExecContext(ctx, `
insert into station_creation_keys(key_hash, station_id, owner_hash, created_at)
values (?, ?, ?, ?)`, keyHash, id, ownerHash, now); err != nil {
		return "", "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", "", 0, err
	}
	return id, ownerToken, expires, nil
}

func validCreateSecret(value string, minimum, maximum int) bool {
	if len(value) < minimum || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character < '0' || (character > '9' && character < 'a') || character > 'f' {
			return false
		}
	}
	return true
}

func (s *StationService) Execute(ctx context.Context, command Command) (Snapshot, error) {
	if !validStationID(normalizedStationID(command.StationID)) {
		return Snapshot{}, ErrInvalidCommand
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.logicalNow()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Snapshot{}, err
	}
	row, err := readStation(ctx, tx, normalizedStationID(command.StationID), now)
	if err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if !canControl(row, command.OwnerToken) {
		_ = tx.Rollback()
		return Snapshot{}, ErrForbidden
	}
	if err := validateStationWriteTime(now, row.Kind == "temporary"); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if _, err := s.normalizeElapsed(&row, now); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if err := s.applyCommand(ctx, tx, &row, command, now); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	row.UpdatedAt = now
	if row.Playing && row.Position >= s.duration(row.TrackID) {
		if _, err := s.normalizeElapsed(&row, now); err != nil {
			_ = tx.Rollback()
			return Snapshot{}, err
		}
	}
	if err := incrementStationRevision(&row); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	row.UpdatedAt = now
	if row.Kind == "temporary" {
		expires := now + tempStationLife.Seconds()
		row.ExpiresAt = &expires
	}
	if err := updateStation(ctx, tx, row); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	snapshot, err := s.snapshot(ctx, tx, row, now)
	if err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return Snapshot{}, err
	}
	s.events.PublishValue(snapshot.StationID, snapshot)
	return snapshot, nil
}

func (s *StationService) Advance(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.logicalNow()
	if err := validateStationWriteTime(now, false); err != nil {
		return err
	}
	if err := s.deleteExpired(ctx, now); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `
select id from stations
where playing=1 and (kind='shared' or expires_at>?)`, now)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		snapshot, changed, err := s.advanceOne(ctx, id, now)
		if err != nil {
			return err
		}
		if changed {
			s.events.PublishValue(snapshot.StationID, snapshot)
		}
	}
	return nil
}

func (s *StationService) logicalNow() float64 {
	raw := unixTime(s.clock())
	sample := s.monotonic()
	s.clockMu.Lock()
	defer s.clockMu.Unlock()
	if elapsed := sample.Sub(s.clockSample).Seconds(); elapsed >= 0.001 {
		s.clockHigh += elapsed
	}
	if sample.After(s.clockSample) {
		s.clockSample = sample
	}
	if raw > s.clockHigh {
		s.clockHigh = raw
	}
	if s.clockHigh > maxRetainedTimestamp {
		s.clockHigh = maxRetainedTimestamp
	}
	return s.clockHigh
}

func (s *StationService) persistLogicalClock(ctx context.Context) error {
	s.clockMu.Lock()
	high := s.clockHigh
	s.clockMu.Unlock()
	if math.IsNaN(high) || math.IsInf(high, 0) || high < 0 || high > maxRetainedTimestamp {
		return errors.New("logical clock high-water mark is invalid")
	}
	value := strconv.FormatFloat(high, 'f', 6, 64)
	_, err := s.db.ExecContext(ctx, `
insert into app_metadata(key, value) values ('logical_clock_high', ?)
on conflict(key) do update set value=excluded.value
where cast(app_metadata.value as real)<cast(excluded.value as real)`, value)
	return err
}

func validateStationWriteTime(now float64, extendsTemporary bool) error {
	limit := maxRetainedTimestamp
	if extendsTemporary {
		limit -= tempStationLife.Seconds()
	}
	if math.IsNaN(now) || math.IsInf(now, 0) || now < 0 || now > limit {
		return errors.New("station clock has no safe retained timestamp headroom")
	}
	return nil
}

func (s *StationService) reconcileCatalogStatistics(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"likes", "skip_counts"} {
		rows, err := tx.QueryContext(ctx, "select track_id from "+table)
		if err != nil {
			return err
		}
		var stale []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			if s.catalog.ByID[id] == nil {
				stale = append(stale, id)
			}
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range stale {
			if _, err := tx.ExecContext(ctx,
				"delete from "+table+" where track_id=?", id); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (s *StationService) deleteExpired(ctx context.Context, now float64) error {
	rows, err := s.db.QueryContext(ctx,
		"select id from stations where kind='temporary' and expires_at<=?", now)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		"delete from stations where kind='temporary' and expires_at<=?", now); err != nil {
		return err
	}
	for _, id := range ids {
		s.events.PublishValue(id, map[string]any{"expired": true})
		s.events.Forget(id)
	}
	return nil
}

func (s *StationService) advanceOne(ctx context.Context, id string, now float64) (Snapshot, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Snapshot{}, false, err
	}
	row, err := readStation(ctx, tx, id, now)
	if err != nil {
		_ = tx.Rollback()
		if errors.Is(err, sql.ErrNoRows) {
			return Snapshot{}, false, nil
		}
		return Snapshot{}, false, err
	}
	changed, err := s.normalizeElapsed(&row, now)
	if err != nil {
		_ = tx.Rollback()
		return Snapshot{}, false, err
	}
	if !changed {
		_ = tx.Rollback()
		return Snapshot{}, false, nil
	}
	if err := incrementStationRevision(&row); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, false, err
	}
	if err := updateStation(ctx, tx, row); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, false, err
	}
	snapshot, err := s.snapshot(ctx, tx, row, now)
	if err != nil {
		_ = tx.Rollback()
		return Snapshot{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Snapshot{}, false, err
	}
	return snapshot, true, nil
}

func incrementStationRevision(row *Station) error {
	if row.Revision < 1 || row.Revision >= maxRevisionValue-3 {
		return errors.New("station revision has no safe increment headroom")
	}
	row.Revision++
	return nil
}

func (s *StationService) normalizeElapsed(row *Station, now float64) (bool, error) {
	duration := s.duration(row.TrackID)
	elapsed := row.Position + math.Max(0, now-row.UpdatedAt)
	if !row.Playing || duration <= 0 || elapsed < duration {
		return false, nil
	}
	if row.RepeatOne {
		row.Position = math.Mod(elapsed, duration)
		row.TrackChangedAt = now - row.Position
	} else {
		if !row.Shuffle {
			var cycle float64
			for _, track := range s.catalog.Tracks {
				cycle += asFloat(track.Duration)
			}
			if cycle > 0 && elapsed >= cycle {
				elapsed = math.Mod(elapsed, cycle)
			}
		}
		steps := 0
		for elapsed >= duration {
			previous := elapsed
			elapsed -= duration
			if elapsed >= previous {
				return false, errors.New("station normalization made no progress")
			}
			row.TrackID = s.nextTrack(*row, 1)
			duration = s.duration(row.TrackID)
			if duration < minTrackDuration || math.IsNaN(duration) || math.IsInf(duration, 0) {
				return false, errors.New("catalog contains a track with invalid duration")
			}
			steps++
			if row.Shuffle && steps >= maxShuffleCatchUpSteps {
				// Unobserved shuffle history has no deterministic sequence worth
				// replaying. Collapse very old state to one bounded random choice.
				row.TrackID = s.randomTrack(row.TrackID)
				duration = s.duration(row.TrackID)
				elapsed = math.Mod(elapsed, duration)
				break
			}
			if steps >= maxNormalizeSteps {
				// A shuffled station can have an arbitrarily old timestamp and
				// therefore no deterministic cycle to skip. Keep the operation
				// bounded while still landing on a playable track.
				elapsed = math.Mod(elapsed, duration)
				break
			}
		}
		row.Position = elapsed
		row.TrackChangedAt = now - elapsed
	}
	row.UpdatedAt = now
	return true, nil
}

func (s *StationService) applyCommand(ctx context.Context, tx *sql.Tx, row *Station, command Command, now float64) error {
	current := stationPosition(*row, now, s.duration(row.TrackID))
	clamp := func(value float64) float64 {
		value = math.Max(0, value)
		if duration := s.duration(row.TrackID); duration > 0 {
			value = math.Min(value, duration)
		}
		return value
	}
	switch command.Action {
	case "play":
		row.Playing, row.Position = true, clamp(current)
	case "pause":
		row.Playing, row.Position = false, clamp(current)
	case "seek":
		if command.Position == nil {
			return fmt.Errorf("%w: position is required", ErrInvalidCommand)
		}
		row.Position = clamp(*command.Position)
	case "relative_seek":
		if command.Position == nil {
			return fmt.Errorf("%w: position is required", ErrInvalidCommand)
		}
		row.Position = clamp(current + *command.Position)
	case "select":
		if command.TrackID == "" {
			return fmt.Errorf("%w: track_id is required", ErrInvalidCommand)
		}
		return s.changeTrack(ctx, tx, row, command.TrackID, now)
	case "next":
		if err := s.recordEarly(ctx, tx, *row, now); err != nil {
			return err
		}
		return s.setTrack(row, s.nextTrack(*row, 1), now)
	case "prev":
		if err := s.recordEarly(ctx, tx, *row, now); err != nil {
			return err
		}
		return s.setTrack(row, s.orderedTrack(row.TrackID, -1), now)
	case "random":
		if err := s.recordEarly(ctx, tx, *row, now); err != nil {
			return err
		}
		return s.setTrack(row, s.randomTrack(row.TrackID), now)
	case "set_repeat_one":
		if command.RepeatOne == nil {
			return fmt.Errorf("%w: repeat_one is required", ErrInvalidCommand)
		}
		row.Position = clamp(current)
		row.RepeatOne = *command.RepeatOne
	case "set_shuffle":
		if command.Shuffle == nil {
			return fmt.Errorf("%w: shuffle is required", ErrInvalidCommand)
		}
		row.Position = clamp(current)
		row.Shuffle = *command.Shuffle
	default:
		return fmt.Errorf("%w: unsupported action", ErrInvalidCommand)
	}
	return nil
}

func (s *StationService) changeTrack(ctx context.Context, tx *sql.Tx, row *Station, trackID string, now float64) error {
	if trackID != row.TrackID {
		if err := s.recordEarly(ctx, tx, *row, now); err != nil {
			return err
		}
	}
	return s.setTrack(row, trackID, now)
}

func (s *StationService) setTrack(row *Station, trackID string, now float64) error {
	if s.catalog.ByID[trackID] == nil {
		return fmt.Errorf("%w: unknown track", ErrInvalidCommand)
	}
	row.TrackID, row.Position, row.TrackChangedAt = trackID, 0, now
	return nil
}

func (s *StationService) recordEarly(ctx context.Context, tx *sql.Tx, row Station, now float64) error {
	duration := s.duration(row.TrackID)
	elapsed := stationPosition(row, now, duration)
	if row.ID != mainStationID || elapsed >= duration || elapsed > earlySkipSeconds {
		return nil
	}
	result, err := tx.ExecContext(ctx, `
insert into skip_counts(track_id, skip_count) values (?, 1)
on conflict(track_id) do update set skip_count=skip_count+1
where skip_count<?`, row.TrackID, maxRevisionValue-3)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return errors.New("skip count has no safe increment headroom")
	}
	result, err = tx.ExecContext(ctx, `
update app_metadata
set value=cast(value as integer)+1
where key='track_stats_revision' and cast(value as integer)<?`,
		maxRevisionValue-3)
	if err != nil {
		return err
	}
	changed, err = result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return errors.New("track-stat revision has no safe increment headroom")
	}
	return nil
}

func (s *StationService) nextTrack(row Station, delta int) string {
	if delta > 0 && row.Shuffle {
		return s.randomTrack(row.TrackID)
	}
	return s.orderedTrack(row.TrackID, delta)
}

func (s *StationService) randomTrack(current string) string {
	if len(s.catalog.Tracks) < 2 {
		return current
	}
	currentIndex, found := s.catalog.IndexByID[current]
	if !found {
		return s.catalog.Tracks[s.randomIndex(len(s.catalog.Tracks))].ID
	}
	index := s.randomIndex(len(s.catalog.Tracks) - 1)
	if index >= currentIndex {
		index++
	}
	return s.catalog.Tracks[index].ID
}

func (s *StationService) orderedTrack(current string, delta int) string {
	if len(s.catalog.Tracks) == 0 {
		return current
	}
	index := s.catalog.IndexByID[current]
	return s.catalog.Tracks[(index+delta+len(s.catalog.Tracks))%len(s.catalog.Tracks)].ID
}

func (s *StationService) duration(trackID string) float64 {
	if track := s.catalog.ByID[trackID]; track != nil {
		return asFloat(track.Duration)
	}
	return 0
}

func (s *StationService) snapshot(ctx context.Context, q queryer, row Station, now float64) (Snapshot, error) {
	var liked, skipCount int
	if err := q.QueryRowContext(ctx, "select coalesce((select liked from likes where track_id=?), 0)", row.TrackID).Scan(&liked); err != nil {
		return Snapshot{}, err
	}
	if err := q.QueryRowContext(ctx, "select coalesce((select skip_count from skip_counts where track_id=?), 0)", row.TrackID).Scan(&skipCount); err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		StationID: row.ID, CatalogRevision: s.catalog.Revision,
		Kind: row.Kind, TrackID: row.TrackID,
		Position: stationPosition(row, now, s.duration(row.TrackID)), Playing: row.Playing,
		RepeatOne: row.RepeatOne, Shuffle: row.Shuffle, UpdatedAt: row.UpdatedAt,
		TrackChangedAt: row.TrackChangedAt, ServerTime: now, Liked: liked != 0,
		SkipCount: skipCount, ExpiresAt: row.ExpiresAt, Revision: row.Revision,
	}, nil
}

func stationPosition(row Station, now, duration float64) float64 {
	position := row.Position
	if row.Playing {
		position += math.Max(0, now-row.UpdatedAt)
	}
	position = math.Max(0, position)
	if duration > 0 {
		position = math.Min(position, duration)
	}
	return position
}

func normalizedStationID(id string) string {
	if id == "" {
		return mainStationID
	}
	return id
}

func validStationID(id string) bool {
	return id == mainStationID || temporaryStationIDPattern.MatchString(id)
}

var (
	ErrForbidden      = stationmodel.ErrForbidden
	ErrCapacity       = stationmodel.ErrCapacity
	ErrInvalidCommand = stationmodel.ErrInvalidCommand
)

func canControl(row Station, token string) bool {
	if row.Kind == "shared" {
		return true
	}
	if token == "" || row.OwnerHash == "" {
		return false
	}
	got, want := sha256.Sum256([]byte(token)), []byte(row.OwnerHash)
	decoded := make([]byte, hex.DecodedLen(len(want)))
	n, err := hex.Decode(decoded, want)
	return err == nil && n == len(got) && subtle.ConstantTimeCompare(got[:], decoded[:n]) == 1
}

func randomHex(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func unixTime(value time.Time) float64 {
	return float64(value.UnixNano()) / 1e9
}

func expiryFrom(now float64) float64 {
	return now + tempStationLife.Seconds()
}
