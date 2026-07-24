package application

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func (a *App) media(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/media/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}
	track := a.byID[parts[0]]
	if track == nil {
		http.NotFound(w, r)
		return
	}
	switch parts[1] {
	case "audio":
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("ETag", fmt.Sprintf(`"sha256-%s"`, track.AudioSHA256))
		serveRootRange(w, r, a.archiveRoot, a.cfg.Archive, track.AudioPath, "private, max-age=86400", "audio/mpeg")
	case "cover":
		if !supportedImagePath(track.CoverPath) {
			http.NotFound(w, r)
			return
		}
		root := a.cfg.Archive
		if !containedPath(track.CoverPath, root) {
			root = a.cfg.MetadataRoot
		}
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("ETag", fmt.Sprintf(`"sha256-%s"`, track.CoverSHA256))
		rootHandle := a.archiveRoot
		if root == a.cfg.MetadataRoot {
			rootHandle = a.metadataRoot
		}
		serveRootContent(w, r, rootHandle, root, track.CoverPath, "private, max-age=86400", contentType(track.CoverPath))
	default:
		http.NotFound(w, r)
	}
}

func serveRange(w http.ResponseWriter, r *http.Request, path string) {
	serveRangeWithCache(w, r, path, "private, max-age=86400")
}

func servePrivateRange(w http.ResponseWriter, r *http.Request, rootHandle *os.Root, root, path string) {
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	serveRootRange(w, r, rootHandle, root, path, "private, no-store", "audio/mpeg")
}

func serveRangeWithCache(w http.ResponseWriter, r *http.Request, path, cacheControl string) {
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", cacheControl)
	http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), file)
}

func serveRootRange(w http.ResponseWriter, r *http.Request, rootHandle *os.Root, root, path, cacheControl, mediaType string) {
	file, stat, err := openRootedRegular(rootHandle, root, path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if ranges := r.Header.Get("Range"); invalidRangeRequest(ranges) {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", stat.Size()))
		http.Error(w, "only one byte range is supported", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("Content-Type", mediaType)
	http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), file)
}

func serveRootContent(w http.ResponseWriter, r *http.Request, rootHandle *os.Root, root, path, cacheControl, mediaType string) {
	file, stat, err := openRootedRegular(rootHandle, root, path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("Content-Type", mediaType)
	http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), file)
}

func openContainedRegular(root, path string) (*os.File, os.FileInfo, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, nil, err
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return nil, nil, err
	}
	relative, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return nil, nil, fmt.Errorf("path escapes root")
	}
	rootHandle, err := os.OpenRoot(rootAbs)
	if err != nil {
		return nil, nil, err
	}
	defer rootHandle.Close()
	return openRootedRegular(rootHandle, rootAbs, pathAbs)
}

func openRootedRegular(rootHandle *os.Root, root, path string) (*os.File, os.FileInfo, error) {
	relative, err := rootedRelative(root, path)
	if err != nil {
		return nil, nil, err
	}
	file, err := rootHandle.OpenFile(relative, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		file.Close()
		if err == nil {
			err = fmt.Errorf("path is not a regular file")
		}
		return nil, nil, err
	}
	return file, stat, nil
}

func rootedRegularInfo(rootHandle *os.Root, root, path string) (os.FileInfo, error) {
	relative, err := rootedRelative(root, path)
	if err != nil {
		return nil, err
	}
	stat, err := rootHandle.Stat(relative)
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("path is not a regular file")
	}
	return stat, nil
}

func rootedRelative(root, path string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(rootAbs, pathAbs)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", fmt.Errorf("path escapes root")
	}
	return relative, nil
}

func supportedAudioPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".mp3")
}

func supportedImagePath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		return true
	default:
		return false
	}
}

func (a *App) serveStaticFile(w http.ResponseWriter, r *http.Request, path string, cache bool) {
	if path == "" {
		http.NotFound(w, r)
		return
	}
	if cache {
		w.Header().Set("Cache-Control", "private, max-age=86400")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	if contentType := contentType(path); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(w, r, path)
}

func contentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".md":
		return "text/markdown; charset=utf-8"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	default:
		return mime.TypeByExtension(filepath.Ext(path))
	}
}

func containedPath(path, root string) bool {
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	// Resolve symlinks for existing paths. For a missing leaf, resolve its
	// parent so a symlinked directory still cannot escape the library.
	resolvedRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return false
	}
	resolvedPath, err := filepath.EvalSymlinks(pathAbs)
	if err != nil {
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(pathAbs))
		if parentErr != nil {
			return false
		}
		resolvedPath = filepath.Join(parent, filepath.Base(pathAbs))
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedPath)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel)
}

func inside(path, root string) bool {
	pathAbs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(rootAbs, pathAbs)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel)
}
