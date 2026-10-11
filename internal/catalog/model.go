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
	BatchIndex         any    `json:"batch_index"`
	PlayCount          any    `json:"play_count"`
	Duration           any    `json:"duration"`
	CoverSHA256        string `json:"cover_sha256,omitempty"`
	CoverPath          string `json:"-"`
	Source             string `json:"source"`
	Artist             string `json:"artist"`
	Title              string `json:"title"`
	Group              string `json:"group"`
	Summary            string `json:"summary"`
	SearchText         string `json:"search_text"`
	PromptPath         string `json:"-"`
	CleanLyrics        string `json:"-"`
	AudioSHA256        string `json:"audio_sha256"`
	ID                 string `json:"id"`
	AudioPath          string `json:"-"`
	CreatedAt          string `json:"created_at"`
	LyricsQuality      string `json:"lyrics_quality_status,omitempty"`
	LyricsPath         string `json:"-"`
	TimedLyricsPath    string `json:"-"`
	TimedLyricsSHA256  string `json:"lyrics_timing_sha256,omitempty"`
	CoverBytes         int64  `json:"-"`
	AudioBytes         int64  `json:"audio_bytes"`
	LikeCount          int    `json:"like_count,omitempty"`
	DislikeCount       int    `json:"dislike_count,omitempty"`
	SkipCount          int    `json:"skip_count,omitempty"`
	TimedLyricsBundled bool   `json:"-"`
	HasSyncedLyrics    bool   `json:"has_synced_lyrics,omitempty"`
	HasCover           bool   `json:"has_cover"`
	Liked              bool   `json:"liked,omitempty"`
	Disliked           bool   `json:"disliked,omitempty"`
}

type Catalog struct {
	ByID      map[string]*Track
	IndexByID map[string]int
	Revision  string
	Tracks    []Track
}
