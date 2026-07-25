package application

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const runtimeIdentity = 65532

// prepareRuntimeIdentity verifies bootstrap/restore provisioned the retained
// volume, then drops root before catalog parsing, database access, or listener
// creation. It never recursively mutates a runtime-supplied path.
func prepareRuntimeIdentity(cfg Config) error {
	enforce := os.Getenv("ZAK_RADIO_DROP_PRIVILEGES") == "1"
	if os.Geteuid() == 0 && !enforce {
		if os.Getenv("ZAK_RADIO_ALLOW_ROOTLESS_CONTAINER") != "1" {
			return fmt.Errorf("refusing to run the network service as root without enforced privilege drop")
		}
		uidMap, err := os.Open("/proc/self/uid_map")
		if err != nil {
			return fmt.Errorf("inspect container user namespace: %w", err)
		}
		isRootless, mapErr := namespaceRootMapsToUnprivileged(uidMap)
		closeErr := uidMap.Close()
		if mapErr != nil {
			return fmt.Errorf("inspect container user namespace: %w", mapErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close container user namespace map: %w", closeErr)
		}
		if !isRootless {
			return fmt.Errorf("refusing root runtime outside an unprivileged user namespace")
		}
		normalized, err := cfg.Normalized()
		if err != nil {
			return err
		}
		return validateDataPaths(normalized)
	}
	if !enforce {
		return nil
	}
	if os.Geteuid() != 0 && (os.Geteuid() != runtimeIdentity || os.Getegid() != runtimeIdentity) {
		return fmt.Errorf("runtime identity enforcement requires root or %d:%d, got %d:%d",
			runtimeIdentity, runtimeIdentity, os.Geteuid(), os.Getegid())
	}
	normalized, err := cfg.Normalized()
	if err != nil {
		return err
	}
	if err := validateDataPaths(normalized); err != nil {
		return err
	}
	for name, pair := range map[string][2]string{
		"archive":        {normalized.Archive, filepath.Join(normalized.MetadataRoot, "music-library")},
		"database":       {normalized.DBPath, filepath.Join(normalized.MetadataRoot, "station.sqlite3")},
		"Reader library": {normalized.ReaderLibrary, filepath.Join(normalized.MetadataRoot, "reader-library")},
	} {
		if filepath.Clean(pair[0]) != filepath.Clean(pair[1]) {
			return fmt.Errorf("%s must use the canonical retained-volume layout in production", name)
		}
	}
	for _, required := range []struct {
		name       string
		path       string
		mode       os.FileMode
		wantDir    bool
		disallowed os.FileMode
	}{
		{"retained volume", normalized.MetadataRoot, 0o700, true, 0o027},
		{"retained database", normalized.DBPath, 0o600, false, 0o027},
	} {
		info, err := os.Stat(required.path)
		if err != nil {
			return fmt.Errorf("inspect pre-provisioned %s: %w", required.name, err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != runtimeIdentity || stat.Gid != runtimeIdentity ||
			info.IsDir() != required.wantDir ||
			info.Mode().Perm()&required.mode != required.mode ||
			info.Mode().Perm()&required.disallowed != 0 {
			return fmt.Errorf("%s must be private, owned, and writable by %d:%d before startup",
				required.name, runtimeIdentity, runtimeIdentity)
		}
	}
	if os.Geteuid() == runtimeIdentity {
		return nil
	}
	if err := syscall.Setgroups([]int{runtimeIdentity}); err != nil {
		return fmt.Errorf("set runtime supplementary groups: %w", err)
	}
	if err := syscall.Setgid(runtimeIdentity); err != nil {
		return fmt.Errorf("drop runtime group: %w", err)
	}
	if err := syscall.Setuid(runtimeIdentity); err != nil {
		return fmt.Errorf("drop runtime user: %w", err)
	}
	if os.Geteuid() != runtimeIdentity || os.Getegid() != runtimeIdentity {
		return fmt.Errorf("runtime identity is %s:%s, want %d:%d",
			strconv.Itoa(os.Geteuid()), strconv.Itoa(os.Getegid()), runtimeIdentity, runtimeIdentity)
	}
	return nil
}

func namespaceRootMapsToUnprivileged(source io.Reader) (bool, error) {
	scanner := bufio.NewScanner(source)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 {
			return false, fmt.Errorf("invalid uid_map entry")
		}
		inside, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			return false, fmt.Errorf("parse uid_map container ID: %w", err)
		}
		outside, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return false, fmt.Errorf("parse uid_map host ID: %w", err)
		}
		if _, err := strconv.ParseUint(fields[2], 10, 64); err != nil {
			return false, fmt.Errorf("parse uid_map range: %w", err)
		}
		if inside == 0 {
			return outside != 0, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return false, err
	}
	return false, fmt.Errorf("uid_map does not map container root")
}
