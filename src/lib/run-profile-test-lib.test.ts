import { ApiError } from "@framedash/api-client";
import { describe, expect, it, vi } from "vitest";
import {
	type BuildListEntry,
	buildEventCount,
	buildSessionEnv,
	ENV_BUILD_ID,
	ENV_GIT_BRANCH,
	ENV_GIT_COMMIT,
	ENV_TEST_SCENARIO,
	hasIngestedBuild,
	isValidRetryAfter,
	planTreeKill,
	resolveProfileIdentity,
	validateSeconds,
	waitForIngest,
	withRateLimitRetry,
} from "./run-profile-test-lib.js";

describe("isValidRetryAfter", () => {
	it("accepts a finite non-negative number of seconds", () => {
		expect(isValidRetryAfter(0)).toBe(true);
		expect(isValidRetryAfter(30)).toBe(true);
	});

	it("rejects undefined, negative, and non-finite values", () => {
		expect(isValidRetryAfter(undefined)).toBe(false);
		expect(isValidRetryAfter(-1)).toBe(false);
		expect(isValidRetryAfter(Number.NaN)).toBe(false);
		expect(isValidRetryAfter(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

function rateLimited(retryAfterSeconds?: number): ApiError {
	return new ApiError(
		"rate limited",
		429,
		new Headers(),
		retryAfterSeconds !== undefined ? { retry_after: retryAfterSeconds } : undefined,
	);
}

describe("withRateLimitRetry", () => {
	it("retries a 429 honoring Retry-After, then returns the value", async () => {
		const waits: number[] = [];
		const sleep = vi.fn((ms: number) => {
			waits.push(ms);
			return Promise.resolve();
		});
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			calls++;
			if (calls < 3) throw rateLimited(2);
			return "ok";
		});
		const onRetry = vi.fn();

		const result = await withRateLimitRetry(fetchFn, { sleep, onRetry });

		expect(result).toBe("ok");
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(waits).toEqual([2000, 2000]);
		expect(onRetry).toHaveBeenCalledTimes(2);
	});

	it("re-throws immediately when a single Retry-After exceeds the cap", async () => {
		const sleep = vi.fn(() => Promise.resolve());
		const fetchFn = vi.fn(async () => {
			throw rateLimited(200);
		});

		await expect(withRateLimitRetry(fetchFn, { sleep })).rejects.toBeInstanceOf(ApiError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("caps the CUMULATIVE wait, not just a single Retry-After", async () => {
		const sleep = vi.fn(() => Promise.resolve());
		const fetchFn = vi.fn(async () => {
			throw rateLimited(80);
		});

		// 80s is under the 120s cap, but 80s + 80s = 160s is not: retry once, then bail.
		await expect(withRateLimitRetry(fetchFn, { sleep })).rejects.toBeInstanceOf(ApiError);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("re-throws the 429 after exhausting the attempt budget", async () => {
		const sleep = vi.fn(() => Promise.resolve());
		const fetchFn = vi.fn(async () => {
			throw rateLimited(1);
		});

		await expect(withRateLimitRetry(fetchFn, { sleep, maxAttempts: 3 })).rejects.toBeInstanceOf(
			ApiError,
		);
		expect(fetchFn).toHaveBeenCalledTimes(3);
		// Slept before the 2nd and 3rd tries, not after the final failure.
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("does not retry a 429 that carries no Retry-After (fail-closed limiter)", async () => {
		const sleep = vi.fn(() => Promise.resolve());
		// retryable=false / no retry_after: the limiter failed closed, so surface it now.
		const fetchFn = vi.fn(async () => {
			throw rateLimited();
		});

		await expect(withRateLimitRetry(fetchFn, { sleep })).rejects.toBeInstanceOf(ApiError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("does not retry a 429 with a malformed Retry-After (NaN/Infinity/negative)", async () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
			const sleep = vi.fn(() => Promise.resolve());
			// A bad delay must not become a NaN/negative wait that slips past the cap
			// checks and hands setTimeout an invalid duration -- treat it as non-retryable.
			const fetchFn = vi.fn(async () => {
				throw rateLimited(bad);
			});

			await expect(withRateLimitRetry(fetchFn, { sleep })).rejects.toBeInstanceOf(ApiError);
			expect(fetchFn).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		}
	});

	it("propagates a non-429 error on the first attempt without sleeping", async () => {
		const sleep = vi.fn(() => Promise.resolve());
		const fetchFn = vi.fn(async () => {
			throw new ApiError("boom", 500, new Headers());
		});

		await expect(withRateLimitRetry(fetchFn, { sleep })).rejects.toThrow("boom");
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});

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

describe("validateSeconds", () => {
	it("falls back when the value is unset or a boolean", () => {
		expect(validateSeconds(undefined, 180)).toEqual({ value: 180 });
		expect(validateSeconds(true, 180)).toEqual({ value: 180 });
	});

	it("parses a positive numeric string", () => {
		expect(validateSeconds("42", 180)).toEqual({ value: 42 });
	});

	it("rejects zero and negatives without allowZero", () => {
		expect(validateSeconds("0", 180)).toEqual({
			error: "must be a positive number of seconds",
		});
		expect(validateSeconds("-5", 180)).toEqual({
			error: "must be a positive number of seconds",
		});
		expect(validateSeconds("abc", 180)).toEqual({
			error: "must be a positive number of seconds",
		});
	});

	it("allows zero (disable) but still rejects negatives with allowZero", () => {
		expect(validateSeconds("0", 1800, { allowZero: true })).toEqual({ value: 0 });
		expect(validateSeconds("30", 1800, { allowZero: true })).toEqual({ value: 30 });
		expect(validateSeconds("-1", 1800, { allowZero: true })).toEqual({
			error: "must be a non-negative number of seconds (0 disables the bound)",
		});
	});

	it("rejects a blank/whitespace value instead of coercing it to 0", () => {
		// Number("") and Number(" ") are 0; blank must not disable the bound.
		expect(validateSeconds("", 1800, { allowZero: true })).toEqual({
			error: "must be a non-negative number of seconds (0 disables the bound)",
		});
		expect(validateSeconds("   ", 1800, { allowZero: true })).toEqual({
			error: "must be a non-negative number of seconds (0 disables the bound)",
		});
		expect(validateSeconds("", 180)).toEqual({ error: "must be a positive number of seconds" });
	});

	it("rejects a value above the max (setTimeout overflow guard)", () => {
		expect(validateSeconds("100", 1800, { allowZero: true, max: 50 })).toEqual({
			error: "must be at most 50 seconds",
		});
		expect(validateSeconds("50", 1800, { allowZero: true, max: 50 })).toEqual({ value: 50 });
	});
});

describe("planTreeKill", () => {
	it("uses taskkill /T /F on win32", () => {
		expect(planTreeKill("win32", 4321)).toEqual({
			platform: "win32",
			command: "taskkill",
			args: ["/pid", "4321", "/t", "/f"],
		});
	});

	it("signals the negative pid (process group) on POSIX", () => {
		expect(planTreeKill("linux", 4321)).toEqual({ platform: "posix", groupPid: -4321 });
		expect(planTreeKill("darwin", 99)).toEqual({ platform: "posix", groupPid: -99 });
	});

	it("refuses to act on a missing / non-positive / non-integer pid", () => {
		// kill(0)/kill(-1) on POSIX would signal our own group or every process, so an
		// unsafe pid must yield a noop plan on every platform.
		for (const platform of ["win32", "linux", "darwin"] as const) {
			expect(planTreeKill(platform, undefined)).toEqual({ platform: "noop" });
			expect(planTreeKill(platform, 0)).toEqual({ platform: "noop" });
			expect(planTreeKill(platform, -5)).toEqual({ platform: "noop" });
			expect(planTreeKill(platform, 1.5)).toEqual({ platform: "noop" });
			expect(planTreeKill(platform, Number.NaN)).toEqual({ platform: "noop" });
		}
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
		const onPollError = vi.fn();
		const failure = new Error("503 from ingest");
		let calls = 0;
		const ok = await waitForIngest({
			fetchBuilds: async () => {
				calls++;
				if (calls === 1) throw failure;
				return [{ build_id: "cand", event_count: 1 }];
			},
			buildId: "cand",
			timeoutMs: 1000,
			intervalMs: 10,
			now: clock.now,
			sleep: clock.sleep,
			onPollError,
		});
		expect(ok).toBe(true);
		expect(calls).toBe(2);
		expect(onPollError).toHaveBeenCalledOnce();
		expect(onPollError).toHaveBeenCalledWith(failure, 1);
	});
});
