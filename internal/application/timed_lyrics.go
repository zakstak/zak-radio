package application

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
)

const (
	maxTimedLyricsBytes = 2 << 20
	maxTimedLyricCues   = 5000
	maxTimedLyricWords  = 500
	maxTimedLyricText   = 4096
	maxTimedSectionText = 160
)

type TimedLyrics struct {
	Version     int                `json:"version"`
	TrackID     string             `json:"track_id"`
	AudioSHA256 string             `json:"audio_sha256"`
	Duration    float64            `json:"duration"`
	Language    string             `json:"language,omitempty"`
	Generator   map[string]any     `json:"generator,omitempty"`
	Quality     TimedLyricsQuality `json:"quality"`
	Cues        []TimedLyricCue    `json:"cues"`
}

type TimedLyricsQuality struct {
	CandidateLines int      `json:"candidate_lines"`
	AlignedLines   int      `json:"aligned_lines"`
	LineCoverage   float64  `json:"line_coverage"`
	WordCoverage   float64  `json:"word_coverage"`
	MeanConfidence float64  `json:"mean_confidence"`
	Warnings       []string `json:"warnings,omitempty"`
}

type TimedLyricCue struct {
	Start   float64          `json:"start"`
	End     float64          `json:"end"`
	Section string           `json:"section,omitempty"`
	Text    string           `json:"text"`
	Words   []TimedLyricWord `json:"words,omitempty"`
}

type TimedLyricWord struct {
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	Text       string  `json:"text"`
	Confidence float64 `json:"confidence,omitempty"`
}

func loadTimedLyrics(
	root *os.Root,
	rootPath, path, trackID, audioSHA256 string,
	duration float64,
) (TimedLyrics, []byte, string, error) {
	data, err := readRootBytes(root, rootPath, path, maxTimedLyricsBytes)
	if err != nil {
		return TimedLyrics{}, nil, "", err
	}
	var lyrics TimedLyrics
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&lyrics); err != nil {
		return TimedLyrics{}, nil, "", fmt.Errorf("decode timed lyrics: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return TimedLyrics{}, nil, "", fmt.Errorf("decode timed lyrics: %w", err)
	}
	if err := validateTimedLyrics(lyrics, trackID, audioSHA256, duration); err != nil {
		return TimedLyrics{}, nil, "", err
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(data))
	return lyrics, data, sum, nil
}

func validateTimedLyrics(
	lyrics TimedLyrics,
	trackID, audioSHA256 string,
	duration float64,
) error {
	if lyrics.Version != 1 {
		return fmt.Errorf("timed lyrics version is %d, want 1", lyrics.Version)
	}
	if lyrics.TrackID != trackID {
		return fmt.Errorf("timed lyrics track_id does not match catalog")
	}
	if lyrics.AudioSHA256 != audioSHA256 {
		return fmt.Errorf("timed lyrics audio_sha256 does not match catalog")
	}
	if !finiteNumber(lyrics.Duration) || math.Abs(lyrics.Duration-duration) > 0.5 {
		return fmt.Errorf("timed lyrics duration does not match catalog")
	}
	if len(lyrics.Cues) == 0 || len(lyrics.Cues) > maxTimedLyricCues {
		return fmt.Errorf("timed lyrics cue count is outside the supported range")
	}
	if lyrics.Quality.CandidateLines < len(lyrics.Cues) ||
		lyrics.Quality.AlignedLines != len(lyrics.Cues) ||
		!unitInterval(lyrics.Quality.LineCoverage) ||
		!unitInterval(lyrics.Quality.WordCoverage) ||
		!unitInterval(lyrics.Quality.MeanConfidence) {
		return fmt.Errorf("timed lyrics quality summary is invalid")
	}
	previousStart := -1.0
	for cueIndex, cue := range lyrics.Cues {
		if cue.Text == "" || len(cue.Text) > maxTimedLyricText ||
			len(cue.Section) > maxTimedSectionText {
			return fmt.Errorf("timed lyric cue %d has invalid text", cueIndex)
		}
		if !finiteNumber(cue.Start) || !finiteNumber(cue.End) ||
			cue.Start < 0 || cue.End <= cue.Start ||
			cue.End > duration+0.25 || cue.Start < previousStart {
			return fmt.Errorf("timed lyric cue %d has invalid timing", cueIndex)
		}
		previousStart = cue.Start
		if len(cue.Words) > maxTimedLyricWords {
			return fmt.Errorf("timed lyric cue %d has too many words", cueIndex)
		}
		previousWordStart := cue.Start
		for wordIndex, word := range cue.Words {
			if word.Text == "" || len(word.Text) > maxTimedLyricText ||
				!finiteNumber(word.Start) || !finiteNumber(word.End) ||
				word.Start < cue.Start-0.05 || word.End > cue.End+0.05 ||
				word.End <= word.Start || word.Start < previousWordStart-0.05 ||
				!unitInterval(word.Confidence) {
				return fmt.Errorf(
					"timed lyric cue %d word %d is invalid", cueIndex, wordIndex)
			}
			previousWordStart = word.Start
		}
	}
	return nil
}

func finiteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func unitInterval(value float64) bool {
	return finiteNumber(value) && value >= 0 && value <= 1
}
