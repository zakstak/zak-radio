package lifecycle

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

const volumeLockName = ".zak-radio-volume.lock"

func AcquireVolumeLock(root string) (*os.File, error) {
	return acquireVolumeLock(root, unix.LOCK_EX, "retained volume is active or another maintenance operation owns it")
}

func AcquireRuntimeVolumeLock(root string) (*os.File, error) {
	return acquireVolumeLock(root, unix.LOCK_SH, "retained volume is unavailable for runtime use")
}

func acquireVolumeLock(root string, mode int, busyMessage string) (*os.File, error) {
	path := filepath.Join(root, volumeLockName)
	fd, err := unix.Open(path,
		unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o640)
	if err != nil {
		return nil, fmt.Errorf("open retained-volume lifecycle lock: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil ||
		stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 {
		file.Close()
		return nil, fmt.Errorf("retained-volume lifecycle lock is unsafe")
	}
	if err := unix.Flock(fd, mode|unix.LOCK_NB); err != nil {
		file.Close()
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return nil, fmt.Errorf("%s", busyMessage)
		}
		return nil, fmt.Errorf("lock retained volume: %w", err)
	}
	return file, nil
}
