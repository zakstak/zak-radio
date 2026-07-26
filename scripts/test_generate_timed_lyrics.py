#!/usr/bin/env python3
"""Unit tests for the deterministic portion of lyric timing generation."""

from __future__ import annotations

import contextlib
import importlib.util
import io
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

    def test_adversarial_cleaning_cases_are_audio_evidence_dependent(self):
        fixtures = json.loads(
            (
                SCRIPT.parent.parent / "testdata/lyrics-regression/adversarial.json"
            ).read_text(encoding="utf-8")
        )
        for case in fixtures["cases"]:
            with self.subTest(case=case["name"]):
                observed = [
                    ALIGNER.ObservedWord(
                        text,
                        ALIGNER.normalized_word(text),
                        index,
                        index + 0.2,
                        confidence,
                    )
                    for index, (text, confidence) in enumerate(case["observed"])
                ]
                if case["kind"] == "generated":
                    actual = [
                        line.text
                        for line in ALIGNER.transcript_lines(case["text"], observed)
                    ]
                else:
                    cleaning = ALIGNER.clean_lyrics(case["text"])
                    recovered, _ = ALIGNER.recover_audio_supported_metadata(
                        cleaning, "", observed
                    )
                    actual = [line.text for line in recovered]
                self.assertEqual(actual, case["expected_lines"])

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
            ALIGNER.ObservedWord(
                word, ALIGNER.normalized_word(word), index, index + 0.2, 0.9
            )
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

    def test_transcript_scoring_handles_no_timed_observed_words(self):
        score, details = ALIGNER.score_candidate([], ["possibly", "sung"], [])
        self.assertEqual(score, 0)
        self.assertEqual(details["token_coverage"], 0)

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
                            SimpleNamespace(words=[observed_word("hello", 1.0, 1.2)])
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

    def test_missing_vocals_require_two_independent_text_signals(self):
        lines = ALIGNER.candidate_lines("Hold the line\n")
        observed = [
            ALIGNER.ObservedWord("Hold", "hold", 1.0, 1.2, 0.9),
            ALIGNER.ObservedWord("the", "the", 1.2, 1.3, 0.9),
            ALIGNER.ObservedWord("line", "line", 1.3, 1.6, 0.9),
            ALIGNER.ObservedWord("I", "i", 2.0, 2.1, 0.9),
            ALIGNER.ObservedWord("will", "will", 2.1, 2.3, 0.9),
            ALIGNER.ObservedWord("answer", "answer", 2.3, 2.6, 0.9),
        ]
        existing = [
            {
                "start": 1.0,
                "end": 1.6,
                "text": "Hold the line",
                "words": [],
            }
        ]
        cues, counts = ALIGNER.missing_vocal_cues(
            lines,
            existing,
            observed,
            "Hold the line. I will answer.",
            ALIGNER.Profile(),
        )
        self.assertEqual(counts["primary"], 1)
        self.assertEqual(cues[-1]["text"], "I will answer")
        rejected, rejected_counts = ALIGNER.missing_vocal_cues(
            lines,
            existing,
            observed,
            "Hold the line. 完全不同的幻觉。",
            ALIGNER.Profile(),
        )
        self.assertEqual(rejected_counts["primary"], 0)
        self.assertEqual(len(rejected), 1)

    def test_overlapping_second_singer_is_kept_as_secondary_text(self):
        lines = ALIGNER.candidate_lines("Hold the line\n")
        observed = [
            ALIGNER.ObservedWord("Hold", "hold", 1.0, 1.2, 0.9),
            ALIGNER.ObservedWord("the", "the", 1.2, 1.3, 0.9),
            ALIGNER.ObservedWord("line", "line", 1.3, 1.6, 0.9),
            ALIGNER.ObservedWord("I", "i", 1.1, 1.2, 0.9),
            ALIGNER.ObservedWord("hear", "hear", 1.2, 1.4, 0.9),
            ALIGNER.ObservedWord("you", "you", 1.4, 1.6, 0.9),
        ]
        cues, counts = ALIGNER.missing_vocal_cues(
            lines,
            [
                {
                    "start": 1.0,
                    "end": 1.7,
                    "text": "Hold the line",
                    "words": [],
                }
            ],
            observed,
            "Hold the line. I hear you.",
            ALIGNER.Profile(),
        )
        self.assertEqual(counts["secondary"], 1)
        self.assertEqual(cues[0]["secondary_text"], "I hear you")
        self.assertEqual(cues[0]["secondary_origin"], "transcribed-missing")

    def test_backing_vocal_words_need_three_corroborated_matches(self):
        lines = []
        observed = [
            ALIGNER.ObservedWord(
                word, word.casefold(), 2 + index * 0.2, 2.15 + index * 0.2, 0.9
            )
            for index, word in enumerate(("Follow", "the", "silver", "road", "tonight"))
        ]
        cues, counts = ALIGNER.missing_vocal_cues(
            lines,
            [],
            observed,
            "Follow another silver road tonight",
            ALIGNER.Profile(),
            phrase_coverage=ALIGNER.BACKING_PHRASE_COVERAGE,
            minimum_matched_words=ALIGNER.BACKING_MINIMUM_MATCHED_WORDS,
            evidence_origin="backing",
            exclude_mapped_source=False,
        )
        self.assertEqual(counts["primary"], 1)
        self.assertEqual(cues[0]["vocal_evidence"], "backing")
        rejected, rejected_counts = ALIGNER.missing_vocal_cues(
            lines,
            [],
            observed,
            "Follow a completely different song",
            ALIGNER.Profile(),
            phrase_coverage=ALIGNER.BACKING_PHRASE_COVERAGE,
            minimum_matched_words=ALIGNER.BACKING_MINIMUM_MATCHED_WORDS,
            evidence_origin="backing",
            exclude_mapped_source=False,
        )
        self.assertEqual(rejected_counts["primary"], 0)
        self.assertEqual(rejected, [])

    def test_local_timing_repair_requires_representation_consensus(self):
        lines = ALIGNER.candidate_lines("Hold the line\n")

        def candidate(name, start):
            return ALIGNER.AudioCandidate(
                name,
                Path(name),
                observed=[
                    ALIGNER.ObservedWord("Hold", "hold", start, start + 0.1, 0.9),
                    ALIGNER.ObservedWord("the", "the", start + 0.1, start + 0.2, 0.9),
                    ALIGNER.ObservedWord("line", "line", start + 0.2, start + 0.3, 0.9),
                ],
            )

        cues, counts = ALIGNER.repair_timings_from_consensus(
            lines,
            [
                {
                    "start": 2.05,
                    "end": 2.35,
                    "text": "Hold the line",
                    "words": [
                        {"start": 2.05, "end": 2.15, "text": "Hold", "confidence": 0.4},
                        {"start": 2.15, "end": 2.25, "text": "the", "confidence": 0.4},
                        {"start": 2.25, "end": 2.35, "text": "line", "confidence": 0.4},
                    ],
                }
            ],
            [candidate("raw", 1.0), candidate("ffmpeg", 1.1), candidate("demucs", 4.0)],
            ALIGNER.Profile(),
        )
        self.assertEqual(counts["repaired_lines"], 1)
        self.assertAlmostEqual(cues[0]["start"], 1.55)
        self.assertTrue(cues[0]["timing_repaired"])

    def test_each_cue_gets_calibrated_uncertainty(self):
        cues = [
            {
                "text": "Hold the line",
                "words": [
                    {"confidence": 0.9},
                    {"confidence": 0.9},
                    {"confidence": 0.9},
                ],
            },
            {
                "text": "Words are missing here",
                "words": [{"confidence": 0.5}],
            },
        ]
        counts = ALIGNER.annotate_cue_quality(cues, ALIGNER.Profile())
        self.assertEqual(counts, {"verified": 1, "warning": 1})
        self.assertEqual(cues[0]["quality_status"], "verified")
        self.assertEqual(cues[1]["quality_status"], "warning")

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

    def test_gold_confidence_calibration_uses_fixed_bands(self):
        reference = [
            {"normalized": "hello", "start": 1.0},
            {"normalized": "world", "start": 2.0},
        ]
        prediction = [
            {"text": "Hello", "start": 1.1, "confidence": 0.6},
            {"text": "world", "start": 2.8, "confidence": 0.9},
        ]
        calibration = ALIGNER.confidence_calibration(reference, prediction)
        self.assertEqual(calibration[1]["matched_words"], 1)
        self.assertEqual(calibration[1]["within_500ms"], 1)
        self.assertEqual(calibration[3]["matched_words"], 1)
        self.assertEqual(calibration[3]["within_500ms"], 0)

    def test_profile_digest_changes_when_alignment_tuning_changes(self):
        baseline = ALIGNER.Profile()
        tuned = ALIGNER.Profile(line_initial_offset=baseline.line_initial_offset + 0.1)
        self.assertEqual(
            ALIGNER.profile_digest(baseline), ALIGNER.profile_digest(baseline)
        )
        self.assertNotEqual(
            ALIGNER.profile_digest(baseline),
            ALIGNER.profile_digest(tuned),
        )

    def test_regression_compare_promotes_only_an_evidence_safe_improvement(self):
        def payload(display_text, words, **quality):
            return {
                "track_id": "track",
                "audio_sha256": "audio",
                "source_lyrics_sha256": "lyrics",
                "display_text": display_text,
                "quality": {
                    "status": "warning",
                    "line_coverage": quality.get("line_coverage", 1),
                    "word_coverage": quality.get("word_coverage", 1),
                    "mean_confidence": quality.get("mean_confidence", 0.9),
                },
                "cues": [
                    {
                        "start": words[0][1],
                        "end": words[-1][1] + 0.2,
                        "text": quality.get("cue_text", "Sing this line"),
                        "words": [
                            {
                                "text": text,
                                "start": start,
                                "end": start + 0.2,
                                "confidence": confidence,
                            }
                            for text, start, confidence in words
                        ],
                    }
                ],
            }

        evidence = {"sha256": "same"}
        baseline = payload(
            "[Verse 2]\nSing this line",
            [("Sing", 1.0, 0.9), ("this", 1.2, 0.9), ("line", 1.4, 0.9)],
        )
        candidate = payload(
            "Sing this line",
            [("Sing", 1.0, 0.9), ("this", 1.2, 0.9), ("line", 1.4, 0.9)],
        )
        comparison = ALIGNER.compare_sidecars(baseline, candidate, evidence, evidence)
        self.assertEqual(comparison["decision"], "promote")
        self.assertEqual(comparison["selected"], "candidate")
        self.assertIn(
            "removed 1 unsupported metadata-like display lines",
            comparison["improvements"],
        )

        sung_phrase = payload(
            "Thanks for listening",
            [
                ("Thanks", 1.0, 0.9),
                ("for", 1.2, 0.9),
                ("listening", 1.4, 0.9),
            ],
            cue_text="Thanks for listening",
        )
        comparison = ALIGNER.compare_sidecars(
            sung_phrase, sung_phrase, evidence, evidence
        )
        self.assertEqual(comparison["decision"], "retain-baseline")
        self.assertEqual(comparison["unsupported_metadata_before"], [])

    def test_regression_compare_abstains_on_word_timing_or_evidence_loss(self):
        def payload(words, coverage=1):
            return {
                "track_id": "track",
                "audio_sha256": "audio",
                "display_text": "Hold the line",
                "quality": {
                    "status": "warning",
                    "line_coverage": coverage,
                    "word_coverage": coverage,
                    "mean_confidence": 0.9,
                },
                "cues": [
                    {
                        "start": words[0][1],
                        "end": words[-1][1] + 0.2,
                        "text": "Hold the line",
                        "words": [
                            {
                                "text": text,
                                "start": start,
                                "end": start + 0.2,
                                "confidence": 0.9,
                            }
                            for text, start in words
                        ],
                    }
                ],
            }

        evidence = {"sha256": "same"}
        baseline = payload([("Hold", 1.0), ("the", 1.2), ("line", 1.4)])
        missing = payload([("Hold", 1.0), ("line", 1.4)], coverage=0.67)
        comparison = ALIGNER.compare_sidecars(baseline, missing, evidence, evidence)
        self.assertEqual(comparison["decision"], "abstain")
        self.assertTrue(
            any(
                "high-confidence baseline words" in item
                for item in comparison["regressions"]
            )
        )

        shifted = payload([("Hold", 2.0), ("the", 2.2), ("line", 2.4)])
        comparison = ALIGNER.compare_sidecars(baseline, shifted, evidence, evidence)
        self.assertEqual(comparison["decision"], "abstain")
        self.assertTrue(
            any("word onsets moved" in item for item in comparison["regressions"])
        )

        lower_confidence = payload([("Hold", 1.0), ("the", 1.2), ("line", 1.4)])
        lower_confidence["cues"][0]["words"][1]["confidence"] = 0.7
        comparison = ALIGNER.compare_sidecars(
            baseline, lower_confidence, evidence, evidence
        )
        self.assertEqual(comparison["decision"], "abstain")
        self.assertTrue(
            any(
                "high-confidence baseline words" in item
                for item in comparison["regressions"]
            )
        )

        comparison = ALIGNER.compare_sidecars(
            baseline, baseline, evidence, {"sha256": "different"}
        )
        self.assertEqual(comparison["decision"], "abstain")
        self.assertIn(
            "baseline and candidate did not use identical frozen evidence",
            comparison["regressions"],
        )

    def test_compare_command_retains_baseline_in_bundle_when_it_abstains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "archive"
            organized = archive / "tracks/Test/01"
            organized.mkdir(parents=True)
            audio = organized / "audio.mp3"
            audio.write_bytes(b"audio")
            audio_sha256 = ALIGNER.sha256_file(audio)
            track = {
                "id": "track",
                "organized_dir": "tracks/Test/01",
                "audio_sha256": audio_sha256,
            }
            (archive / "index.json").write_text(
                json.dumps({"tracks": [track]}),
                encoding="utf-8",
            )
            evidence = {
                "version": 1,
                "audio_sha256": audio_sha256,
                "source_lyrics_sha256": "",
                "selected_preprocessing": "raw",
                "selected_audio_sha256": audio_sha256,
                "model_output_sha256": "model",
            }
            evidence["sha256"] = ALIGNER.canonical_json_sha256(evidence)

            def payload(words):
                return {
                    "version": 2,
                    "track_id": "track",
                    "audio_sha256": audio_sha256,
                    "display_text": "Hold the line",
                    "evidence": evidence,
                    "generator": {"preprocessing": "raw"},
                    "quality": {
                        "status": "warning",
                        "line_coverage": 1,
                        "word_coverage": len(words) / 3,
                        "mean_confidence": 0.9,
                    },
                    "cues": [
                        {
                            "start": 1,
                            "end": 2,
                            "text": "Hold the line",
                            "words": [
                                {
                                    "text": word,
                                    "start": 1 + index * 0.2,
                                    "end": 1.1 + index * 0.2,
                                    "confidence": 0.9,
                                }
                                for index, word in enumerate(words)
                            ],
                        }
                    ],
                }

            baseline_root = root / "baseline"
            candidate_root = root / "candidate"
            baseline_path = ALIGNER.output_path(baseline_root, track["organized_dir"])
            candidate_path = ALIGNER.output_path(candidate_root, track["organized_dir"])
            baseline_path.parent.mkdir(parents=True)
            candidate_path.parent.mkdir(parents=True)
            baseline_path.write_text(
                json.dumps(payload(["Hold", "the", "line"])),
                encoding="utf-8",
            )
            candidate_path.write_text(
                json.dumps(payload(["Hold", "line"])),
                encoding="utf-8",
            )
            bundle = root / "bundle"
            report = root / "report.json"
            with contextlib.redirect_stdout(io.StringIO()):
                status = ALIGNER.run_compare(
                    SimpleNamespace(
                        archive=archive,
                        baseline_root=baseline_root,
                        candidate_root=candidate_root,
                        cache_root=root / "cache",
                        profile=ALIGNER.DEFAULT_PROFILE,
                        track_id=[],
                        max_tracks=0,
                        maximum_onset_shift=0.5,
                        high_confidence=0.75,
                        bundle_root=bundle,
                        report=report,
                    )
                )
            self.assertEqual(status, 2)
            self.assertEqual(
                json.loads((bundle / "track.json").read_text())["cues"][0]["words"][1][
                    "text"
                ],
                "the",
            )
            self.assertEqual(
                json.loads(report.read_text())["counts"]["abstain"],
                1,
            )

    def test_regression_compare_promotes_safe_alternate_vocal_detection(self):
        baseline = {
            "display_text": "Hold the line",
            "quality": {
                "status": "verified",
                "line_coverage": 1,
                "word_coverage": 1,
                "mean_confidence": 0.9,
            },
            "cues": [
                {
                    "start": 1.0,
                    "end": 1.5,
                    "text": "Hold the line",
                    "words": [
                        {
                            "text": "Hold",
                            "start": 1.0,
                            "end": 1.2,
                            "confidence": 0.9,
                        }
                    ],
                }
            ],
        }
        candidate = json.loads(json.dumps(baseline))
        candidate["quality"]["alternate_vocals_detected"] = True
        candidate["quality"]["alternate_vocals_unresolved"] = True
        evidence = {"sha256": "same"}
        result = ALIGNER.compare_sidecars(
            baseline,
            candidate,
            evidence,
            evidence,
        )
        self.assertEqual(result["decision"], "promote")
        self.assertIn(
            "surfaced independently detected alternate vocals",
            result["improvements"],
        )

    def test_cli_exposes_song_bulk_compare_and_gold_commands(self):
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
        compare = parser.parse_args(
            [
                "compare",
                "--archive",
                "/archive",
                "--baseline-root",
                "/baseline",
                "--candidate-root",
                "/candidate",
                "--report",
                "/report.json",
            ]
        )
        self.assertEqual(compare.command, "compare")
        gold = parser.parse_args(
            [
                "gold",
                "run",
                "--output-root",
                "/output",
                "--report",
                "/report.json",
                "--strategy",
                "v5",
            ]
        )
        self.assertEqual(gold.strategy, "v5")

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
