import { describe, expect, it } from "vitest";
import {
	type BuildListEntry,
	buildEventCount,
	buildSessionEnv,
	ENV_BUILD_ID,
	ENV_GIT_BRANCH,
	ENV_GIT_COMMIT,
	ENV_TEST_SCENARIO,
	hasIngestedBuild,
	resolveProfileIdentity,
	waitForIngest,
} from "./run-profile-test-lib.js";

describe("resolveProfileIdentity", () => {
	it("prefers explicit flags over git fallbacks", () => {
		const id = resolveProfileIdentity(
			{ buildId: "b1", branch: "feat", commit: "sha-flag", scenario: "smoke" },
			{ branch: "git-branch", commit: "git-sha" },
		);
		expect(id).toEqual({ buildId: "b1", branch: "feat", commit: "sha-flag", scenario: "smoke" });
	});

	it("defaults the build id to the resolved commit", () => {
		const id = resolveProfileIdentity({ commit: "sha-flag" }, { commit: "git-sha" });
		expect(id?.buildId).toBe("sha-flag");
		expect(id?.commit).toBe("sha-flag");
	});

	it("falls back to git branch and commit when flags are unset", () => {
		const id = resolveProfileIdentity({}, { branch: "main", commit: "git-sha" });
		expect(id).toEqual({
			buildId: "git-sha",
			branch: "main",
			commit: "git-sha",
			scenario: undefined,
		});
	});

	it("trims surrounding whitespace and treats blank as unset", () => {
		const id = resolveProfileIdentity(
			{ buildId: "  b1  ", branch: "   ", scenario: "" },
			{ branch: "git-branch" },
		);
		expect(id?.buildId).toBe("b1");
		// Blank --branch falls through to the git fallback.
		expect(id?.branch).toBe("git-branch");
		expect(id?.scenario).toBeUndefined();
	});

	it("returns null when no build id can be determined", () => {
		expect(resolveProfileIdentity({}, {})).toBeNull();
		expect(resolveProfileIdentity({ buildId: "   " }, { commit: "  " })).toBeNull();
	});
});

describe("buildSessionEnv", () => {
	it("includes only the non-empty FRAMEDASH_* variables", () => {
		const env = buildSessionEnv({
			buildId: "b1",
			branch: "feat",
			commit: "sha",
			scenario: "smoke",
		});
		expect(env).toEqual({
			[ENV_BUILD_ID]: "b1",
			[ENV_GIT_BRANCH]: "feat",
			[ENV_GIT_COMMIT]: "sha",
			[ENV_TEST_SCENARIO]: "smoke",
		});
	});

	it("omits branch/commit/scenario when they are unset", () => {
		const env = buildSessionEnv({ buildId: "b1" });
		expect(env).toEqual({ [ENV_BUILD_ID]: "b1" });
		expect(env).not.toHaveProperty(ENV_GIT_BRANCH);
		expect(env).not.toHaveProperty(ENV_TEST_SCENARIO);
	});
});

describe("buildEventCount", () => {
	const builds: BuildListEntry[] = [
		{ build_id: "old", event_count: 100 },
		{ build_id: "cand", event_count: 3 },
	];

	it("returns the candidate's event count", () => {
		expect(buildEventCount(builds, "cand")).toBe(3);
	});

	it("returns 0 when the build is absent", () => {
		expect(buildEventCount(builds, "missing")).toBe(0);
	});

	it("returns 0 for a row with no event_count or a non-array response", () => {
		expect(buildEventCount([{ build_id: "cand" }], "cand")).toBe(0);
		expect(buildEventCount(null, "cand")).toBe(0);
		expect(buildEventCount(undefined, "cand")).toBe(0);
	});

	it("normalizes a JSON-quoted UInt64 string to a number", () => {
		// ClickHouse count() serializes as a quoted string by default.
		expect(buildEventCount([{ build_id: "cand", event_count: "10" }], "cand")).toBe(10);
		// And the comparison must be numeric, not lexicographic ("10" > "9").
		expect(hasIngestedBuild([{ build_id: "cand", event_count: "10" }], "cand", 9)).toBe(true);
		expect(hasIngestedBuild([{ build_id: "cand", event_count: "9" }], "cand", 9)).toBe(false);
	});
});

describe("hasIngestedBuild", () => {
	const builds: BuildListEntry[] = [
		{ build_id: "old", event_count: 100 },
		{ build_id: "cand", event_count: 3 },
	];

	it("is true when the candidate is present with events (default threshold 0)", () => {
		expect(hasIngestedBuild(builds, "cand")).toBe(true);
	});

	it("is false when the candidate is absent", () => {
		expect(hasIngestedBuild(builds, "missing")).toBe(false);
	});

	it("is false for a present-but-empty build row", () => {
		expect(hasIngestedBuild([{ build_id: "cand", event_count: 0 }], "cand")).toBe(false);
	});

	it("is false for a row with no event_count", () => {
		expect(hasIngestedBuild([{ build_id: "cand" }], "cand")).toBe(false);
	});

	it("is false for a non-array response", () => {
		expect(hasIngestedBuild(null, "cand")).toBe(false);
		expect(hasIngestedBuild(undefined, "cand")).toBe(false);
	});

	it("requires the count to EXCEED a non-zero prior threshold", () => {
		// Same count as before the run -> not yet fresh.
		expect(hasIngestedBuild(builds, "cand", 3)).toBe(false);
		// Grew past the prior count -> fresh events landed.
		expect(hasIngestedBuild([{ build_id: "cand", event_count: 4 }], "cand", 3)).toBe(true);
	});
});

describe("waitForIngest", () => {
	/** A fake clock advanced only by sleep(), so the loop runs with no real timers. */
	function fakeClock() {
		let t = 0;
		return {
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
			},
		};
	}

	it("returns true once the build appears on a later poll", async () => {
		const clock = fakeClock();
		const present: BuildListEntry[] = [{ build_id: "cand", event_count: 1 }];
		const pages: BuildListEntry[][] = [[], [], present];
		let i = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => pages[Math.min(i++, pages.length - 1)] ?? present,
			buildId: "cand",
			timeoutMs: 1000,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(ok).toBe(true);
		expect(i).toBe(3);
	});

	it("waits for the count to exceed minEventCount (ignores the prior run's data)", async () => {
		const clock = fakeClock();
		// Prior run left 5 events; the wait must not be satisfied until it grows.
		const pages: BuildListEntry[][] = [
			[{ build_id: "cand", event_count: 5 }],
			[{ build_id: "cand", event_count: 5 }],
			[{ build_id: "cand", event_count: 9 }],
		];
		let i = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => pages[Math.min(i++, pages.length - 1)] ?? [],
			buildId: "cand",
			minEventCount: 5,
			timeoutMs: 1000,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(ok).toBe(true);
		expect(i).toBe(3);
	});

	it("returns false on timeout without ever finding the build", async () => {
		const clock = fakeClock();
		let calls = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => {
				calls++;
				return [];
			},
			buildId: "cand",
			timeoutMs: 30,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(ok).toBe(false);
		// Polls at 0/10/20/30ms, then the deadline check fails -> 4 attempts.
		expect(calls).toBe(4);
	});

	it("polls at least once even with a zero timeout", async () => {
		const clock = fakeClock();
		let calls = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => {
				calls++;
				return [{ build_id: "cand", event_count: 2 }];
			},
			buildId: "cand",
			timeoutMs: 0,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(ok).toBe(true);
		expect(calls).toBe(1);
	});

	it("keeps polling through a transient fetch error", async () => {
		const clock = fakeClock();
		let calls = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => {
				calls++;
				if (calls === 1) throw new Error("503 from ingest");
				return [{ build_id: "cand", event_count: 1 }];
			},
			buildId: "cand",
			timeoutMs: 1000,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(ok).toBe(true);
		expect(calls).toBe(2);
	});
});
