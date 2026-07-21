import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { type ApiClient, ApiError } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProfileTest } from "../commands/run-profile-test.js";
import type { ApiBuildComparison, ApiMetricDiff } from "../lib/perf-diff-eval.js";
import type { BuildListEntry } from "../lib/run-profile-test-lib.js";

vi.mock("node:child_process", () => ({
	// git rev-parse -> a stable fake SHA/branch. spawn/spawnSync are wired up in
	// beforeEach (the factory cannot reference module-scope helpers -- it is hoisted).
	execFileSync: vi.fn(() => "gitsha\n"),
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../lib/create-client.js", () => ({
	createClient: vi.fn(),
}));

import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as createClientModule from "../lib/create-client.js";
import * as loggerModule from "../lib/logger.js";

interface FakeChildOpts {
	status?: number | null;
	signal?: NodeJS.Signals | null;
	error?: Error;
	/** When true, never auto-emits: the test drives exit/error itself. */
	hang?: boolean;
	pid?: number;
}

/**
 * A minimal ChildProcess stand-in: an EventEmitter with a pid and kill(). Unless
 * `hang` is set it emits "exit" (or "error") on the next microtask so the runner's
 * exit-listener resolves without real timers.
 */
function makeChild(opts: FakeChildOpts = {}): ChildProcess & EventEmitter {
	const child = new EventEmitter() as ChildProcess & EventEmitter;
	(child as { pid?: number }).pid = opts.pid ?? 4321;
	(child as { kill: unknown }).kill = vi.fn();
	if (!opts.hang) {
		queueMicrotask(() => {
			if (opts.error) child.emit("error", opts.error);
			else child.emit("exit", opts.status ?? 0, opts.signal ?? null);
		});
	}
	return child;
}

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
	return {
		get: vi.fn(),
		post: vi.fn(),
		patch: vi.fn(),
		delete: vi.fn(),
		projectPath: vi.fn((s: string) => `/api/v1/projects/test-project/${s}`),
		currentProjectId: "test-project",
		withProject: vi.fn(),
		...overrides,
	} as unknown as ApiClient;
}

function diff(metric: ApiMetricDiff["metric"], diffPct: number | null): ApiMetricDiff {
	return {
		metric,
		baselineP50: 10,
		candidateP50: diffPct === null ? null : 10 * (1 + diffPct / 100),
		diffPct,
		isRegression: diffPct !== null && diffPct > 0,
		baselineTail: 20,
		candidateTail: 20,
	};
}

function comparison(diffs: ApiMetricDiff[]): ApiBuildComparison {
	return { baseline: { build_id: "base" }, candidate: { build_id: "cand" }, diffs };
}

const ingested: BuildListEntry[] = [{ build_id: "cand", event_count: 5 }];

function expectExit() {
	const spy = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as never);
	return { restore: () => spy.mockRestore(), spy };
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FRAMEDASH_API_KEY = "fd_test_key";
	process.env.FRAMEDASH_PROJECT_ID = "test-project";
	delete process.env.FRAMEDASH_BASE_URL;
	delete process.env.FRAMEDASH_FORMAT;
	delete process.env.FRAMEDASH_GIT_BRANCH;
	// Restore the default mock behavior cleared above.
	vi.mocked(execFileSync).mockReturnValue("gitsha\n");
	// Default: the launched command exits 0 on the next microtask.
	vi.mocked(spawn).mockImplementation(() => makeChild());
	// spawnSync is only used by the win32 tree-kill path; a no-op return is fine.
	vi.mocked(spawnSync).mockReturnValue({} as never);
});

describe("run-profile-test command", () => {
	it("exits with error when --command is missing", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(runProfileTest(["--build-id", "cand"])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("--command is required"),
		);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("exits when --fail-on-regression is set without --baseline", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--fail-on-regression"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("requires --baseline"));
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("exits when --baseline equals the candidate build id", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--baseline", "cand"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("must differ"));
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("launches the command with the FRAMEDASH_* contract exported", async () => {
		// First get = pre-run count (none yet); subsequent = the ingest poll.
		const client = mockClient({
			get: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(ingested),
		});
		vi.mocked(createClientModule.createClient).mockReturnValue(client);
		// The game's own ingest (events:write) key lives in the environment.
		process.env.FRAMEDASH_API_KEY = "game_ingest_key";

		await runProfileTest([
			"--command",
			"game --headless",
			// The gate uses a distinct read key; it must NOT clobber the game's key.
			"--api-key",
			"cli_read_key",
			"--build-id",
			"cand",
			"--branch",
			"feat/x",
			"--scenario",
			"smoke",
		]);

		expect(spawn).toHaveBeenCalledWith(
			"game --headless",
			expect.objectContaining({
				shell: true,
				stdio: "inherit",
				env: expect.objectContaining({
					FRAMEDASH_BUILD_ID: "cand",
					FRAMEDASH_GIT_BRANCH: "feat/x",
					FRAMEDASH_TEST_SCENARIO: "smoke",
					FRAMEDASH_PROJECT_ID: "test-project",
					// The game keeps its ingest key; the gate's read key is not forwarded
					// (asserting the exact value proves it is not "cli_read_key").
					FRAMEDASH_API_KEY: "game_ingest_key",
				}),
			}),
		);
		expect(loggerModule.success).toHaveBeenCalledWith(expect.stringContaining("ingested"));
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("propagates a non-zero exit code from the profiling command", async () => {
		const { restore, spy } = expectExit();
		vi.mocked(spawn).mockImplementation(() => makeChild({ status: 7 }));
		const client = mockClient({ get: vi.fn() });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--skip-wait"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 7"));
		expect(spy).toHaveBeenCalledWith(7);
		// Exited on the failed run before any builds API call.
		expect(client.get).not.toHaveBeenCalled();
		restore();
	});

	it("fails closed before launch when the pre-run snapshot cannot be read", async () => {
		const { restore } = expectExit();
		const client = mockClient({ get: vi.fn().mockRejectedValueOnce(new Error("503 from API")) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(runProfileTest(["--command", "game", "--build-id", "cand"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("Could not read the build's pre-run event count"),
		);
		// Aborted before launching the game.
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("fails closed with a rate-limit message when the pre-run 429 exceeds the retry cap", async () => {
		const { restore } = expectExit();
		// Retry-After of 200s is beyond the 120s cap: fail fast, do not retry.
		const err = new ApiError("rate limited", 429, new Headers(), { retry_after: 200 });
		const client = mockClient({ get: vi.fn().mockRejectedValueOnce(err) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(runProfileTest(["--command", "game", "--build-id", "cand"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("hourly rate limit"));
		// Fail closed: never launched the game.
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("fails closed without retrying on a non-retryable 429 (limiter failed closed)", async () => {
		const { restore } = expectExit();
		// Fail-closed limiter: 429 with no retry_after / retryable=false.
		const err = new ApiError("rate limited", 429, new Headers());
		const get = vi.fn().mockRejectedValue(err);
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(runProfileTest(["--command", "game", "--build-id", "cand"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("temporarily unavailable"),
		);
		// Not retried: exactly one snapshot fetch, and the game never launched.
		expect(get).toHaveBeenCalledTimes(1);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("reports a malformed 429 Retry-After as a fail-closed limiter, not a cap breach", async () => {
		const { restore } = expectExit();
		// A negative retry_after is invalid: the call site must NOT report it as a
		// rate-limit window (that is the isValidRetryAfter gap Gemini flagged).
		const err = new ApiError("rate limited", 429, new Headers(), { retry_after: -5 });
		const get = vi.fn().mockRejectedValue(err);
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(runProfileTest(["--command", "game", "--build-id", "cand"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("temporarily unavailable"),
		);
		expect(loggerModule.error).not.toHaveBeenCalledWith(
			expect.stringContaining("hourly rate limit"),
		);
		// Not retried, and the game never launched.
		expect(get).toHaveBeenCalledTimes(1);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("retries the pre-run snapshot on a 429 with Retry-After, then proceeds", async () => {
		vi.useFakeTimers();
		const err = new ApiError("rate limited", 429, new Headers(), { retry_after: 1 });
		const get = vi
			.fn()
			.mockRejectedValueOnce(err) // pre-run snapshot: rate limited
			.mockResolvedValueOnce([]) // pre-run snapshot retry: count 0
			.mockResolvedValueOnce(ingested); // ingest poll: grown
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		const run = runProfileTest(["--command", "game", "--build-id", "cand"]).catch(
			(e: unknown) => e,
		);
		// Fire the 1s Retry-After backoff, then drain the launch + ingest poll.
		await vi.advanceTimersByTimeAsync(1000);
		await vi.runAllTimersAsync();
		const outcome = await run;

		expect(outcome).toBeUndefined();
		expect(loggerModule.warn).toHaveBeenCalledWith(
			expect.stringContaining("Rate limited (429) reading the pre-run event count"),
		);
		expect(loggerModule.success).toHaveBeenCalledWith(
			expect.stringContaining("Profiling run complete"),
		);
		expect(loggerModule.error).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("surfaces an ingest poll failure while continuing to a successful ingest", async () => {
		vi.useFakeTimers();
		const get = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error("503 from ingest"))
			.mockResolvedValueOnce(ingested);
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		const run = runProfileTest(["--command", "game", "--build-id", "cand"]).catch(
			(e: unknown) => e,
		);
		await vi.runAllTimersAsync();
		const outcome = await run;

		expect(outcome).toBeUndefined();
		expect(loggerModule.warn).toHaveBeenCalledWith(
			expect.stringContaining("Ingest poll attempt 1 failed"),
		);
		expect(loggerModule.success).toHaveBeenCalledWith(expect.stringContaining("ingested"));
		vi.useRealTimers();
	});

	it("fails closed when the pre-run snapshot is not an array", async () => {
		const { restore } = expectExit();
		// A non-error response that is not a build array (malformed 200).
		const client = mockClient({ get: vi.fn().mockResolvedValueOnce({ error: "nope" }) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest(["--command", "game", "--api-key", "k", "--build-id", "cand"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("unexpected response"));
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("clears stale FRAMEDASH session vars the run does not set", async () => {
		vi.mocked(execFileSync).mockReturnValue(""); // git yields nothing -> no branch/commit
		process.env.FRAMEDASH_GIT_BRANCH = "stale-branch";
		const client = mockClient({ get: vi.fn() });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		// Only --build-id set; no --branch/--commit/--scenario and git is empty.
		await runProfileTest([
			"--command",
			"game",
			"--api-key",
			"k",
			"--build-id",
			"cand",
			"--skip-wait",
		]);

		const opts = vi.mocked(spawn).mock.calls[0]?.[1] as unknown as
			| { env?: NodeJS.ProcessEnv }
			| undefined;
		expect(opts?.env?.FRAMEDASH_BUILD_ID).toBe("cand");
		// The stale branch from the environment must not leak to the game.
		expect(opts?.env?.FRAMEDASH_GIT_BRANCH).toBeUndefined();
	});

	it("strips an env-derived gate key from the launched game's environment", async () => {
		const client = mockClient({ get: vi.fn() });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);
		// Gate key comes from the environment (no --api-key flag).
		process.env.FRAMEDASH_API_KEY = "env_read_key";

		await runProfileTest(["--command", "game", "--build-id", "cand", "--skip-wait"]);

		const opts = vi.mocked(spawn).mock.calls[0]?.[1] as unknown as
			| { env?: NodeJS.ProcessEnv }
			| undefined;
		expect(opts?.env?.FRAMEDASH_API_KEY).toBeUndefined();
		expect(loggerModule.warn).toHaveBeenCalledWith(
			expect.stringContaining("Removed the gate's FRAMEDASH_API_KEY"),
		);
	});

	it("skips the ingest wait with --skip-wait and exits 0 with no baseline", async () => {
		const client = mockClient({ get: vi.fn() });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await runProfileTest(["--command", "game", "--build-id", "cand", "--skip-wait"]);

		expect(client.get).not.toHaveBeenCalled();
		expect(loggerModule.success).toHaveBeenCalledWith(
			expect.stringContaining("Profiling run complete"),
		);
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("runs the perf-diff gate and exits 1 on a regression", async () => {
		const { restore } = expectExit();
		const get = vi
			.fn()
			.mockResolvedValueOnce([]) // pre-run count
			.mockResolvedValueOnce(ingested) // ingest poll
			.mockResolvedValueOnce(comparison([diff("frame_time", 8)])); // compare
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest([
				"--command",
				"game",
				"--build-id",
				"cand",
				"--baseline",
				"base",
				"--fail-on-regression",
			]),
		).rejects.toThrow("process.exit");
		expect(get).toHaveBeenNthCalledWith(3, expect.stringContaining("builds/compare?baseline=base"));
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("Performance regression detected"),
		);
		restore();
	});

	it("warns but exits 0 on a regression without --fail-on-regression", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce([]) // pre-run count
			.mockResolvedValueOnce(ingested) // ingest poll
			.mockResolvedValueOnce(comparison([diff("frame_time", 8)])); // compare
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await runProfileTest(["--command", "game", "--build-id", "cand", "--baseline", "base"]);

		expect(loggerModule.warn).toHaveBeenCalledWith(expect.stringContaining("Regression detected"));
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("warns (exit 0) in report-only mode when nothing is comparable", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce([]) // pre-run count
			.mockResolvedValueOnce(ingested) // ingest poll
			.mockResolvedValueOnce(comparison([diff("gpu_time", null)])); // no comparable data
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await runProfileTest(["--command", "game", "--build-id", "cand", "--baseline", "base"]);

		expect(loggerModule.warn).toHaveBeenCalledWith(expect.stringContaining("evaluated nothing"));
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("passes the gate when the regression is within the threshold", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce([]) // pre-run count
			.mockResolvedValueOnce(ingested) // ingest poll
			.mockResolvedValueOnce(comparison([diff("frame_time", 3)])); // compare
		const client = mockClient({ get });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await runProfileTest([
			"--command",
			"game",
			"--build-id",
			"cand",
			"--baseline",
			"base",
			"--threshold",
			"5",
			"--fail-on-regression",
		]);

		expect(loggerModule.success).toHaveBeenCalledWith(
			expect.stringContaining("No performance regression"),
		);
	});

	it("rejects an invalid --ingest-timeout before launching", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--ingest-timeout", "0"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("--ingest-timeout must be a positive number"),
		);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("rejects a negative --command-timeout before launching (0 is allowed)", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		// Use the `=` form: bare `--command-timeout -1` is parsed by parseArgs as an
		// ambiguous option (same as the --limit note in e2e-cli-testing.md).
		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--command-timeout=-1"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("--command-timeout must be a non-negative number"),
		);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});

	it("kills the process tree and fails closed WITHOUT gating on --command-timeout", async () => {
		vi.useFakeTimers();
		const { restore, spy } = expectExit();
		// Spy the POSIX group-kill path; the win32 path shells out via spawnSync.
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		// The game never exits on its own; the test drives its (post-kill) exit.
		const child = makeChild({ hang: true, pid: 4321 });
		vi.mocked(spawn).mockReturnValue(child);
		// With --baseline set, a CLEAN run would call the compare API. --skip-wait
		// removes the pre-run snapshot read, so ANY client.get would be the gate
		// compare -- asserting it is never called proves the timeout aborted BEFORE
		// gating (fail-closed), not merely that a no-baseline run does no compare.
		const client = mockClient({ get: vi.fn() });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		const run = runProfileTest([
			"--command",
			"game",
			"--build-id",
			"cand",
			"--baseline",
			"base",
			"--skip-wait",
			"--command-timeout",
			"1",
		]).catch((err: unknown) => err);

		// Fire the 1s command-timeout; the handler kills the tree.
		await vi.advanceTimersByTimeAsync(1000);
		// The killed process then reports its exit (SIGKILL), resolving the runner.
		child.emit("exit", null, "SIGKILL");
		const outcome = await run;

		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe("process.exit");
		expect(spy).toHaveBeenCalledWith(1);
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("exceeded the --command-timeout"),
		);
		// The whole tree was killed via the platform-specific strategy.
		if (process.platform === "win32") {
			expect(spawnSync).toHaveBeenCalledWith(
				"taskkill",
				["/pid", "4321", "/t", "/f"],
				expect.anything(),
			);
		} else {
			expect(killSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
		}
		// Fail closed: aborted before the perf-diff compare (the gate API is untouched).
		expect(client.get).not.toHaveBeenCalled();
		killSpy.mockRestore();
		vi.useRealTimers();
		restore();
	});

	it("rejects a blank --command-timeout instead of silently disabling the bound", async () => {
		const { restore } = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		// Number("") === 0 would otherwise disable the bound under allowZero.
		await expect(
			runProfileTest(["--command", "game", "--build-id", "cand", "--command-timeout="]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("--command-timeout must be a non-negative number"),
		);
		expect(spawn).not.toHaveBeenCalled();
		restore();
	});
});
