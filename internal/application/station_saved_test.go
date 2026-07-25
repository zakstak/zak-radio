package application

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSavedStationCRUDPersistsPastPrivateExpiry(t *testing.T) {
	app := newTestApp(t)
	cfg := app.cfg
	definition, token, err := app.station.CreateSavedIdempotent(
		context.Background(),
		SavedStationInput{
			Name: "Hand picked", SourceType: "list", RandomMode: "deck",
			TrackIDs: []string{"one"},
		},
		strings.Repeat("a", 64), strings.Repeat("b", 32), strings.Repeat("c", 48),
	)
	if err != nil {
		t.Fatal(err)
	}
	if definition.SourceType != "list" || len(definition.TrackIDs) != 1 {
		t.Fatalf("created definition = %#v", definition)
	}
	if _, err := app.db.Exec(
		"update stations set expires_at=0 where id=?", definition.StationID); err != nil {
		t.Fatal(err)
	}
	app.Close()

	reopened, err := NewApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	snapshot, err := reopened.station.Snapshot(context.Background(), definition.StationID)
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.Saved || snapshot.StationName != "Hand picked" ||
		snapshot.ExpiresAt != nil {
		t.Fatalf("persistent snapshot = %#v", snapshot)
	}
	newName := "Road trip"
	addTrack := "two"
	updated, err := reopened.station.UpdateSaved(
		context.Background(), definition.StationID, token,
		SavedStationUpdate{Name: &newName, AddTrackID: addTrack},
	)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != newName || len(updated.TrackIDs) != 2 {
		t.Fatalf("updated definition = %#v", updated)
	}
	if _, err := reopened.station.UpdateSaved(
		context.Background(), definition.StationID, strings.Repeat("d", 48),
		SavedStationUpdate{Name: &newName},
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("listener update error = %v, want forbidden", err)
	}
	if err := reopened.station.DeleteSaved(
		context.Background(), definition.StationID, token); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.station.Snapshot(
		context.Background(), definition.StationID); err == nil {
		t.Fatal("deleted station remained readable")
	}
}

func TestRadioRandomModesAndDislikedFilter(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(`
insert into likes(track_id, liked, disliked, updated_at) values ('two', 0, 1, 1)
on conflict(track_id) do update set disliked=1`); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.station.Snapshot(context.Background(), mainStationID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Eligible != 2 || snapshot.SkipDisliked {
		t.Fatalf("default All songs eligibility = %#v", snapshot)
	}
	skip := true
	snapshot, err = app.station.Execute(context.Background(), Command{
		Action: "set_station_skip_disliked", SkipDisliked: &skip,
	})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Eligible != 1 || !snapshot.SkipDisliked {
		t.Fatalf("filtered eligibility = %#v", snapshot)
	}

	skip = false
	if _, err := app.station.Execute(context.Background(), Command{
		Action: "set_station_skip_disliked", SkipDisliked: &skip,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.station.Execute(context.Background(), Command{
		Action: "select", TrackID: "one",
	}); err != nil {
		t.Fatal(err)
	}
	app.station.randomIndex = func(int) int { return 0 }
	snapshot, err = app.station.Execute(context.Background(), Command{
		Action: "set_station_random_mode", RandomMode: "true_random",
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err = app.station.Execute(context.Background(), Command{Action: "next"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != "one" || snapshot.Remaining != 0 {
		t.Fatalf("true random did not permit a repeat: %#v", snapshot)
	}

	snapshot, err = app.station.Execute(context.Background(), Command{
		Action: "set_station_random_mode", RandomMode: "deck",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.UpNext) != 1 || snapshot.UpNext[0] == snapshot.TrackID {
		t.Fatalf("deck preview = %#v", snapshot)
	}
	next := snapshot.UpNext[0]
	snapshot, err = app.station.Execute(context.Background(), Command{Action: "next"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TrackID != next {
		t.Fatalf("deck next = %q, want %q", snapshot.TrackID, next)
	}
}

func TestSavedFilterAndListEligibility(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.db.Exec(`
insert into likes(track_id, liked, disliked, updated_at) values ('two', 1, 0, 1)
on conflict(track_id) do update set liked=1`); err != nil {
		t.Fatal(err)
	}
	filtered, _, err := app.station.CreateSavedIdempotent(
		context.Background(),
		SavedStationInput{
			Name: "Liked", SourceType: "filter", FilterMode: "liked",
			RandomMode: "deck",
		},
		strings.Repeat("1", 64), strings.Repeat("2", 32), strings.Repeat("3", 48),
	)
	if err != nil {
		t.Fatal(err)
	}
	listed, _, err := app.station.CreateSavedIdempotent(
		context.Background(),
		SavedStationInput{
			Name: "One only", SourceType: "list", RandomMode: "deck",
			TrackIDs: []string{"one"},
		},
		strings.Repeat("4", 64), strings.Repeat("5", 32), strings.Repeat("6", 48),
	)
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{
		filtered.StationID: "two",
		listed.StationID:   "one",
	} {
		snapshot, err := app.station.Snapshot(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot.Eligible != 1 || snapshot.TrackID != want {
			t.Fatalf("station %s snapshot = %#v, want %s", id, snapshot, want)
		}
	}
}
