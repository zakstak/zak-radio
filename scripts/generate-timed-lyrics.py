#!/usr/bin/env python3
"""Compatibility wrapper for the bulk lyrics harness command.

New automation should call ``scripts/lyrics-harness.py bulk``. The historical
flags remain accepted so existing offline generation jobs do not break.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from lyrics_harness import main as harness_main


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--bundle-root", type=Path)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--track-id", action="append", default=[])
    parser.add_argument("--max-tracks", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--without-denoiser", action="store_true")
    parser.add_argument("--without-vad", action="store_true")
    parser.add_argument("--verbose-model", action="store_true")
    parser.add_argument(
        "--model",
        default="turbo",
        help="deprecated; the pinned profile selects the alignment model",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    forwarded = [
        "bulk",
        "--archive",
        str(args.archive),
        "--output-root",
        str(args.output_root),
        "--max-tracks",
        str(args.max_tracks),
        "--preprocess",
        "raw" if args.without_denoiser else "auto",
    ]
    if args.bundle_root:
        forwarded.extend(["--bundle-root", str(args.bundle_root)])
    if args.model_dir:
        forwarded.extend(["--model-dir", str(args.model_dir)])
    for track_id in args.track_id:
        forwarded.extend(["--track-id", track_id])
    if args.force:
        forwarded.append("--force")
    if args.verbose_model:
        forwarded.append("--verbose-model")
    return harness_main(forwarded)


if __name__ == "__main__":
    raise SystemExit(main())
