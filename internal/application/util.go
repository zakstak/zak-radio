package application

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func writeJSON(w http.ResponseWriter, value any) {
	writeJSONStatus(w, http.StatusOK, value)
}

func writeJSONStatus(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func internalError(w http.ResponseWriter) {
	http.Error(w, "internal service error", http.StatusInternalServerError)
}

func readJSON(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func exists(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func cleanJoin(root, relative string) string {
	path := filepath.Clean(filepath.Join(root, relative))
	if !inside(path, root) {
		return ""
	}
	return path
}

func asFloat(value any) float64 {
	switch value := value.(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case json.Number:
		result, _ := value.Float64()
		return result
	case string:
		result, _ := strconv.ParseFloat(value, 64)
		return result
	default:
		return 0
	}
}

func asInt(value any) int {
	return int(asFloat(value))
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func urlPath(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	return parsed.Path
}

func resolveURL(base, reference string) string {
	ref, err := url.Parse(reference)
	if err != nil {
		return reference
	}
	baseURL, err := url.Parse(base)
	if err != nil || baseURL.Scheme == "" {
		return reference
	}
	return baseURL.ResolveReference(ref).String()
}

func parseWarnings(item map[string]any) {
	if raw, ok := item["quality_warnings"].(string); ok {
		var warnings []string
		if json.Unmarshal([]byte(raw), &warnings) == nil {
			item["quality_warnings"] = warnings
		} else {
			item["quality_warnings"] = []string{}
		}
	}
}

func scanMap(rows *sql.Rows) (map[string]any, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	values, pointers := make([]any, len(columns)), make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	if err := rows.Scan(pointers...); err != nil {
		return nil, err
	}
	result := make(map[string]any, len(columns))
	for i, column := range columns {
		if bytes, ok := values[i].([]byte); ok {
			result[column] = string(bytes)
		} else {
			result[column] = values[i]
		}
	}
	return result, nil
}
