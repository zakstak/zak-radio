"""Regression checks for bounded, trustworthy runtime verification."""

import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "verify_runtime", Path(__file__).with_name("verify-runtime.py")
)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def test_repeated_cursor_cannot_loop_forever(monkeypatch):
    monkeypatch.setattr(
        verifier, "fetch_json", lambda *_: (200, {"tracks": [], "next_cursor": "same"})
    )
    with pytest.raises(ValueError, match="cursor did not advance"):
        verifier.fetch_pages("http://localhost", "/api/library", "tracks")


@pytest.mark.parametrize("offset", [True, 0, -1, "1"])
def test_invalid_offsets_are_rejected(monkeypatch, offset):
    monkeypatch.setattr(
        verifier, "fetch_json", lambda *_: (200, {"tracks": [], "next_offset": offset})
    )
    with pytest.raises(ValueError, match="cursor did not advance"):
        verifier.fetch_pages("http://localhost", "/api/library", "tracks")


def test_aggregate_catalog_budget_is_enforced(monkeypatch):
    monkeypatch.setattr(
        verifier, "fetch_json", lambda *_: (200, {"tracks": [None] * 10001})
    )
    with pytest.raises(ValueError, match="exceeds verifier budget"):
        verifier.fetch_pages("http://localhost", "/api/library", "tracks")


def test_cursor_is_encoded_without_injecting_query_parameters(monkeypatch):
    requested = []

    def fetch(_, path):
        requested.append(path)
        return (
            (200, {"tracks": [], "next_cursor": "one&admin=true"})
            if len(requested) == 1
            else (200, {"tracks": ["one"]})
        )

    monkeypatch.setattr(verifier, "fetch_json", fetch)
    assert verifier.fetch_pages("http://localhost", "/api/library?q=one", "tracks") == (
        200,
        ["one"],
    )
    assert requested[-1] == "/api/library?q=one&cursor=one%26admin%3Dtrue"


@pytest.mark.parametrize(
    "value", [None, "bytes 0-99/199", "bytes 0-100/200", "bytes 0-99/200\n"]
)
def test_media_range_must_match_exact_catalog_size(value):
    assert not verifier.valid_content_range(value, 200)
    assert verifier.valid_content_range("bytes 0-99/200", 200)
