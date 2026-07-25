#!/usr/bin/env python3
"""Generate validated, audio-derived lyric timing sidecars for Zak Radio.

The source lyrics remain untouched. Stable-ts first transcribes the performed
vocals with word timestamps, using Demucs vocal isolation and Silero VAD by
default. The generator then maps only exact, ordered words from lyrics.md onto
that observed timeline. It never asks a language model to invent timestamps or
forces an unsung written line onto the audio.

Outputs mirror the archive tree beneath --output-root so they can be reviewed
and promoted independently of the recovered source archive. A timing-report.json
records every success and failure in the current run.
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SECTION_RE = re.compile(r"^\[([^\[\]\n]{1,160})\]$")
WORD_RE = re.compile(r"[\w]+(?:['’][\w]+)?", re.UNICODE)
COMMENTARY_RE = re.compile(
    r"^(?:"
    r"What I (?:fixed|changed)|"
    r"One small improvement|"
    r"Here['’]s (?:that|the) |"
    r"So if you want |"
    r"For Suno, |"
    r"\d+\.\s+(?:Added|Standardized|Kept|Removed)\b"
    r")",
    re.IGNORECASE,
)
PRODUCTION_CUE_RE = re.compile(
    r"\b(?:"
    r"ambient|arpeggiat|arrangement|bass|beat|breath|click|drum|fade|"
    r"guitar|hat|instrument|kick|lead|melody|music|pad|reverb|room tone|"
    r"sax|sfx|silence|solo|swell|synth|vocalise"
    r")\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CandidateLine:
    source_line: int
    section: str
    text: str
    words: tuple[str, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument(
        "--bundle-root",
        type=Path,
        help="also export validated sidecars as <track-id>.json files",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path.home() / ".cache/zak-radio-aligner/models",
    )
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--track-id", action="append", default=[])
    parser.add_argument("--max-tracks", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--without-denoiser", action="store_true")
    parser.add_argument("--without-vad", action="store_true")
    parser.add_argument("--verbose-model", action="store_true")
    return parser.parse_args()


def normalized_word(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def is_production_cue(value: str) -> bool:
    stripped = value.strip()
    if not (stripped.startswith("(") and stripped.endswith(")")):
        return False
    return bool(PRODUCTION_CUE_RE.search(stripped))


def candidate_lines(text: str) -> list[CandidateLine]:
    result: list[CandidateLine] = []
    section = ""
    saw_content = False
    for source_line, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        line = raw.strip()
        if not line:
            continue
        if saw_content and COMMENTARY_RE.match(line):
            break
        section_match = SECTION_RE.match(line)
        if section_match:
            section = section_match.group(1).strip()
            saw_content = True
            continue
        if line.upper() in {"LYRICS:", "STYLE:"}:
            continue
        if not saw_content and (
            line.startswith("#")
            or re.match(r"^(?:title|style)\s*:", line, re.IGNORECASE)
        ):
            continue
        if is_production_cue(line):
            saw_content = True
            continue
        words = tuple(WORD_RE.findall(line))
        if not words:
            continue
        result.append(CandidateLine(source_line, section, line, words))
        saw_content = True
    return result


def output_path(output_root: Path, organized_dir: str) -> Path:
    relative = Path(organized_dir)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("organized_dir escapes archive")
    return output_root / relative / "lyrics.timed.json"


def existing_matches(path: Path, track: dict[str, Any]) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        payload.get("version") == 1
        and payload.get("track_id") == track["id"]
        and payload.get("audio_sha256") == track["audio_sha256"]
        and bool(payload.get("cues"))
    )


def bundle_eligible(payload: dict[str, Any]) -> bool:
    quality = payload.get("quality") or {}
    cues = payload.get("cues") or []
    line_coverage = float(quality.get("line_coverage") or 0)
    mean_confidence = float(quality.get("mean_confidence") or 0)
    return (
        line_coverage >= 0.2
        and mean_confidence >= 0.7
        and (len(cues) >= 2 or line_coverage >= 0.8)
    )


def load_tracks(
    archive: Path, selected: set[str], maximum: int
) -> list[dict[str, Any]]:
    payload = json.loads((archive / "index.json").read_text(encoding="utf-8"))
    tracks = payload.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("archive index has no tracks array")
    result = []
    for track in tracks:
        if selected and track.get("id") not in selected:
            continue
        if not isinstance(track.get("organized_dir"), str):
            raise ValueError("track has no organized_dir")
        result.append(track)
        if maximum and len(result) >= maximum:
            break
    missing = selected - {str(track.get("id")) for track in result}
    if missing:
        raise ValueError(f"unknown track ids: {', '.join(sorted(missing))}")
    return result


def flatten_result_words(result: Any) -> list[dict[str, Any]]:
    flattened = []
    for segment in result.segments:
        for word in segment.words:
            flattened.append(
                {
                    "text": str(word.word).strip(),
                    "normalized": normalized_word(str(word.word)),
                    "start": float(word.start),
                    "end": float(word.end),
                    "confidence": max(0.0, min(1.0, float(word.probability or 0))),
                }
            )
    return [word for word in flattened if word["normalized"]]


def timed_cues(
    candidates: list[CandidateLine], result: Any, duration: float
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    original_words: list[str] = []
    word_owners: list[int] = []
    original_spellings: list[str] = []
    for line_index, line in enumerate(candidates):
        for word in line.words:
            original_words.append(normalized_word(word))
            original_spellings.append(word)
            word_owners.append(line_index)

    matched_by_line: list[list[dict[str, Any]]] = [[] for _ in candidates]
    if len(result.segments) == len(candidates):
        for line_index, (line, segment) in enumerate(
            zip(candidates, result.segments, strict=True)
        ):
            segment_words = []
            for word in segment.words:
                normalized = normalized_word(str(word.word))
                if normalized:
                    segment_words.append(
                        {
                            "text": str(word.word).strip(),
                            "normalized": normalized,
                            "start": float(word.start),
                            "end": float(word.end),
                            "confidence": max(
                                0.0, min(1.0, float(word.probability or 0))
                            ),
                        }
                    )
            line_words = [normalized_word(word) for word in line.words]
            matcher = difflib.SequenceMatcher(
                None,
                line_words,
                [word["normalized"] for word in segment_words],
                autojunk=False,
            )
            for block in matcher.get_matching_blocks():
                for offset in range(block.size):
                    original_index = block.a + offset
                    word = dict(segment_words[block.b + offset])
                    word["text"] = line.words[original_index]
                    matched_by_line[line_index].append(word)
    else:
        aligned_words = flatten_result_words(result)
        matcher = difflib.SequenceMatcher(
            None,
            original_words,
            [word["normalized"] for word in aligned_words],
            autojunk=False,
        )
        for block in matcher.get_matching_blocks():
            for offset in range(block.size):
                original_index = block.a + offset
                aligned_index = block.b + offset
                word = dict(aligned_words[aligned_index])
                word["text"] = original_spellings[original_index]
                matched_by_line[word_owners[original_index]].append(word)

    cues: list[dict[str, Any]] = []
    matched_words = 0
    confidence_total = 0.0
    previous_start = -1.0
    partial_lines = 0
    for line, words in zip(candidates, matched_by_line, strict=True):
        usable = [
            word
            for word in words
            if math.isfinite(word["start"])
            and math.isfinite(word["end"])
            and word["start"] >= 0
            and word["end"] > word["start"]
            and word["end"] <= duration + 0.25
        ]
        coverage = len(usable) / len(line.words)
        if coverage < 0.6 or not usable:
            continue
        start = min(word["start"] for word in usable)
        end = max(word["end"] for word in usable)
        maximum_gap = max(
            (
                usable[index]["start"] - usable[index - 1]["end"]
                for index in range(1, len(usable))
            ),
            default=0,
        )
        if maximum_gap > 4 or end - start > max(8, len(line.words) * 2.5):
            continue
        if start < previous_start or end <= start:
            continue
        if coverage < 0.999:
            partial_lines += 1
        previous_start = start
        matched_words += len(usable)
        confidence_total += sum(word["confidence"] for word in usable)
        cues.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "section": line.section,
                "text": line.text,
                "words": [
                    {
                        "start": round(word["start"], 3),
                        "end": round(word["end"], 3),
                        "text": word["text"],
                        "confidence": round(word["confidence"], 4),
                    }
                    for word in usable
                ],
                "_source_line": line.source_line,
            }
        )

    for index, cue in enumerate(cues[:-1]):
        next_start = cues[index + 1]["start"]
        cue["end"] = round(min(cue["end"], max(cue["start"] + 0.05, next_start)), 3)
        cue["words"] = [
            word for word in cue["words"] if word["end"] <= cue["end"] + 0.05
        ]

    warnings = []
    omitted = len(candidates) - len(cues)
    if omitted:
        warnings.append(f"{omitted} written lines had no reliable audio match")
    if partial_lines:
        warnings.append(f"{partial_lines} lines were only partially matched")
    total_words = len(original_words)
    quality = {
        "candidate_lines": len(candidates),
        "aligned_lines": len(cues),
        "line_coverage": round(len(cues) / len(candidates), 4) if candidates else 0,
        "word_coverage": round(matched_words / total_words, 4) if total_words else 0,
        "mean_confidence": round(confidence_total / matched_words, 4)
        if matched_words
        else 0,
        "warnings": warnings,
    }
    for cue in cues:
        cue.pop("_source_line", None)
    return cues, quality


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode()
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    with temporary.open("xb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def export_bundle(
    output_root: Path,
    bundle_root: Path,
    tracks: list[dict[str, Any]],
) -> int:
    exported = 0
    for track in tracks:
        source = output_path(output_root, track["organized_dir"])
        if not existing_matches(source, track):
            continue
        payload = json.loads(source.read_text(encoding="utf-8"))
        if not bundle_eligible(payload):
            continue
        write_json_atomic(bundle_root / f"{track['id']}.json", payload)
        exported += 1
    return exported


def main() -> int:
    args = parse_args()
    archive = args.archive.resolve()
    output_root = args.output_root.resolve()
    tracks = load_tracks(archive, set(args.track_id), args.max_tracks)
    pending = [
        track
        for track in tracks
        if args.force
        or not existing_matches(output_path(output_root, track["organized_dir"]), track)
    ]
    bundle_root = args.bundle_root.resolve() if args.bundle_root else None
    print(
        json.dumps(
            {
                "event": "start",
                "tracks": len(tracks),
                "pending": len(pending),
                "model": args.model,
                "denoiser": not args.without_denoiser,
                "vad": not args.without_vad,
            }
        ),
        flush=True,
    )
    if not pending:
        if bundle_root:
            print(
                json.dumps(
                    {
                        "event": "bundle",
                        "exported": export_bundle(output_root, bundle_root, tracks),
                    }
                ),
                flush=True,
            )
        return 0

    import stable_whisper
    import torch

    args.model_dir.mkdir(parents=True, exist_ok=True)
    model = stable_whisper.load_model(
        args.model,
        device="cuda",
        download_root=str(args.model_dir),
    )
    failures = 0
    outcomes: list[dict[str, Any]] = []
    started = time.monotonic()
    for number, track in enumerate(pending, 1):
        track_started = time.monotonic()
        try:
            directory = archive / track["organized_dir"]
            audio = directory / "audio.mp3"
            lyrics = directory / "lyrics.md"
            candidates = candidate_lines(lyrics.read_text(encoding="utf-8"))
            if not candidates:
                raise ValueError("lyrics contain no alignable lines")
            transcribe_options: dict[str, Any] = {
                "language": "en",
                "verbose": args.verbose_model,
                "vad": not args.without_vad,
                "word_timestamps": True,
            }
            if not args.without_denoiser:
                transcribe_options["denoiser"] = "demucs"
            result = model.transcribe(str(audio), **transcribe_options)
            if result is None:
                raise RuntimeError("transcription returned no result")
            duration = float(track["duration"])
            cues, quality = timed_cues(candidates, result, duration)
            if not cues:
                raise RuntimeError("no written lines matched the audio")
            payload = {
                "version": 1,
                "track_id": track["id"],
                "audio_sha256": track["audio_sha256"],
                "duration": duration,
                "language": "en",
                "generator": {
                    "name": "zak-radio-local-aligner",
                    "method": "performed-vocals-sequence-match",
                    "stable_ts": stable_whisper.__version__,
                    "model": args.model,
                    "denoiser": "demucs" if not args.without_denoiser else "none",
                    "vad": not args.without_vad,
                    "device": torch.cuda.get_device_name(0),
                },
                "quality": quality,
                "cues": cues,
            }
            destination = output_path(output_root, track["organized_dir"])
            write_json_atomic(destination, payload)
            outcome = {
                "id": track["id"],
                "status": "generated",
                "path": str(destination.relative_to(output_root)),
                "cues": len(cues),
                "line_coverage": quality["line_coverage"],
                "word_coverage": quality["word_coverage"],
                "mean_confidence": quality["mean_confidence"],
                "seconds": round(time.monotonic() - track_started, 2),
            }
            outcomes.append(outcome)
            print(
                json.dumps(
                    {
                        "event": "track",
                        "number": number,
                        "pending": len(pending),
                        **outcome,
                    }
                ),
                flush=True,
            )
        except Exception as error:
            failures += 1
            outcomes.append(
                {
                    "id": track.get("id"),
                    "status": "failed",
                    "error": str(error),
                    "seconds": round(time.monotonic() - track_started, 2),
                }
            )
            print(
                json.dumps(
                    {
                        "event": "error",
                        "number": number,
                        "pending": len(pending),
                        "id": track.get("id"),
                        "error": str(error),
                    }
                ),
                file=sys.stderr,
                flush=True,
            )
    write_json_atomic(
        output_root / "timing-report.json",
        {
            "version": 1,
            "model": args.model,
            "method": "performed-vocals-sequence-match",
            "device": torch.cuda.get_device_name(0),
            "processed": len(pending),
            "generated": len(pending) - failures,
            "failures": failures,
            "seconds": round(time.monotonic() - started, 2),
            "tracks": outcomes,
        },
    )
    if bundle_root:
        print(
            json.dumps(
                {
                    "event": "bundle",
                    "exported": export_bundle(output_root, bundle_root, tracks),
                }
            ),
            flush=True,
        )
    print(
        json.dumps(
            {
                "event": "complete",
                "processed": len(pending),
                "failures": failures,
                "seconds": round(time.monotonic() - started, 2),
            }
        ),
        flush=True,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
