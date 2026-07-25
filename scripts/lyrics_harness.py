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


HARNESS_VERSION = "4"
MODEL_CACHE_VERSION = "3"
DEFAULT_MODEL_DIR = Path.home() / ".cache/zak-radio-aligner/models"
DEFAULT_CACHE_ROOT = Path.home() / ".cache/zak-radio-aligner"
DEFAULT_PROFILE = Path(__file__).resolve().parent.parent / "testdata/lyrics-gold/profile-v1.json"
DEFAULT_GOLD_MANIFEST = (
    Path(__file__).resolve().parent.parent / "testdata/lyrics-gold/manifest.json"
)

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
RECOVERABLE_METADATA_REASONS = frozenset({"local-text-model", "prompt-prose"})
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
    return [word for word in (normalized_word(item) for item in WORD_RE.findall(value)) if word]


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
    enclosed = (
        len(stripped) >= 2
        and (stripped[0], stripped[-1]) in {("(", ")"), ("[", "]")}
    )
    return enclosed and bool(PRODUCTION_CUE_RE.search(stripped))


def _looks_like_prompt_prose(value: str) -> bool:
    words = WORD_RE.findall(value)
    return (
        bool(PROMPT_PROSE_RE.search(value))
        and (len(words) >= 10 or any(mark in value for mark in (":", ";", "—")))
    )


def _display_text(lines: Sequence[CandidateLine]) -> str:
    parts: list[str] = []
    previous: CandidateLine | None = None
    for line in lines:
        if previous and (
            line.section != previous.section or line.source_line > previous.source_line + 1
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
                    source_line, original, normalized, "metadata", "after-editorial-tail"
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
                LineDecision(source_line, original, normalized, "metadata", "field-label")
            )
            continue
        if re.match(
            r"^[^\w]*(?:title|style|genre|tempo|key)\s*:", normalized, re.I
        ):
            decisions.append(
                LineDecision(source_line, original, normalized, "metadata", "prompt-field")
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
                    source_line, original, normalized, "metadata", "production-direction"
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
        if (
            re.match(r"^(?:instrumental|outro)\b", section, re.IGNORECASE)
            and re.fullmatch(
                r"(?:stomp|clap|low hum|wind)[.!…]*", normalized, re.IGNORECASE
            )
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
                LineDecision(source_line, original, normalized, "metadata", "prompt-prose")
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
            LineDecision(source_line, original, normalized, "lyrics", "deterministic", section)
        )
        saw_content = True

    warnings: list[str] = []
    model_decisions: dict[int, str] = {}
    if ambiguous and classifier:
        try:
            model_decisions = classifier([(number, value) for number, _, value, _ in ambiguous])
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError) as error:
            warnings.append(f"local text classification unavailable: {error}")
    elif ambiguous:
        warnings.append(f"{len(ambiguous)} ambiguous lines preserved without model classification")

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
                "local-text-model" if source_line in model_decisions else "safe-fallback",
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
        return bool(payload.get("cues")) or bool(str(payload.get("display_text") or "").strip())
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
            segment_words = flatten_result_words(
                SimpleNamespace(segments=[segment])
            )
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


def _sequence_score(reference: Sequence[str], observed: Sequence[ObservedWord]) -> tuple[float, dict[str, float]]:
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
    if not source_words and transcript_words:
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
    raw = next((candidate for candidate in usable if candidate.name == "raw"), usable[0])
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


def _run(command: Sequence[str]) -> None:
    completed = subprocess.run(
        list(command),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
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
    with tempfile.TemporaryDirectory(prefix="zak-radio-demucs-") as temporary:
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
                str(destination),
            ]
        )
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
            from transformers import pipeline

            local_model = self.model_dir / "HeartTranscriptor-oss"
            model_name = str(local_model) if local_model.exists() else self.profile.heart_model
            self._heart = pipeline(
                "automatic-speech-recognition",
                model=model_name,
                device=0,
                dtype=torch.float16,
                chunk_length_s=30,
                stride_length_s=5,
                **(
                    {"revision": self.profile.heart_revision}
                    if model_name == self.profile.heart_model
                    else {}
                ),
            )
        result = self._heart(
            str(audio),
            return_timestamps=True,
            generate_kwargs={
                "language": self.profile.language,
                "do_sample": False,
                "num_beams": 1,
            },
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

    expected = [
        normalized_word(word)
        for line in lines
        for word in line.words
    ]
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
        for word_index, weight in zip(
            range(gap_start, gap_end), weights, strict=True
        ):
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
                boundaries.append(
                    min(duration, max(boundaries[-1] + 0.02, boundary))
                )
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
        word.get("confidence", 0)
        for cue in monotonic
        for word in cue.get("words", [])
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


def clean_generated_transcript(text: str) -> str:
    """Remove high-confidence ASR boilerplate and consecutive duplicate sentences."""

    retained: list[str] = []
    previous = ""
    for raw in re.split(r"(?<=[.!?])\s+|\n+", text):
        value = raw.strip(" \t\r\n,")
        if not value or GENERIC_TRANSCRIPT_RE.search(value):
            continue
        normalized = " ".join(tokenize(value))
        if normalized and normalized == previous:
            continue
        retained.append(value)
        previous = normalized
    return "\n".join(retained)


def transcript_lines(text: str) -> list[CandidateLine]:
    lines: list[CandidateLine] = []
    cleaned = clean_generated_transcript(text)
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

    transcript_evidence = tokenize(clean_generated_transcript(transcript))
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
            if matched < minimum_matches or matched / len(reference) < minimum_coverage:
                continue
            recovered.append(
                CandidateLine(decision.source_line, decision.section, value, words)
            )
    return recovered, considered


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
                    f"{'heart' if generated_transcript else 'anchors'}"
                ),
            )
            cache_path = cache_root / "transcripts" / f"{transcript_key}.json"
            if cache_path.exists():
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                candidate.transcript = str(cached.get("transcript") or "")
                candidate.warning = str(cached.get("warning") or "")
                candidate.observed = [
                    ObservedWord(**word) for word in cached["observed"]
                ]
                candidate.cache_hit = True
            else:
                if generated_transcript:
                    try:
                        candidate.transcript = clean_generated_transcript(
                            models.heart_transcribe(candidate.path)
                        )
                    except Exception as error:
                        candidate.warning = (
                            "singing transcriber failed; stable-ts fallback used: "
                            f"{error}"
                        )
                candidate.stable_result = models.stable_transcribe(candidate.path)
                candidate.observed = observed_words(candidate.stable_result)
                if generated_transcript and not candidate.transcript:
                    candidate.transcript = clean_generated_transcript(
                        " ".join(word.text for word in candidate.observed)
                    )
                write_json_atomic(
                    cache_path,
                    {
                        "version": 1,
                        "transcript": candidate.transcript,
                        "warning": candidate.warning,
                        "observed": [
                            asdict(word) for word in candidate.observed
                        ],
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


def process_track(
    archive: Path,
    output_root: Path,
    track: dict[str, Any],
    profile: Profile,
    models: LocalModels,
    cache_root: Path,
    preprocess: str = "auto",
    text_classifier: Callable[[Sequence[tuple[int, str]]], dict[int, str]] | None = None,
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
    _evaluate_audio_candidates(
        candidates, models, source_words, generated, cache_root
    )
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

    recovered_prompt = False
    recovered_considered = 0
    if generated:
        recovered, recovered_considered = recover_audio_supported_metadata(
            cleaning, selected.transcript, selected.observed or []
        )
        if recovered:
            lines = recovered
            display_text = _display_text(lines)
            origin = "reconciled"
            recovered_prompt = True
        else:
            lines = transcript_lines(selected.transcript)
            display_text = _display_text(lines)
            origin = "transcribed"
    else:
        lines = list(cleaning.lines)
        display_text = cleaning.display_text
        origin = "reconciled" if any(
            decision.decision == "metadata" for decision in cleaning.decisions
        ) else "provided"
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
    quality["warnings"] = list(
        dict.fromkeys(
            [
                *cleaning.warnings,
                *quality.get("warnings", []),
                *([selected.warning] if selected.warning else []),
                *(
                    [
                        "prompt-like source text was recovered only where local audio evidence supported it"
                    ]
                    if recovered_prompt
                    else []
                ),
                *(
                    [
                        f"{recovered_considered - len(lines)} prompt-like source clauses had no reliable audio support"
                    ]
                    if recovered_prompt and recovered_considered > len(lines)
                    else []
                ),
                *(
                    ["lyrics were transcribed locally because no usable source lyrics were available"]
                    if generated and not recovered_prompt
                    else []
                ),
            ]
        )
    )
    quality["status"] = quality_status(quality, origin, profile)
    if recovered_prompt:
        quality["status"] = "warning"
    if quality["status"] == "warning" and not quality["warnings"]:
        quality["warnings"].append("lyrics did not meet the verified quality profile")

    try:
        import torch

        device = torch.cuda.get_device_name(0)
    except Exception:
        device = "unknown"
    payload: dict[str, Any] = {
        "version": 2,
        "track_id": track["id"],
        "audio_sha256": track["audio_sha256"],
        "duration": duration,
        "language": profile.language,
        "display_text": display_text,
        "origin": origin,
        "generator": {
            "name": "zak-radio-lyrics-harness",
            "version": HARNESS_VERSION,
            "profile_sha256": profile_digest(profile),
            "stable_ts": models.stable_version,
            "aligner_model": profile.stable_model,
            "transcriber_model": profile.heart_model if generated else "",
            "transcriber_revision": profile.heart_revision if generated else "",
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
        outcomes.append(
            {
                "id": track["id"],
                "status": "skipped",
                "quality_status": (payload.get("quality") or {}).get("status", ""),
                "origin": payload.get("origin", ""),
                "cues": len(payload.get("cues") or []),
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
    report = {
        "version": 2,
        "profile": asdict(profile),
        "processed": len(pending),
        "counts": counts,
        "seconds": round(time.monotonic() - started, 2),
        "tracks": outcomes,
    }
    write_json_atomic(output_root / "timing-report.json", report)
    if args.bundle_root:
        exported = export_bundle(output_root, args.bundle_root.resolve(), tracks)
        print(json.dumps({"event": "bundle", "exported": exported}), flush=True)
    print(json.dumps({"event": "complete", **counts}), flush=True)
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
        request = urllib.request.Request(url, headers={"User-Agent": "zak-radio/lyrics-harness"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open(
            "wb"
        ) as output:
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
        print(json.dumps({"event": "gold-fetched", "dataset": args.dataset, "path": str(extracted)}))
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
        print(json.dumps({"event": "gold-fetched", "dataset": args.dataset, "path": str(cache)}))
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
                    {"start": start, "end": end, "text": row[2], "normalized": normalized}
                )
    return words


def _jamendo_song_id(file_name: str) -> str:
    return re.sub(
        r"[^a-z0-9]+", "_", Path(file_name).stem.casefold()
    ).strip("_")


def load_jamendo_songs(
    root: Path, dataset: dict[str, Any]
) -> list[dict[str, Any]]:
    metadata_relative = str(dataset["metadata"])
    metadata_path = root / metadata_relative
    songs: list[dict[str, Any]] = []
    with metadata_path.open(encoding="utf-8") as source:
        for raw in source:
            payload = json.loads(raw)
            song_id = _jamendo_song_id(str(payload["file_name"]))
            held_out = int(hashlib.sha256(song_id.encode()).hexdigest()[:2], 16) % 4 == 0
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
            for lane in args.lane if args.lane != ["both"] else ("alignment", "transcription"):
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
        "thresholds": thresholds,
        "passed": not failures,
        "failures": failures,
        "generation": generation,
        "results": results,
    }
    write_json_atomic(args.report.resolve(), report)
    print(json.dumps({"event": "gold-complete", "passed": not failures, "failures": len(failures)}))
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

    song = subcommands.add_parser("song", help="process one archive song")
    common(song)
    song.add_argument("--track-id", required=True)

    bulk = subcommands.add_parser("bulk", help="process an archive")
    common(bulk)
    bulk.add_argument("--track-id", action="append", default=[])
    bulk.add_argument("--max-tracks", type=int, default=0)

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
    run.add_argument("--split", choices=("development", "held-out", "all"), default="held-out")
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
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "song":
        return run_tracks(args, {args.track_id})
    if args.command == "bulk":
        return run_tracks(args, set(args.track_id))
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
