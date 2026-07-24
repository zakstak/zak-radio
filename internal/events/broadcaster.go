package events

import (
	"encoding/json"
	"sync"
)

type Broadcaster struct {
	mu          sync.Mutex
	subscribers map[string]map[chan []byte]struct{}
	revisions   map[string]int64
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{
		subscribers: make(map[string]map[chan []byte]struct{}),
		revisions:   make(map[string]int64),
	}
}

func (b *Broadcaster) Subscribe(stationID string) (<-chan []byte, func()) {
	ch := make(chan []byte, 1)
	b.mu.Lock()
	if b.subscribers[stationID] == nil {
		b.subscribers[stationID] = make(map[chan []byte]struct{})
	}
	b.subscribers[stationID][ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subscribers[stationID], ch)
		if len(b.subscribers[stationID]) == 0 {
			delete(b.subscribers, stationID)
		}
		b.mu.Unlock()
	}
}

func (b *Broadcaster) Forget(topic string) {
	b.mu.Lock()
	delete(b.revisions, topic)
	if len(b.subscribers[topic]) == 0 {
		delete(b.subscribers, topic)
	}
	b.mu.Unlock()
}

func (b *Broadcaster) SubscriberCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	count := 0
	for _, subscribers := range b.subscribers {
		count += len(subscribers)
	}
	return count
}

func (b *Broadcaster) Revision(topic string) (int64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	revision, ok := b.revisions[topic]
	return revision, ok
}

func (b *Broadcaster) PublishValue(topic string, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	var revisioned struct {
		Revision int64 `json:"revision"`
	}
	_ = json.Unmarshal(payload, &revisioned)
	b.mu.Lock()
	defer b.mu.Unlock()
	if revisioned.Revision > 0 {
		if revisioned.Revision <= b.revisions[topic] {
			return
		}
		b.revisions[topic] = revisioned.Revision
	}
	for ch := range b.subscribers[topic] {
		select {
		case ch <- payload:
		default:
			// Coalesce pending state: discard the stale snapshot and retain the
			// newest revision without blocking a mutation on a slow browser.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- payload:
			default:
			}
		}
	}
}
