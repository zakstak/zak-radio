package application

import (
	"bytes"
	"context"
	"errors"
	"io"

	"github.com/hajimehoshi/go-mp3"
)

// Check complete Layer III frames before decoding: the decoder deliberately
// tolerates truncated final frames, which is unsuitable for upload admission.
func validateSongMP3(ctx context.Context, data []byte) (duration float64, err error) {
	invalid := errors.New("audio must be a complete, playable MP3 (MPEG-1 or MPEG-2 Layer III), up to 20 minutes")
	// Malformed external bitstreams must not panic the HTTP server.
	defer func() {
		if recover() != nil {
			duration, err = 0, invalid
		}
	}()
	offset := 0
	if len(data) >= 10 && string(data[:3]) == "ID3" {
		if (data[3] != 3 && data[3] != 4) || data[4] == 255 {
			return 0, invalid
		}
		size := 0
		for _, b := range data[6:10] {
			if b&0x80 != 0 {
				return 0, invalid
			}
			size = size<<7 | int(b)
		}
		offset = size + 10
		if data[3] == 4 && data[5]&0x10 != 0 {
			offset += 10
		}
	}
	sampleRate, samples := 0, int64(0)
	for offset < len(data) {
		if contextErr := ctx.Err(); contextErr != nil {
			return 0, contextErr
		}
		if len(data)-offset == 128 && string(data[offset:offset+3]) == "TAG" {
			offset = len(data)
			break
		}
		if len(data)-offset < 4 {
			return 0, invalid
		}
		h := data[offset : offset+4]
		version := (h[1] >> 3) & 3
		layer := (h[1] >> 1) & 3
		bitrateIndex, rateIndex := int(h[2]>>4), int((h[2]>>2)&3)
		if h[0] != 255 || h[1]&0xe0 != 0xe0 || (version != 3 && version != 2) || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3 {
			return 0, invalid
		}
		rate := [...]int{44100, 48000, 32000}[rateIndex]
		bitrate := [...]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}[bitrateIndex]
		frameSamples, coefficient := 1152, 144000
		if version == 2 {
			rate /= 2
			bitrate = [...]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}[bitrateIndex]
			frameSamples, coefficient = 576, 72000
		}
		if sampleRate != 0 && sampleRate != rate {
			return 0, invalid
		}
		sampleRate = rate
		frameSize := coefficient*bitrate/rate + int((h[2]>>1)&1)
		if frameSize < 4 || frameSize > len(data)-offset {
			return 0, invalid
		}
		offset += frameSize
		samples += int64(frameSamples)
		if samples > int64(rate*maxSongDuration) {
			return 0, invalid
		}
	}
	if offset != len(data) || sampleRate == 0 || samples < int64(float64(sampleRate)*minTrackDuration) {
		return 0, invalid
	}
	decoder, err := mp3.NewDecoder(&songContextReader{ctx: ctx, reader: bytes.NewReader(data)})
	if err != nil {
		return 0, invalid
	}
	// The decoder always produces signed 16-bit stereo PCM, including for mono.
	decoded, err := io.Copy(io.Discard, io.LimitReader(decoder, samples*4+1))
	if err != nil || decoded != samples*4 {
		return 0, invalid
	}
	return float64(samples) / float64(sampleRate), nil
}

type songContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *songContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
