package catalog

type ArchiveIndex struct {
	Tracks []ArchiveItem `json:"tracks"`
}

type ArchiveItem struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Artist       string `json:"artist"`
	Source       string `json:"source"`
	CreatedAt    string `json:"created_at"`
	BatchIndex   any    `json:"batch_index"`
	Duration     any    `json:"duration"`
	PlayCount    any    `json:"play_count"`
	OrganizedDir string `json:"organized_dir"`
	AudioSHA256  string `json:"audio_sha256"`
}

type CuratedFile struct {
	Tracks map[string]CuratedTrack `json:"tracks"`
}

type CuratedTrack struct {
	Title   string `json:"title"`
	Artist  string `json:"artist"`
	Summary string `json:"summary"`
	Cover   string `json:"cover"`
}

type Track struct {
	ID                 string `json:"id"`
	Title              string `json:"title"`
	Artist             string `json:"artist"`
	Source             string `json:"source"`
	CreatedAt          string `json:"created_at"`
	BatchIndex         any    `json:"batch_index"`
	Duration           any    `json:"duration"`
	PlayCount          any    `json:"play_count"`
	Group              string `json:"group"`
	Summary            string `json:"summary"`
	SearchText         string `json:"search_text"`
	HasCover           bool   `json:"has_cover"`
	AudioBytes         int64  `json:"audio_bytes"`
	AudioSHA256        string `json:"audio_sha256"`
	CoverSHA256        string `json:"cover_sha256,omitempty"`
	AudioPath          string `json:"-"`
	CoverPath          string `json:"-"`
	CoverBytes         int64  `json:"-"`
	LyricsPath         string `json:"-"`
	TimedLyricsPath    string `json:"-"`
	TimedLyricsBundled bool   `json:"-"`
	TimedLyricsSHA256  string `json:"lyrics_timing_sha256,omitempty"`
	HasSyncedLyrics    bool   `json:"has_synced_lyrics,omitempty"`
	LyricsQuality      string `json:"lyrics_quality_status,omitempty"`
	CleanLyrics        string `json:"-"`
	PromptPath         string `json:"-"`
	Liked              bool   `json:"liked,omitempty"`
	Disliked           bool   `json:"disliked,omitempty"`
	LikeCount          int    `json:"like_count,omitempty"`
	DislikeCount       int    `json:"dislike_count,omitempty"`
	SkipCount          int    `json:"skip_count,omitempty"`
}

type Catalog struct {
	Tracks    []Track
	ByID      map[string]*Track
	IndexByID map[string]int
	Revision  string
}
