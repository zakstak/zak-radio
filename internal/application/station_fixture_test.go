package application

import (
	"context"
	"testing"
)

// createTemporaryStationForTest provides unique credentials for independent fixture stations.
func createTemporaryStationForTest(t *testing.T, service *StationService, ctx context.Context, trackID, creatorBucket string) (string, string, float64, error) {
	t.Helper()
	key, err := randomHex(16)
	if err != nil {
		return "", "", 0, err
	}
	token, err := randomHex(24)
	if err != nil {
		return "", "", 0, err
	}
	return service.CreateIdempotent(ctx, trackID, creatorBucket, key, token)
}
