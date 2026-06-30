import type { ApiClient } from "@framedash/api-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builds } from "../commands/builds.js";
import { perfDiff } from "../commands/perf-diff.js";
import type { ApiBuildComparison, ApiMetricDiff } from "../lib/perf-diff-eval.js";

vi.mock("../lib/logger.js", () => ({
	log: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
}));

vi.mock("../lib/create-client.js", () => ({
	createClient: vi.fn(),
}));

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

function expectExit(): () => void {
	const spy = vi.spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as never);
	return () => spy.mockRestore();
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FRAMEDASH_API_KEY = "fd_test_key";
	process.env.FRAMEDASH_PROJECT_ID = "test-project";
	delete process.env.FRAMEDASH_BASE_URL;
	delete process.env.FRAMEDASH_FORMAT;
});

describe("builds command", () => {
	it("calls GET builds with the days param", async () => {
		const data = [{ build_id: "v1", event_count: 10 }];
		const client = mockClient({ get: vi.fn().mockResolvedValue(data) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await builds(["--days", "7"]);

		expect(client.get).toHaveBeenCalledWith(
			expect.stringContaining("/api/v1/projects/test-project/builds?days=7"),
		);
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
	});
});

describe("perf-diff command", () => {
	it("exits with error when baseline/candidate are missing", async () => {
		const restore = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(perfDiff(["--baseline", "base"])).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("are required"));
		restore();
	});

	it("exits with error when baseline equals candidate", async () => {
		const restore = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(perfDiff(["--baseline", "same", "--candidate", "same"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("must be different"));
		restore();
	});

	it("trims baseline/candidate before the equality check", async () => {
		const restore = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(perfDiff(["--baseline", "sha ", "--candidate", "sha"])).rejects.toThrow(
			"process.exit",
		);
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("must be different"));
		restore();
	});

	it("trims a valid --metric with surrounding whitespace", async () => {
		const client = mockClient({
			get: vi.fn().mockResolvedValue(comparison([diff("frame_time", 2)])),
		});
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await perfDiff(["--baseline", "a", "--candidate", "b", "--metric", " frame_time "]);
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("exits with error on an invalid --metric", async () => {
		const restore = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			perfDiff(["--baseline", "a", "--candidate", "b", "--metric", "fps"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("Invalid --metric"));
		restore();
	});

	it("fetches the comparison and prints it (no gate by default, exits 0)", async () => {
		const cmp = comparison([diff("frame_time", 2)]);
		const client = mockClient({ get: vi.fn().mockResolvedValue(cmp) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await perfDiff(["--baseline", "a", "--candidate", "b", "--days", "30", "--map", "lobby"]);

		expect(client.get).toHaveBeenCalledWith(
			expect.stringContaining("builds/compare?baseline=a&candidate=b&days=30&mapId=lobby"),
		);
		expect(loggerModule.log).toHaveBeenCalledWith(JSON.stringify(cmp, null, 2));
		// No --fail-on-regression -> no verdict, no error
		expect(loggerModule.error).not.toHaveBeenCalled();
	});

	it("exits 1 on a regression when --fail-on-regression is set", async () => {
		const restore = expectExit();
		const client = mockClient({
			get: vi.fn().mockResolvedValue(comparison([diff("frame_time", 8)])),
		});
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			perfDiff(["--baseline", "a", "--candidate", "b", "--fail-on-regression"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(
			expect.stringContaining("Performance regression detected"),
		);
		restore();
	});

	it("passes (success, no exit) when the regression is within the threshold", async () => {
		const client = mockClient({
			get: vi.fn().mockResolvedValue(comparison([diff("frame_time", 3)])),
		});
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await perfDiff([
			"--baseline",
			"a",
			"--candidate",
			"b",
			"--threshold",
			"5",
			"--fail-on-regression",
		]);

		expect(loggerModule.success).toHaveBeenCalledWith(
			expect.stringContaining("No performance regression"),
		);
	});

	it("fails closed (exit 1) on a malformed API response (no diffs array)", async () => {
		const restore = expectExit();
		const client = mockClient({ get: vi.fn().mockResolvedValue({ baseline: {}, candidate: {} }) });
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			perfDiff(["--baseline", "a", "--candidate", "b", "--fail-on-regression"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("Unexpected response"));
		restore();
	});

	it("fails closed (exit 1) when nothing is comparable", async () => {
		const restore = expectExit();
		const client = mockClient({
			get: vi.fn().mockResolvedValue(comparison([diff("gpu_time", null)])),
		});
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		await expect(
			perfDiff(["--baseline", "a", "--candidate", "b", "--fail-on-regression"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("cannot evaluate"));
		restore();
	});

	it("rejects a negative --threshold", async () => {
		const restore = expectExit();
		const client = mockClient();
		vi.mocked(createClientModule.createClient).mockReturnValue(client);

		// `--threshold=-1` (vs `--threshold -1`, which node's parseArgs rejects as an
		// ambiguous option argument) reaches the command's own non-negative check.
		await expect(
			perfDiff(["--baseline", "a", "--candidate", "b", "--threshold=-1"]),
		).rejects.toThrow("process.exit");
		expect(loggerModule.error).toHaveBeenCalledWith(expect.stringContaining("--threshold"));
		restore();
	});
});
