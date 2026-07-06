# @framedash/cli

Framedash CLI tool for CI/CD pipelines, analytics queries, and coding agent integration.

## Commands

| Command | Description |
|---------|-------------|
| `framedash login` | Sign in via the browser (interactive OAuth; not for CI) |
| `framedash logout` | Revoke and remove a stored browser login |
| `framedash auth` | Verify credentials, show their source, and list projects |
| `framedash projects` | List accessible projects (discover your project id) |
| `framedash query` | Run SQL analytics queries against ClickHouse |
| `framedash dashboard` | Fetch dashboard KPI summary |
| `framedash retention` | Fetch retention cohort data |
| `framedash funnel` | Fetch funnel conversion data |
| `framedash builds` | List builds seen for the project (for `perf-diff`) |
| `framedash perf-diff` | Compare two builds and gate CI on a perf regression |
| `framedash run-profile-test` | Run a profiling build, wait for ingest, then gate on a regression |
| `framedash alerts` | Manage alert rules and channels |
| `framedash maps` | List and manage map overlays |
| `framedash threshold-profiles` | List threshold profiles (perf budgets for alerts) |
| `framedash content` | Manage content registry entries |
| `framedash status` | Check project ingestion status |
| `framedash map-capture` | Upload captured map images |

`framedash alerts create` requires an existing map and threshold profile: pass
their UUIDs via `--map-id` and `--threshold-profile-id`. Discover those UUIDs
without opening the dashboard by running `framedash maps list` and
`framedash threshold-profiles list`.

## Authentication

Two credential types are supported:

- API keys (recommended for CI and any non-interactive use): pass via
  `--api-key-file` (supports `-` for piped stdin), `--api-key`, or the
  `FRAMEDASH_API_KEY` environment variable. Prefer files or piped stdin over
  `--api-key` for local runs so raw keys do not appear in shell history.
- Interactive browser login: `framedash login` runs an OAuth 2.1
  authorization-code + PKCE flow against the Framedash authorization server
  (loopback redirect on `127.0.0.1`). Tokens are stored per base-URL origin in
  `$XDG_CONFIG_HOME/framedash/credentials.json` (default
  `~/.config/framedash/credentials.json`; the same `~/.config` path is used on
  Windows) and refreshed automatically, including refresh-token rotation.
  `framedash logout` revokes the session server-side (best effort) and removes
  the stored tokens; `framedash logout --all` clears every stored login.

Precedence: `--api-key` > `--api-key-file` > `FRAMEDASH_API_KEY` > stored
OAuth login for the resolved base URL. `framedash auth` reports which source
is active.

CI/non-interactive environments should keep using `FRAMEDASH_API_KEY` with a
project API key: `framedash login` requires a browser and stores per-user
refresh tokens, neither of which fits ephemeral CI runners.

Project-scoped commands such as `dashboard` also require a project ID from
`--project-id` or `FRAMEDASH_PROJECT_ID`. The `auth` command only requires an
API key.

For the local examples below, keep the API key in `../../framedash.key` and set
`FRAMEDASH_PROJECT_ID` to the target project UUID before running project-scoped
commands.

```bash
export FRAMEDASH_PROJECT_ID="<project-uuid>"
```

## Usage

Build the CLI workspace and its dependencies from the repository root:

```bash
pnpm --filter @framedash/cli... build
```

After completing the Environment setup, run these commands from `packages/cli`:

```bash
cd packages/cli

node . --help
node . auth --api-key-file ../../framedash.key
cat ../../framedash.key | node . auth --api-key-file -
node . dashboard --api-key-file ../../framedash.key --format json
node . dashboard --api-key-file ../../framedash.key --format table
node . dashboard --api-key-file ../../framedash.key --format csv
```

## CI performance gating

`run-profile-test` ties the SDK's automated-session API to the `perf-diff` gate
into a single CI step. It exports the `FRAMEDASH_*` session contract, launches
your profiling build, waits for its performance data to ingest, then fails the
job on a build-over-build regression:

```bash
framedash run-profile-test \
  --command "./Build/Game.exe -nullrhi -ExecCmds='Automation RunTest Perf'" \
  --scenario nightly --baseline "$BASE_SHA" --threshold 5 --fail-on-regression
```

The launched command inherits `FRAMEDASH_BUILD_ID`, `FRAMEDASH_GIT_BRANCH`,
`FRAMEDASH_GIT_COMMIT`, and `FRAMEDASH_TEST_SCENARIO`; an SDK that calls
`BeginAutomatedSessionFromEnvironment()` stamps them onto every event with no
in-game code change. The build id (defaulting to the git commit) becomes the
`perf-diff` candidate. Because the build id reaches the game only through the
exported `FRAMEDASH_BUILD_ID`, a build that hardcodes its SDK build id will never
match the awaited build and the ingest wait will time out.

The launched process is bounded by `--command-timeout` (default 1800s, `0`
disables): if the game does not exit on its own, its whole process tree is killed
and the run fails without gating -- so a non-self-quitting build cannot hang the
CI job forever. Run `framedash run-profile-test --help` for all options, or use
`framedash builds` / `framedash perf-diff` to drive the steps manually.

## Development

Run these commands from `packages/cli`:

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm type-check # Type check
```
