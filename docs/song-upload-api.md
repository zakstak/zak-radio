# Upload songs through the API

## Create an upload key

1. Sign in to Zak Radio and open **Library > API access**.
2. Name the key for your agent and choose an expiry of 1–90 days. The default is
   30 days.
3. Select **Create upload key** and copy the key before closing the dialog. The
   secret appears only once.
4. Give the agent your instance's `/ai.json` URL. Supply the key through the
   agent's secret store.

Upload keys grant `songs:write`. They cannot manage keys, control stations, or
replace songs. Each user can have five active keys. The service allows 1,000
active keys in total. Revoke a key in **API access** to stop future requests
with it. A request already authorized can finish after revocation or expiry.

The service stores SHA-256 hashes of keys and SSO owner identities. The database
never stores the key itself. Do not put keys in prompts, source files, URLs, or
logs. If a create-key response is lost, list and revoke the unused key before
creating another. The service cannot recover its secret.

## Send a song

Save the following header in a file readable only by your account, such as
`/path/to/private/upload.headers`. Replace the placeholder with your key:

```text
Authorization: Bearer <upload key>
```

Use HTTPS for your deployed instance. Set the file's permissions and check
access:

```bash
chmod 600 /path/to/private/upload.headers
curl --fail-with-body --silent --show-error \
  --header @/path/to/private/upload.headers \
  https://radio.example.com/api/song-upload
```

Continue when the response has `enabled: true` and `can_upload: true`. Upload
the binary file using multipart form data:

```bash
curl --fail-with-body --silent --show-error \
  --header @/path/to/private/upload.headers \
  --form-string 'title=Harbor lights' \
  --form-string 'artist=Zak' \
  --form 'audio=@/path/to/song.mp3;type=audio/mpeg' \
  --form 'lyrics=</path/to/lyrics.txt;type=text/plain' \
  https://radio.example.com/api/tracks
```

Omit the `lyrics` part when there are no lyrics. `lyrics=<...` reads the file as
the field value. Send one song per request. Do not set `Content-Type` yourself;
curl supplies the multipart boundary. The API accepts file bytes, not a source
URL, a server path, or base64 JSON.

Success returns status 201 with a `track` object, including the server-generated
`id`, `duration`, `audio_sha256`, and `audio_bytes`. The song becomes available
immediately in Library and Radio. The `Location` header contains its audio URL.

## Instructions for an agent

Give an agent these instructions together with its secret configuration:

```text
Read /ai.json at the supplied Zak Radio instance for the complete workflow.
Use /api/song-upload/openapi.json when you need the OpenAPI schema.
Authenticate with the upload key from your secret store using Authorization: Bearer.
Check GET /api/song-upload; stop if can_upload is false.
Submit a title, artist, and binary MP3 using POST /api/tracks as multipart/form-data.
Include plain UTF-8 lyrics only when available. Follow all limits in the schema.
Treat 201 as complete. Report the returned track ID.
If a response is lost, retry only the identical audio bytes.
Treat 409 duplicate_audio as already present and report existing_track_id.
For 400 or 413, correct the input before retrying. For 401 or 403, stop and report the access problem.
For 429, respect Retry-After and retry with a bounded retry count.
Never print the key or send it to a different host or redirect target.
```

## Format and request limits

| Field    | Requirements                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`  | Required UTF-8 text, 1–120 characters after trimming, on one line.                                                                                            |
| `artist` | Required UTF-8 text, 1–120 characters after trimming, on one line.                                                                                            |
| `audio`  | Required nonempty `.mp3` file, at most 33,554,432 bytes and 1,200 seconds. Complete, decodable MPEG-1 or MPEG-2 Layer III frames with a constant sample rate. |
| `lyrics` | Optional UTF-8 text, at most 65,536 bytes. Tabs and line breaks are allowed. Other control characters are rejected.                                           |

Only one part of each name is allowed. Unknown fields are rejected. The service
calculates duration, track ID, storage paths, and hashes. ID3v2.3, ID3v2.4, and
ID3v1 tags are supported. Uploading different audio with an existing title does
not replace a song. Duplicate detection uses the exact file's SHA-256 digest.

The service processes one song at a time. Each client address can make 20 upload
attempts per hour. Existing trusted-proxy settings determine that address. Key
creation has a separate limit of 20 attempts per client address per hour.

## Handle errors

Song API errors have this shape:

```json
{ "error": { "code": "invalid_audio", "message": "Audio validation failed." } }
```

Use `error.code` for decisions and `error.message` for explanation.

| HTTP status | Code                               | Action                                                                    |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------- |
| 400         | `invalid_request`, `invalid_audio` | Correct the form or audio.                                                |
| 401         | `unauthorized`                     | Use a valid, unexpired key. Uploads may be disabled.                      |
| 403         | `forbidden`, `insufficient_scope`  | Check ingress, origin, and the requested endpoint.                        |
| 409         | `duplicate_audio`                  | Use the top-level `existing_track_id`; the song is already present.       |
| 409         | `catalog_conflict`                 | Ask the service owner to check catalog capacity.                          |
| 413         | `payload_too_large`                | Reduce the file or lyrics size.                                           |
| 429         | `upload_busy`, `too_many_requests` | Wait for `Retry-After` when supplied.                                     |
| 500         | `storage_unavailable`              | A retry must use identical bytes, because publication may have completed. |
| 507         | `storage_full`                     | Ask the service owner to free storage.                                    |

Admission failures also use status-derived codes such as `misdirected_request`
and `method_not_allowed`. A gateway may return its own response before the app
receives the request. Treat an HTML login page as a gateway configuration issue.

## Configure the gateway

Uploads require the configured SSO identity header and exact trusted-proxy
settings described in
[Configure upload identity](../README.md#configure-upload-identity). Disabling
`ZAK_RADIO_UPLOAD_IDENTITY_HEADER` disables both SSO uploads and API keys.

For bearer clients, route only the following automation endpoints to the app
without an interactive SSO redirect:

- `GET /api/song-upload`
- `GET /ai.json` and `GET /.well-known/ai.json`
- `GET /api/song-upload/openapi.json`
- `POST /api/tracks`

Forward `Authorization` unchanged. Allow multipart requests up to 33 MiB and
enough time for audio validation. Keep `/api/song-upload/keys` and its DELETE
subroutes behind SSO. Strip incoming identity-header values and set that header
only after successful SSO authentication. Bearer-only requests do not need an
SSO identity header. Keep all other routes under their existing access policy.

The app validates bearer keys and enforces upload scope when a request presents
a Zak Radio upload bearer credential. Existing private-service routes do not
gain a new general authentication requirement. Do not expose those routes by
removing gateway authentication globally.

Key management endpoints require SSO and reject bearer credentials:

| Method and path                     | Request or response                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/song-upload/keys`         | Lists the user's active keys, without secrets.                                                          |
| `POST /api/song-upload/keys`        | JSON `{"name":"Agent","expires_in_days":30}`; returns 201 with `key` metadata and the one-time `token`. |
| `DELETE /api/song-upload/keys/{id}` | Revokes the current user's key; returns 404 for missing keys or another user's key.                     |

Key metadata contains `id`, `name`, `scope`, `created_at`, and `expires_at`.
Timestamps are Unix seconds. Names are 1–80 characters on one line. Expired keys
are excluded from listings and deleted when a new key is created.

API keys add SQLite schema 19. Startup backs up an existing schema-18 database
before migration. Previous binaries reject schema 19. Use a matching pre-upgrade
volume snapshot when rolling back both binary and data. Retained backups include
hashed keys, so restoring a snapshot also restores key state.

## Experiment with disposable data

Run the upload tests from the repository root:

```bash
go test -race ./internal/application -run '^TestSongUpload' -count=1
```

These tests create temporary catalogs and databases, start a loopback HTTP
server, and upload a generated tone without audio playback. They do not use your
live volume or gateway. For a manual server, use the separate development data
root in [Run locally](../README.md#run-locally).
