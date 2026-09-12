import { type ApiClient, comparePerformanceRuns, type PerformanceRun } from "@framedash/api-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDiff } from "../commands/run-diff.js";
import { createClient } from "../lib/create-client.js";
import { log } from "../lib/logger.js";

vi.mock("../lib/create-client.js", () => ({ createClient: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ log: vi.fn(), error: vi.fn() }));
const BASE = "a1111111-1111-4111-8111-111111111111";
const CANDIDATE = "b2222222-2222-4222-8222-222222222222";
const get = vi.fn();
function completeRun(runId: string) {
	return {
		runId,
		status: "complete",
		reasons: [],
		metadata: {
			buildId: "build-a",
			commit: "abc",
			branch: "main",
			scenario: "route-a",
			hardware: "pc-a",
			graphics: "high",
			resolution: "1920x1080",
			configuration: "release",
			platform: "WindowsPlayer",
			engineVersion: "6000.4",
			method: "unity-update-stopwatch-v1",
			sdkVersion: "0.1.8",
			warmupFrames: 0,
			targetFrames: 1000,
		},
		startedAtUs: "1000000",
		endedAtUs: "18000000",
		samples: 1000,
		droppedSamples: 0,
		warmupSamples: 0,
		durationMs: 16000,
		quantiles: { p50: [16, 17], p95: [16, 17], p99: [16, 17] },
		hitches: [1000 / 60, 1000 / 30, 50, 100].map((thresholdMs) => ({
			thresholdMs,
			count: 0,
			per1000Frames: 0,
		})),
	} satisfies PerformanceRun;
}
function comparable(repeatId?: string) {
	const result = comparePerformanceRuns(
		completeRun(BASE),
		completeRun(CANDIDATE),
		repeatId ? completeRun(repeatId) : undefined,
	);
	if (!result.quantiles) throw new Error("Comparable fixture has no quantiles");
	return { ...result, quantiles: result.quantiles, windowDays: 7 };
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FRAMEDASH_API_KEY", "fd_test_key");
	vi.stubEnv("FRAMEDASH_PROJECT_ID", "test-project");
	vi.stubEnv("FRAMEDASH_FORMAT", "json");
	vi.mocked(createClient).mockReturnValue({
		get,
		projectPath: (path: string) => `/project/${path}`,
	} as unknown as ApiClient);
});
afterEach(() => {
	vi.unstubAllEnvs();
	process.exitCode = 0;
});

it("prints inconclusive evidence and returns a distinct non-success exit code", async () => {
	get.mockResolvedValue({
		status: "inconclusive",
		reasons: ["baseline_not_complete", "candidate_not_complete"],
		baseline: { runId: BASE, status: "missing", reasons: ["no_records_in_window"] },
		candidate: { runId: CANDIDATE, status: "missing", reasons: ["no_records_in_window"] },
		windowDays: 7,
	});
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE]);
	expect(get).toHaveBeenCalledWith(
		`/project/performance-runs/compare?baseline=${BASE}&candidate=${CANDIDATE}`,
	);
	expect(log).toHaveBeenCalledWith(expect.stringContaining("baseline_not_complete"));
	expect(process.exitCode).toBe(2);
});
it("rejects reused IDs before querying and rejects malformed successful responses", async () => {
	await expect(runDiff(["--baseline", BASE, "--candidate", BASE])).rejects.toThrow("distinct");
	expect(get).not.toHaveBeenCalled();
	get.mockResolvedValue({ status: "comparable" });
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});
it("forwards an unchanged repeat and never claims a regression verdict", async () => {
	const repeatId = "c3333333-3333-4333-8333-333333333333";
	const data = comparable(repeatId);
	get.mockResolvedValue(data);
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE, "--repeat", repeatId]);
	expect(get).toHaveBeenCalledWith(expect.stringContaining(`&repeat=${repeatId}`));
	expect(process.exitCode).not.toBe(2);
	expect(log).toHaveBeenCalledWith(expect.stringContaining('"status": "comparable"'));
});

it.each([
	"metadata",
	"samples",
	"droppedSamples",
	"warmupSamples",
	"durationMs",
	"hitches",
	"startedAtUs",
	"endedAtUs",
	"quantiles",
] as const)("rejects a complete run missing %s", async (field) => {
	const data = comparable();
	delete data.baseline[field];
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
	expect(log).not.toHaveBeenCalled();
});

it("rejects contradictory completion, conditions and hitch evidence", async () => {
	const variants = [comparable(), comparable(), comparable(), comparable(), comparable()] as const;
	variants[0].baseline.droppedSamples = 1;
	variants[1].candidate.metadata = { ...completeRun(CANDIDATE).metadata, hardware: "different-pc" };
	variants[2].baseline.hitches = [
		{ thresholdMs: 1000 / 60, count: 1001, per1000Frames: 1001 },
		...completeRun(BASE).hitches.slice(1),
	];
	variants[3].baseline.status = "incomplete";
	variants[4].baseline.endedAtUs = "999999";
	for (const data of variants) {
		get.mockResolvedValue(data);
		await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow(
			"response",
		);
	}
});

it("rejects missing repeat variation and deltas that disagree with run evidence", async () => {
	const repeatId = "c3333333-3333-4333-8333-333333333333";
	const data = comparable(repeatId);
	delete data.repeatVariation;
	get.mockResolvedValue(data);
	await expect(
		runDiff(["--baseline", BASE, "--candidate", CANDIDATE, "--repeat", repeatId]),
	).rejects.toThrow("response");
	const wrongDelta = comparable();
	wrongDelta.quantiles.p99.deltaMs = [50, 60];
	get.mockResolvedValue(wrongDelta);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it.each([
	"table",
	"csv",
])("formats only supported quantiles in %s while allowing additive API fields", async (format) => {
	const data = comparable();
	Object.assign(data.quantiles, { futureMetadata: null });
	get.mockResolvedValue(data);
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE, "--format", format]);
	expect(log).toHaveBeenCalledWith(expect.stringContaining("p99"));
	expect(log).not.toHaveBeenCalledWith(expect.stringContaining("futureMetadata"));
});

it("rejects reversed quantiles even when comparison intervals match them", async () => {
	const baseline = completeRun(BASE);
	baseline.quantiles.p50 = [30, 31];
	get.mockResolvedValue({
		...comparePerformanceRuns(baseline, completeRun(CANDIDATE)),
		windowDays: 7,
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("rejects increasing hitch counts and accepts decreasing counts", async () => {
	const data = comparable();
	data.baseline.hitches = completeRun(BASE).hitches.map((hitch, i) => ({
		...hitch,
		count: i === 3 ? 1 : 0,
		per1000Frames: i === 3 ? 1 : 0,
	}));
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
	data.baseline.hitches = completeRun(BASE).hitches.map((hitch, i) => ({
		...hitch,
		count: i === 0 ? 100 : 0,
		per1000Frames: i === 0 ? 100 : 0,
	}));
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE]);
	expect(log).toHaveBeenCalled();
});

it("rejects an inconclusive status contradicting complete matching runs", async () => {
	const data = comparable();
	const { quantiles: _quantiles, ...inconclusive } = data;
	get.mockResolvedValue({
		...inconclusive,
		status: "inconclusive",
		reasons: ["baseline_not_complete"],
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("rejects a measured duration longer than the run wall time", async () => {
	const data = comparable();
	data.baseline.durationMs = 18000;
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it.each([
	1, 8000, 1000000,
])("rejects duration %d inconsistent with quantile evidence", async (durationMs) => {
	const data = comparable();
	data.baseline.durationMs = durationMs;
	data.baseline.endedAtUs = "2000000000";
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("rejects hitch counts above the quantile rank limit", async () => {
	const data = comparable();
	data.baseline.hitches = completeRun(BASE).hitches.map((hitch) => ({
		...hitch,
		count: 1000,
		per1000Frames: 1000,
	}));
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("rejects hitch counts below the quantile rank limit", async () => {
	const baseline = completeRun(BASE);
	baseline.quantiles.p99 = [100, 104];
	baseline.durationMs = 17000;
	baseline.endedAtUs = "19000000";
	get.mockResolvedValue({
		...comparePerformanceRuns(baseline, completeRun(CANDIDATE)),
		windowDays: 7,
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it.each([
	{ reasons: ["unrelated_failure"] },
	{ reasons: ["baseline_not_complete"] },
	{ reasons: ["baseline_not_complete", "baseline_not_complete"] },
])("rejects inconclusive reasons inconsistent with run evidence: $reasons", async ({ reasons }) => {
	get.mockResolvedValue({
		status: "inconclusive",
		reasons,
		baseline: { runId: BASE, status: "missing", reasons: ["no_records_in_window"] },
		candidate: { runId: CANDIDATE, status: "missing", reasons: ["no_records_in_window"] },
		windowDays: 7,
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("accepts additional server reasons while retaining every locally required reason", async () => {
	get.mockResolvedValue({
		status: "inconclusive",
		reasons: ["future_server_reason", "candidate_not_complete", "baseline_not_complete"],
		baseline: { runId: BASE, status: "missing", reasons: ["no_records_in_window"] },
		candidate: { runId: CANDIDATE, status: "missing", reasons: ["no_records_in_window"] },
		windowDays: 7,
	});
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE]);
	expect(process.exitCode).toBe(2);
	expect(log).toHaveBeenCalledWith(expect.stringContaining("future_server_reason"));
});

it("rejects a duration above the total permitted by zero hitches", async () => {
	const data = comparable();
	data.baseline.durationMs = 20000;
	data.baseline.endedAtUs = "30000000";
	get.mockResolvedValue(data);
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});

it("intersects hitch and quantile constraints on the same frame population", async () => {
	const baseline = completeRun(BASE);
	baseline.quantiles.p95 = [100, 104];
	baseline.quantiles.p99 = [100, 104];
	baseline.durationMs = 13000;
	baseline.endedAtUs = "30000000";
	baseline.hitches = baseline.hitches.map((hitch, i) => ({
		...hitch,
		count: i < 3 ? 100 : 0,
		per1000Frames: i < 3 ? 100 : 0,
	}));
	get.mockResolvedValue({
		...comparePerformanceRuns(baseline, completeRun(CANDIDATE)),
		windowDays: 7,
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
	baseline.durationMs = 900 * 16 + 100 * 100;
	get.mockResolvedValue({
		...comparePerformanceRuns(baseline, completeRun(CANDIDATE)),
		windowDays: 7,
	});
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE]);
	expect(log).toHaveBeenCalled();
});

it("rejects a quantile spanning multiple histogram bins despite feasible frame totals", async () => {
	const baseline = completeRun(BASE);
	baseline.quantiles = { p50: [16, 18], p95: [16, 18], p99: [16, 18] };
	baseline.durationMs = 16100;
	baseline.hitches = baseline.hitches.map((hitch, i) => ({
		...hitch,
		count: i === 0 ? 100 : 0,
		per1000Frames: i === 0 ? 100 : 0,
	}));
	get.mockResolvedValue({
		...comparePerformanceRuns(baseline, completeRun(CANDIDATE)),
		windowDays: 7,
	});
	await expect(runDiff(["--baseline", BASE, "--candidate", CANDIDATE])).rejects.toThrow("response");
});
