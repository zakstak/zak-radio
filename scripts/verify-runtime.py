#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import signal
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)
# The admitted catalog may contain 8 MiB of aggregate search text plus bounded
# metadata and JSON escaping. Keep a finite ceiling above the server contract.
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024


def open_request(request, timeout=15):
    return OPENER.open(request, timeout=timeout)


def fetch_json(base: str, path: str):
    with open_request(base.rstrip('/') + path) as response:
        body = response.read(MAX_JSON_BYTES + 1)
        if len(body) > MAX_JSON_BYTES:
            raise ValueError(f'JSON response exceeds {MAX_JSON_BYTES} bytes')
        return response.status, json.loads(body.decode('utf-8'))


def fetch_pages(base: str, path: str, key: str):
    values = []
    offset = 0
    cursor = None
    seen_cursors = set()
    pages = 0
    while True:
        separator = '&' if '?' in path else '?'
        pagination = (f'cursor={urllib.parse.quote(cursor, safe="")}'
                      if cursor is not None else f'offset={offset}')
        status, payload = fetch_json(base, f'{path}{separator}{pagination}')
        if status != 200:
            return status, values
        page_values = payload.get(key) or []
        if not isinstance(page_values, list):
            raise ValueError(f'{key} page is not a list')
        values.extend(page_values)
        pages += 1
        if pages > 1000 or len(values) > 10000:
            raise ValueError(f'{key} pagination exceeds verifier budget')
        next_cursor = payload.get('next_cursor')
        if next_cursor is not None:
            if (not isinstance(next_cursor, str) or not next_cursor or
                    next_cursor in seen_cursors):
                raise ValueError(
                    f'{key} pagination cursor did not advance: {next_cursor!r}')
            seen_cursors.add(next_cursor)
            cursor = next_cursor
            continue
        next_offset = payload.get('next_offset')
        if next_offset is None:
            return status, values
        if isinstance(next_offset, bool) or not isinstance(next_offset, int) or next_offset <= offset:
            raise ValueError(f'{key} pagination cursor did not advance: {next_offset!r}')
        offset = next_offset


def check_range(url: str) -> tuple[int, str | None, int]:
    req = urllib.request.Request(url, headers={'Range': 'bytes=0-99'})
    try:
        with open_request(req) as response:
            return response.status, response.headers.get('Content-Range'), len(response.read(1024))
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get('Content-Range'), len(err.read(MAX_ERROR_BYTES + 1))


def check_head(url: str) -> tuple[int, int, str | None]:
    req = urllib.request.Request(url, method='HEAD')
    try:
        with open_request(req) as response:
            return response.status, int(response.headers.get('Content-Length') or 0), response.headers.get('Accept-Ranges')
    except urllib.error.HTTPError as err:
        return err.code, 0, err.headers.get('Accept-Ranges')


def check_origin_policy(base: str) -> tuple[int, str]:
    parsed = urllib.parse.urlsplit(base)
    origin = urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, '', '', ''))
    request = urllib.request.Request(
        base.rstrip('/') + '/api/control',
        data=b'{}',
        headers={
            'Content-Type': 'application/json',
            'Origin': origin,
        },
        method='POST',
    )
    try:
        with open_request(request) as response:
            return response.status, response.read(
                MAX_ERROR_BYTES + 1).decode('utf-8', 'replace')
    except urllib.error.HTTPError as err:
        try:
            return err.code, err.read(
                MAX_ERROR_BYTES + 1).decode('utf-8', 'replace')
        finally:
            err.close()


def check_digest(url: str, expected_size: int) -> tuple[int, int, str]:
    if expected_size <= 0:
        raise ValueError('expected media size must be positive')
    digest = hashlib.sha256()
    size = 0
    with open_request(url, timeout=60) as response:
        while chunk := response.read(min(1024 * 1024, expected_size - size + 1)):
            digest.update(chunk)
            size += len(chunk)
            if size > expected_size:
                raise ValueError(
                    f'media response exceeds declared size {expected_size}')
        return response.status, size, digest.hexdigest()


def valid_content_range(value: str | None, expected_size: int) -> bool:
    match = re.fullmatch(r'bytes 0-99/([0-9]+)', value or '')
    return bool(match and int(match.group(1)) == expected_size)


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify Zak Radio + Reader runtime endpoints')
    parser.add_argument('--base', default='http://127.0.0.1:8793')
    parser.add_argument('--expected-tracks', type=int, required=True)
    parser.add_argument('--expected-reader-items', type=int, required=True)
    parser.add_argument('--expected-release', required=True)
    parser.add_argument('--deadline-seconds', type=int, default=300)
    args = parser.parse_args()
    if (args.expected_tracks <= 0 or args.expected_reader_items < 0 or
            args.deadline_seconds < 1 or args.deadline_seconds > 3600):
        parser.error('expected tracks must be positive and expected Reader items non-negative')
    def deadline_expired(_signum, _frame):
        raise TimeoutError(
            f'runtime verification exceeded {args.deadline_seconds} seconds')

    signal.signal(signal.SIGALRM, deadline_expired)
    signal.setitimer(signal.ITIMER_REAL, args.deadline_seconds)
    base = args.base.rstrip('/')

    status, health = fetch_json(base, '/health')
    checks = health.get('checks') or {}
    if status != 200 or not health.get('ok') or not checks or not all(checks.values()):
        print(f'health failed: status={status} payload={health}', file=sys.stderr)
        return 1
    if health.get('release') != args.expected_release:
        print(
            f'release mismatch: actual={health.get("release")} '
            f'expected={args.expected_release}',
            file=sys.stderr,
        )
        return 1
    origin_status, origin_body = check_origin_policy(base)
    if origin_status != 400:
        print(
            f'public origin policy failed: status={origin_status} '
            f'body={origin_body[:256]!r}',
            file=sys.stderr,
        )
        return 1

    status, tracks_payload = fetch_json(base, '/api/tracks')
    tracks = tracks_payload.get('tracks') or []
    if status != 200 or not tracks or len(tracks) != args.expected_tracks:
        print(f'tracks failed: status={status} count={len(tracks)}', file=sys.stderr)
        return 1

    status, station = fetch_json(base, '/api/station')
    if status != 200 or 'track_id' not in station:
        print(f'station failed: status={status} payload={station}', file=sys.stderr)
        return 1

    status, items = fetch_pages(base, '/api/reader/items', 'items')
    if status != 200 or len(items) != args.expected_reader_items:
        print(f'reader items failed: status={status} count={len(items)}', file=sys.stderr)
        return 1

    track_urls = []
    for track in tracks:
        track_id = urllib.parse.quote(str(track['id']), safe='')
        url = f'{base}/media/{track_id}/audio'
        head_status, content_length, accept_ranges = check_head(url)
        expected_bytes = int(track.get('audio_bytes') or 0)
        if head_status != 200 or expected_bytes <= 0 or content_length != expected_bytes or accept_ranges != 'bytes':
            print(
                f'track media failed: id={track_id} status={head_status} '
                f'content_length={content_length} expected={expected_bytes} ranges={accept_ranges}',
                file=sys.stderr,
            )
            return 1
        expected_digest = str(track.get('audio_sha256') or '')
        media_status, actual_bytes, actual_digest = check_digest(url, expected_bytes)
        if media_status != 200 or actual_bytes != expected_bytes or actual_digest != expected_digest:
            print(
                f'track digest failed: id={track_id} status={media_status} '
                f'bytes={actual_bytes}/{expected_bytes} sha256={actual_digest}/{expected_digest}',
                file=sys.stderr,
            )
            return 1
        track_urls.append((url, expected_bytes))

    reader_urls = []
    reader_sources_checked = 0
    for item in items:
        item_id = urllib.parse.quote(str(item['id']), safe='')
        source_status, _, _ = check_head(f'{base}/reader-source/{item_id}/source')
        if source_status != 200:
            print(f'reader source failed: item={item_id} status={source_status}', file=sys.stderr)
            return 1
        reader_sources_checked += 1
        status, segments = fetch_pages(
            base, f'/api/reader/items/{item_id}/segments', 'segments')
        if status != 200:
            print(f'reader segments failed: item={item_id} status={status}', file=sys.stderr)
            return 1
        ready = [segment for segment in segments if segment.get('status') == 'ready']
        indices = [int(segment['segment_index']) for segment in segments]
        if indices != list(range(len(indices))):
            print(f'reader segment indices are not contiguous: item={item_id} indices={indices}', file=sys.stderr)
            return 1
        if len(segments) != int(item.get('segment_count') or 0):
            print(
                f'reader segment count mismatch: item={item_id} '
                f'api={len(segments)} declared={item.get("segment_count")}',
                file=sys.stderr,
            )
            return 1
        item_audio_bytes = 0
        for segment in ready:
            index = int(segment['segment_index'])
            url = f'{base}/reader-media/{item_id}/{index}.mp3'
            head_status, content_length, accept_ranges = check_head(url)
            if head_status != 200 or content_length <= 0 or accept_ranges != 'bytes':
                print(
                    f'reader media failed: item={item_id} segment={index} '
                    f'status={head_status} content_length={content_length} ranges={accept_ranges}',
                    file=sys.stderr,
                )
                return 1
            expected_bytes = int(segment.get('audio_bytes') or 0)
            expected_digest = str(segment.get('audio_sha256') or '')
            media_status, actual_bytes, actual_digest = check_digest(url, expected_bytes)
            if (media_status != 200 or actual_bytes != expected_bytes or
                    not expected_digest or actual_digest != expected_digest):
                print(
                    f'reader digest failed: item={item_id} segment={index} '
                    f'status={media_status} bytes={actual_bytes}/{expected_bytes} '
                    f'sha256={actual_digest}/{expected_digest}',
                    file=sys.stderr,
                )
                return 1
            item_audio_bytes += content_length
            reader_urls.append((url, expected_bytes))
        if item_audio_bytes != int(item.get('audio_bytes') or 0):
            print(
                f'reader audio byte mismatch: item={item_id} '
                f'actual={item_audio_bytes} declared={item.get("audio_bytes")}',
                file=sys.stderr,
            )
            return 1

    if items and not reader_urls:
        print('reader verification found no ready audio segments', file=sys.stderr)
        return 1

    range_urls = []
    if track_urls:
        range_urls.extend([track_urls[0], track_urls[-1]])
    if reader_urls:
        range_urls.extend([reader_urls[0], reader_urls[-1]])
    checked_ranges = []
    for url, expected_size in dict(range_urls).items():
        media_status, media_range, media_len = check_range(url)
        if ((media_status, media_len) != (206, 100) or
                not valid_content_range(media_range, expected_size)):
            print(
                f'media range failed: url={url} status={media_status} '
                f'range={media_range} len={media_len}',
                file=sys.stderr,
            )
            return 1
        checked_ranges.append(media_range)

    print(json.dumps({
        'ok': True,
        'base': base,
        'release': health.get('release'),
        'tracks': len(tracks),
        'reader_items': len(items),
        'reader_sources_checked': reader_sources_checked,
        'track_media_checked': len(track_urls),
        'reader_media_checked': len(reader_urls),
        'ranges': checked_ranges,
        'checks': checks,
    }, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
