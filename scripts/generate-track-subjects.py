#!/usr/bin/env python3
"""Create concise titles for tracks whose imported title is absent or metadata noise."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.request
from pathlib import Path
from typing import Any


SECTION = re.compile(
    r"^\[\s*(?:lyrics?|hook|verse|chorus|bridge|intro|outro|pre-?chorus)\b.*\]$",
    re.IGNORECASE,
)
BARE_SECTION = re.compile(
    r"^(?:lyrics?|hook|verse|chorus|bridge|intro|outro|pre-?chorus)\s*(?::.*)?$",
    re.IGNORECASE,
)
PRODUCTION = re.compile(
    r"^\([^)]*(?:ambient|beat|click|drum|guitar|hum|instrument|pad|reverb|"
    r"sax|sfx|synth|whisper)[^)]*\)$",
    re.IGNORECASE,
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--curated", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--timed-lyrics-root",
        type=Path,
        help="prefer cleaned or locally transcribed display_text from lyric sidecars",
    )
    parser.add_argument("--track-id", action="append", default=[])
    parser.add_argument("--model", default="gemma4:e2b")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    return parser.parse_args()


def clean_label(value: Any) -> str:
    label = str(value or "").strip()
    label = re.sub(r"^#+\s*", "", label)
    label = re.sub(
        r"^(?:🎵\s*)?(?:title|subject)\s*:\s*", "", label, flags=re.IGNORECASE
    )
    return label.strip("“”\"'` ").strip()


def weak_label(value: Any) -> bool:
    label = clean_label(value)
    return (
        not label
        or len(label) > 88
        or label.isdecimal()
        or label.casefold().startswith("artist:")
        or (
            (label.startswith("(") and label.endswith(")"))
            or (label.startswith("[") and label.endswith("]"))
        )
        or bool(SECTION.match(label))
        or bool(
            re.match(
                r"^(?:lyrics?|verse|chorus|bridge|intro|outro|pre-?chorus)\]$",
                label,
                re.IGNORECASE,
            )
        )
        or bool(BARE_SECTION.match(label))
    )


def valid_subject(value: Any) -> bool:
    subject = clean_label(value)
    words = re.findall(r"[\w'’]+", subject, re.UNICODE)
    return (
        2 <= len(subject) <= 60
        and 1 <= len(words) <= 8
        and not weak_label(subject)
        and not any(character in subject for character in "[]{}:\n\r")
        and subject.casefold() not in {"original track", "untitled", "unknown"}
    )


def fallback_subject(lyrics: str) -> str:
    for raw in lyrics.splitlines():
        line = clean_label(raw)
        if (
            not line
            or SECTION.match(line)
            or BARE_SECTION.match(line)
            or PRODUCTION.match(line)
            or line.casefold() in {"user fix it.", "user: fix it."}
        ):
            continue
        words = re.findall(r"[\w'’]+", line, re.UNICODE)
        if 2 <= len(words) <= 8 and len(line) <= 60:
            return line.rstrip(".,;—–- ")
    return "Original track"


def title_evidence(
    archive: Path,
    track: dict[str, Any],
    timed_lyrics_root: Path | None,
) -> tuple[str, str]:
    """Prefer audio-derived clean text, then source lyrics, then the prompt."""

    if timed_lyrics_root:
        candidates = (
            timed_lyrics_root / f"{track['id']}.json",
            timed_lyrics_root / track["organized_dir"] / "lyrics.timed.json",
        )
        for path in candidates:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if payload.get("track_id") == track["id"] and payload.get(
                "audio_sha256"
            ) == track.get("audio_sha256"):
                display_text = str(payload.get("display_text") or "").strip()
                if display_text:
                    return display_text, "timed-lyrics"

    directory = archive / track["organized_dir"]
    for filename, kind in (("lyrics.md", "source-lyrics"), ("prompt.txt", "prompt")):
        path = directory / filename
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            return text, kind
    return "", "none"


def ollama_subject(
    endpoint: str,
    model: str,
    imported_title: str,
    imported_summary: str,
    evidence: str,
    evidence_kind: str = "lyrics",
) -> str:
    prompt = f"""Create a title for this song.

Return only JSON in this exact shape: {{"subject":"two to six words"}}
The result must sound like a concise human-facing song title, not a synopsis,
topic label, filename, or production instruction. Ground it only in the
evidence below. Prefer a memorable phrase or central image from the song.
Do not use section labels, artist names, quotes, colons, numbering, or generic
words such as Untitled and Original Track. Use normal song-title
capitalization. Do not explain the answer.

Imported noisy title: {imported_title}
Imported first line: {imported_summary}
Evidence source: {evidence_kind}

Song evidence:
{evidence[:7000]}
"""
    request = urllib.request.Request(
        endpoint.rstrip("/") + "/api/generate",
        data=json.dumps(
            {
                "model": model,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.15, "num_predict": 80},
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.load(response)
    parsed = json.loads(result["response"])
    subject = clean_label(parsed.get("subject"))
    if not valid_subject(subject):
        raise ValueError(f"model returned invalid subject {subject!r}")
    return subject


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def main() -> int:
    args = arguments()
    archive = args.archive.resolve()
    index = json.loads((archive / "index.json").read_text(encoding="utf-8"))
    curated = json.loads(args.curated.read_text(encoding="utf-8")).get("tracks", {})
    selected = set(args.track_id)
    timed_lyrics_root = (
        args.timed_lyrics_root.resolve() if args.timed_lyrics_root else None
    )
    subjects: dict[str, dict[str, str]] = {}
    by_source: dict[str, str] = {}
    evidence_manifest: dict[str, dict[str, str]] = {}
    generated = fallback = 0
    for track in index["tracks"]:
        if selected and track["id"] not in selected:
            continue
        current = curated.get(track["id"], {})
        imported_title = current.get("title") or track.get("title") or ""
        if not weak_label(imported_title):
            continue
        evidence, evidence_kind = title_evidence(
            archive,
            track,
            timed_lyrics_root,
        )
        identity = hashlib.sha256(evidence.encode()).hexdigest()
        evidence_manifest[track["id"]] = {
            "kind": evidence_kind,
            "sha256": identity,
        }
        subject = by_source.get(identity)
        if subject is None:
            try:
                subject = ollama_subject(
                    args.ollama_url,
                    args.model,
                    imported_title,
                    current.get("summary", ""),
                    evidence,
                    evidence_kind,
                )
                generated += 1
            except Exception as error:
                subject = fallback_subject(evidence)
                fallback += 1
                print(
                    json.dumps(
                        {
                            "event": "fallback",
                            "id": track["id"],
                            "subject": subject,
                            "error": str(error),
                        }
                    ),
                    flush=True,
                )
            by_source[identity] = subject
        subjects[track["id"]] = {"title": subject}
        print(
            json.dumps(
                {
                    "event": "subject",
                    "id": track["id"],
                    "subject": subject,
                }
            ),
            flush=True,
        )
    write_atomic(
        args.output.resolve(),
        {
            "version": 1,
            "generator": {
                "name": "zak-radio-local-subject-curator",
                "model": args.model,
                "policy": "missing-or-weak-imported-titles-only",
            },
            "evidence": evidence_manifest,
            "tracks": subjects,
        },
    )
    print(
        json.dumps(
            {
                "event": "complete",
                "tracks": len(subjects),
                "unique_model_subjects": generated,
                "fallbacks": fallback,
                "output": str(args.output.resolve()),
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
