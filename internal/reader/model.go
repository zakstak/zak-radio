package reader

type Item map[string]any
type Segment map[string]any

func PublicItem(item Item) map[string]any {
	result := make(map[string]any)
	for _, key := range []string{
		"id", "title", "source_url", "source_type", "author", "published_at",
		"uploaded_at", "generated_at", "status", "voice", "tts_backend",
		"tts_speed", "total_duration", "segment_count", "audio_bytes",
		"quality_score", "quality_warnings", "cleanup_after",
	} {
		if value, ok := item[key]; ok {
			result[key] = value
		}
	}
	return result
}

func PublicSegment(segment Segment) map[string]any {
	result := make(map[string]any)
	for _, key := range []string{
		"segment_index", "heading_path", "kind", "text", "char_start",
		"char_end", "duration", "audio_bytes", "audio_sha256", "status",
	} {
		if value, ok := segment[key]; ok {
			result[key] = value
		}
	}
	return result
}
