# Release guide

Tessera publishes two independently versioned release families:

| Tag | Artifact | Intended use |
|---|---|---|
| `bridge-vX.Y.Z` | `broker-bridge` executable | Run an existing SDK-based application through a loopback compatibility bridge. |
| `client-vX.Y.Z` | `broker-client` self-contained archive | Call brokered vendor APIs directly from a .NET-capable environment. |

Every published release contains SHA-256 checksums, a CycloneDX SBOM, GitHub
build provenance, and release notes. Release artifacts contain no vendor key,
broker bearer token, session state, or tenant-specific configuration.

## Install and verify

Download the artifact for your platform and its accompanying `SHA256SUMS` file.
Verify before executing it:

```bash
sha256sum --check SHA256SUMS
```

On Windows, use `Get-FileHash -Algorithm SHA256` and compare the result with the
corresponding `SHA256SUMS` entry. Follow the README packaged with the artifact
to set `BROKER_BASE` and `BROKER_SCOPE`; both are public routing/identity
metadata, never vendor credentials.

## Maintainer release procedure

1. Update the relevant version and [CHANGELOG.md](CHANGELOG.md).
2. Run the repository verification commands from the root README.
3. Confirm `node clients/bridge/scripts/verify-release-actions.mjs` and
   `git diff --check` pass.
4. Create and push exactly one annotated tag: `bridge-vX.Y.Z` or `client-vX.Y.Z`.
5. Confirm the corresponding GitHub Actions release workflow completes its
   platform builds, release integration job, checksum generation, SBOM,
   provenance attestation, and GitHub Release publication.
6. Download one artifact from the published release, verify its checksum, and
   record the release URL in the deployment change record.

Do not retag a published version. Cut a new patch release for any correction.

## Support policy

The `0.x` line is a public preview: interfaces and release packaging may change
between minor releases. Security fixes are coordinated according to
[SECURITY.md](SECURITY.md); deployments should upgrade to the most recent
compatible preview release.
