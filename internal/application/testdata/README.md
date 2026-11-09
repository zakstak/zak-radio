# Song upload fixture

`upload.mp3` is a generated 523 Hz tone, 0.35 seconds long. It contains no
recorded music or speech. Generate it with:

```sh
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'sine=frequency=523:sample_rate=44100:duration=0.35' \
  -codec:a libmp3lame -b:a 64k -write_xing 0 -map_metadata -1 \
  -y internal/application/testdata/upload.mp3
```

Upload tests decode this file without audio playback.
