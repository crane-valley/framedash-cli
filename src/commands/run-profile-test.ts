import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { type ApiClient, buildBuildComparePath, buildBuildsPath } from "@framedash/api-client";
import type { CliConfig } from "../lib/config.js";
import { createClient } from "../lib/create-client.js";
import { formatOutput } from "../lib/formatters.js";
import { error, log, success, warn } from "../lib/logger.js";
import {
	type ApiBuildComparison,
	evaluateRegression,
	formatMetricDiff,
	isRegressionMetric,
	loadTimeMapConflict,
	type RegressionMetric,
} from "../lib/perf-diff-eval.js";
import { runCommand } from "../lib/run-command.js";
import {
	type BuildListEntry,
	buildEventCount,
	buildSessionEnv,
	planTreeKill,
	resolveProfileIdentity,
	SESSION_ENV_KEYS,
	validateSeconds,
	waitForIngest,
} from "../lib/run-profile-test-lib.js";

const DEFAULT_INGEST_TIMEOUT_S = 180;
const DEFAULT_POLL_INTERVAL_S = 5;
// Generous finite default so a game that never self-quits cannot hang a CI job
// forever (the F53 failure mode); 0 disables the bound for interactive/local use.
const DEFAULT_COMMAND_TIMEOUT_S = 1800;
// Cap so command-timeout * 1000 stays within setTimeout's signed 32-bit delay
// (2^31-1 ms); a larger value would be clamped to 1ms and fire almost at once.
const MAX_COMMAND_TIMEOUT_S = Math.floor(2 ** 31 / 1000);

type Values = Record<string, string | boolean | undefined>;

/** Resolved + validated regression-gate options. */
interface GateOptions {
	metric?: RegressionMetric;
	thresholdPct: number;
	/** Set only when a comparison should run (a baseline was given). */
	baseline?: string;
}

/** Best-effort `git` lookup; returns undefined when git is absent or fails. */
function gitOutput(args: string[]): string | undefined {
	try {
		const out = execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/** Parse a seconds-valued flag with a descriptive error, or fall back. */
function parseSeconds(
	value: string | boolean | undefined,
	flag: string,
	fallback: number,
	opts: { allowZero?: boolean; max?: number } = {},
): number {
	const result = validateSeconds(value, fallback, opts);
	if ("error" in result) {
		error(`--${flag} ${result.error}`);
		process.exit(1);
	}
	return result.value;
}

/**
 * Forward the project id and base URL so a CI game build that reads them from the
 * environment targets the same project/endpoint the gate queries (they must match
 * or the gate would read a different project's builds).
 *
 * Deliberately does NOT forward the API key: the gate's key needs analytics:read,
 * while the game's SDK needs a separate events:write ingest key (the presets keep
 * ingest a separate plane). Overwriting the child's FRAMEDASH_API_KEY would make
 * the game send events with a read-only key and 403 at ingest, so the game keeps
 * whatever ingest key the CI environment already set for it.
 */
function passthroughProjectEnv(config: CliConfig): Record<string, string> {
	return {
		FRAMEDASH_PROJECT_ID: config.projectId,
		FRAMEDASH_BASE_URL: config.baseUrl,
	};
}

/** Validate and resolve the regression-gate flags, exiting on a misconfig. */
function resolveGateOptions(values: Values, candidateBuildId: string): GateOptions {
	let metric: RegressionMetric | undefined;
	if (values.metric !== undefined) {
		const raw = (values.metric as string).trim();
		if (!isRegressionMetric(raw)) {
			error(
				`Invalid --metric '${raw}'. Allowed: frame_time, memory, gpu_time, io.read_bytes, io.read_time_ms, io.read_ops, load_time_ms`,
			);
			process.exit(1);
		}
		metric = raw;
	}

	// map_load rows have an empty map_id; a map-filtered load_time_ms gate returns
	// no rows and would wrongly trip the fail-closed check.
	const mapConflict = loadTimeMapConflict(metric, values.map as string | undefined);
	if (mapConflict) {
		error(mapConflict);
		process.exit(1);
	}

	let thresholdPct = 0;
	if (values.threshold !== undefined) {
		thresholdPct = Number(values.threshold);
		if (!Number.isFinite(thresholdPct) || thresholdPct < 0) {
			error("--threshold must be a non-negative number (percent)");
			process.exit(1);
		}
	}

	const baseline = (values.baseline as string | undefined)?.trim();
	// A build compared against itself is a zero diff that would silently pass.
	if (baseline && baseline === candidateBuildId) {
		error("--baseline must differ from the candidate build id (the build under test).");
		process.exit(1);
	}
	if (values["fail-on-regression"] && !baseline) {
		error("--fail-on-regression requires --baseline (the known-good build to compare against).");
		process.exit(1);
	}

	return { metric, thresholdPct, baseline };
}

/**
 * Terminate the launched process TREE by pid. A plain child kill leaves
 * grandchildren behind (a game launched via the shell spawns helper processes),
 * so use the platform-specific whole-tree strategy from planTreeKill: taskkill
 * /T /F on win32, or a SIGKILL to the process group on POSIX (falling back to the
 * direct pid if the group is already gone). planTreeKill returns a noop plan for a
 * missing/non-positive pid (which would otherwise signal our own group or every
 * process on POSIX). Best-effort: never throws.
 */
function killProcessTree(pid: number | undefined): void {
	const plan = planTreeKill(process.platform, pid);
	if (plan.platform === "noop") return;
	if (plan.platform === "win32") {
		spawnSync(plan.command, plan.args, { stdio: "ignore" });
		return;
	}
	try {
		process.kill(plan.groupPid, "SIGKILL");
	} catch {
		try {
			// -groupPid is the validated positive child pid; fall back to it directly.
			process.kill(-plan.groupPid, "SIGKILL");
		} catch {
			// The process (group) is already gone; nothing left to kill.
		}
	}
}

/** Outcome of a profiling run (mirrors the fields we branch on). */
interface ProfilingRunResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	/** True when the run was killed for exceeding --command-timeout. */
	timedOut: boolean;
}

/**
 * Spawn the profiling command (inheriting stdio) and resolve when it exits.
 * Bounds the run with an overall timeout: on win32 the child is the shell, whose
 * whole tree taskkill terminates; on POSIX the child is spawned detached so we
 * can signal its process group. timeoutMs <= 0 disables the bound. Rejects only
 * on a spawn error (ENOENT etc.).
 */
function runProfilingCommand(
	command: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<ProfilingRunResult> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(command, {
			shell: true,
			stdio: "inherit",
			env,
			// POSIX: run in a new process group so killProcessTree can signal the whole
			// group. win32 has no process groups here; taskkill /T handles the tree.
			detached: process.platform !== "win32",
		});
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		// A detached POSIX child does NOT share the terminal's signals, so a Ctrl-C or
		// CI cancellation that terminates THIS CLI would orphan the game's process
		// group. Kill the tree on those signals first, then exit with the conventional
		// 128 + signal-number code so the exit status still reflects the signal.
		const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			for (const s of forwardedSignals) process.off(s, onSignal);
		};
		const onSignal = (signal: NodeJS.Signals): void => {
			cleanup();
			killProcessTree(child.pid);
			process.exit(128 + (osConstants.signals[signal] ?? 0));
		};
		for (const s of forwardedSignals) process.on(s, onSignal);
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				killProcessTree(child.pid);
			}, timeoutMs);
		}
		child.on("error", (err) => {
			cleanup();
			reject(err);
		});
		child.on("exit", (code, signal) => {
			cleanup();
			resolve({ status: code, signal, timedOut });
		});
	});
}

/** Launch the profiling command and exit on any failure (or timeout). */
async function launchProfilingRun(
	command: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<void> {
	let result: ProfilingRunResult;
	try {
		result = await runProfilingCommand(command, env, timeoutMs);
	} catch (err) {
		error(`Failed to launch --command: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	// A timeout is incomplete data: fail closed WITHOUT gating, same philosophy as a
	// non-zero exit. Checked first because the kill also sets a signal on the child.
	if (result.timedOut) {
		error(
			`Profiling command exceeded the --command-timeout of ${timeoutMs / 1000}s and was killed; ` +
				"not gating on incomplete data. If the game does not exit on its own, make your " +
				"automation quit when the run finishes, or raise --command-timeout (0 disables the bound).",
		);
		process.exit(1);
	}
	if (result.signal) {
		error(`Profiling command was terminated by signal ${result.signal}.`);
		// Conventional 128 + signal number so CI sees a meaningful non-zero code.
		process.exit(128 + (osConstants.signals[result.signal] ?? 0));
	}
	if (typeof result.status === "number" && result.status !== 0) {
		error(`Profiling command exited with code ${result.status}; not gating on incomplete data.`);
		process.exit(result.status);
	}
}

/**
 * Fetch the candidate build's list row (the suffix the pre-run snapshot and poll
 * share). Scopes to the candidate buildId so the server's newest-50 cap cannot
 * hide a re-run of an older build, and uses fresh=1 to bypass the aggregation
 * cache so the wait reads live state (a cached, stale-low count could let an old
 * run's data pass the wait).
 */
function fetchBuilds(
	client: ApiClient,
	values: Values,
	buildId: string,
): Promise<BuildListEntry[]> {
	return client.get<BuildListEntry[]>(
		client.projectPath(
			buildBuildsPath({ days: values.days as string | undefined, buildId, fresh: true }),
		),
	);
}

/**
 * The candidate's perf-event count right now. Read BEFORE the run so the ingest
 * wait can require the count to grow -- a CI re-run for the same build_id must
 * not be satisfied by the previous run's data. Fails closed if the snapshot
 * cannot be read: without a reliable baseline the wait could pass on old data
 * (a false-green gate), so abort before launch rather than guess 0.
 */
async function readPriorEventCount(
	client: ApiClient,
	values: Values,
	buildId: string,
): Promise<number> {
	let builds: BuildListEntry[];
	try {
		builds = await fetchBuilds(client, values, buildId);
	} catch (err) {
		error(
			`Could not read the build's pre-run event count (${
				err instanceof Error ? err.message : String(err)
			}). Aborting before launch; pass --skip-wait if your SDK flushes synchronously.`,
		);
		process.exit(1);
	}
	// A non-error response that is not an array means we cannot trust the baseline
	// (it could read as 0 and let an old run's data satisfy the wait), so fail closed.
	if (!Array.isArray(builds)) {
		error(
			"The builds API returned an unexpected response (no build list); cannot establish a " +
				"pre-run baseline. Aborting before launch; pass --skip-wait if your SDK flushes synchronously.",
		);
		process.exit(1);
	}
	return buildEventCount(builds, buildId);
}

/** Poll the builds list until the candidate gains fresh events; exit on timeout. */
async function awaitIngest(
	client: ApiClient,
	values: Values,
	buildId: string,
	priorEventCount: number,
	timeoutMs: number,
	intervalMs: number,
): Promise<void> {
	success(`Waiting up to ${timeoutMs / 1000}s for build '${buildId}' to ingest...`);
	const landed = await waitForIngest({
		buildId,
		minEventCount: priorEventCount,
		timeoutMs,
		intervalMs,
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		fetchBuilds: () => fetchBuilds(client, values, buildId),
	});
	if (!landed) {
		error(
			`Build '${buildId}' did not ingest fresh events within ${timeoutMs / 1000}s. ` +
				"The SDK may not have flushed, or ingest/aggregation is lagging. " +
				"Increase --ingest-timeout, or check with 'framedash builds'. " +
				`Also confirm the game picked up the awaited build id: --build-id reaches the game via the ` +
				`exported FRAMEDASH_BUILD_ID env var and the SDK's BeginAutomatedSessionFromEnvironment() ` +
				`auto-session pickup -- a game that hardcodes its buildId will never match '${buildId}'.`,
		);
		process.exit(1);
	}
	success(`Build '${buildId}' ingested.`);
}

/** Fetch the build comparison, print it, and (with --fail-on-regression) gate. */
async function runRegressionGate(
	client: ApiClient,
	config: CliConfig,
	values: Values,
	gate: Required<Pick<GateOptions, "baseline" | "thresholdPct">> &
		Pick<GateOptions, "metric"> & { candidate: string },
): Promise<void> {
	const comparison = await client.get<ApiBuildComparison>(
		client.projectPath(
			buildBuildComparePath({
				baseline: gate.baseline,
				candidate: gate.candidate,
				days: values.days as string | undefined,
				mapId: values.map as string | undefined,
				platform: values.platform as string | undefined,
				// Bypass the compare cache so a re-run gates on the just-ingested data.
				fresh: true,
			}),
		),
	);
	// A non-error 2xx with a malformed body must fail closed, not crash the gate.
	if (!comparison || !Array.isArray(comparison.diffs)) {
		error("Unexpected response from the builds/compare API (no comparison data).");
		process.exit(1);
	}
	log(
		config.format === "json"
			? formatOutput(comparison, "json")
			: formatOutput(comparison.diffs, config.format),
	);

	const verdict = evaluateRegression(comparison, {
		metric: gate.metric,
		thresholdPct: gate.thresholdPct,
	});

	// Report-only (no --fail-on-regression): never exit non-zero, but still warn --
	// on a regression, AND when nothing was comparable -- so a misconfigured CI job
	// (wrong build IDs, or a metric with no data) does not silently go green.
	if (!values["fail-on-regression"]) {
		if (verdict.evaluated.length === 0) {
			warn(
				gate.metric
					? `No comparable '${gate.metric}' data between these builds; the gate evaluated nothing (check the build IDs / metric).`
					: "No comparable performance data between these builds; the gate evaluated nothing (check the build IDs).",
			);
		} else if (verdict.failed) {
			warn(
				`Regression detected (threshold ${gate.thresholdPct}%): ${verdict.offenders
					.map(formatMetricDiff)
					.join("; ")}. Pass --fail-on-regression to fail the build.`,
			);
		}
		return;
	}

	// Fail closed: nothing comparable means the gate is unmeasured, not passed.
	if (verdict.evaluated.length === 0) {
		error(
			gate.metric
				? `No comparable '${gate.metric}' data between these builds; cannot evaluate a regression.`
				: "No comparable performance data between these builds; cannot evaluate a regression.",
		);
		process.exit(1);
	}
	if (verdict.failed) {
		error(
			`Performance regression detected (threshold ${gate.thresholdPct}%): ${verdict.offenders
				.map(formatMetricDiff)
				.join("; ")}`,
		);
		process.exit(1);
	}
	success(
		`No performance regression beyond ${gate.thresholdPct}% (${verdict.evaluated.length} metric(s) checked).`,
	);
}

/**
 * Turnkey CI profiling gate: export the FRAMEDASH_* session contract, launch the
 * configured game/profiling command, wait for its perf data to ingest, then run
 * the perf-diff regression gate against a baseline build.
 */
export async function runProfileTest(args: string[]): Promise<void> {
	await runCommand(
		{
			args,
			help: HELP,
			options: {
				command: { type: "string" },
				"build-id": { type: "string" },
				branch: { type: "string" },
				commit: { type: "string" },
				scenario: { type: "string" },
				"command-timeout": { type: "string" },
				"ingest-timeout": { type: "string" },
				"poll-interval": { type: "string" },
				"skip-wait": { type: "boolean" },
				baseline: { type: "string" },
				metric: { type: "string" },
				threshold: { type: "string" },
				days: { type: "string" },
				map: { type: "string" },
				platform: { type: "string" },
				"fail-on-regression": { type: "boolean" },
			},
		},
		async ({ client, config, values }) => {
			const command = (values.command as string | undefined)?.trim();
			if (!command) {
				error("--command is required (the game/profiling command to launch)");
				process.exit(1);
			}

			// Resolve the build identity: explicit flags win, else fall back to git.
			// Only spawn `git` for a field the caller did not provide.
			const branchFlag = values.branch as string | undefined;
			const commitFlag = values.commit as string | undefined;
			const identity = resolveProfileIdentity(
				{
					buildId: values["build-id"] as string | undefined,
					branch: branchFlag,
					commit: commitFlag,
					scenario: values.scenario as string | undefined,
				},
				{
					branch: branchFlag ? undefined : gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]),
					commit: commitFlag ? undefined : gitOutput(["rev-parse", "HEAD"]),
				},
			);
			if (!identity) {
				error(
					"Could not determine a build id: pass --build-id or --commit, or run inside a git repo.",
				);
				process.exit(1);
			}

			// Validate everything up front so a misconfig fails before we spend minutes
			// running the game only to reject the result.
			const gate = resolveGateOptions(values, identity.buildId);
			// Bounds only the launched game/profiling process, NOT the ingest wait
			// (--ingest-timeout covers that separately). 0 disables the bound.
			const commandTimeoutMs =
				parseSeconds(values["command-timeout"], "command-timeout", DEFAULT_COMMAND_TIMEOUT_S, {
					allowZero: true,
					max: MAX_COMMAND_TIMEOUT_S,
				}) * 1000;
			const ingestTimeoutMs =
				parseSeconds(values["ingest-timeout"], "ingest-timeout", DEFAULT_INGEST_TIMEOUT_S) * 1000;
			const pollIntervalMs =
				parseSeconds(values["poll-interval"], "poll-interval", DEFAULT_POLL_INTERVAL_S) * 1000;

			// The ingest snapshot/poll run in a retry loop, so they need a client that
			// THROWS on a transient 429/5xx (the default client exits the process,
			// which would kill the wait on a temporary blip). The gate compare keeps
			// the default exit-on-error client (a compare failure should fail the gate).
			const skipWait = Boolean(values["skip-wait"]);
			const pollClient = skipWait
				? client
				: createClient(config.baseUrl, config.credential, config.projectId, {
						throwOnError: true,
					});

			// Snapshot the candidate's event count BEFORE the run (only when we will
			// wait), so the ingest wait can require fresh events rather than accepting
			// a prior run's data for the same build_id.
			const priorEventCount = skipWait
				? 0
				: await readPriorEventCount(pollClient, values, identity.buildId);

			// 1) Launch the profiling command with the FRAMEDASH_* contract exported, so
			// the SDK's BeginAutomatedSessionFromEnvironment() stamps build_id + ci.* tags
			// onto every event (including the perf_heartbeat the gate reads).
			success(
				`Running profiling build '${identity.buildId}'${
					identity.scenario ? ` (scenario: ${identity.scenario})` : ""
				}`,
			);
			// Build the child environment. Two safeguards:
			// 1) The runner owns the whole FRAMEDASH_* session contract: clear any
			//    contract key it did not set this run, so the game cannot inherit stale
			//    branch/commit/scenario left in the environment by a prior CI step.
			// 2) The gate key (analytics:read) must not be handed to the game as its key
			//    -- the game needs a separate events:write ingest key. When the gate key
			//    came from FRAMEDASH_API_KEY in the environment (no --api-key flag), strip
			//    it from the child so the game cannot inherit a read key.
			const sessionEnv = buildSessionEnv(identity);
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				...passthroughProjectEnv(config),
				...sessionEnv,
			};
			for (const key of SESSION_ENV_KEYS) {
				if (!(key in sessionEnv)) delete childEnv[key];
			}
			if (!values["api-key"] && !values["api-key-file"] && process.env.FRAMEDASH_API_KEY) {
				delete childEnv.FRAMEDASH_API_KEY;
				warn(
					"Removed the gate's FRAMEDASH_API_KEY (an analytics:read key) from the launched " +
						"game's environment so it is not used as the game's ingest key. Set the game's " +
						"events:write key separately, or pass the gate key via --api-key/--api-key-file.",
				);
			}
			await launchProfilingRun(command, childEnv, commandTimeoutMs);

			// 2) Wait for the candidate build's perf events to land (unless skipped).
			if (!skipWait) {
				await awaitIngest(
					pollClient,
					values,
					identity.buildId,
					priorEventCount,
					ingestTimeoutMs,
					pollIntervalMs,
				);
			}

			// 3) Run the perf-diff gate when a baseline is given; otherwise the run is
			// complete (the SDK reported the build; the caller can compare it later).
			if (!gate.baseline) {
				success(
					"Profiling run complete. Pass --baseline to gate on a build-over-build regression.",
				);
				return;
			}
			await runRegressionGate(client, config, values, {
				baseline: gate.baseline,
				candidate: identity.buildId,
				metric: gate.metric,
				thresholdPct: gate.thresholdPct,
			});
		},
	);
}

const HELP = `Usage: framedash run-profile-test --command "<cmd>" [options]

Run an automated profiling test end-to-end for CI: export the FRAMEDASH_*
session contract, launch your game/profiling command, wait for its performance
data to ingest, then (with --baseline) gate on a build-over-build regression.

The launched command inherits these environment variables; an SDK that calls
BeginAutomatedSessionFromEnvironment() picks them up automatically:
  FRAMEDASH_BUILD_ID       the candidate build_id (first-class)
  FRAMEDASH_GIT_BRANCH     ci.branch attribute
  FRAMEDASH_GIT_COMMIT     ci.commit attribute
  FRAMEDASH_TEST_SCENARIO  ci.scenario attribute
The build id from --build-id (or the git default) reaches the game ONLY via the
exported FRAMEDASH_BUILD_ID env var, which BeginAutomatedSessionFromEnvironment()
reads. A game that hardcodes its buildId will never match the awaited build, so
the ingest wait will time out -- do not hardcode the SDK build id in a CI build.
FRAMEDASH_PROJECT_ID / FRAMEDASH_BASE_URL are forwarded so the build targets the
same project the gate queries. The gate uses an analytics:read key while your
game needs a separate events:write ingest key: pass the gate key with
--api-key/--api-key-file and keep the game's ingest key in the launched command's
FRAMEDASH_API_KEY, so the gate key does not get inherited as the game's key.

Required:
  --command <cmd>        Game/profiling command to launch (run via the shell)

Run bound (kills the launched process tree on timeout so a game that never
self-quits cannot hang a CI job forever; a timeout fails the run without gating):
  --command-timeout <s>  Max seconds the launched command may run (default: 1800,
                         0 disables the bound)

Build identity (each defaults as noted; exported to the child):
  --build-id <id>        Candidate build_id (default: --commit, else git HEAD)
  --branch <name>        default: git rev-parse --abbrev-ref HEAD
  --commit <sha>         default: git rev-parse HEAD
  --scenario <name>      Test scenario label (no default)

Note: the gate compares ALL of a build_id's samples in the window (the build_id
is the comparison unit, as in 'perf-diff'). If a CI job may re-run the SAME
commit, give each run a unique build_id (e.g. --build-id "$GIT_SHA-$RUN_ID") so
the comparison is not diluted by a previous run's samples.

Ingest wait (polls a cache-bypassing live read and waits for the build's
perf-event count to GROW past its pre-run value, so a re-run for the same build
id is not satisfied by old data):
  --ingest-timeout <s>   Max seconds to wait for fresh events (default: 180)
  --poll-interval <s>    Seconds between build-list polls (default: 5)
  --skip-wait            Skip the ingest wait (e.g. the SDK flushed synchronously)

Regression gate (runs only when --baseline is set):
  --baseline <id>        Known-good build_id to compare the candidate against
  --metric <name>        Gate on one metric: frame_time, memory, gpu_time,
                         io.read_bytes, io.read_time_ms, io.read_ops, load_time_ms
                         (default: all)
  --threshold <pct>      Tolerate a regression up to this percent (default: 0)
  --fail-on-regression   Exit 1 on a regression beyond the threshold (needs --baseline)
  --days <n>             Comparison window in days: 7, 14, 30, 90 (default: 30)
  --map <id>             Restrict the comparison to one map. NOT valid with
                         --metric load_time_ms (map_load rows carry an empty map_id).
  --platform <name>      Restrict the comparison to one platform

Global:
  --api-key <key>        API key (or FRAMEDASH_API_KEY env)
  --project-id <uuid>    Project ID (or FRAMEDASH_PROJECT_ID env)
  --base-url <url>       API base URL (default: https://app.framedash.dev)
  --format <fmt>         Comparison output format: json, table, csv (default: json)
  -h, --help             Show help

Example (GitHub Actions gate):
  framedash run-profile-test \\
    --command "./Build/Game.exe -nullrhi -ExecCmds='Automation RunTest Perf'" \\
    --scenario nightly --baseline "$BASE_SHA" --threshold 5 --fail-on-regression`;
