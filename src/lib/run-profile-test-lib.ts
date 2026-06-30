/**
 * Pure helpers for `framedash run-profile-test`, kept free of process/network
 * I/O so the env-contract and ingest-wait logic is unit-testable. The command
 * (commands/run-profile-test.ts) layers git resolution, the child-process
 * spawn, and the perf-diff gate around these.
 */

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
