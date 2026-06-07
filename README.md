# @framedash/cli

Framedash CLI tool for CI/CD pipelines, analytics queries, and coding agent integration.

## Commands

| Command | Description |
|---------|-------------|
| `framedash auth` | Authenticate with API key |
| `framedash query` | Run SQL analytics queries against ClickHouse |
| `framedash dashboard` | Fetch dashboard KPI summary |
| `framedash retention` | Fetch retention cohort data |
| `framedash funnel` | Fetch funnel conversion data |
| `framedash alerts` | Manage alert rules and channels |
| `framedash maps` | List and manage map overlays |
| `framedash content` | Manage content registry entries |
| `framedash status` | Check project ingestion status |
| `framedash map-capture` | Upload captured map images |

## Environment

API commands require an API key from `--api-key-file` (which supports `-` for
piped stdin), `--api-key`, or `FRAMEDASH_API_KEY`. Prefer files or piped stdin
over `--api-key` for local runs so raw keys do not appear in shell history.

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

## Development

Run these commands from `packages/cli`:

```bash
pnpm build      # Compile TypeScript
pnpm test       # Run tests
pnpm type-check # Type check
```
