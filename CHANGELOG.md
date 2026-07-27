# Changelog

All notable changes to Tessera API Broker are documented here. The project uses
[Semantic Versioning](https://semver.org/) for independently released clients
and follows the [Keep a Changelog](https://keepachangelog.com/) structure.

## Unreleased

### Added

- Authenticated, route-specific broker preflight with a redacted correlation
  surface and zero vendor, Key Vault, quota, or OAuth side effects.
- Tenant-neutral NinjaOne provider profile, deployment-chain validation, and
  operator guidance.
- Public retry, configuration, and preflight coverage for Node, Python, and
  .NET clients.
- Immutable release-action and SBOM image pins, architecture checks, provenance,
  SBOMs, and release integration verification.

### Changed

- Registration packages require a deployment-owned trust anchor before they can
  be rendered or deployed.
- JWKS cache policy honors `Cache-Control: max-age=0`.
- Release artifacts now include operator documentation and the project license.

### Security

- Credential-shaped caller headers are rejected at shipped client boundaries.
- Retired registration schema and renderer assets were removed.

## 1.0.0 - 2026-07-26

### Added

- Initial Tessera API Broker reference implementation and `broker-bridge`
  release pipeline.
