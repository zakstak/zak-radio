package application

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"testing"

	stationmodel "zak-radio/internal/station"
)

func TestQueueEditsPreserveOrderAndPlayback(t *testing.T) {
	app := newTestApp(t)
	ctx := context.Background()
	id, token, _, err := createTemporaryStationForTest(t, app.station, ctx, "one", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	run := func(action, track string, position *float64) stationmodel.Snapshot {
		t.Helper()
		snapshot, executeErr := app.station.Execute(ctx, stationmodel.Command{StationID: id, OwnerToken: token, Action: action, TrackID: track, Position: position})
		if executeErr != nil {
			t.Fatal(executeErr)
		}
		return snapshot
	}
	for _, track := range []string{"two", "one", "two"} {
		run("add_to_queue", track, nil)
	}
	zero, one, two := 0.0, 1.0, 2.0
	snapshot := run("queue_remove", "two", &two)
	if !slices.Equal(snapshot.Queue, []string{"two", "one"}) || snapshot.TrackID != "one" {
		t.Fatalf("remove duplicate = %#v", snapshot)
	}
	snapshot = run("queue_move_up", "one", &one)
	if !slices.Equal(snapshot.Queue, []string{"one", "two"}) {
		t.Fatalf("move up = %v", snapshot.Queue)
	}
	snapshot = run("queue_move_down", "one", &zero)
	if !slices.Equal(snapshot.Queue, []string{"two", "one"}) {
		t.Fatalf("move down = %v", snapshot.Queue)
	}
	snapshot = run("queue_play", "two", &zero)
	if !slices.Equal(snapshot.Queue, []string{"one"}) || snapshot.TrackID != "two" || snapshot.Position != 0 || !snapshot.Playing {
		t.Fatalf("play queued song = %#v", snapshot)
	}
	snapshot = run("next", "", nil)
	if len(snapshot.Queue) != 0 || snapshot.TrackID != "one" {
		t.Fatalf("next after edit = %#v", snapshot)
	}
}

func TestQueueEditsRejectStalePositionsAndListeners(t *testing.T) {
	app := newTestApp(t)
	ctx := context.Background()
	id, token, _, err := createTemporaryStationForTest(t, app.station, ctx, "one", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	_, err = app.station.Execute(ctx, stationmodel.Command{StationID: id, OwnerToken: token, Action: "add_to_queue", TrackID: "two"})
	if err != nil {
		t.Fatal(err)
	}
	zero, negative, fraction, pastEnd, nan, infinite := 0.0, -1.0, 0.5, 1.0, math.NaN(), math.Inf(1)
	for _, tc := range []struct {
		want                                error
		position                            *float64
		name, action, track, owner, station string
	}{
		{stationmodel.ErrForbidden, &zero, "listener", "queue_remove", "two", "", id},
		{stationmodel.ErrInvalidCommand, nil, "missing position", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &negative, "negative", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &fraction, "fraction", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &pastEnd, "past end", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &nan, "not a number", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &infinite, "infinite", "queue_remove", "two", token, id},
		{stationmodel.ErrInvalidCommand, &zero, "stale song", "queue_play", "one", token, id},
		{stationmodel.ErrInvalidCommand, &zero, "first row", "queue_move_up", "two", token, id},
		{stationmodel.ErrInvalidCommand, &zero, "last row", "queue_move_down", "two", token, id},
		{stationmodel.ErrInvalidCommand, &zero, "automatic station", "queue_remove", "two", "", mainStationID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, executeErr := app.station.Execute(ctx, stationmodel.Command{StationID: tc.station, OwnerToken: tc.owner, Action: tc.action, TrackID: tc.track, Position: tc.position})
			if !errors.Is(executeErr, tc.want) {
				t.Fatalf("error = %v, want %v", executeErr, tc.want)
			}
			snapshot, snapshotErr := app.station.Snapshot(ctx, id)
			if snapshotErr != nil {
				t.Fatal(snapshotErr)
			}
			if !slices.Equal(snapshot.Queue, []string{"two"}) || snapshot.TrackID != "one" {
				t.Fatalf("rejected edit changed station: %#v", snapshot)
			}
		})
	}
}
