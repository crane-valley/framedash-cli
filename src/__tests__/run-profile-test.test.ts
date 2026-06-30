import type { SpawnSyncReturns } from "node:child_process";
import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProfileTest } from "../commands/run-profile-test.js";
import type { ApiBuildComparison, ApiMetricDiff } from "../lib/perf-diff-eval.js";
import type { BuildListEntry } from "../lib/run-profile-test-lib.js";

vi.mock("node:child_process", () => ({
	// git rev-parse -> a stable fake SHA/branch; spawnSync -> exit 0 by default.
	execFileSync: vi.fn(() => "gitsha\n"),
	spawnSync: vi.fn(
		() => ({ status: 0, signal: null, error: undefined }) as SpawnSyncReturns<string>,
	),
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

import { execFileSync, spawnSync } from "node:child_process";
import * as createClientModule from "../lib/create-client.js";
import * as loggerModule from "../lib/logger.js";

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
	vi.mocked(spawnSync).mockReturnValue({
		status: 0,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<string>);
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
		expect(spawnSync).not.toHaveBeenCalled();
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
		expect(spawnSync).not.toHaveBeenCalled();
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
		expect(spawnSync).not.toHaveBeenCalled();
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

		expect(spawnSync).toHaveBeenCalledWith(
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
		vi.mocked(spawnSync).mockReturnValue({
			status: 7,
			signal: null,
			error: undefined,
		} as SpawnSyncReturns<string>);
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
		expect(spawnSync).not.toHaveBeenCalled();
		restore();
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
		expect(spawnSync).not.toHaveBeenCalled();
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

		const opts = vi.mocked(spawnSync).mock.calls[0]?.[1] as unknown as
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

		const opts = vi.mocked(spawnSync).mock.calls[0]?.[1] as unknown as
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
		expect(spawnSync).not.toHaveBeenCalled();
		restore();
	});
});
