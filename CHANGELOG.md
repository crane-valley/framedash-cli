# Changelog

All notable changes to `@framedash/cli` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-06-30

### Added

- `framedash run-profile-test`: run an automated profiling build end-to-end for
  CI. Exports the `FRAMEDASH_*` automated-session contract (build id, branch,
  commit, scenario) to the launched game/profiling command, waits for its
  performance data to ingest (a cache-bypassing live read that requires the
  build's event count to grow past its pre-run value, so a re-run is not
  satisfied by old data), then runs the `perf-diff` regression gate against a
  baseline build -- the turnkey companion to `builds` and `perf-diff`.

## [0.1.1] - 2026-06-07

Published from the public mirror via npm Trusted Publishing (OIDC) with a
provenance attestation; the published manifest now carries repository metadata.
No API changes.

## [0.1.0] - 2026-06-06

Initial public pre-release (beta).

- `framedash` CLI for analytics queries, alerts, maps, and content management.
- Designed for CI/CD pipelines and coding-agent workflows.
