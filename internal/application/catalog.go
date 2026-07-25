package application

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	catalogmodel "zak-radio/internal/catalog"
)

var (
	catalogIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	sha256Pattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type ArchiveIndex = catalogmodel.ArchiveIndex
type ArchiveItem = catalogmodel.ArchiveItem
type CuratedFile = catalogmodel.CuratedFile
type CuratedTrack = catalogmodel.CuratedTrack
type Track = catalogmodel.Track
type Catalog = catalogmodel.Catalog

const (
	maxCatalogJSONBytes   = 16 << 20
	maxTrackTextBytes     = 1 << 20
	maxCatalogTracks      = 5000
	maxCatalogTextBytes   = 8 << 20
	maxRouteIDBytes       = 128
	maxAudioArtifactBytes = 512 << 20
	minTrackDuration      = 0.05
	maxStationDuration    = 1e9
	timedLyricsSubjects   = "subjects.json"
)

func validRouteID(id string) bool {
	return len(id) <= maxRouteIDBytes && catalogIDPattern.MatchString(id)
}

func loadCatalog(
	cfg Config,
	archiveRoot, metadataRoot, timedLyricsRoot *os.Root,
) (Catalog, error) {
	indexData, err := readRootBytes(
		archiveRoot, cfg.Archive, filepath.Join(cfg.Archive, "index.json"), maxCatalogJSONBytes)
	if err != nil {
		return Catalog{}, err
	}
	index, err := decodeArchiveIndex(indexData)
	if err != nil {
		return Catalog{}, err
	}
	curatedData, err := readRootBytes(metadataRoot, cfg.MetadataRoot,
		filepath.Join(cfg.MetadataRoot, "curated-tracks.json"), maxCatalogJSONBytes)
	if err != nil {
		return Catalog{}, fmt.Errorf("load curated metadata: %w", err)
	}
	curated, err := decodeCuratedFile(curatedData)
	if err != nil {
		return Catalog{}, fmt.Errorf("load curated metadata: %w", err)
	}
	if timedLyricsRoot != nil {
		subjectsPath := filepath.Join(cfg.TimedLyricsRoot, timedLyricsSubjects)
		if safeOptionalFile(subjectsPath, cfg.TimedLyricsRoot) {
			subjectsData, err := readRootBytes(
				timedLyricsRoot, cfg.TimedLyricsRoot,
				subjectsPath, maxCatalogJSONBytes,
			)
			if err != nil {
				return Catalog{}, fmt.Errorf("load immutable subjects: %w", err)
			}
			subjects, err := decodeCuratedFile(subjectsData)
			if err != nil {
				return Catalog{}, fmt.Errorf("load immutable subjects: %w", err)
			}
			for id, subject := range subjects.Tracks {
				current := curated.Tracks[id]
				if subject.Title != "" {
					current.Title = subject.Title
				}
				if subject.Artist != "" {
					current.Artist = subject.Artist
				}
				if subject.Summary != "" {
					current.Summary = subject.Summary
				}
				curated.Tracks[id] = current
			}
		}
	}
	tracks := make([]Track, 0, len(index.Tracks))
	seenIDs := make(map[string]struct{}, len(index.Tracks))
	var catalogTextBytes int
	for _, item := range index.Tracks {
		if item.ID == "" || item.OrganizedDir == "" {
			return Catalog{}, errorsForCatalog(item.ID, "id and organized_dir are required")
		}
		if !validRouteID(item.ID) {
			return Catalog{}, errorsForCatalog(item.ID, "id is not route-safe")
		}
		if _, exists := seenIDs[item.ID]; exists {
			return Catalog{}, errorsForCatalog(item.ID, "duplicate id")
		}
		seenIDs[item.ID] = struct{}{}
		dir := cleanJoin(cfg.Archive, item.OrganizedDir)
		if dir == "" || !containedPath(dir, cfg.Archive) {
			return Catalog{}, errorsForCatalog(item.ID, "organized directory escapes archive")
		}
		audio := filepath.Join(dir, "audio.mp3")
		duration := asFloat(item.Duration)
		audioFile, audioInfo, audioErr := openRootedRegular(archiveRoot, cfg.Archive, audio)
		if audioErr == nil {
			audioFile.Close()
		}
		if !containedPath(audio, cfg.Archive) || audioErr != nil {
			return Catalog{}, errorsForCatalog(item.ID, "audio.mp3 is missing or outside archive")
		}
		if audioInfo.Size() <= 0 {
			return Catalog{}, errorsForCatalog(item.ID, "audio.mp3 is empty")
		}
		if audioInfo.Size() > maxAudioArtifactBytes {
			return Catalog{}, errorsForCatalog(item.ID, "audio.mp3 exceeds the per-artifact size limit")
		}
		if math.IsNaN(duration) || math.IsInf(duration, 0) {
			return Catalog{}, errorsForCatalog(item.ID, "duration is outside the finite operational range")
		}
		if duration < minTrackDuration {
			return Catalog{}, errorsForCatalog(item.ID, "duration is below the operational minimum")
		}
		if duration > maxStationDuration {
			return Catalog{}, errorsForCatalog(item.ID, "duration exceeds the operational maximum")
		}
		if !sha256Pattern.MatchString(item.AudioSHA256) {
			return Catalog{}, errorsForCatalog(item.ID, "audio_sha256 must be a lowercase SHA-256 digest")
		}
		cover := filepath.Join(dir, "cover-large.jpg")
		if !exists(cover) {
			cover = filepath.Join(dir, "cover.jpg")
		}
		lyrics := filepath.Join(dir, "lyrics.md")
		timedLyrics := filepath.Join(dir, "lyrics.timed.json")
		timedLyricsBundled := false
		prompt := filepath.Join(dir, "prompt.txt")
		c := curated.Tracks[item.ID]
		if !exists(cover) && c.Cover != "" {
			cover = cleanJoin(cfg.MetadataRoot, c.Cover)
		}
		if !safeOptionalFile(cover, cfg.Archive, cfg.MetadataRoot) {
			cover = ""
		}
		if cover != "" && !supportedImagePath(cover) {
			return Catalog{}, errorsForCatalog(item.ID, "cover must be a supported raster image")
		}
		var coverBytes int64
		var coverSHA256 string
		if cover != "" {
			coverRoot, coverRootPath := archiveRoot, cfg.Archive
			if containedPath(cover, cfg.MetadataRoot) {
				coverRoot, coverRootPath = metadataRoot, cfg.MetadataRoot
			}
			coverFile, coverInfo, coverErr := openRootedRegular(coverRoot, coverRootPath, cover)
			if coverErr != nil {
				return Catalog{}, errorsForCatalog(item.ID, "cover is missing or outside its retained root")
			}
			coverFile.Close()
			coverBytes = coverInfo.Size()
			if coverBytes <= 0 || coverBytes > maxAudioArtifactBytes {
				return Catalog{}, errorsForCatalog(item.ID, "cover is empty or oversized")
			}
			coverSHA256, err = rootedDigest(coverRoot, coverRootPath, cover)
			if err != nil {
				return Catalog{}, errorsForCatalog(item.ID, "cover could not be fingerprinted")
			}
		}
		if !safeOptionalFile(lyrics, cfg.Archive) {
			lyrics = ""
		}
		var timedLyricsSHA256 string
		timedLyricsRootHandle := archiveRoot
		timedLyricsRootPath := cfg.Archive
		if !safeOptionalFile(timedLyrics, cfg.Archive) &&
			timedLyricsRoot != nil {
			bundledPath := filepath.Join(cfg.TimedLyricsRoot, item.ID+".json")
			if safeOptionalFile(bundledPath, cfg.TimedLyricsRoot) {
				timedLyrics = bundledPath
				timedLyricsBundled = true
				timedLyricsRootHandle = timedLyricsRoot
				timedLyricsRootPath = cfg.TimedLyricsRoot
			}
		}
		if safeOptionalFile(timedLyrics, timedLyricsRootPath) {
			if _, _, timedLyricsSHA256, err = loadTimedLyrics(
				timedLyricsRootHandle, timedLyricsRootPath, timedLyrics, item.ID,
				item.AudioSHA256, duration,
			); err != nil {
				return Catalog{}, errorsForCatalog(item.ID, err.Error())
			}
		} else {
			timedLyrics = ""
		}
		if !safeOptionalFile(prompt, cfg.Archive) {
			prompt = ""
		}
		title, artist := first(c.Title, item.Title, item.ID, "Untitled"), first(c.Artist, item.Artist, "Zak")
		group := title
		parts := strings.Split(filepath.ToSlash(item.OrganizedDir), "/")
		if len(parts) > 1 {
			group = parts[1]
		}
		searchText := strings.Join([]string{
			title, artist, item.Source, item.CreatedAt, c.Summary,
			readRootTextMaybe(archiveRoot, cfg.Archive, lyrics),
			readRootTextMaybe(archiveRoot, cfg.Archive, prompt),
		}, "\n")
		if len(searchText) > maxTrackTextBytes {
			return Catalog{}, errorsForCatalog(item.ID, "track text exceeds response-memory limit")
		}
		catalogTextBytes += len(searchText)
		if catalogTextBytes > maxCatalogTextBytes {
			return Catalog{}, errorsForCatalog(item.ID, "aggregate catalog text exceeds retained-memory limit")
		}
		tracks = append(tracks, Track{
			ID: item.ID, Title: title, Artist: artist, Source: item.Source, CreatedAt: item.CreatedAt,
			BatchIndex: item.BatchIndex, Duration: item.Duration, PlayCount: item.PlayCount, Group: group,
			Summary: c.Summary, SearchText: searchText,
			HasCover: exists(cover), AudioBytes: audioInfo.Size(), AudioSHA256: item.AudioSHA256,
			CoverSHA256: coverSHA256, AudioPath: audio, CoverPath: cover,
			CoverBytes: coverBytes, LyricsPath: lyrics,
			TimedLyricsPath: timedLyrics, TimedLyricsSHA256: timedLyricsSHA256,
			TimedLyricsBundled: timedLyricsBundled,
			HasSyncedLyrics:    timedLyrics != "", PromptPath: prompt,
		})
	}
	if len(tracks) == 0 {
		return Catalog{}, errorsForCatalog("", "no playable tracks")
	}
	sort.Slice(tracks, func(i, j int) bool {
		if strings.ToLower(tracks[i].Group) != strings.ToLower(tracks[j].Group) {
			return strings.ToLower(tracks[i].Group) < strings.ToLower(tracks[j].Group)
		}
		if tracks[i].CreatedAt != tracks[j].CreatedAt {
			return tracks[i].CreatedAt < tracks[j].CreatedAt
		}
		return fmt.Sprint(tracks[i].BatchIndex) < fmt.Sprint(tracks[j].BatchIndex)
	})
	byID := make(map[string]*Track, len(tracks))
	indexByID := make(map[string]int, len(tracks))
	for i := range tracks {
		byID[tracks[i].ID] = &tracks[i]
		indexByID[tracks[i].ID] = i
	}
	revisionPayload, err := json.Marshal(tracks)
	if err != nil {
		return Catalog{}, fmt.Errorf("fingerprint catalog: %w", err)
	}
	revision := fmt.Sprintf("%x", sha256.Sum256(revisionPayload))
	return Catalog{
		Tracks: tracks, ByID: byID, IndexByID: indexByID, Revision: revision,
	}, nil
}

func decodeArchiveIndex(data []byte) (ArchiveIndex, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return ArchiveIndex{}, errorsForCatalog("", "index must be a JSON object")
	}
	result := ArchiveIndex{}
	seenTracks := false
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return ArchiveIndex{}, err
		}
		if key != "tracks" {
			var ignored json.RawMessage
			if err := decoder.Decode(&ignored); err != nil {
				return ArchiveIndex{}, err
			}
			continue
		}
		if seenTracks {
			return ArchiveIndex{}, errorsForCatalog("", "duplicate tracks field")
		}
		seenTracks = true
		if token, err := decoder.Token(); err != nil || token != json.Delim('[') {
			return ArchiveIndex{}, errorsForCatalog("", "tracks must be an array")
		}
		for decoder.More() {
			if len(result.Tracks) >= maxCatalogTracks {
				return ArchiveIndex{}, errorsForCatalog("", "track count exceeds retained catalog limit")
			}
			var item ArchiveItem
			if err := decoder.Decode(&item); err != nil {
				return ArchiveIndex{}, err
			}
			result.Tracks = append(result.Tracks, item)
		}
		if token, err := decoder.Token(); err != nil || token != json.Delim(']') {
			return ArchiveIndex{}, errorsForCatalog("", "tracks array is incomplete")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return ArchiveIndex{}, errorsForCatalog("", "index object is incomplete")
	}
	if !seenTracks {
		return ArchiveIndex{}, errorsForCatalog("", "index has no tracks field")
	}
	if err := requireJSONEOF(decoder); err != nil {
		return ArchiveIndex{}, err
	}
	return result, nil
}

func decodeCuratedFile(data []byte) (CuratedFile, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return CuratedFile{}, errorsForCatalog("", "curated metadata must be a JSON object")
	}
	result := CuratedFile{Tracks: make(map[string]CuratedTrack)}
	seenTracks := false
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return CuratedFile{}, err
		}
		if key != "tracks" {
			var ignored json.RawMessage
			if err := decoder.Decode(&ignored); err != nil {
				return CuratedFile{}, err
			}
			continue
		}
		if seenTracks {
			return CuratedFile{}, errorsForCatalog("", "duplicate curated tracks field")
		}
		seenTracks = true
		if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
			return CuratedFile{}, errorsForCatalog("", "curated tracks must be an object")
		}
		entries := 0
		for decoder.More() {
			if entries >= maxCatalogTracks {
				return CuratedFile{}, errorsForCatalog("", "curated track count exceeds limit")
			}
			idToken, err := decoder.Token()
			if err != nil {
				return CuratedFile{}, err
			}
			id, ok := idToken.(string)
			if !ok {
				return CuratedFile{}, errorsForCatalog("", "curated track id is not text")
			}
			if _, duplicate := result.Tracks[id]; duplicate {
				return CuratedFile{}, errorsForCatalog(id, "duplicate curated track")
			}
			var track CuratedTrack
			if err := decoder.Decode(&track); err != nil {
				return CuratedFile{}, err
			}
			result.Tracks[id] = track
			entries++
		}
		if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
			return CuratedFile{}, errorsForCatalog("", "curated tracks object is incomplete")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return CuratedFile{}, errorsForCatalog("", "curated metadata object is incomplete")
	}
	if !seenTracks {
		result.Tracks = map[string]CuratedTrack{}
	}
	if err := requireJSONEOF(decoder); err != nil {
		return CuratedFile{}, err
	}
	return result, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errorsForCatalog("", "JSON has trailing data")
		}
		return err
	}
	return nil
}

func readRootTextMaybe(rootHandle *os.Root, root, path string) string {
	if path == "" {
		return ""
	}
	data, err := readRootBytes(rootHandle, root, path, maxTrackTextBytes)
	if err != nil {
		return ""
	}
	return string(data)
}

func readRootBytes(rootHandle *os.Root, root, path string, maximum int64) ([]byte, error) {
	file, stat, err := openRootedRegular(rootHandle, root, path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if stat.Size() > maximum {
		return nil, fmt.Errorf("%s exceeds %d bytes", filepath.Base(path), maximum)
	}
	return io.ReadAll(io.LimitReader(file, maximum+1))
}

func safeOptionalFile(path string, roots ...string) bool {
	if path == "" || !exists(path) {
		return false
	}
	for _, root := range roots {
		if root != "" && containedPath(path, root) {
			return true
		}
	}
	return false
}

func errorsForCatalog(id, reason string) error {
	if id == "" {
		return fmt.Errorf("invalid catalog: %s", reason)
	}
	return fmt.Errorf("invalid catalog track %q: %s", id, reason)
}
