package application

import (
	"os"

	"zak-radio/internal/lifecycle"
)

func acquireRuntimeVolumeLock(root string) (*os.File, error) {
	return lifecycle.AcquireRuntimeVolumeLock(root)
}
