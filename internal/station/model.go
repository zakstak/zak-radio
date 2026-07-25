package station

import (
	"errors"
	"fmt"
	"time"
)

type Station struct {
	ID, Kind, OwnerHash, TrackID         string
	Position                             float64
	Playing, RepeatOne, Shuffle          bool
	CreatedAt, UpdatedAt, TrackChangedAt float64
	ExpiresAt                            *float64
	Revision                             int64
}

type Snapshot struct {
	StationID       string   `json:"station_id"`
	CatalogRevision string   `json:"catalog_revision"`
	Kind            string   `json:"kind"`
	TrackID         string   `json:"track_id"`
	Position        float64  `json:"position"`
	Playing         bool     `json:"playing"`
	RepeatOne       bool     `json:"repeat_one"`
	Shuffle         bool     `json:"shuffle"`
	UpdatedAt       float64  `json:"updated_at"`
	TrackChangedAt  float64  `json:"track_changed_at"`
	ServerTime      float64  `json:"server_time"`
	Liked           bool     `json:"liked"`
	Disliked        bool     `json:"disliked"`
	LikeCount       int      `json:"like_count"`
	DislikeCount    int      `json:"dislike_count"`
	SkipCount       int      `json:"skip_count"`
	ExpiresAt       *float64 `json:"expires_at,omitempty"`
	Revision        int64    `json:"revision"`
	CanControl      *bool    `json:"can_control,omitempty"`
	Queue           []string `json:"queue"`
}

type Command struct {
	StationID, OwnerToken, Action, TrackID string
	Position                               *float64
	RepeatOne, Shuffle                     *bool
}

type Clock func() time.Time
type RandomIndex func(int) int

var (
	ErrForbidden      = errors.New("this station is listen-only")
	ErrCapacity       = errors.New("temporary station capacity reached")
	ErrQueueFull      = errors.New("this station queue is full")
	ErrInvalidCommand = errors.New("invalid station command")
)

func (s Station) String() string {
	return fmt.Sprintf("%s@%d", s.ID, s.Revision)
}
