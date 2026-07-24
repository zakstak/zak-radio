package application

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	maxRetainedVolumeEntries = 100000
	// Kiln provides a 10 GiB retained volume. Product data is capped at 9 GiB
	// and validated migration backups have a separate 1 GiB durable reserve.
	maxRetainedProductBytes = int64(9 * 1024 * 1024 * 1024)
	maxRetainedBackupBytes  = int64(1 * 1024 * 1024 * 1024)
	maxRetainedVolumeBytes  = maxRetainedProductBytes + maxRetainedBackupBytes
)

var (
	migrationBackupName  = regexp.MustCompile(`^.+\.schema-v[0-9]+-[0-9a-f]{64}\.bak$`)
	migrationReceiptName = regexp.MustCompile(
		`^.+\.migration-v[0-9]+\.backup-receipt$`,
	)
)

func cleanupMigrationTemporaryFiles(databasePath string) error {
	directory := filepath.Dir(databasePath)
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer handle.Close()
	removed := false
	seen := 0
	for {
		entries, readErr := handle.ReadDir(128)
		for _, entry := range entries {
			seen++
			if seen > maxRetainedVolumeEntries {
				return fmt.Errorf("retained volume exceeds %d entries", maxRetainedVolumeEntries)
			}
			name := entry.Name()
			if !strings.HasPrefix(name, ".zak-radio-migration-backup-") &&
				!strings.HasPrefix(name, ".zak-radio-migration-receipt-") {
				continue
			}
			path := filepath.Join(directory, name)
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("interrupted migration artifact is not a regular file: %s", path)
			}
			if err := os.Remove(path); err != nil {
				return err
			}
			removed = true
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if removed {
		return syncDirectory(directory)
	}
	return nil
}

type retainedUsage struct {
	entries      int
	productBytes int64
	backupBytes  int64
}

func validateDataPaths(cfg Config) error {
	metadata, err := unsymlinkedPath(cfg.MetadataRoot)
	if err != nil {
		return fmt.Errorf("metadata root: %w", err)
	}
	for name, path := range map[string]string{
		"archive":        cfg.Archive,
		"Reader library": cfg.ReaderLibrary,
	} {
		resolved, err := unsymlinkedPath(path)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if !lexicallyInside(resolved, metadata) {
			return fmt.Errorf("%s must remain beneath metadata root", name)
		}
	}
	databasePath := cfg.DBPath
	if _, err := os.Lstat(databasePath); os.IsNotExist(err) {
		databasePath = filepath.Dir(databasePath)
	} else if err != nil {
		return fmt.Errorf("database path: %w", err)
	}
	resolvedDB, err := unsymlinkedPath(databasePath)
	if err != nil {
		return fmt.Errorf("database path: %w", err)
	}
	if !lexicallyInside(resolvedDB, metadata) {
		return fmt.Errorf("database must remain beneath metadata root")
	}
	if cfg.StaticDir != "" {
		static, err := unsymlinkedPath(cfg.StaticDir)
		if err != nil {
			return fmt.Errorf("static directory: %w", err)
		}
		if lexicallyInside(static, metadata) || lexicallyInside(metadata, static) {
			return fmt.Errorf("static directory and metadata root must be disjoint")
		}
	}
	return nil
}

func validateRetainedTreeBudget(root string) error {
	usage, err := inspectRetainedTree(root)
	if err != nil {
		return err
	}
	if usage.productBytes > maxRetainedProductBytes {
		return fmt.Errorf("retained product data exceeds %d apparent bytes", maxRetainedProductBytes)
	}
	if usage.backupBytes > maxRetainedBackupBytes {
		return fmt.Errorf("retained migration backups exceed %d apparent bytes", maxRetainedBackupBytes)
	}
	if usage.productBytes+usage.backupBytes > maxRetainedVolumeBytes {
		return fmt.Errorf("retained volume exceeds %d apparent bytes", maxRetainedVolumeBytes)
	}
	return nil
}

func inspectRetainedTree(root string) (retainedUsage, error) {
	rootInfo, err := os.Lstat(root)
	if err == nil && descriptorVolumeRoot.MatchString(filepath.Clean(root)) {
		rootInfo, err = os.Stat(root)
	}
	if err != nil {
		return retainedUsage{}, err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return retainedUsage{}, fmt.Errorf("retained root has no Unix device identity")
	}
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return retainedUsage{}, err
	}
	defer rootHandle.Close()
	rootDirectory, err := rootHandle.Open(".")
	if err != nil {
		return retainedUsage{}, err
	}
	rootMount, err := mountIdentity(int(rootDirectory.Fd()), ".")
	rootDirectory.Close()
	if err != nil {
		return retainedUsage{}, fmt.Errorf("inspect retained root mount identity: %w", err)
	}
	var usage retainedUsage
	directories := []string{"."}
	for len(directories) > 0 {
		relativeDir := directories[len(directories)-1]
		directories = directories[:len(directories)-1]
		directory, err := rootHandle.Open(relativeDir)
		if err != nil {
			return retainedUsage{}, err
		}
		for {
			entries, readErr := directory.ReadDir(128)
			for _, entry := range entries {
				usage.entries++
				if usage.entries > maxRetainedVolumeEntries {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"retained volume exceeds %d entries", maxRetainedVolumeEntries)
				}
				relative := filepath.Join(relativeDir, entry.Name())
				info, err := rootHandle.Lstat(relative)
				if err != nil {
					directory.Close()
					return retainedUsage{}, err
				}
				stat, ok := info.Sys().(*syscall.Stat_t)
				if !ok || stat.Dev != rootStat.Dev {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"retained volume crosses a filesystem device boundary")
				}
				entryMount, err := mountIdentity(int(directory.Fd()), entry.Name())
				if err != nil {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"inspect retained mount identity for %s: %w", relative, err)
				}
				if entryMount != rootMount {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"retained volume contains a nested mountpoint at %s", relative)
				}
				if info.IsDir() {
					directories = append(directories, relative)
					continue
				}
				if !info.Mode().IsRegular() {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"retained volume contains unsupported file type at %s", relative)
				}
				if stat.Nlink != 1 {
					directory.Close()
					return retainedUsage{}, fmt.Errorf(
						"retained volume contains hard-linked file %s", relative)
				}
				if migrationBackupName.MatchString(filepath.Base(relative)) ||
					migrationReceiptName.MatchString(filepath.Base(relative)) {
					if info.Size() > maxRetainedBackupBytes-usage.backupBytes {
						directory.Close()
						return retainedUsage{}, fmt.Errorf(
							"retained migration backups exceed %d apparent bytes",
							maxRetainedBackupBytes)
					}
					usage.backupBytes += info.Size()
				} else {
					if info.Size() > maxRetainedProductBytes-usage.productBytes {
						directory.Close()
						return retainedUsage{}, fmt.Errorf(
							"retained product data exceeds %d apparent bytes",
							maxRetainedProductBytes)
					}
					usage.productBytes += info.Size()
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				directory.Close()
				return retainedUsage{}, readErr
			}
		}
		if err := directory.Close(); err != nil {
			return retainedUsage{}, err
		}
	}
	return usage, nil
}

func mountIdentity(directoryFD int, path string) (uint64, error) {
	var stat unix.Statx_t
	if err := unix.Statx(directoryFD, path, unix.AT_SYMLINK_NOFOLLOW,
		unix.STATX_MNT_ID, &stat); err != nil {
		return 0, err
	}
	if stat.Mask&unix.STATX_MNT_ID == 0 {
		return 0, fmt.Errorf("filesystem did not report a mount identity")
	}
	return stat.Mnt_id, nil
}

func unsymlinkedPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	if filepath.Clean(resolved) != filepath.Clean(absolute) {
		return "", fmt.Errorf("symlinked data roots are not allowed")
	}
	return resolved, nil
}

func lexicallyInside(path, root string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative)
}
