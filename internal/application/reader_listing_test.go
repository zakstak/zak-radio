package application

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReaderItemsListIncludesListeningProgress(t *testing.T) {
	app := newTestApp(t)
	seedReaderItem(t, app, "reader-started")
	seedReaderItem(t, app, "reader-fresh")
	// reader-started: segment 0 ready (10 s), 1 ready (6 s), 2 ready without
	// audio, 3 processing. Saved playback sits 2.5 s into segment 1.
	if _, err := app.db.Exec(`
insert into reader_segments (
	item_id, segment_index, heading_path, kind, text, char_start, char_end,
	audio_path, duration, audio_bytes, status, audio_sha256
) values
	('reader-started', 1, '[]', 'paragraph', 'Second', 0, 6, null, 6, 0, 'ready', ''),
	('reader-started', 2, '[]', 'heading', 'Silent', 0, 6, null, 0, 0, 'ready', ''),
	('reader-started', 3, '[]', 'paragraph', 'Later', 0, 5, null, 0, 0, 'processing', '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
update reader_items set segment_count=4, status='processing' where id='reader-started'`); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(`
insert into reader_playback (item_id, segment_index, position, playing, updated_at, revision)
values ('reader-started', 1, 2.5, 0, 1234.5, 3)`); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/reader/items", nil)
	res := httptest.NewRecorder()
	app.readerItems(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("items status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, item := range payload.Items {
		id, _ := item["id"].(string)
		byID[id] = item
	}

	started := byID["reader-started"]
	if started == nil {
		t.Fatalf("listing omitted reader-started: %s", res.Body.String())
	}
	if got := started["ready_segment_count"]; got != float64(3) {
		t.Fatalf("ready_segment_count = %#v, want 3", got)
	}
	listened, ok := started["listened_seconds"].(float64)
	if !ok || math.Abs(listened-12.5) > 1e-9 {
		t.Fatalf("listened_seconds = %#v, want 12.5", started["listened_seconds"])
	}
	if got := started["listened_at"]; got != 1234.5 {
		t.Fatalf("listened_at = %#v, want 1234.5", got)
	}

	fresh := byID["reader-fresh"]
	if fresh == nil {
		t.Fatalf("listing omitted reader-fresh: %s", res.Body.String())
	}
	if got := fresh["ready_segment_count"]; got != float64(1) {
		t.Fatalf("fresh ready_segment_count = %#v, want 1", got)
	}
	for _, key := range []string{"listened_seconds", "listened_at"} {
		value, present := fresh[key]
		if !present || value != nil {
			t.Fatalf("fresh %s = %#v (present=%v), want null", key, value, present)
		}
	}

	// Single-item reads keep their existing shape.
	itemReq := httptest.NewRequest(http.MethodGet, "/api/reader/items/reader-started", nil)
	itemRes := httptest.NewRecorder()
	app.readerItemSubroute(itemRes, itemReq)
	if itemRes.Code != http.StatusOK {
		t.Fatalf("item status=%d body=%s", itemRes.Code, itemRes.Body.String())
	}
	var itemPayload map[string]map[string]any
	if err := json.Unmarshal(itemRes.Body.Bytes(), &itemPayload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"ready_segment_count", "listened_seconds", "listened_at"} {
		if _, present := itemPayload["item"][key]; present {
			t.Fatalf("single item unexpectedly exposed %q", key)
		}
	}
}

func TestReaderItemsCursorPageIncludesListeningProgress(t *testing.T) {
	app := newTestApp(t)
	for index, id := range []string{"reader-a", "reader-b"} {
		seedReaderItem(t, app, id)
		if _, err := app.db.Exec("update reader_items set uploaded_at=? where id=?",
			(index+1)*10, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.db.Exec(`
insert into reader_playback (item_id, segment_index, position, playing, updated_at, revision)
values ('reader-a', 0, 4, 0, 99, 1)`); err != nil {
		t.Fatal(err)
	}
	page := func(path string) (string, []map[string]any) {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		app.readerItems(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, res.Code, res.Body.String())
		}
		var payload struct {
			NextCursor string           `json:"next_cursor"`
			Items      []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.NextCursor, payload.Items
	}
	cursor, first := page("/api/reader/items?limit=1")
	if len(first) != 1 || first[0]["id"] != "reader-b" || cursor == "" {
		t.Fatalf("first page = %#v cursor=%q", first, cursor)
	}
	_, second := page("/api/reader/items?limit=1&cursor=" + cursor)
	if len(second) != 1 || second[0]["id"] != "reader-a" {
		t.Fatalf("cursor page = %#v", second)
	}
	if got := second[0]["listened_seconds"]; got != float64(4) {
		t.Fatalf("cursor page listened_seconds = %#v, want 4", got)
	}
}
