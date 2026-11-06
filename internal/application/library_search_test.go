package application

import (
	"context"
	"slices"
	"testing"

	catalogmodel "zak-radio/internal/catalog"
	stationmodel "zak-radio/internal/station"
)

func searchTestService(tracks ...catalogmodel.Track) *StationService {
	catalog := catalogmodel.Catalog{
		Tracks:    tracks,
		ByID:      make(map[string]*catalogmodel.Track, len(tracks)),
		IndexByID: make(map[string]int, len(tracks)),
	}
	for index := range catalog.Tracks {
		catalog.ByID[catalog.Tracks[index].ID] = &catalog.Tracks[index]
		catalog.IndexByID[catalog.Tracks[index].ID] = index
	}
	return &StationService{catalog: catalog}
}

func searchTestCatalog() *StationService {
	return searchTestService(
		catalogmodel.Track{ID: "harbor", Title: "Glass Harbor", Artist: "Zak", Group: "Night Drive", HasCover: true},
		catalogmodel.Track{ID: "cafe", Title: "Café Noir", Artist: "Mira Okonkwo"},
		catalogmodel.Track{ID: "synth", Title: "Taillights", Artist: "Zak", Summary: "Analog synth at dusk", HasCover: true},
		catalogmodel.Track{ID: "lyrics", Title: "Cruise Control", Artist: "Saint Vellum", SearchText: "we drove the grey coast road"},
		catalogmodel.Track{ID: "strasse", Title: "Straße", Artist: "Zak"},
	)
}

func TestLibrarySearchMatchesLikeLibrary(t *testing.T) {
	service := searchTestCatalog()
	all := []string{"harbor", "cafe", "synth", "lyrics", "strasse"}
	for _, test := range []struct {
		query string
		want  []string
	}{
		// Whole words, the start of a word, and part of a field.
		{"harbor", []string{"harbor"}},
		{"harb", []string{"harbor"}},
		{"arbo", []string{"harbor"}},
		// Case and accents fold away, both ways.
		{"CAFE", []string{"cafe"}},
		{"café", []string{"cafe"}},
		{"strasse", []string{"strasse"}},
		// British spellings find American ones, and the reverse.
		{"glass harbour", []string{"harbor"}},
		{"gray", []string{"lyrics"}},
		// Every word must match somewhere.
		{"zak synth", []string{"synth"}},
		{"zak harbor", []string{"harbor"}},
		{"mira harbor", nil},
		// No exact match: close spellings count.
		{"harbr", []string{"harbor"}},
		{"taillihgts", []string{"synth"}},
		// An empty query includes every song.
		{"  ", all},
	} {
		got := service.searchTrackIDs(all, test.query)
		if !slices.Equal(got, test.want) {
			t.Errorf("search %q = %v, want %v", test.query, got, test.want)
		}
	}
}

func TestLibrarySearchPrefersExactMatches(t *testing.T) {
	service := searchTestService(
		catalogmodel.Track{ID: "exact", Title: "Harbor Lights"},
		catalogmodel.Track{ID: "close", Title: "Harbour Bells"},
		catalogmodel.Track{ID: "typo", Title: "Hardor"},
	)
	pool := []string{"exact", "close", "typo"}
	// "Harbour" is the same word as "harbor", so it is an exact match; the
	// typo only counts when nothing matches exactly.
	if got := service.searchTrackIDs(pool, "harbor"); !slices.Equal(got, []string{"exact", "close"}) {
		t.Fatalf("exact search = %v", got)
	}
	if got := service.searchTrackIDs([]string{"typo"}, "harbor"); !slices.Equal(got, []string{"typo"}) {
		t.Fatalf("close search = %v", got)
	}
}

func TestLibrarySearchKeepsShortTyposOutOfLyrics(t *testing.T) {
	service := searchTestService(
		catalogmodel.Track{ID: "lyric", Title: "Untitled", SearchText: "coast road"},
		catalogmodel.Track{ID: "title", Title: "Coats"},
	)
	pool := []string{"lyric", "title"}
	// "coatz" is one edit from both; lyrics only take close spellings of
	// six letters or more.
	if got := service.searchTrackIDs(pool, "coatz"); !slices.Equal(got, []string{"title"}) {
		t.Fatalf("short typo search = %v", got)
	}
}

func TestFilterStationPlaysWhatLibrarySearchShowed(t *testing.T) {
	service := searchTestCatalog()
	for _, test := range []struct {
		want       []string
		definition stationmodel.Definition
	}{
		{
			[]string{"harbor"},
			stationmodel.Definition{SourceType: "filter", FilterMode: "all", FilterQuery: "glass harbour"},
		},
		{
			[]string{"harbor"},
			stationmodel.Definition{SourceType: "filter", FilterMode: "all", FilterQuery: "harbr"},
		},
		{
			// Matching happens among the songs the filter includes.
			[]string{"harbor", "synth"},
			stationmodel.Definition{SourceType: "filter", FilterMode: "covers", FilterQuery: "zak"},
		},
		{
			[]string{"cafe"},
			stationmodel.Definition{SourceType: "filter", FilterMode: "all", FilterQuery: "cafe"},
		},
	} {
		got, err := service.eligibleStationTracks(context.Background(), nil, test.definition)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(got, test.want) {
			t.Errorf("filter %q (%s) = %v, want %v",
				test.definition.FilterQuery, test.definition.FilterMode, got, test.want)
		}
	}
}
