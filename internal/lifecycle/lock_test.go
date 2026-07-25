package lifecycle

import "testing"

func TestRuntimeLocksExcludeMaintenanceButAllowRollingPeer(t *testing.T) {
	root := t.TempDir()
	first, err := AcquireRuntimeVolumeLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := AcquireRuntimeVolumeLock(root)
	if err != nil {
		t.Fatalf("second runtime lock failed: %v", err)
	}
	if maintenance, err := AcquireVolumeLock(root); err == nil {
		maintenance.Close()
		second.Close()
		t.Fatal("exclusive maintenance lock overlapped active runtimes")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	maintenance, err := AcquireVolumeLock(root)
	if err != nil {
		t.Fatalf("maintenance lock failed after runtimes stopped: %v", err)
	}
	maintenance.Close()
}
