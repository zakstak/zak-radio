package station

import (
	"errors"
	"fmt"
	"time"
)

type Station struct {
	ExpiresAt      *float64
	ID             string
	Kind           string
	OwnerHash      string
	TrackID        string
	CreatedAt      float64
	UpdatedAt      float64
	TrackChangedAt float64
	Position       float64
	Revision       int64
	RepeatOne      bool
	Shuffle        bool
	Saved          bool
	Playing        bool
}

type Definition struct {
	Name           string   `json:"name"`
	SourceType     string   `json:"source_type"`
	FilterMode     string   `json:"filter_mode,omitempty"`
	FilterQuery    string   `json:"filter_query,omitempty"`
	RandomMode     string   `json:"random_mode"`
	StationID      string   `json:"station_id"`
	TrackIDs       []string `json:"track_ids"`
	UpdatedAt      float64  `json:"updated_at"`
	CreatedAt      float64  `json:"created_at"`
	EligibleCount  int      `json:"eligible_count,omitempty"`
	RemainingCount int      `json:"remaining_count,omitempty"`
	SkipDisliked   bool     `json:"skip_disliked"`
	BuiltIn        bool     `json:"built_in"`
	CanEdit        bool     `json:"can_edit,omitempty"`
}

type Snapshot struct {
	CanControl      *bool    `json:"can_control,omitempty"`
	ExpiresAt       *float64 `json:"expires_at,omitempty"`
	FilterQuery     string   `json:"filter_query,omitempty"`
	TrackID         string   `json:"track_id"`
	RandomMode      string   `json:"random_mode,omitempty"`
	StationID       string   `json:"station_id"`
	FilterMode      string   `json:"filter_mode,omitempty"`
	SourceType      string   `json:"source_type,omitempty"`
	StationName     string   `json:"station_name,omitempty"`
	Kind            string   `json:"kind"`
	CatalogRevision string   `json:"catalog_revision"`
	UpNext          []string `json:"up_next,omitempty"`
	Queue           []string `json:"queue"`
	DislikeCount    int      `json:"dislike_count"`
	Position        float64  `json:"position"`
	SkipCount       int      `json:"skip_count"`
	Eligible        int      `json:"eligible,omitempty"`
	Revision        int64    `json:"revision"`
	LikeCount       int      `json:"like_count"`
	ServerTime      float64  `json:"server_time"`
	Remaining       int      `json:"remaining,omitempty"`
	TrackChangedAt  float64  `json:"track_changed_at"`
	UpdatedAt       float64  `json:"updated_at"`
	Liked           bool     `json:"liked"`
	RepeatOne       bool     `json:"repeat_one"`
	Playing         bool     `json:"playing"`
	SkipDisliked    bool     `json:"skip_disliked,omitempty"`
	Shuffle         bool     `json:"shuffle"`
	Saved           bool     `json:"saved"`
	Disliked        bool     `json:"disliked"`
}

type Command struct {
	Position     *float64
	RepeatOne    *bool
	Shuffle      *bool
	SkipDisliked *bool
	StationID    string
	OwnerToken   string
	Action       string
	TrackID      string
	RandomMode   string
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
