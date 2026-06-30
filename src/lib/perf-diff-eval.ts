/**
 * Pure regression-gate logic for `framedash perf-diff`, kept free of I/O so the
 * CI pass/fail decision is unit-testable. The shapes mirror the builds/compare
 * API response (apps/web .../builds/compare); the CLI cannot import the web
 * app's types, so they are restated here.
 */

/** Lower-is-better performance metrics perf-diff can gate on. */
export type RegressionMetric = "frame_time" | "memory" | "gpu_time";

export const REGRESSION_METRICS: readonly RegressionMetric[] = ["frame_time", "memory", "gpu_time"];

export function isRegressionMetric(value: string): value is RegressionMetric {
	return (REGRESSION_METRICS as readonly string[]).includes(value);
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
 * Decide whether a build comparison should fail a CI gate. All regression
 * metrics are lower-is-better, so a positive diffPct (candidate P50 above
 * baseline) is a regression. A null diffPct (no baseline data, or a metric
 * unavailable on the platform, e.g. GPU timing) is not comparable and is
 * skipped -- neither an offender nor counted as evaluated.
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
	const evaluated = diffs.filter(
		(d) => (!options.metric || d.metric === options.metric) && typeof d.diffPct === "number",
	);
	const offenders = evaluated.filter((d) => (d.diffPct as number) > threshold);
	return { failed: offenders.length > 0, offenders, evaluated };
}

/** A one-line human summary of a single metric diff (for CI logs). */
export function formatMetricDiff(d: ApiMetricDiff): string {
	// `typeof !== "number"` covers a null OR an undefined/missing diffPct, so the
	// toFixed() below can never throw on a malformed row.
	if (typeof d.diffPct !== "number") return `${d.metric}: no comparable data`;
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
