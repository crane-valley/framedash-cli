/**
 * Pure helpers for `framedash run-profile-test`, kept free of process/network
 * I/O so the env-contract and ingest-wait logic is unit-testable. The command
 * (commands/run-profile-test.ts) layers git resolution, the child-process
 * spawn, and the perf-diff gate around these.
 */

import { ApiError } from "@framedash/api-client";

/**
 * True when an ApiError carries a Retry-After we can actually honor: a finite,
 * non-negative number of seconds. The API omits retry_after (undefined) when its
 * limiter fails closed on a backend outage, and a malformed body could yield
 * null / NaN / Infinity / negative -- all of which mean "no usable window", so a
 * 429 with an invalid delay is treated the same as the fail-closed case. Shared
 * between withRateLimitRetry (whether to retry) and the command's error-reporting
 * (real rate-limit window vs. transient outage) so the two cannot drift.
 */
export function isValidRetryAfter(retryAfter: number | undefined): retryAfter is number {
	return retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0;
}

/** Injected knobs for withRateLimitRetry (all bounds have sane defaults). */
export interface RateLimitRetryOptions {
	/** Sleep helper (injected so tests need no real timers). */
	sleep: (ms: number) => Promise<void>;
	/** Total tries including the first attempt (default 5). */
	maxAttempts?: number;
	/** Cap on the CUMULATIVE Retry-After wait, in ms (default 120_000). */
	totalWaitCapMs?: number;
	/** Per-retry hook (progress logging); not called on the final failure. */
	onRetry?: (info: { attempt: number; waitMs: number; maxAttempts: number }) => void;
}

/**
 * Run `fetchFn`, retrying ONLY a genuinely retryable HTTP 429 while honoring the
 * ApiError's Retry-After. The API omits retry_after (and sets retryable=false)
 * when its limiter fails closed on a Redis outage; that 429 is NOT retried here
 * -- it re-throws on the first attempt so the caller surfaces it immediately
 * rather than spinning on a guessed backoff. The cumulative wait is capped: a
 * single Retry-After (or the running total) beyond `totalWaitCapMs` re-throws
 * the 429 rather than blocking a CI job on a long per-account-quota reset. Any
 * non-429 error propagates on the first attempt, and the final 429 (budget/cap
 * exhausted) is re-thrown so the caller can surface a rate-limit-specific
 * message. Kept pure (no logging, no process.exit) so the logic is unit-testable.
 */
export async function withRateLimitRetry<T>(
	fetchFn: () => Promise<T>,
	options: RateLimitRetryOptions,
): Promise<T> {
	const maxAttempts = options.maxAttempts ?? 5;
	const totalWaitCapMs = options.totalWaitCapMs ?? 120_000;
	let totalWaitMs = 0;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fetchFn();
		} catch (err) {
			// A 429 without a usable Retry-After is the fail-closed limiter
			// (retryable=false, or a malformed NaN/Infinity/negative delay): re-throw
			// it (and any non-429 / budget-exhausted error) unretried. Validating the
			// delay is finite and non-negative here keeps a bad value from becoming a
			// NaN/negative retryAfterMs that slips past the cap checks below and hands
			// setTimeout an invalid duration.
			if (
				!(err instanceof ApiError) ||
				err.status !== 429 ||
				!isValidRetryAfter(err.retryAfter) ||
				attempt >= maxAttempts
			) {
				throw err;
			}
			const retryAfterMs = err.retryAfter * 1000;
			// Fail fast rather than block: a wait (this Retry-After plus what we have
			// already slept) past the cap is not worth stalling on. totalWaitMs starts
			// at 0 and only accrues validated non-negative delays, so this single check
			// also covers a first Retry-After that alone exceeds the cap.
			if (totalWaitMs + retryAfterMs > totalWaitCapMs) {
				throw err;
			}
			totalWaitMs += retryAfterMs;
			options.onRetry?.({ attempt, waitMs: retryAfterMs, maxAttempts });
			await options.sleep(retryAfterMs);
		}
	}
}

/**
 * The FRAMEDASH_* environment contract the SDK's
 * BeginAutomatedSessionFromEnvironment() reads to stamp the automated session.
 * The build id becomes the first-class `build_id`; branch/commit/scenario ride
 * the attributes map as ci.branch / ci.commit / ci.scenario.
 */
export const ENV_BUILD_ID = "FRAMEDASH_BUILD_ID";
export const ENV_GIT_BRANCH = "FRAMEDASH_GIT_BRANCH";
export const ENV_GIT_COMMIT = "FRAMEDASH_GIT_COMMIT";
export const ENV_TEST_SCENARIO = "FRAMEDASH_TEST_SCENARIO";

/**
 * The full FRAMEDASH_* session contract. The runner is authoritative for all of
 * these: it clears any it does not set so the launched game can never inherit a
 * stale value (e.g. a FRAMEDASH_GIT_BRANCH left in the CI environment) when the
 * current run omits that field.
 */
export const SESSION_ENV_KEYS = [
	ENV_BUILD_ID,
	ENV_GIT_BRANCH,
	ENV_GIT_COMMIT,
	ENV_TEST_SCENARIO,
] as const;

/** Resolved build identity stamped onto the profiling run. */
export interface ProfileIdentity {
	/** Becomes FRAMEDASH_BUILD_ID and the perf-diff candidate; always set. */
	buildId: string;
	/** FRAMEDASH_GIT_BRANCH (ci.branch); omitted from the env when empty. */
	branch?: string;
	/** FRAMEDASH_GIT_COMMIT (ci.commit); omitted when empty. */
	commit?: string;
	/** FRAMEDASH_TEST_SCENARIO (ci.scenario); omitted when empty. */
	scenario?: string;
}

/** Raw identity flags as parsed from the command line (any may be unset). */
export interface IdentityInputs {
	buildId?: string;
	branch?: string;
	commit?: string;
	scenario?: string;
}

/** Git fallbacks (best-effort `git rev-parse` outputs; either may be unset). */
export interface GitFallbacks {
	branch?: string;
	commit?: string;
}

function clean(value: unknown): string | undefined {
	// Guard the type defensively: parseArgs only yields strings for these flags,
	// but a non-string (boolean/null) must not crash .trim().
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the build identity from explicit flags, falling back to git. The
 * build id defaults to the resolved commit, so a CI run that sets only --commit
 * (or relies on the git fallback) still gets a stable, first-class build_id.
 * Returns null when no build id can be determined, so the caller can error out
 * before launching the game.
 */
export function resolveProfileIdentity(
	flags: IdentityInputs,
	git: GitFallbacks,
): ProfileIdentity | null {
	const commit = clean(flags.commit) ?? clean(git.commit);
	const buildId = clean(flags.buildId) ?? commit;
	if (!buildId) return null;
	return {
		buildId,
		branch: clean(flags.branch) ?? clean(git.branch),
		commit,
		scenario: clean(flags.scenario),
	};
}

/**
 * The FRAMEDASH_* variables to overlay onto the child process environment. Only
 * non-empty values are included so the SDK's env reader never picks up a blank
 * branch/commit/scenario and stamps an empty ci.* tag.
 */
export function buildSessionEnv(identity: ProfileIdentity): Record<string, string> {
	const env: Record<string, string> = { [ENV_BUILD_ID]: identity.buildId };
	if (identity.branch) env[ENV_GIT_BRANCH] = identity.branch;
	if (identity.commit) env[ENV_GIT_COMMIT] = identity.commit;
	if (identity.scenario) env[ENV_TEST_SCENARIO] = identity.scenario;
	return env;
}

/** Result of validating a "seconds" CLI option value. */
export type SecondsValidation = { value: number } | { error: string };

/**
 * Validate a seconds-valued option. Returns the parsed number, or an error
 * message describing why it is invalid (the caller adds the --flag prefix and
 * decides how to surface it). A non-string value (unset, or the boolean parseArgs
 * yields for a value-less flag) falls back to `fallback`. With `allowZero` the
 * value may be 0 (used by --command-timeout, where 0 disables the bound);
 * otherwise it must be strictly positive (as --ingest-timeout / --poll-interval
 * require).
 */
export function validateSeconds(
	value: string | boolean | undefined,
	fallback: number,
	opts: { allowZero?: boolean; max?: number } = {},
): SecondsValidation {
	if (typeof value !== "string") return { value: fallback };
	const baseError = opts.allowZero
		? "must be a non-negative number of seconds (0 disables the bound)"
		: "must be a positive number of seconds";
	// Reject empty / whitespace explicitly: Number("") and Number(" ") are 0, which
	// would silently DISABLE the bound under allowZero (a fail-closed footgun for a
	// mistyped --command-timeout= value), so treat a blank value as invalid.
	const trimmed = value.trim();
	if (trimmed === "") return { error: baseError };
	const n = Number(trimmed);
	const minOk = opts.allowZero ? n >= 0 : n > 0;
	if (!Number.isFinite(n) || !minOk) return { error: baseError };
	// Guard against a value so large that timeoutMs overflows setTimeout's signed
	// 32-bit delay, which Node clamps to 1ms -- an "effectively unbounded" input
	// would then fire almost immediately and kill the run at once.
	if (opts.max !== undefined && n > opts.max) {
		return { error: `must be at most ${opts.max} seconds` };
	}
	return { value: n };
}

/**
 * Platform-specific plan for terminating a launched process TREE by pid. A plain
 * kill of the direct child orphans its grandchildren (a Unity/UE5 player launched
 * via the shell spawns helper processes that survive), so on win32 we shell out
 * to `taskkill /T /F` (whole tree, forced) and on POSIX we signal the child's
 * process GROUP (the negative pid, valid because the child is spawned detached
 * into its own group). Pure so the argv/decision is unit-testable without
 * spawning anything.
 */
export type TreeKillPlan =
	| { platform: "win32"; command: "taskkill"; args: string[] }
	| { platform: "posix"; groupPid: number }
	| { platform: "noop" };

export function planTreeKill(platform: NodeJS.Platform, pid: number | undefined): TreeKillPlan {
	// A missing, non-integer, or non-positive pid is UNSAFE to kill: on POSIX,
	// process.kill(0, sig) signals the caller's OWN process group and kill(-1, sig)
	// signals every process the user owns, either of which could take down this CLI
	// or the CI runner itself. Refuse to act rather than risk it.
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		return { platform: "noop" };
	}
	if (platform === "win32") {
		return { platform: "win32", command: "taskkill", args: ["/pid", String(pid), "/t", "/f"] };
	}
	// Negative pid targets the whole process group (see detached spawn in the command).
	return { platform: "posix", groupPid: -pid };
}

/** Minimal shape of a builds-list row (mirrors apps/web BuildInfo). */
export interface BuildListEntry {
	build_id: string;
	/**
	 * Perf-event count. ClickHouse `count()` is a UInt64, which the JSON format
	 * serializes as a quoted string by default, so this can arrive as a number OR
	 * a numeric string -- buildEventCount() normalizes it.
	 */
	event_count?: number | string;
}

/**
 * The perf-bearing event count currently reported for a build_id, or 0 when the
 * build is absent (or the row has no usable count). Normalizes the value with
 * Number() so a JSON-quoted UInt64 string compares numerically, not
 * lexicographically (otherwise "10" > "9" would be false). Used to snapshot the
 * candidate's count before a run so the wait can require it to grow.
 */
export function buildEventCount(
	builds: BuildListEntry[] | null | undefined,
	buildId: string,
): number {
	if (!Array.isArray(builds)) return 0;
	const row = builds.find((b) => b.build_id === buildId);
	const count = Number(row?.event_count);
	return Number.isFinite(count) ? count : 0;
}

/**
 * True once the candidate build_id has produced MORE than `minEventCount`
 * perf-bearing events. With the default 0 this means "present with any events".
 * Passing the build's pre-run count makes the wait require fresh events from
 * THIS run, so a CI re-run for the same build_id is not satisfied by old data.
 */
export function hasIngestedBuild(
	builds: BuildListEntry[] | null | undefined,
	buildId: string,
	minEventCount = 0,
): boolean {
	return buildEventCount(builds, buildId) > minEventCount;
}

/** Injected dependencies for waitForIngest (so the poll loop is unit-testable). */
export interface WaitForIngestDeps {
	/** Fetch the current builds list (one poll). */
	fetchBuilds: () => Promise<BuildListEntry[]>;
	/** Candidate build_id to wait for. */
	buildId: string;
	/**
	 * Require the candidate's event count to exceed this value (its count before
	 * the run), so the wait confirms fresh events rather than pre-existing data.
	 * Defaults to 0 ("present with any events").
	 */
	minEventCount?: number;
	/** Give up after this many milliseconds. */
	timeoutMs: number;
	/** Delay between polls, in milliseconds. */
	intervalMs: number;
	/** Sleep helper (injected so tests can advance a fake clock). */
	sleep: (ms: number) => Promise<void>;
	/** Monotonic clock in milliseconds (injected for the same reason). */
	now: () => number;
	/** Optional per-attempt hook (for progress logging). */
	onPoll?: (attempt: number) => void;
}

/**
 * Poll the builds list until the candidate build's perf data has landed, or the
 * timeout elapses. Returns true if the build appeared, false on timeout. Always
 * polls at least once (so timeoutMs=0 still makes a single attempt). A transient
 * fetch error (ingest / ClickHouse lag) is swallowed and retried until the
 * deadline rather than failing the whole run on a blip.
 */
export async function waitForIngest(deps: WaitForIngestDeps): Promise<boolean> {
	const deadline = deps.now() + deps.timeoutMs;
	let attempt = 0;
	while (true) {
		attempt++;
		deps.onPoll?.(attempt);
		try {
			const builds = await deps.fetchBuilds();
			if (hasIngestedBuild(builds, deps.buildId, deps.minEventCount ?? 0)) return true;
		} catch {
			// Transient ingest / aggregation lag -- keep polling until the deadline.
		}
		// Read the clock once so the deadline check and the sleep window are
		// consistent (a second now() call could advance past the deadline and yield
		// a negative remaining); never sleep past the deadline.
		const remaining = deadline - deps.now();
		if (remaining <= 0) return false;
		await deps.sleep(Math.min(deps.intervalMs, remaining));
	}
}
