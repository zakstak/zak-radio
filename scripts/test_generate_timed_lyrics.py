#!/usr/bin/env python3
"""Unit tests for the deterministic portion of lyric timing generation."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("lyrics_harness.py")
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

    def test_cleaner_hides_markdown_sections_prompt_fields_and_directions(self):
        source = """# Imported title
**[Verse 2]**
The first sung line
**[CHORUS / HOOK — repeat, slightly bigger harmonies]**
(drums swell and backing vocals double)
The hook is sung
STYLE: cinematic pop at 120 BPM
"""
        cleaned = ALIGNER.clean_lyrics(source)
        self.assertEqual(
            [line.text for line in cleaned.lines],
            ["The first sung line", "The hook is sung"],
        )
        self.assertEqual(
            cleaned.display_text,
            "The first sung line\n\nThe hook is sung",
        )
        self.assertNotIn("Verse", cleaned.display_text)
        self.assertNotIn("STYLE", cleaned.display_text)

    def test_cleaner_preserves_sung_parenthetical_adlibs(self):
        cleaned = ALIGNER.clean_lyrics(
            """[Chorus]
(Ooh, ooh)
Stay with me
"""
        )
        self.assertEqual(
            [line.text for line in cleaned.lines],
            ["(Ooh, ooh)", "Stay with me"],
        )

    def test_plain_lyric_beginning_with_build_is_not_a_section(self):
        cleaned = ALIGNER.clean_lyrics(
            """[Bridge]
Build the walls with patience
leave the sky above
[Final Chorus]
Sing the final line
[Outro]
pads fade
sax fading
"""
        )
        self.assertEqual(
            [line.text for line in cleaned.lines],
            [
                "Build the walls with patience",
                "leave the sky above",
                "Sing the final line",
            ],
        )
        self.assertEqual(cleaned.lines[-1].section, "Final Chorus")

    def test_cleaner_removes_title_and_short_production_prose(self):
        cleaned = ALIGNER.clean_lyrics(
            """🎵 Title: “Ship the Line”
[Intro – Instrumental Build]
Low drum.
Boot stomp.
Fiddle drone.
Wind noise.
(short pause)
Echo
[INSTRUMENTAL HAUL SECTION]
No lyrics.
Stomp.
Clap.
Crew chanting low:
“HEAVE — HO”
Then layered chant:
“Ship it — haul it”
Rhythmic. Almost tribal.
This is where it vibes harder.
Let it groove for 20–30 seconds.
[Outro – Fade on rhythm]
Stomp…
Clap…
Low hum…
Wind…
"""
        )
        self.assertEqual(
            [line.text for line in cleaned.lines],
            ["Echo", "“HEAVE — HO”", "“Ship it — haul it”"],
        )

    def test_stage_tag_followed_by_sung_words_is_preserved(self):
        cleaned = ALIGNER.clean_lyrics(
            """[Outro]
(Whisper) No side effects…
(Whisper) Keep it pure…
"""
        )
        self.assertEqual(
            [line.text for line in cleaned.lines],
            ["(Whisper) No side effects…", "(Whisper) Keep it pure…"],
        )

    def test_ambiguous_classifier_is_extractive(self):
        source = (
            "[Verse]\n"
            "This unusually long line, containing far more than twenty-two separate "
            "words, remains an exact input line for classification and may never "
            "be rewritten by the local model at all\n"
        )

        def classifier(lines):
            self.assertEqual(len(lines), 1)
            return {lines[0][0]: "metadata"}

        cleaned = ALIGNER.clean_lyrics(source, classifier)
        self.assertEqual(cleaned.lines, ())
        self.assertEqual(cleaned.decisions[-1].reason, "local-text-model")

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

    def test_version_two_warning_text_is_bundle_eligible_without_cues(self):
        self.assertTrue(
            ALIGNER.bundle_eligible(
                {
                    "version": 2,
                    "display_text": "Auto-generated words",
                    "quality": {"status": "warning"},
                    "cues": [],
                }
            )
        )

    def test_generated_transcript_removes_boilerplate_and_duplicate_sentences(self):
        lines = ALIGNER.transcript_lines(
            "Hold on to the light. Hold on to the light. "
            "Thank you so much for tuning in. "
            "We hope you enjoyed this beat."
        )
        self.assertEqual([line.text for line in lines], ["Hold on to the light."])

    def test_generated_transcript_chunks_each_long_sentence(self):
        lines = ALIGNER.transcript_lines(
            "One two three four five six seven eight nine ten eleven twelve thirteen. "
            "Short ending."
        )
        self.assertEqual([len(line.words) for line in lines], [12, 1, 2])

    def test_prompt_metadata_is_recovered_only_with_audio_support(self):
        source = (
            "Deprecation with cause — hollow deprecate ID with reason. "
            "Memory stays searchable, but future me sees why it was deprecated. "
            "The Graveyard, but as a Hollow feature.\n"
        )

        def classifier(lines):
            return {lines[0][0]: "metadata"}

        cleaning = ALIGNER.clean_lyrics(source, classifier)
        observed = [
            ALIGNER.ObservedWord(word, ALIGNER.normalized_word(word), index, index + 0.2, 0.9)
            for index, word in enumerate(
                "memory stays searchable but future me sees why it was deprecated "
                "the graveyard but as a hollow feature".split()
            )
        ]
        recovered, considered = ALIGNER.recover_audio_supported_metadata(
            cleaning,
            "Memory stays searchable but future me sees why it was deprecated. "
            "The graveyard but as a hollow feature. Thanks for listening.",
            observed,
        )
        self.assertGreaterEqual(considered, 3)
        self.assertEqual(
            [line.text for line in recovered],
            [
                "Memory stays searchable, but future me sees why it was deprecated.",
                "The Graveyard, but as a Hollow feature.",
            ],
        )

    def test_audio_candidate_requires_a_real_improvement_over_raw(self):
        raw = ALIGNER.AudioCandidate(
            "raw",
            Path("raw.wav"),
            score=0.8,
            score_details={"token_coverage": 0.8},
        )
        marginal = ALIGNER.AudioCandidate(
            "ffmpeg",
            Path("ffmpeg.wav"),
            score=0.82,
            score_details={"token_coverage": 0.82},
        )
        self.assertIs(ALIGNER.choose_candidate([raw, marginal], 0.05), raw)
        better = ALIGNER.AudioCandidate(
            "demucs",
            Path("vocals.wav"),
            score=0.9,
            score_details={"token_coverage": 0.85},
        )
        self.assertIs(
            ALIGNER.choose_candidate([raw, marginal, better], 0.05),
            better,
        )

    def test_transcription_cache_avoids_repeating_model_work(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / "audio.wav"
            audio.write_bytes(b"not-real-audio")

            class Models:
                profile = ALIGNER.Profile(text_model="")
                stable_version = "test"
                calls = 0

                def stable_transcribe(self, _audio):
                    self.calls += 1
                    return SimpleNamespace(
                        segments=[
                            SimpleNamespace(
                                words=[observed_word("hello", 1.0, 1.2)]
                            )
                        ]
                    )

                def heart_transcribe(self, _audio):
                    return "hello"

            models = Models()
            first = ALIGNER.AudioCandidate("raw", audio)
            ALIGNER._evaluate_audio_candidates(
                [first], models, [], True, root / "cache"
            )
            second = ALIGNER.AudioCandidate("raw", audio)
            ALIGNER._evaluate_audio_candidates(
                [second], models, [], True, root / "cache"
            )
            self.assertEqual(models.calls, 1)
            self.assertTrue(second.cache_hit)
            self.assertEqual(second.transcript, "hello")

    def test_jamendo_metadata_builds_pinned_gold_songs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata = root / "subsets" / "en" / "metadata.jsonl"
            metadata.parent.mkdir(parents=True)
            metadata.write_text(
                json.dumps(
                    {
                        "file_name": "mp3/Artist_-_Fast_Song.mp3",
                        "text": "Fast words now",
                        "genre": "Hip-Hop",
                        "license_type": "BY",
                        "polyphonic": True,
                        "lyric_overlap": False,
                        "non_lexical": True,
                        "words": [
                            {"start": 1.0, "end": 1.2, "text": "Fast"},
                            {"start": 1.2, "end": 1.4, "text": "words"},
                            {"start": 1.4, "end": 1.6, "text": "now"},
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            songs = ALIGNER.load_jamendo_songs(
                root, {"metadata": "subsets/en/metadata.jsonl", "song_count": 1}
            )
            self.assertEqual(songs[0]["id"], "artist_fast_song")
            self.assertEqual(songs[0]["mix"], "subsets/en/mp3/Artist_-_Fast_Song.mp3")
            self.assertEqual(
                [word["normalized"] for word in songs[0]["reference"]],
                ["fast", "words", "now"],
            )
            self.assertTrue(songs[0]["polyphonic"])

    def test_monotonic_line_mapping_uses_repeated_choruses_in_order(self):
        lines = ALIGNER.candidate_lines(
            """[Verse]
You have my heart
[Chorus]
Under my umbrella
[Verse 2]
The world has dealt its cards
[Chorus]
Under my umbrella
"""
        )
        tokens = (
            "you have my heart under my umbrella the world has dealt its cards "
            "under my umbrella"
        ).split()
        observed = [
            ALIGNER.ObservedWord(word, word, index, index + 0.2, 0.9)
            for index, word in enumerate(tokens)
        ]
        mapping = ALIGNER.monotonic_line_mapping(lines, observed)
        first_umbrella = sum(len(line.words) for line in lines[:1])
        second_umbrella = sum(len(line.words) for line in lines[:3])
        self.assertEqual(mapping[first_umbrella], 4)
        self.assertEqual(mapping[second_umbrella], 13)

    def test_missing_lyrics_transcript_is_split_into_display_lines(self):
        lines = ALIGNER.transcript_lines(
            "One two three four five six seven eight nine ten eleven twelve "
            "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
        )
        self.assertEqual(len(lines), 2)
        self.assertEqual(sum(len(line.words) for line in lines), 20)
        self.assertEqual(ALIGNER.transcript_lines("е"), [])

    def test_gold_metrics_are_exact_for_exact_word_timing(self):
        reference = [
            {"normalized": "hello", "start": 1.0},
            {"normalized": "world", "start": 2.0},
        ]
        prediction = [
            {"text": "Hello", "start": 1.0},
            {"text": "world", "start": 2.0},
        ]
        metrics = ALIGNER.gold_metrics(reference, prediction)
        self.assertEqual(metrics["word_coverage"], 1)
        self.assertEqual(metrics["wer"], 0)
        self.assertEqual(metrics["median_onset_error"], 0)
        self.assertEqual(metrics["within_500ms"], 1)

    def test_profile_digest_changes_when_alignment_tuning_changes(self):
        baseline = ALIGNER.Profile()
        tuned = ALIGNER.Profile(line_initial_offset=baseline.line_initial_offset + 0.1)
        self.assertEqual(ALIGNER.profile_digest(baseline), ALIGNER.profile_digest(baseline))
        self.assertNotEqual(
            ALIGNER.profile_digest(baseline),
            ALIGNER.profile_digest(tuned),
        )

    def test_cli_exposes_song_bulk_and_gold_commands(self):
        parser = ALIGNER.build_parser()
        song = parser.parse_args(
            [
                "song",
                "--archive",
                "/archive",
                "--output-root",
                "/output",
                "--track-id",
                "track",
            ]
        )
        self.assertEqual((song.command, song.track_id), ("song", "track"))
        bulk = parser.parse_args(
            ["bulk", "--archive", "/archive", "--output-root", "/output"]
        )
        self.assertEqual(bulk.command, "bulk")

    def test_gold_manifest_has_fixed_song_level_holdout(self):
        manifest = json.loads(
            (SCRIPT.parent.parent / "testdata/lyrics-gold/manifest.json").read_text()
        )
        songs = manifest["datasets"]["hansen"]["songs"]
        self.assertTrue(any(song["split"] == "development" for song in songs))
        self.assertTrue(any(song["split"] == "held-out" for song in songs))
        self.assertEqual(len({song["id"] for song in songs}), len(songs))


if __name__ == "__main__":
    unittest.main()
