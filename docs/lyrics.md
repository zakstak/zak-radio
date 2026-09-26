# Lyrics and subject metadata

Run these commands from the repository root. For normal setup and packaging,
see [README](../README.md).

Lyrics are cleaned, transcribed, and aligned offline, then promoted as immutable
release input. Source `lyrics.md` and playback audio are never rewritten.
Obvious section labels and prompt directions are removed deterministically;
ambiguous prose can be classified by the pinned local Ollama model, and songs
without source lyrics use the local HeartTranscriptor singing model.

The model environment needs CUDA PyTorch, `stable-ts`, `transformers`,
`accelerate`, and `demucs`; FFmpeg and ffprobe must be on `PATH`. Installing
`audio-separator` additionally enables the fail-soft backing-vocal pass. It uses
the local `mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt` model only
after Demucs has produced a vocal stem. If that optional model or command is
unavailable, normal alignment continues unchanged.

HeartTranscriptor is invoked with its official Whisper decoding settings. When
source coverage is weak, version 6 compares its text with stable-ts,
cross-checks timing across raw/FFmpeg/Demucs representations, and can inspect an
isolated backing-vocal stem. Missing or overlapping words are displayed only
when both local transcribers corroborate at least four words; otherwise the
player reports that alternate vocals were detected and their exact words need
review.

Run one song or the complete archive through the same engine:

```bash
python3 scripts/lyrics-harness.py song \
  --archive /path/to/music-library \
  --track-id TRACK_ID \
  --output-root /path/to/alignment-run \
  --strategy v6

python3 scripts/lyrics-harness.py bulk \
  --archive /path/to/music-library \
  --output-root /path/to/alignment-run \
  --bundle-root /path/to/validated-timed-lyrics-bundle \
  --strategy v6
```

Treat each tuning run as a proposal. Compare it with the currently accepted run
before creating a bundle:

```bash
python3 scripts/lyrics-harness.py compare \
  --archive /path/to/music-library \
  --baseline-root /path/to/accepted-run \
  --candidate-root /path/to/proposed-run \
  --report /path/to/regression-report.json \
  --bundle-root /path/to/fail-closed-bundle
```

The comparison requires identical audio, source-text, preprocessing, and cached
model evidence. It protects every high-confidence baseline word, rejects
coverage or confidence decreases, rejects non-monotonic or materially shifted
timings, and prevents new metadata-like display lines unless their words have
strong audio support. A candidate is promoted per song only when it has a
measurable improvement and no regression. Safely surfacing an independently
detected alternate vocal is an improvement even when uncertain words are
deliberately withheld. Otherwise the bundle retains the baseline; evidence
mismatches and regressions are reported as `abstain` and make the command exit
with status 2. Version 5 sidecars embed an evidence digest; version 6 also
records per-line confidence, timing consensus, and alternate-vocal state. Older
harness sidecars can be compared only while their exact model cache remains
available. The bundle destination must be absent or empty so unexamined sidecars
cannot survive from an older run.

`--preprocess auto` always scores raw audio first. It keeps the inexpensive
FFmpeg vocal-forward pass only when that measurably improves alignment, and
tries Demucs only if neither raw nor FFmpeg audio reaches the configured anchor
quality. The selected preprocessing is for analysis only.

Generated-transcript cleanup is extractive: common ASR outros and immediate duplicate sentences are removed only when independent
observed words do not support them. Metadata-like source clauses, including
short production-looking words, are restored only when local audio evidence
supports the exact words. Adversarial fixtures cover genuinely sung
boilerplate-looking phrases, repeated choruses, and one-word production-like
lyrics.

Gold audio is downloaded into the local cache and is never committed. The
Hansen/MIREX public half contains five fully annotated popular songs, each with
full-mix and a-cappella audio:

```bash
python3 scripts/lyrics-harness.py gold fetch --dataset hansen

python3 scripts/lyrics-harness.py gold run \
  --output-root ~/.cache/zak-radio-aligner/gold-predictions \
  --report ~/.cache/zak-radio-aligner/gold-report.json \
  --split held-out
```

The command runs both supplied-lyrics alignment and no-lyrics transcription
lanes and exits with status 2 when the pinned profile misses a gold gate.
JamendoLyrics adds 20 pinned, Creative Commons English full mixes with manual
word timestamps and metadata for genre, overlapping lyrics, polyphony, and
non-lexical singing. The fetch verifies every file checksum and retains the
upstream license and per-song license catalog:

```bash
python3 scripts/lyrics-harness.py gold fetch --dataset jamendo

python3 scripts/lyrics-harness.py gold run \
  --dataset jamendo \
  --output-root ~/.cache/zak-radio-aligner/gold-predictions-jamendo \
  --report ~/.cache/zak-radio-aligner/gold-report-jamendo.json \
  --split held-out \
  --representation mix \
  --strategy v6
```

Jamendo’s fixed split is derived from each stable song ID, so reruns and
machines evaluate the same development and held-out songs. Gold reports also
break onset accuracy into fixed ASR-confidence bands so per-line uncertainty can
be calibrated against known word timestamps. MUSDB18 can also be fetched for
source-separation and genre-diversity experiments (it is not part of the
automated word-timing runner), but its educational-use license must be
acknowledged explicitly:

```bash
python3 scripts/lyrics-harness.py gold fetch \
  --dataset musdb18 \
  --accept-educational-license
```

Missing or weak imported titles can be replaced with locally generated song
titles. The curator prefers cleaned or locally transcribed lyrics from the
alignment run, then source lyrics, then the prompt for a lyricless instrumental.
It never replaces a usable curated title and talks only to the configured local
Ollama endpoint:

```bash
python3 scripts/generate-track-subjects.py \
  --archive /path/to/music-library \
  --curated /path/to/curated-tracks.json \
  --timed-lyrics-root /path/to/alignment-run \
  --output /path/to/validated-timed-lyrics-bundle/subjects.json
```

Pass `--track-id TRACK_ID` for a song-level canary; omit it to generate every
missing or weak title in bulk. The resulting `subjects.json` records the
evidence kind and digest used for each generated title.
