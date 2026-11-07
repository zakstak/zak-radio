# Deploy Zak Radio through Pyre and Kiln

Zak Radio owns its package and retained-data compatibility. Pyre owns the
execution host and scoped client. Kiln owns backup and publication transactions.
Resolve the actual Pyre checkout and revision on the execution host, then read
its `AGENTS.md`, `docs/ownership.md`, `docs/plan.md`, and
`docs/kiln-releases.md`. Saga source is frozen provenance. Existing owner names,
volume keys, and service paths can retain `saga` without making Saga the
deployment owner.

## Prepare the release

1. Build from the selected release revision with
   `scripts/prepare-kiln-package.sh`. Use the live deployment's exact routing
   settings and qualified lyrics bundle, as described in the README.
2. Run `scripts/verify-release-package.sh PACKAGE_DIRECTORY`.
3. Run the installed Pyre client's `kiln.doctor` and `kiln.inventory`. Forge's
   verified entrypoint is `~/.local/bin/pyre-lab`. Discover the installed path
   when executing elsewhere.
4. Read Music's `currentDeployment` through Kiln's authenticated `/api/state`.
   Preserve that deployment's complete package and compare its content digest
   with the recorded `packageDigest`. Preserve file modes as well as bytes. The
   newest local package directory can be older than the live release.
5. Verify application schema compatibility and retain the prior runtime for
   recovery. Keep runtime data and credentials outside Git.

## Publish with the current owner workflow

When the installed Pyre policy qualifies both manifests, use its normal
transaction:

```sh
pyre-lab kiln.release-plan music "$manifest" "$previous_manifest"
pyre-lab kiln.release music "$manifest" "$previous_manifest"
```

The previous manifest must point at the complete, verified live package. The
release command backs up retained data, rechecks the deployment, publishes, and
verifies committed state. A lost response requires state reconciliation before
another attempt.

Forge's profile observed on November 6, 2026 still contains the obsolete volume
quota. It rejects the corrected manifest before publication. The release below
used Kiln's native API with the existing scoped Forge credential instead.
Neither the installed profile nor authentication policy changed. A future Pyre
profile update belongs to Pyre's owner procedure.

For that supported native path, use Kiln's current typed client or operator UI:

1. Freeze a `PublishRequest` containing the qualified package bytes, modes,
   package digests, and supported manifest. Bind its idempotency key to the
   current deployment and candidate. Preserve the request's SHA-256.
2. Plan `/api/product/backup` with `app: "music"` and `mode: "dryRun"`.
3. Apply that exact backup plan with `expectedPlanDigest` and a stable
   idempotency key. Require a successful receipt covering every required volume.
4. Recheck the current deployment, then submit the frozen request once to
   `/api/deployments/publish`.
5. Verify the committed deployment and package digest through `/api/state`.
   Check runtime `/health`, the retained volume identity, and the intended
   access route. Public HTTPS requires the existing SSO session.

Do not install the frozen `saga appv` client to repair a Pyre policy mismatch.
Kiln's producer contracts define request schemas and publication behavior.
Compatible code rollback uses retained current data and a supported manifest. It
does not restore an old database over newer writes.

## November 6, 2026 release checkpoint

Producing host: Forge. Runtime: primary Proxmox VM216, hostname
`saga-apphost-vnext`, UUID `eb4ca454-0b24-4019-92c3-d96f9a484644`. Kiln runs
version 2.1.0.

- Source: `v0.2.0`, commit `54b6611801b40def9b0f8c29849b27fad58c5975`.
- Package release:
  `ef4e076c50d46a626667fefd6f301e67986e036c6e6de91d9ffef458bbfe0295`.
- Kiln package:
  `sha256:20eb8ba13ecf53d3388448a95527097220fcc89b524760677dd1f8a2d1ee0ab4`.
- Previous deployment:
  `dep_ae74a9b51f4a1425b0250cdf7107639679f667f65c79e3b3d293e28d6a8d1ec7`.
- Committed deployment:
  `dep_706e17525e1650478314645d542a74ff1ebeee28c35c325639bc4ec1ddc10fbb`.
- Retained volume: `vol_a97aeabaa48f446b2c1bcc57`, mounted at `/data/zak-radio`.
- Schema: 18 before and after. The backup captured 1,854 retained files,
  totalling 1,605,169,462 bytes.

The tagged package bytes remain unchanged. Its external deployment manifest
removes only the unsupported `size-limit-bytes` declaration. This package script
correction makes future generated manifests compatible with Kiln 2.1. The
bundled lyrics and routing settings match the prior live package.

Verification passed all four Kiln publication gates and all eight application
health checks. Radio, Library, and Reader returned HTTP 200. The catalog retains
156 tracks and one Reader item. Served JavaScript and CSS hashes match the
tagged package, and a media range request returned HTTP 206. Public HTTPS
redirects to the existing SSO login. A signed-in device session was not
retested.

Private request bytes, the exact rollback package, and transaction receipts
remain on Forge under `~/.local/state/zak-radio-release-20261106/`. They are not
repository assets or a substitute for retained server-side backups.
