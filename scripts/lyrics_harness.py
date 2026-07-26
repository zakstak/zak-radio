#!/usr/bin/env python3
"""Offline lyric cleaning, transcription, alignment, and gold evaluation.

The harness never edits an archive. It writes versioned sidecars and diagnostic
reports beneath an explicit output root. Heavy model imports are intentionally
lazy so parsing, scoring, and gold-metric tests run without a GPU environment.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Sequence


HARNESS_VERSION = "6"
MODEL_CACHE_VERSION = "3"
DEFAULT_MODEL_DIR = Path.home() / ".cache/zak-radio-aligner/models"
DEFAULT_CACHE_ROOT = Path.home() / ".cache/zak-radio-aligner"
DEFAULT_PROFILE = (
    Path(__file__).resolve().parent.parent / "testdata/lyrics-gold/profile-v1.json"
)
DEFAULT_GOLD_MANIFEST = (
    Path(__file__).resolve().parent.parent / "testdata/lyrics-gold/manifest.json"
)
SOURCE_MISMATCH_COVERAGE = 0.30
SUPPLEMENTAL_TRIGGER_COVERAGE = 0.75
SUPPLEMENTAL_PHRASE_COVERAGE = 0.75
SUPPLEMENTAL_MINIMUM_CONFIDENCE = 0.65
BACKING_PHRASE_COVERAGE = 0.55
BACKING_MINIMUM_MATCHED_WORDS = 4
BACKING_VOCAL_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
CONSENSUS_MAXIMUM_SPREAD = 0.50
LOCAL_REPAIR_MINIMUM_SHIFT = 0.50
LOCAL_REPAIR_MAXIMUM_SHIFT = 0.50
LINE_VERIFIED_COVERAGE = 0.75
LINE_VERIFIED_CONFIDENCE = 0.65

WORD_RE = re.compile(r"[\w]+(?:['’][\w]+)?", re.UNICODE)
MARKDOWN_EDGE_RE = re.compile(r"^(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)$")
SECTION_PREFIX_RE = re.compile(
    r"^(?:"
    r"final[\s-]+"
    r")?(?:"
    r"verse|chorus|pre[\s-]?chorus|post[\s-]?chorus|hook|bridge|"
    r"intro|outro|refrain|breakdown|interlude|instrumental|solo|"
    r"drop|build|ending|spoken|rap"
    r")\b",
    re.IGNORECASE,
)
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
    r"accordion|ambient|arpeggiat|arrangement|backing vocal|bass|beat|breath|"
    r"chant|clap|click|double(?:d)?|drum|echo|fade|fiddle|filter|guitar|"
    r"harmon(?:y|ies)|hat|instrument|kick|lead vocal|melody|music|pad|pause|"
    r"piano|repeat|reverb|rhythmic|room tone|sax|sfx|silence|solo|stomp|"
    r"swell|synth|tempo|tribal|vocalise|whisper(?:ed)?|wind noise"
    r")\b",
    re.IGNORECASE,
)
PROMPT_PROSE_RE = re.compile(
    r"\b(?:"
    r"bpm|genre|key signature|male vocalist|female vocalist|production|"
    r"song should|vocal style|make (?:the|this)|use (?:a|an|the)|"
    r"slightly bigger|builds? into|in the style"
    r")\b",
    re.IGNORECASE,
)
GENERIC_TRANSCRIPT_RE = re.compile(
    r"(?:"
    r"\bthank you(?: so much)? for (?:listening|tuning in)\b|"
    r"\bwe hope you enjoyed (?:this|the) (?:beat|song|music|track)\b|"
    r"\bthanks for (?:listening|watching)\b|"
    r"\bsubscribe (?:for|to) (?:more|the channel)\b"
    r")",
    re.IGNORECASE,
)
RECOVERABLE_METADATA_REASONS = frozenset(
    {
        "local-text-model",
        "production-direction",
        "production-prose",
        "production-duration",
        "prompt-prose",
        "section-production-direction",
    }
)
PRODUCTION_SENTENCE_RE = re.compile(
    r"^(?:"
    r"no lyrics\b|"
    r"(?:low )?(?:drums?|fiddle|accordion|wind noise)\b|"
    r"(?:boot|crew) stomp\b|"
    r"crew (?:humming|chanting)\b|"
    r"then layered chant\b|"
    r"chant \(|"
    r"rhythmic\b|"
    r"this is where (?:it|the) (?:vibes?|builds?)\b"
    r")",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CandidateLine:
    source_line: int
    section: str
    text: str
    words: tuple[str, ...]
    origin: str = "source"


@dataclass(frozen=True)
class LineDecision:
    source_line: int
    original: str
    normalized: str
    decision: str
    reason: str
    section: str = ""


@dataclass(frozen=True)
class CleanedLyrics:
    lines: tuple[CandidateLine, ...]
    display_text: str
    decisions: tuple[LineDecision, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class Profile:
    language: str = "en"
    stable_model: str = "turbo"
    heart_model: str = "HeartMuLa/HeartTranscriptor-oss"
    heart_revision: str = "918f88917c17489c1f8dbae0165cd1019c4d5cd3"
    text_model: str = "gemma4:e4b"
    text_model_url: str = "http://127.0.0.1:11434/api/generate"
    window_lines: int = 6
    line_initial_offset: float = 0.5
    candidate_improvement: float = 0.05
    minimum_anchor_score: float = 0.70
    verified_line_coverage: float = 0.80
    verified_word_coverage: float = 0.75
    verified_confidence: float = 0.70

    @classmethod
    def load(cls, path: Path | None) -> "Profile":
        if path is None:
            return cls()
        payload = json.loads(path.read_text(encoding="utf-8"))
        supported = set(cls.__dataclass_fields__)
        unknown = sorted(set(payload) - supported)
        if unknown:
            raise ValueError(f"unknown profile keys: {', '.join(unknown)}")
        return cls(**payload)


@dataclass(frozen=True)
class ObservedWord:
    text: str
    normalized: str
    start: float
    end: float
    confidence: float


@dataclass
class AudioCandidate:
    name: str
    path: Path
    raw_transcript: str = ""
    transcript: str = ""
    observed: list[ObservedWord] | None = None
    stable_result: Any = None
    score: float = 0.0
    score_details: dict[str, float] | None = None
    accepted: bool = False
    cache_hit: bool = False
    warning: str = ""
    error: str = ""


def normalized_word(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def tokenize(value: str) -> list[str]:
    return [
        word
        for word in (normalized_word(item) for item in WORD_RE.findall(value))
        if word
    ]


def _markdown_unwrap(value: str) -> str:
    line = value.strip()
    while True:
        match = MARKDOWN_EDGE_RE.match(line)
        if not match:
            break
        line = match.group(1).strip()
    return line


def _section_name(value: str) -> str:
    line = _markdown_unwrap(value)
    heading = bool(re.match(r"^#{1,6}\s*", line))
    line = re.sub(r"^#{1,6}\s*", "", line).strip()
    bracketed = re.fullmatch(r"\[([^\[\]\n]{1,200})\]", line)
    if bracketed:
        line = bracketed.group(1).strip()
    line = line.rstrip(":").strip()
    if (bracketed or heading) and SECTION_PREFIX_RE.match(line):
        return line
    if re.fullmatch(
        r"(?:final[\s-]+)?(?:"
        r"verse|chorus|pre[\s-]?chorus|post[\s-]?chorus|hook|bridge|"
        r"intro|outro|refrain|breakdown|interlude|instrumental|solo|"
        r"drop|build|ending|spoken|rap"
        r")(?:\s+\d+)?",
        line,
        re.IGNORECASE,
    ):
        return line
    return ""


def is_production_cue(value: str) -> bool:
    stripped = _markdown_unwrap(value).strip()
    enclosed = len(stripped) >= 2 and (stripped[0], stripped[-1]) in {
        ("(", ")"),
        ("[", "]"),
    }
    return enclosed and bool(PRODUCTION_CUE_RE.search(stripped))


def _looks_like_prompt_prose(value: str) -> bool:
    words = WORD_RE.findall(value)
    return bool(PROMPT_PROSE_RE.search(value)) and (
        len(words) >= 10 or any(mark in value for mark in (":", ";", "—"))
    )


def _display_text(lines: Sequence[CandidateLine]) -> str:
    parts: list[str] = []
    previous: CandidateLine | None = None
    for line in lines:
        if previous and (
            line.section != previous.section
            or line.source_line > previous.source_line + 1
        ):
            if parts and parts[-1] != "":
                parts.append("")
        parts.append(line.text)
        previous = line
    return "\n".join(parts).strip()


class OllamaLineClassifier:
    """Classify ambiguous source lines without permitting text generation."""

    def __init__(self, model: str, url: str, timeout: float = 5.0):
        self.model = model
        self.url = url
        self.timeout = timeout
        self.disabled_error = ""

    def __call__(self, lines: Sequence[tuple[int, str]]) -> dict[int, str]:
        if not lines:
            return {}
        if self.disabled_error:
            raise OSError(self.disabled_error)
        prompt = (
            "Classify each exact input line as lyrics or metadata. Lyrics are words "
            "actually sung, including ad-libs. Metadata includes section labels, "
            "arrangement directions, style prompts, and editorial prose. Do not "
            "rewrite text. Return only a JSON object mapping each numeric id to "
            '"lyrics" or "metadata".\n\n'
            + "\n".join(f"{number}: {json.dumps(text)}" for number, text in lines)
        )
        request = urllib.request.Request(
            self.url,
            data=json.dumps(
                {
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0},
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read())
        except Exception as error:
            self.disabled_error = str(error)
            raise
        result = json.loads(payload["response"])
        decisions: dict[int, str] = {}
        expected = {number for number, _ in lines}
        for key, value in result.items():
            number = int(key)
            if number in expected and value in {"lyrics", "metadata"}:
                decisions[number] = value
        if set(decisions) != expected:
            raise ValueError("local text model returned an incomplete classification")
        return decisions


def clean_lyrics(
    text: str,
    classifier: Callable[[Sequence[tuple[int, str]]], dict[int, str]] | None = None,
) -> CleanedLyrics:
    result: list[CandidateLine] = []
    decisions: list[LineDecision] = []
    ambiguous: list[tuple[int, str, str, str]] = []
    section = ""
    saw_content = False
    stop_after_commentary = False

    for source_line, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        original = raw
        line = raw.strip()
        if not line:
            continue
        normalized = _markdown_unwrap(line)
        if saw_content and COMMENTARY_RE.match(normalized):
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "editorial-tail"
                )
            )
            stop_after_commentary = True
            continue
        if stop_after_commentary:
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "after-editorial-tail",
                )
            )
            continue
        next_section = _section_name(line)
        if next_section:
            section = next_section
            saw_content = True
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "section-label",
                    section,
                )
            )
            continue
        if normalized.upper() in {"LYRICS:", "LYRICS", "STYLE:", "STYLE", "PROMPT:"}:
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "field-label"
                )
            )
            continue
        if re.match(r"^[^\w]*(?:title|style|genre|tempo|key)\s*:", normalized, re.I):
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "prompt-field"
                )
            )
            continue
        if normalized.startswith("#"):
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "markdown-heading"
                )
            )
            continue
        if re.fullmatch(r"\[[^\[\]\n]{1,240}\]", normalized):
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "bracketed-direction"
                )
            )
            continue
        if is_production_cue(normalized):
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "production-direction",
                )
            )
            saw_content = True
            continue
        if PRODUCTION_SENTENCE_RE.match(normalized):
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "production-prose",
                )
            )
            saw_content = True
            continue
        if re.match(
            r"^(?:instrumental|outro)\b", section, re.IGNORECASE
        ) and re.fullmatch(
            r"(?:stomp|clap|low hum|wind)[.!…]*", normalized, re.IGNORECASE
        ):
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "section-production-direction",
                )
            )
            continue
        if re.match(
            r"^let it groove for \d+(?:[–-]\d+)? seconds?[.!…]*$",
            normalized,
            re.IGNORECASE,
        ):
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "production-duration",
                )
            )
            continue
        if (
            re.match(r"^(?:instrumental|intro|outro)\b", section, re.IGNORECASE)
            and len(WORD_RE.findall(normalized)) >= 2
            and len(WORD_RE.findall(normalized)) <= 4
            and PRODUCTION_CUE_RE.search(normalized)
            and not re.match(r"^\([^)]{1,30}\)\s+\S", normalized)
        ):
            decisions.append(
                LineDecision(
                    source_line,
                    original,
                    normalized,
                    "metadata",
                    "section-production-direction",
                )
            )
            continue
        if _looks_like_prompt_prose(normalized):
            decisions.append(
                LineDecision(
                    source_line, original, normalized, "metadata", "prompt-prose"
                )
            )
            continue
        words = tuple(WORD_RE.findall(normalized))
        if not words:
            decisions.append(
                LineDecision(source_line, original, normalized, "metadata", "no-words")
            )
            continue

        # Long prose-like lines are the only cases delegated to the optional
        # local classifier. Ordinary lyric lines remain deterministic.
        if len(words) >= 22 and re.search(r"[,;:—]", normalized):
            ambiguous.append((source_line, original, normalized, section))
            continue
        candidate = CandidateLine(source_line, section, normalized, words)
        result.append(candidate)
        decisions.append(
            LineDecision(
                source_line, original, normalized, "lyrics", "deterministic", section
            )
        )
        saw_content = True

    warnings: list[str] = []
    model_decisions: dict[int, str] = {}
    if ambiguous and classifier:
        try:
            model_decisions = classifier(
                [(number, value) for number, _, value, _ in ambiguous]
            )
        except (
            OSError,
            ValueError,
            KeyError,
            json.JSONDecodeError,
            urllib.error.URLError,
        ) as error:
            warnings.append(f"local text classification unavailable: {error}")
    elif ambiguous:
        warnings.append(
            f"{len(ambiguous)} ambiguous lines preserved without model classification"
        )

    for source_line, original, normalized, line_section in ambiguous:
        decision = model_decisions.get(source_line, "lyrics")
        if decision == "lyrics":
            result.append(
                CandidateLine(
                    source_line,
                    line_section,
                    normalized,
                    tuple(WORD_RE.findall(normalized)),
                )
            )
        decisions.append(
            LineDecision(
                source_line,
                original,
                normalized,
                decision,
                "local-text-model"
                if source_line in model_decisions
                else "safe-fallback",
                line_section,
            )
        )
    result.sort(key=lambda item: item.source_line)
    decisions.sort(key=lambda item: item.source_line)
    return CleanedLyrics(
        tuple(result),
        _display_text(result),
        tuple(decisions),
        tuple(warnings),
    )


def candidate_lines(text: str) -> list[CandidateLine]:
    """Compatibility helper used by the original deterministic tests."""

    return list(clean_lyrics(text).lines)


def output_path(output_root: Path, organized_dir: str) -> Path:
    relative = Path(organized_dir)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("organized_dir escapes archive")
    return output_root / relative / "lyrics.timed.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_sha256(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def model_evidence(
    track: dict[str, Any],
    source_lyrics_sha256: str,
    selected: AudioCandidate,
) -> dict[str, Any]:
    observed = [asdict(word) for word in selected.observed or []]
    model_output_sha256 = canonical_json_sha256(
        {
            "raw_transcript": selected.raw_transcript,
            "observed": observed,
            "warning": selected.warning,
        }
    )
    evidence = {
        "version": 1,
        "audio_sha256": str(track["audio_sha256"]),
        "source_lyrics_sha256": source_lyrics_sha256,
        "selected_preprocessing": selected.name,
        "selected_audio_sha256": sha256_file(selected.path),
        "model_output_sha256": model_output_sha256,
    }
    evidence["sha256"] = canonical_json_sha256(evidence)
    return evidence


def model_evidence_set(
    track: dict[str, Any],
    source_lyrics_sha256: str,
    selected: AudioCandidate,
    candidates: Sequence[AudioCandidate],
    supplemental: AudioCandidate | None,
) -> dict[str, Any]:
    """Freeze every representation used by either side of a v5/v6 comparison."""

    representations = []
    for candidate in sorted(candidates, key=lambda item: item.name):
        if candidate.error or not candidate.path.is_file():
            continue
        representations.append(
            {
                "name": candidate.name,
                "audio_sha256": sha256_file(candidate.path),
                "model_output_sha256": canonical_json_sha256(
                    {
                        "observed": [asdict(word) for word in candidate.observed or []],
                        "warning": candidate.warning,
                    }
                ),
            }
        )
    evidence = {
        "version": 2,
        "audio_sha256": str(track["audio_sha256"]),
        "source_lyrics_sha256": source_lyrics_sha256,
        "selected_preprocessing": selected.name,
        "representations": representations,
        "supplemental_model_output_sha256": (
            canonical_json_sha256(
                {
                    "raw_transcript": supplemental.raw_transcript,
                    "observed": [asdict(word) for word in supplemental.observed or []],
                    "warning": supplemental.warning,
                }
            )
            if supplemental
            else ""
        ),
    }
    evidence["sha256"] = canonical_json_sha256(evidence)
    return evidence


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode()
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    with temporary.open("xb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def existing_matches(path: Path, track: dict[str, Any]) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        payload.get("version") in {1, 2}
        and payload.get("track_id") == track["id"]
        and payload.get("audio_sha256") == track["audio_sha256"]
        and (
            payload.get("version") == 1
            or (payload.get("generator") or {}).get("version") == HARNESS_VERSION
        )
        and (
            bool(payload.get("cues"))
            or bool(str(payload.get("display_text") or "").strip())
        )
    )


def bundle_eligible(payload: dict[str, Any]) -> bool:
    if payload.get("version") == 2:
        return bool(payload.get("cues")) or bool(
            str(payload.get("display_text") or "").strip()
        )
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
    archive: Path, selected: set[str] | None = None, maximum: int = 0
) -> list[dict[str, Any]]:
    selected = selected or set()
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
    for segment in getattr(result, "segments", []):
        for word in getattr(segment, "words", []):
            normalized = normalized_word(str(word.word))
            if not normalized:
                continue
            flattened.append(
                {
                    "text": str(word.word).strip(),
                    "normalized": normalized,
                    "start": float(word.start),
                    "end": float(word.end),
                    "confidence": max(
                        0.0, min(1.0, float(getattr(word, "probability", 0) or 0))
                    ),
                }
            )
    return flattened


def observed_words(result: Any) -> list[ObservedWord]:
    return [ObservedWord(**item) for item in flatten_result_words(result)]


def timed_cues(
    candidates: Sequence[CandidateLine], result: Any, duration: float
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
    segments = list(getattr(result, "segments", []))
    if len(segments) == len(candidates):
        for line_index, (line, segment) in enumerate(
            zip(candidates, segments, strict=True)
        ):
            segment_words = flatten_result_words(SimpleNamespace(segments=[segment]))
            matcher = difflib.SequenceMatcher(
                None,
                [normalized_word(word) for word in line.words],
                [word["normalized"] for word in segment_words],
                autojunk=False,
            )
            for block in matcher.get_matching_blocks():
                for offset in range(block.size):
                    word = dict(segment_words[block.b + offset])
                    word["text"] = line.words[block.a + offset]
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
    partial_lines = 0
    previous_start = -1.0
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

    omitted = len(candidates) - len(cues)
    warnings = []
    if omitted:
        warnings.append(f"{omitted} lyric lines had no reliable audio match")
    if partial_lines:
        warnings.append(f"{partial_lines} lyric lines were only partially matched")
    total_words = len(original_words)
    quality = {
        "candidate_lines": len(candidates),
        "aligned_lines": len(cues),
        "line_coverage": round(len(cues) / len(candidates), 4) if candidates else 0,
        "word_coverage": round(matched_words / total_words, 4) if total_words else 0,
        "timing_coverage": round(matched_words / total_words, 4) if total_words else 0,
        "mean_confidence": round(confidence_total / matched_words, 4)
        if matched_words
        else 0,
        "warnings": warnings,
    }
    for cue in cues:
        cue.pop("_source_line", None)
    return cues, quality


def _sequence_score(
    reference: Sequence[str], observed: Sequence[ObservedWord]
) -> tuple[float, dict[str, float]]:
    if not reference or not observed:
        return 0.0, {
            "token_coverage": 0.0,
            "mean_confidence": 0.0,
            "repetition_penalty": 0.0,
        }
    matcher = difflib.SequenceMatcher(
        None, list(reference), [word.normalized for word in observed], autojunk=False
    )
    matched = sum(block.size for block in matcher.get_matching_blocks())
    coverage = matched / len(reference)
    confidence = sum(word.confidence for word in observed) / len(observed)
    repeated = sum(
        1
        for index in range(3, len(observed))
        if observed[index - 3 : index] == observed[index - 2 : index + 1]
    )
    repetition_penalty = min(1.0, repeated / max(1, len(observed) / 20))
    score = max(0.0, 0.72 * coverage + 0.28 * confidence - 0.15 * repetition_penalty)
    return score, {
        "token_coverage": round(coverage, 4),
        "mean_confidence": round(confidence, 4),
        "repetition_penalty": round(repetition_penalty, 4),
    }


def score_candidate(
    source_words: Sequence[str],
    transcript_words: Sequence[str],
    observed: Sequence[ObservedWord],
) -> tuple[float, dict[str, float]]:
    reference = list(source_words) or list(transcript_words)
    score, details = _sequence_score(reference, observed)
    if not source_words and transcript_words and observed:
        words_per_minute = len(observed) / max(
            1 / 60, (observed[-1].end - observed[0].start) / 60
        )
        plausible_density = 1.0 if 15 <= words_per_minute <= 260 else 0.5
        details["plausible_density"] = plausible_density
        score = score * 0.85 + plausible_density * 0.15
    return round(score, 6), details


def choose_candidate(
    candidates: Sequence[AudioCandidate],
    improvement: float,
) -> AudioCandidate:
    usable = [candidate for candidate in candidates if not candidate.error]
    if not usable:
        errors = "; ".join(f"{item.name}: {item.error}" for item in candidates)
        raise RuntimeError(f"all audio candidates failed: {errors}")
    raw = next(
        (candidate for candidate in usable if candidate.name == "raw"), usable[0]
    )
    selected = raw
    for candidate in sorted(usable, key=lambda item: item.score, reverse=True):
        raw_coverage = float((raw.score_details or {}).get("token_coverage", 0))
        coverage = float((candidate.score_details or {}).get("token_coverage", 0))
        if candidate is raw or (
            candidate.score >= raw.score * (1 + improvement)
            and coverage >= raw_coverage - 0.02
        ):
            selected = candidate
            break
    for candidate in candidates:
        candidate.accepted = False
    selected.accepted = True
    return selected


def _run(
    command: Sequence[str],
    *,
    environment: dict[str, str] | None = None,
) -> None:
    completed = subprocess.run(
        list(command),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    if completed.returncode:
        message = completed.stderr.strip().splitlines()
        raise RuntimeError(message[-1] if message else f"{command[0]} failed")


def ffmpeg_vocal_forward(audio: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + f".tmp-{os.getpid()}.wav")
    filters = (
        "dialoguenhance=original=0.15:enhance=3:voice=8,"
        "pan=mono|c0=c2,highpass=f=90,lowpass=f=9000,"
        "dynaudnorm=f=150:g=9:p=0.9"
    )
    try:
        _run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(audio),
                "-af",
                filters,
                "-ar",
                "16000",
                str(temporary),
            ]
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def demucs_vocals(audio: Path, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="zak-radio-demucs-",
        dir=destination.parent,
    ) as temporary:
        _run(
            [
                sys.executable,
                "-m",
                "demucs",
                "--two-stems",
                "vocals",
                "--mp3",
                "--out",
                temporary,
                str(audio),
            ]
        )
        matches = list(Path(temporary).glob("*/" + audio.stem + "/vocals.*"))
        if len(matches) != 1:
            raise RuntimeError("Demucs did not produce one vocals stem")
        converted = destination.with_name(destination.name + f".tmp-{os.getpid()}.wav")
        try:
            _run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(matches[0]),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(converted),
                ]
            )
            os.replace(converted, destination)
        finally:
            converted.unlink(missing_ok=True)
    return destination


def backing_vocals(
    vocal_stem: Path,
    destination: Path,
    cache_root: Path,
) -> Path:
    """Split a Demucs vocal stem into lead and backing vocals, fail-atomic."""

    executable = Path(sys.executable).with_name("audio-separator")
    if not executable.is_file():
        raise FileNotFoundError(
            f"optional backing-vocal separator is unavailable: {executable}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    model_directory = cache_root / "models" / "audio-separator"
    model_directory.mkdir(parents=True, exist_ok=True)
    temporary_root = cache_root / "tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="zak-radio-backing-",
        dir=destination.parent,
    ) as temporary:
        output_directory = Path(temporary)
        environment = dict(os.environ)
        environment["TMPDIR"] = str(temporary_root)
        _run(
            [
                str(executable),
                "--log_level",
                "warning",
                "--model_filename",
                BACKING_VOCAL_MODEL,
                "--model_file_dir",
                str(model_directory),
                "--output_dir",
                str(output_directory),
                "--output_format",
                "WAV",
                "--single_stem",
                "Instrumental",
                "--sample_rate",
                "16000",
                "--use_autocast",
                "--custom_output_names",
                '{"Instrumental":"backing-vocals"}',
                str(vocal_stem),
            ],
            environment=environment,
        )
        separated = output_directory / "backing-vocals.wav"
        if not separated.is_file():
            raise RuntimeError("backing-vocal separator produced no backing stem")
        converted = destination.with_name(destination.name + f".tmp-{os.getpid()}.wav")
        try:
            _run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(separated),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(converted),
                ]
            )
            os.replace(converted, destination)
        finally:
            converted.unlink(missing_ok=True)
    return destination


class LocalModels:
    def __init__(self, profile: Profile, model_dir: Path, verbose: bool = False):
        self.profile = profile
        self.model_dir = model_dir
        self.verbose = verbose
        self._stable: Any = None
        self._heart: Any = None

    @property
    def stable_version(self) -> str:
        import stable_whisper

        return stable_whisper.__version__

    def stable(self) -> Any:
        if self._stable is None:
            import stable_whisper

            self.model_dir.mkdir(parents=True, exist_ok=True)
            self._stable = stable_whisper.load_model(
                self.profile.stable_model,
                device="cuda",
                download_root=str(self.model_dir),
            )
        return self._stable

    def stable_transcribe(self, audio: Path) -> Any:
        return self.stable().transcribe(
            str(audio),
            language=self.profile.language,
            verbose=self.verbose,
            vad=True,
            word_timestamps=True,
        )

    def heart_transcribe(self, audio: Path) -> str:
        if self._heart is None:
            import torch
            from transformers.models.whisper.modeling_whisper import (
                WhisperForConditionalGeneration,
            )
            from transformers.models.whisper.processing_whisper import WhisperProcessor
            from transformers.pipelines.automatic_speech_recognition import (
                AutomaticSpeechRecognitionPipeline,
            )

            local_model = self.model_dir / "HeartTranscriptor-oss"
            if not local_model.exists():
                raise FileNotFoundError(
                    f"HeartTranscriptor checkpoint is missing: {local_model}"
                )
            model = WhisperForConditionalGeneration.from_pretrained(
                str(local_model),
                torch_dtype=torch.float16,
                low_cpu_mem_usage=True,
            )
            processor = WhisperProcessor.from_pretrained(str(local_model))
            self._heart = AutomaticSpeechRecognitionPipeline(
                model=model,
                tokenizer=processor.tokenizer,
                feature_extractor=processor.feature_extractor,
                device=0,
                dtype=torch.float16,
                chunk_length_s=30,
                batch_size=16,
            )
        result = self._heart(
            str(audio),
            max_new_tokens=256,
            num_beams=2,
            task="transcribe",
            condition_on_prev_tokens=False,
            compression_ratio_threshold=1.8,
            temperature=(0.0, 0.1, 0.2, 0.4),
            logprob_threshold=-1.0,
            no_speech_threshold=0.4,
        )
        return str(result.get("text") or "").strip()


def _cache_key(audio_sha256: str, profile: Profile, stage: str) -> str:
    encoded = json.dumps(
        {
            "audio": audio_sha256,
            "harness": MODEL_CACHE_VERSION,
            "profile": asdict(profile),
            "stage": stage,
        },
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def profile_digest(profile: Profile) -> str:
    return hashlib.sha256(
        json.dumps(asdict(profile), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _result_from_observed(words: Sequence[ObservedWord]) -> Any:
    return SimpleNamespace(
        segments=[
            SimpleNamespace(
                words=[
                    SimpleNamespace(
                        word=word.text,
                        start=word.start,
                        end=word.end,
                        probability=word.confidence,
                    )
                    for word in words
                ]
            )
        ]
    )


def monotonic_line_mapping(
    lines: Sequence[CandidateLine],
    observed: Sequence[ObservedWord],
) -> dict[int, int]:
    """Map source words onto ASR words with a global minimum-edit alignment."""

    expected = [normalized_word(word) for line in lines for word in line.words]
    observed_tokens = [word.normalized for word in observed]
    return dict(edit_alignment_pairs(expected, observed_tokens))


def _offset_result(result: Any, offset: float) -> Any:
    if hasattr(result, "offset_time"):
        result.offset_time(offset)
        return result
    for segment in getattr(result, "segments", []):
        for word in getattr(segment, "words", []):
            word.start = float(word.start) + offset
            word.end = float(word.end) + offset
    return result


def _crop_audio(audio: Path, start: float, end: float, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            str(audio),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(destination),
        ]
    )
    return destination


def direct_line_cue(
    line: CandidateLine,
    result: Any,
    observed: Sequence[ObservedWord],
    source_to_observed: dict[int, int],
    source_offset: int,
    estimated_range: tuple[float, float],
    duration: float,
    line_initial_offset: float,
) -> dict[str, Any] | None:
    """Merge forced and ASR anchors, filling only bounded intra-line gaps."""

    expected = [normalized_word(word) for word in line.words]
    forced = flatten_result_words(result)
    anchors: dict[int, tuple[float, float, float]] = {}
    matcher = difflib.SequenceMatcher(
        None, expected, [word["normalized"] for word in forced], autojunk=False
    )
    for block in matcher.get_matching_blocks():
        for block_offset in range(block.size):
            source_index = block.a + block_offset
            word = forced[block.b + block_offset]
            if (
                math.isfinite(word["start"])
                and math.isfinite(word["end"])
                and word["end"] > word["start"]
                and word["start"] >= 0
                and word["end"] <= duration + 0.25
            ):
                anchors[source_index] = (
                    word["start"],
                    word["end"],
                    word["confidence"],
                )
    for index in range(len(expected)):
        observed_index = source_to_observed.get(source_offset + index)
        if observed_index is None:
            continue
        word = observed[observed_index]
        existing = anchors.get(index)
        if (
            existing is None
            or existing[2] < 0.2
            or abs(existing[0] - word.start) > 0.75
        ):
            anchors[index] = (word.start, word.end, word.confidence)
    if not anchors:
        return None

    line_start = max(0.0, estimated_range[0])
    line_end = min(duration, estimated_range[1])
    first_anchor = min(anchors)
    last_anchor = max(anchors)
    if first_anchor == 0:
        line_start = min(line_start, anchors[first_anchor][0])
    if last_anchor == len(expected) - 1:
        line_end = max(line_end, anchors[last_anchor][1])
    if line_end <= line_start:
        return None

    completed: list[tuple[float, float, float] | None] = [
        anchors.get(index) for index in range(len(expected))
    ]
    index = 0
    while index < len(completed):
        if completed[index] is not None:
            index += 1
            continue
        gap_start = index
        while index < len(completed) and completed[index] is None:
            index += 1
        gap_end = index
        left = (
            completed[gap_start - 1][1]
            if gap_start and completed[gap_start - 1] is not None
            else line_start
        )
        right = (
            completed[gap_end][0]
            if gap_end < len(completed) and completed[gap_end] is not None
            else line_end
        )
        if right <= left:
            continue
        weights = [
            max(1, len(expected[word_index]))
            for word_index in range(gap_start, gap_end)
        ]
        total_weight = sum(weights)
        cursor = left
        for word_index, weight in zip(range(gap_start, gap_end), weights, strict=True):
            word_end = cursor + (right - left) * weight / total_weight
            completed[word_index] = (cursor, word_end, 0.0)
            cursor = word_end

    words = []
    previous_end = line_start
    for text, timing in zip(line.words, completed, strict=True):
        if timing is None:
            continue
        start, end, confidence = timing
        start = max(start, previous_end)
        end = min(line_end, max(end, start + 0.02))
        if end <= start or end > duration + 0.25:
            continue
        words.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "confidence": round(max(0.0, min(1.0, confidence)), 4),
            }
        )
        previous_end = end
    if len(words) / len(line.words) < 0.6:
        return None
    if words:
        shifted = min(
            words[0]["end"] - 0.02,
            words[0]["start"] + line_initial_offset,
        )
        words[0]["start"] = round(max(words[0]["start"], shifted), 3)
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": line.text,
        "words": words,
    }


def align_in_windows(
    models: LocalModels,
    audio: Path,
    lines: Sequence[CandidateLine],
    observed: Sequence[ObservedWord],
    duration: float,
    cache_dir: Path,
    window_lines: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Align short monotonic windows, falling back to observed ASR timestamps."""

    if not lines:
        return [], {
            "candidate_lines": 0,
            "aligned_lines": 0,
            "line_coverage": 0,
            "word_coverage": 0,
            "timing_coverage": 0,
            "mean_confidence": 0,
            "warnings": ["no lyric lines were available"],
        }
    source_to_observed = monotonic_line_mapping(lines, observed)

    source_offsets: list[tuple[int, int]] = []
    cursor = 0
    for line in lines:
        source_offsets.append((cursor, cursor + len(line.words)))
        cursor += len(line.words)

    line_ranges: list[tuple[float, float] | None] = []
    for word_start, word_end in source_offsets:
        matched_indexes = [
            source_to_observed[index]
            for index in range(word_start, word_end)
            if index in source_to_observed
        ]
        line_ranges.append(
            (
                observed[min(matched_indexes)].start,
                observed[max(matched_indexes)].end,
            )
            if matched_indexes
            else None
        )
    index = 0
    while index < len(line_ranges):
        if line_ranges[index] is not None:
            index += 1
            continue
        run_start = index
        while index < len(line_ranges) and line_ranges[index] is None:
            index += 1
        run_end = index
        left = line_ranges[run_start - 1][1] if run_start else 0.0
        right = line_ranges[run_end][0] if run_end < len(line_ranges) else duration
        if right <= left:
            right = min(duration, left + max(1.0, run_end - run_start))
        width = (right - left) / (run_end - run_start)
        for run_index in range(run_start, run_end):
            relative = run_index - run_start
            line_ranges[run_index] = (
                left + relative * width,
                left + (relative + 1) * width,
            )

    cues: list[dict[str, Any]] = []
    alignment_warnings: list[str] = []
    used_bounded_alignment = False
    if window_lines == 1:
        try:
            from stable_whisper.alignment import align_words

            boundaries = [0.0]
            for line_index in range(len(line_ranges) - 1):
                current = line_ranges[line_index]
                following = line_ranges[line_index + 1]
                assert current is not None and following is not None
                boundary = (current[1] + following[0]) / 2
                boundaries.append(min(duration, max(boundaries[-1] + 0.02, boundary)))
            boundaries.append(duration)
            aligned = align_words(
                models.stable(),
                str(audio),
                [
                    {
                        "start": boundaries[index],
                        "end": boundaries[index + 1],
                        "text": line.text,
                    }
                    for index, line in enumerate(lines)
                ],
                language=models.profile.language,
                vad=True,
                verbose=None,
                regroup=False,
            )
            if len(aligned.segments) != len(lines):
                raise RuntimeError("bounded alignment changed the lyric line count")
            for line_index, (line, segment) in enumerate(
                zip(lines, aligned.segments, strict=True)
            ):
                cue = direct_line_cue(
                    line,
                    SimpleNamespace(segments=[segment]),
                    observed,
                    source_to_observed,
                    source_offsets[line_index][0],
                    (boundaries[line_index], boundaries[line_index + 1]),
                    duration,
                    models.profile.line_initial_offset,
                )
                if cue is not None:
                    cues.append(cue)
            used_bounded_alignment = True
        except Exception as error:
            alignment_warnings.append(f"bounded word alignment failed: {error}")

    for first_line in (
        [] if used_bounded_alignment else range(0, len(lines), window_lines)
    ):
        group = list(lines[first_line : first_line + window_lines])
        first_range = line_ranges[first_line]
        last_range = line_ranges[first_line + len(group) - 1]
        assert first_range is not None and last_range is not None
        start = max(0.0, first_range[0] - 1.5)
        end = min(duration, last_range[1] + 1.5)
        if end - start < 1:
            continue

        result = None
        try:
            from stable_whisper.alignment import align

            crop = cache_dir / f"align-{first_line:05d}.wav"
            if not crop.exists():
                _crop_audio(audio, start, end, crop)
            result = align(
                models.stable(),
                str(crop),
                "\n".join(line.text for line in group),
                language=models.profile.language,
                original_split=True,
                fast_mode=False,
                failure_threshold=0.5,
            )
            if result is not None:
                _offset_result(result, start)
        except Exception as error:
            alignment_warnings.append(
                f"window {first_line + 1} forced alignment failed: {error}"
            )
        if result is None:
            result = _result_from_observed(observed)
        if len(group) == 1:
            cue = direct_line_cue(
                group[0],
                result,
                observed,
                source_to_observed,
                source_offsets[first_line][0],
                (
                    max(0.0, first_range[0] - 0.15),
                    min(duration, last_range[1] + 0.15),
                ),
                duration,
                models.profile.line_initial_offset,
            )
            group_cues = [cue] if cue is not None else []
        else:
            group_cues, _ = timed_cues(group, result, duration)
        cues.extend(group_cues)

    monotonic: list[dict[str, Any]] = []
    for cue in cues:
        if monotonic and cue["start"] < monotonic[-1]["start"]:
            continue
        if monotonic and cue["start"] < monotonic[-1]["end"]:
            monotonic[-1]["end"] = round(
                max(monotonic[-1]["start"] + 0.05, cue["start"]), 3
            )
            monotonic[-1]["words"] = [
                word
                for word in monotonic[-1].get("words", [])
                if word["end"] <= monotonic[-1]["end"] + 0.05
            ]
        monotonic.append(cue)

    total_words = sum(len(line.words) for line in lines)
    timed_words = sum(len(cue.get("words", [])) for cue in monotonic)
    confidences = [
        word.get("confidence", 0) for cue in monotonic for word in cue.get("words", [])
    ]
    warnings = list(dict.fromkeys(alignment_warnings))
    omitted = len(lines) - len(monotonic)
    if omitted:
        warnings.append(f"{omitted} lyric lines had no reliable audio match")
    quality = {
        "candidate_lines": len(lines),
        "aligned_lines": len(monotonic),
        "line_coverage": round(len(monotonic) / len(lines), 4),
        "word_coverage": round(timed_words / total_words, 4) if total_words else 0,
        "timing_coverage": round(timed_words / total_words, 4) if total_words else 0,
        "mean_confidence": round(sum(confidences) / len(confidences), 4)
        if confidences
        else 0,
        "warnings": warnings,
    }
    return monotonic, quality


def _text_chunks(value: str, maximum_words: int = 12) -> list[str]:
    """Split prose into display-sized clauses without asking a model to rewrite it."""

    clauses = [
        clause.strip(" \t\r\n;—–-")
        for clause in re.split(r"(?<=[.!?;])\s+|\s+[—–]\s+", value)
        if clause.strip(" \t\r\n;—–-")
    ]
    chunks: list[str] = []
    for clause in clauses:
        words = WORD_RE.findall(clause)
        if len(words) <= maximum_words:
            chunks.append(clause)
            continue
        for index in range(0, len(words), maximum_words):
            chunks.append(" ".join(words[index : index + maximum_words]))
    return chunks


def _observed_phrase_coverage(
    reference: Sequence[str],
    observed: Sequence[ObservedWord],
    minimum_confidence: float = 0.7,
) -> float:
    usable = [
        word.normalized
        for word in observed
        if word.confidence >= minimum_confidence and word.normalized
    ]
    if not reference or not usable:
        return 0.0
    return _matching_token_count(reference, usable) / len(reference)


def _observed_phrase_occurrences(
    reference: Sequence[str],
    observed: Sequence[ObservedWord],
    minimum_confidence: float = 0.7,
) -> int:
    usable = [
        word.normalized
        for word in observed
        if word.confidence >= minimum_confidence and word.normalized
    ]
    width = len(reference)
    if not width or width > len(usable):
        return 0
    return sum(
        usable[index : index + width] == list(reference)
        for index in range(len(usable) - width + 1)
    )


def clean_generated_transcript(
    text: str,
    observed: Sequence[ObservedWord] = (),
) -> str:
    """Remove likely ASR boilerplate without deleting audio-supported lyrics."""

    retained: list[str] = []
    previous = ""
    retained_occurrences: dict[str, int] = {}
    for raw in re.split(r"(?<=[.!?])\s+|\n+", text):
        value = raw.strip(" \t\r\n,")
        if not value:
            continue
        tokens = tokenize(value)
        normalized = " ".join(tokens)
        if (
            GENERIC_TRANSCRIPT_RE.search(value)
            and _observed_phrase_coverage(tokens, observed) < 0.8
        ):
            continue
        if normalized and normalized == previous:
            retained_count = retained_occurrences.get(normalized, 0)
            if _observed_phrase_occurrences(tokens, observed) <= retained_count:
                continue
        retained.append(value)
        retained_occurrences[normalized] = retained_occurrences.get(normalized, 0) + 1
        previous = normalized
    return "\n".join(retained)


def transcript_lines(
    text: str,
    observed: Sequence[ObservedWord] = (),
) -> list[CandidateLine]:
    lines: list[CandidateLine] = []
    cleaned = clean_generated_transcript(text, observed)
    for raw in re.split(r"(?<=[.!?])\s+|\n+", cleaned):
        for value in _text_chunks(raw):
            words = tuple(WORD_RE.findall(value))
            if words and any(re.search(r"[A-Za-z0-9]", word) for word in words):
                lines.append(CandidateLine(len(lines) + 1, "", value, words))
    return lines


def _matching_token_count(reference: Sequence[str], evidence: Sequence[str]) -> int:
    if not reference or not evidence:
        return 0
    matcher = difflib.SequenceMatcher(
        None, list(reference), list(evidence), autojunk=False
    )
    return sum(block.size for block in matcher.get_matching_blocks())


def recover_audio_supported_metadata(
    cleaning: CleanedLyrics,
    transcript: str,
    observed: Sequence[ObservedWord],
    minimum_coverage: float = 0.55,
    minimum_matches: int = 3,
) -> tuple[list[CandidateLine], int]:
    """Recover exact source clauses only when independent audio text supports them."""

    transcript_evidence = tokenize(transcript)
    observed_evidence = [word.normalized for word in observed]
    recovered: list[CandidateLine] = []
    considered = 0
    for decision in cleaning.decisions:
        if (
            decision.decision != "metadata"
            or decision.reason not in RECOVERABLE_METADATA_REASONS
        ):
            continue
        for value in _text_chunks(decision.normalized):
            words = tuple(WORD_RE.findall(value))
            reference = [normalized_word(word) for word in words]
            if not reference:
                continue
            considered += 1
            matched = max(
                _matching_token_count(reference, transcript_evidence),
                _matching_token_count(reference, observed_evidence),
            )
            if len(reference) <= 2:
                if _observed_phrase_coverage(reference, observed, 0.8) < 1:
                    continue
            elif (
                matched < minimum_matches or matched / len(reference) < minimum_coverage
            ):
                continue
            recovered.append(
                CandidateLine(decision.source_line, decision.section, value, words)
            )
    return recovered, considered


def _best_contiguous_coverage(
    reference: Sequence[str],
    evidence: Sequence[str],
) -> float:
    """Measure phrase support without allowing matches scattered across a song."""

    if not reference or not evidence:
        return 0.0
    width = len(reference)
    best = 0
    for candidate_width in range(max(1, width - 2), min(len(evidence), width + 3) + 1):
        for index in range(0, len(evidence) - candidate_width + 1):
            best = max(
                best,
                _matching_token_count(
                    reference,
                    evidence[index : index + candidate_width],
                ),
            )
            if best == width:
                return 1.0
    return best / width


def _english_lyric_text(value: str) -> bool:
    """Reject obvious multilingual ASR hallucinations for an English profile."""

    letters = [character for character in value if character.isalpha()]
    if not letters:
        return False
    latin = sum(
        ("a" <= character.casefold() <= "z") or character in "'’"
        for character in letters
    )
    return latin / len(letters) >= 0.9


def _observed_runs(
    observed: Sequence[ObservedWord],
    indexes: Sequence[int],
    minimum_confidence: float,
    maximum_words: int = 12,
) -> list[list[ObservedWord]]:
    runs: list[list[ObservedWord]] = []
    current: list[ObservedWord] = []
    previous_index = -2
    for index in indexes:
        word = observed[index]
        continuous = (
            current
            and index == previous_index + 1
            and word.start - current[-1].end <= 1.1
            and len(current) < maximum_words
        )
        if (
            word.confidence < minimum_confidence
            or not math.isfinite(word.start)
            or not math.isfinite(word.end)
            or word.end - word.start < 0.02
        ):
            if len(current) >= 3:
                runs.append(current)
            current = []
            previous_index = index
            continue
        if current and not continuous:
            if len(current) >= 3:
                runs.append(current)
            current = []
        current.append(word)
        previous_index = index
    if len(current) >= 3:
        runs.append(current)
    return runs


def supported_transcript_lines(
    transcript: str,
    observed: Sequence[ObservedWord],
    profile: Profile,
) -> list[CandidateLine]:
    """Build fallback lyrics from independently corroborated timed ASR spans."""

    transcript_tokens = tokenize(transcript)
    runs = _observed_runs(
        observed,
        list(range(len(observed))),
        SUPPLEMENTAL_MINIMUM_CONFIDENCE,
    )
    lines: list[CandidateLine] = []
    for run in runs:
        text = " ".join(word.text for word in run)
        reference = [word.normalized for word in run]
        if (
            not _english_lyric_text(text)
            or _best_contiguous_coverage(reference, transcript_tokens)
            < SUPPLEMENTAL_PHRASE_COVERAGE
        ):
            continue
        words = tuple(word.text for word in run)
        lines.append(
            CandidateLine(
                len(lines) + 1,
                "",
                text,
                words,
                "transcribed",
            )
        )
    return lines


def missing_vocal_cues(
    lines: Sequence[CandidateLine],
    cues: Sequence[dict[str, Any]],
    observed: Sequence[ObservedWord],
    supplemental_transcript: str,
    profile: Profile,
    *,
    phrase_coverage: float = SUPPLEMENTAL_PHRASE_COVERAGE,
    minimum_matched_words: int = 0,
    evidence_origin: str = "supplemental",
    exclude_mapped_source: bool = True,
    maximum_source_similarity: float = 0.55,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Add only transcript clauses corroborated by unmatched timed ASR words."""

    if not supplemental_transcript or not observed:
        return [dict(cue) for cue in cues], {
            "primary": 0,
            "secondary": 0,
            "rejected": 0,
            "detected": 0,
            "unresolved": 0,
        }
    source_mapping = (
        monotonic_line_mapping(lines, observed) if exclude_mapped_source else {}
    )
    used = set(source_mapping.values())
    transcript_tokens = tokenize(supplemental_transcript)
    source_lines = [tokenize(line.text) for line in lines]
    source_corpus = [token for line in source_lines for token in line]
    runs = _observed_runs(
        observed,
        [index for index in range(len(observed)) if index not in used],
        SUPPLEMENTAL_MINIMUM_CONFIDENCE,
    )
    merged = [dict(cue) for cue in cues]
    counts = {
        "primary": 0,
        "secondary": 0,
        "rejected": 0,
        "detected": 0,
        "unresolved": 0,
    }
    for run in runs:
        text = " ".join(word.text for word in run)
        reference = [word.normalized for word in run]
        transcript_coverage = _best_contiguous_coverage(reference, transcript_tokens)
        source_similarity = max(
            (
                _best_contiguous_coverage(reference, source_corpus),
                *(_best_contiguous_coverage(reference, line) for line in source_lines),
            ),
            default=0.0,
        )
        if (
            not _english_lyric_text(text)
            or source_similarity >= maximum_source_similarity
        ):
            counts["rejected"] += 1
            continue
        start = run[0].start
        end = run[-1].end
        if end <= start or end - start > max(8.0, len(run) * 2.5):
            counts["rejected"] += 1
            continue
        counts["detected"] += 1
        if (
            transcript_coverage < phrase_coverage
            or round(transcript_coverage * len(reference)) < minimum_matched_words
        ):
            counts["rejected"] += 1
            counts["unresolved"] += 1
            continue
        words = [
            {
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "text": word.text,
                "confidence": round(word.confidence, 4),
            }
            for word in run
        ]
        overlaps = [
            (
                max(0.0, min(end, float(cue["end"])) - max(start, float(cue["start"]))),
                index,
            )
            for index, cue in enumerate(merged)
        ]
        overlap, overlap_index = max(overlaps, default=(0.0, -1))
        if overlap_index >= 0 and overlap / max(0.05, end - start) >= 0.45:
            cue = merged[overlap_index]
            if cue.get("secondary_text"):
                counts["rejected"] += 1
                continue
            cue["secondary_text"] = text
            cue["secondary_words"] = words
            cue["secondary_origin"] = "transcribed-missing"
            cue["vocal_evidence"] = evidence_origin
            counts["secondary"] += 1
            continue
        merged.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "words": words,
                "origin": "transcribed-missing",
                "vocal_evidence": evidence_origin,
            }
        )
        counts["primary"] += 1
    merged.sort(key=lambda cue: (float(cue["start"]), float(cue["end"])))
    return merged, counts


def _line_ranges(
    lines: Sequence[CandidateLine],
    observed: Sequence[ObservedWord],
) -> list[tuple[float, float] | None]:
    mapping = monotonic_line_mapping(lines, observed)
    ranges: list[tuple[float, float] | None] = []
    offset = 0
    for line in lines:
        indexes = [
            mapping[index]
            for index in range(offset, offset + len(line.words))
            if index in mapping
        ]
        ranges.append(
            (observed[min(indexes)].start, observed[max(indexes)].end)
            if indexes
            else None
        )
        offset += len(line.words)
    return ranges


def _median(values: Sequence[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return (
        ordered[middle]
        if len(ordered) % 2
        else (ordered[middle - 1] + ordered[middle]) / 2
    )


def _consensus_range(
    ranges: Sequence[tuple[float, float]],
    maximum_spread: float,
) -> tuple[float, float, int] | None:
    ordered = sorted(ranges)
    best: list[tuple[float, float]] = []
    for first in range(len(ordered)):
        cluster = [
            item
            for item in ordered[first:]
            if item[0] - ordered[first][0] <= maximum_spread
        ]
        if len(cluster) > len(best):
            best = cluster
    if len(best) < 2:
        return None
    return (
        _median([item[0] for item in best]),
        _median([item[1] for item in best]),
        len(best),
    )


def repair_timings_from_consensus(
    lines: Sequence[CandidateLine],
    cues: Sequence[dict[str, Any]],
    candidates: Sequence[AudioCandidate],
    profile: Profile,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Repair local onset outliers only where two representations agree."""

    ranges_by_candidate = [
        _line_ranges(lines, candidate.observed or [])
        for candidate in candidates
        if not candidate.error and candidate.observed
    ]
    repaired = [dict(cue) for cue in cues]
    counts = {"agreed_lines": 0, "repaired_lines": 0}
    search_from = 0
    for cue_index, cue in enumerate(repaired):
        cue_tokens = tokenize(str(cue.get("text") or ""))
        line_index = next(
            (
                index
                for index in range(search_from, len(lines))
                if tokenize(lines[index].text) == cue_tokens
            ),
            None,
        )
        if line_index is None:
            continue
        search_from = line_index + 1
        line_ranges = [
            ranges[line_index]
            for ranges in ranges_by_candidate
            if ranges[line_index] is not None
        ]
        consensus = _consensus_range(
            line_ranges,
            CONSENSUS_MAXIMUM_SPREAD,
        )
        if consensus is None:
            continue
        target_start, _target_end, agreement = consensus
        target_start += profile.line_initial_offset
        counts["agreed_lines"] += 1
        current_start = float(cue["start"])
        cue_words = cue.get("words") or []
        cue_coverage = len(cue_words) / len(cue_tokens) if cue_tokens else 0.0
        cue_confidence = (
            sum(float(word.get("confidence") or 0) for word in cue_words)
            / len(cue_words)
            if cue_words
            else 0.0
        )
        if (
            cue_coverage >= LINE_VERIFIED_COVERAGE
            and cue_confidence >= LINE_VERIFIED_CONFIDENCE
        ):
            cue["timing_consensus"] = agreement
            continue
        shift = target_start - current_start
        if abs(shift) + 1e-6 < LOCAL_REPAIR_MINIMUM_SHIFT:
            cue["timing_consensus"] = agreement
            continue
        if abs(shift) - 1e-6 > LOCAL_REPAIR_MAXIMUM_SHIFT:
            cue["timing_consensus"] = agreement
            continue
        previous_end = float(repaired[cue_index - 1]["end"]) if cue_index else 0.0
        next_start = (
            float(repaired[cue_index + 1]["start"])
            if cue_index + 1 < len(repaired)
            else math.inf
        )
        if target_start < previous_end - 0.05 or target_start >= next_start:
            continue
        target_end = float(cue["end"]) + shift
        if target_end <= target_start or target_end > next_start:
            continue
        cue["start"] = round(target_start, 3)
        cue["end"] = round(target_end, 3)
        cue["words"] = [
            {
                **word,
                "start": round(float(word["start"]) + shift, 3),
                "end": round(float(word["end"]) + shift, 3),
            }
            for word in cue.get("words", [])
            if float(word["end"]) + shift <= target_end + 0.05
        ]
        cue["timing_consensus"] = agreement
        cue["timing_repaired"] = True
        counts["repaired_lines"] += 1
    return repaired, counts


def sanitize_cue_timings(
    cues: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    def sanitize_word(
        source: dict[str, Any],
        minimum: float,
        maximum: float,
    ) -> dict[str, Any] | None:
        start = float(source.get("start", math.nan))
        end = float(source.get("end", math.nan))
        if not math.isfinite(start) or not math.isfinite(end):
            return None
        word = dict(source)
        if end <= start:
            end = min(maximum, max(minimum + 0.02, end))
            start = max(minimum, end - 0.02)
            if end <= start:
                return None
            word["start"] = round(start, 3)
            word["end"] = round(end, 3)
            word["confidence"] = 0.0
            word["timing_repaired"] = True
        if start < minimum - 0.05 or end > maximum + 0.05:
            return None
        return word

    sanitized: list[dict[str, Any]] = []
    for source in cues:
        cue = dict(source)
        start = float(cue["start"])
        end = float(cue["end"])
        cue["words"] = list(
            filter(
                None,
                (sanitize_word(word, start, end) for word in cue.get("words", [])),
            )
        )
        cue["secondary_words"] = list(
            filter(
                None,
                (
                    sanitize_word(word, 0.0, math.inf)
                    for word in cue.get("secondary_words", [])
                ),
            )
        )
        sanitized.append(cue)
    return sanitized


def annotate_cue_quality(
    cues: Sequence[dict[str, Any]],
    profile: Profile,
) -> dict[str, int]:
    counts = {"verified": 0, "warning": 0}
    for cue in cues:
        expected = tokenize(str(cue.get("text") or ""))
        words = cue.get("words") or []
        coverage = len(words) / len(expected) if expected else 0.0
        confidence = (
            sum(float(word.get("confidence") or 0) for word in words) / len(words)
            if words
            else 0.0
        )
        status = (
            "verified"
            if coverage >= LINE_VERIFIED_COVERAGE
            and confidence >= LINE_VERIFIED_CONFIDENCE
            else "warning"
        )
        cue["quality_status"] = status
        cue["line_coverage"] = round(min(1.0, coverage), 4)
        cue["mean_confidence"] = round(confidence, 4)
        counts[status] += 1
    return counts


def quality_status(
    quality: dict[str, Any],
    origin: str,
    profile: Profile,
) -> str:
    if origin == "transcribed":
        return "warning"
    return (
        "verified"
        if quality["line_coverage"] >= profile.verified_line_coverage
        and quality["word_coverage"] >= profile.verified_word_coverage
        and quality["mean_confidence"] >= profile.verified_confidence
        and bool(quality["aligned_lines"])
        else "warning"
    )


def _preprocess_candidates(
    audio: Path,
    audio_sha256: str,
    cache_root: Path,
    profile: Profile,
    mode: str,
) -> list[AudioCandidate]:
    root = cache_root / "preprocessed" / _cache_key(audio_sha256, profile, "audio")
    candidates = [AudioCandidate("raw", audio)]
    if mode in {"auto", "ffmpeg"}:
        path = root / "ffmpeg-vocal.wav"
        try:
            if not path.exists():
                ffmpeg_vocal_forward(audio, path)
            candidates.append(AudioCandidate("ffmpeg", path))
        except Exception as error:
            candidates.append(AudioCandidate("ffmpeg", path, error=str(error)))
    if mode == "demucs":
        path = root / "demucs-vocals.wav"
        try:
            if not path.exists():
                demucs_vocals(audio, path)
            candidates.append(AudioCandidate("demucs", path))
        except Exception as error:
            candidates.append(AudioCandidate("demucs", path, error=str(error)))
    return candidates


def _evaluate_audio_candidates(
    candidates: list[AudioCandidate],
    models: LocalModels,
    source_words: Sequence[str],
    generated_transcript: bool,
    cache_root: Path,
) -> None:
    for candidate in candidates:
        if candidate.error:
            continue
        try:
            transcript_key = _cache_key(
                sha256_file(candidate.path),
                models.profile,
                (
                    f"transcript-{candidate.name}-{models.stable_version}-"
                    f"{'heart-official-v2' if generated_transcript else 'anchors'}"
                ),
            )
            cache_path = cache_root / "transcripts" / f"{transcript_key}.json"
            if cache_path.exists():
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                candidate.warning = str(cached.get("warning") or "")
                candidate.observed = [
                    ObservedWord(**word) for word in cached["observed"]
                ]
                candidate.raw_transcript = str(
                    cached.get("raw_transcript") or cached.get("transcript") or ""
                )
                candidate.transcript = clean_generated_transcript(
                    candidate.raw_transcript, candidate.observed
                )
                candidate.cache_hit = True
            else:
                if generated_transcript:
                    try:
                        candidate.raw_transcript = models.heart_transcribe(
                            candidate.path
                        )
                    except Exception as error:
                        candidate.warning = (
                            "singing transcriber failed; stable-ts fallback used: "
                            f"{error}"
                        )
                candidate.stable_result = models.stable_transcribe(candidate.path)
                candidate.observed = observed_words(candidate.stable_result)
                if generated_transcript and not candidate.raw_transcript:
                    candidate.raw_transcript = " ".join(
                        word.text for word in candidate.observed
                    )
                candidate.transcript = clean_generated_transcript(
                    candidate.raw_transcript, candidate.observed
                )
                write_json_atomic(
                    cache_path,
                    {
                        "version": 2,
                        "raw_transcript": candidate.raw_transcript,
                        "transcript": candidate.transcript,
                        "warning": candidate.warning,
                        "observed": [asdict(word) for word in candidate.observed],
                    },
                )
            transcript_reference = tokenize(candidate.transcript)
            candidate.score, candidate.score_details = score_candidate(
                source_words, transcript_reference, candidate.observed
            )
        except Exception as error:
            candidate.error = str(error)


def _maybe_add_demucs(
    candidates: list[AudioCandidate],
    selected: AudioCandidate,
    audio: Path,
    audio_sha256: str,
    cache_root: Path,
    profile: Profile,
    models: LocalModels,
    source_words: Sequence[str],
    generated_transcript: bool,
) -> AudioCandidate:
    if selected.score >= profile.minimum_anchor_score:
        return selected
    root = cache_root / "preprocessed" / _cache_key(audio_sha256, profile, "audio")
    path = root / "demucs-vocals.wav"
    candidate = AudioCandidate("demucs", path)
    try:
        if not path.exists():
            demucs_vocals(audio, path)
    except Exception as error:
        candidate.error = str(error)
    candidates.append(candidate)
    _evaluate_audio_candidates(
        [candidate], models, source_words, generated_transcript, cache_root
    )
    return choose_candidate(candidates, profile.candidate_improvement)


def _supplemental_transcript(
    selected: AudioCandidate,
    models: LocalModels,
    source_words: Sequence[str],
    cache_root: Path,
) -> AudioCandidate:
    supplemental = AudioCandidate(selected.name, selected.path)
    _evaluate_audio_candidates(
        [supplemental],
        models,
        source_words,
        True,
        cache_root,
    )
    if supplemental.error:
        supplemental.warning = (
            "supplemental singing transcript unavailable: " + supplemental.error
        )
    return supplemental


def _maybe_add_backing_vocals(
    candidates: list[AudioCandidate],
    *,
    audio_sha256: str,
    cache_root: Path,
    profile: Profile,
    models: LocalModels,
    source_words: Sequence[str],
) -> AudioCandidate | None:
    demucs = next(
        (
            candidate
            for candidate in candidates
            if candidate.name == "demucs" and not candidate.error
        ),
        None,
    )
    if demucs is None:
        return None
    root = cache_root / "preprocessed" / _cache_key(audio_sha256, profile, "audio")
    candidate = AudioCandidate("backing", root / "backing-vocals.wav")
    try:
        if not candidate.path.exists():
            backing_vocals(demucs.path, candidate.path, cache_root)
    except Exception as error:
        candidate.error = str(error)
    candidates.append(candidate)
    _evaluate_audio_candidates(
        [candidate],
        models,
        source_words,
        True,
        cache_root,
    )
    return candidate


def process_track(
    archive: Path,
    output_root: Path,
    track: dict[str, Any],
    profile: Profile,
    models: LocalModels,
    cache_root: Path,
    preprocess: str = "auto",
    text_classifier: Callable[[Sequence[tuple[int, str]]], dict[int, str]]
    | None = None,
    strategy: str = "v6",
) -> tuple[dict[str, Any], dict[str, Any]]:
    directory = archive / str(track["organized_dir"])
    audio = directory / "audio.mp3"
    lyrics_path = directory / "lyrics.md"
    if not audio.is_file():
        raise ValueError("audio.mp3 is missing")
    source_sha256 = ""
    cleaning = CleanedLyrics((), "", (), ())
    if lyrics_path.is_file() and lyrics_path.stat().st_size:
        source_sha256 = sha256_file(lyrics_path)
        cleaning = clean_lyrics(
            lyrics_path.read_text(encoding="utf-8"), classifier=text_classifier
        )

    candidates = _preprocess_candidates(
        audio,
        str(track["audio_sha256"]),
        cache_root,
        profile,
        preprocess,
    )
    source_words = [
        normalized_word(word) for line in cleaning.lines for word in line.words
    ]
    generated = not bool(cleaning.lines)
    _evaluate_audio_candidates(candidates, models, source_words, generated, cache_root)
    selected = choose_candidate(candidates, profile.candidate_improvement)
    if preprocess == "auto":
        selected = _maybe_add_demucs(
            candidates,
            selected,
            audio,
            str(track["audio_sha256"]),
            cache_root,
            profile,
            models,
            source_words,
            generated,
        )

    selected_coverage = float((selected.score_details or {}).get("token_coverage", 0))
    backing: AudioCandidate | None = None
    if cleaning.lines and selected_coverage < SUPPLEMENTAL_TRIGGER_COVERAGE:
        backing = _maybe_add_backing_vocals(
            candidates,
            audio_sha256=str(track["audio_sha256"]),
            cache_root=cache_root,
            profile=profile,
            models=models,
            source_words=source_words,
        )
    supplemental: AudioCandidate | None = None
    if cleaning.lines and selected_coverage < SUPPLEMENTAL_TRIGGER_COVERAGE:
        supplemental = _supplemental_transcript(
            selected,
            models,
            source_words,
            cache_root,
        )
    elif generated:
        supplemental = selected
    supplemental_text = (
        supplemental.transcript if supplemental and not supplemental.error else ""
    )

    recovered_source = False
    recovered_considered = 0
    recovered, recovered_considered = recover_audio_supported_metadata(
        cleaning,
        supplemental_text or selected.transcript,
        selected.observed or [],
    )
    source_mismatch = (
        strategy == "v6"
        and bool(cleaning.lines)
        and selected_coverage < SOURCE_MISMATCH_COVERAGE
        and bool(supplemental_text)
    )
    fallback_lines = (
        supported_transcript_lines(
            supplemental_text,
            supplemental.observed or [],
            profile,
        )
        if source_mismatch and supplemental
        else []
    )
    if fallback_lines:
        lines = fallback_lines
        display_text = _display_text(lines)
        origin = "transcribed"
    elif cleaning.lines:
        keyed = {
            (line.source_line, line.text): line
            for line in (*cleaning.lines, *recovered)
        }
        lines = sorted(keyed.values(), key=lambda line: line.source_line)
        display_text = _display_text(lines)
        recovered_source = bool(recovered)
        origin = (
            "reconciled"
            if any(decision.decision == "metadata" for decision in cleaning.decisions)
            else "provided"
        )
    elif recovered:
        lines = recovered
        display_text = _display_text(lines)
        origin = "reconciled"
        recovered_source = True
    else:
        lines = transcript_lines(selected.transcript, selected.observed or [])
        display_text = _display_text(lines)
        origin = "transcribed"
    if not display_text:
        raise RuntimeError("local models produced no lyric text")

    duration = float(track["duration"])
    alignment_cache = (
        cache_root
        / "alignment"
        / _cache_key(
            str(track["audio_sha256"]), profile, f"{selected.name}-monotonic-lines-v1"
        )
    )
    cues, quality = align_in_windows(
        models,
        selected.path,
        lines,
        selected.observed or [],
        duration,
        alignment_cache,
        profile.window_lines,
    )
    consensus = {"agreed_lines": 0, "repaired_lines": 0}
    supplemental_counts = {
        "primary": 0,
        "secondary": 0,
        "rejected": 0,
        "detected": 0,
        "unresolved": 0,
    }
    backing_counts = {
        "primary": 0,
        "secondary": 0,
        "rejected": 0,
        "detected": 0,
        "unresolved": 0,
    }
    if strategy == "v6":
        cues, consensus = repair_timings_from_consensus(
            lines,
            cues,
            candidates,
            profile,
        )
        if supplemental and supplemental_text and not fallback_lines:
            cues, supplemental_counts = missing_vocal_cues(
                lines,
                cues,
                supplemental.observed or [],
                supplemental_text,
                profile,
                evidence_origin="selected",
            )
            if supplemental_counts["primary"] or supplemental_counts["secondary"]:
                origin = "reconciled"
                display_text = "\n".join(
                    filter(
                        None,
                        (
                            (
                                str(cue["text"])
                                + (
                                    "\n" + str(cue["secondary_text"])
                                    if cue.get("secondary_text")
                                    else ""
                                )
                            )
                            for cue in cues
                        ),
                    )
                )
        if backing and not backing.error and backing.transcript and not fallback_lines:
            cues, backing_counts = missing_vocal_cues(
                lines,
                cues,
                backing.observed or [],
                backing.transcript,
                profile,
                phrase_coverage=BACKING_PHRASE_COVERAGE,
                minimum_matched_words=BACKING_MINIMUM_MATCHED_WORDS,
                evidence_origin="backing",
                exclude_mapped_source=False,
            )
            if backing_counts["primary"] or backing_counts["secondary"]:
                origin = "reconciled"
                display_text = "\n".join(
                    filter(
                        None,
                        (
                            (
                                str(cue["text"])
                                + (
                                    "\n" + str(cue["secondary_text"])
                                    if cue.get("secondary_text")
                                    else ""
                                )
                            )
                            for cue in cues
                        ),
                    )
                )
        cues = sanitize_cue_timings(cues)
    added_primary = supplemental_counts["primary"] + backing_counts["primary"]
    if added_primary:
        quality["candidate_lines"] += added_primary
    quality["aligned_lines"] = len(cues)
    quality["line_coverage"] = round(
        len(cues) / max(1, int(quality["candidate_lines"])),
        4,
    )
    all_words = [word for cue in cues for word in cue.get("words", [])]
    expected_words = sum(len(line.words) for line in lines) + sum(
        len(tokenize(str(cue.get("text") or "")))
        for cue in cues
        if cue.get("origin") == "transcribed-missing"
    )
    quality["word_coverage"] = round(
        len(all_words) / max(1, expected_words),
        4,
    )
    quality["timing_coverage"] = quality["word_coverage"]
    quality["mean_confidence"] = round(
        sum(float(word.get("confidence") or 0) for word in all_words)
        / max(1, len(all_words)),
        4,
    )
    line_quality_counts = annotate_cue_quality(cues, profile)
    quality["warnings"] = list(
        dict.fromkeys(
            [
                *cleaning.warnings,
                *quality.get("warnings", []),
                *([selected.warning] if selected.warning else []),
                *(
                    [
                        "backing-vocal pass was unavailable; primary alignment was retained: "
                        + backing.error
                    ]
                    if backing and backing.error
                    else []
                ),
                *(
                    [
                        "metadata-like source text was recovered only where local audio evidence supported it"
                    ]
                    if recovered_source
                    else []
                ),
                *(
                    [
                        f"{recovered_considered - len(recovered)} metadata-like source clauses had no reliable audio support"
                    ]
                    if recovered_source and recovered_considered > len(recovered)
                    else []
                ),
                *(
                    [
                        "lyrics were transcribed locally because no usable source lyrics were available"
                    ]
                    if generated and not recovered_source
                    else []
                ),
                *(
                    [
                        "provided lyrics were replaced because independent audio evidence showed a source mismatch"
                    ]
                    if fallback_lines
                    else []
                ),
                *(
                    [
                        f"added {supplemental_counts['primary']} missing vocal lines and "
                        f"{supplemental_counts['secondary']} overlapping vocal parts"
                    ]
                    if supplemental_counts["primary"]
                    or supplemental_counts["secondary"]
                    else []
                ),
                *(
                    [
                        f"added {backing_counts['primary']} backing-vocal lines and "
                        f"{backing_counts['secondary']} overlapping backing-vocal parts"
                    ]
                    if backing_counts["primary"] or backing_counts["secondary"]
                    else []
                ),
                *(
                    [
                        f"withheld {backing_counts['unresolved']} possible backing-vocal "
                        "phrases because the local models did not corroborate the words "
                        "strongly enough"
                    ]
                    if backing_counts["unresolved"]
                    else []
                ),
            ]
        )
    )
    quality["status"] = quality_status(quality, origin, profile)
    if strategy == "v6":
        quality["alternate_vocals_detected"] = bool(backing_counts["detected"])
        quality["alternate_vocals_unresolved"] = bool(backing_counts["unresolved"])
    if recovered_source:
        quality["status"] = "warning"
    if quality["status"] == "warning" and not quality["warnings"]:
        quality["warnings"].append("lyrics did not meet the verified quality profile")

    try:
        import torch

        device = torch.cuda.get_device_name(0)
    except Exception:
        device = "unknown"
    evidence = model_evidence_set(
        track,
        source_sha256,
        selected,
        candidates,
        supplemental,
    )
    payload: dict[str, Any] = {
        "version": 2,
        "track_id": track["id"],
        "audio_sha256": track["audio_sha256"],
        "duration": duration,
        "language": profile.language,
        "display_text": display_text,
        "origin": origin,
        "evidence": evidence,
        "generator": {
            "name": "zak-radio-lyrics-harness",
            "version": HARNESS_VERSION,
            "strategy": strategy,
            "profile_sha256": profile_digest(profile),
            "stable_ts": models.stable_version,
            "aligner_model": profile.stable_model,
            "transcriber_model": profile.heart_model if supplemental else "",
            "transcriber_revision": profile.heart_revision if supplemental else "",
            "preprocessing": selected.name,
            "device": device,
        },
        "quality": quality,
        "cues": cues,
    }
    if source_sha256:
        payload["source_lyrics_sha256"] = source_sha256

    report = {
        "id": track["id"],
        "status": "text-only" if not cues else quality["status"],
        "quality_status": quality["status"],
        "origin": origin,
        "preprocessing": selected.name,
        "cues": len(cues),
        "line_coverage": quality["line_coverage"],
        "word_coverage": quality["word_coverage"],
        "mean_confidence": quality["mean_confidence"],
        "warnings": quality["warnings"],
        "consensus": consensus,
        "supplemental_vocals": supplemental_counts,
        "backing_vocals": backing_counts,
        "line_quality_counts": line_quality_counts,
        "candidates": [
            {
                "name": candidate.name,
                "score": candidate.score,
                "score_details": candidate.score_details or {},
                "accepted": candidate.accepted,
                "cache_hit": candidate.cache_hit,
                "warning": candidate.warning,
                "error": candidate.error,
            }
            for candidate in candidates
        ],
        "line_decisions": [asdict(decision) for decision in cleaning.decisions],
    }
    destination = output_path(output_root, str(track["organized_dir"]))
    write_json_atomic(destination, payload)
    report["path"] = str(destination.relative_to(output_root))
    return payload, report


def export_bundle(
    output_root: Path,
    bundle_root: Path,
    tracks: Sequence[dict[str, Any]],
) -> int:
    exported = 0
    for track in tracks:
        source = output_path(output_root, str(track["organized_dir"]))
        if not existing_matches(source, track):
            continue
        payload = json.loads(source.read_text(encoding="utf-8"))
        if not bundle_eligible(payload):
            continue
        write_json_atomic(bundle_root / f"{track['id']}.json", payload)
        exported += 1
    return exported


def _resolved_sidecar_evidence(
    payload: dict[str, Any],
    track: dict[str, Any],
    archive: Path,
    cache_root: Path,
    profile: Profile,
) -> tuple[dict[str, Any], str]:
    if payload.get("track_id") != track.get("id"):
        raise ValueError("sidecar does not match the archive track")
    if payload.get("audio_sha256") != track.get("audio_sha256"):
        raise ValueError("sidecar does not match the archive audio identity")
    directory = archive / str(track["organized_dir"])
    source = directory / "lyrics.md"
    source_sha256 = (
        sha256_file(source) if source.is_file() and source.stat().st_size else ""
    )
    payload_source_sha256 = payload.get("source_lyrics_sha256")
    if source_sha256 and not payload_source_sha256:
        raise ValueError("sidecar is not bound to the current source lyrics")
    if (payload_source_sha256 or "") != source_sha256:
        raise ValueError("sidecar does not match the current source lyrics")

    embedded = payload.get("evidence")
    if isinstance(embedded, dict):
        evidence = dict(embedded)
        claimed = str(evidence.pop("sha256", ""))
        if not claimed or canonical_json_sha256(evidence) != claimed:
            raise ValueError("embedded evidence digest is invalid")
        evidence["sha256"] = claimed
        if evidence.get("audio_sha256") != str(track["audio_sha256"]):
            raise ValueError("embedded evidence does not match the archive audio")
        if evidence.get("source_lyrics_sha256", "") != payload.get(
            "source_lyrics_sha256", ""
        ):
            raise ValueError("embedded evidence does not match the source lyrics")
        if evidence.get("selected_preprocessing") != (
            payload.get("generator") or {}
        ).get("preprocessing"):
            raise ValueError("embedded evidence does not match preprocessing")
        return evidence, "embedded"

    generator = payload.get("generator") or {}
    if generator.get("profile_sha256") != profile_digest(profile):
        raise ValueError("legacy sidecar profile does not match the comparison profile")
    preprocessing = str(generator.get("preprocessing") or "")
    if preprocessing not in {"raw", "ffmpeg", "demucs"}:
        raise ValueError("legacy sidecar has no supported preprocessing identity")
    audio = directory / "audio.mp3"
    if preprocessing == "raw":
        selected_audio = audio
    else:
        selected_audio = (
            cache_root
            / "preprocessed"
            / _cache_key(str(track["audio_sha256"]), profile, "audio")
            / f"{preprocessing}-{'vocal' if preprocessing == 'ffmpeg' else 'vocals'}.wav"
        )
    if not selected_audio.is_file():
        raise ValueError(f"cached {preprocessing} audio evidence is missing")
    stable_version = str(generator.get("stable_ts") or "")
    generated = bool(generator.get("transcriber_model"))
    transcript_key = _cache_key(
        sha256_file(selected_audio),
        profile,
        (
            f"transcript-{preprocessing}-{stable_version}-"
            f"{'heart' if generated else 'anchors'}"
        ),
    )
    cache_path = cache_root / "transcripts" / f"{transcript_key}.json"
    if not cache_path.is_file():
        raise ValueError("cached model evidence is missing")
    cached = json.loads(cache_path.read_text(encoding="utf-8"))
    candidate = AudioCandidate(
        preprocessing,
        selected_audio,
        raw_transcript=str(
            cached.get("raw_transcript") or cached.get("transcript") or ""
        ),
        transcript=str(cached.get("transcript") or ""),
        observed=[ObservedWord(**word) for word in cached.get("observed") or []],
        warning=str(cached.get("warning") or ""),
    )
    return model_evidence(track, source_sha256, candidate), "legacy-cache"


def _payload_words(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for cue in payload.get("cues") or []:
        for word in cue.get("words") or []:
            normalized = normalized_word(str(word.get("text") or ""))
            if normalized:
                result.append(
                    {
                        "normalized": normalized,
                        "start": float(word.get("start") or 0),
                        "confidence": float(word.get("confidence") or 0),
                    }
                )
    return result


def _metadata_like_display_line(value: str) -> bool:
    normalized = _markdown_unwrap(value).strip()
    return bool(
        _section_name(normalized)
        or re.match(
            r"^[^\w]*(?:title|style|genre|tempo|key|prompt)\s*:",
            normalized,
            re.IGNORECASE,
        )
        or is_production_cue(normalized)
        or PRODUCTION_SENTENCE_RE.match(normalized)
        or _looks_like_prompt_prose(normalized)
    )


def _display_line_audio_supported(
    payload: dict[str, Any],
    value: str,
    minimum_confidence: float = 0.75,
) -> bool:
    reference = tokenize(value)
    if not reference:
        return False
    for cue in payload.get("cues") or []:
        if tokenize(str(cue.get("text") or "")) != reference:
            continue
        supported = [
            normalized_word(str(word.get("text") or ""))
            for word in cue.get("words") or []
            if float(word.get("confidence") or 0) >= minimum_confidence
        ]
        matched = _matching_token_count(reference, supported)
        if matched / len(reference) >= 0.8:
            return True
    return False


def _unsupported_metadata_lines(payload: dict[str, Any]) -> list[str]:
    return [
        line.strip()
        for line in str(payload.get("display_text") or "").splitlines()
        if line.strip()
        and _metadata_like_display_line(line)
        and not _display_line_audio_supported(payload, line)
    ]


def _monotonic_timing(payload: dict[str, Any]) -> bool:
    previous = -1.0
    for cue in payload.get("cues") or []:
        start = float(cue.get("start") or 0)
        end = float(cue.get("end") or 0)
        if start < previous or end <= start:
            return False
        previous = start
        word_previous = start
        for word in cue.get("words") or []:
            word_start = float(word.get("start") or 0)
            word_end = float(word.get("end") or 0)
            if word_start < word_previous - 0.001 or word_end <= word_start:
                return False
            word_previous = word_start
    return True


def compare_sidecars(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
    baseline_evidence: dict[str, Any],
    candidate_evidence: dict[str, Any],
    maximum_onset_shift: float = 0.5,
    high_confidence: float = 0.75,
) -> dict[str, Any]:
    regressions: list[str] = []
    improvements: list[str] = []
    if baseline_evidence.get("sha256") != candidate_evidence.get("sha256"):
        regressions.append(
            "baseline and candidate did not use identical frozen evidence"
        )
    if baseline.get("track_id") != candidate.get("track_id"):
        regressions.append("track identity changed")
    if baseline.get("audio_sha256") != candidate.get("audio_sha256"):
        regressions.append("audio identity changed")
    if baseline.get("source_lyrics_sha256", "") != candidate.get(
        "source_lyrics_sha256", ""
    ):
        regressions.append("source lyric identity changed")

    baseline_words = _payload_words(baseline)
    candidate_words = _payload_words(candidate)
    protected = [
        word for word in baseline_words if word["confidence"] >= high_confidence
    ]
    candidate_protected = [
        word for word in candidate_words if word["confidence"] >= high_confidence
    ]
    matcher = difflib.SequenceMatcher(
        None,
        [word["normalized"] for word in protected],
        [word["normalized"] for word in candidate_protected],
        autojunk=False,
    )
    protected_matches = sum(block.size for block in matcher.get_matching_blocks())
    protected_lost = len(protected) - protected_matches
    if protected_lost:
        regressions.append(f"{protected_lost} high-confidence baseline words were lost")

    onset_shifts: list[float] = []
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            onset_shifts.append(
                abs(
                    protected[block.a + offset]["start"]
                    - candidate_protected[block.b + offset]["start"]
                )
            )
    excessive_shifts = sum(shift > maximum_onset_shift for shift in onset_shifts)
    if excessive_shifts:
        regressions.append(
            f"{excessive_shifts} protected word onsets moved more than "
            f"{maximum_onset_shift:.3f}s"
        )

    baseline_quality = baseline.get("quality") or {}
    candidate_quality = candidate.get("quality") or {}
    for metric in ("line_coverage", "word_coverage", "mean_confidence"):
        before = float(baseline_quality.get(metric) or 0)
        after = float(candidate_quality.get(metric) or 0)
        if after < before:
            regressions.append(f"{metric} decreased from {before:.4f} to {after:.4f}")
        elif after > before:
            improvements.append(f"{metric} increased from {before:.4f} to {after:.4f}")
    baseline_alternate = bool(baseline_quality.get("alternate_vocals_detected"))
    candidate_alternate = bool(candidate_quality.get("alternate_vocals_detected"))
    if candidate_alternate and not baseline_alternate:
        improvements.append("surfaced independently detected alternate vocals")
    elif baseline_alternate and not candidate_alternate:
        regressions.append("lost an alternate-vocal detection")

    if not _monotonic_timing(candidate):
        regressions.append("candidate timing is not monotonic")

    baseline_metadata = _unsupported_metadata_lines(baseline)
    candidate_metadata = _unsupported_metadata_lines(candidate)
    baseline_metadata_keys = {" ".join(tokenize(line)) for line in baseline_metadata}
    new_metadata = [
        line
        for line in candidate_metadata
        if " ".join(tokenize(line)) not in baseline_metadata_keys
    ]
    if new_metadata:
        regressions.append(
            f"{len(new_metadata)} new metadata-like display lines lack audio support"
        )
    if len(candidate_metadata) < len(baseline_metadata):
        improvements.append(
            f"removed {len(baseline_metadata) - len(candidate_metadata)} "
            "unsupported metadata-like display lines"
        )

    status_rank = {"warning": 0, "verified": 1}
    baseline_status = str(baseline_quality.get("status") or "")
    candidate_status = str(candidate_quality.get("status") or "")
    if status_rank.get(candidate_status, 0) > status_rank.get(baseline_status, 0):
        improvements.append(f"quality status improved to {candidate_status}")
    elif status_rank.get(candidate_status, 0) < status_rank.get(baseline_status, 0):
        regressions.append(
            f"quality status decreased from {baseline_status} to {candidate_status}"
        )

    if regressions:
        decision = "abstain"
        selected = "baseline"
    elif improvements:
        decision = "promote"
        selected = "candidate"
    else:
        decision = "retain-baseline"
        selected = "baseline"
    return {
        "decision": decision,
        "selected": selected,
        "regressions": regressions,
        "improvements": improvements,
        "protected_words": len(protected),
        "protected_words_lost": protected_lost,
        "maximum_onset_shift": round(max(onset_shifts), 4) if onset_shifts else 0,
        "unsupported_metadata_before": baseline_metadata,
        "unsupported_metadata_after": candidate_metadata,
    }


def run_compare(args: argparse.Namespace) -> int:
    archive = args.archive.resolve()
    baseline_root = args.baseline_root.resolve()
    candidate_root = args.candidate_root.resolve()
    cache_root = args.cache_root.resolve()
    profile = Profile.load(args.profile)
    selected_ids = set(args.track_id)
    tracks = load_tracks(archive, selected_ids, args.max_tracks)
    results: list[dict[str, Any]] = []
    counts = {"promote": 0, "retain-baseline": 0, "abstain": 0}
    bundle_root = args.bundle_root.resolve() if args.bundle_root else None
    if bundle_root and bundle_root.exists() and any(bundle_root.iterdir()):
        raise ValueError("--bundle-root must be absent or empty")

    for track in tracks:
        baseline_path = output_path(baseline_root, str(track["organized_dir"]))
        candidate_path = output_path(candidate_root, str(track["organized_dir"]))
        result: dict[str, Any] = {"id": track["id"]}
        try:
            archive_audio = archive / str(track["organized_dir"]) / "audio.mp3"
            if (
                not archive_audio.is_file()
                or sha256_file(archive_audio) != track["audio_sha256"]
            ):
                raise ValueError("archive audio does not match its indexed digest")
            if not baseline_path.is_file():
                raise ValueError("baseline sidecar is missing")
            if not candidate_path.is_file():
                raise ValueError("candidate sidecar is missing")
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
            candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
            baseline_evidence, baseline_evidence_source = _resolved_sidecar_evidence(
                baseline, track, archive, cache_root, profile
            )
            candidate_evidence, candidate_evidence_source = _resolved_sidecar_evidence(
                candidate, track, archive, cache_root, profile
            )
            comparison = compare_sidecars(
                baseline,
                candidate,
                baseline_evidence,
                candidate_evidence,
                args.maximum_onset_shift,
                args.high_confidence,
            )
            result.update(
                comparison,
                baseline_path=str(baseline_path),
                candidate_path=str(candidate_path),
                evidence_sha256=baseline_evidence["sha256"],
                evidence_sources={
                    "baseline": baseline_evidence_source,
                    "candidate": candidate_evidence_source,
                },
            )
            chosen = candidate if comparison["selected"] == "candidate" else baseline
            if bundle_root:
                write_json_atomic(bundle_root / f"{track['id']}.json", chosen)
        except Exception as error:
            result.update(
                {
                    "decision": "abstain",
                    "selected": "baseline",
                    "regressions": [str(error)],
                    "improvements": [],
                }
            )
            if bundle_root and baseline_path.is_file():
                baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
                write_json_atomic(bundle_root / f"{track['id']}.json", baseline)
        counts[result["decision"]] += 1
        results.append(result)
        print(json.dumps({"event": "compare-track", **result}), flush=True)

    report = {
        "version": 1,
        "profile_sha256": profile_digest(profile),
        "baseline_root": str(baseline_root),
        "candidate_root": str(candidate_root),
        "counts": counts,
        "passed": counts["abstain"] == 0,
        "tracks": results,
    }
    write_json_atomic(args.report.resolve(), report)
    print(json.dumps({"event": "compare-complete", **counts}), flush=True)
    return 2 if counts["abstain"] else 0


def run_tracks(args: argparse.Namespace, selected: set[str]) -> int:
    archive = args.archive.resolve()
    output_root = args.output_root.resolve()
    profile = Profile.load(args.profile)
    tracks = load_tracks(archive, selected, getattr(args, "max_tracks", 0))
    models = LocalModels(profile, args.model_dir.resolve(), args.verbose_model)
    classifier = (
        OllamaLineClassifier(profile.text_model, profile.text_model_url)
        if profile.text_model
        else None
    )
    pending = [
        track
        for track in tracks
        if args.force
        or not existing_matches(output_path(output_root, track["organized_dir"]), track)
    ]
    print(
        json.dumps(
            {
                "event": "start",
                "tracks": len(tracks),
                "pending": len(pending),
                "profile": asdict(profile),
                "preprocess": args.preprocess,
            }
        ),
        flush=True,
    )
    pending_ids = {str(track["id"]) for track in pending}
    outcomes: list[dict[str, Any]] = []
    for track in tracks:
        if str(track["id"]) in pending_ids:
            continue
        destination = output_path(output_root, track["organized_dir"])
        payload = json.loads(destination.read_text(encoding="utf-8"))
        quality = payload.get("quality") or {}
        generator = payload.get("generator") or {}
        outcomes.append(
            {
                "id": track["id"],
                "status": "skipped",
                "quality_status": quality.get("status", ""),
                "origin": payload.get("origin", ""),
                "preprocessing": generator.get("preprocessing", ""),
                "cues": len(payload.get("cues") or []),
                "line_coverage": quality.get("line_coverage", 0),
                "word_coverage": quality.get("word_coverage", 0),
                "mean_confidence": quality.get("mean_confidence", 0),
                "warnings": quality.get("warnings") or [],
                "path": str(destination.relative_to(output_root)),
            }
        )
    failures = 0
    started = time.monotonic()
    for number, track in enumerate(pending, 1):
        track_started = time.monotonic()
        try:
            _, outcome = process_track(
                archive,
                output_root,
                track,
                profile,
                models,
                args.cache_root.resolve(),
                args.preprocess,
                classifier,
                args.strategy,
            )
            outcome["seconds"] = round(time.monotonic() - track_started, 2)
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
            outcome = {
                "id": track.get("id"),
                "status": "failed",
                "error": str(error),
                "seconds": round(time.monotonic() - track_started, 2),
            }
            outcomes.append(outcome)
            print(
                json.dumps({"event": "error", "number": number, **outcome}),
                file=sys.stderr,
                flush=True,
            )

    counts = {
        status: sum(item.get("status") == status for item in outcomes)
        for status in ("verified", "warning", "text-only", "skipped", "failed")
    }
    quality_counts = {
        status: sum(item.get("quality_status") == status for item in outcomes)
        for status in ("verified", "warning")
    }
    report = {
        "version": 2,
        "profile": asdict(profile),
        "processed": len(pending),
        "counts": counts,
        "quality_counts": quality_counts,
        "seconds": round(time.monotonic() - started, 2),
        "tracks": outcomes,
    }
    write_json_atomic(output_root / "timing-report.json", report)
    if args.bundle_root:
        exported = export_bundle(output_root, args.bundle_root.resolve(), tracks)
        print(json.dumps({"event": "bundle", "exported": exported}), flush=True)
    print(
        json.dumps({"event": "complete", **counts, "quality_counts": quality_counts}),
        flush=True,
    )
    return 1 if failures else 0


def _safe_extract_zip(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        root = destination.resolve()
        for item in source.infolist():
            target = (destination / item.filename.lstrip("/")).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"zip member escapes destination: {item.filename}")
        source.extractall(destination)


def _download(url: str, destination: Path, expected_sha256: str = "") -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and (
        not expected_sha256 or sha256_file(destination) == expected_sha256
    ):
        return
    temporary = destination.with_name(destination.name + f".tmp-{os.getpid()}")
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "zak-radio/lyrics-harness"}
        )
        with (
            urllib.request.urlopen(request, timeout=60) as response,
            temporary.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
        if expected_sha256 and sha256_file(temporary) != expected_sha256:
            raise ValueError(f"checksum mismatch for {destination.name}")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def gold_fetch(args: argparse.Namespace) -> int:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    cache = args.cache_root.resolve() / "gold"
    dataset = manifest["datasets"].get(args.dataset)
    if not dataset:
        raise ValueError(f"unknown gold dataset: {args.dataset}")
    if args.dataset == "hansen":
        archive = cache / "sources" / dataset["archive"]
        _download(dataset["url"], archive, dataset["sha256"])
        extracted = cache / dataset["directory"]
        marker = extracted / ".complete"
        if not marker.exists():
            _safe_extract_zip(archive, extracted)
            marker.touch()
        print(
            json.dumps(
                {
                    "event": "gold-fetched",
                    "dataset": args.dataset,
                    "path": str(extracted),
                }
            )
        )
        return 0
    if args.dataset == "musdb18":
        if not args.accept_educational_license:
            raise ValueError(
                "MUSDB18 is educational-use data; rerun with "
                "--accept-educational-license after reviewing its license"
            )
        audio = cache / "sources" / "musdb18.zip"
        _download(dataset["audio_url"], audio)
        annotations = cache / "musdb18-annotations"
        annotations.mkdir(parents=True, exist_ok=True)
        metadata = json.loads(
            urllib.request.urlopen(dataset["annotations_api"], timeout=60).read()
        )
        for item in metadata["files"]:
            _download(item["links"]["self"], annotations / item["key"])
        print(
            json.dumps(
                {"event": "gold-fetched", "dataset": args.dataset, "path": str(cache)}
            )
        )
        return 0
    if args.dataset == "jamendo":
        root = cache / dataset["directory"]
        marker = root / ".complete"
        base_url = dataset["base_url"].rstrip("/")
        for relative, expected_sha256 in dataset["assets"].items():
            url = base_url + "/" + urllib.parse.quote(relative, safe="/")
            _download(url, root / relative, expected_sha256)
        marker.touch()
        print(
            json.dumps(
                {
                    "event": "gold-fetched",
                    "dataset": args.dataset,
                    "path": str(root),
                    "songs": dataset["song_count"],
                }
            )
        )
        return 0
    raise ValueError(f"unsupported gold dataset: {args.dataset}")


def parse_hansen_words(path: Path) -> list[dict[str, Any]]:
    words = []
    with path.open(encoding="utf-8") as source:
        for row in csv.reader(source, delimiter="\t"):
            if len(row) < 3:
                continue
            start = float(row[0].replace(",", "."))
            end = float(row[1].replace(",", "."))
            normalized = normalized_word(row[2])
            if normalized and not normalized.startswith("breath"):
                words.append(
                    {
                        "start": start,
                        "end": end,
                        "text": row[2],
                        "normalized": normalized,
                    }
                )
    return words


def _jamendo_song_id(file_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", Path(file_name).stem.casefold()).strip("_")


def load_jamendo_songs(root: Path, dataset: dict[str, Any]) -> list[dict[str, Any]]:
    metadata_relative = str(dataset["metadata"])
    metadata_path = root / metadata_relative
    songs: list[dict[str, Any]] = []
    with metadata_path.open(encoding="utf-8") as source:
        for raw in source:
            payload = json.loads(raw)
            song_id = _jamendo_song_id(str(payload["file_name"]))
            held_out = (
                int(hashlib.sha256(song_id.encode()).hexdigest()[:2], 16) % 4 == 0
            )
            reference = []
            for word in payload.get("words") or []:
                normalized = normalized_word(str(word.get("text") or ""))
                if not normalized:
                    continue
                reference.append(
                    {
                        "start": float(word["start"]),
                        "end": float(word["end"]),
                        "text": str(word["text"]),
                        "normalized": normalized,
                    }
                )
            songs.append(
                {
                    "id": song_id,
                    "split": "held-out" if held_out else "development",
                    "mix": str(Path(metadata_relative).parent / payload["file_name"]),
                    "text": str(payload["text"]),
                    "reference": reference,
                    "license_type": str(payload.get("license_type") or ""),
                    "genre": str(payload.get("genre") or ""),
                    "polyphonic": bool(payload.get("polyphonic")),
                    "lyric_overlap": bool(payload.get("lyric_overlap")),
                    "non_lexical": bool(payload.get("non_lexical")),
                }
            )
    if len(songs) != int(dataset["song_count"]):
        raise ValueError(
            f"JamendoLyrics metadata has {len(songs)} songs; "
            f"expected {dataset['song_count']}"
        )
    return songs


def _song_lyrics(song: dict[str, Any], gold_root: Path) -> tuple[str, str]:
    if "text" in song:
        text = str(song["text"])
        digest = hashlib.sha256(text.encode()).hexdigest()
        return text, digest
    path = gold_root / song["lyrics"]
    return path.read_text(encoding="utf-8"), sha256_file(path)


def word_error_rate(reference: Sequence[str], prediction: Sequence[str]) -> float:
    if not reference:
        return 0.0 if not prediction else 1.0
    previous = list(range(len(prediction) + 1))
    for index, expected in enumerate(reference, 1):
        current = [index]
        for predicted_index, actual in enumerate(prediction, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[predicted_index] + 1,
                    previous[predicted_index - 1] + (expected != actual),
                )
            )
        previous = current
    return previous[-1] / len(reference)


def edit_alignment_pairs(
    reference: Sequence[str], prediction: Sequence[str]
) -> list[tuple[int, int]]:
    """Return equal-token pairs from a minimum-edit monotonic alignment."""

    rows = len(reference) + 1
    columns = len(prediction) + 1
    distance = [[0] * columns for _ in range(rows)]
    for index in range(rows):
        distance[index][0] = index
    for index in range(columns):
        distance[0][index] = index
    for row in range(1, rows):
        for column in range(1, columns):
            distance[row][column] = min(
                distance[row - 1][column] + 1,
                distance[row][column - 1] + 1,
                distance[row - 1][column - 1]
                + (reference[row - 1] != prediction[column - 1]),
            )
    pairs: list[tuple[int, int]] = []
    row, column = len(reference), len(prediction)
    while row or column:
        if (
            row
            and column
            and reference[row - 1] == prediction[column - 1]
            and distance[row][column] == distance[row - 1][column - 1]
        ):
            pairs.append((row - 1, column - 1))
            row -= 1
            column -= 1
        elif row and distance[row][column] == distance[row - 1][column] + 1:
            row -= 1
        elif column and distance[row][column] == distance[row][column - 1] + 1:
            column -= 1
        else:
            row -= 1
            column -= 1
    pairs.reverse()
    return pairs


def gold_metrics(
    reference: Sequence[dict[str, Any]],
    prediction: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    reference_words = [str(word["normalized"]) for word in reference]
    prediction_words = [
        normalized_word(str(word.get("text") or word.get("normalized") or ""))
        for word in prediction
    ]
    errors: list[float] = []
    pairs = edit_alignment_pairs(reference_words, prediction_words)
    for reference_index, prediction_index in pairs:
        errors.append(
            abs(
                float(reference[reference_index]["start"])
                - float(prediction[prediction_index]["start"])
            )
        )
    ordered = sorted(errors)

    def percentile(value: float) -> float | None:
        if not ordered:
            return None
        index = min(len(ordered) - 1, math.ceil(value * len(ordered)) - 1)
        return round(ordered[index], 6)

    return {
        "reference_words": len(reference),
        "predicted_words": len(prediction),
        "matched_words": len(pairs),
        "word_coverage": round(len(pairs) / len(reference), 6) if reference else 0,
        "wer": round(word_error_rate(reference_words, prediction_words), 6),
        "median_onset_error": percentile(0.5),
        "p90_onset_error": percentile(0.9),
        "within_500ms": round(sum(error <= 0.5 for error in errors) / len(errors), 6)
        if errors
        else 0,
        "beyond_1s": round(sum(error > 1 for error in errors) / len(errors), 6)
        if errors
        else 0,
    }


def confidence_calibration(
    reference: Sequence[dict[str, Any]],
    prediction: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Measure timing accuracy inside fixed ASR-confidence bands."""

    boundaries = (
        (0.0, 0.50, "0.00-0.49"),
        (0.50, 0.65, "0.50-0.64"),
        (0.65, 0.75, "0.65-0.74"),
        (0.75, 1.01, "0.75-1.00"),
    )
    bins = {
        label: {"label": label, "matched_words": 0, "within_500ms": 0, "error": 0.0}
        for _, _, label in boundaries
    }
    reference_words = [str(word["normalized"]) for word in reference]
    prediction_words = [
        normalized_word(str(word.get("text") or word.get("normalized") or ""))
        for word in prediction
    ]
    for reference_index, prediction_index in edit_alignment_pairs(
        reference_words, prediction_words
    ):
        predicted = prediction[prediction_index]
        confidence = max(0.0, min(1.0, float(predicted.get("confidence") or 0)))
        error = abs(
            float(reference[reference_index]["start"]) - float(predicted["start"])
        )
        for lower, upper, label in boundaries:
            if lower <= confidence < upper:
                current = bins[label]
                current["matched_words"] += 1
                current["within_500ms"] += int(error <= 0.5)
                current["error"] += error
                break
    calibrated = []
    for _, _, label in boundaries:
        current = bins[label]
        count = int(current["matched_words"])
        calibrated.append(
            {
                "confidence": label,
                "matched_words": count,
                "within_500ms": (
                    round(float(current["within_500ms"]) / count, 6) if count else None
                ),
                "mean_onset_error": (
                    round(float(current["error"]) / count, 6) if count else None
                ),
            }
        )
    return calibrated


def _prediction_words(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        word
        for cue in payload.get("cues", [])
        for word in cue.get("words", [])
        if normalized_word(str(word.get("text") or ""))
    ]


def probe_duration(path: Path) -> float:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or "ffprobe failed")
    duration = float(completed.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"invalid audio duration for {path}")
    return duration


def generate_gold_prediction(
    *,
    song: dict[str, Any],
    representation: str,
    lane: str,
    gold_root: Path,
    prediction_path: Path,
    profile: Profile,
    models: LocalModels,
    cache_root: Path,
    preprocess: str,
    strategy: str,
) -> dict[str, Any]:
    audio = gold_root / song[representation]
    audio_sha256 = sha256_file(audio)
    lyrics_text, lyrics_sha256 = _song_lyrics(song, gold_root)
    cleaning = clean_lyrics(lyrics_text)
    supplied = lane == "alignment"
    source_words = (
        [normalized_word(word) for line in cleaning.lines for word in line.words]
        if supplied
        else []
    )
    candidates = _preprocess_candidates(
        audio, audio_sha256, cache_root, profile, preprocess
    )
    _evaluate_audio_candidates(
        candidates, models, source_words, not supplied, cache_root
    )
    selected = choose_candidate(candidates, profile.candidate_improvement)
    if preprocess == "auto":
        selected = _maybe_add_demucs(
            candidates,
            selected,
            audio,
            audio_sha256,
            cache_root,
            profile,
            models,
            source_words,
            not supplied,
        )
    if supplied:
        lines = list(cleaning.lines)
        display_text = cleaning.display_text
        origin = "provided"
    else:
        lines = transcript_lines(selected.transcript)
        display_text = _display_text(lines)
        origin = "transcribed"
    if not display_text:
        raise RuntimeError("local models produced no lyric text")
    duration = probe_duration(audio)
    alignment_cache = (
        cache_root
        / "gold-alignment"
        / _cache_key(
            audio_sha256,
            profile,
            f"{song['id']}-{representation}-{lane}-{selected.name}-monotonic-lines-v1",
        )
    )
    cues, quality = align_in_windows(
        models,
        selected.path,
        lines,
        selected.observed or [],
        duration,
        alignment_cache,
        profile.window_lines,
    )
    if strategy == "v6":
        cues, _ = repair_timings_from_consensus(lines, cues, candidates, profile)
        cues = sanitize_cue_timings(cues)
    annotate_cue_quality(cues, profile)
    quality["status"] = quality_status(quality, origin, profile)
    quality["warnings"] = list(
        dict.fromkeys(
            [
                *quality.get("warnings", []),
                *([selected.warning] if selected.warning else []),
                *(
                    ["gold transcription lane received no supplied lyrics"]
                    if not supplied
                    else []
                ),
            ]
        )
    )
    payload = {
        "version": 2,
        "track_id": f"gold:{song['id']}:{representation}:{lane}",
        "audio_sha256": audio_sha256,
        "duration": duration,
        "language": profile.language,
        "display_text": display_text,
        "origin": origin,
        "generator": {
            "name": "zak-radio-lyrics-harness",
            "version": HARNESS_VERSION,
            "strategy": strategy,
            "profile_sha256": profile_digest(profile),
            "stable_ts": models.stable_version,
            "aligner_model": profile.stable_model,
            "transcriber_model": profile.heart_model if not supplied else "",
            "transcriber_revision": profile.heart_revision if not supplied else "",
            "preprocessing": selected.name,
        },
        "quality": quality,
        "cues": cues,
    }
    if supplied:
        payload["source_lyrics_sha256"] = lyrics_sha256
    write_json_atomic(prediction_path, payload)
    return {
        "song": song["id"],
        "representation": representation,
        "lane": lane,
        "preprocessing": selected.name,
        "quality": quality,
        "candidates": [
            {
                "name": candidate.name,
                "score": candidate.score,
                "score_details": candidate.score_details or {},
                "accepted": candidate.accepted,
                "cache_hit": candidate.cache_hit,
                "warning": candidate.warning,
                "error": candidate.error,
            }
            for candidate in candidates
        ],
    }


def gold_run(args: argparse.Namespace) -> int:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    dataset = manifest["datasets"][args.dataset]
    root = args.cache_root.resolve() / "gold" / dataset["directory"]
    if not root.exists():
        raise ValueError(
            f"{args.dataset} gold data is missing; run "
            f"`gold fetch --dataset {args.dataset}` first"
        )
    if args.dataset == "hansen":
        songs = dataset["songs"]
    elif args.dataset == "jamendo":
        songs = load_jamendo_songs(root, dataset)
        if args.representation == "vocals":
            raise ValueError("JamendoLyrics provides full mixes, not isolated vocals")
    else:
        raise ValueError(f"{args.dataset} does not have a gold runner")
    predictions = args.output_root.resolve()
    predictions.mkdir(parents=True, exist_ok=True)
    profile = Profile.load(args.profile)
    models = LocalModels(profile, args.model_dir.resolve(), args.verbose_model)
    results = []
    failures = []
    generation = []
    thresholds = manifest["thresholds"]
    for song in songs:
        if args.split != "all" and song["split"] != args.split:
            continue
        if args.song and song["id"] not in args.song:
            continue
        reference = (
            parse_hansen_words(root / song["word_onsets"])
            if args.dataset == "hansen"
            else song["reference"]
        )
        representations = (
            ("mix", "vocals")
            if args.representation == "both" and args.dataset == "hansen"
            else ("mix",)
            if args.representation == "both"
            else (args.representation,)
        )
        for representation in representations:
            for lane in (
                args.lane if args.lane != ["both"] else ("alignment", "transcription")
            ):
                prediction_path = (
                    predictions / f"{song['id']}-{representation}-{lane}.json"
                )
                regenerate = args.force or not prediction_path.exists()
                if not regenerate:
                    existing = json.loads(prediction_path.read_text(encoding="utf-8"))
                    regenerate = (
                        (existing.get("generator") or {}).get("profile_sha256")
                        != profile_digest(profile)
                        or (existing.get("generator") or {}).get("version")
                        != HARNESS_VERSION
                        or (existing.get("generator") or {}).get("strategy")
                        != args.strategy
                    )
                if regenerate:
                    try:
                        generation.append(
                            generate_gold_prediction(
                                song=song,
                                representation=representation,
                                lane=lane,
                                gold_root=root,
                                prediction_path=prediction_path,
                                profile=profile,
                                models=models,
                                cache_root=args.cache_root.resolve(),
                                preprocess=args.preprocess,
                                strategy=args.strategy,
                            )
                        )
                    except Exception as error:
                        failures.append(
                            f"{song['id']}-{representation}-{lane} generation failed: {error}"
                        )
                        continue
                payload = json.loads(prediction_path.read_text(encoding="utf-8"))
                predicted_words = _prediction_words(payload)
                if reference:
                    annotated_start = float(reference[0]["start"])
                    annotated_end = float(reference[-1]["end"])
                    predicted_words = [
                        word
                        for word in predicted_words
                        if float(word["start"]) >= annotated_start - 0.5
                        and float(word["start"]) <= annotated_end + 0.5
                    ]
                metrics = gold_metrics(reference, predicted_words)
                metrics["confidence_calibration"] = confidence_calibration(
                    reference, predicted_words
                )
                metrics.update(
                    {
                        "song": song["id"],
                        "split": song["split"],
                        "representation": representation,
                        "lane": lane,
                        **(
                            {
                                "genre": song["genre"],
                                "license_type": song["license_type"],
                                "polyphonic": song["polyphonic"],
                                "lyric_overlap": song["lyric_overlap"],
                                "non_lexical": song["non_lexical"],
                            }
                            if args.dataset == "jamendo"
                            else {}
                        ),
                    }
                )
                limits = thresholds[lane]
                passed = (
                    metrics["word_coverage"] >= limits["word_coverage"]
                    and metrics["median_onset_error"] is not None
                    and metrics["median_onset_error"] <= limits["median_onset_error"]
                    and metrics["p90_onset_error"] <= limits["p90_onset_error"]
                    and metrics["within_500ms"] >= limits["within_500ms"]
                    and metrics["beyond_1s"] <= limits["beyond_1s"]
                )
                if lane == "transcription":
                    wer_limit = limits[
                        "wer_vocals" if representation == "vocals" else "wer_mix"
                    ]
                    passed = passed and metrics["wer"] <= wer_limit
                metrics["passed"] = passed
                if not passed:
                    failures.append(
                        f"{song['id']}-{representation}-{lane} missed its gold gate"
                    )
                results.append(metrics)
    report = {
        "version": 1,
        "dataset": args.dataset,
        "split": args.split,
        "profile": asdict(profile),
        "strategy": args.strategy,
        "thresholds": thresholds,
        "passed": not failures,
        "failures": failures,
        "generation": generation,
        "results": results,
    }
    write_json_atomic(args.report.resolve(), report)
    print(
        json.dumps(
            {
                "event": "gold-complete",
                "passed": not failures,
                "failures": len(failures),
            }
        )
    )
    return 0 if not failures else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    def common(command: argparse.ArgumentParser) -> None:
        command.add_argument("--archive", type=Path, required=True)
        command.add_argument("--output-root", type=Path, required=True)
        command.add_argument("--bundle-root", type=Path)
        command.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
        command.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
        command.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
        command.add_argument(
            "--preprocess",
            choices=("auto", "raw", "ffmpeg", "demucs"),
            default="auto",
        )
        command.add_argument("--force", action="store_true")
        command.add_argument("--verbose-model", action="store_true")
        command.add_argument(
            "--strategy",
            choices=("v5", "v6"),
            default="v6",
            help="run the frozen v5 behavior or the tuned v6 behavior",
        )

    song = subcommands.add_parser("song", help="process one archive song")
    common(song)
    song.add_argument("--track-id", required=True)

    bulk = subcommands.add_parser("bulk", help="process an archive")
    common(bulk)
    bulk.add_argument("--track-id", action="append", default=[])
    bulk.add_argument("--max-tracks", type=int, default=0)

    compare = subcommands.add_parser(
        "compare",
        help="fail-closed baseline/candidate regression comparison",
    )
    compare.add_argument("--archive", type=Path, required=True)
    compare.add_argument("--baseline-root", type=Path, required=True)
    compare.add_argument("--candidate-root", type=Path, required=True)
    compare.add_argument("--report", type=Path, required=True)
    compare.add_argument("--bundle-root", type=Path)
    compare.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    compare.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    compare.add_argument("--track-id", action="append", default=[])
    compare.add_argument("--max-tracks", type=int, default=0)
    compare.add_argument("--high-confidence", type=float, default=0.75)
    compare.add_argument("--maximum-onset-shift", type=float, default=0.5)

    gold = subcommands.add_parser("gold", help="manage and evaluate gold datasets")
    gold_subcommands = gold.add_subparsers(dest="gold_command", required=True)
    fetch = gold_subcommands.add_parser("fetch")
    fetch.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    fetch.add_argument("--manifest", type=Path, default=DEFAULT_GOLD_MANIFEST)
    fetch.add_argument(
        "--dataset", choices=("hansen", "jamendo", "musdb18"), default="hansen"
    )
    fetch.add_argument("--accept-educational-license", action="store_true")

    run = gold_subcommands.add_parser("run")
    run.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    run.add_argument("--manifest", type=Path, default=DEFAULT_GOLD_MANIFEST)
    run.add_argument("--dataset", choices=("hansen", "jamendo"), default="hansen")
    run.add_argument("--output-root", type=Path, required=True)
    run.add_argument("--report", type=Path, required=True)
    run.add_argument(
        "--split", choices=("development", "held-out", "all"), default="held-out"
    )
    run.add_argument("--song", action="append", default=[])
    run.add_argument(
        "--representation",
        choices=("mix", "vocals", "both"),
        default="both",
    )
    run.add_argument(
        "--lane",
        action="append",
        choices=("alignment", "transcription", "both"),
        default=[],
    )
    run.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    run.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    run.add_argument(
        "--preprocess",
        choices=("auto", "raw", "ffmpeg", "demucs"),
        default="auto",
    )
    run.add_argument("--force", action="store_true")
    run.add_argument("--verbose-model", action="store_true")
    run.add_argument(
        "--strategy",
        choices=("v5", "v6"),
        default="v6",
        help="run the frozen v5 behavior or the tuned v6 behavior",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "song":
        return run_tracks(args, {args.track_id})
    if args.command == "bulk":
        return run_tracks(args, set(args.track_id))
    if args.command == "compare":
        if not 0 <= args.high_confidence <= 1:
            raise ValueError("--high-confidence must be between 0 and 1")
        if args.maximum_onset_shift < 0:
            raise ValueError("--maximum-onset-shift cannot be negative")
        return run_compare(args)
    if args.command == "gold" and args.gold_command == "fetch":
        return gold_fetch(args)
    if args.command == "gold" and args.gold_command == "run":
        if not args.lane:
            args.lane = ["both"]
        if "both" in args.lane and len(args.lane) != 1:
            raise ValueError("--lane both cannot be combined with another lane")
        return gold_run(args)
    raise AssertionError("unreachable command")


if __name__ == "__main__":
    raise SystemExit(main())
