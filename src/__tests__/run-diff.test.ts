import type { ApiClient } from "@framedash/api-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDiff } from "../commands/run-diff.js";
import { createClient } from "../lib/create-client.js";
import { log } from "../lib/logger.js";

vi.mock("../lib/create-client.js", () => ({ createClient: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ log: vi.fn(), error: vi.fn() }));
const BASE = "a1111111-1111-4111-8111-111111111111";
const CANDIDATE = "b2222222-2222-4222-8222-222222222222";
const get = vi.fn();
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
		reasons: ["baseline_not_complete"],
		baseline: { runId: BASE },
		candidate: { runId: CANDIDATE },
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
	const data = {
		status: "comparable",
		reasons: [],
		baseline: { runId: BASE },
		candidate: { runId: CANDIDATE },
		repeat: { runId: repeatId },
		quantiles: Object.fromEntries(
			["p50", "p95", "p99"].map((q) => [
				q,
				{ baseline: [16, 17], candidate: [32, 34], deltaMs: [15, 18] },
			]),
		),
	};
	get.mockResolvedValue(data);
	await runDiff(["--baseline", BASE, "--candidate", CANDIDATE, "--repeat", repeatId]);
	expect(get).toHaveBeenCalledWith(expect.stringContaining(`&repeat=${repeatId}`));
	expect(process.exitCode).not.toBe(2);
	expect(log).toHaveBeenCalledWith(expect.stringContaining('"status": "comparable"'));
});
