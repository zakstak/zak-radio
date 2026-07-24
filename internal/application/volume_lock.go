package application

import (
	"os"

	"zak-radio-apphost/internal/lifecycle"
)

func acquireRuntimeVolumeLock(root string) (*os.File, error) {
	return lifecycle.AcquireVolumeLock(root)
}
