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

	stationmodel "zak-radio/internal/station"
)

var temporaryStationIDPattern = regexp.MustCompile(`^[a-f0-9]{12}(?:[a-f0-9]{20})?$`)

const (
	mainStationID          = "main"
	tempStationLife        = 24 * time.Hour
	earlySkipSeconds       = 6.0
	maxTempStations        = 100
	maxCreatorStations     = 5
	maxStationQueue        = 100
	stationUpcomingPreview = 100
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
type StationDefinition = stationmodel.Definition
type Clock = stationmodel.Clock
type RandomIndex = stationmodel.RandomIndex

type SavedStationInput struct {
	Name         string
	SourceType   string
	FilterMode   string
	FilterQuery  string
	RandomMode   string
	SkipDisliked bool
	TrackIDs     []string
}

type SavedStationUpdate struct {
	Name          *string
	SourceType    *string
	FilterMode    *string
	FilterQuery   *string
	RandomMode    *string
	SkipDisliked  *bool
	TrackIDs      *[]string
	AddTrackID    string
	RemoveTrackID string
}

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
values (?, 'shared', '', ?, 0, 0, 0, 1, ?, ?, ?, null, 1)
on conflict(id) do nothing`, mainStationID, s.catalog.Tracks[0].ID, now, now, now); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
update stations
set repeat_one=0, shuffle=1, revision=revision+1
where id=? and (repeat_one<>0 or shuffle<>1) and revision<?`,
		mainStationID, maxRevisionValue-3); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		"delete from station_queue where station_id=?", mainStationID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
insert into station_definitions
	(station_id, name, source_type, filter_mode, filter_query, random_mode,
	 skip_disliked, created_at, updated_at)
values (?, 'All songs', 'filter', 'all', '', 'deck', 0, ?, ?)
on conflict(station_id) do nothing`, mainStationID, now, now); err != nil {
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
	if err := s.reconcileCatalogStatistics(ctx); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	row, err := readStation(ctx, tx, mainStationID, now)
	if err != nil {
		return err
	}
	definition, err := readStationDefinition(ctx, tx, mainStationID)
	if err != nil {
		return err
	}
	if err := s.ensureStationRotation(ctx, tx, row, definition); err != nil {
		return err
	}
	return tx.Commit()
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
	defer func() { _ = tx.Rollback() }()
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

func (s *StationService) CreateSavedIdempotent(
	ctx context.Context, input SavedStationInput, creatorBucket, idempotencyKey,
	ownerToken string,
) (StationDefinition, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	input, err := s.validateSavedStationInput(input)
	if err != nil {
		return StationDefinition{}, "", err
	}
	if !validCreateSecret(idempotencyKey, 32, 128) ||
		!validCreateSecret(ownerToken, 48, 48) {
		return StationDefinition{}, "", fmt.Errorf(
			"%w: idempotency_key and owner_token must be bounded lowercase hex",
			ErrInvalidCommand)
	}
	if creatorBucket == "" {
		return StationDefinition{}, "", fmt.Errorf(
			"%w: creator identity is required", ErrInvalidCommand)
	}
	now := s.logicalNow()
	if err := validateStationWriteTime(now, true); err != nil {
		return StationDefinition{}, "", err
	}
	if err := s.deleteExpired(ctx, now); err != nil {
		return StationDefinition{}, "", err
	}
	ownerHash := tokenHash(ownerToken)
	keyHash := tokenHash(idempotencyKey)
	var existingID, existingOwnerHash string
	err = s.db.QueryRowContext(ctx, `
select k.station_id, k.owner_hash
from station_creation_keys k join stations s on s.id=k.station_id
where k.key_hash=?`, keyHash).Scan(&existingID, &existingOwnerHash)
	if err == nil {
		if subtle.ConstantTimeCompare([]byte(existingOwnerHash), []byte(ownerHash)) != 1 {
			return StationDefinition{}, "", fmt.Errorf(
				"%w: idempotency key was reused", ErrInvalidCommand)
		}
		definition, readErr := readStationDefinition(ctx, s.db, existingID)
		return definition, ownerToken, readErr
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return StationDefinition{}, "", err
	}
	var count int
	if err := s.db.QueryRowContext(ctx,
		"select count(*) from stations where kind='temporary'").Scan(&count); err != nil {
		return StationDefinition{}, "", err
	}
	if count >= maxTempStations {
		return StationDefinition{}, "", ErrCapacity
	}
	if err := s.db.QueryRowContext(ctx, `
select count(*) from stations where kind='temporary' and creator_bucket=?`,
		creatorBucket).Scan(&count); err != nil {
		return StationDefinition{}, "", err
	}
	if count >= maxCreatorStations {
		return StationDefinition{}, "", ErrCapacity
	}
	id, err := randomHex(16)
	if err != nil {
		return StationDefinition{}, "", err
	}
	trackID := s.catalog.Tracks[0].ID
	if eligible, eligibleErr := s.eligibleTracksForInput(ctx, s.db, input); eligibleErr != nil {
		return StationDefinition{}, "", eligibleErr
	} else if len(eligible) > 0 {
		trackID = eligible[0]
	}
	expires := now + tempStationLife.Seconds()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StationDefinition{}, "", err
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `
insert into stations
	(id, kind, owner_hash, track_id, position, playing, repeat_one, shuffle,
	 created_at, updated_at, track_changed_at, expires_at, revision, creator_bucket)
values (?, 'temporary', ?, ?, 0, 0, 0, 1, ?, ?, ?, ?, 1, ?)`,
		id, ownerHash, trackID, now, now, now, expires, creatorBucket)
	if err != nil && strings.Contains(err.Error(), "temporary station capacity reached") {
		err = ErrCapacity
	}
	if err != nil {
		return StationDefinition{}, "", err
	}
	if _, err := tx.ExecContext(ctx, `
insert into station_creation_keys(key_hash, station_id, owner_hash, created_at)
values (?, ?, ?, ?)`, keyHash, id, ownerHash, now); err != nil {
		return StationDefinition{}, "", err
	}
	if err := insertStationDefinition(ctx, tx, id, input, now); err != nil {
		return StationDefinition{}, "", err
	}
	if err := replaceStationTracks(ctx, tx, id, input.TrackIDs); err != nil {
		return StationDefinition{}, "", err
	}
	row, err := readStation(ctx, tx, id, now)
	if err != nil {
		return StationDefinition{}, "", err
	}
	definition, err := readStationDefinition(ctx, tx, id)
	if err != nil {
		return StationDefinition{}, "", err
	}
	if err := s.ensureStationRotation(ctx, tx, row, definition); err != nil {
		return StationDefinition{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return StationDefinition{}, "", err
	}
	return definition, ownerToken, nil
}

func (s *StationService) ListSaved(ctx context.Context) ([]StationDefinition, error) {
	rows, err := s.db.QueryContext(ctx, `
select station_id from station_definitions
order by case when station_id='main' then 0 else 1 end, lower(name), station_id`)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	definitions := make([]StationDefinition, 0, len(ids))
	for _, id := range ids {
		definition, err := readStationDefinition(ctx, s.db, id)
		if err != nil {
			return nil, err
		}
		var remaining int
		if err := s.db.QueryRowContext(ctx,
			"select count(*) from station_rotation where station_id=?", id).
			Scan(&remaining); err != nil {
			return nil, err
		}
		eligible, err := s.eligibleStationTracks(ctx, s.db, definition)
		if err != nil {
			return nil, err
		}
		definition.BuiltIn = id == mainStationID
		definition.EligibleCount = len(eligible)
		definition.RemainingCount = remaining
		definitions = append(definitions, definition)
	}
	return definitions, nil
}

func (s *StationService) UpdateSaved(
	ctx context.Context, stationID, ownerToken string, update SavedStationUpdate,
) (StationDefinition, error) {
	stationID = normalizedStationID(stationID)
	if !validStationID(stationID) || stationID == mainStationID {
		return StationDefinition{}, ErrForbidden
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.logicalNow()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StationDefinition{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	row, err := readStation(ctx, tx, stationID, now)
	if err != nil {
		return StationDefinition{}, err
	}
	if !row.Saved {
		return StationDefinition{}, sql.ErrNoRows
	}
	if !canControl(row, ownerToken) {
		return StationDefinition{}, ErrForbidden
	}
	definition, err := readStationDefinition(ctx, tx, stationID)
	if err != nil {
		return StationDefinition{}, err
	}
	input := SavedStationInput{
		Name: definition.Name, SourceType: definition.SourceType,
		FilterMode: definition.FilterMode, FilterQuery: definition.FilterQuery,
		RandomMode: definition.RandomMode, SkipDisliked: definition.SkipDisliked,
		TrackIDs: append([]string(nil), definition.TrackIDs...),
	}
	if update.Name != nil {
		input.Name = *update.Name
	}
	if update.SourceType != nil {
		input.SourceType = *update.SourceType
	}
	if update.FilterMode != nil {
		input.FilterMode = *update.FilterMode
	}
	if update.FilterQuery != nil {
		input.FilterQuery = *update.FilterQuery
	}
	if update.RandomMode != nil {
		input.RandomMode = *update.RandomMode
	}
	if update.SkipDisliked != nil {
		input.SkipDisliked = *update.SkipDisliked
	}
	if update.TrackIDs != nil {
		input.TrackIDs = append([]string(nil), (*update.TrackIDs)...)
	}
	if update.AddTrackID != "" {
		input.SourceType, input.FilterMode, input.FilterQuery = "list", "all", ""
		input.TrackIDs = append(input.TrackIDs, update.AddTrackID)
	}
	if update.RemoveTrackID != "" {
		filtered := input.TrackIDs[:0]
		for _, trackID := range input.TrackIDs {
			if trackID != update.RemoveTrackID {
				filtered = append(filtered, trackID)
			}
		}
		input.TrackIDs = filtered
	}
	input, err = s.validateSavedStationInput(input)
	if err != nil {
		return StationDefinition{}, err
	}
	if _, err := tx.ExecContext(ctx, `
update station_definitions set
	name=?, source_type=?, filter_mode=?, filter_query=?, random_mode=?,
	skip_disliked=?, updated_at=?
where station_id=?`,
		input.Name, input.SourceType, input.FilterMode, input.FilterQuery,
		input.RandomMode, boolInt(input.SkipDisliked), now, stationID); err != nil {
		return StationDefinition{}, err
	}
	if err := replaceStationTracks(ctx, tx, stationID, input.TrackIDs); err != nil {
		return StationDefinition{}, err
	}
	if err := s.replaceStationRotation(ctx, tx, stationID, nil); err != nil {
		return StationDefinition{}, err
	}
	definition, err = readStationDefinition(ctx, tx, stationID)
	if err != nil {
		return StationDefinition{}, err
	}
	eligible, err := s.eligibleStationTracks(ctx, tx, definition)
	if err != nil {
		return StationDefinition{}, err
	}
	if len(eligible) > 0 && !containsTrack(eligible, row.TrackID) {
		if err := s.setTrack(&row, eligible[0], now); err != nil {
			return StationDefinition{}, err
		}
	}
	if err := s.ensureStationRotation(ctx, tx, row, definition); err != nil {
		return StationDefinition{}, err
	}
	if err := incrementStationRevision(&row); err != nil {
		return StationDefinition{}, err
	}
	row.UpdatedAt = now
	if err := updateStation(ctx, tx, row); err != nil {
		return StationDefinition{}, err
	}
	snapshot, err := s.snapshot(ctx, tx, row, now)
	if err != nil {
		return StationDefinition{}, err
	}
	if err := tx.Commit(); err != nil {
		return StationDefinition{}, err
	}
	s.events.PublishValue(stationID, snapshot)
	return definition, nil
}

func (s *StationService) DeleteSaved(
	ctx context.Context, stationID, ownerToken string,
) error {
	stationID = normalizedStationID(stationID)
	if !validStationID(stationID) || stationID == mainStationID {
		return ErrForbidden
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.logicalNow()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	row, err := readStation(ctx, tx, stationID, now)
	if err != nil {
		return err
	}
	if !row.Saved {
		return sql.ErrNoRows
	}
	if !canControl(row, ownerToken) {
		return ErrForbidden
	}
	if _, err := tx.ExecContext(ctx, "delete from stations where id=?", stationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.events.PublishValue(stationID, map[string]any{"expired": true})
	s.events.Forget(stationID)
	return nil
}

func (s *StationService) validateSavedStationInput(
	input SavedStationInput,
) (SavedStationInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.FilterQuery = strings.TrimSpace(input.FilterQuery)
	if input.Name == "" || len([]byte(input.Name)) > 80 ||
		strings.ContainsRune(input.Name, 0) {
		return SavedStationInput{}, fmt.Errorf(
			"%w: station name must be 1 to 80 characters", ErrInvalidCommand)
	}
	if input.SourceType != "filter" && input.SourceType != "list" {
		return SavedStationInput{}, fmt.Errorf(
			"%w: source_type must be filter or list", ErrInvalidCommand)
	}
	if input.RandomMode == "" {
		input.RandomMode = "deck"
	}
	if input.RandomMode != "true_random" && input.RandomMode != "deck" {
		return SavedStationInput{}, fmt.Errorf(
			"%w: random_mode must be true_random or deck", ErrInvalidCommand)
	}
	if input.SourceType == "list" {
		input.FilterMode, input.FilterQuery = "all", ""
	} else {
		if input.FilterMode == "" {
			input.FilterMode = "all"
		}
		if input.FilterMode != "all" && input.FilterMode != "liked" &&
			input.FilterMode != "covers" && input.FilterMode != "recent" {
			return SavedStationInput{}, fmt.Errorf(
				"%w: unsupported station filter", ErrInvalidCommand)
		}
		if len([]byte(input.FilterQuery)) > 160 ||
			strings.ContainsRune(input.FilterQuery, 0) {
			return SavedStationInput{}, fmt.Errorf(
				"%w: station search is too long", ErrInvalidCommand)
		}
		input.TrackIDs = nil
	}
	unique := make([]string, 0, len(input.TrackIDs))
	seen := make(map[string]bool, len(input.TrackIDs))
	for _, trackID := range input.TrackIDs {
		if s.catalog.ByID[trackID] == nil {
			return SavedStationInput{}, fmt.Errorf(
				"%w: unknown station track", ErrInvalidCommand)
		}
		if !seen[trackID] {
			seen[trackID] = true
			unique = append(unique, trackID)
		}
	}
	if len(unique) > maxCatalogTracks {
		return SavedStationInput{}, fmt.Errorf(
			"%w: station track list is too large", ErrInvalidCommand)
	}
	input.TrackIDs = unique
	return input, nil
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
	if err := validateStationWriteTime(now, row.Kind == "temporary" && !row.Saved); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if _, err := s.normalizeElapsedWithQueue(ctx, tx, &row, now); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	if err := s.applyCommand(ctx, tx, &row, command, now); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	row.UpdatedAt = now
	if row.Playing && row.Position >= s.duration(row.TrackID) {
		if _, err := s.normalizeElapsedWithQueue(ctx, tx, &row, now); err != nil {
			_ = tx.Rollback()
			return Snapshot{}, err
		}
	}
	if err := incrementStationRevision(&row); err != nil {
		_ = tx.Rollback()
		return Snapshot{}, err
	}
	row.UpdatedAt = now
	if row.Kind == "temporary" && !row.Saved {
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
where playing=1 and (
	kind='shared' or expires_at>? or
	exists (select 1 from station_definitions d where d.station_id=stations.id)
)`, now)
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
	defer func() {
		_ = tx.Rollback()
	}()
	for _, table := range []string{
		"likes", "skip_counts", "station_queue", "station_tracks", "station_rotation",
	} {
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
		`select id from stations where kind='temporary' and expires_at<=?
		 and not exists (
			select 1 from station_definitions d where d.station_id=stations.id
		 )`, now)
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
		`delete from stations where kind='temporary' and expires_at<=?
		 and not exists (
			select 1 from station_definitions d where d.station_id=stations.id
		 )`, now); err != nil {
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
	changed, err := s.normalizeElapsedWithQueue(ctx, tx, &row, now)
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
	return s.normalizeElapsedWithQueue(context.Background(), nil, row, now)
}

func (s *StationService) normalizeElapsedWithQueue(
	ctx context.Context, tx *sql.Tx, row *Station, now float64,
) (bool, error) {
	duration := s.duration(row.TrackID)
	elapsed := row.Position + math.Max(0, now-row.UpdatedAt)
	if !row.Playing || duration <= 0 || elapsed < duration {
		return false, nil
	}
	if row.RepeatOne {
		row.Position = math.Mod(elapsed, duration)
		row.TrackChangedAt = now - row.Position
	} else {
		queueLength := 0
		if tx != nil {
			var err error
			queueLength, err = s.queueLength(ctx, tx, row.ID)
			if err != nil {
				return false, err
			}
		}
		if !row.Shuffle && queueLength == 0 {
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
			next := s.nextTrack(*row, 1)
			if tx != nil {
				var err error
				next, err = s.nextQueuedOrCatalog(ctx, tx, *row)
				if err != nil {
					return false, err
				}
			}
			row.TrackID = next
			duration = s.duration(row.TrackID)
			if duration < minTrackDuration || math.IsNaN(duration) || math.IsInf(duration, 0) {
				return false, errors.New("catalog contains a track with invalid duration")
			}
			steps++
			if row.Shuffle && steps >= maxShuffleCatchUpSteps {
				// Unobserved shuffle history has no useful exact playhead.
				// Bound catch-up while preserving the radio deck already consumed.
				if !row.Saved {
					row.TrackID = s.randomTrack(row.TrackID)
					duration = s.duration(row.TrackID)
				}
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
		next, err := s.nextQueuedOrCatalog(ctx, tx, *row)
		if err != nil {
			return err
		}
		return s.setTrack(row, next, now)
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
	case "play_next":
		if row.Saved {
			return fmt.Errorf("%w: radio does not accept queued tracks", ErrInvalidCommand)
		}
		return s.enqueueTrack(ctx, tx, row.ID, command.TrackID, true)
	case "add_to_queue":
		if row.Saved {
			return fmt.Errorf("%w: radio does not accept queued tracks", ErrInvalidCommand)
		}
		return s.enqueueTrack(ctx, tx, row.ID, command.TrackID, false)
	case "set_station_random_mode":
		if !row.Saved ||
			(command.RandomMode != "true_random" && command.RandomMode != "deck") {
			return fmt.Errorf("%w: station random mode must be true_random or deck",
				ErrInvalidCommand)
		}
		if _, err := tx.ExecContext(ctx, `
update station_definitions set random_mode=?, updated_at=? where station_id=?`,
			command.RandomMode, now, row.ID); err != nil {
			return err
		}
		if err := s.replaceStationRotation(ctx, tx, row.ID, nil); err != nil {
			return err
		}
		definition, err := readStationDefinition(ctx, tx, row.ID)
		if err != nil {
			return err
		}
		eligible, err := s.eligibleStationTracks(ctx, tx, definition)
		if err != nil {
			return err
		}
		if len(eligible) == 0 {
			row.Playing = false
			row.Position = clamp(current)
		} else if !containsTrack(eligible, row.TrackID) {
			if err := s.setTrack(row, eligible[0], now); err != nil {
				return err
			}
		}
		if err := s.ensureStationRotation(ctx, tx, *row, definition); err != nil {
			return err
		}
	case "set_station_skip_disliked":
		if !row.Saved || command.SkipDisliked == nil {
			return fmt.Errorf("%w: station disliked filter is required", ErrInvalidCommand)
		}
		if _, err := tx.ExecContext(ctx, `
update station_definitions set skip_disliked=?, updated_at=? where station_id=?`,
			boolInt(*command.SkipDisliked), now, row.ID); err != nil {
			return err
		}
		if err := s.replaceStationRotation(ctx, tx, row.ID, nil); err != nil {
			return err
		}
		definition, err := readStationDefinition(ctx, tx, row.ID)
		if err != nil {
			return err
		}
		eligible, err := s.eligibleStationTracks(ctx, tx, definition)
		if err != nil {
			return err
		}
		if len(eligible) == 0 {
			row.Playing = false
			row.Position = clamp(current)
		} else if !containsTrack(eligible, row.TrackID) {
			if err := s.setTrack(row, eligible[0], now); err != nil {
				return err
			}
		}
		if err := s.ensureStationRotation(ctx, tx, *row, definition); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: unsupported action", ErrInvalidCommand)
	}
	return nil
}

func (s *StationService) queueLength(
	ctx context.Context, q queryer, stationID string,
) (int, error) {
	var count int
	err := q.QueryRowContext(ctx,
		"select count(*) from station_queue where station_id=?", stationID).Scan(&count)
	return count, err
}

func (s *StationService) queueTracks(
	ctx context.Context, q queryer, stationID string,
) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
select track_id from station_queue where station_id=? order by position`, stationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tracks := make([]string, 0)
	for rows.Next() {
		var trackID string
		if err := rows.Scan(&trackID); err != nil {
			return nil, err
		}
		tracks = append(tracks, trackID)
	}
	return tracks, rows.Err()
}

func (s *StationService) replaceQueue(
	ctx context.Context, tx *sql.Tx, stationID string, tracks []string,
) error {
	if len(tracks) > maxStationQueue {
		return ErrQueueFull
	}
	if _, err := tx.ExecContext(ctx,
		"delete from station_queue where station_id=?", stationID); err != nil {
		return err
	}
	for position, trackID := range tracks {
		if _, err := tx.ExecContext(ctx, `
insert into station_queue(station_id, position, track_id) values (?, ?, ?)`,
			stationID, position, trackID); err != nil {
			return err
		}
	}
	return nil
}

func (s *StationService) enqueueTrack(
	ctx context.Context, tx *sql.Tx, stationID, trackID string, first bool,
) error {
	if s.catalog.ByID[trackID] == nil {
		return fmt.Errorf("%w: unknown track", ErrInvalidCommand)
	}
	tracks, err := s.queueTracks(ctx, tx, stationID)
	if err != nil {
		return err
	}
	if len(tracks) >= maxStationQueue {
		return ErrQueueFull
	}
	if first {
		tracks = append([]string{trackID}, tracks...)
	} else {
		tracks = append(tracks, trackID)
	}
	return s.replaceQueue(ctx, tx, stationID, tracks)
}

func (s *StationService) nextQueuedOrCatalog(
	ctx context.Context, tx *sql.Tx, row Station,
) (string, error) {
	if row.Saved {
		return s.nextStationTrack(ctx, tx, row)
	}
	tracks, err := s.queueTracks(ctx, tx, row.ID)
	if err != nil {
		return "", err
	}
	if len(tracks) == 0 {
		return s.nextTrack(row, 1), nil
	}
	if err := s.replaceQueue(ctx, tx, row.ID, tracks[1:]); err != nil {
		return "", err
	}
	return tracks[0], nil
}

func readStationDefinition(
	ctx context.Context, q queryer, stationID string,
) (StationDefinition, error) {
	var definition StationDefinition
	var skip int
	if err := q.QueryRowContext(ctx, `
select station_id, name, source_type, filter_mode, filter_query, random_mode,
	skip_disliked, created_at, updated_at
from station_definitions where station_id=?`, stationID).Scan(
		&definition.StationID, &definition.Name, &definition.SourceType,
		&definition.FilterMode, &definition.FilterQuery, &definition.RandomMode,
		&skip, &definition.CreatedAt, &definition.UpdatedAt,
	); err != nil {
		return StationDefinition{}, err
	}
	definition.SkipDisliked = skip != 0
	definition.BuiltIn = stationID == mainStationID
	rows, err := q.QueryContext(ctx, `
select track_id from station_tracks where station_id=? order by position`, stationID)
	if err != nil {
		return StationDefinition{}, err
	}
	defer rows.Close()
	definition.TrackIDs = make([]string, 0)
	for rows.Next() {
		var trackID string
		if err := rows.Scan(&trackID); err != nil {
			return StationDefinition{}, err
		}
		definition.TrackIDs = append(definition.TrackIDs, trackID)
	}
	return definition, rows.Err()
}

func insertStationDefinition(
	ctx context.Context, tx *sql.Tx, stationID string, input SavedStationInput,
	now float64,
) error {
	_, err := tx.ExecContext(ctx, `
insert into station_definitions
	(station_id, name, source_type, filter_mode, filter_query, random_mode,
	 skip_disliked, created_at, updated_at)
values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		stationID, input.Name, input.SourceType, input.FilterMode,
		input.FilterQuery, input.RandomMode, boolInt(input.SkipDisliked), now, now)
	return err
}

func replaceStationTracks(
	ctx context.Context, tx *sql.Tx, stationID string, tracks []string,
) error {
	if len(tracks) > maxCatalogTracks {
		return fmt.Errorf("%w: station track list is too large", ErrInvalidCommand)
	}
	if _, err := tx.ExecContext(ctx,
		"delete from station_tracks where station_id=?", stationID); err != nil {
		return err
	}
	for position, trackID := range tracks {
		if _, err := tx.ExecContext(ctx, `
insert into station_tracks(station_id, position, track_id) values (?, ?, ?)`,
			stationID, position, trackID); err != nil {
			return err
		}
	}
	return nil
}

func (s *StationService) eligibleTracksForInput(
	ctx context.Context, q queryer, input SavedStationInput,
) ([]string, error) {
	return s.eligibleStationTracks(ctx, q, StationDefinition{
		SourceType: input.SourceType, FilterMode: input.FilterMode,
		FilterQuery: input.FilterQuery, RandomMode: input.RandomMode,
		SkipDisliked: input.SkipDisliked, TrackIDs: input.TrackIDs,
	})
}

func (s *StationService) eligibleStationTracks(
	ctx context.Context, q queryer, definition StationDefinition,
) ([]string, error) {
	liked, disliked := make(map[string]bool), make(map[string]bool)
	if definition.FilterMode == "liked" || definition.SkipDisliked {
		rows, err := q.QueryContext(ctx,
			"select track_id, liked, disliked from likes where liked>0 or disliked>0")
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var trackID string
			var likeCount, dislikeCount int
			if err := rows.Scan(&trackID, &likeCount, &dislikeCount); err != nil {
				rows.Close()
				return nil, err
			}
			liked[trackID], disliked[trackID] = likeCount > 0, dislikeCount > 0
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	source := definition.TrackIDs
	if definition.SourceType == "filter" {
		source = make([]string, 0, len(s.catalog.Tracks))
		for _, track := range s.catalog.Tracks {
			source = append(source, track.ID)
		}
	}
	newest := time.Time{}
	if definition.SourceType == "filter" && definition.FilterMode == "recent" {
		for _, track := range s.catalog.Tracks {
			if parsed := parseCatalogTime(track.CreatedAt); parsed.After(newest) {
				newest = parsed
			}
		}
	}
	query := strings.ToLower(definition.FilterQuery)
	eligible := make([]string, 0, len(source))
	for _, trackID := range source {
		track := s.catalog.ByID[trackID]
		if track == nil || (definition.SkipDisliked && disliked[trackID]) {
			continue
		}
		switch definition.FilterMode {
		case "liked":
			if !liked[trackID] {
				continue
			}
		case "covers":
			if !track.HasCover {
				continue
			}
		case "recent":
			created := parseCatalogTime(track.CreatedAt)
			if newest.IsZero() || created.IsZero() ||
				created.Before(newest.AddDate(0, 0, -180)) {
				continue
			}
		}
		if query != "" {
			search := strings.ToLower(strings.Join([]string{
				track.Title, track.Artist, track.Source, track.Group,
				track.Summary, track.SearchText,
			}, " "))
			if !strings.Contains(search, query) {
				continue
			}
		}
		eligible = append(eligible, trackID)
	}
	return eligible, nil
}

func parseCatalogTime(value string) time.Time {
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339, "2006-01-02",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

func containsTrack(tracks []string, trackID string) bool {
	for _, candidate := range tracks {
		if candidate == trackID {
			return true
		}
	}
	return false
}

func (s *StationService) stationRotationTracks(
	ctx context.Context, q queryer, stationID string, limit int,
) ([]string, int, error) {
	var remaining int
	if err := q.QueryRowContext(ctx,
		"select count(*) from station_rotation where station_id=?", stationID).
		Scan(&remaining); err != nil {
		return nil, 0, err
	}
	query := "select track_id from station_rotation where station_id=? order by position"
	args := []any{stationID}
	if limit > 0 {
		query += " limit ?"
		args = append(args, limit)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	tracks := make([]string, 0, min(remaining, max(0, limit)))
	for rows.Next() {
		var trackID string
		if err := rows.Scan(&trackID); err != nil {
			return nil, 0, err
		}
		tracks = append(tracks, trackID)
	}
	return tracks, remaining, rows.Err()
}

func (s *StationService) replaceStationRotation(
	ctx context.Context, tx *sql.Tx, stationID string, tracks []string,
) error {
	if len(tracks) > maxCatalogTracks {
		return errors.New("station rotation exceeds catalog capacity")
	}
	if _, err := tx.ExecContext(ctx,
		"delete from station_rotation where station_id=?", stationID); err != nil {
		return err
	}
	for position, trackID := range tracks {
		if _, err := tx.ExecContext(ctx, `
insert into station_rotation(station_id, position, track_id) values (?, ?, ?)`,
			stationID, position, trackID); err != nil {
			return err
		}
	}
	return nil
}

func (s *StationService) shuffledStationTracks(tracks []string) []string {
	shuffled := append([]string(nil), tracks...)
	for index := len(shuffled) - 1; index > 0; index-- {
		swap := s.randomIndex(index + 1)
		shuffled[index], shuffled[swap] = shuffled[swap], shuffled[index]
	}
	return shuffled
}

func (s *StationService) ensureStationRotation(
	ctx context.Context, tx *sql.Tx, row Station, definition StationDefinition,
) error {
	if definition.RandomMode != "deck" {
		return s.replaceStationRotation(ctx, tx, row.ID, nil)
	}
	rotation, _, err := s.stationRotationTracks(ctx, tx, row.ID, 0)
	if err != nil {
		return err
	}
	eligible, err := s.eligibleStationTracks(ctx, tx, definition)
	if err != nil {
		return err
	}
	allowed := make(map[string]bool, len(eligible))
	for _, trackID := range eligible {
		allowed[trackID] = true
	}
	filtered := make([]string, 0, len(rotation))
	for _, trackID := range rotation {
		if allowed[trackID] && trackID != row.TrackID {
			filtered = append(filtered, trackID)
		}
	}
	if len(filtered) == 0 {
		for _, trackID := range eligible {
			if trackID != row.TrackID {
				filtered = append(filtered, trackID)
			}
		}
		filtered = s.shuffledStationTracks(filtered)
	}
	return s.replaceStationRotation(ctx, tx, row.ID, filtered)
}

func (s *StationService) nextStationTrack(
	ctx context.Context, tx *sql.Tx, row Station,
) (string, error) {
	definition, err := readStationDefinition(ctx, tx, row.ID)
	if err != nil {
		return "", err
	}
	eligible, err := s.eligibleStationTracks(ctx, tx, definition)
	if err != nil {
		return "", err
	}
	if len(eligible) == 0 {
		return row.TrackID, nil
	}
	if definition.RandomMode == "true_random" {
		if err := s.replaceStationRotation(ctx, tx, row.ID, nil); err != nil {
			return "", err
		}
		return eligible[s.randomIndex(len(eligible))], nil
	}
	if err := s.ensureStationRotation(ctx, tx, row, definition); err != nil {
		return "", err
	}
	rotation, _, err := s.stationRotationTracks(ctx, tx, row.ID, 0)
	if err != nil {
		return "", err
	}
	if len(rotation) == 0 {
		return row.TrackID, nil
	}
	if err := s.replaceStationRotation(ctx, tx, row.ID, rotation[1:]); err != nil {
		return "", err
	}
	return rotation[0], nil
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
	if !row.Saved || elapsed >= duration || elapsed > earlySkipSeconds {
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
	var liked, disliked, skipCount int
	if err := q.QueryRowContext(ctx, `
select
	coalesce((select liked from likes where track_id=?), 0),
	coalesce((select disliked from likes where track_id=?), 0)`,
		row.TrackID, row.TrackID).Scan(&liked, &disliked); err != nil {
		return Snapshot{}, err
	}
	if err := q.QueryRowContext(ctx, "select coalesce((select skip_count from skip_counts where track_id=?), 0)", row.TrackID).Scan(&skipCount); err != nil {
		return Snapshot{}, err
	}
	queue, err := s.queueTracks(ctx, q, row.ID)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot := Snapshot{
		StationID: row.ID, CatalogRevision: s.catalog.Revision,
		Kind: row.Kind, TrackID: row.TrackID,
		Position: stationPosition(row, now, s.duration(row.TrackID)), Playing: row.Playing,
		RepeatOne: row.RepeatOne, Shuffle: row.Shuffle, UpdatedAt: row.UpdatedAt,
		TrackChangedAt: row.TrackChangedAt, ServerTime: now,
		Liked: liked != 0, Disliked: disliked != 0,
		LikeCount: liked, DislikeCount: disliked,
		SkipCount: skipCount, ExpiresAt: row.ExpiresAt, Revision: row.Revision,
		Queue: queue, Saved: row.Saved,
	}
	if row.Saved {
		snapshot.ExpiresAt = nil
	}
	if row.Saved {
		definition, err := readStationDefinition(ctx, q, row.ID)
		if err != nil {
			return Snapshot{}, err
		}
		eligible, err := s.eligibleStationTracks(ctx, q, definition)
		if err != nil {
			return Snapshot{}, err
		}
		upNext, remaining, err := s.stationRotationTracks(
			ctx, q, row.ID, stationUpcomingPreview)
		if err != nil {
			return Snapshot{}, err
		}
		snapshot.StationName = definition.Name
		snapshot.SourceType = definition.SourceType
		snapshot.FilterMode = definition.FilterMode
		snapshot.FilterQuery = definition.FilterQuery
		snapshot.RandomMode = definition.RandomMode
		snapshot.SkipDisliked = definition.SkipDisliked
		snapshot.UpNext = upNext
		snapshot.Remaining = remaining
		snapshot.Eligible = len(eligible)
	}
	return snapshot, nil
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
	ErrQueueFull      = stationmodel.ErrQueueFull
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
