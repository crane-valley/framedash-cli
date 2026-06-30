#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { error, log } from "./lib/logger.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
	.version as string;

const HELP = `Usage: framedash <command> [options]

Commands:
  auth           Verify API key and list projects
  status         Show project status and key metrics
  dashboard      Show dashboard metrics
  retention      Show player retention cohorts
  funnel         Analyze event funnels
  builds         List builds seen for the project (for perf-diff)
  perf-diff      Compare two builds and gate CI on perf regressions
  run-profile-test  Run a profiling build, wait for ingest, gate on regression
  query          Execute a read-only ClickHouse query
  alerts         Manage alert rules (list, create, update, delete)
  maps           Manage maps (list, delete)
  content        Manage content registry (list, import, delete)
  map-capture    Upload captured map images

Global Options:
  --api-key <key>        API key. Prefer FRAMEDASH_API_KEY env or --api-key-file:
                         a key passed as --api-key is visible in the process
                         list and shell history.
  --api-key-file <path>  Read the API key from a file ('-' for stdin)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Output format: json, table, csv (default: json)
  -h, --help             Show help
  -v, --version          Show version

Run 'framedash <command> --help' for command-specific options.`;

/** Type-safe command registry — typos in export names become build-time errors. */
const COMMANDS: Record<string, () => Promise<(args: string[]) => Promise<void>>> = {
	auth: () => import("./commands/auth.js").then((m) => m.auth),
	status: () => import("./commands/status.js").then((m) => m.status),
	dashboard: () => import("./commands/dashboard.js").then((m) => m.dashboard),
	retention: () => import("./commands/retention.js").then((m) => m.retention),
	funnel: () => import("./commands/funnel.js").then((m) => m.funnel),
	builds: () => import("./commands/builds.js").then((m) => m.builds),
	"perf-diff": () => import("./commands/perf-diff.js").then((m) => m.perfDiff),
	"run-profile-test": () => import("./commands/run-profile-test.js").then((m) => m.runProfileTest),
	query: () => import("./commands/query.js").then((m) => m.query),
	alerts: () => import("./commands/alerts.js").then((m) => m.alerts),
	maps: () => import("./commands/maps.js").then((m) => m.maps),
	content: () => import("./commands/content.js").then((m) => m.content),
	"map-capture": () => import("./commands/map-capture.js").then((m) => m.mapCaptureCommand),
};

const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (command === "-v" || command === "--version") {
	log(`framedash v${VERSION}`);
	process.exit(0);
}

if (!command || command === "-h" || command === "--help") {
	log(HELP);
	process.exit(0);
}

try {
	if (!Object.hasOwn(COMMANDS, command)) {
		error(`Unknown command: ${command}`);
		log(HELP);
		process.exit(1);
	}

	// biome-ignore lint/style/noNonNullAssertion: validated by Object.hasOwn above
	const fn = await COMMANDS[command]!();
	await fn(commandArgs);
} catch (err) {
	if (err instanceof Error && "code" in err && err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
		error(err.message);
		process.exit(1);
	}
	error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
