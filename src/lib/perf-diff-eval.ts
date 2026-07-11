/**
 * Pure regression-gate logic for `framedash perf-diff`, kept free of I/O so the
 * CI pass/fail decision is unit-testable. The shapes mirror the builds/compare
 * API response (apps/web .../builds/compare); the CLI cannot import the web
 * app's types, so they are restated here.
 */

/**
 * Lower-is-better performance metrics perf-diff can gate on. Mirrors the web
 * app's RegressionMetric registry (apps/web .../regression-types.ts): the core
 * three fixed perf fields, the disk io.* metrics carried in the events_v2 metrics
 * map on perf_heartbeat, and load_time_ms carried in the metrics map on map_load
 * events (appended LAST so existing io.* wire positions are unchanged).
 */
export type RegressionMetric =
	| "frame_time"
	| "memory"
	| "gpu_time"
	| "io.read_bytes"
	| "io.read_time_ms"
	| "io.read_ops"
	| "load_time_ms";

export const REGRESSION_METRICS: readonly RegressionMetric[] = [
	"frame_time",
	"memory",
	"gpu_time",
	"io.read_bytes",
	"io.read_time_ms",
	"io.read_ops",
	"load_time_ms",
];

export function isRegressionMetric(value: string): value is RegressionMetric {
	return (REGRESSION_METRICS as readonly string[]).includes(value);
}

/**
 * Guard against `--metric load_time_ms` combined with `--map`. map_load events
 * carry an EMPTY map_id, so a map-filtered comparison has zero load_time_ms rows
 * -- the gate would then fail-closed on "no comparable data" and mislead the user.
 * Returns an error message when the combination is invalid, else null. Shared by
 * `perf-diff` and `run-profile-test`, which both forward `--metric` and `--map`.
 */
export function loadTimeMapConflict(
	metric: string | undefined,
	map: string | undefined,
): string | null {
	if (metric === "load_time_ms" && typeof map === "string" && map.trim().length > 0) {
		return (
			"--metric load_time_ms cannot be combined with --map: map_load events carry an " +
			"empty map_id, so a map-filtered comparison has no load-time data. Drop --map, or " +
			"use the dashboard's per-map load-time breakdown (grouped by map name) instead."
		);
	}
	return null;
}

/** One metric's diff, as returned by the builds/compare API. */
export interface ApiMetricDiff {
	metric: RegressionMetric;
	baselineP50: number | null;
	candidateP50: number | null;
	/** Signed percent change of candidate P50 vs baseline P50; null = not comparable. */
	diffPct: number | null;
	isRegression: boolean;
	baselineTail: number | null;
	candidateTail: number | null;
}

export interface ApiBuildComparison {
	baseline: { build_id: string };
	candidate: { build_id: string };
	diffs: ApiMetricDiff[];
}

export interface RegressionVerdict {
	/** True when at least one evaluated metric regressed beyond the threshold. */
	failed: boolean;
	/** Metrics that regressed beyond the threshold. */
	offenders: ApiMetricDiff[];
	/** Metrics actually evaluated (matching the metric filter, with comparable data). */
	evaluated: ApiMetricDiff[];
}

export interface EvaluateOptions {
	/** Restrict the gate to a single metric; default checks all. */
	metric?: RegressionMetric;
	/**
	 * A metric fails only when its P50 worsened by MORE than this percentage,
	 * letting CI tolerate run-to-run noise. Default 0 = any worsening fails.
	 */
	thresholdPct?: number;
}

/**
 * Metrics whose zero is a VALID collected value: the map-carried io.* read
 * windows (no reads -> 0, distinct from an absent metric) and load_time_ms (an
 * instant/cached load reads 0, distinct from a build with no map_load samples).
 * The fixed perf fields (frame_time/memory/gpu_time) cannot be 0 when a heartbeat
 * is recorded, so a zero baseline there is degenerate and stays "not comparable"
 * -- unchanged behavior. Mirrors the web ZERO_BASELINE_MEANINGFUL registry flag.
 */
function isZeroMeaningfulMetric(metric: string): boolean {
	return metric.startsWith("io.") || metric === "load_time_ms";
}

/**
 * A zero-baseline row for a zero-meaningful metric with a finite candidate P50. A
 * zero baseline carries diffPct: null (percent change from 0 is undefined) but
 * must still be comparable.
 */
function isZeroBaseline(d: ApiMetricDiff): boolean {
	return (
		isZeroMeaningfulMetric(d.metric) &&
		d.baselineP50 === 0 &&
		typeof d.candidateP50 === "number" &&
		Number.isFinite(d.candidateP50)
	);
}

/**
 * A zero baseline that moved to a positive candidate: an "infinite" worsening
 * (0 -> N) that no finite threshold can tolerate, so it always fails the gate.
 * All regression metrics are lower-is-better, so any positive candidate regresses.
 */
function isZeroBaselineRegression(d: ApiMetricDiff): boolean {
	return isZeroBaseline(d) && (d.candidateP50 as number) > 0;
}

/**
 * Decide whether a build comparison should fail a CI gate. All regression
 * metrics are lower-is-better, so a positive diffPct (candidate P50 above
 * baseline) is a regression. A null diffPct usually means "not comparable" (no
 * baseline data, or a metric unavailable on the platform, e.g. GPU timing) and is
 * skipped -- EXCEPT a valid zero baseline (diffPct is null because percent change
 * from 0 is undefined): 0 -> positive is an infinite regression that fails
 * regardless of threshold, and 0 -> 0 is comparable-but-unchanged.
 */
export function evaluateRegression(
	comparison: ApiBuildComparison,
	options: EvaluateOptions = {},
): RegressionVerdict {
	// Clamp a non-finite or negative threshold to 0 (the strictest gate) so a bad
	// value fails safe rather than silently disabling the gate -- `x > Infinity`
	// and `x > NaN` are both always false, which would pass every regression. The
	// command validates --threshold too; this keeps the exported helper robust on
	// its own.
	const threshold =
		Number.isFinite(options.thresholdPct) && (options.thresholdPct as number) >= 0
			? (options.thresholdPct as number)
			: 0;
	// Defensive: a malformed response (missing diffs) yields no evaluable metrics,
	// which the caller treats as "nothing comparable" -> fail-closed. `typeof ===
	// "number"` (not `!== null`) also skips an undefined/missing diffPct safely.
	const diffs = Array.isArray(comparison?.diffs) ? comparison.diffs : [];
	const scoped = diffs.filter((d) => !options.metric || d.metric === options.metric);
	const evaluated = scoped.filter((d) => typeof d.diffPct === "number" || isZeroBaseline(d));
	const offenders = evaluated.filter(
		(d) => isZeroBaselineRegression(d) || (typeof d.diffPct === "number" && d.diffPct > threshold),
	);
	return { failed: offenders.length > 0, offenders, evaluated };
}

/** A one-line human summary of a single metric diff (for CI logs). */
export function formatMetricDiff(d: ApiMetricDiff): string {
	// `typeof !== "number"` covers a null OR an undefined/missing diffPct, so the
	// toFixed() below can never throw on a malformed row.
	if (typeof d.diffPct !== "number") {
		// A zero baseline going positive has no percent (0 -> N) but is a real
		// regression, so report the raw movement instead of "no comparable data".
		if (isZeroBaselineRegression(d)) {
			return `${d.metric}: baseline 0 -> ${fmtValue(d.candidateP50)} (regression from zero)`;
		}
		return `${d.metric}: no comparable data`;
	}
	const sign = d.diffPct >= 0 ? "+" : "";
	return `${d.metric}: ${sign}${d.diffPct.toFixed(1)}% (P50 ${fmtValue(d.baselineP50)} -> ${fmtValue(
		d.candidateP50,
	)})`;
}

function fmtValue(value: number | null | undefined): string {
	// `typeof !== "number"` covers null AND a missing/undefined value on a
	// malformed row, so toFixed() can never throw here.
	return typeof value !== "number" ? "n/a" : value.toFixed(2);
}
