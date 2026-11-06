package application

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	catalogmodel "zak-radio/internal/catalog"
)

// Library search and filter stations match songs the same way, so a saved
// search keeps playing the songs it showed. This mirrors static/library.js:
// text is folded (case, accents, a few letters such as ß), words are
// canonicalized for common British spellings, and every query word must
// match a whole word, the start of a word, or (from three letters) part of a
// field. Only when nothing matches that way do close spellings count, so
// "harbr" finds "Harbor" and "glass harbour" finds "Glass Harbor".

const (
	searchTitle = iota
	searchArtist
	searchGroup
	searchSource
	searchNotes
	searchText
	searchFieldCount
)

var searchFoldMap = map[rune]string{
	'ß': "ss", 'æ': "ae", 'œ': "oe", 'ø': "o", 'ł': "l",
	'đ': "d", 'ð': "d", 'þ': "th", 'ı': "i",
}

var searchSpelling = map[string]string{
	"grey": "gray", "greys": "grays", "centre": "center", "centres": "centers",
	"theatre": "theater", "metre": "meter", "litre": "liter", "fibre": "fiber",
	"sombre": "somber", "spectre": "specter", "lustre": "luster",
}

type searchField struct {
	set    map[string]struct{}
	folded string
	words  []string
}

type searchEntry [searchFieldCount]searchField

// foldSearchText lowercases text, removes accents and other combining
// marks, and folds the letters that have no decomposition.
func foldSearchText(text string) string {
	decomposed := norm.NFD.String(strings.ToLower(text))
	var folded strings.Builder
	folded.Grow(len(decomposed))
	for _, r := range decomposed {
		if unicode.Is(unicode.M, r) {
			continue
		}
		if replacement, ok := searchFoldMap[r]; ok {
			folded.WriteString(replacement)
			continue
		}
		folded.WriteRune(r)
	}
	return folded.String()
}

func canonicalSearchWord(word string) string {
	if canonical, ok := searchSpelling[word]; ok {
		return canonical
	}
	// "harbour" → "harbor", "colours" → "colors": at least three letters
	// before "our".
	for _, suffix := range []string{"ours", "our"} {
		stem, found := strings.CutSuffix(word, suffix)
		if !found || utf8.RuneCountInString(stem) < 3 {
			continue
		}
		onlyLetters := true
		for _, r := range stem {
			if !unicode.IsLetter(r) {
				onlyLetters = false
				break
			}
		}
		if onlyLetters {
			return stem + "or" + strings.TrimPrefix(suffix, "our")
		}
	}
	return word
}

func searchWords(folded string) []string {
	fields := strings.FieldsFunc(folded, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	for index, word := range fields {
		fields[index] = canonicalSearchWord(word)
	}
	return fields
}

func newSearchField(text string) searchField {
	folded := foldSearchText(text)
	words := searchWords(folded)
	set := make(map[string]struct{}, len(words))
	for _, word := range words {
		set[word] = struct{}{}
	}
	return searchField{folded: folded, words: words, set: set}
}

func newSearchEntry(track *catalogmodel.Track) searchEntry {
	return searchEntry{
		searchTitle:  newSearchField(track.Title),
		searchArtist: newSearchField(track.Artist),
		searchGroup:  newSearchField(track.Group),
		searchSource: newSearchField(track.Source),
		searchNotes:  newSearchField(track.Summary),
		searchText:   newSearchField(track.SearchText),
	}
}

// searchTerms is the query as distinct folded, canonical words.
func searchTerms(query string) []string {
	seen := make(map[string]struct{})
	terms := make([]string, 0, 4)
	for _, word := range searchWords(foldSearchText(strings.TrimSpace(query))) {
		if _, ok := seen[word]; ok {
			continue
		}
		seen[word] = struct{}{}
		terms = append(terms, word)
	}
	return terms
}

func searchTypoLimit(length int) int {
	switch {
	case length >= 8:
		return 2
	case length >= 4:
		return 1
	default:
		return 0
	}
}

// withinSearchDistance reports whether a and b are at most limit edits
// apart (optimal string alignment: insertions, deletions, substitutions,
// and adjacent transpositions).
func withinSearchDistance(a, b []rune, limit int) bool {
	if abs(len(a)-len(b)) > limit {
		return false
	}
	var before []int
	previous := make([]int, len(b)+1)
	for j := range previous {
		previous[j] = j
	}
	for i := 1; i <= len(a); i++ {
		row := make([]int, len(b)+1)
		row[0] = i
		smallest := i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			value := min(previous[j]+1, row[j-1]+1, previous[j-1]+cost)
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				value = min(value, before[j-2]+1)
			}
			row[j] = value
			smallest = min(smallest, value)
		}
		if smallest > limit {
			return false
		}
		before, previous = previous, row
	}
	return previous[len(b)] <= limit
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func (field searchField) matches(term string, fuzzy bool) bool {
	if _, ok := field.set[term]; ok {
		return true
	}
	for _, word := range field.words {
		if strings.HasPrefix(word, term) {
			return true
		}
	}
	termRunes := []rune(term)
	if len(termRunes) >= 3 && strings.Contains(field.folded, term) {
		return true
	}
	if !fuzzy {
		return false
	}
	limit := searchTypoLimit(len(termRunes))
	if limit == 0 {
		return false
	}
	for _, word := range field.words {
		if withinSearchDistance(termRunes, []rune(word), limit) {
			return true
		}
	}
	if len(termRunes) >= 5 {
		for _, word := range field.words {
			wordRunes := []rune(word)
			if len(wordRunes) > len(termRunes) &&
				withinSearchDistance(termRunes, wordRunes[:len(termRunes)], limit) {
				return true
			}
		}
	}
	return false
}

// matches reports whether every term is found in some field. Lyrics and
// other long text allow close spellings only for words of six letters or
// more, so short typos don't match stray words in lyrics.
func (entry *searchEntry) matches(terms []string, fuzzy bool) bool {
	for _, term := range terms {
		found := false
		for key := range entry {
			allowFuzzy := fuzzy &&
				(key != searchText || utf8.RuneCountInString(term) >= 6)
			if entry[key].matches(term, allowFuzzy) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// searchTrackIDs returns the songs in pool that Library search would show
// for query: its exact matches, or, when there are none, its close matches.
func (s *StationService) searchTrackIDs(pool []string, query string) []string {
	terms := searchTerms(query)
	if len(terms) == 0 {
		return pool
	}
	entries := s.searchIndex()
	collect := func(fuzzy bool) []string {
		found := make([]string, 0, len(pool))
		for _, trackID := range pool {
			entry, ok := entries[trackID]
			if ok && entry.matches(terms, fuzzy) {
				found = append(found, trackID)
			}
		}
		return found
	}
	if exact := collect(false); len(exact) > 0 {
		return exact
	}
	return collect(true)
}

// searchIndex folds every song's searchable text once per catalog.
func (s *StationService) searchIndex() map[string]*searchEntry {
	s.searchOnce.Do(func() {
		s.searchEntries = make(map[string]*searchEntry, len(s.catalog.Tracks))
		for index := range s.catalog.Tracks {
			track := &s.catalog.Tracks[index]
			entry := newSearchEntry(track)
			s.searchEntries[track.ID] = &entry
		}
	})
	return s.searchEntries
}
