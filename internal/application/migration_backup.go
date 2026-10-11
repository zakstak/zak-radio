package application

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

func backupBeforeMigration(
	ctx context.Context, db *sql.DB, path, retainedRoot string, version int,
) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return "", fmt.Errorf("create backup directory: %w", err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return "", fmt.Errorf("checkpoint before migration backup: %w", err)
	}
	sourceSHA256, err := fileSHA256(path)
	if err != nil {
		return "", fmt.Errorf("fingerprint pre-migration database: %w", err)
	}
	if backup, found, existingProtectedBackupErr := existingProtectedBackup(
		ctx, path, version, sourceSHA256,
	); existingProtectedBackupErr != nil {
		return "", existingProtectedBackupErr
	} else if found {
		return backup, nil
	}
	backup := fmt.Sprintf("%s.schema-v%d-%s.bak", path, version, sourceSHA256)
	if info, lstatErr := os.Lstat(backup); lstatErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("existing migration backup is unsafe")
		}
		backupSHA256, validateMigrationBackupErr := validateMigrationBackup(ctx, backup)
		if validateMigrationBackupErr != nil {
			return "", validateMigrationBackupErr
		}
		if backupSHA256 != sourceSHA256 {
			return "", fmt.Errorf(
				"existing migration backup is not an exact copy of the live source")
		}
		if writeMigrationBackupReceiptErr := writeMigrationBackupReceipt(path, migrationBackupReceipt{
			TargetVersion: currentSchemaVersion,
			SourceVersion: version,
			SourceSHA256:  sourceSHA256,
			Backup:        backup,
			BackupSHA256:  backupSHA256,
		}); writeMigrationBackupReceiptErr != nil {
			return "", writeMigrationBackupReceiptErr
		}
		return backup, nil
	} else if !errors.Is(lstatErr, os.ErrNotExist) {
		return "", lstatErr
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	projected := info.Size()
	for _, suffix := range []string{"-wal", "-shm"} {
		if sidecar, statErr := os.Stat(path + suffix); statErr == nil {
			projected += sidecar.Size()
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
	}
	if ensureMigrationHeadroomErr := ensureMigrationHeadroom(path, projected, true); ensureMigrationHeadroomErr != nil {
		return "", ensureMigrationHeadroomErr
	}
	usage, err := inspectRetainedTree(retainedRoot)
	if err != nil {
		return "", fmt.Errorf("inspect retained usage before migration backup: %w", err)
	}
	const receiptReserve = int64(4096)
	if usage.backupBytes+projected+receiptReserve > maxRetainedBackupBytes ||
		usage.productBytes+usage.backupBytes+projected+receiptReserve > maxRetainedVolumeBytes {
		return "", fmt.Errorf("migration backup would exceed the retained-volume durable reserve")
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".zak-radio-migration-backup-*")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }() // Best-effort cleanup; operation errors are checked separately.
	if chmodErr := temporary.Chmod(0o600); chmodErr != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return "", chmodErr
	}
	source, err := os.Open(path)
	if err != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return "", err
	}
	if _, copyErr := io.Copy(temporary, source); copyErr != nil {
		_ = source.Close()    // Preserve the primary result while releasing resources.
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return "", fmt.Errorf("copy pre-migration database: %w", copyErr)
	}
	if closeErr := source.Close(); closeErr != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return "", closeErr
	}
	if syncErr := temporary.Sync(); syncErr != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return "", syncErr
	}
	if closeErr2 := temporary.Close(); closeErr2 != nil {
		return "", closeErr2
	}
	temporaryInfo, err := os.Lstat(temporaryPath)
	if err != nil || !temporaryInfo.Mode().IsRegular() {
		return "", fmt.Errorf("inspect pre-migration backup: %w", err)
	}
	if usage.backupBytes+temporaryInfo.Size()+receiptReserve > maxRetainedBackupBytes ||
		usage.productBytes+usage.backupBytes+temporaryInfo.Size()+receiptReserve >
			maxRetainedVolumeBytes {
		return "", fmt.Errorf("migration backup exceeds the retained-volume durable reserve")
	}
	backupSHA256, err := validateMigrationBackup(ctx, temporaryPath)
	if err != nil {
		return "", err
	}
	sourceAfterCopy, err := fileSHA256(path)
	if err != nil || sourceAfterCopy != sourceSHA256 || backupSHA256 != sourceSHA256 {
		return "", fmt.Errorf("pre-migration source changed while its exact backup was copied")
	}
	if err := os.Link(temporaryPath, backup); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return "", fmt.Errorf("publish pre-migration backup: %w", err)
		}
		existingSHA256, validateErr := validateMigrationBackup(ctx, backup)
		if validateErr != nil || existingSHA256 != sourceSHA256 {
			return "", fmt.Errorf("conflicting pre-migration backup: %w", validateErr)
		}
	}
	if err := syncRegularFile(backup); err != nil {
		return "", fmt.Errorf("sync pre-migration backup: %w", err)
	}
	if err := syncDirectory(filepath.Dir(backup)); err != nil {
		return "", fmt.Errorf("sync pre-migration backup directory: %w", err)
	}
	if err := writeMigrationBackupReceipt(path, migrationBackupReceipt{
		TargetVersion: currentSchemaVersion,
		SourceVersion: version,
		SourceSHA256:  sourceSHA256,
		Backup:        backup,
		BackupSHA256:  backupSHA256,
	}); err != nil {
		return "", err
	}
	return backup, nil
}

type migrationBackupReceipt struct {
	SourceSHA256  string `json:"source_sha256"`
	Backup        string `json:"backup"`
	BackupSHA256  string `json:"backup_sha256"`
	TargetVersion int    `json:"target_version"`
	SourceVersion int    `json:"source_version"`
}

func migrationBackupReceiptPath(path string) string {
	return fmt.Sprintf("%s.migration-v%d.backup-receipt", path, currentSchemaVersion)
}

func existingProtectedBackup(
	ctx context.Context, path string, currentVersion int, currentSHA256 string,
) (string, bool, error) {
	receiptPath := migrationBackupReceiptPath(path)
	info, err := os.Lstat(receiptPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
		return "", false, fmt.Errorf("migration backup receipt is unsafe")
	}
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		return "", false, err
	}
	var receipt migrationBackupReceipt
	if json.Unmarshal(data, &receipt) != nil ||
		receipt.TargetVersion != currentSchemaVersion ||
		receipt.SourceVersion < 0 || receipt.SourceVersion > currentVersion ||
		!sha256Pattern.MatchString(receipt.SourceSHA256) ||
		!sha256Pattern.MatchString(receipt.BackupSHA256) ||
		filepath.Dir(receipt.Backup) != filepath.Dir(path) ||
		!strings.HasPrefix(filepath.Base(receipt.Backup), filepath.Base(path)+".schema-v") ||
		!migrationBackupName.MatchString(filepath.Base(receipt.Backup)) {
		return "", false, fmt.Errorf("migration backup receipt is invalid")
	}
	if receipt.SourceVersion == currentVersion && currentSHA256 != "" &&
		receipt.SourceSHA256 != currentSHA256 {
		return "", false, fmt.Errorf("migration backup receipt does not match the live source database")
	}
	if !strings.Contains(filepath.Base(receipt.Backup), receipt.SourceSHA256) {
		return "", false, fmt.Errorf("migration backup filename does not match its source digest")
	}
	backupSHA256, err := validateMigrationBackup(ctx, receipt.Backup)
	if err != nil {
		return "", false, err
	}
	if backupSHA256 != receipt.BackupSHA256 {
		return "", false, fmt.Errorf("migration backup receipt digest does not match")
	}
	if backupSHA256 != receipt.SourceSHA256 {
		return "", false, fmt.Errorf("migration backup is not an exact source copy")
	}
	return receipt.Backup, true, nil
}

func validateMigrationBackup(ctx context.Context, backup string) (string, error) {
	info, err := os.Lstat(backup)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 ||
		info.Size() <= 0 || info.Size() > maxRetainedBackupBytes {
		return "", fmt.Errorf("pre-migration backup is unsafe or oversized")
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, lstatErr2 := os.Lstat(backup + suffix); lstatErr2 == nil {
			return "", fmt.Errorf("pre-migration backup has an unbound SQLite sidecar")
		} else if !errors.Is(lstatErr2, os.ErrNotExist) {
			return "", lstatErr2
		}
	}
	check, err := sql.Open("sqlite", (&url.URL{
		Scheme: "file", Path: backup, RawQuery: "mode=ro&immutable=1",
	}).String())
	if err != nil {
		return "", fmt.Errorf("open pre-migration backup: %w", err)
	}
	defer func() { _ = check.Close() }() // Best-effort cleanup; operation errors are checked separately.
	var result string
	if scanErr := check.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); scanErr != nil || result != "ok" {
		return "", fmt.Errorf("validate pre-migration backup: result=%q err=%w", result, scanErr)
	}
	digest, err := fileSHA256(backup)
	if err != nil {
		return "", fmt.Errorf("digest pre-migration backup: %w", err)
	}
	return digest, nil
}

func writeMigrationBackupReceipt(path string, receipt migrationBackupReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	receiptPath := migrationBackupReceiptPath(path)
	temporary, err := os.CreateTemp(filepath.Dir(path), ".zak-radio-migration-receipt-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }() // Best-effort cleanup; operation errors are checked separately.
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close() // Preserve the primary result while releasing resources.
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, receiptPath); err != nil {
		return fmt.Errorf("publish migration backup receipt: %w", err)
	}
	return syncDirectory(filepath.Dir(receiptPath))
}

func clearMigrationBackupReceipt(ctx context.Context, path string) error {
	receiptPath := migrationBackupReceiptPath(path)
	keep, found, err := existingProtectedBackup(
		ctx, path, currentSchemaVersion, "",
	)
	if !found && err == nil {
		return nil
	}
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	handle, err := os.Open(directory)
	if err != nil {
		return err
	}
	entries, err := handle.ReadDir(maxRetainedVolumeEntries + 1)
	_ = handle.Close() // Preserve the primary result while releasing resources.
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if len(entries) > maxRetainedVolumeEntries {
		return fmt.Errorf("retained volume exceeds entry limit while retiring migration backups")
	}
	keep = filepath.Clean(keep)
	backupPrefix := filepath.Base(path) + ".schema-v"
	for _, entry := range entries {
		candidate := filepath.Join(directory, entry.Name())
		if candidate == keep ||
			!strings.HasPrefix(entry.Name(), backupPrefix) ||
			!migrationBackupName.MatchString(entry.Name()) {
			continue
		}
		info, err := os.Lstat(candidate)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("obsolete migration backup is unsafe: %s", candidate)
		}
		if err := os.Remove(candidate); err != nil {
			return fmt.Errorf("retire obsolete migration backup: %w", err)
		}
	}
	if err := syncDirectory(directory); err != nil {
		return fmt.Errorf("sync retired migration backups: %w", err)
	}
	if err := os.Remove(receiptPath); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func syncRegularFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }() // Best-effort cleanup; operation errors are checked separately.
	return file.Sync()
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = directory.Close() }() // Best-effort cleanup; operation errors are checked separately.
	return directory.Sync()
}
