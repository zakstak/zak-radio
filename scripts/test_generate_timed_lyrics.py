#!/usr/bin/env python3
"""Unit tests for the deterministic portion of lyric timing generation."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("generate-timed-lyrics.py")
SPEC = importlib.util.spec_from_file_location("zak_radio_lyric_aligner", SCRIPT)
assert SPEC and SPEC.loader
ALIGNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ALIGNER
SPEC.loader.exec_module(ALIGNER)


def observed_word(text: str, start: float, end: float, probability: float = 0.9):
    return SimpleNamespace(
        word=text,
        start=start,
        end=end,
        probability=probability,
    )


class GeneratorTests(unittest.TestCase):
    def test_candidate_lines_remove_editorial_and_production_text(self):
        source = """# Title
[Verse]
(room tone, synth pad)
The first sung line
The second sung line

What I fixed:
1. Added a duplicate
The first sung line
"""
        lines = ALIGNER.candidate_lines(source)
        self.assertEqual(
            [(line.section, line.text) for line in lines],
            [
                ("Verse", "The first sung line"),
                ("Verse", "The second sung line"),
            ],
        )

    def test_timed_cues_follow_observed_order_across_repeated_lines(self):
        candidates = ALIGNER.candidate_lines(
            """[Verse]
Open the door
Walk through the light
[Chorus]
Open the door
"""
        )
        result = SimpleNamespace(
            segments=[
                SimpleNamespace(
                    words=[
                        observed_word("Open", 1.0, 1.2),
                        observed_word("the", 1.2, 1.3),
                        observed_word("door", 1.3, 1.6),
                        observed_word("Walk", 2.0, 2.3),
                        observed_word("through", 2.3, 2.6),
                        observed_word("the", 2.6, 2.7),
                        observed_word("light", 2.7, 3.0),
                        observed_word("Open", 4.0, 4.2),
                        observed_word("the", 4.2, 4.3),
                        observed_word("door", 4.3, 4.6),
                    ]
                )
            ]
        )
        cues, quality = ALIGNER.timed_cues(candidates, result, 5.0)
        self.assertEqual([cue["start"] for cue in cues], [1.0, 2.0, 4.0])
        self.assertEqual(
            [cue["text"] for cue in cues],
            [
                "Open the door",
                "Walk through the light",
                "Open the door",
            ],
        )
        self.assertEqual(quality["line_coverage"], 1.0)

    def test_timed_cues_reject_sparse_and_implausibly_spread_matches(self):
        candidates = ALIGNER.candidate_lines(
            """[Verse]
One two three four five
Close words stay together
"""
        )
        result = SimpleNamespace(
            segments=[
                SimpleNamespace(
                    words=[
                        observed_word("One", 1.0, 1.2),
                        observed_word("two", 1.2, 1.4),
                        observed_word("Close", 5.0, 5.2),
                        observed_word("words", 5.2, 5.4),
                        observed_word("stay", 12.0, 12.2),
                        observed_word("together", 12.2, 12.4),
                    ]
                )
            ]
        )
        cues, _ = ALIGNER.timed_cues(candidates, result, 20.0)
        self.assertEqual(cues, [])

    def test_output_path_rejects_archive_escape(self):
        with self.assertRaisesRegex(ValueError, "escapes archive"):
            ALIGNER.output_path(Path("/tmp/output"), "../outside")

    def test_bundle_gate_rejects_sparse_or_low_confidence_alignment(self):
        base = {
            "quality": {"line_coverage": 0.75, "mean_confidence": 0.9},
            "cues": [{}, {}],
        }
        self.assertTrue(ALIGNER.bundle_eligible(base))
        self.assertFalse(
            ALIGNER.bundle_eligible(
                {
                    **base,
                    "quality": {"line_coverage": 0.1, "mean_confidence": 0.9},
                }
            )
        )
        self.assertFalse(
            ALIGNER.bundle_eligible(
                {
                    **base,
                    "quality": {"line_coverage": 0.75, "mean_confidence": 0.4},
                }
            )
        )
        self.assertTrue(
            ALIGNER.bundle_eligible(
                {
                    "quality": {"line_coverage": 1, "mean_confidence": 0.9},
                    "cues": [{}],
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
