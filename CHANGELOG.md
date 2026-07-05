# Changelog

All notable changes to `@framedash/cli` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-07-05

### Added

- `framedash login` / `framedash logout`: interactive browser sign-in via OAuth
  2.1 authorization code + PKCE (S256) with CSRF `state` validation. The
  loopback redirect receiver binds strictly to `127.0.0.1` on an ephemeral port
  (RFC 8252) with a 5-minute timeout; the authorization URL is always printed in
  case the browser cannot be opened. Tokens are stored per API origin in
  `~/.config/framedash/credentials.json` (honors `XDG_CONFIG_HOME`; same path on
  Windows) with `0600` permissions and atomic writes. Credential precedence is
  `--api-key` > `--api-key-file` > `FRAMEDASH_API_KEY` > stored OAuth login for
  the resolved base URL origin; access tokens auto-refresh shortly before expiry
  and once after a 401, and rotated refresh tokens are persisted. `framedash
  logout` revokes the refresh token (RFC 7009, best effort) before removing it
  locally, and `--all` clears every stored origin. `framedash auth` now reports
  the active credential source. CI/non-interactive use keeps
  `FRAMEDASH_API_KEY`.
- `framedash threshold-profiles list`: list a project's threshold profiles
  (the performance budgets referenced by alert rules), so the
  `--threshold-profile-id` UUID for `alerts create` is discoverable from the
  CLI; `alerts create --help` now points at `framedash maps list` and
  `framedash threshold-profiles list` for the `--map-id` /
  `--threshold-profile-id` options.

### Changed

- Raise the minimum supported Node.js runtime to `>=20.0.0` (was `>=18.0.0`) so
  Node's default Happy Eyeballs / `autoSelectFamily` concurrent IPv4 fallback is
  a guaranteed contract. On a broken-IPv6 network (a global AAAA advertised with
  no working route) an older runtime without that default would wedge every
  connect on the unreachable address; requiring Node 20+ makes the fast IPv4
  fallback part of the supported-runtime contract, not a Node-20 default
  assumption on an older supported runtime.
- `framedash run-profile-test`: bound the launched game/profiling process with a
  new `--command-timeout <seconds>` option (default 1800, `0` disables). A game
  that never self-quits previously hung the command -- and any CI job -- forever;
  the wait is now bounded and, on timeout, the whole process tree is killed
  (`taskkill /T /F` on Windows, a process-group signal on POSIX) and the run
  fails closed without gating on incomplete data. The ingest-wait timeout message
  and `--help` now spell out that `--build-id` reaches the game only via the
  exported `FRAMEDASH_BUILD_ID` and the SDK's
  `BeginAutomatedSessionFromEnvironment()` pickup, so a hardcoded in-game build id
  will never match the awaited build.
- `--format table` now renders an envelope response whose fields are all nested
  values (e.g. the dashboard's `kpis` / `dailyActiveUsers` / `topEvents`) as one
  titled section per key -- an object becomes key/value rows, an array of
  objects becomes a sub-table with one-level dot-path flattening -- instead of a
  single row of JSON blob cells. Flat arrays (maps, alerts, builds lists),
  objects that mix scalar and nested fields, and `json`/`csv` output are
  unchanged.

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
