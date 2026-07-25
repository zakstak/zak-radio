#!/usr/bin/env python3
import importlib.util
import pathlib
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer


MODULE_PATH = pathlib.Path(__file__).with_name("verify-runtime.py")
SPEC = importlib.util.spec_from_file_location("verify_runtime", MODULE_PATH)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class RedirectHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302)
        self.send_header("Location", "http://127.0.0.1:1/healthy")
        self.end_headers()

    def log_message(self, format, *args):
        pass


class VerifierSafetyTests(unittest.TestCase):
    def test_redirects_are_not_followed(self):
        server = HTTPServer(("127.0.0.1", 0), RedirectHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                VERIFY.open_request(f"http://127.0.0.1:{server.server_port}/health")
            self.assertEqual(raised.exception.code, 302)
            raised.exception.close()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_content_range_requires_requested_offsets_and_total(self):
        self.assertTrue(VERIFY.valid_content_range("bytes 0-99/200", 200))
        for value in (
            None,
            "",
            "bytes 100-199/200",
            "bytes 0-98/200",
            "bytes 0-99/201",
            "garbage",
        ):
            self.assertFalse(VERIFY.valid_content_range(value, 200))

    def test_pagination_requires_strict_progress(self):
        original = VERIFY.fetch_json
        try:
            for name, pages in {
                "repeated": [
                    {"items": [], "next_offset": 0},
                ],
                "decreasing": [
                    {"items": [], "next_offset": 2},
                    {"items": [], "next_offset": 1},
                ],
                "malformed": [
                    {"items": [], "next_offset": "1"},
                ],
                "repeated_cursor": [
                    {"items": [], "next_cursor": "cursor"},
                    {"items": [], "next_cursor": "cursor"},
                ],
            }.items():
                with self.subTest(name=name):
                    replies = iter(pages)
                    VERIFY.fetch_json = lambda _base, _path: (200, next(replies))
                    with self.assertRaises(ValueError):
                        VERIFY.fetch_pages("http://example.test", "/items", "items")
        finally:
            VERIFY.fetch_json = original

    def test_json_response_is_bounded(self):
        class OversizedJSONHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{" + b" " * VERIFY.MAX_JSON_BYTES + b"}")

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), OversizedJSONHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with self.assertRaises(ValueError):
                VERIFY.fetch_json(
                    f"http://127.0.0.1:{server.server_port}", "/oversized"
                )
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_digest_rejects_bytes_beyond_declared_size(self):
        class OverlongMediaHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"12345")

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), OverlongMediaHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with self.assertRaises(ValueError):
                VERIFY.check_digest(f"http://127.0.0.1:{server.server_port}/media", 4)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_origin_probe_is_non_mutating_and_uses_public_origin(self):
        observed = {}

        class OriginHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                observed["path"] = self.path
                observed["origin"] = self.headers.get("Origin")
                observed["body"] = self.rfile.read(
                    int(self.headers.get("Content-Length") or 0)
                )
                self.send_response(
                    400
                    if observed["origin"]
                    == f"http://127.0.0.1:{self.server.server_port}"
                    else 403
                )
                self.end_headers()

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), OriginHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            status, _ = VERIFY.check_origin_policy(base)
            self.assertEqual(status, 400)
            self.assertEqual(
                observed,
                {
                    "path": "/api/control",
                    "origin": base,
                    "body": b"{}",
                },
            )
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
