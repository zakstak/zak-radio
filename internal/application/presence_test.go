package application

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStationPresenceCountsOnlyItsStreamsAndReleasesOnDisconnect(t *testing.T) {
	app := newTestApp(t)
	_, other := app.events.Subscribe("another-station")
	defer other()
	done := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		app.stationEvents(w, r)
		done <- struct{}{}
	}))
	defer server.Close()
	connect := func(want string) *http.Response {
		t.Helper()
		response, err := http.Get(server.URL + "/api/station/events?station_id=main")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = response.Body.Close() })
		reader := bufio.NewScanner(response.Body)
		for reader.Scan() {
			if reader.Text() != "event: presence" {
				continue
			}
			if !reader.Scan() || strings.TrimSpace(reader.Text()) != want {
				t.Fatalf("presence = %q, want %q", reader.Text(), want)
			}
			return response
		}
		t.Fatalf("presence event missing: %v", reader.Err())
		return nil
	}
	first := connect(`data: {"connected":1}`)
	second := connect(`data: {"connected":2}`)
	if err := second.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("closed event stream did not finish")
	}
	if count := app.events.TopicSubscriberCount(mainStationID); count != 1 {
		t.Fatalf("after disconnect: %d connected, want 1", count)
	}
	if err := first.Body.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("last event stream did not finish")
	}
	if count := app.events.TopicSubscriberCount(mainStationID); count != 0 {
		t.Fatalf("last disconnect leaked %d connections", count)
	}
}
