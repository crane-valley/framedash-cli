# Changelog

All notable changes to `@framedash/cli` are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.8] - 2026-07-22

### Added

- `framedash threshold-profiles delete <profile-id>`: delete a threshold
  profile via the API/CLI without opening the dashboard. Returns a conflict
  if the profile is still referenced by an alert rule.

### Fixed

- `framedash run-profile-test`: report the first failed ingest poll while
  continuing to retry, so a transient API failure no longer looks like an
  unexplained hang at the waiting step.
- 429 fallback message misread `X-RateLimit-Reset` as a seconds unix
  timestamp; the server has always emitted it in milliseconds (#1304
  confirmed this contract), so an absent `Retry-After` produced an
  absurd far-future "Resets at" time. Parsed as milliseconds now.

## [0.1.7] - 2026-07-17

### Added

- `framedash threshold-profiles create`: create a threshold profile (perf budget)
  via the API/CLI without opening the dashboard.

## [0.1.6] - 2026-07-17

### Added

- `framedash alerts create` / `framedash alerts update`:
  `--threshold-profile-ids <id1,id2,...>` attaches up to 10 threshold
  profiles to a single alert rule (each profile fires and resolves
  independently). The existing `--threshold-profile-id` remains for the
  single-profile case; `alerts create` requires at least one of the two,
  and when both are supplied `--threshold-profile-ids` takes precedence.
  (This entry was backfilled: the flag shipped in 0.1.6 but was missing
  from the changelog at publish time.)
- Package `description` and `keywords` for discoverability on npm.

### Changed

- The "no credentials found" error now points to the project API Keys page
  (https://app.framedash.dev) and the docs URL so an AI agent can self-serve
  setup.
- `framedash login`: surface an OAuth loopback host mismatch clearly. If the
  browser callback lands on a host other than the one the `redirect_uri` was
  registered with (e.g. an authorize URL rewritten from `127.0.0.1` to
  `localhost` by a proxy or by hand), the receiver now warns that the URL was
  altered and that token exchange will fail. When the exchange itself fails with
  `invalid_grant` on a `redirect_uri` mismatch, the error is followed by an
  actionable hint to re-run and open the printed authorization URL exactly as-is.
- `framedash run-profile-test`: a `429` during the pre-run event-count snapshot
  no longer aborts before the engine launches. The snapshot now honors
  `Retry-After` and retries with a capped cumulative wait (up to 120s; a longer
  `Retry-After` fails fast), and on exhaustion exits with a rate-limit-specific
  message that surfaces the server's detail (the hourly rate limit that was hit).
  A 429 with no `Retry-After` (the limiter failing closed on a backend outage,
  `retryable: false`) is not retried and is reported as a transient outage rather
  than a rate limit. The snapshot is still fail-closed (never skipped).
- `framedash alerts delete`: help and success output now describe the operation
  as a deactivation (soft-delete). A deactivated rule stops firing and no longer
  counts against quota but is retained and can be reactivated with
  `framedash alerts update <id> --is-active true`. The command name is unchanged.

## [0.1.5] - 2026-07-11

### Added

- `framedash perf-diff` / `framedash run-profile-test`: four new comparable
  metrics for `--metric` -- disk I/O (`io.read_bytes`, `io.read_time_ms`,
  `io.read_ops`, from the SDK perf-heartbeat disk metrics) and map/level load
  time (`load_time_ms`, from the SDK `map_load` event). All lower-is-better,
  P95 tail, gated build-over-build like the core three.
- Zero-baseline regression detection: a metric whose baseline is 0 (or absent
  baseline samples with candidate samples present) and whose candidate moved
  away from zero now counts as a regression offender even though a percent
  diff is undefined; the diff output prints
  `baseline 0 -> N (regression from zero)`.

### Changed

- `--metric load_time_ms` combined with `--map` is rejected with an explicit
  validation error: `map_load` events deliberately carry an empty `map_id`
  (the per-map load-time breakdown lives in the dashboard). Documented on
  `--map` in `--help` for both commands.

## [0.1.4] - 2026-07-06

### Added

- `framedash projects list`: list the projects your credentials can read
  (id, name, createdAt) via `GET /api/v1/projects`, requiring no
  `--project-id`. Gives onboarding a first-class way to discover a project id
  instead of inferring it from `framedash auth` output.

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
