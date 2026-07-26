#!/usr/bin/env python3
"""Unit tests for local missing-title generation inputs."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate-track-subjects.py")
SPEC = importlib.util.spec_from_file_location("zak_radio_track_subjects", SCRIPT)
assert SPEC and SPEC.loader
SUBJECTS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SUBJECTS
SPEC.loader.exec_module(SUBJECTS)


class TrackSubjectTests(unittest.TestCase):
    def test_missing_and_metadata_titles_are_weak(self):
        for title in ("", "2", "[Intro]", "Artist: somebody", "(blink)"):
            with self.subTest(title=title):
                self.assertTrue(SUBJECTS.weak_label(title))
        self.assertFalse(SUBJECTS.weak_label("Set Me to Gravity"))

    def test_audio_derived_timed_lyrics_are_preferred(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "archive"
            directory = archive / "tracks" / "one"
            directory.mkdir(parents=True)
            (directory / "lyrics.md").write_text("Wrong source words\n")
            timed = root / "timed"
            timed.mkdir()
            track = {
                "id": "one",
                "audio_sha256": "a" * 64,
                "organized_dir": "tracks/one",
            }
            (timed / "one.json").write_text(
                json.dumps(
                    {
                        "track_id": "one",
                        "audio_sha256": "a" * 64,
                        "display_text": "Words supported by the audio",
                    }
                )
            )
            evidence, kind = SUBJECTS.title_evidence(archive, track, timed)
            self.assertEqual(evidence, "Words supported by the audio")
            self.assertEqual(kind, "timed-lyrics")

    def test_prompt_is_used_when_no_lyrics_exist(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary)
            directory = archive / "tracks" / "instrumental"
            directory.mkdir(parents=True)
            (directory / "prompt.txt").write_text(
                "Restless midnight train instrumental\n"
            )
            track = {
                "id": "instrumental",
                "audio_sha256": "b" * 64,
                "organized_dir": "tracks/instrumental",
            }
            evidence, kind = SUBJECTS.title_evidence(archive, track, None)
            self.assertEqual(evidence, "Restless midnight train instrumental")
            self.assertEqual(kind, "prompt")

    def test_fallback_title_uses_a_clean_lyric_line(self):
        self.assertEqual(
            SUBJECTS.fallback_subject("[Verse]\nSignals crossing in the dark\n"),
            "Signals crossing in the dark",
        )


if __name__ == "__main__":
    unittest.main()
