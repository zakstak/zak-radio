# Dependency refresh, November 26, 2026

The refresh starts at GitHub `main` commit
`2c3e6d9f6bac0e143f9b2fee0696ca03fc124557`.

The tracked dependency inputs are `go.mod`, `go.sum`, `package.json`, and
`package-lock.json`. The Pragma wrappers select owner-managed tools through
`PRAGMA_HOME` or `pragma.home`. There are no workspace manifests, Git dependency
refs, container base images, or GitHub Actions workflows. Kiln packaging
generates a `FROM scratch` image around a compiled binary. Signal Stack CSS and
local fonts remain vendored product assets with their existing provenance.

## Updated versions

- Go toolchain: 1.27.3 to 1.27.4. The Go 1.26 language contract remains
  unchanged.
- Tailwind CSS and CLI: 4.3.3 to 4.3.5, with regenerated CSS and npm lockfile.
- SQLite: 1.61.0 to 1.63.0.
- `golang.org/x/sys`: 0.49.0 to 0.50.0.
- `golang.org/x/text`: 0.43.0 to 0.44.0.
- `modernc.org/libc`: 1.79.0 to 1.82.13.
- `modernc.org/memory`: 1.12.1 to 1.13.1.

Other direct dependencies and the `@parcel/watcher` 2.6.0 override already match
latest stable versions. npm updated compatible transitive dependencies and
retained integrity hashes. `go mod tidy` regenerated Go checksums.

## Versions retained below latest

Registry evidence comes from `npm outdated --all --package-lock-only --json`,
`go list -m -u all`, and `go mod why -m`. Candidates are those observed on
November 26, 2026.

| Dependency                      | Retained                             | Latest candidate                     | Reason                                                                                                               |
| ------------------------------- | ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `node-addon-api`                | 7.1.1                                | 8.9.2                                | Latest Parcel watcher requires `^7.0.0`; retain its supported native build API.                                      |
| `@emnapi/wasi-threads`          | 1.2.3                                | 2.2.0                                | Bundled inside latest Tailwind WASI binary package; its core dependency pins 1.2.3.                                  |
| `@napi-rs/wasm-runtime`         | 1.2.2                                | 1.2.7                                | Bundled inside latest Tailwind WASI binary package.                                                                  |
| `@tybys/wasm-util`              | 0.10.3                               | 0.10.5                               | Bundled inside latest Tailwind WASI binary package.                                                                  |
| `tslib`                         | 2.8.1                                | 2.9.1                                | Bundled inside latest Tailwind WASI binary package.                                                                  |
| `github.com/hajimehoshi/oto/v2` | 2.3.1                                | 2.4.3                                | Deprecated graph-only module; `go mod why` reports it is unnecessary. The MP3 decoder does not use its playback API. |
| `github.com/google/pprof`       | `v0.0.0-20261016150608-1facf8f91b50` | `v0.0.0-20261118010117-084b33a85f63` | Used by upstream SQLite tests, not this service's tests or runtime.                                                  |
| `golang.org/x/tools`            | 0.52.0                               | 0.53.0                               | Used by upstream libc tests.                                                                                         |
| `golang.org/x/mod`              | 0.42.0                               | 0.43.0                               | Used by upstream libc tests through ccgo.                                                                            |
| `modernc.org/gc/v3`             | 3.2.0                                | 3.2.1                                | Used by upstream libc tests through ccgo.                                                                            |

`go get -u all` followed by `go mod tidy` retains these upstream test module
selections. Adding unused requirements would not update the service binary. The
bundled WASI dependencies come from the producer's tarball; replacing them
requires a Tailwind producer release. Native Linux CSS generation uses the
platform binary. No unpublished producer refs are required.

## Verification and rollout

Owner verification uses the README commands and current Pragma from its public
main branch, with Go parallelism limited to two. Runtime smoke uses the
checked-in synthetic tone, a temporary catalog, Reader directory, and SQLite
database on loopback. Gateway smoke uses mock SSO and app servers with scratch
nginx. Private command logs and the transfer receipt stay outside Git.

Repository Actions are disabled. The main ruleset requires a pull request and
names no required status checks. No workflow on main merges or tags can deploy
this repository. Deployment is an explicit Pyre/Kiln operation, routed through
the coordinator. A routed package still needs the owner's exact routing
settings, qualified lyrics bundle, rollback package, and deployment transaction.
