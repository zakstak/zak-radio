package lifecycle

import "testing"

func TestRuntimeLocksExcludeMaintenanceButAllowRollingPeer(t *testing.T) {
	root := t.TempDir()
	first, err := AcquireRuntimeVolumeLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Close() }() // Best-effort cleanup; operation errors are checked separately.
	second, err := AcquireRuntimeVolumeLock(root)
	if err != nil {
		t.Fatalf("second runtime lock failed: %v", err)
	}
	if maintenance, acquireVolumeLockErr := AcquireVolumeLock(root); acquireVolumeLockErr == nil {
		_ = maintenance.Close() // Preserve the primary result while releasing resources.
		_ = second.Close()      // Preserve the primary result while releasing resources.
		t.Fatal("exclusive maintenance lock overlapped active runtimes")
	}
	if closeErr := second.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if closeErr2 := first.Close(); closeErr2 != nil {
		t.Fatal(closeErr2)
	}
	maintenance, err := AcquireVolumeLock(root)
	if err != nil {
		t.Fatalf("maintenance lock failed after runtimes stopped: %v", err)
	}
	_ = maintenance.Close() // Preserve the primary result while releasing resources.
}
