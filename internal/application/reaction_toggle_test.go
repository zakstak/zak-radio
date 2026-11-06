package application

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type reactionResult struct {
	TrackID      string `json:"track_id"`
	Liked        bool   `json:"liked"`
	Disliked     bool   `json:"disliked"`
	LikeCount    int    `json:"like_count"`
	DislikeCount int    `json:"dislike_count"`
	Revision     int64  `json:"revision"`
}

func postReaction(t *testing.T, app *App, body string) reactionResult {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/reaction", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiReaction(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("reaction %s status=%d body=%s", body, res.Code, res.Body.String())
	}
	var result reactionResult
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func reaction(trackID, kind string, remove bool) string {
	if remove {
		return fmt.Sprintf(`{"track_id":%q,"reaction":%q,"remove":true}`, trackID, kind)
	}
	return fmt.Sprintf(`{"track_id":%q,"reaction":%q}`, trackID, kind)
}

func TestReactionRemoveDecrementsTheMatchingCounter(t *testing.T) {
	app := newTestApp(t)
	first := postReaction(t, app, reaction("one", "like", false))
	second := postReaction(t, app, reaction("one", "like", false))
	disliked := postReaction(t, app, reaction("one", "dislike", false))
	if first.LikeCount != 1 || second.LikeCount != 2 || disliked.DislikeCount != 1 {
		t.Fatalf("increments: first=%+v second=%+v disliked=%+v", first, second, disliked)
	}
	removed := postReaction(t, app, reaction("one", "like", true))
	if removed.LikeCount != 1 || !removed.Liked || removed.DislikeCount != 1 {
		t.Fatalf("remove like changed the wrong counter: %+v", removed)
	}
	if removed.Revision <= disliked.Revision {
		t.Fatalf("remove did not advance the stats revision: %d <= %d",
			removed.Revision, disliked.Revision)
	}
	removed = postReaction(t, app, reaction("one", "dislike", true))
	if removed.DislikeCount != 0 || removed.Disliked || removed.LikeCount != 1 {
		t.Fatalf("remove dislike: %+v", removed)
	}
}

func TestReactionRemoveNeverGoesBelowZero(t *testing.T) {
	app := newTestApp(t)
	// No row exists yet for this track.
	empty := postReaction(t, app, reaction("two", "like", true))
	if empty.LikeCount != 0 || empty.DislikeCount != 0 || empty.Liked {
		t.Fatalf("remove without a reaction: %+v", empty)
	}
	postReaction(t, app, reaction("two", "like", false))
	postReaction(t, app, reaction("two", "like", true))
	floor := postReaction(t, app, reaction("two", "like", true))
	if floor.LikeCount != 0 || floor.Liked {
		t.Fatalf("like counter went below zero: %+v", floor)
	}
	floor = postReaction(t, app, reaction("two", "dislike", true))
	if floor.DislikeCount != 0 || floor.Disliked {
		t.Fatalf("dislike counter went below zero: %+v", floor)
	}
}

func TestReactionRemovePublishesTrackStats(t *testing.T) {
	app := newTestApp(t)
	postReaction(t, app, reaction("one", "like", false))
	events, unsubscribe := app.events.Subscribe("track-stats")
	defer unsubscribe()
	removed := postReaction(t, app, reaction("one", "like", true))
	select {
	case payload := <-events:
		var event struct {
			Tracks []struct {
				TrackID   string `json:"track_id"`
				LikeCount int    `json:"like_count"`
			} `json:"tracks"`
			Revision int64 `json:"revision"`
		}
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatal(err)
		}
		if event.Revision != removed.Revision {
			t.Fatalf("published revision=%d want %d", event.Revision, removed.Revision)
		}
		for _, stat := range event.Tracks {
			if stat.TrackID == "one" && stat.LikeCount != 0 {
				t.Fatalf("published like count=%d after remove", stat.LikeCount)
			}
		}
	case <-time.After(time.Second):
		t.Fatal("remove did not publish a track-stat event")
	}
}

func TestReactionRejectsUnknownKindsEvenWhenRemoving(t *testing.T) {
	app := newTestApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/reaction",
		strings.NewReader(`{"track_id":"one","reaction":"love","remove":true}`))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	app.apiReaction(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unknown reaction status=%d body=%s", res.Code, res.Body.String())
	}
}
